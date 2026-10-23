// ============================================================================
// InitialPositionSolver.js — Cold-Start Position Fix from Two Beacon Ranges
//
// THE PROBLEM THIS SOLVES:
// Dead reckoning can only tell you how you have MOVED. Something has to say
// where you started, and if that answer is wrong every later position inherits
// the error no matter how good the tracking is. With two beacons the honest
// answer is geometric: each range defines a circle, and the user is where the
// circles cross.
//
// Two circles cross at TWO points, mirrored about the line joining the beacons.
// Ranges alone can never separate them — the two candidates are exactly the
// same distance from both beacons, which is what "mirrored" means. So the
// ambiguity is resolved by information that is not a range:
//
//   1. THE WALKABLE AREA. Beacons are normally mounted on or near a wall, so
//      one of the two candidates usually falls outside the floor plan — behind
//      the wall — and can be rejected outright. This alone settles most real
//      deployments on the first reading.
//
//   2. MOVEMENT, when both candidates are genuinely inside the room. The two
//      stay mirror images only while the user moves PARALLEL to the beacon
//      line. Any movement across it breaks the symmetry: the candidates then
//      predict genuinely different ranges, and subsequent readings favour one.
//      That is what the hypothesis scoring in FusionEngine exploits.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO:
// It does not average the two candidates, and it does not fall back to a point
// on the beacon line. The previous cold start did effectively that — it solved
// the along-baseline coordinate and dropped the perpendicular component — so
// it always placed the user somewhere on the line between the beacons, which
// is only correct if that is genuinely where they are. With both beacons
// together on a desk the line IS the desk and the result looks right; move the
// beacons apart and the same code puts the user on a line they may be thirty
// feet away from. A wrong answer with a confident number attached is worse
// than an honest "two possibilities, walk a few steps".
//
// UNITS: FEET throughout, matching the floor plan and FusionEngine. Callers
// convert BLE metres with metresToFeet() before calling.
// ============================================================================

export const SOLVER_CONFIG = {
  // How far the two ranges may disagree with the KNOWN beacon spacing before it
  // is treated as evidence of bad calibration rather than ordinary noise.
  //
  // The beacon separation is measured and fixed, so the ranges are not free to
  // be anything: the triangle inequality requires d1 + d2 >= L and
  // |d1 - d2| <= L. When a fix repeatedly has to rescale the ranges to make the
  // circles meet at all, the path-loss model is systematically wrong — usually
  // an uncalibrated beacon, which reads long through walls. This is one of the
  // few places the system can tell the user their DISTANCES are off rather than
  // just producing a quietly wrong position.
  CALIBRATION_SUSPECT_ADJUSTMENT_FT: 8.0,

  // Beacons closer together than this cannot define a usable baseline: the
  // intersection geometry degenerates and the perpendicular offset becomes
  // meaningless. Below it, the solver reports a proximity fix instead of
  // pretending to triangulate.
  MIN_BASELINE_FT: 3.0,

  // How far outside the floor plan a candidate may sit and still be accepted.
  // Non-zero because range error can legitimately push a fix slightly past a
  // wall when the user is standing right against it.
  WALKABLE_MARGIN_FT: 4.0,

  // If the two candidates are closer together than this, they are not
  // meaningfully different positions — the user is close to the beacon line —
  // so they collapse into a single answer rather than an ambiguous pair.
  // (6 ft: with about 4 ft of range error, two spots closer than that cannot be told apart,
  // so asking "A or B?" would be a guess.)
  MIN_CANDIDATE_SEPARATION_FT: 6.0,

  // When the two circles do not meet, the ranges are adjusted to make them touch. Range
  // error grows with distance (the signal-to-distance curve is multiplicative), so the
  // FARTHER beacon is adjusted more and the CLOSER one is trusted: each adjustment is
  // proportional to its range's variance. This floor (ft) keeps a beacon at a few feet,
  // where the receiver saturates, from being treated as exact.
  MIN_RANGE_SIGMA_FT: 3.0,

  // PRIORITY 1 - a beacon this close (ft, about 2 m) decides the start: the user is
  // standing by it. A close range is the most reliable one there is (its error grows
  // with distance), so the answer is one spot next to that beacon, never an A/B question.
  NEAR_BEACON_FT: 6.6,
  // Next to a beacon, a far range that needed more than this (ft) to meet the near one
  // disagrees with it; its direction is then not used and the user is placed at the
  // closest clear walkable spot to the near beacon.
  NEAR_BEACON_DISAGREE_FT: 4.0,

  // A crossing point inside a wall, desk or cabin (off the walkable area) by up to this
  // much (ft) means the user is standing next to it: it is moved to the nearest walkable
  // point and kept as a real option. Farther off than this it is impossible.
  NEAR_PLAN_FT: 10.0,

  // Assumed 1-sigma range error, used to size the reported uncertainty.
  // Matches what the BLE engine actually delivers indoors after filtering.
  RANGE_SIGMA_FT: 4.0,

  // Geometry quality ceiling. GDOP = sqrt(2)/|sin(theta)| blows up when the
  // user is near the beacon line (theta near 0 or 180), where range noise maps
  // into huge position error. Cap what is reported so the UI shows a large but
  // finite uncertainty instead of infinity.
  MAX_GDOP: 12.0,

  // Minimum per-beacon confidence before a reading is trusted for a cold start.
  // A cold start is a one-shot decision that everything downstream inherits, so
  // it is worth waiting for a clean reading rather than committing to a noisy
  // one immediately.
  MIN_COLD_START_CONFIDENCE: 0.25,
};

/**
 * Intersects two range circles.
 *
 * Real measurements frequently describe circles that do not actually meet:
 * either both ranges read short and the circles fall apart, or one reads long
 * and swallows the other. Rather than failing, the ranges are rescaled by the
 * smallest common factor that restores contact, which yields the point that
 * best explains both measurements while changing them as little as possible.
 *
 * @returns {{
 *   ok: boolean, reason?: string,
 *   candidates: Array<{x:number,y:number}>,
 *   alongFt: number, perpFt: number, baselineFt: number,
 *   adjusted: boolean, adjustmentFt: number,
 *   ux: number, uy: number, nx: number, ny: number
 * }}
 */
export function intersectRangeCircles(a1, r1, a2, r2, config = SOLVER_CONFIG, sigmas = null) {
  const bx = a2.x - a1.x;
  const by = a2.y - a1.y;
  const L = Math.hypot(bx, by);

  if (!Number.isFinite(L) || L < config.MIN_BASELINE_FT) {
    return { ok: false, reason: "beacons-too-close", candidates: [], baselineFt: L };
  }
  if (!Number.isFinite(r1) || !Number.isFinite(r2) || r1 <= 0 || r2 <= 0) {
    return { ok: false, reason: "invalid-ranges", candidates: [], baselineFt: L };
  }

  const ux = bx / L;
  const uy = by / L;
  // Left-hand normal to the baseline; the two candidates sit at +/- along this.
  const nx = -uy;
  const ny = ux;

  // ── Reconcile ranges that describe non-intersecting circles ──
  let R1 = r1;
  let R2 = r2;
  let adjusted = false;
  let adjustmentFt = 0;

  // Weight of each range in the adjustment: its error variance. Error grows with the
  // range, so the farther beacon takes most of the change and the closer one is trusted.
  const floor = config.MIN_RANGE_SIGMA_FT ?? 3;
  const s1 = Math.max(floor, Number.isFinite(sigmas?.s1) ? sigmas.s1 : r1);
  const s2 = Math.max(floor, Number.isFinite(sigmas?.s2) ? sigmas.s2 : r2);
  const w1 = (s1 * s1) / (s1 * s1 + s2 * s2);
  const w2 = 1 - w1;

  if (R1 + R2 < L) {
    // Both ranges too short to reach each other: grow them until they touch,
    // the less certain (farther) one by more.
    const gap = L - (R1 + R2);
    adjustmentFt = gap;
    R1 += gap * w1;
    R2 += gap * w2;
    adjusted = true;
  } else if (Math.abs(R1 - R2) > L) {
    // One circle entirely contains the other: pull the larger in / push the
    // smaller out until the difference equals the baseline (internal tangency),
    // the less certain one moving more.
    const excess = Math.abs(R1 - R2) - L;
    adjustmentFt = excess;
    if (R1 > R2) {
      R1 -= excess * w1;
      R2 += excess * w2;
    } else {
      R2 -= excess * w2;
      R1 += excess * w1;
    }
    adjusted = true;
  }

  // Along-baseline coordinate of the radical line, measured from a1.
  const along = (L * L + R1 * R1 - R2 * R2) / (2 * L);
  // Perpendicular half-separation. Clamped at zero for the tangent case, where
  // floating point can leave this fractionally negative.
  const perpSq = R1 * R1 - along * along;
  const perp = perpSq > 0 ? Math.sqrt(perpSq) : 0;

  const baseX = a1.x + ux * along;
  const baseY = a1.y + uy * along;

  const candidates = [
    { x: baseX + nx * perp, y: baseY + ny * perp },
    { x: baseX - nx * perp, y: baseY - ny * perp },
  ];

  return {
    ok: true,
    candidates,
    alongFt: along,
    perpFt: perp,
    baselineFt: L,
    adjusted,
    adjustmentFt: Number(adjustmentFt.toFixed(2)),
    ux, uy, nx, ny,
  };
}

/**
 * Is this point inside the walkable floor plan (allowing a small margin for
 * range error at the walls)?
 */
export function isWalkable(p, room, config = SOLVER_CONFIG) {
  if (!room || !Number.isFinite(room.width) || !Number.isFinite(room.height)) return true;
  const m = config.WALKABLE_MARGIN_FT;
  return p.x >= -m && p.x <= room.width + m && p.y >= -m && p.y <= room.height + m;
}

/**
 * Expected 1-sigma position error from range noise, given the geometry.
 *
 * With two ranges the observation Jacobian is the pair of unit vectors from the
 * user to each beacon. If theta is the angle they subtend at the user, the
 * dilution of precision works out to GDOP = sqrt(2)/|sin(theta)|: best when the
 * beacons are 90 degrees apart as seen from the user, and unbounded when the
 * user is on the line through both, where the two ranges carry almost the same
 * information and the position becomes weakly determined.
 *
 * This is why beacon PLACEMENT dominates achievable accuracy, and why the
 * number is surfaced to the UI rather than hidden.
 */
export function positionUncertaintyFt(p, a1, a2, config = SOLVER_CONFIG) {
  const v1x = p.x - a1.x, v1y = p.y - a1.y;
  const v2x = p.x - a2.x, v2y = p.y - a2.y;
  const n1 = Math.hypot(v1x, v1y);
  const n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-6 || n2 < 1e-6) return config.RANGE_SIGMA_FT;

  // |sin(theta)| from the 2D cross product of the two unit bearing vectors.
  const sinTheta = Math.abs((v1x * v2y - v1y * v2x) / (n1 * n2));
  const gdop = sinTheta < 1e-6
    ? config.MAX_GDOP
    : Math.min(config.MAX_GDOP, Math.SQRT2 / sinTheta);
  return Number((config.RANGE_SIGMA_FT * gdop).toFixed(2));
}

/**
 * Full cold-start solve: ranges in, candidate positions out.
 *
 * @param {object} args
 * @param {{x,y}} args.anchor1 / args.anchor2 - beacon positions, FEET
 * @param {number} args.d1 / args.d2          - measured ranges, FEET
 * @param {number} args.conf1 / args.conf2    - per-beacon confidence [0,1]
 * @param {{width,height}} args.room          - floor plan, FEET
 * @param {{x,y}|null} args.priorPosition     - previous estimate, used only to
 *        break a tie between two otherwise equally valid candidates.
 *
 * @returns {{
 *   status: "ok"|"ambiguous"|"low-confidence"|"degenerate-geometry"|"invalid",
 *   reason?: string,
 *   position: {x,y}|null,
 *   alternate: {x,y}|null,
 *   candidates: Array<{x,y,walkable:boolean}>,
 *   uncertaintyFt: number|null,
 *   separationFt: number,
 *   adjusted: boolean,
 *   geometryQuality: "good"|"fair"|"poor"
 * }}
 */
export function solveInitialPosition({
  anchor1, anchor2, d1, d2, conf1 = 1, conf2 = 1, room = null, priorPosition = null,
  requireConfidence = true,
  // Optional floor-plan walkable area: p -> { x, y, distFt } = nearest point
  // on it (distFt 0 when p is already on it). See WalkableGrid.nearest().
  snap = null,
  // Optional: p -> a point at least a little inside the walkable area (not on its edge).
  // See WalkableGrid.inside(). Used for points that had to be moved onto the floor.
  inside = null,
  config = SOLVER_CONFIG,
}) {
  // A candidate this close to the walkable area counts as on it (range noise
  // easily puts a correct answer a few feet into a cabin wall); it is then
  // moved onto it.
  const SNAP_TOLERANCE_FT = 4;
  // ...but asking the user "A or B?" needs both spots really ON the walkable
  // area (within the plan's resolution). One on it and the other only near it
  // (on a desk, in a wall) is one spot, not two.
  const ON_PLAN_FT = 1;
  const onPlan = (c) => (snap ? snap(c) : null);
  const placed = (c) => {
    const s = onPlan(c);
    if (!s) return { x: c.x, y: c.y };
    // Moved onto the floor: not onto its very edge (a wall line), a little inside it.
    if (s.distFt > 0 && inside) {
      const q = inside(s);
      if (q) return { x: q.x, y: q.y };
    }
    return { x: s.x, y: s.y };
  };
  const fail = (status, reason) => ({
    status, reason, position: null, alternate: null, candidates: [],
    uncertaintyFt: null, separationFt: 0, adjusted: false, geometryQuality: "poor",
  });

  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d1 <= 0 || d2 <= 0) {
    return fail("invalid", "ranges-unavailable");
  }
  // A cold start is committed to once and inherited by everything afterwards,
  // so a noisy reading is worth waiting out rather than acting on.
  if (requireConfidence && (conf1 < config.MIN_COLD_START_CONFIDENCE || conf2 < config.MIN_COLD_START_CONFIDENCE)) {
    return fail("low-confidence", "waiting-for-a-clean-reading-from-both-beacons");
  }

  // Less confident readings are less certain: scale each beacon's error by its confidence.
  const sg = (d, c) => d / Math.max(0.3, Math.min(1, Number.isFinite(c) ? c : 1));
  const geo = intersectRangeCircles(anchor1, d1, anchor2, d2, config, { s1: sg(d1, conf1), s2: sg(d2, conf2) });

  if (!geo.ok) {
    // Beacons mounted together cannot triangulate at all. Rather than invent a
    // direction, report the honest answer: the user is somewhere within roughly
    // d1 of that spot. This is exactly the desk-with-both-beacons case, and it
    // is genuinely a proximity fix, not a position fix.
    if (geo.reason === "beacons-too-close") {
      const mid = { x: (anchor1.x + anchor2.x) / 2, y: (anchor1.y + anchor2.y) / 2 };
      return {
        status: "degenerate-geometry",
        reason: "beacons-are-too-close-together-to-triangulate",
        position: mid,
        alternate: null,
        candidates: [{ ...mid, walkable: true }],
        uncertaintyFt: Number(Math.max(d1, d2).toFixed(2)),
        separationFt: 0,
        adjusted: false,
        geometryQuality: "poor",
      };
    }
    return fail("invalid", geo.reason);
  }

  // ── Classify each crossing point against the floor plan ──
  //   on    - on the walkable area (within the plan's resolution)
  //   close - within SNAP_TOLERANCE_FT: ordinary range noise, moved onto it
  //   wall  - in a wall / desk / cabin, within NEAR_PLAN_FT: the user is beside it
  //   off   - farther, or outside the room: not a place the user can be
  const TIER = { on: 0, close: 1, wall: 2, off: 3 };
  const nearPlanFt = config.NEAR_PLAN_FT ?? 10;
  const candidates = geo.candidates.map((c) => {
    const s = onPlan(c);
    // No walkable point found nearby at all = very far off the plan.
    const offPlanFt = !snap ? 0 : s ? s.distFt : Infinity;
    const inRoom = isWalkable(c, room, config);
    const tier = !inRoom ? "off"
      : offPlanFt <= ON_PLAN_FT ? "on"
      : offPlanFt <= SNAP_TOLERANCE_FT ? "close"
      : offPlanFt <= nearPlanFt ? "wall"
      : "off";
    return { ...c, walkable: tier === "on" || tier === "close", tier, offPlanFt };
  });
  const separation = 2 * geo.perpFt;
  const minSep = config.MIN_CANDIDATE_SEPARATION_FT;

  const qualityOf = (p) => {
    const u = positionUncertaintyFt(p, anchor1, anchor2, config);
    return u < 8 ? "good" : u < 16 ? "fair" : "poor";
  };
  // Better tier first, then nearer the walkable area.
  const byPriority = (a, b) => TIER[a.tier] - TIER[b.tier] || a.offPlanFt - b.offPlanFt;
  const one = (p, reason, uncertaintyFt, quality = null) => ({
    status: "ok",
    reason,
    position: p,
    alternate: null,
    candidates,
    uncertaintyFt: Number(uncertaintyFt.toFixed(2)),
    separationFt: Number(separation.toFixed(2)),
    adjusted: geo.adjusted,
    adjustmentFt: geo.adjustmentFt,
    geometryQuality: quality || qualityOf(p),
  });
  const midpoint = (a, b) => placed({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const plausible = candidates.filter((c) => c.tier !== "off");

  // ── PRIORITY 1: right next to a beacon ─────────────────────────────────────
  // The weighted crossing already keeps the close beacon's range (it is the most
  // certain), so both points are about that far from it. Pick the better-placed one;
  // if both are equally good they lie on either side of the beacon line within a few
  // feet of each other, and the spot between them (next to the beacon) is the answer.
  const nearFt = config.NEAR_BEACON_FT ?? 6.6;
  const dNear = Math.min(d1, d2);
  if (dNear <= nearFt) {
    const beacon = d1 <= d2 ? anchor1 : anchor2;
    const which = d1 <= d2 ? 1 : 2;
    // The doubt is the close range (plus how far the spot had to be moved), NOT the
    // two-beacon geometry: on the line through both beacons that reads up to 48 ft and
    // would spread the map's starting cloud over half the office.
    const unc = (p) => Math.max(dNear, config.MIN_RANGE_SIGMA_FT ?? 3, Math.hypot(p.x - beacon.x, p.y - beacon.y));
    const near = (p, why) => ({ ...one(p, `next-to-beacon-${which}${why}`, unc(p), "fair"), nearBeacon: which });
    // The far range had to be stretched or shrunk a lot to meet the close one: it is
    // wrong (blocked, reflected), so its direction says nothing. The user is by the
    // close beacon: the nearest clear spot on the floor to it.
    const disagree = geo.adjusted && (geo.adjustmentFt || 0) > (config.NEAR_BEACON_DISAGREE_FT ?? 4);
    if (disagree || !plausible.length) return near(placed(beacon), disagree ? "-far-range-disagrees" : "");
    const sorted = [...plausible].sort(byPriority);
    const p = sorted.length === 2 && sorted[0].tier === sorted[1].tier
      ? midpoint(sorted[0], sorted[1])
      : placed(sorted[0]);
    return near(p, "");
  }

  // ── PRIORITY 2: the two crossing points cannot be told apart ───────────────
  // Includes ranges that did not meet (adjusted to touch: one point). One answer:
  // the point between the two, weighted by both ranges.
  if (separation < minSep) {
    const p = {
      x: (candidates[0].x + candidates[1].x) / 2,
      y: (candidates[0].y + candidates[1].y) / 2,
    };
    return one(
      placed(p),
      geo.adjusted ? "ranges-did-not-meet-weighted-to-the-closer-beacon" : "candidates-too-close-to-tell-apart",
      // The wider of the geometry's error and how far the ranges had to be adjusted.
      Math.max(positionUncertaintyFt(p, anchor1, anchor2, config), (geo.adjustmentFt || 0) * 0.5),
    );
  }

  // ── PRIORITY 3: the floor plan ─────────────────────────────────────────────
  // Neither point is a place the user can be: the nearer one, as a rough answer.
  if (!plausible.length) {
    const best = candidates
      .map((c) => ({ c, d: snap ? c.offPlanFt : outsideDistance(c, room) }))
      .sort((a, b) => a.d - b.d)[0].c;
    return one(
      placed(best),
      "no-candidate-inside-floor-plan-using-closest",
      Math.max(positionUncertaintyFt(best, anchor1, anchor2, config), config.RANGE_SIGMA_FT * 2),
      "poor",
    );
  }

  // Only one point is possible: that one (moved onto the walkable area if it was
  // in a wall - the user is standing beside it).
  if (plausible.length === 1) {
    const p = plausible[0];
    return one(
      placed(p),
      p.tier === "wall" ? "beside-a-wall-moved-onto-the-floor" : "resolved-by-floor-plan",
      positionUncertaintyFt(p, anchor1, anchor2, config) + (p.tier === "wall" ? p.offPlanFt / 2 : 0),
    );
  }

  // Both are possible. Where each one really ends up once moved onto the walkable
  // area: if that is the same spot, it is one answer.
  const [first, second] = [...plausible].sort((a, b) => {
    const t = byPriority(a, b);
    if (t !== 0 || !priorPosition || !Number.isFinite(priorPosition.x)) return t;
    // Same tier: a prior position (e.g. resuming tracking) decides which to show first.
    return Math.hypot(a.x - priorPosition.x, a.y - priorPosition.y) - Math.hypot(b.x - priorPosition.x, b.y - priorPosition.y);
  });
  const pA = placed(first);
  const pB = placed(second);
  if (Math.hypot(pA.x - pB.x, pA.y - pB.y) < minSep) {
    const p = midpoint(pA, pB);
    return one(p, "both-points-meet-on-the-floor", positionUncertaintyFt(p, anchor1, anchor2, config));
  }

  // Two different places the user could be (including one beside a wall): ranges
  // cannot separate them, so both are offered - the better-placed one first - and
  // FusionEngine carries both until the user picks one or walking decides.
  return {
    status: "ambiguous",
    reason: second.tier === "wall" || first.tier === "wall"
      ? "two-possible-positions-one-beside-a-wall"
      : "two-valid-positions-walk-a-few-steps-to-resolve",
    position: pA,
    alternate: pB,
    candidates,
    uncertaintyFt: positionUncertaintyFt(first, anchor1, anchor2, config),
    separationFt: Number(separation.toFixed(2)),
    adjusted: geo.adjusted,
    geometryQuality: qualityOf(first),
  };
}

/** How far outside the floor plan a point lies (0 when inside). */
function outsideDistance(p, room) {
  if (!room) return 0;
  const dx = Math.max(0, Math.max(-p.x, p.x - room.width));
  const dy = Math.max(0, Math.max(-p.y, p.y - room.height));
  return Math.hypot(dx, dy);
}

// ============================================================================
// RANGE FIX ACCUMULATOR
//
// WHY A SINGLE PACKET IS NOT ENOUGH:
// The intersection of two range circles is only as good as the two ranges, and
// a single BLE reading carries several feet of error. Solving from one packet
// therefore throws that error straight into the starting position — and because
// the intersection geometry amplifies range error away from the baseline, a few
// feet of range noise can move the fix by twenty.
//
// Indoor range error has two parts that behave very differently:
//   • fast jitter, which averaging removes as 1/sqrt(N)
//   • slow shadowing from bodies and walls, which it does not
// So averaging buys a lot at first and then flattens. Measured over the office:
//   1 sample   5.8 ft mean / 20.6 ft worst
//   10 samples 3.3 ft      / 12.5 ft
//   30 samples ~2.1 ft     / ~8 ft
//   80 samples 1.1 ft      /  6.0 ft
// About three seconds of packets captures most of the available gain without
// asking the user to stand still for an unreasonable time; the accumulator
// commits then if the ranges have settled, and waits a little longer only
// while they are still drifting.
//
// A TRIMMED MEAN is used rather than a plain mean or a median: the plain mean is
// dragged by the occasional severe multipath outlier, while the median discards
// genuine information. Trimming the extremes keeps the efficiency of the mean
// with the outlier resistance of the median.
// ============================================================================

export const ACCUMULATOR_CONFIG = {
  // Enough to produce an early provisional fix to show the user immediately.
  MIN_SAMPLES_FOR_PROVISIONAL: 4,
  // Minimum evidence before any commit on the normal path: this many packets
  // AND this much time. Accuracy is set by how many independent looks at the
  // slow shadowing the window contains, which is a matter of TIME, not packet
  // count. Simulated against correlated BLE noise, 1.5 s costs ~0.2 ft of
  // median range error against 3 s (2.5 vs 2.3 ft) while halving the wait,
  // and the navigation filter keeps refining with every BLE update afterwards.
  // Below ~1 s the loss grows quickly (a small window that merely looks
  // steady was simulated at more than double the error), so do not go lower.
  MIN_SAMPLES_TO_COMMIT: 6,
  MIN_COLLECT_MS: 1500,
  // Commit once the standard error of BOTH mean ranges is below this AND the
  // ranges are not drifting. The standard error is computed from the
  // EFFECTIVE sample count (see effectiveSampleCount): the distances arriving
  // here are Kalman-smoothed, so neighbouring samples are strongly correlated
  // and a plain spread/sqrt(N) would claim far more precision than the data
  // holds - committing early on that would cost accuracy.
  CONVERGED_SEM_FT: 1.0,
  // Drift test: the two halves of the window must agree to within this (or
  // twice the standard error, whichever is larger). A range still settling -
  // the user only just stopped walking, or the BLE filter is catching up -
  // shows up as the halves disagreeing, and averaging it would bake the lag
  // into the starting position.
  DRIFT_TOLERANCE_FT: 2.5,
  // Fraction trimmed from EACH end before averaging.
  TRIM_FRACTION: 0.2,
  // Normal time limit: commit with what is there if the ranges are steady.
  MAX_COLLECT_MS: 4000,
  // Extended limit while the ranges are still drifting; the commit then uses
  // only the most recent half of the window, which is closest to the truth.
  MAX_COLLECT_DRIFTING_MS: 8000,
  // Minimum evidence for the timeout path - still better than one packet.
  MIN_SAMPLES_ON_TIMEOUT: 3,
  // Absolute deadline. Whatever has been collected by now is committed, as
  // long as it is at least MIN_SAMPLES_AT_DEADLINE. Locating must END: a user
  // left staring at "finding your position" gets nothing, whereas a slightly
  // rougher start is refined by BLE correction as soon as they walk.
  HARD_DEADLINE_MS: 8000,
  MIN_SAMPLES_AT_DEADLINE: 2,
  // Rolling window cap; older samples are dropped first.
  MAX_SAMPLES: 60,
  // Samples below this confidence are ignored entirely.
  //
  // Deliberately 0. The BLE engine's confidence is 1 - (raw RSSI noise
  // variance)/20 dB^2, and ordinary indoor BLE noise of 4-5 dB alone puts it at
  // 0-0.2 - so the old 0.2 floor rejected almost every reading and locating
  // waited minutes for a rare quiet moment. Noisy readings are exactly what
  // averaging is for, and their noise is already measured by the spread and
  // reflected in the reported uncertainty. Staleness, which IS a reason to
  // reject a sample, is handled by the caller from packet timestamps.
  MIN_SAMPLE_CONFIDENCE: 0.0,
};

/** Mean of the middle (1 - 2·trim) fraction of the values. */
export function trimmedMean(values, trimFraction = ACCUMULATOR_CONFIG.TRIM_FRACTION) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * trimFraction);
  const kept = sorted.length - 2 * cut >= 1 ? sorted.slice(cut, sorted.length - cut) : sorted;
  return kept.reduce((a, v) => a + v, 0) / kept.length;
}

/** Sample standard deviation, used to report honest fix uncertainty. */
function stdDev(values) {
  if (values.length < 2) return null;
  const m = values.reduce((a, v) => a + v, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Number of INDEPENDENT samples a correlated series is worth.
 *
 * For an AR(1)-like series with lag-1 autocorrelation rho, the variance of the
 * mean is that of n_eff = n(1 - rho)/(1 + rho) independent samples. Kalman-
 * smoothed ranges typically have rho around 0.7-0.9, i.e. 20 samples carry
 * the information of only 2-4, and pretending otherwise understates error.
 */
function effectiveSampleCount(values) {
  const n = values.length;
  if (n < 3) return n;
  const m = values.reduce((a, v) => a + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const e = values[i] - m;
    den += e * e;
    if (i + 1 < n) num += e * (values[i + 1] - m);
  }
  if (den < 1e-9) return n; // perfectly constant: no evidence of correlation
  const rho = Math.max(0, Math.min(0.95, num / den));
  return Math.max(1, (n * (1 - rho)) / (1 + rho));
}

/** Standard error of the mean, corrected for autocorrelation. */
function honestSem(values) {
  const s = stdDev(values);
  if (s === null) return null;
  return s / Math.sqrt(effectiveSampleCount(values));
}

export class RangeFixAccumulator {
  constructor(config = {}) {
    this.cfg = { ...ACCUMULATOR_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this._d1 = [];
    this._d2 = [];
    this._conf = [];
    this._startedAt = Date.now();
  }

  /** Feeds one BLE reading. The caller is responsible for skipping stale or duplicate ones. */
  add(d1, d2, conf1 = 1, conf2 = 1) {
    if (!Number.isFinite(d1) || !Number.isFinite(d2) || d1 <= 0 || d2 <= 0) return false;
    if (conf1 < this.cfg.MIN_SAMPLE_CONFIDENCE || conf2 < this.cfg.MIN_SAMPLE_CONFIDENCE) return false;
    this._d1.push(d1);
    this._d2.push(d2);
    this._conf.push(Math.min(conf1, conf2));
    if (this._d1.length > this.cfg.MAX_SAMPLES) {
      this._d1.shift();
      this._d2.shift();
      this._conf.shift();
    }
    return true;
  }

  get sampleCount() { return this._d1.length; }
  get elapsedMs() { return Date.now() - this._startedAt; }

  /** True while either range is still moving between the two halves of the window. */
  isDrifting() {
    const n = this._d1.length;
    if (n < this.cfg.MIN_SAMPLES_TO_COMMIT) return false;
    const half = Math.floor(n / 2);
    const drifts = (values) => {
      const early = trimmedMean(values.slice(0, half), this.cfg.TRIM_FRACTION);
      const late = trimmedMean(values.slice(half), this.cfg.TRIM_FRACTION);
      const sem = honestSem(values) ?? 0;
      return Math.abs(late - early) > Math.max(this.cfg.DRIFT_TOLERANCE_FT, 2 * sem);
    };
    return drifts(this._d1) || drifts(this._d2);
  }

  /** Enough evidence to commit to a fix? */
  isReady() {
    const n = this._d1.length;
    const elapsed = Date.now() - this._startedAt;
    const drifting = this.isDrifting();
    if (
      n >= this.cfg.MIN_SAMPLES_TO_COMMIT &&
      elapsed >= this.cfg.MIN_COLLECT_MS &&
      !drifting &&
      this._isConverged()
    ) return true;
    // Timeout paths: commit with whatever we have rather than stalling, provided
    // it is at least enough to be better than a single packet. A drifting
    // window is given longer, because committing mid-drift bakes the lag in.
    if (n >= this.cfg.MIN_SAMPLES_AT_DEADLINE && elapsed > this.cfg.HARD_DEADLINE_MS) return true;
    if (n < this.cfg.MIN_SAMPLES_ON_TIMEOUT) return false;
    return elapsed > (drifting ? this.cfg.MAX_COLLECT_DRIFTING_MS : this.cfg.MAX_COLLECT_MS);
  }

  /** Both mean ranges known to within CONVERGED_SEM_FT (autocorrelation-corrected). */
  _isConverged() {
    const e1 = honestSem(this._d1);
    const e2 = honestSem(this._d2);
    if (e1 === null || e2 === null) return false;
    return e1 <= this.cfg.CONVERGED_SEM_FT && e2 <= this.cfg.CONVERGED_SEM_FT;
  }

  /** Enough for a provisional position to show while still collecting. */
  hasProvisional() {
    return this._d1.length >= this.cfg.MIN_SAMPLES_FOR_PROVISIONAL;
  }

  progress() {
    if (this.isReady()) return 1;
    // Closer of: statistical convergence, or the time limit.
    const e = Math.max(honestSem(this._d1) ?? Infinity, honestSem(this._d2) ?? Infinity);
    const byPrecision = Number.isFinite(e) && this._d1.length >= this.cfg.MIN_SAMPLES_TO_COMMIT
      ? Math.min(1, this.cfg.CONVERGED_SEM_FT / e)
      : (this._d1.length / this.cfg.MIN_SAMPLES_TO_COMMIT) * 0.5;
    const limit = this.isDrifting() ? this.cfg.MAX_COLLECT_DRIFTING_MS : this.cfg.MAX_COLLECT_MS;
    const byTime = (Date.now() - this._startedAt) / limit;
    return Math.min(0.95, Math.max(byPrecision, byTime));
  }

  /**
   * Consolidated ranges plus the standard error of each.
   *
   * The reported sigma is the autocorrelation-corrected standard error of the
   * mean; FusionEngine floors it so it never claims more precision than BLE can
   * physically deliver - averaging reduces jitter but cannot remove the slow
   * shadowing component. If the window is still drifting (timeout path) only
   * the most recent half is used, since the older part describes where the
   * range estimate was, not where the user is.
   */
  consolidate() {
    if (!this._d1.length) return null;
    let v1 = this._d1, v2 = this._d2, vc = this._conf;
    if (this.isDrifting()) {
      const half = Math.floor(v1.length / 2);
      v1 = v1.slice(half); v2 = v2.slice(half); vc = vc.slice(half);
    }
    const n = v1.length;
    // How far the ranges moved across the window. A commit made while they
    // were still settling is less certain than its standard error says, so
    // the caller widens the starting uncertainty by this - the navigation
    // filter then trusts BLE more for the first few updates and pulls a rough
    // start in quickly, instead of defending it.
    const halfDrift = (values) => {
      if (values.length < 4) return 0;
      const h = Math.floor(values.length / 2);
      return Math.abs(
        trimmedMean(values.slice(h), this.cfg.TRIM_FRACTION) -
        trimmedMean(values.slice(0, h), this.cfg.TRIM_FRACTION)
      );
    };
    return {
      driftFt: Math.max(halfDrift(this._d1), halfDrift(this._d2)),
      d1: trimmedMean(v1, this.cfg.TRIM_FRACTION),
      d2: trimmedMean(v2, this.cfg.TRIM_FRACTION),
      sampleCount: this._d1.length,
      conf: vc.reduce((a, v) => a + v, 0) / n,
      sigma1Ft: honestSem(v1),
      sigma2Ft: honestSem(v2),
      spread1Ft: stdDev(v1),
      spread2Ft: stdDev(v2),
    };
  }
}
