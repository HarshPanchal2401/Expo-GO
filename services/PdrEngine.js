// ============================================================================
// PdrEngine.js — Pure Pedestrian Dead Reckoning (PDR) Position Tracker
//
// Self-contained, framework-free position accumulator driven by step events.
// Used by FusionEngine as the "prediction" side of the async EKF.
//
// Usage:
//   const pdr = new PdrEngine();
//   pdr.reset(0, 0);
//   pdr.applyStep(0.75, 45.0);  // 75 cm step toward NE
//   const { x, y, uncertaintyRadius } = pdr.getState();
// ============================================================================

// ============================================================================
// CONFIGURABLE CONSTANTS
// ============================================================================

export const PDR_CONFIG = {
  // Uncertainty grows per step as a fraction of step length.
  // 10% means every 1 m step adds 0.10 m of positional uncertainty.
  STEP_UNCERTAINTY_FACTOR: 0.10,

  // Uncertainty grows passively (per second while standing still) due to
  // sensor drift and heading noise even when not walking.
  PASSIVE_DRIFT_M_PER_S: 0.005,

  // Maximum uncertainty radius the tracker will report (caps the growing halo).
  MAX_UNCERTAINTY_M: 8.0,

  // Initial uncertainty at reset (small — we know our start position).
  INITIAL_UNCERTAINTY_M: 0.3,

  // Confidence decays from 1.0 toward this floor as time since last step grows.
  MIN_CONFIDENCE: 0.15,

  // Time in milliseconds after which confidence starts decaying (still walking = no decay).
  CONFIDENCE_DECAY_START_MS: 3000,

  // Time in milliseconds over which confidence decays from 1.0 to MIN_CONFIDENCE.
  CONFIDENCE_DECAY_DURATION_MS: 20000,
};

// ============================================================================
// PdrEngine Class
// ============================================================================

export class PdrEngine {
  constructor(config = {}) {
    this._cfg = { ...PDR_CONFIG, ...config };
    this._state = this._makeInitialState();
  }

  _makeInitialState() {
    return {
      x: 0,
      y: 0,
      headingDeg: 0,
      stepCount: 0,
      totalDistanceM: 0,
      lastStepTime: null,       // timestamp of most recent step (ms)
      resetTime: Date.now(),    // timestamp of last reset
      uncertaintyRadius: this._cfg.INITIAL_UNCERTAINTY_M,
    };
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /**
   * Reset PDR to a known position (cold start or BLE-corrected anchor).
   * @param {number} x - Initial X coordinate in metres
   * @param {number} y - Initial Y coordinate in metres
   */
  reset(x = 0, y = 0) {
    const now = Date.now();
    this._state = {
      ...this._makeInitialState(),
      x: Number(x) || 0,
      y: Number(y) || 0,
      resetTime: now,
      lastStepTime: now,
    };
  }

  /**
   * Apply a single confirmed step to the PDR position.
   * Fires on each accelerometer-detected step event.
   *
   * Coordinate convention (same as App.android.js addStep):
   *   Heading 0°   → +Y (North / Forward)
   *   Heading 90°  → +X (East / Right)
   *   Heading -90° → -X (West / Left)
   *   Heading 180° → -Y (South / Backward)
   *
   * @param {number} stepLengthM - Weinberg-estimated step length in metres [0.45, 1.05]
   * @param {number} headingDeg  - Current smoothed heading in degrees (relative to calibrated zero)
   */
  applyStep(stepLengthM, headingDeg) {
    const len = this._clampStepLength(stepLengthM);
    const rad = (headingDeg * Math.PI) / 180;

    this._state.x += len * Math.sin(rad);
    this._state.y += len * Math.cos(rad);
    this._state.headingDeg = headingDeg;
    this._state.stepCount++;
    this._state.totalDistanceM += len;
    this._state.lastStepTime = Date.now();

    // Accumulate positional uncertainty: σ grows by 10% of step length per step.
    // This models step-length estimation error and heading noise.
    const stepSigma = this._cfg.STEP_UNCERTAINTY_FACTOR * len;
    this._state.uncertaintyRadius = Math.min(
      this._cfg.MAX_UNCERTAINTY_M,
      Math.sqrt(this._state.uncertaintyRadius ** 2 + stepSigma ** 2)
    );
  }

  /**
   * Advance the passive time-based drift component.
   * Call this periodically (e.g. every second) when standing still,
   * so the uncertainty halo grows even when no steps occur.
   *
   * @param {number} dtSec - Elapsed seconds since last call
   */
  tickPassiveDrift(dtSec) {
    const safeDt = Math.max(0, Math.min(dtSec, 5.0));
    this._state.uncertaintyRadius = Math.min(
      this._cfg.MAX_UNCERTAINTY_M,
      this._state.uncertaintyRadius + this._cfg.PASSIVE_DRIFT_M_PER_S * safeDt
    );
  }

  /**
   * Externally correct the current position estimate (called by FusionEngine
   * after an EKF BLE correction step). Also shrinks the uncertainty radius
   * because BLE has anchored the position.
   *
   * @param {number} correctedX
   * @param {number} correctedY
   * @param {number} newUncertaintyM - Updated uncertainty radius from EKF
   */
  applyCorrection(correctedX, correctedY, newUncertaintyM) {
    this._state.x = Number.isFinite(correctedX) ? correctedX : this._state.x;
    this._state.y = Number.isFinite(correctedY) ? correctedY : this._state.y;
    this._state.uncertaintyRadius = Number.isFinite(newUncertaintyM)
      ? Math.max(this._cfg.INITIAL_UNCERTAINTY_M, newUncertaintyM)
      : this._state.uncertaintyRadius;
  }

  /**
   * Returns a PDR confidence score in [0, 1]:
   *   1.0  = recent step detected, low uncertainty
   *   ~0.5 = step detected a few seconds ago
   *   MIN  = standing still for a long time
   *
   * @returns {number} Confidence [MIN_CONFIDENCE, 1.0]
   */
  getConfidence() {
    if (this._state.lastStepTime === null) return this._cfg.MIN_CONFIDENCE;

    const msSinceStep = Date.now() - this._state.lastStepTime;
    const decayStart = this._cfg.CONFIDENCE_DECAY_START_MS;
    const decayDuration = this._cfg.CONFIDENCE_DECAY_DURATION_MS;

    if (msSinceStep <= decayStart) return 1.0;

    const elapsed = msSinceStep - decayStart;
    const ratio = Math.min(1.0, elapsed / decayDuration);
    // Smooth exponential decay curve
    const conf = 1.0 - ratio * (1.0 - this._cfg.MIN_CONFIDENCE);
    return Math.max(this._cfg.MIN_CONFIDENCE, conf);
  }

  /**
   * Returns the current full state snapshot.
   * @returns {{ x, y, headingDeg, stepCount, totalDistanceM, uncertaintyRadius, confidence }}
   */
  getState() {
    return {
      x: Number(this._state.x.toFixed(3)),
      y: Number(this._state.y.toFixed(3)),
      headingDeg: this._state.headingDeg,
      stepCount: this._state.stepCount,
      totalDistanceM: Number(this._state.totalDistanceM.toFixed(2)),
      lastStepTime: this._state.lastStepTime,
      uncertaintyRadius: Number(this._state.uncertaintyRadius.toFixed(3)),
      confidence: Number(this.getConfidence().toFixed(3)),
    };
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  _clampStepLength(len) {
    if (!Number.isFinite(len)) return 0.70; // safe fallback
    return Math.max(0.45, Math.min(1.05, len));
  }
}

// Export a shared singleton for convenience (FusionEngine imports this).
export const pdrEngine = new PdrEngine();
