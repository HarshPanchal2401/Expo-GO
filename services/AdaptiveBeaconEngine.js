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

  // Outlier rejection thresholds in dBm relative to the rolling median.
  // ASYMMETRIC ON PURPOSE: indoor RF degradation is one-sided. Obstruction,
  // body shadowing and multipath nulls only ever push RSSI DOWN, never up.
  // So a sudden drop is far more likely to be a transient blockage than a real
  // move away (clamp it tightly), while a sudden rise is usually a blockage
  // CLEARING — i.e. a truer, less-obstructed reading — and should be admitted
  // more readily rather than being suppressed as "noise".
  OUTLIER_DROP_THRESHOLD_DBM: 7.0,
  OUTLIER_RISE_THRESHOLD_DBM: 12.0,

  // Noise variance (dBm², successive-difference based — see
  // BeaconProfile.getNoiseVariance) at which the filter's process noise reaches
  // its full scaling. Fed from NOISE variance rather than raw window variance,
  // so a beacon whose RSSI is trending steadily because the user is walking is
  // not misread as "unstable" and slowed down exactly when it matters.
  VARIANCE_THRESHOLD: 10.0,

  // Adaptive Kalman: Measurement Noise Covariance (R) floor and ceiling.
  // R_MIN is the realistic BLE RF noise floor for a clean line-of-sight beacon.
  // R_MAX prevents runaway distrust: previously R grew unbounded while Q was
  // capped, so any genuinely noisy/moving beacon collapsed the Kalman gain to
  // ~0.05 (15-20+ sample settling time). Capping R keeps the filter responsive
  // even for erratic beacons, while Q/R together still damp real RF noise.
  R_MIN: 3.0,
  R_MAX: 25.0,

  // ── Innovation-whiteness trend detection (stationary vs moving) ──
  // Noise variance alone cannot tell "user standing still" from "user walking"
  // — both look like a spread of samples — so a single fixed Q has to choose
  // between being calm at rest OR responsive in motion, never both.
  // The innovation sequence (measurement − prediction) distinguishes them:
  //   • Standing still  -> innovations are randomly signed, mean ≈ 0 (white)
  //   • Really moving   -> innovations are consistently same-signed, because
  //                        the filter is lagging behind a genuine trend
  // trendRatio = |mean(innovation)| / mean(|innovation|) is ≈0 when white and
  // ≈1 when trending, and scales Q between calm and agile accordingly. This is
  // self-contained (needs no step-detector input), so it works on every screen.
  // Damping is applied as a HARD GATE, not a continuous blend: Q is reduced
  // only when BOTH tests agree the link is quiet, and is otherwise left exactly
  // at its baseline. A continuous blend was measurably worse — it also damped
  // slow walks (whose gentle trend hides inside the noise), costing ~17%
  // tracking lag. Gating keeps the full stationary benefit at zero cost in
  // motion, because anything not clearly stationary behaves as before.
  INNOVATION_WINDOW: 8,
  STATIONARY_MIN_SAMPLES: 6,       // need this many innovations before gating
  STATIONARY_TREND_MAX: 0.35,      // trendRatio below this = looks white
  STATIONARY_INNOV_SIGMA_MAX: 1.0, // mean|innovation| below this×σ = tracking well
  STATIONARY_Q_SCALE: 0.12,        // Q multiplier once confirmed stationary

  // ── Constant-VELOCITY Kalman (replaces the old constant-position model) ──
  // The old filter assumed RSSI was a constant being measured repeatedly. That
  // model is wrong the moment the user walks: a constant-position filter can
  // only follow a ramp by lagging behind it, and the only way to make it calm
  // when standing still is to make it lag even harder when moving. That single
  // tradeoff is where the multi-second delay came from.
  // A constant-velocity model estimates BOTH the level and its rate of change
  // (dBm/s), so a steady walk is tracked with ~zero steady-state lag while the
  // noise damping stays just as strong. Latency and smoothness stop competing.
  //   PROCESS_NOISE_ACCEL: white-noise-acceleration intensity q, in dB²/s³.
  //     Governs how fast the estimated rate is allowed to change — i.e. how
  //     quickly the filter accepts that you started or stopped walking.
  //   MAX_RSSI_RATE_DB_S: hard ceiling on the rate state. Walking at 1.6 m/s
  //     can only change path loss so fast; clamping prevents a noise burst from
  //     launching the velocity estimate and overshooting.
  //   STATIONARY_RATE_DECAY: how hard the rate state is pulled to zero once the
  //     stationary gate fires. Kills the slow "drift" a CV filter would
  //     otherwise show while you stand still.
  PROCESS_NOISE_ACCEL: 12.0,
  MAX_RSSI_RATE_DB_S: 14.0,
  STATIONARY_RATE_DECAY: 0.35,

  // ── Long-horizon shadow envelope (the accuracy fix) ──
  // The dominant indoor ranging error is NOT white noise — it is slow, strongly
  // one-sided shadow fading from bodies, walls and glass, lasting seconds. A
  // low-pass filter cannot remove it (it is low-frequency), and the previous
  // percentile-gap correction could not even SEE it: that gap was measured over
  // a 10-sample (~1 s) window, which is shorter than the fade itself, so within
  // the window the shadow looks like a constant and the measured gap collapses
  // to the white-noise spread (~0.5 dB instead of the ~5 dB actually lost).
  // Physics gives a better reference: attenuation is one-sided, so the HIGHEST
  // recent RSSI is the closest thing to the unobstructed line-of-sight level.
  // Tracking a peak-hold envelope with a bounded decay rate captures that:
  //   • rises instantly  — a blockage clearing reveals the truth immediately
  //   • falls slowly     — bounded by how fast walking could genuinely weaken
  //                        the link, so real movement away is still followed
  // Ranging off that envelope instead of the distribution centre removes the
  // shadow bias that makes a true 10 m read as 19-21 m. Self-disabling: in
  // clean line-of-sight the envelope sits on the estimate and nothing changes.
  // The envelope's hold time is the one real tradeoff left: hold long and a
  // fade cannot fool you, but genuine walking is followed late; hold short and
  // the reverse. It is only a tradeoff while the engine has to GUESS whether
  // you are moving. It does not have to guess — the app runs a PDR step
  // detector, so the answer can simply be supplied via setMotionState(). With
  // it, the envelope holds hard while you stand (killing fade-driven drift)
  // and releases immediately once you step (killing the lag), instead of
  // compromising between the two. Falls back to the filter's own innovation
  // gate when no motion state has been supplied, e.g. on the Signal Lab screen.
  ENVELOPE_DECAY_DB_S: 0.35,
  ENVELOPE_HOLD_STILL_SEC: 8.0,
  ENVELOPE_HOLD_MOVING_SEC: 0.6,
  ENVELOPE_HOLD_UNKNOWN_SEC: 4.0,
  ENVELOPE_DECAY_RAMP_STILL_DB_S2: 1.5,
  ENVELOPE_DECAY_RAMP_MOVING_DB_S2: 8.0,
  ENVELOPE_DECAY_RAMP_UNKNOWN_DB_S2: 10.0,
  ENVELOPE_MAX_DECAY_DB_S: 12.0,
  MOTION_STATE_TIMEOUT_MS: 2000,
  ENVELOPE_WEIGHT: 0.85,
  MAX_ENVELOPE_CORRECTION_DB: 9.0,

  // Fallback path loss parameters if beacon is not individually calibrated.
  //
  // WHY n = 2.9 AND NOT 2.2: n is the exponent in d = 10^((Tx - RSSI)/(10n)),
  // so it sets the ENTIRE distance scale, and it is the single biggest source
  // of absolute range error before per-beacon calibration. n = 2.0 is free
  // space; 2.2 is barely more than that and describes an open corridor with
  // clear line of sight. A real furnished office - desks, partitions, people,
  // the user's own body between phone and beacon - measures 2.8 to 3.2.
  //
  // The error is not small, because it compounds logarithmically. A beacon at
  // a true 10 m with Tx = -59 reads about -89 dBm in an office. Inverted with
  // n = 2.2 that becomes 10^(30/22) = 23 m; with n = 2.9 it becomes
  // 10^(30/29) = 10.2 m. The old default reported distances roughly 2.3x too
  // long at 10 m, and the overshoot GREW with range - the worst possible shape
  // of error for an initial-position solve, which depends on two long ranges
  // agreeing with each other and with the floor plan.
  //
  // This is only the fallback. Per-beacon calibration (PathLossCalibrator, fed
  // by BeaconRangingCalibration) overrides it and should always be run for a
  // real deployment, because n and Tx both differ between two beacons.
  DEFAULT_TX_POWER_1M: -59.0,
  DEFAULT_PATH_LOSS_N: 2.9,

  // Kinematic walking ceiling (1.6 m/s represents natural indoor walking speed).
  // This is a PLAUSIBILITY CLAMP, not a smoother — see ingestReading() step 7.
  MAX_WALKING_SPEED_M_S: 1.6,

  // Slack applied to the kinematic clamp while genuinely walking, and the much
  // tighter ceiling applied while standing still. See the clamp in
  // ingestReading() step 7 for why the two states need different limits.
  MOVING_CLAMP_SLACK: 2.5,
  STATIONARY_MAX_DRIFT_M_S: 0.3,
  UNKNOWN_CLAMP_SLACK: 2.5,

  // Near-field touch non-linearity correction, expressed as dB ABOVE that
  // beacon's calibrated TxPower@1m — NOT as absolute dBm.
  // WHY: receiver saturation happens at a certain distance, and what RSSI that
  // corresponds to depends entirely on how strongly the beacon transmits. With
  // absolute thresholds (-43/-50 dBm), a beacon configured at a higher output
  // power would have its genuine mid-range distances crushed to 0.00 m — e.g.
  // a beacon calibrating to -45 dBm @1m would report 0.00 m at a real 0.8 m,
  // and start collapsing distance from 1.7 m inward. Offsets keep the curve
  // pinned to the right physical distance for ANY beacon power.
  // At n=2.2: +16 dB above the 1m reference ≈ 0.19 m, +9 dB ≈ 0.39 m — which
  // reproduces the old -43/-50 behavior for a beacon calibrated at -59 dBm.
  NEAR_FIELD_SAT_OFFSET_DB: 16.0,
  NEAR_FIELD_RAMP_OFFSET_DB: 9.0,

  // Stale beacon timeout in milliseconds (decays confidence if packets stop arriving)
  STALE_TIMEOUT_MS: 3000,

  // Packet gap that costs no confidence. A beacon advertising at 400 ms is
  // perfectly healthy, so the recency decay must not begin at the first
  // millisecond of silence or every link would sit permanently below full
  // confidence. Confidence stays at 1.0 up to this gap, then ramps linearly
  // to 0 at STALE_TIMEOUT_MS.
  PACKET_GAP_GRACE_MS: 900,

  // Optional 3D slant -> 2D floor-plane height correction, for beacons mounted at
  // a different height than the phone (e.g. ceiling-mounted, common in floor-plan
  // deployments). null = disabled (beacon assumed to be at phone height). Set both
  // via BeaconManager.setHeights(beaconHeightM, phoneHeightM).
  BEACON_HEIGHT_M: null,
  PHONE_HEIGHT_M: 1.1,

  // Absolute plausibility ceiling on computed distance (metres). A weak/noisy
  // RSSI reading combined with an uncalibrated or poorly-fit path-loss model
  // can extrapolate to a distance far larger than the deployment space is
  // physically capable of containing (e.g. reporting 30+ m in a 22 m-diagonal
  // room). null = disabled. Set via BeaconManager.setMaxPlausibleDistance(),
  // normally to the real floor plan's diagonal — nothing legitimate should
  // ever measure farther than that.
  MAX_PLAUSIBLE_DISTANCE_M: null,
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
 * 2-state (level + rate) Kalman filter dedicated to a single beacon.
 *
 * STATE:  x = [ rssi (dBm), rate (dBm/s) ]
 *
 * WHY CONSTANT-VELOCITY INSTEAD OF CONSTANT-POSITION:
 * The previous filter modelled RSSI as a fixed value being measured over and
 * over. Under that assumption, any genuine trend — the user walking — is
 * indistinguishable from error, so the filter can only follow it by lagging
 * behind, and every increase in smoothing bought at rest was paid for as delay
 * in motion. Estimating the rate of change as a second state removes that
 * tradeoff outright: a steady walk is a constant rate, which the model predicts
 * exactly, so it is tracked with essentially zero steady-state lag even while
 * the level estimate stays heavily damped against noise.
 *
 * The rate state is bounded (MAX_RSSI_RATE_DB_S) and is actively pulled to zero
 * whenever the stationary gate fires, which prevents the classic CV-filter
 * failure mode of coasting past the target after the user stops.
 */
export class AdaptiveKalmanFilter {
  constructor(initialRssi = -60.0) {
    this.x = initialRssi;   // level estimate (dBm)
    this.v = 0;             // rate estimate (dBm/s)
    // Covariance P = [[p00, p01], [p01, p11]]
    this.p00 = 5.0;
    this.p01 = 0.0;
    this.p11 = 4.0;
    this.k = 0.5;           // level Kalman gain (diagnostics)
    this.currentQ = DEFAULT_ADAPTIVE_CONFIG.PROCESS_NOISE_ACCEL;
    this.currentR = DEFAULT_ADAPTIVE_CONFIG.R_MIN;
    this.initialized = false;
    this.lastTimestamp = null;
    this.innovations = [];   // recent (measurement - prediction) values
    this.trendRatio = 0;     // 0 = white/stationary, 1 = consistent trend/moving
    this.isStationary = false;
  }

  /**
   * Innovation whiteness statistics - see INNOVATION_WINDOW in the config block.
   *  trendRatio: |sum innovations| / sum|innovations|. ~0 when innovations are
   *    randomly signed (white - filter tracking, user stationary), ~1 when they
   *    share a sign (filter lagging a genuine trend).
   *  meanAbs: average innovation magnitude, used to confirm the filter really
   *    is tracking rather than sitting at a large steady offset.
   *
   * NOTE: with the constant-velocity model this test is strictly sharper than
   * it was before. Under the old constant-position model a steady walk produced
   * a permanent same-signed innovation bias, so "trending" and "moving" were
   * conflated. Here a steady walk is absorbed by the rate state and produces
   * white innovations again, meaning a surviving same-signed run now indicates
   * genuine acceleration rather than mere motion.
   */
  _innovationStats() {
    const n = this.innovations.length;
    if (n === 0) return { trendRatio: 1.0, meanAbs: Infinity, count: 0 };
    let sum = 0;
    let sumAbs = 0;
    for (const val of this.innovations) {
      sum += val;
      sumAbs += Math.abs(val);
    }
    const trendRatio = sumAbs < 1e-6 ? 0 : Math.max(0, Math.min(1, Math.abs(sum) / sumAbs));
    return { trendRatio, meanAbs: sumAbs / n, count: n };
  }

  /**
   * Steps the filter with a new raw measurement z.
   *
   * @param {number} z - New cleaned raw RSSI reading
   * @param {number} measuredVariance - Live NOISE variance from BeaconProfile.getNoiseVariance()
   * @param {object} config - Tuning configuration object
   * @param {number} timestamp - Packet arrival time in ms (drives dt; BLE packet
   *                             spacing is irregular, and a CV model needs the
   *                             real elapsed time rather than a fixed step)
   */
  step(z, measuredVariance, config = DEFAULT_ADAPTIVE_CONFIG, timestamp = null, motionHint = null) {
    if (!Number.isFinite(z)) {
      return { filteredRssi: this.x, kalmanGain: this.k, q: this.currentQ, r: this.currentR };
    }

    if (!this.initialized) {
      this.x = z;
      this.v = 0;
      this.p00 = 5.0;   // high initial uncertainty -> responsive on packet 2
      this.p01 = 0.0;
      this.p11 = 4.0;
      this.initialized = true;
      this.lastTimestamp = timestamp;
      return {
        filteredRssi: Number(this.x.toFixed(2)),
        rateDbPerS: 0,
        kalmanGain: 1.0,
        q: this.currentQ,
        r: this.currentR,
        errorCovariance: this.p00,
      };
    }

    // Real elapsed time between packets. Bounded: a long gap (beacon briefly
    // out of range) must not let the rate state extrapolate the level far away
    // from reality before the first new measurement arrives to correct it.
    let dt = 0.1;
    if (Number.isFinite(timestamp) && Number.isFinite(this.lastTimestamp)) {
      dt = (timestamp - this.lastTimestamp) / 1000.0;
    }
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.1;
    dt = Math.min(1.0, Math.max(0.02, dt));
    this.lastTimestamp = timestamp;

    const varSafe = Math.max(0.1, Number.isFinite(measuredVariance) ? measuredVariance : 2.0);

    // -------------------------------------------------------------------------
    // WHY ADAPTIVE R (bounded):
    // Measurement noise covariance R represents per-packet sensor inaccuracy,
    // estimated from trend-cancelled NOISE variance rather than raw dispersion,
    // so a beacon is not judged "unreliable" merely because the user is walking:
    //   - Clean beacon (noise var 1.5 dBm^2): R = 3.0 (floor) -> high gain.
    //   - Noisy beacon (noise var 35.0 dBm^2): R = 25.0 (ceiling) -> low gain,
    //     but the ceiling stops the gain collapsing toward zero the way an
    //     unbounded R previously did.
    // -------------------------------------------------------------------------
    this.currentR = Math.min(config.R_MAX ?? 25.0, Math.max(config.R_MIN ?? 3.0, varSafe));

    // -------------------------------------------------------------------------
    // WHY ADAPTIVE Q (white-noise-acceleration):
    // q is the intensity of unmodelled acceleration - how quickly the rate is
    // permitted to change, i.e. how fast the filter accepts that the user has
    // started or stopped walking. It is raised on noisy links so the estimate
    // cannot become over-confident and stop responding, and cut hard once the
    // stationary gate confirms the link genuinely is not changing.
    // -------------------------------------------------------------------------
    const qBase = config.PROCESS_NOISE_ACCEL ?? 9.0;
    const varThresh = config.VARIANCE_THRESHOLD ?? 10.0;
    const noiseScale = 1.0 + Math.min(1.0, varSafe / varThresh);

    const stats = this._innovationStats();
    this.trendRatio = stats.trendRatio;
    const sigma = Math.sqrt(varSafe);
    // A fresh PDR verdict overrides the internal estimate outright: a step
    // detector observes the user directly, whereas the innovation test can only
    // infer motion from a signal that shadowing corrupts in the same direction.
    this.isStationary =
      motionHint !== null
        ? !motionHint
        : stats.count >= (config.STATIONARY_MIN_SAMPLES ?? 6) &&
          stats.trendRatio < (config.STATIONARY_TREND_MAX ?? 0.35) &&
          stats.meanAbs < (config.STATIONARY_INNOV_SIGMA_MAX ?? 1.0) * sigma;

    this.currentQ = this.isStationary
      ? qBase * noiseScale * (config.STATIONARY_Q_SCALE ?? 0.12)
      : qBase * noiseScale;

    // ---- 1. Time update (predict): constant-velocity model ----
    //   xPred = x + v*dt        Ppred = F*P*F' + Q(dt)
    // Q is the standard white-noise-acceleration discretisation:
    //   Q = q * [[dt^3/3, dt^2/2], [dt^2/2, dt]]
    const q = this.currentQ;
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;

    const xPred = this.x + this.v * dt;
    const vPred = this.v;

    const p00Pred = this.p00 + 2 * dt * this.p01 + dt2 * this.p11 + (q * dt3) / 3.0;
    const p01Pred = this.p01 + dt * this.p11 + (q * dt2) / 2.0;
    const p11Pred = this.p11 + q * dt;

    // ---- 2. Measurement update (correct): H = [1, 0] ----
    const innovation = z - xPred;
    const s = p00Pred + this.currentR;
    const k0 = p00Pred / s;
    const k1 = p01Pred / s;
    this.k = k0;

    this.x = xPred + k0 * innovation;
    this.v = vPred + k1 * innovation;

    this.p00 = (1.0 - k0) * p00Pred;
    this.p01 = (1.0 - k0) * p01Pred;
    this.p11 = p11Pred - k1 * p01Pred;

    // ---- 3. Rate conditioning ----
    // Physical ceiling: no walking speed can change path loss faster than this,
    // so anything beyond it is a noise burst driving the rate state, not motion.
    const maxRate = config.MAX_RSSI_RATE_DB_S ?? 14.0;
    if (this.v > maxRate) this.v = maxRate;
    else if (this.v < -maxRate) this.v = -maxRate;

    // Once the link is confirmed quiet, bleed the rate toward zero. Without
    // this a CV filter keeps coasting on its last estimated rate and drifts
    // steadily away from a stationary user.
    if (this.isStationary) {
      this.v *= (1.0 - (config.STATIONARY_RATE_DECAY ?? 0.35));
    }

    // Record the innovation for the next step's whiteness test.
    this.innovations.push(innovation);
    const innovWindow = config.INNOVATION_WINDOW || 8;
    while (this.innovations.length > innovWindow) this.innovations.shift();

    return {
      filteredRssi: Number(this.x.toFixed(2)),
      rateDbPerS: Number(this.v.toFixed(3)),
      kalmanGain: Number(this.k.toFixed(4)),
      q: Number(this.currentQ.toFixed(4)),
      r: Number(this.currentR.toFixed(2)),
      trendRatio: Number(this.trendRatio.toFixed(3)),
      isStationary: this.isStationary,
      errorCovariance: Number(this.p00.toFixed(4)),
    };
  }

  reset(initialRssi = -60.0) {
    this.x = initialRssi;
    this.v = 0;
    this.p00 = 5.0;
    this.p01 = 0.0;
    this.p11 = 4.0;
    this.k = 0.5;
    this.initialized = false;
    this.lastTimestamp = null;
    this.innovations = [];
    this.trendRatio = 0;
    this.isStationary = false;
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

    // Set when the active model was learned by BeaconAutoCalibration rather
    // than measured by hand, and from how many walks.
    this.autoCalibrated = false;
    this.autoWindows = 0;
  }

  /** Installs a model learned automatically from walking. */
  applyAutoModel(txPower1m, n, windows = 0) {
    this.fittedTxPower1m = Number(Number(txPower1m).toFixed(1));
    this.fittedN = Number(Number(n).toFixed(2));
    this.hasFarSegment = false;
    this.fittedNFar = null;
    this.rssiAtBreakpoint = null;
    this.isCalibrated = true;
    this.autoCalibrated = true;
    this.autoWindows = windows;
    this.saveToStorage();
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
    this.autoCalibrated = false;
    this.autoWindows = 0;
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
    this.autoCalibrated = false;
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

    // Requires 3+ far points (not just 2) — a 2-point far fit is fully
    // determined by a single pair, so one noisy reading can swing the slope
    // to an implausible value with no data to contradict it.
    const canFitDualSlope = nearRaw.length >= 2 && farRaw.length >= 3;

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
        // Floor nFar at fittedN: walls/glass beyond the breakpoint can only
        // ADD attenuation relative to the open near-field regime, never
        // reduce it. Without this floor, a noisy or sparse far-point fit can
        // land on an implausibly SHALLOW slope, which under-predicts
        // attenuation and extrapolates ordinary weak RSSI into wildly
        // inflated distances — e.g. 30+ m inside a room whose diagonal is
        // 22 m. Clamping to [fittedN, 6.5] keeps the far segment physically
        // sane even from a rough fit.
        const nFar = Number(Math.max(fittedN, Math.min(6.5, sumXY / sumXX)).toFixed(2));
        this.hasFarSegment = true;
        this.fittedNFar = nFar;
        this.rssiAtBreakpoint = Number(rssiAtD0.toFixed(2));
      }
    }

    // ── Goodness of fit (R² ) evaluated against whichever model is active ──
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
    this.autoCalibrated = false;

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
        autoCalibrated: this.autoCalibrated,
        autoWindows: this.autoWindows,
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
        this.autoCalibrated = Boolean(parsed.autoCalibrated);
        this.autoWindows = parsed.autoWindows || 0;
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
    // Externally-supplied motion state (from the PDR step detector). null until
    // set, and treated as stale after MOTION_STATE_TIMEOUT_MS so that a screen
    // which stops reporting motion degrades to the internal estimate rather
    // than silently trusting a frozen value.
    this._motionIsMoving = null;
    this._motionUpdatedAt = null;
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
        shadowEnvelopeDb: null,
        lastEnvelopeUpdate: null,
        envelopePeakTime: null,
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
    // Captured BEFORE it is overwritten: step 8 needs the gap since the
    // PREVIOUS packet to judge whether this link is keeping up. Reading
    // entry.lastTimestamp after the assignment below always yielded 0, which
    // silently pinned recencyFactor at 1.0 and made STALE_TIMEOUT_MS dead
    // code - a beacon dropping most of its packets still scored full
    // confidence, and the fusion filter trusted it accordingly.
    const prevTimestamp = entry.lastTimestamp;
    entry.totalPackets++;
    entry.lastRawRssi = numRssi;
    entry.lastTimestamp = timestamp;
    if (meta.name) entry.name = meta.name;

    // 2. Asymmetric Outlier Gating.
    // Drops are clamped tighter than rises because indoor RF only degrades in
    // one direction: a sudden drop is almost always a transient blockage
    // (body, door, passing person), whereas a sudden rise is a blockage
    // clearing — a truer, less-obstructed sample that we want to let through.
    const median = entry.profile.getRollingMedian();
    let cleanRssi = numRssi;

    if (median !== null && entry.profile.samples.length >= 4) {
      const deviation = numRssi - median; // signed: negative = drop
      const limit = deviation >= 0
        ? this.config.OUTLIER_RISE_THRESHOLD_DBM
        : this.config.OUTLIER_DROP_THRESHOLD_DBM;
      if (Math.abs(deviation) > limit) {
        entry.outlierCount++;
        cleanRssi = deviation >= 0 ? median + limit : median - limit;
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

    // 4b. Resolve motion state. A PDR step detector is a far more reliable
    // witness to "is the user actually walking" than anything recoverable from
    // a single RSSI stream, where a body blocking the path and a step away look
    // identical. Use it when it is fresh; otherwise fall back to the filter's
    // own innovation-whiteness gate.
    const motionFresh =
      Number.isFinite(this._motionUpdatedAt) &&
      timestamp - this._motionUpdatedAt < (this.config.MOTION_STATE_TIMEOUT_MS ?? 2000);
    const motionHint = motionFresh ? Boolean(this._motionIsMoving) : null;

    // 5. Step Adaptive Kalman Filter with Live NOISE Variance
    const kalmanOut = entry.filter.step(cleanRssi, noiseVariance, this.config, timestamp, motionHint);

    // Three states, not two. Without a PDR verdict the engine genuinely cannot
    // tell a walk from a fade, and pretending otherwise is what makes a
    // two-state version regress on screens that supply no motion data.
    // The internal gate is used ASYMMETRICALLY because its two answers are not
    // equally trustworthy: it only reports "stationary" when the innovations
    // are both white and small, which is strong evidence of genuinely standing
    // still, whereas "not stationary" merely means something changed — motion
    // or shadowing alike. So a positive is believed, a negative is treated as
    // UNKNOWN and handled with intermediate settings rather than assumed to be
    // movement.
    let motionMode;
    if (motionHint !== null) motionMode = motionHint ? "moving" : "still";
    else motionMode = kalmanOut.isStationary ? "still" : "unknown";
    const treatAsMoving = motionMode === "moving";
    const treatAsStill = motionMode === "still";
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

    // 5b. Long-horizon one-sided fading (shadow) correction.
    // The Kalman output tracks the CENTRE of the sample distribution, but that
    // distribution is skewed downward by body/wall shadowing, so the centre
    // sits below the true unobstructed level and the distance comes out too
    // long. The previous version measured that skew as a percentile gap inside
    // the 10-sample rolling window, which could not work: real indoor fades
    // last seconds, so across a ~1 s window the shadow is effectively constant
    // and the measured gap collapsed to the white-noise spread (~0.5 dB) while
    // several dB were actually being lost.
    // This instead tracks a peak-hold envelope of the FILTERED level with a
    // bounded decay rate, which spans many seconds and therefore actually sees
    // the fade. Ranging is then done off the envelope rather than the centre.
    // Applied here rather than inside the Kalman so the filter keeps running
    // on the raw stream at full responsiveness — this is a bias correction,
    // not another smoothing stage.
    const envDtSec = Number.isFinite(entry.lastEnvelopeUpdate)
      ? Math.min(2.0, Math.max(0.02, (timestamp - entry.lastEnvelopeUpdate) / 1000.0))
      : 0.1;
    // How fast the envelope is allowed to fall is the whole design problem: a
    // blockage and a genuine walk away both just lower RSSI, and from a single
    // link they are not separable instant to instant. What DOES separate them
    // is duration — a body, door or passing person clears within a few seconds
    // and the level returns, whereas walking away never comes back. So the
    // envelope holds nearly flat for ENVELOPE_HOLD_SEC (long enough to ride out
    // a realistic fade), and past that ramps its decay up until it is falling
    // fast enough to follow real movement. The cost is a bounded, short lag
    // when genuinely walking away; the payoff is not mistaking every fade for
    // several metres of travel.
    const tSincePeakSec = Number.isFinite(entry.envelopePeakTime)
      ? Math.max(0, (timestamp - entry.envelopePeakTime) / 1000.0)
      : 0;
    const envHoldSec = treatAsMoving
      ? (this.config.ENVELOPE_HOLD_MOVING_SEC ?? 0.6)
      : treatAsStill
        ? (this.config.ENVELOPE_HOLD_STILL_SEC ?? 8.0)
        : (this.config.ENVELOPE_HOLD_UNKNOWN_SEC ?? 3.0);
    const envRamp = treatAsMoving
      ? (this.config.ENVELOPE_DECAY_RAMP_MOVING_DB_S2 ?? 8.0)
      : treatAsStill
        ? (this.config.ENVELOPE_DECAY_RAMP_STILL_DB_S2 ?? 1.5)
        : (this.config.ENVELOPE_DECAY_RAMP_UNKNOWN_DB_S2 ?? 4.0);
    const envDecayRate = Math.min(
      this.config.ENVELOPE_MAX_DECAY_DB_S ?? 12.0,
      (this.config.ENVELOPE_DECAY_DB_S ?? 0.35)
        + Math.max(0, tSincePeakSec - envHoldSec) * envRamp
    );
    const envDecayDb = envDecayRate * envDtSec;

    if (!Number.isFinite(entry.shadowEnvelopeDb)) {
      entry.shadowEnvelopeDb = safeFilteredRssi;
      entry.envelopePeakTime = timestamp;
    } else if (safeFilteredRssi >= entry.shadowEnvelopeDb) {
      // Rise instantly: a stronger reading means the path just got clearer, and
      // since attenuation is one-sided that reading is closer to the truth.
      entry.shadowEnvelopeDb = safeFilteredRssi;
      entry.envelopePeakTime = timestamp;
    } else {
      // Fall only at a bounded rate, so the envelope still follows the user
      // genuinely walking away, but a transient blockage cannot drag it down.
      entry.shadowEnvelopeDb = Math.max(safeFilteredRssi, entry.shadowEnvelopeDb - envDecayDb);
    }
    entry.lastEnvelopeUpdate = timestamp;

    const shadowGapDb = Math.max(0, entry.shadowEnvelopeDb - safeFilteredRssi);
    const shadowCorrectionDb = Math.min(
      this.config.MAX_ENVELOPE_CORRECTION_DB ?? 9.0,
      shadowGapDb * (this.config.ENVELOPE_WEIGHT ?? 0.75)
    );
    const rangingRssi = safeFilteredRssi + shadowCorrectionDb;

    let slantDistM;
    if (entry.calibrator.isCalibrated) {
      slantDistM = entry.calibrator.distanceFromRssi(rangingRssi);
    } else {
      // Uncalibrated fallback: single-slope log-distance with default/advertised Tx & n
      const ratio = (safeTx - rangingRssi) / (10.0 * safeN);
      slantDistM = Math.pow(10, ratio);
    }
    if (!Number.isFinite(slantDistM) || slantDistM < 0) slantDistM = 1.0;

    // Near-Field Touch Correction, anchored to THIS beacon's calibrated output
    // power (see NEAR_FIELD_*_OFFSET_DB) rather than fixed absolute dBm, so a
    // stronger-transmitting beacon doesn't have real mid-range distances
    // crushed toward zero.
    const touchSatDbm = safeTx + this.config.NEAR_FIELD_SAT_OFFSET_DB;
    const nearFieldDbm = safeTx + this.config.NEAR_FIELD_RAMP_OFFSET_DB;
    if (rangingRssi >= touchSatDbm) {
      slantDistM = 0.0;
    } else if (rangingRssi > nearFieldDbm) {
      const touchFactor = (touchSatDbm - rangingRssi) / (touchSatDbm - nearFieldDbm);
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

    // 6c. Absolute Plausibility Ceiling.
    // A weak or borderline RSSI reading, combined with an uncalibrated (or
    // sparsely-calibrated) path-loss model, can extrapolate to a distance the
    // deployment space physically cannot contain — e.g. 30+ m reported inside
    // a room whose diagonal is 22 m. Nothing legitimate can measure farther
    // than the known space allows, so cap it there instead of letting it
    // propagate into positioning as a "hallucinated" far-away reading.
    const maxPlausibleM = this.config.MAX_PLAUSIBLE_DISTANCE_M;
    if (Number.isFinite(maxPlausibleM)) {
      if (rawDistM > maxPlausibleM) rawDistM = maxPlausibleM;
      if (slantDistM > maxPlausibleM) slantDistM = maxPlausibleM;
    }

    // 7. Kinematic Plausibility Clamp (NOT a smoother).
    // The Kalman filter above already performs the statistical smoothing — this
    // step only rejects a single-packet, physically-impossible jump (e.g. a
    // brief multipath null the outlier gate didn't catch). It intentionally adds
    // NO extra lag beyond the walking-speed ceiling itself, unlike the previous
    // alpha-blended IIR stage that damped every update a second time on top of
    // the Kalman filter.
    const prevDist = entry.lastDistanceM;
    // dt is bounded: with a slow or stuttering advertising interval an unbounded
    // dt would open the allowed jump so wide that the clamp stops clamping.
    const dtSec = Number.isFinite(entry.lastDistanceUpdate)
      ? Math.min(1.0, Math.max(0.01, (timestamp - entry.lastDistanceUpdate) / 1000.0))
      : 0.05;

    let clampedDistM = rawDistM;
    if (entry.totalPackets > 2 && prevDist !== null && Number.isFinite(prevDist)) {
      // The permitted rate of change depends on whether the user is actually
      // moving. Standing still, the true distance is CONSTANT, so a tight bound
      // removes residual flicker at zero cost in responsiveness — there is no
      // real motion being held back. Walking, the bound is deliberately slack:
      // the filter above is already doing the smoothing, and a tight limit here
      // would only re-introduce lag by rate-limiting genuine movement.
      // Previously a single walking-speed limit was applied in both states, so
      // it was simultaneously too loose to stop flicker at rest and tight
      // enough to saturate in motion, where it degenerated into a slew-rate
      // limiter chasing a noisy target -- which is where most of the delay came
      // from.
      const speedCeilingMs = treatAsMoving
        ? (this.config.MAX_WALKING_SPEED_M_S ?? 1.6) * (this.config.MOVING_CLAMP_SLACK ?? 2.5)
        : treatAsStill
          ? (this.config.STATIONARY_MAX_DRIFT_M_S ?? 0.3)
          : (this.config.MAX_WALKING_SPEED_M_S ?? 1.6) * (this.config.UNKNOWN_CLAMP_SLACK ?? 1.0);
      const maxDelta = Math.max(0.04, speedCeilingMs * dtSec);
      const delta = rawDistM - prevDist;
      if (Math.abs(delta) > maxDelta) {
        clampedDistM = prevDist + Math.sign(delta) * maxDelta;
      }
    }

    entry.lastDistanceM = Number(Math.max(0, clampedDistM).toFixed(2));
    entry.lastSlantDistanceM = Number(Math.max(0, slantDistM).toFixed(2));
    entry.lastDistanceUpdate = timestamp;

    // 8. Compute Live Confidence Score C ∈ [0.0, 1.0]
    const gapMs = Number.isFinite(prevTimestamp) ? Math.max(0, timestamp - prevTimestamp) : 0;
    const graceMs = this.config.PACKET_GAP_GRACE_MS ?? 900;
    const staleMs = Math.max(graceMs + 1, this.config.STALE_TIMEOUT_MS ?? 3000);
    const recencyFactor = Math.max(
      0.0,
      Math.min(1.0, 1.0 - Math.max(0, gapMs - graceMs) / (staleMs - graceMs))
    );
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
      shadowGapDb: Number(shadowGapDb.toFixed(1)),
      shadowCorrectionDb: Number(shadowCorrectionDb.toFixed(1)),
      // The exact level the path-loss inversion was fed: filtered RSSI plus
      // the shadow correction. Calibration MUST be fitted against this rather
      // than filteredRssi - fitting the model to one level and then ranging
      // off another injects a constant offset equal to the typical correction,
      // which is several dB and therefore metres of range error.
      rangingRssi: Number(rangingRssi.toFixed(2)),
      packetGapMs: gapMs,
      stdDev: entry.profile.getStdDev(),
      stabilityScore: Number.isFinite(stabilityScore) ? stabilityScore : 0.5,
      confidenceScore,
      currentN: safeN,
      txPower1m: safeTx,
      isCalibrated: Boolean(entry.calibrator.isCalibrated),
      hasFarSegment: Boolean(entry.calibrator.hasFarSegment),
      currentNFar: entry.calibrator.fittedNFar,
      breakpointDistanceM: entry.calibrator.breakpointDistanceM,
      rateDbPerS: kalmanOut.rateDbPerS ?? 0,
      motionMode,
      shadowEnvelopeDb: Number.isFinite(entry.shadowEnvelopeDb) ? Number(entry.shadowEnvelopeDb.toFixed(2)) : null,
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
  /**
   * IMPORTANT - UNITS: anchors must be given in METRES, because the radii used
   * here come from state.distanceM, which is metres. Passing foot-based anchor
   * coordinates silently mixes units: the (r1squared - r2squared) term is then
   * ~10.8x too small relative to the baseline, which collapses the solution
   * toward the midpoint between the beacons regardless of the real ranges.
   *
   * NOTE ALSO: this returns a point ON the beacon baseline - it solves the
   * along-baseline coordinate and drops the perpendicular one. That makes it a
   * proximity/blend estimate, NOT a position fix, and it is not suitable for
   * establishing an initial position. Use InitialPositionSolver for that: it
   * intersects the range circles properly and keeps both candidates.
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

  /**
   * Supplies external motion state, normally driven by the PDR step detector.
   * Knowing whether the user is genuinely walking is what lets the shadow
   * envelope hold firmly at rest without paying for it as lag in motion.
   * Safe to omit: the engine falls back to its own innovation-based estimate.
   *
   * @param {boolean} isMoving - true while steps are being detected
   * @param {number} timestamp - when this verdict was formed
   */
  setMotionState(isMoving, timestamp = Date.now()) {
    this._motionIsMoving = Boolean(isMoving);
    this._motionUpdatedAt = timestamp;
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

  /**
   * Sets the absolute plausibility ceiling on computed distance (metres) —
   * normally the real floor plan's diagonal (plus a small margin). Pass null
   * to disable. See MAX_PLAUSIBLE_DISTANCE_M in DEFAULT_ADAPTIVE_CONFIG.
   */
  /**
   * Sets the fallback path-loss model used by any beacon that has NOT been
   * individually calibrated.
   *
   * These two numbers existed in DEFAULT_ADAPTIVE_CONFIG and in the app's
   * settings store simultaneously, but nothing connected them: the Settings
   * screen wrote pathLossN into AsyncStorage, the scanner used it only for the
   * rough estimate shown next to unselected devices in the discovery list, and
   * the engine that produces every real distance kept its own hardcoded 2.2.
   * Changing the setting therefore appeared to do nothing. This is the missing
   * link, called whenever settings load or change.
   *
   * @param {number} n - Path-loss exponent (1.2 - 4.5)
   * @param {number} [txPower1m] - Fallback RSSI at 1 m in dBm (-95 - -35)
   */
  setDefaultPathLoss(n, txPower1m = null) {
    if (Number.isFinite(n)) {
      this.config.DEFAULT_PATH_LOSS_N = Math.max(1.2, Math.min(4.5, n));
    }
    if (Number.isFinite(txPower1m)) {
      this.config.DEFAULT_TX_POWER_1M = Math.max(-95, Math.min(-35, txPower1m));
    }
    return {
      pathLossN: this.config.DEFAULT_PATH_LOSS_N,
      txPower1m: this.config.DEFAULT_TX_POWER_1M,
    };
  }

  /**
   * Discards a beacon's shadow envelope so it re-seeds from the next reading.
   *
   * The envelope is a peak-hold over many seconds, which is exactly what makes
   * it work as a fading correction and exactly what makes it WRONG the instant
   * the phone is somewhere else. After walking from one beacon to the other,
   * the near beacon's envelope still holds the strong level it saw at 1 m, so
   * every reading at the new spot looks like a deep fade and gets up to
   * MAX_ENVELOPE_CORRECTION_DB added to it - which during calibration is
   * indistinguishable from the beacon genuinely being stronger, and corrupts
   * the fitted exponent by several dB of lever arm.
   *
   * Callers that know the phone has moved somewhere materially different -
   * ranging calibration between stands - should call this first.
   */
  resetShadowEnvelope(beaconId = null) {
    const clear = (entry) => {
      entry.shadowEnvelopeDb = null;
      entry.envelopePeakTime = null;
      entry.lastEnvelopeUpdate = null;
    };
    if (beaconId === null) {
      for (const entry of this.beacons.values()) clear(entry);
      return true;
    }
    const entry = this.beacons.get(beaconId);
    if (!entry) return false;
    clear(entry);
    return true;
  }

  setMaxPlausibleDistance(maxDistanceM) {
    this.config.MAX_PLAUSIBLE_DISTANCE_M = Number.isFinite(maxDistanceM) ? maxDistanceM : null;
  }
}

// Global active engine singleton for application-wide consistency
export const adaptiveEngine = new BeaconManager();
