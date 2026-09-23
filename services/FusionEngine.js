// ============================================================================
// FusionEngine.js — Async EKF Fusion Engine (PDR Prediction + BLE Correction)
//
// Implements a lightweight 2D Extended Kalman Filter that fuses:
//   • PDR (Pedestrian Dead Reckoning) prediction steps — fires on every step
//   • BLE weighted-distance correction — fires on every beacon packet
//
// With only 2 beacons (not enough for true trilateration), this engine uses
// WEIGHTED PROXIMITY BLENDING:
//   — Each beacon defines a distance circle.
//   — We estimate position along the B1→B2 baseline, weighted by confidence².
//   — PDR fills in the lateral (perpendicular) component.
//
// State vector: [x, y]  (2×1 position in metres)
// Covariance:   P       (2×2 error covariance)
//
// PDR → Prediction step  (updates x, y, grows P)
// BLE → Correction step  (computes Kalman gain K, shrinks P)
// ============================================================================

import { pdrEngine } from './PdrEngine.js';

// ============================================================================
// FUSION CONFIGURATION
// ============================================================================

export const FUSION_CONFIG = {
  // PDR process noise: fraction of step length used as positional σ per step.
  // Larger value = EKF trusts PDR less = BLE pulls harder.
  PDR_STEP_NOISE_FACTOR: 0.12,

  // Minimum BLE measurement noise (R). Even a perfect beacon has ~0.3 m error.
  BLE_R_MIN: 0.09,      // = (0.3 m)²

  // Maximum BLE measurement noise (R). Low-confidence beacon = very weak pull.
  BLE_R_MAX: 16.0,      // = (4.0 m)²

  // If implied correction speed exceeds this, the beacon is likely lying (multipath).
  // Down-weight the correction instead of accepting it blindly.
  JUMP_GUARD_SPEED_MPS: 3.0,

  // Factor by which R is multiplied when jump guard fires.
  JUMP_GUARD_R_MULTIPLIER: 8.0,

  // Initial position uncertainty (m²) on cold-start.
  INITIAL_COVARIANCE: 0.25,   // = (0.5 m)²

  // Passive covariance growth (m²/s) when standing still.
  // Prevents the filter from becoming overconfident while stationary.
  Q_PASSIVE_M2_PER_S: 0.001,

  // Minimum uncertainty radius reported in UI (never shows 0 m exactly).
  MIN_UNCERTAINTY_M: 0.15,

  // Maximum uncertainty radius reported.
  MAX_UNCERTAINTY_M: 8.0,
};

// ============================================================================
// FusionEngine Class
// ============================================================================

export class FusionEngine {
  constructor(config = {}) {
    this._cfg = { ...FUSION_CONFIG, ...config };

    // EKF State: 2D position
    this._x = 0;  // metres
    this._y = 0;  // metres

    // EKF Error Covariance (diagonal 2×2, stored as [pxx, pyy])
    // Full off-diagonal terms kept for correctness:
    this._pxx = this._cfg.INITIAL_COVARIANCE;
    this._pyy = this._cfg.INITIAL_COVARIANCE;
    this._pxy = 0;  // cross-covariance

    // Beacon anchor positions in metres (user-configured real-world coordinates)
    this._anchor1 = { x: 0, y: 0 };
    this._anchor2 = { x: 3, y: 0 };  // default: 3 m apart on x-axis

    // Room bounds for soft clamping
    this._roomWidth = null;   // metres, null = unconstrained
    this._roomHeight = null;

    // Timestamps
    this._lastCorrectionTime = null;
    this._lastTickTime = Date.now();

    // Scores for UI
    this._lastBleConf = 0;
    this._lastPdrConf = 0;
    this._lastCorrectionPos = null;

    // Trail of recent positions for the map
    this._trail = [];
    this._maxTrailLength = 80;
  }

  // --------------------------------------------------------------------------
  // CONFIGURATION
  // --------------------------------------------------------------------------

  /**
   * Set real-world anchor coordinates for both beacons.
   * Call this whenever the user edits beacon positions in the setup wizard.
   *
   * @param {{ x: number, y: number }} b1 - Beacon 1 world position (metres)
   * @param {{ x: number, y: number }} b2 - Beacon 2 world position (metres)
   */
  setBleAnchors(b1, b2) {
    this._anchor1 = { x: Number(b1.x) || 0, y: Number(b1.y) || 0 };
    this._anchor2 = { x: Number(b2.x) || 3, y: Number(b2.y) || 0 };
  }

  /**
   * Set room boundaries for soft position clamping.
   * @param {number} widthM
   * @param {number} heightM
   */
  setRoomSize(widthM, heightM) {
    this._roomWidth = Number(widthM) > 0 ? Number(widthM) : null;
    this._roomHeight = Number(heightM) > 0 ? Number(heightM) : null;
  }

  /**
   * Cold-start reset — snaps position to known coordinates and resets covariance.
   * @param {number} x0
   * @param {number} y0
   */
  reset(x0 = 0, y0 = 0) {
    this._x = Number(x0) || 0;
    this._y = Number(y0) || 0;
    this._pxx = this._cfg.INITIAL_COVARIANCE;
    this._pyy = this._cfg.INITIAL_COVARIANCE;
    this._pxy = 0;
    this._lastCorrectionTime = null;
    this._lastTickTime = Date.now();
    this._lastBleConf = 0;
    this._lastPdrConf = 0;
    this._trail = [{ x: this._x, y: this._y }];
    pdrEngine.reset(x0, y0);
  }

  // --------------------------------------------------------------------------
  // EKF PREDICTION — called on every PDR step event
  // --------------------------------------------------------------------------

  /**
   * PDR prediction step. Moves the EKF state forward based on step + heading.
   * Also updates the shared pdrEngine for confidence tracking.
   *
   * @param {number} stepLengthM - Weinberg step length (metres)
   * @param {number} headingDeg  - Smoothed heading (degrees, 0 = forward/north)
   */
  predict(stepLengthM, headingDeg) {
    const len = Math.max(0.45, Math.min(1.05, stepLengthM || 0.70));
    const rad = (headingDeg * Math.PI) / 180;

    // State transition — standard dead-reckoning
    this._x += len * Math.sin(rad);
    this._y += len * Math.cos(rad);

    // Process noise Q: step uncertainty modelled as σ_step = factor × length
    const sigma = this._cfg.PDR_STEP_NOISE_FACTOR * len;
    const Q = sigma * sigma;

    // Covariance prediction: P = P + Q·I (identity addition for isotropic noise)
    this._pxx += Q;
    this._pyy += Q;
    // pxy is unchanged by isotropic noise

    // Soft-clamp to room bounds
    this._clampToRoom();

    // Update PDR engine for confidence tracking
    pdrEngine.applyStep(len, headingDeg);

    // Append to trail
    this._pushTrail(this._x, this._y);
  }

  // --------------------------------------------------------------------------
  // EKF CORRECTION — called on every BLE packet from both beacons
  // --------------------------------------------------------------------------

  /**
   * BLE correction step using weighted 2-beacon proximity blending.
   *
   * With only 2 beacons we cannot do full 2D trilateration. Instead:
   *   1. Compute the baseline vector B1→B2.
   *   2. Project each beacon's distance circle onto the baseline.
   *   3. Blend the intersection point weighted by (confidence)².
   *   4. Use the PDR y-component for the perpendicular axis.
   *
   * This gives us a 1D BLE observation (along the B1→B2 axis) fused
   * with PDR in the perpendicular direction.
   *
   * @param {number} d1  - Filtered distance to Beacon 1 (metres)
   * @param {number} d2  - Filtered distance to Beacon 2 (metres)
   * @param {number} c1  - Beacon 1 confidence [0, 1]
   * @param {number} c2  - Beacon 2 confidence [0, 1]
   */
  correct(d1, d2, c1, c2) {
    // Guard: both distances must be valid finite positives
    if (!Number.isFinite(d1) || !Number.isFinite(d2)) return;
    if (d1 <= 0 || d2 <= 0) return;

    const now = Date.now();
    const w1 = Math.max(0, c1 || 0) ** 2;
    const w2 = Math.max(0, c2 || 0) ** 2;
    const wTotal = w1 + w2;
    if (wTotal < 0.01) return;

    // ── Baseline geometry ──────────────────────────────────────────────────
    const bx = this._anchor2.x - this._anchor1.x;
    const by = this._anchor2.y - this._anchor1.y;
    const baselineLen = Math.sqrt(bx * bx + by * by);
    if (baselineLen < 0.1) return;

    // Unit vector along B1→B2 (observation direction)
    const ux = bx / baselineLen;
    const uy = by / baselineLen;

    // ── 1D observation: position along baseline from B1 ───────────────────
    // Law of cosines: t = (L² + d1² - d2²) / (2L)
    // This is the ONLY axis BLE can resolve with 2 beacons.
    // The perpendicular axis is unobservable by BLE alone — PDR covers it.
    const t_geom = (baselineLen ** 2 + d1 ** 2 - d2 ** 2) / (2 * baselineLen);
    const t_clamped = Math.max(0, Math.min(baselineLen, t_geom));

    // BLE's scalar observation of the state projected onto the baseline:
    //   z_measured = t_clamped     (distance from B1 along the B1→B2 axis)
    //   z_predicted = H · x        (current state projected onto baseline)
    //   H = [ux, uy]               (1×2 observation matrix)
    const z_measured = t_clamped;
    const z_predicted = ux * (this._x - this._anchor1.x)
                      + uy * (this._y - this._anchor1.y);
    const innovation = z_measured - z_predicted;

    // ── Position-jump guard ────────────────────────────────────────────────
    // Physical sanity check: correct() is called on every BLE packet, so
    // the "implied speed" from the innovation should not exceed human running.
    let R = this._bleConfidenceToR(wTotal);

    if (this._lastCorrectionTime !== null) {
      const dtSec = (now - this._lastCorrectionTime) / 1000;
      if (dtSec > 0.05) {
        // Innovation in metres / elapsed seconds = implied lateral speed
        const impliedSpeed = Math.abs(innovation) / dtSec;
        if (impliedSpeed > this._cfg.JUMP_GUARD_SPEED_MPS) {
          R *= this._cfg.JUMP_GUARD_R_MULTIPLIER;
        }
      }
    }

    // ── Proper 1D EKF Update with H = [ux, uy] ───────────────────────────
    //
    // Innovation covariance:  S = H·P·Hᵀ + R  (scalar)
    //   S = ux²·Pxx + 2·ux·uy·Pxy + uy²·Pyy + R
    //
    // Kalman gain:  K = P·Hᵀ / S  (2×1 column vector)
    //   Kx = (ux·Pxx + uy·Pxy) / S
    //   Ky = (ux·Pxy + uy·Pyy) / S
    //
    // State update:  x = x + K · innovation
    // Covariance:    P = (I - K·H) · P
    //
    // This is the mathematically correct form for a 1D observation of a 2D state.
    // It only pulls the position in the DIRECTION we actually have information about.

    const S = ux * ux * this._pxx
            + 2 * ux * uy * this._pxy
            + uy * uy * this._pyy
            + R;

    if (S < 1e-9) return; // degenerate

    const Kx = (ux * this._pxx + uy * this._pxy) / S;
    const Ky = (ux * this._pxy + uy * this._pyy) / S;

    // State correction — moves position in the baseline direction only
    this._x += Kx * innovation;
    this._y += Ky * innovation;

    // Covariance update — Joseph form for numerical stability:
    // P_new = P - K·H·P
    //   ΔPxx = Kx·(ux·Pxx + uy·Pxy)
    //   ΔPyy = Ky·(ux·Pxy + uy·Pyy)
    //   ΔPxy = Kx·(ux·Pxy + uy·Pyy)  [or equivalently Ky*(ux*Pxx+uy*Pxy)]
    const dPxx = Kx * (ux * this._pxx + uy * this._pxy);
    const dPyy = Ky * (ux * this._pxy + uy * this._pyy);
    const dPxy = Kx * (ux * this._pxy + uy * this._pyy);

    this._pxx = Math.max(1e-6, this._pxx - dPxx);
    this._pyy = Math.max(1e-6, this._pyy - dPyy);
    this._pxy = this._pxy - dPxy;

    // Soft-clamp to room bounds
    this._clampToRoom();

    // Sync corrected position back to PDR engine
    const newUncertainty = this._getUncertaintyRadius();
    pdrEngine.applyCorrection(this._x, this._y, newUncertainty);

    this._lastCorrectionTime = now;
    this._lastBleConf = Math.min(1.0, (w1 + w2) / 2);
    this._pushTrail(this._x, this._y);
  }

  // --------------------------------------------------------------------------
  // PASSIVE TICK — call from setInterval (1 Hz) for passive drift
  // --------------------------------------------------------------------------

  tick() {
    const now = Date.now();
    const dtSec = (now - this._lastTickTime) / 1000;
    this._lastTickTime = now;

    // Grow covariance passively while not stepping (sensor drift)
    const Q_passive = this._cfg.Q_PASSIVE_M2_PER_S * dtSec;
    this._pxx += Q_passive;
    this._pyy += Q_passive;

    // Cap covariance (prevents indefinite growth during long BLE dropout)
    const maxP = this._cfg.MAX_UNCERTAINTY_M ** 2;
    this._pxx = Math.min(maxP, this._pxx);
    this._pyy = Math.min(maxP, this._pyy);

    pdrEngine.tickPassiveDrift(dtSec);
    this._lastPdrConf = pdrEngine.getConfidence();
  }

  // --------------------------------------------------------------------------
  // STATE ACCESSOR
  // --------------------------------------------------------------------------

  /**
   * Returns the current fused position and diagnostics for the UI.
   * @returns {{
   *   x: number, y: number,
   *   uncertaintyRadius: number,
   *   bleConfidence: number,
   *   pdrConfidence: number,
   *   fusionWeightBle: number,
   *   fusionWeightPdr: number,
   *   stepCount: number,
   *   totalDistanceM: number,
   *   trail: Array<{x, y}>
   * }}
   */
  getState() {
    const pdrState = pdrEngine.getState();
    const bleConf = this._lastBleConf;
    const pdrConf = this._lastPdrConf || pdrState.confidence;
    const total = bleConf + pdrConf + 0.001;
    const wBle = bleConf / total;
    const wPdr = pdrConf / total;

    return {
      x: Number(this._x.toFixed(3)),
      y: Number(this._y.toFixed(3)),
      uncertaintyRadius: this._getUncertaintyRadius(),
      bleConfidence: Number(bleConf.toFixed(3)),
      pdrConfidence: Number(pdrConf.toFixed(3)),
      fusionWeightBle: Number(wBle.toFixed(3)),
      fusionWeightPdr: Number(wPdr.toFixed(3)),
      stepCount: pdrState.stepCount,
      totalDistanceM: pdrState.totalDistanceM,
      trail: [...this._trail],
    };
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  /**
   * Converts total beacon confidence weight to EKF measurement noise R.
   * High confidence (near 2.0) → small R → strong BLE pull.
   * Low confidence (near 0.0) → large R → weak BLE pull, PDR dominates.
   *
   * @param {number} wTotal - Sum of confidence² weights for both beacons [0, 2]
   * @returns {number} Measurement noise variance R (m²)
   */
  _bleConfidenceToR(wTotal) {
    // Normalize to [0, 1] (both beacons at full confidence → wTotal = 2.0)
    const normalized = Math.min(1.0, wTotal / 2.0);
    // Interpolate R from BLE_R_MAX (no confidence) to BLE_R_MIN (full confidence)
    const R = this._cfg.BLE_R_MAX - normalized * (this._cfg.BLE_R_MAX - this._cfg.BLE_R_MIN);
    return Math.max(this._cfg.BLE_R_MIN, R);
  }

  _getUncertaintyRadius() {
    // The 1-sigma uncertainty in position is √(trace(P)/2)
    const sigma = Math.sqrt((this._pxx + this._pyy) / 2);
    return Number(Math.max(this._cfg.MIN_UNCERTAINTY_M, Math.min(this._cfg.MAX_UNCERTAINTY_M, sigma)).toFixed(3));
  }

  _clampToRoom() {
    if (this._roomWidth !== null) {
      // Soft clamp: allows slight overflow, pulls back gently
      if (this._x < 0) this._x = 0;
      if (this._x > this._roomWidth) this._x = this._roomWidth;
    }
    if (this._roomHeight !== null) {
      if (this._y < 0) this._y = 0;
      if (this._y > this._roomHeight) this._y = this._roomHeight;
    }
  }

  _pushTrail(x, y) {
    // Only push if the position meaningfully changed (> 2 cm)
    const last = this._trail[this._trail.length - 1];
    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      if (dx * dx + dy * dy < 0.0004) return; // < 2 cm
    }
    this._trail.push({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
    if (this._trail.length > this._maxTrailLength) {
      this._trail.shift();
    }
  }
}

// Export a shared singleton — FusionMapScreen imports this directly.
export const fusionEngine = new FusionEngine();
