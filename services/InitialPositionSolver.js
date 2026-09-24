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
  MIN_CANDIDATE_SEPARATION_FT: 4.0,

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
export function intersectRangeCircles(a1, r1, a2, r2, config = SOLVER_CONFIG) {
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

  if (R1 + R2 < L) {
    // Both ranges too short to reach each other: grow both until they touch.
    const k = L / (R1 + R2);
    adjustmentFt = L - (R1 + R2);
    R1 *= k;
    R2 *= k;
    adjusted = true;
  } else if (Math.abs(R1 - R2) > L) {
    // One circle entirely contains the other: pull the larger in / push the
    // smaller out until the difference equals the baseline (internal tangency).
    const excess = Math.abs(R1 - R2) - L;
    adjustmentFt = excess;
    if (R1 > R2) {
      R1 -= excess / 2;
      R2 += excess / 2;
    } else {
      R2 -= excess / 2;
      R1 += excess / 2;
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
  config = SOLVER_CONFIG,
}) {
  const fail = (status, reason) => ({
    status, reason, position: null, alternate: null, candidates: [],
    uncertaintyFt: null, separationFt: 0, adjusted: false, geometryQuality: "poor",
  });

  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d1 <= 0 || d2 <= 0) {
    return fail("invalid", "ranges-unavailable");
  }
  // A cold start is committed to once and inherited by everything afterwards,
  // so a noisy reading is worth waiting out rather than acting on.
  if (conf1 < config.MIN_COLD_START_CONFIDENCE || conf2 < config.MIN_COLD_START_CONFIDENCE) {
    return fail("low-confidence", "waiting-for-a-clean-reading-from-both-beacons");
  }

  const geo = intersectRangeCircles(anchor1, d1, anchor2, d2, config);

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

  const candidates = geo.candidates.map((c) => ({ ...c, walkable: isWalkable(c, room, config) }));
  const separation = 2 * geo.perpFt;
  const walkableOnes = candidates.filter((c) => c.walkable);

  const qualityOf = (p) => {
    const u = positionUncertaintyFt(p, anchor1, anchor2, config);
    return u < 8 ? "good" : u < 16 ? "fair" : "poor";
  };

  // The candidates coincide (user effectively on the beacon line) — one answer.
  if (separation < config.MIN_CANDIDATE_SEPARATION_FT) {
    const p = candidates[0];
    return {
      status: "ok",
      position: { x: p.x, y: p.y },
      alternate: null,
      candidates,
      uncertaintyFt: positionUncertaintyFt(p, anchor1, anchor2, config),
      separationFt: Number(separation.toFixed(2)),
      adjusted: geo.adjusted,
      adjustmentFt: geo.adjustmentFt,
      geometryQuality: qualityOf(p),
    };
  }

  // The normal, and best, case: the floor plan rules one candidate out.
  if (walkableOnes.length === 1) {
    const p = walkableOnes[0];
    return {
      status: "ok",
      reason: "resolved-by-floor-plan",
      position: { x: p.x, y: p.y },
      alternate: null,
      candidates,
      uncertaintyFt: positionUncertaintyFt(p, anchor1, anchor2, config),
      separationFt: Number(separation.toFixed(2)),
      adjusted: geo.adjusted,
      adjustmentFt: geo.adjustmentFt,
      geometryQuality: qualityOf(p),
    };
  }

  // Neither candidate is on the floor plan: the ranges disagree with the map.
  if (walkableOnes.length === 0) {
    const best = candidates
      .map((c) => ({ c, d: outsideDistance(c, room) }))
      .sort((a, b) => a.d - b.d)[0].c;
    return {
      status: "ok",
      reason: "no-candidate-inside-floor-plan-using-closest",
      position: { x: best.x, y: best.y },
      alternate: null,
      candidates,
      uncertaintyFt: Math.max(
        positionUncertaintyFt(best, anchor1, anchor2, config),
        config.RANGE_SIGMA_FT * 2
      ),
      separationFt: Number(separation.toFixed(2)),
      adjusted: geo.adjusted,
      adjustmentFt: geo.adjustmentFt,
      geometryQuality: "poor",
    };
  }

  // Both candidates are legitimately inside the room. Ranges cannot separate
  // them — that is geometry, not a shortcoming of the filter — so both are
  // returned and FusionEngine carries them until movement decides. A prior
  // position (e.g. resuming tracking) is a legitimate tiebreak for which one to
  // show meanwhile; it does NOT discard the other.
  let primary = candidates[0];
  let secondary = candidates[1];
  if (priorPosition && Number.isFinite(priorPosition.x)) {
    const dA = Math.hypot(candidates[0].x - priorPosition.x, candidates[0].y - priorPosition.y);
    const dB = Math.hypot(candidates[1].x - priorPosition.x, candidates[1].y - priorPosition.y);
    if (dB < dA) { primary = candidates[1]; secondary = candidates[0]; }
  }

  return {
    status: "ambiguous",
    reason: "two-valid-positions-walk-a-few-steps-to-resolve",
    position: { x: primary.x, y: primary.y },
    alternate: { x: secondary.x, y: secondary.y },
    candidates,
    uncertaintyFt: positionUncertaintyFt(primary, anchor1, anchor2, config),
    separationFt: Number(separation.toFixed(2)),
    adjusted: geo.adjusted,
    geometryQuality: qualityOf(primary),
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
// Around three seconds of packets captures most of the available gain without
// asking the user to stand still for an unreasonable time.
//
// A TRIMMED MEAN is used rather than a plain mean or a median: the plain mean is
// dragged by the occasional severe multipath outlier, while the median discards
// genuine information. Trimming the extremes keeps the efficiency of the mean
// with the outlier resistance of the median.
// ============================================================================

export const ACCUMULATOR_CONFIG = {
  // Samples needed before a fix is committed. At a typical 9-10 packets/sec
  // this is roughly three seconds of standing still.
  TARGET_SAMPLES: 30,
  // Enough to produce an early provisional fix to show the user immediately.
  MIN_SAMPLES_FOR_PROVISIONAL: 8,
  // Fraction trimmed from EACH end before averaging.
  TRIM_FRACTION: 0.2,
  // Give up waiting for TARGET_SAMPLES after this long and use what we have,
  // so a weak beacon cannot leave the user stuck on "locating" forever.
  MAX_COLLECT_MS: 9000,
  // Samples below this confidence are ignored entirely.
  MIN_SAMPLE_CONFIDENCE: 0.2,
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

  /** Feeds one BLE reading. Low-confidence readings are dropped, not averaged in. */
  add(d1, d2, conf1 = 1, conf2 = 1) {
    if (!Number.isFinite(d1) || !Number.isFinite(d2) || d1 <= 0 || d2 <= 0) return false;
    if (conf1 < this.cfg.MIN_SAMPLE_CONFIDENCE || conf2 < this.cfg.MIN_SAMPLE_CONFIDENCE) return false;
    this._d1.push(d1);
    this._d2.push(d2);
    this._conf.push(Math.min(conf1, conf2));
    return true;
  }

  get sampleCount() { return this._d1.length; }

  /** Enough evidence to commit to a fix? */
  isReady() {
    if (this._d1.length >= this.cfg.TARGET_SAMPLES) return true;
    // Timeout path: commit with whatever we have rather than stalling, provided
    // it is at least enough to be better than a single packet.
    return (
      this._d1.length >= this.cfg.MIN_SAMPLES_FOR_PROVISIONAL &&
      Date.now() - this._startedAt > this.cfg.MAX_COLLECT_MS
    );
  }

  /** Enough for a provisional position to show while still collecting. */
  hasProvisional() {
    return this._d1.length >= this.cfg.MIN_SAMPLES_FOR_PROVISIONAL;
  }

  progress() {
    return Math.min(1, this._d1.length / this.cfg.TARGET_SAMPLES);
  }

  /**
   * Consolidated ranges plus the standard error of each.
   *
   * The reported sigma is the standard error of the MEAN (spread / sqrt(N)),
   * floored so it never claims more precision than BLE can physically deliver —
   * averaging reduces jitter but cannot remove the slow shadowing component, so
   * a spread that happens to look small must not be read as a perfect fix.
   */
  consolidate() {
    if (!this._d1.length) return null;
    const n = this._d1.length;
    const d1 = trimmedMean(this._d1, this.cfg.TRIM_FRACTION);
    const d2 = trimmedMean(this._d2, this.cfg.TRIM_FRACTION);
    const s1 = stdDev(this._d1);
    const s2 = stdDev(this._d2);
    const sem = (s) => (s === null ? null : s / Math.sqrt(n));
    return {
      d1, d2,
      sampleCount: n,
      conf: this._conf.reduce((a, v) => a + v, 0) / n,
      sigma1Ft: sem(s1),
      sigma2Ft: sem(s2),
      spread1Ft: s1,
      spread2Ft: s2,
    };
  }
}
