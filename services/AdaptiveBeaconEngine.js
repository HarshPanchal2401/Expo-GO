// ============================================================================
// AdaptiveBeaconEngine.js — Adaptive, Per-Beacon Signal Processing & Localization
//
// Addresses physical beacon hardware inconsistencies and multipath volatility
// through a fully individualized, per-beacon adaptive pipeline:
//
// 1. BeaconProfile:
//    Tracks a sliding sample window per beacon ID, computing live mean (μ),
//    raw dispersion (σ², display only), a trend-cancelled NOISE variance
//    (successive-difference based — see getNoiseVariance()), and a continuous
//    [0, 1] stability score driven by that noise variance.
//
// 2. AdaptiveKalmanFilter:
//    Individual Kalman instance per beacon ID. Scales process noise covariance Q
//    and measurement noise covariance R dynamically based on that beacon's live
//    NOISE variance (not raw dispersion, which is inflated by real motion/trend):
//      - Stable beacons (low noise σ²) -> Small R, small Q -> Responsive, ~5-sample settle.
//      - Erratic beacons (high noise σ²) -> Higher R (capped at R_MAX) -> Filter
//        distrusts raw samples without its gain collapsing to near-zero.
//    A single Kalman pass is the ONLY smoothing stage — there is deliberately no
//    second cascaded IIR filter downstream, since two smoothers in series just
//    compound lag without improving accuracy.
//
// 3. PathLossCalibrator:
//    Fits environmental path loss exponent (n) and TxPower@1m for each beacon
//    via Ordinary Least Squares (OLS) linear regression on empirical calibration points:
//      RSSI = -n · (10 · log10(d)) + TxPower_1m
//    Calibration reference points should be logged at the true straight-line
//    (slant) distance to the beacon — see the height-correction note in step 4.
//
// 4. Outlier Rejection & Height Correction:
//    Rejects / clamps samples deviating > 9 dBm from that beacon's rolling
//    median before statistical ingestion. Optionally converts the resulting 3D
//    slant range to a 2D floor-plane distance via BeaconManager.setHeights(),
//    for beacons mounted at a different height than the phone.
//
// 5. BeaconManager:
//    Orchestrates the pipeline per beacon, applies a kinematic walking-speed
//    PLAUSIBILITY CLAMP (not a smoother — see ingestReading() step 7), outputs a
//    live confidence score C ∈ [0, 1], and computes a confidence-squared
//    weighted position estimate (w_i = C_i²).
// ============================================================================

import AsyncStorage from "@react-native-async-storage/async-storage";

// ============================================================================
// CONFIGURABLE CONSTANTS (Deploy-time tuning parameters — no magic numbers)
// ============================================================================

export const DEFAULT_ADAPTIVE_CONFIG = {
  // Size of rolling RSSI window for statistical dispersion & median estimation
  ROLLING_WINDOW_SIZE: 10,

  // Outlier rejection threshold in dBm relative to rolling median
  // Clamps spurious multipath RF reflection spikes (> 9 dBm)
  OUTLIER_THRESHOLD_DBM: 9.0,

  // Adaptive Kalman: Process Noise Covariance (Q) floor and ceiling.
  // NOTE: these now scale with NOISE variance (successive-difference based, see
  // BeaconProfile.getNoiseVariance), not raw window variance — a beacon that is
  // trending steadily (user walking toward/away from it) no longer gets misread
  // as "unstable", so the filter stays responsive during real motion.
  Q_FLOOR: 0.08,
  Q_CEILING: 0.5,
  VARIANCE_THRESHOLD: 10.0, // Noise variance (dBm²) at which Q caps at Q_CEILING

  // Adaptive Kalman: Measurement Noise Covariance (R) floor and ceiling.
  // R_MIN is the realistic BLE RF noise floor for a clean line-of-sight beacon.
  // R_MAX prevents runaway distrust: previously R grew unbounded while Q was
  // capped, so any genuinely noisy/moving beacon collapsed the Kalman gain to
  // ~0.05 (15-20+ sample settling time). Capping R keeps the filter responsive
  // even for erratic beacons, while Q/R together still damp real RF noise.
  R_MIN: 3.0,
  R_MAX: 25.0,

  // Fallback path loss parameters if beacon is not individually calibrated
  DEFAULT_TX_POWER_1M: -59.0,
  DEFAULT_PATH_LOSS_N: 2.2,

  // Kinematic walking ceiling (1.6 m/s represents natural indoor walking speed).
  // This is a PLAUSIBILITY CLAMP, not a smoother — see ingestReading() step 7.
  MAX_WALKING_SPEED_M_S: 1.6,

  // Near-field touch non-linearity correction thresholds in dBm
  TOUCH_SATURATION_DBM: -43.0,
  NEAR_FIELD_LIMIT_DBM: -50.0,

  // Stale beacon timeout in milliseconds (decays confidence if packets stop arriving)
  STALE_TIMEOUT_MS: 3000,

  // Optional 3D slant -> 2D floor-plane height correction, for beacons mounted at
  // a different height than the phone (e.g. ceiling-mounted, common in floor-plan
  // deployments). null = disabled (beacon assumed to be at phone height). Set both
  // via BeaconManager.setHeights(beaconHeightM, phoneHeightM).
  BEACON_HEIGHT_M: null,
  PHONE_HEIGHT_M: 1.1,
};


// ============================================================================
// 1. BEACON PROFILE
// ============================================================================

/**
 * Tracks a rolling sample window for a specific beacon, computing live
 * statistical variance, mean, and a normalized 0–1 stability score.
 */
export class BeaconProfile {
  constructor(windowSize = DEFAULT_ADAPTIVE_CONFIG.ROLLING_WINDOW_SIZE) {
    this.windowSize = Math.max(5, Math.min(50, windowSize));
    this.samples = []; // Array of { rssi, timestamp }
    this.totalSamplesReceived = 0;
    this.lastTimestamp = null;
  }

  /**
   * Appends a validated, clean RSSI measurement to the rolling profile window.
   */
  addSample(rssi, timestamp = Date.now()) {
    if (!Number.isFinite(rssi)) return;
    this.totalSamplesReceived++;
    this.lastTimestamp = timestamp;
    this.samples.push({ rssi, timestamp });

    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
  }

  /**
   * Computes rolling median across current sample window.
   * WHY: Median is impervious to asymmetric multipath spikes, providing
   * the ideal reference baseline for outlier gating.
   */
  getRollingMedian() {
    if (this.samples.length === 0) return null;
    const sorted = this.samples.map((s) => s.rssi).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0;
  }

  /**
   * Computes sample mean (μ).
   */
  getMean() {
    if (this.samples.length === 0) return null;
    const sum = this.samples.reduce((acc, s) => acc + s.rssi, 0);
    return Number((sum / this.samples.length).toFixed(2));
  }

  /**
   * Computes sample variance (σ² = (1/N) * Σ(x_i - μ)²).
   * WHY: Variance is the primary driver of our adaptive engine. A beacon with
   * poor crystal oscillators or placed near metal shelves will exhibit high variance;
   * a line-of-sight beacon exhibits low variance.
   */
  getVariance() {
    if (this.samples.length < 2) return 1.0;
    const mean = this.getMean();
    const sumSq = this.samples.reduce((acc, s) => acc + (s.rssi - mean) ** 2, 0);
    return Number((sumSq / this.samples.length).toFixed(2));
  }

  /**
   * Computes standard deviation (σ) of the raw window (dispersion, for display).
   */
  getStdDev() {
    return Number(Math.sqrt(this.getVariance()).toFixed(2));
  }

  /**
   * Computes measurement-NOISE variance from successive-difference statistics,
   * isolating true RF/measurement jitter from real signal trend.
   *
   * WHY: getVariance() measures dispersion of the raw window, which is inflated
   * by any genuine trend in the data — e.g. RSSI rising steadily as the user
   * walks toward the beacon. That previously caused the adaptive filter to
   * interpret real motion as "instability" and slow itself down at exactly the
   * moment responsiveness mattered most. Differencing consecutive samples
   * cancels a locally-linear trend: for a signal = trend + white noise, the
   * variance of consecutive differences is 2·Var(noise) regardless of the
   * trend's slope. Dividing by 2 recovers the true per-sample noise variance.
   */
  getNoiseVariance() {
    if (this.samples.length < 3) return 4.0; // moderate default until enough data
    const diffs = [];
    for (let i = 1; i < this.samples.length; i++) {
      diffs.push(this.samples[i].rssi - this.samples[i - 1].rssi);
    }
    const meanDiff = diffs.reduce((acc, d) => acc + d, 0) / diffs.length;
    const sumSq = diffs.reduce((acc, d) => acc + (d - meanDiff) ** 2, 0);
    const diffVariance = sumSq / diffs.length;
    return Number(Math.max(0.5, diffVariance / 2.0).toFixed(2));
  }

  /**
   * Computes a normalized stability score S ∈ [0.0, 1.0], driven by NOISE
   * variance (not raw dispersion) so a beacon isn't penalized just because the
   * user is walking and its RSSI is legitimately trending.
   * WHY: Feeds downstream multilateration confidence weighting.
   *   - Noise variance <= 1.0 dBm² -> S ≈ 0.95 - 1.00 (Rock solid)
   *   - Noise variance = 10.0 dBm² -> S ≈ 0.50 (Moderate noise)
   *   - Noise variance >= 20.0 dBm² -> S = 0.00 (Unusable / heavy multipath)
   */
  getStabilityScore() {
    if (this.samples.length < 3) return 0.5;
    const noiseVariance = this.getNoiseVariance();
    const normalized = 1.0 - noiseVariance / 20.0;
    return Number(Math.max(0.0, Math.min(1.0, normalized)).toFixed(3));
  }

  reset() {
    this.samples = [];
    this.totalSamplesReceived = 0;
    this.lastTimestamp = null;
  }
}

// ============================================================================
// 2. ADAPTIVE KALMAN FILTER
// ============================================================================

/**
 * 1D Kalman Filter instance dedicated to a single beacon.
 * Dynamically scales Q and R based on that beacon's live variance.
 */
export class AdaptiveKalmanFilter {
  constructor(initialRssi = -60.0) {
    this.x = initialRssi; // State estimate (filtered RSSI in dBm)
    this.p = 1.0;         // Error covariance estimate
    this.k = 0.5;         // Current Kalman gain
    this.currentQ = DEFAULT_ADAPTIVE_CONFIG.Q_FLOOR;
    this.currentR = DEFAULT_ADAPTIVE_CONFIG.R_MIN;
    this.initialized = false;
  }

  /**
   * Steps the Kalman filter with a new raw measurement z.
   *
   * @param {number} z - New cleaned raw RSSI reading
   * @param {number} measuredVariance - Live NOISE variance σ² from BeaconProfile.getNoiseVariance()
   * @param {object} config - Tuning configuration object
   * @returns {{ filteredRssi: number, kalmanGain: number, q: number, r: number, errorCovariance: number }}
   */
  step(z, measuredVariance, config = DEFAULT_ADAPTIVE_CONFIG) {
    if (!Number.isFinite(z)) return { filteredRssi: this.x, kalmanGain: this.k, q: this.currentQ, r: this.currentR };

    if (!this.initialized) {
      this.x = z;
      this.p = 5.0; // High initial uncertainty allows immediate responsiveness on second packet
      this.initialized = true;
      return {
        filteredRssi: Number(this.x.toFixed(2)),
        kalmanGain: 1.0,
        q: this.currentQ,
        r: this.currentR,
        errorCovariance: this.p,
      };
    }

    const varSafe = Math.max(0.1, Number.isFinite(measuredVariance) ? measuredVariance : 2.0);

    // -------------------------------------------------------------------------
    // WHY ADAPTIVE Q:
    // Process noise covariance Q reflects state volatility. Below is fed the
    // trend-cancelled NOISE variance, so a beacon's Q no longer rises just
    // because the user is walking (only genuine multipath/RF noise raises it).
    // Q stays at Q_FLOOR when noise is low, keeping the filtered estimate calm.
    // As noise variance approaches VARIANCE_THRESHOLD, Q scales up to Q_CEILING,
    // preventing the filter's error covariance (p) from shrinking so much that
    // it lags behind true physical movements.
    // -------------------------------------------------------------------------
    const qFloor = config.Q_FLOOR;
    const qCeil = config.Q_CEILING;
    const varThresh = config.VARIANCE_THRESHOLD;

    if (varSafe <= varThresh) {
      this.currentQ = qFloor + (qCeil - qFloor) * (varSafe / varThresh);
    } else {
      this.currentQ = qCeil;
    }

    // -------------------------------------------------------------------------
    // WHY ADAPTIVE R (bounded):
    // Measurement noise covariance R represents sensor inaccuracy, estimated
    // from NOISE variance (trend-cancelled), not raw dispersion:
    //   - Clean beacon (noise σ² = 1.5 dBm²): R = 3.0 (floor) -> High Kalman
    //     Gain K -> filter tracks true movement in ~5 samples.
    //   - Noisy beacon (noise σ² = 35.0 dBm²): R = 25.0 (ceiling) -> Lower gain
    //     -> filter damps the noise, but the R_MAX ceiling keeps gain from
    //     collapsing toward zero the way an unbounded R previously did.
    // -------------------------------------------------------------------------
    this.currentR = Math.min(config.R_MAX ?? 25.0, Math.max(config.R_MIN, varSafe));

    // 1. Time Update (Predict)
    // For stationary / low-acceleration indoor beacons, constant-position model:
    // x_k|k-1 = x_k-1
    const xPred = this.x;
    const pPred = this.p + this.currentQ;

    // 2. Measurement Update (Correct)
    const innovation = z - xPred;
    const innovationCovariance = pPred + this.currentR;
    this.k = pPred / innovationCovariance;

    this.x = xPred + this.k * innovation;
    this.p = (1.0 - this.k) * pPred;

    return {
      filteredRssi: Number(this.x.toFixed(2)),
      kalmanGain: Number(this.k.toFixed(4)),
      q: Number(this.currentQ.toFixed(4)),
      r: Number(this.currentR.toFixed(2)),
      errorCovariance: Number(this.p.toFixed(4)),
    };
  }

  reset(initialRssi = -60.0) {
    this.x = initialRssi;
    this.p = 1.0;
    this.k = 0.5;
    this.initialized = false;
  }
}

// ============================================================================
// 3. PATH LOSS CALIBRATOR (OLS Linear Regression)
// ============================================================================

/**
 * Fits per-beacon environmental path-loss exponent (n) and TxPower@1m
 * from a set of empirical reference measurements recorded during a calibration walk.
 *
 * DUAL-SLOPE (BREAKPOINT) MODEL:
 * A single log-distance exponent fit from short, mostly line-of-sight readings
 * systematically UNDER-estimates real-world attenuation once the signal has to
 * cross walls/glass at longer range — which is exactly what makes a true 10 m
 * read as ~20 m in an obstacle-heavy office. Instead of forcing one straight
 * line through both regimes, this fits two: a near-field slope (n_near) from
 * points at/below BREAKPOINT_DISTANCE_M, and a separate, typically steeper,
 * far-field slope (n_far) from points beyond it — continuous at the
 * breakpoint, so there's no discontinuity in the inverted distance. This
 * activates automatically once you log at least 2 calibration points on each
 * side of the breakpoint (e.g. 1-3 m near, plus 8-10+ m through the real
 * walls/glass the beacon will actually be seen through) — no floor plan or
 * wall count needed. With fewer points it falls back to the original
 * single-slope OLS fit across all points.
 */
export class PathLossCalibrator {
  constructor(beaconId, breakpointDistanceM = 6.0) {
    this.beaconId = beaconId;
    this.referencePoints = []; // Array of { distanceM, rssi, timestamp }
    this.fittedN = DEFAULT_ADAPTIVE_CONFIG.DEFAULT_PATH_LOSS_N;
    this.fittedTxPower1m = DEFAULT_ADAPTIVE_CONFIG.DEFAULT_TX_POWER_1M;
    this.rSquared = null;
    this.isCalibrated = false;

    // Dual-slope far-field state (populated only when enough far points exist)
    this.breakpointDistanceM = breakpointDistanceM;
    this.hasFarSegment = false;
    this.fittedNFar = null;
    this.rssiAtBreakpoint = null; // RSSI predicted by the near segment at the breakpoint
  }

  /**
   * Log a calibration reference reading at a known physical distance.
   *
   * @param {number} distanceM - Known physical distance in meters (e.g. 1.0, 3.0, 5.0)
   * @param {number} rssi - Measured average RSSI at that distance
   */
  addReferencePoint(distanceM, rssi) {
    if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(rssi)) return;
    this.referencePoints.push({
      distanceM: Number(distanceM.toFixed(2)),
      rssi: Number(rssi.toFixed(1)),
      timestamp: Date.now(),
    });
  }

  removeReferencePoint(index) {
    if (index >= 0 && index < this.referencePoints.length) {
      this.referencePoints.splice(index, 1);
    }
  }

  clear() {
    this.referencePoints = [];
    this.rSquared = null;
    this.isCalibrated = false;
    this.hasFarSegment = false;
    this.fittedNFar = null;
    this.rssiAtBreakpoint = null;
  }

  /**
   * Ordinary Least Squares fit of Y = a·X + b over arbitrary point arrays.
   * Returns null if fewer than 2 points or all points share the same X.
   */
  _olsFit(pts) {
    const M = pts.length;
    if (M < 2) return null;
    const sumX = pts.reduce((acc, p) => acc + p.x, 0);
    const sumY = pts.reduce((acc, p) => acc + p.y, 0);
    const meanX = sumX / M;
    const meanY = sumY / M;
    let numerator = 0;
    let denominator = 0;
    for (const p of pts) {
      numerator += (p.x - meanX) * (p.y - meanY);
      denominator += (p.x - meanX) ** 2;
    }
    if (Math.abs(denominator) < 1e-6) return null;
    const slopeA = numerator / denominator;
    const interceptB = meanY - slopeA * meanX;
    return { slopeA, interceptB, meanX, meanY, M };
  }

  /**
   * Sets and persists the calibrated 1-meter reference RSSI (TxPower@1m).
   * Also updates or prepends the 1.0m reference point for OLS modeling.
   * @param {number} txPower1m 
   */
  set1MeterTxPower(txPower1m) {
    const val = Number(Number(txPower1m).toFixed(1));
    this.fittedTxPower1m = val;
    this.isCalibrated = true;
    const idx = this.referencePoints.findIndex((p) => Math.abs(p.distanceM - 1.0) < 0.1);
    if (idx >= 0) {
      this.referencePoints[idx] = { distanceM: 1.0, rssi: val, timestamp: Date.now() };
    } else {
      this.referencePoints.unshift({ distanceM: 1.0, rssi: val, timestamp: Date.now() });
    }
    this.saveToStorage();
    return { success: true, txPower1m: val };
  }

  /**
   * Performs Ordinary Least Squares (OLS) Linear Regression on calibration points:
   *   RSSI = TxPower_1m - 10 · n · log10(distance)
   *
   * Linear Form: Y = a · X + b
   *   Where:
   *     X = 10 · log10(distance)
   *     Y = RSSI
   *     Slope a = -n  ==>  n = -a
   *     Intercept b = TxPower_1m
   *
   * Automatically upgrades to a dual-slope (breakpoint) fit — see class doc —
   * when at least 2 points exist on each side of breakpointDistanceM.
   *
   * @returns {{ n: number, txPower1m: number, rSquared: number, pointCount: number, hasFarSegment: boolean, nFar: number|null } | null}
   */
  fitModel() {
    if (this.referencePoints.length < 2) {
      return null;
    }

    const toXY = (p) => ({ x: 10.0 * Math.log10(p.distanceM), y: p.rssi });
    const nearRaw = this.referencePoints.filter((p) => p.distanceM <= this.breakpointDistanceM);
    const farRaw = this.referencePoints.filter((p) => p.distanceM > this.breakpointDistanceM);

    const canFitDualSlope = nearRaw.length >= 2 && farRaw.length >= 2;

    // ── Near-segment fit (or single-segment fit across ALL points as fallback) ──
    const nearFit = this._olsFit((canFitDualSlope ? nearRaw : this.referencePoints).map(toXY));
    if (!nearFit) return null;

    const fittedN = Number(Math.max(1.2, Math.min(4.5, -nearFit.slopeA)).toFixed(2));
    const fittedTxPower = Number(Math.max(-95.0, Math.min(-35.0, nearFit.interceptB)).toFixed(1));

    this.fittedN = fittedN;
    this.fittedTxPower1m = fittedTxPower;
    this.hasFarSegment = false;
    this.fittedNFar = null;
    this.rssiAtBreakpoint = null;

    // ── Far-segment fit: single unknown (n_far), regression through the
    // breakpoint anchor so the piecewise model has no discontinuity ──
    if (canFitDualSlope) {
      const d0 = this.breakpointDistanceM;
      const rssiAtD0 = fittedTxPower - 10.0 * fittedN * Math.log10(d0);

      let sumXY = 0;
      let sumXX = 0;
      for (const p of farRaw) {
        const x = 10.0 * Math.log10(p.distanceM / d0); // > 0
        const y = rssiAtD0 - p.rssi; // expected > 0 (weaker signal further out)
        sumXY += x * y;
        sumXX += x * x;
      }

      if (sumXX > 1e-6) {
        const nFar = Number(Math.max(1.2, Math.min(6.5, sumXY / sumXX)).toFixed(2));
        this.hasFarSegment = true;
        this.fittedNFar = nFar;
        this.rssiAtBreakpoint = Number(rssiAtD0.toFixed(2));
      }
    }

    // ── Goodness of fit (R²) evaluated against whichever model is active ──
    const allPts = this.referencePoints;
    const meanY = allPts.reduce((acc, p) => acc + p.rssi, 0) / allPts.length;
    let ssTot = 0;
    let ssRes = 0;
    for (const p of allPts) {
      const yPred = this._predictRssi(p.distanceM);
      ssTot += (p.rssi - meanY) ** 2;
      ssRes += (p.rssi - yPred) ** 2;
    }
    const r2 = ssTot > 0 ? Math.max(0.0, 1.0 - ssRes / ssTot) : 1.0;

    this.rSquared = Number(r2.toFixed(3));
    this.isCalibrated = true;

    return {
      n: this.fittedN,
      nFar: this.fittedNFar,
      hasFarSegment: this.hasFarSegment,
      breakpointDistanceM: this.breakpointDistanceM,
      txPower1m: this.fittedTxPower1m,
      rSquared: this.rSquared,
      pointCount: allPts.length,
    };
  }

  /**
   * Predicts RSSI at a given distance under the currently fitted model
   * (dual-slope if active, otherwise single-slope). Inverse of distanceFromRssi().
   */
  _predictRssi(distanceM) {
    if (this.hasFarSegment && distanceM > this.breakpointDistanceM) {
      return this.rssiAtBreakpoint - 10.0 * this.fittedNFar * Math.log10(distanceM / this.breakpointDistanceM);
    }
    return this.fittedTxPower1m - 10.0 * this.fittedN * Math.log10(distanceM);
  }

  /**
   * Converts a filtered RSSI reading to distance using the fitted model,
   * automatically applying the far-field slope beyond the breakpoint when
   * dual-slope calibration is active. This is the single source of truth for
   * RSSI -> distance inversion once a beacon is calibrated.
   *
   * @param {number} rssi
   * @returns {number} distance in metres (>= 0)
   */
  distanceFromRssi(rssi) {
    const nearDist = Math.pow(10, (this.fittedTxPower1m - rssi) / (10.0 * this.fittedN));

    if (!this.hasFarSegment) {
      return Number.isFinite(nearDist) && nearDist >= 0 ? nearDist : 1.0;
    }

    // If the near-segment inversion already lands beyond the breakpoint, or
    // the reading is weaker than the breakpoint's predicted RSSI, use the
    // far-field slope instead.
    if (rssi <= this.rssiAtBreakpoint || nearDist > this.breakpointDistanceM) {
      const farDist = this.breakpointDistanceM *
        Math.pow(10, (this.rssiAtBreakpoint - rssi) / (10.0 * this.fittedNFar));
      return Number.isFinite(farDist) && farDist >= 0 ? farDist : this.breakpointDistanceM;
    }

    return Number.isFinite(nearDist) && nearDist >= 0 ? nearDist : 1.0;
  }

  async saveToStorage() {
    try {
      const data = {
        beaconId: this.beaconId,
        referencePoints: this.referencePoints,
        fittedN: this.fittedN,
        fittedTxPower1m: this.fittedTxPower1m,
        rSquared: this.rSquared,
        isCalibrated: this.isCalibrated,
        breakpointDistanceM: this.breakpointDistanceM,
        hasFarSegment: this.hasFarSegment,
        fittedNFar: this.fittedNFar,
        rssiAtBreakpoint: this.rssiAtBreakpoint,
      };
      await AsyncStorage.setItem(`@v2_beacon_calib_${this.beaconId}`, JSON.stringify(data));
    } catch (e) {
      console.warn("[PathLossCalibrator] Save error:", e);
    }
  }

  async loadFromStorage() {
    try {
      const raw = await AsyncStorage.getItem(`@v2_beacon_calib_${this.beaconId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.referencePoints = parsed.referencePoints || [];
        this.fittedN = parsed.fittedN || DEFAULT_ADAPTIVE_CONFIG.DEFAULT_PATH_LOSS_N;
        this.fittedTxPower1m = parsed.fittedTxPower1m || DEFAULT_ADAPTIVE_CONFIG.DEFAULT_TX_POWER_1M;
        this.rSquared = parsed.rSquared ?? null;
        this.isCalibrated = parsed.isCalibrated || false;
        this.breakpointDistanceM = parsed.breakpointDistanceM || this.breakpointDistanceM;
        this.hasFarSegment = parsed.hasFarSegment || false;
        this.fittedNFar = parsed.fittedNFar ?? null;
        this.rssiAtBreakpoint = parsed.rssiAtBreakpoint ?? null;
      }
    } catch (e) {
      console.warn("[PathLossCalibrator] Load error:", e);
    }
  }
}

// ============================================================================
// 4. BEACON MANAGER (Orchestrator & Weighted Positioning Engine)
// ============================================================================

/**
 * Manages per-beacon profiles, adaptive filters, path loss calibrators,
 * outlier rejection, and confidence-squared weighted multilateration.
 */
export class BeaconManager {
  constructor(config = DEFAULT_ADAPTIVE_CONFIG) {
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
    // Map<beaconId, BeaconRecord>
    this.beacons = new Map();
  }

  _getOrCreate(beaconId, name = null) {
    if (!this.beacons.has(beaconId)) {
      const profile = new BeaconProfile(this.config.ROLLING_WINDOW_SIZE);
      const filter = new AdaptiveKalmanFilter();
      const calibrator = new PathLossCalibrator(beaconId);
      calibrator.loadFromStorage();

      this.beacons.set(beaconId, {
        beaconId,
        name: name || `Beacon (${beaconId.slice(-5)})`,
        profile,
        filter,
        calibrator,
        outlierCount: 0,
        totalPackets: 0,
        lastRawRssi: null,
        lastFilteredRssi: null,
        lastDistanceM: null,
        lastSlantDistanceM: null,
        lastDistanceUpdate: null,
        lastTimestamp: null,
        lastKalmanResult: null,
      });
    }
    return this.beacons.get(beaconId);
  }

  /**
   * Main scan callback ingestion:
   * Ingests a raw BLE packet, performs outlier gating, steps profile & filter,
   * converts to distance using calibrated parameters, and outputs debug metrics.
   *
   * @param {string} beaconId - Unique hardware MAC or UUID
   * @param {number} rawRssi - Raw received signal strength in dBm
   * @param {number|null} txPower - Calibrated 1m Tx power if advertised in packet
   * @param {number} timestamp - Exact packet arrival timestamp in ms
   * @param {object} meta - Optional metadata (name, major, minor)
   * @returns {object} Processed per-beacon state and diagnostics
   */
  ingestReading(beaconId, rawRssi, txPower = null, timestamp = Date.now(), meta = {}) {
    if (!beaconId) return null;
    const numRssi = typeof rawRssi === "number" ? rawRssi : parseFloat(rawRssi);
    // 1. Basic Hardware Range Sanity Check
    if (!Number.isFinite(numRssi) || numRssi < -120 || numRssi > 0) {
      return null;
    }

    const entry = this._getOrCreate(beaconId, meta.name);
    entry.totalPackets++;
    entry.lastRawRssi = numRssi;
    entry.lastTimestamp = timestamp;
    if (meta.name) entry.name = meta.name;

    // 2. Outlier Rejection (Requirement 5):
    // Rejects / clamps readings deviating > OUTLIER_THRESHOLD_DBM from the rolling median.
    const median = entry.profile.getRollingMedian();
    let cleanRssi = numRssi;

    if (median !== null && entry.profile.samples.length >= 4) {
      const deviation = Math.abs(numRssi - median);
      if (deviation > this.config.OUTLIER_THRESHOLD_DBM) {
        entry.outlierCount++;
        cleanRssi = numRssi > median ? median + this.config.OUTLIER_THRESHOLD_DBM : median - this.config.OUTLIER_THRESHOLD_DBM;
      }
    }

    // 3. Update BeaconProfile with cleaned reading
    entry.profile.addSample(cleanRssi, timestamp);

    // 4. Retrieve Live Statistical Metrics from Profile.
    // `dispersion` is raw window variance (display/diagnostics only — it's
    // inflated by real trend/motion, so it must NOT drive the filter).
    // `noiseVariance` is the trend-cancelled true noise estimate that the
    // Kalman filter and confidence scoring are actually based on.
    const dispersion = entry.profile.getVariance();
    const noiseVariance = entry.profile.getNoiseVariance();
    const stabilityScore = entry.profile.getStabilityScore();

    // 5. Step Adaptive Kalman Filter with Live NOISE Variance
    const kalmanOut = entry.filter.step(cleanRssi, noiseVariance, this.config);
    const safeFilteredRssi = Number.isFinite(kalmanOut.filteredRssi) ? kalmanOut.filteredRssi : cleanRssi;
    entry.lastFilteredRssi = safeFilteredRssi;
    entry.lastKalmanResult = kalmanOut;

    // 6. Convert Filtered RSSI to Distance Using Calibrated Path-Loss Model.
    // When the beacon has a dual-slope (near/far) calibration, distanceFromRssi()
    // automatically applies the steeper far-field exponent beyond the breakpoint
    // — this is what fixes long-range-through-obstacles distance inflation that
    // a single global exponent can't capture.
    const rawN = entry.calibrator.isCalibrated ? entry.calibrator.fittedN : this.config.DEFAULT_PATH_LOSS_N;
    const safeN = Math.max(1.2, Math.min(4.5, Number.isFinite(rawN) ? rawN : 2.2));

    const rawTx = entry.calibrator.isCalibrated
      ? entry.calibrator.fittedTxPower1m
      : (txPower !== null && Number.isFinite(txPower) ? txPower : this.config.DEFAULT_TX_POWER_1M);
    const safeTx = Number.isFinite(rawTx) ? rawTx : -59.0;

    let slantDistM;
    if (entry.calibrator.isCalibrated) {
      slantDistM = entry.calibrator.distanceFromRssi(safeFilteredRssi);
    } else {
      // Uncalibrated fallback: single-slope log-distance with default/advertised Tx & n
      const ratio = (safeTx - safeFilteredRssi) / (10.0 * safeN);
      slantDistM = Math.pow(10, ratio);
    }
    if (!Number.isFinite(slantDistM) || slantDistM < 0) slantDistM = 1.0;

    // Near-Field Touch Correction (eliminates artificial 20cm floor when touching beacon)
    if (safeFilteredRssi >= this.config.TOUCH_SATURATION_DBM) {
      slantDistM = 0.0;
    } else if (safeFilteredRssi > this.config.NEAR_FIELD_LIMIT_DBM) {
      const touchFactor =
        (this.config.TOUCH_SATURATION_DBM - safeFilteredRssi) /
        (this.config.TOUCH_SATURATION_DBM - this.config.NEAR_FIELD_LIMIT_DBM);
      slantDistM = slantDistM * Math.max(0, touchFactor);
    }

    // 6b. Optional 3D Slant -> 2D Floor-Plane Height Correction.
    // Beacons mounted above/below phone height (e.g. ceiling-mounted, common in
    // real floor-plan deployments) measure a line-of-sight slant range, not the
    // horizontal distance a 2D trilateration solver needs. Disabled by default
    // (BEACON_HEIGHT_M = null) so behavior is unchanged unless configured via
    // BeaconManager.setHeights(). NOTE: if you calibrate with PathLossCalibrator,
    // log reference points using the true straight-line (slant) distance to the
    // beacon, not the floor-projected distance — the path-loss model is fit
    // against RF path length, and this correction converts that back to planar
    // distance afterward.
    let rawDistM = slantDistM;
    const beaconH = this.config.BEACON_HEIGHT_M;
    if (Number.isFinite(beaconH)) {
      const deltaH = Math.abs(beaconH - (Number.isFinite(this.config.PHONE_HEIGHT_M) ? this.config.PHONE_HEIGHT_M : 1.1));
      rawDistM = Math.sqrt(Math.max(0, slantDistM * slantDistM - deltaH * deltaH));
    }

    // 7. Kinematic Plausibility Clamp (NOT a smoother).
    // The Kalman filter above already performs the statistical smoothing — this
    // step only rejects a single-packet, physically-impossible jump (e.g. a
    // brief multipath null the outlier gate didn't catch). It intentionally adds
    // NO extra lag beyond the walking-speed ceiling itself, unlike the previous
    // alpha-blended IIR stage that damped every update a second time on top of
    // the Kalman filter.
    const prevDist = entry.lastDistanceM;
    const dtSec = entry.lastDistanceUpdate ? Math.max(0.01, (timestamp - entry.lastDistanceUpdate) / 1000.0) : 0.05;

    let clampedDistM = rawDistM;
    if (entry.totalPackets > 2 && dtSec < 1.5 && prevDist !== null && Number.isFinite(prevDist)) {
      const maxWalkDelta = Math.max(0.08, this.config.MAX_WALKING_SPEED_M_S * dtSec);
      const delta = rawDistM - prevDist;
      if (Math.abs(delta) > maxWalkDelta) {
        clampedDistM = prevDist + Math.sign(delta) * maxWalkDelta;
      }
    }

    entry.lastDistanceM = Number(Math.max(0, clampedDistM).toFixed(2));
    entry.lastSlantDistanceM = Number(Math.max(0, slantDistM).toFixed(2));
    entry.lastDistanceUpdate = timestamp;

    // 8. Compute Live Confidence Score C ∈ [0.0, 1.0]
    const ageMs = timestamp - entry.lastTimestamp;
    const recencyFactor = Math.max(0.0, 1.0 - ageMs / this.config.STALE_TIMEOUT_MS);
    const sufficiencyFactor = Math.min(1.0, entry.profile.samples.length / 5.0);
    const rawConf = stabilityScore * recencyFactor * sufficiencyFactor;
    const confidenceScore = Number.isFinite(rawConf) ? Number(Math.max(0, Math.min(1, rawConf)).toFixed(3)) : 0.5;

    return {
      beaconId,
      name: entry.name,
      rawRssi: numRssi,
      filteredRssi: entry.lastFilteredRssi,
      distanceM: entry.lastDistanceM,
      distanceFt: Number((entry.lastDistanceM * 3.28084).toFixed(2)),
      distanceSlantM: entry.lastSlantDistanceM,
      variance: Number.isFinite(dispersion) ? dispersion : 1.0,
      noiseVariance: Number.isFinite(noiseVariance) ? noiseVariance : 4.0,
      stdDev: entry.profile.getStdDev(),
      stabilityScore: Number.isFinite(stabilityScore) ? stabilityScore : 0.5,
      confidenceScore,
      currentN: safeN,
      txPower1m: safeTx,
      isCalibrated: Boolean(entry.calibrator.isCalibrated),
      hasFarSegment: Boolean(entry.calibrator.hasFarSegment),
      currentNFar: entry.calibrator.fittedNFar,
      breakpointDistanceM: entry.calibrator.breakpointDistanceM,
      kalmanQ: kalmanOut.q,
      kalmanR: kalmanOut.r,
      kalmanGain: kalmanOut.kalmanGain,
      outlierCount: entry.outlierCount,
      sampleCount: entry.profile.samples.length,
      lastTimestamp: timestamp,
    };
  }

  /**
   * Retrieves comprehensive per-beacon diagnostics for UI/debug inspectability.
   */
  getBeaconState(beaconId) {
    if (!this.beacons.has(beaconId)) return null;
    const entry = this.beacons.get(beaconId);
    const now = Date.now();
    const ageMs = entry.lastTimestamp ? now - entry.lastTimestamp : 99999;
    const recencyFactor = Math.max(0.0, 1.0 - ageMs / this.config.STALE_TIMEOUT_MS);
    const stability = entry.profile.getStabilityScore();
    const confidence = Number((stability * recencyFactor * Math.min(1.0, entry.profile.samples.length / 5.0)).toFixed(3));

    const n = entry.calibrator.isCalibrated ? entry.calibrator.fittedN : this.config.DEFAULT_PATH_LOSS_N;
    const tx = entry.calibrator.isCalibrated ? entry.calibrator.fittedTxPower1m : this.config.DEFAULT_TX_POWER_1M;

    return {
      beaconId,
      name: entry.name,
      rawRssi: entry.lastRawRssi,
      filteredRssi: entry.lastFilteredRssi,
      distanceM: entry.lastDistanceM,
      distanceFt: entry.lastDistanceM !== null ? Number((entry.lastDistanceM * 3.28084).toFixed(2)) : null,
      distanceSlantM: entry.lastSlantDistanceM ?? null,
      variance: entry.profile.getVariance(),
      noiseVariance: entry.profile.getNoiseVariance(),
      stdDev: entry.profile.getStdDev(),
      stabilityScore: stability,
      confidenceScore: confidence,
      currentN: n,
      txPower1m: tx,
      isCalibrated: entry.calibrator.isCalibrated,
      hasFarSegment: Boolean(entry.calibrator.hasFarSegment),
      currentNFar: entry.calibrator.fittedNFar,
      breakpointDistanceM: entry.calibrator.breakpointDistanceM,
      rSquared: entry.calibrator.rSquared,
      outlierCount: entry.outlierCount,
      kalmanResult: entry.lastKalmanResult,
      isStale: ageMs > this.config.STALE_TIMEOUT_MS,
    };
  }

  /**
   * Computes a WEIGHTED 2D Position Estimate across all visible beacons.
   *
   * WHY CONFIDENCE SQUARED (w_i = C_i²):
   * As required, weighting by confidence squared sharply penalizes unreliable / fluctuating
   * beacons. If Beacon A has confidence 0.90 (weight 0.81) and Beacon B has confidence
   * 0.40 (weight 0.16), Beacon A exerts 5x more pull on the position estimate,
   * preventing multipath noise on Beacon B from shifting the calculated location.
   *
   * @param {Array<{ beaconId: string, x: number, y: number }>} anchors - Known anchor coordinates
   * @returns {{ x: number, y: number, confidence: number, activeBeacons: number } | null}
   */
  computeWeightedPosition(anchors) {
    if (!Array.isArray(anchors) || anchors.length === 0) return null;

    try {
      const visible = [];
      for (const a of anchors) {
        if (!a || !a.beaconId) continue;
        const state = this.getBeaconState(a.beaconId);
        if (state && state.distanceM !== null && Number.isFinite(state.distanceM) && !state.isStale && (state.confidenceScore || 0) > 0.05) {
          visible.push({
            beaconId: a.beaconId,
            x: Number.isFinite(a.x) ? a.x : 0,
            y: Number.isFinite(a.y) ? a.y : 0,
            r: state.distanceM,
            confidence: Number.isFinite(state.confidenceScore) ? state.confidenceScore : 0.5,
            weight: Math.max(1e-4, ((state.confidenceScore || 0.5) ** 2)), // Squared penalty
          });
        }
      }

      if (visible.length === 0) return null;

      // Single Beacon Case: User located in circle radius around beacon
      if (visible.length === 1) {
        return {
          x: visible[0].x,
          y: visible[0].y,
          confidence: Number(visible[0].confidence.toFixed(2)),
          activeBeacons: 1,
          residuals: 0,
        };
      }

      // Two Beacon Case: Weighted circle chord center
      if (visible.length === 2) {
        const b1 = visible[0];
        const b2 = visible[1];
        const D = Math.hypot(b2.x - b1.x, b2.y - b1.y);

        if (D < 1e-4) {
          return { x: b1.x, y: b1.y, confidence: b1.confidence, activeBeacons: 2 };
        }

        // Orthogonal chord distance a
        const a = (b1.r ** 2 - b2.r ** 2 + D ** 2) / (2.0 * D);
        const aClamped = Math.max(-0.2 * D, Math.min(1.2 * D, a));
        const p0x = b1.x + (aClamped / D) * (b2.x - b1.x);
        const p0y = b1.y + (aClamped / D) * (b2.y - b1.y);

        // Weight chord center with proximity centroids by confidence squared
        const totalW = b1.weight + b2.weight;
        const w1 = totalW > 0 ? b1.weight / totalW : 0.5;
        const w2 = totalW > 0 ? b2.weight / totalW : 0.5;

        const centroidX = w1 * b1.x + w2 * b2.x;
        const centroidY = w1 * b1.y + w2 * b2.y;

        const posX = 0.7 * p0x + 0.3 * centroidX;
        const posY = 0.7 * p0y + 0.3 * centroidY;

        const safeX = Number.isFinite(posX) ? Number(posX.toFixed(2)) : b1.x;
        const safeY = Number.isFinite(posY) ? Number(posY.toFixed(2)) : b1.y;
        const avgConf = Number.isFinite(b1.confidence) && Number.isFinite(b2.confidence)
          ? Number(((b1.confidence + b2.confidence) / 2.0).toFixed(2))
          : 0.5;

        return {
          x: safeX,
          y: safeY,
          confidence: avgConf,
          activeBeacons: 2,
        };
      }

      // Three or More Beacons: Weighted Linear Least Squares (WLS) Multilateration
      const ref = visible[0];
      let sumW = 0;
      let ATA_00 = 0;
      let ATA_01 = 0;
      let ATA_11 = 0;
      let ATb_0 = 0;
      let ATb_1 = 0;

      for (let i = 1; i < visible.length; i++) {
        const cur = visible[i];
        const A_row_0 = 2.0 * (cur.x - ref.x);
        const A_row_1 = 2.0 * (cur.y - ref.y);
        const b_row =
          ref.r ** 2 - cur.r ** 2 + (cur.x ** 2 - ref.x ** 2) + (cur.y ** 2 - ref.y ** 2);

        const w = cur.weight;
        sumW += w;

        ATA_00 += w * A_row_0 * A_row_0;
        ATA_01 += w * A_row_0 * A_row_1;
        ATA_11 += w * A_row_1 * A_row_1;
        ATb_0 += w * A_row_0 * b_row;
        ATb_1 += w * A_row_1 * b_row;
      }

      const det = ATA_00 * ATA_11 - ATA_01 * ATA_01;
      if (Math.abs(det) < 1e-6 || sumW <= 0) {
        let cx = 0;
        let cy = 0;
        const divisor = sumW > 0 ? sumW : visible.length;
        for (const v of visible) {
          cx += v.weight * v.x;
          cy += v.weight * v.y;
        }
        return {
          x: Number((cx / divisor).toFixed(2)),
          y: Number((cy / divisor).toFixed(2)),
          confidence: Number((visible.reduce((acc, v) => acc + v.confidence, 0) / visible.length).toFixed(2)),
          activeBeacons: visible.length,
        };
      }

      const xSol = (ATA_11 * ATb_0 - ATA_01 * ATb_1) / det;
      const ySol = (ATA_00 * ATb_1 - ATA_01 * ATb_0) / det;

      const avgConf = visible.reduce((acc, v) => acc + v.confidence, 0) / visible.length;

      return {
        x: Number.isFinite(xSol) ? Number(xSol.toFixed(2)) : 0,
        y: Number.isFinite(ySol) ? Number(ySol.toFixed(2)) : 0,
        confidence: Number.isFinite(avgConf) ? Number(avgConf.toFixed(2)) : 0.5,
        activeBeacons: visible.length,
      };
    } catch (err) {
      console.warn("[AdaptiveBeaconEngine] computeWeightedPosition error:", err);
      return null;
    }
  }

  getCalibrator(beaconId) {
    return this._getOrCreate(beaconId).calibrator;
  }

  /**
   * Configures global 3D slant -> 2D floor-plane height correction, applied to
   * every beacon's distance going forward. Use this when beacons are mounted at
   * a consistent height different from the phone (e.g. ceiling-mounted at 2.7m
   * while the phone is carried at ~1.1m) — common for real floor-plan
   * deployments where beacons aren't at hand height.
   *
   * @param {number|null} beaconHeightM - Beacon mount height in metres, or null to disable
   * @param {number} phoneHeightM - Typical carried phone height in metres (default 1.1)
   */
  setHeights(beaconHeightM, phoneHeightM = 1.1) {
    this.config.BEACON_HEIGHT_M = Number.isFinite(beaconHeightM) ? beaconHeightM : null;
    this.config.PHONE_HEIGHT_M = Number.isFinite(phoneHeightM) ? phoneHeightM : 1.1;
  }
}

// Global active engine singleton for application-wide consistency
export const adaptiveEngine = new BeaconManager();
