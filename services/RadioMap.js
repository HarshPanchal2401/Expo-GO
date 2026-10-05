// ============================================================================
// RadioMap.js — what walls, pillars and cabins do, place by place
//
// A distance model, however it is fitted, gives the same answer for every
// place at the same distance. Indoors that is the largest remaining error:
// standing behind a pillar or inside a glass cabin costs 5-15 dB that the
// open desk area two metres away does not, so the same distance reads
// anywhere from right to double.
//
// Every calibration point measured at a known spot on the floor plan shows
// that directly: residual = measured level - model level at that distance.
// Residuals are strongly correlated over a couple of metres (the same walls
// are in the way) and unrelated across the room. This interpolates them with
// a Gaussian process (squared-exponential kernel), which gives both
//   mean(x, y) - the correction to add at a place, and
//   sd(x, y)   - how sure that is: small next to survey points, rising to the
//                no-information value TAU_DB away from them (where the mean
//                also falls back to 0, i.e. the plain distance model).
//
// Units: feet (map frame), dB.
// ============================================================================

export const RADIO_MAP_CONFIG = {
  // Correlation length: how far one survey point's correction carries.
  // About a cabin or a pillar's shadow.
  LENGTH_FT: 8,
  // Spread of residuals with no data nearby (office shadowing).
  TAU_DB: 5,
  // Most recent points kept per beacon (cost grows with the cube).
  MAX_POINTS: 120,
};

export class RadioMap {
  constructor(config = {}) {
    this.cfg = { ...RADIO_MAP_CONFIG, ...config };
    this.pts = [];
    this.alpha = null; // K^-1 r
    this.Kinv = null;
  }

  /** @param {{x:number, y:number, residualDb:number, sigmaDb:number}[]} points */
  build(points) {
    const pts = (points || [])
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.residualDb))
      .slice(-this.cfg.MAX_POINTS);
    this.pts = pts;
    if (!pts.length) {
      this.alpha = null;
      this.Kinv = null;
      return;
    }
    const n = pts.length;
    const K = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => this._k(pts[i], pts[j]) + (i === j ? Math.max(0.5, pts[i].sigmaDb || 2) ** 2 : 0))
    );
    this.Kinv = invertSPD(K);
    if (!this.Kinv) {
      this.alpha = null;
      return;
    }
    // Residuals are clipped: a single wild point must not paint a 15 dB hole.
    const r = pts.map((p) => Math.max(-15, Math.min(15, p.residualDb)));
    this.alpha = this.Kinv.map((row) => row.reduce((a, v, j) => a + v * r[j], 0));
  }

  _k(a, b) {
    const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    return this.cfg.TAU_DB ** 2 * Math.exp(-d2 / (2 * this.cfg.LENGTH_FT ** 2));
  }

  /** Correction (dB, + = measured stronger than the model here) and its sd. */
  query(x, y) {
    const tau = this.cfg.TAU_DB;
    if (!this.alpha || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { meanDb: 0, sdDb: tau, points: 0 };
    }
    const q = { x, y };
    const k = this.pts.map((p) => this._k(q, p));
    const meanDb = k.reduce((a, v, i) => a + v * this.alpha[i], 0);
    let quad = 0;
    for (let i = 0; i < k.length; i++) {
      if (k[i] < 1e-6) continue;
      let s = 0;
      for (let j = 0; j < k.length; j++) s += this.Kinv[i][j] * k[j];
      quad += k[i] * s;
    }
    const sdDb = Math.sqrt(Math.max(0.25, tau * tau - quad));
    return { meanDb, sdDb, points: this.pts.length };
  }
}

/** Inverse of a symmetric positive-definite matrix via Cholesky; null if not SPD. */
function invertSPD(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 1e-12)) return null;
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  // inv(L), then inv(A) = inv(L)^T inv(L)
  const Li = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    Li[i][i] = 1 / L[i][i];
    for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= L[i][k] * Li[k][j];
      Li[i][j] = s / L[i][i];
    }
  }
  const inv = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = i; k < n; k++) s += Li[k][i] * Li[k][j];
      inv[i][j] = s;
      inv[j][i] = s;
    }
  }
  return inv;
}

