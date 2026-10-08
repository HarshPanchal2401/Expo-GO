// ============================================================================
// ParticleFilter.js — position from PDR steps + map + BLE (navigation phase)
//
// Replaces the EKF while navigating. ~300 "particles" are possible positions,
// each also carrying its OWN step-length scale and heading bias:
//
//   step:  every particle moves by the step, using its own scale and bias plus
//          a little noise. A particle whose move crosses a wall, enters a
//          pillar or a no-walk area, or leaves the room is removed - so the
//          track can only follow walkable paths.
//   BLE:   (at most twice a second) every particle is weighted by how well it
//          explains both beacons' ranges. The expected range at a particle
//          includes the walls between it and the beacon (they make the
//          measured range read long), and a range that is much LONGER than
//          expected is tolerated more than one that is shorter (an unmodelled
//          obstruction only ever lengthens it).
//   learn: particles with the wrong step scale or heading bias drift into
//          walls or away from the BLE ranges and die out; the survivors carry
//          the right values - step length and heading drift are calibrated
//          while walking, per walk.
//   two candidates: the start can be two mirror points (two beacons). Both get
//          particles; the wrong side dies out as soon as walls or ranges
//          disagree with it. Until then both are reported.
//
// Units: feet, degrees (0 = map +Y, clockwise - the app's heading convention).
// ============================================================================

export const PF_CONFIG = {
  N: 300,
  // Per step: length noise (fraction) and heading noise (deg).
  STEP_LEN_NOISE: 0.07,
  HEADING_NOISE_DEG: 5,
  // Per particle: step-length scale ~ N(1, sd) and heading bias ~ N(0, sd),
  // with a slow random walk so they can follow changes.
  SCALE_SD0: 0.08,
  SCALE_WALK: 0.004,
  BIAS_SD0_DEG: 6,
  BIAS_WALK_DEG: 0.4,
  // BLE update: at most this often; tempered (power < 1) because consecutive
  // filtered ranges are strongly correlated, and more so when standing.
  BLE_MIN_INTERVAL_MS: 500,
  BLE_TEMPER_WALKING: 0.6,
  BLE_TEMPER_STILL: 0.25,
  // Range error in log-distance (multiplicative), floor; longer-than-expected
  // ranges are allowed this much more; fraction of gross outliers.
  BLE_LN_SIGMA_MIN: 0.22,
  NLOS_LONG_SIGMA_FACTOR: 1.8,
  OUTLIER_EPS: 0.05,
  // Resampling and roughening.
  RESAMPLE_ESS_FRAC: 0.5,
  ROUGHEN_FT: 0.25,
  // If fewer than this fraction of particles could make a step (e.g. heading
  // badly wrong into a wall), they are not killed but held where they were.
  MIN_SURVIVOR_FRAC: 0.05,
  // Mirror ambiguity is reported while the other side holds this much weight
  // and the two sides are this far apart.
  AMBIGUITY_MIN_WEIGHT: 0.2,
  AMBIGUITY_MIN_SEP_FT: 4,
};

// ── geometry ────────────────────────────────────────────────────────────────
function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
function pointSegDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
function inRect(x, y, r) {
  return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
}

export class ParticleFilter {
  constructor(config = {}) {
    this.cfg = { ...PF_CONFIG, ...config };
    this.map = { walls: [], circles: [], areas: [], room: null };
    this.beacons = { 1: null, 2: null };
    this.rangeFactor = null;
    // Floor-plan walkable area (WalkableGrid) or null.
    this.grid = null;
    this.p = [];
    this.lastBleAt = 0;
    this._rand = Math.random;
  }

  /**
   * walls: [{x1,y1,x2,y2}], circles: [{x,y,r}], areas: [{x1,y1,x2,y2}]
   * (any corner order), room: {w,h} or null.
   */
  setMap({ walls = [], circles = [], areas = [], room = null } = {}) {
    this.map = {
      walls: walls.filter((w) => [w.x1, w.y1, w.x2, w.y2].every(Number.isFinite)),
      circles: circles.filter((c) => [c.x, c.y, c.r].every(Number.isFinite)),
      areas: areas
        .filter((a) => [a.x1, a.y1, a.x2, a.y2].every(Number.isFinite))
        .map((a) => ({
          x1: Math.min(a.x1, a.x2), x2: Math.max(a.x1, a.x2),
          y1: Math.min(a.y1, a.y2), y2: Math.max(a.y1, a.y2),
        })),
      room: room && room.w > 0 && room.h > 0 ? room : null,
    };
  }

  setBeacons(a1, a2) {
    this.beacons = { 1: a1 ? { ...a1 } : null, 2: a2 ? { ...a2 } : null };
  }

  /** WalkableGrid of the floor plan's green area (or null). */
  setGrid(grid) {
    this.grid = grid || null;
  }

  /** (x, y, beaconNum) -> expected measured / straight-line range (>= 1; walls). */
  setRangeFactor(fn) {
    this.rangeFactor = typeof fn === "function" ? fn : null;
  }

  get active() {
    return this.p.length > 0;
  }

  _gauss() {
    let u = 0;
    while (!u) u = this._rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this._rand());
  }

  /** Is (x, y) a place someone can stand? */
  walkable(x, y) {
    if (this.grid && !this.grid.isWalkable(x, y)) return false;
    const m = this.map;
    if (m.room && (x < 0 || y < 0 || x > m.room.w || y > m.room.h)) return false;
    for (const a of m.areas) if (inRect(x, y, a)) return false;
    for (const c of m.circles) if (Math.hypot(x - c.x, y - c.y) < c.r) return false;
    return true;
  }

  /** Can someone walk straight from (x0,y0) to (x1,y1)? */
  canMove(x0, y0, x1, y1) {
    if (!this.walkable(x1, y1)) return false;
    if (this.grid && !this.grid.segmentWalkable(x0, y0, x1, y1)) return false;
    for (const w of this.map.walls) if (segCross(x0, y0, x1, y1, w.x1, w.y1, w.x2, w.y2)) return false;
    for (const c of this.map.circles) if (pointSegDist(c.x, c.y, x0, y0, x1, y1) < c.r) return false;
    for (const a of this.map.areas) {
      // Cutting a corner of a no-walk area.
      if (
        segCross(x0, y0, x1, y1, a.x1, a.y1, a.x2, a.y1) || segCross(x0, y0, x1, y1, a.x2, a.y1, a.x2, a.y2) ||
        segCross(x0, y0, x1, y1, a.x2, a.y2, a.x1, a.y2) || segCross(x0, y0, x1, y1, a.x1, a.y2, a.x1, a.y1)
      ) return false;
    }
    return true;
  }

  /**
   * Starts from one or more candidate positions: [{x, y, sigmaFt, weight}].
   * Particles that would start inside a wall area are re-drawn.
   */
  init(candidates) {
    const cfg = this.cfg;
    const cands = candidates.filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y));
    if (!cands.length) { this.p = []; return; }
    const wSum = cands.reduce((a, c) => a + (c.weight ?? 1), 0);
    this.p = [];
    for (const c of cands) {
      const n = Math.max(1, Math.round((cfg.N * (c.weight ?? 1)) / wSum));
      const sd = Math.max(0.5, c.sigmaFt ?? 3);
      for (let i = 0; i < n; i++) {
        let x = c.x, y = c.y;
        for (let k = 0; k < 20; k++) {
          const tx = c.x + sd * this._gauss(), ty = c.y + sd * this._gauss();
          if (this.walkable(tx, ty)) { x = tx; y = ty; break; }
        }
        this.p.push({
          x, y,
          s: 1 + cfg.SCALE_SD0 * this._gauss(),
          b: cfg.BIAS_SD0_DEG * this._gauss(),
          lw: 0,
        });
      }
    }
    this._normalise();
  }

  /**
   * One PDR step: lenFt and heading (deg). headingJumpSdDeg > 0 when the
   * phone was just repositioned (pocket, ear): the walking direction was
   * carried over rather than measured, so each particle's heading bias is
   * re-spread once by that much and the map / beacons pick the right one.
   */
  step(lenFt, headingDeg, headingJumpSdDeg = 0) {
    if (!this.active || !Number.isFinite(lenFt) || !Number.isFinite(headingDeg)) return;
    const cfg = this.cfg;
    const moved = [];
    let okW = 0, allW = 0;
    const jump = Number.isFinite(headingJumpSdDeg) && headingJumpSdDeg > 0 ? headingJumpSdDeg : 0;
    for (const q of this.p) {
      q.s = Math.max(0.6, Math.min(1.5, q.s + cfg.SCALE_WALK * this._gauss()));
      q.b += cfg.BIAS_WALK_DEG * this._gauss() + (jump ? jump * this._gauss() : 0);
      const L = lenFt * q.s * (1 + cfg.STEP_LEN_NOISE * this._gauss());
      const h = ((headingDeg + q.b + cfg.HEADING_NOISE_DEG * this._gauss()) * Math.PI) / 180;
      const nx = q.x + L * Math.sin(h), ny = q.y + L * Math.cos(h);
      const ok = this.canMove(q.x, q.y, nx, ny);
      const w = Math.exp(q.lw);
      allW += w;
      if (ok) okW += w;
      moved.push({ nx, ny, ok });
    }
    const kill = allW > 0 && okW / allW >= cfg.MIN_SURVIVOR_FRAC;
    this.p.forEach((q, i) => {
      const m = moved[i];
      if (m.ok) { q.x = m.nx; q.y = m.ny; }
      else if (kill) q.lw = -Infinity; // walked through a wall: impossible
      // else: everyone is blocked (heading far off) - hold position instead.
    });
    this._normalise();
    this._maybeResample();
  }

  /**
   * BLE ranges (feet) and their 1-sigma (feet); a beacon with no usable range
   * is passed as null. walking: tempers the update less while moving.
   */
  updateBle(d1, d2, s1, s2, walking, now = Date.now()) {
    if (!this.active) return false;
    const cfg = this.cfg;
    if (now - this.lastBleAt < cfg.BLE_MIN_INTERVAL_MS) return false;
    const meas = [];
    for (const [num, d, s] of [[1, d1, s1], [2, d2, s2]]) {
      const b = this.beacons[num];
      if (!b || !Number.isFinite(d) || d <= 0) continue;
      const sig = Math.max(cfg.BLE_LN_SIGMA_MIN, Number.isFinite(s) && s > 0 ? s / d : 0.3);
      meas.push({ num, b, lnD: Math.log(Math.max(0.3, d)), sig });
    }
    if (!meas.length) return false;
    this.lastBleAt = now;
    const temper = walking ? cfg.BLE_TEMPER_WALKING : cfg.BLE_TEMPER_STILL;
    const floor = Math.log(cfg.OUTLIER_EPS);
    for (const q of this.p) {
      if (q.lw === -Infinity) continue;
      let ll = 0;
      for (const m of meas) {
        const geo = Math.max(0.5, Math.hypot(q.x - m.b.x, q.y - m.b.y));
        const f = this.rangeFactor ? this.rangeFactor(q.x, q.y, m.num) : 1;
        const r = m.lnD - Math.log(geo * (Number.isFinite(f) && f > 0 ? f : 1));
        const sd = r > 0 ? m.sig * cfg.NLOS_LONG_SIGMA_FACTOR : m.sig;
        // Gaussian with a floor: a gross outlier costs a bounded amount.
        ll += Math.max(-(r * r) / (2 * sd * sd), floor);
      }
      q.lw += temper * ll;
    }
    this._normalise();
    this._maybeResample();
    return true;
  }

  _normalise() {
    let max = -Infinity;
    for (const q of this.p) if (q.lw > max) max = q.lw;
    if (!Number.isFinite(max)) {
      // Everything died: restart evenly (positions kept).
      for (const q of this.p) q.lw = 0;
      return;
    }
    let sum = 0;
    for (const q of this.p) sum += q.lw === -Infinity ? 0 : Math.exp(q.lw - max);
    const ls = Math.log(sum) + max;
    for (const q of this.p) if (q.lw !== -Infinity) q.lw -= ls;
  }

  _weights() {
    return this.p.map((q) => (q.lw === -Infinity ? 0 : Math.exp(q.lw)));
  }

  _maybeResample() {
    const cfg = this.cfg;
    const w = this._weights();
    const sumSq = w.reduce((a, v) => a + v * v, 0);
    const ess = sumSq > 0 ? 1 / sumSq : 0;
    if (ess >= cfg.RESAMPLE_ESS_FRAC * this.p.length) return;
    // Systematic resampling.
    const N = this.p.length;
    const out = [];
    const u0 = this._rand() / N;
    let c = w[0], i = 0;
    for (let j = 0; j < N; j++) {
      const u = u0 + j / N;
      while (u > c && i < N - 1) { i++; c += w[i]; }
      const q = this.p[i];
      // Roughen, without pushing a copy into a wall.
      const nx = q.x + cfg.ROUGHEN_FT * this._gauss();
      const ny = q.y + cfg.ROUGHEN_FT * this._gauss();
      const keep = this.canMove(q.x, q.y, nx, ny);
      out.push({
        x: keep ? nx : q.x,
        y: keep ? ny : q.y,
        s: q.s + 0.005 * this._gauss(),
        b: q.b + 0.3 * this._gauss(),
        lw: -Math.log(N),
      });
    }
    this.p = out;
  }

  /** Side of the beacon baseline (+1 / -1); 0 when beacons are unknown. */
  _side(x, y) {
    const a = this.beacons[1], b = this.beacons[2];
    if (!a || !b) return 0;
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    return c >= 0 ? 1 : -1;
  }

  _stats(filter) {
    let sw = 0, sx = 0, sy = 0, ss = 0, sb = 0;
    const w = this._weights();
    this.p.forEach((q, i) => {
      if (!filter(q) || !w[i]) return;
      sw += w[i]; sx += w[i] * q.x; sy += w[i] * q.y; ss += w[i] * q.s; sb += w[i] * q.b;
    });
    if (!(sw > 0)) return null;
    const mx = sx / sw, my = sy / sw;
    let v = 0;
    this.p.forEach((q, i) => {
      if (!filter(q) || !w[i]) return;
      v += w[i] * ((q.x - mx) ** 2 + (q.y - my) ** 2);
    });
    return { w: sw, x: mx, y: my, sd: Math.sqrt(v / sw / 2), scale: ss / sw, biasDeg: sb / sw };
  }

  /**
   * Position estimate: the weighted mean of the stronger side of the beacon
   * line (never the average of two mirror candidates, which would be a point
   * between them), plus the other side while it is still plausible.
   */
  estimate() {
    if (!this.active) return null;
    const pos = this._stats((q) => this._side(q.x, q.y) >= 0);
    const neg = this._stats((q) => this._side(q.x, q.y) < 0);
    const main = !neg || (pos && pos.w >= neg.w) ? pos : neg;
    const other = main === pos ? neg : pos;
    const ambiguous = Boolean(
      other && other.w >= this.cfg.AMBIGUITY_MIN_WEIGHT &&
      Math.hypot(other.x - main.x, other.y - main.y) >= this.cfg.AMBIGUITY_MIN_SEP_FT
    );
    return {
      x: main.x,
      y: main.y,
      sdFt: main.sd,
      stepScale: main.scale,
      headingBiasDeg: main.biasDeg,
      ambiguous,
      alternate: ambiguous ? { x: other.x, y: other.y, weight: other.w } : null,
    };
  }

  /** The user pointed at where they are: keep that side of the beacon line. */
  keepSideNear(x, y) {
    const s = this._side(x, y);
    if (!s) return false;
    for (const q of this.p) if (this._side(q.x, q.y) !== s) q.lw = -Infinity;
    this._normalise();
    this._maybeResample();
    return true;
  }

  clear() {
    this.p = [];
  }
}
