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
import { OBSTACLE_TYPES, ObstacleMap } from "./ObstacleMap.js";

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
  // The whiteness test alone cannot see a STEADY walk: the constant-velocity
  // model tracks a steady ramp exactly, so its innovations come out white and
  // the gate declared "stationary" in the middle of walking away. That one
  // misjudgement held the shadow envelope for 8 s and rate-limited the range
  // to 0.3 m/s, which is why walking AWAY from a beacon lagged by many
  // seconds while walking toward it did not. So a large rate state also
  // rules stationarity out.
  STATIONARY_MAX_RATE_DB_S: 1.0,
  // Evidence that the filter is LAGGING a real change: innovations mostly of
  // one sign and larger than the noise. Overrides a "standing still" verdict
  // from the step detector, because the link changing steadily is proof the
  // range is changing - e.g. the beacon is being carried away, or steps are
  // simply not being detected.
  LAG_TREND_MIN: 0.6,
  LAG_INNOV_SIGMA_MIN: 1.0,
  // ...but only once it has lasted this long. A body blocking the beacon is a
  // single DROP that the filter catches up with in a second or two; a range
  // that keeps changing keeps the filter lagging. Without this wait, every
  // fade while standing was released as if it were movement.
  LAG_OVERRIDE_MS: 2500,

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
  // Trend release. A shadow fade is a DROP that then sits flat (or recovers);
  // walking away is a fall that keeps going. Once the filter's own rate has
  // stayed below -TREND_RELEASE_RATE for TREND_RELEASE_AFTER_MS, the envelope
  // is released: it falls at least as fast as the signal plus closes the gap
  // within ~TREND_CLOSE_S. Not applied while the step detector says the user
  // is standing (the true range is then constant, so a fall IS a fade) unless
  // the filter is visibly lagging a real change.
  TREND_RELEASE_RATE_DB_S: 0.8,
  TREND_RELEASE_AFTER_MS: 700,
  TREND_CLOSE_S: 0.8,
  MAX_ENVELOPE_CORRECTION_DB: 9.0,

  // ── Unified ranging (2026-10) ──────────────────────────────────────────────
  // Measured against a simulated office (multipath fading, slow shadowing,
  // channel offsets, packet loss and the user's own body), the envelope above
  // turned out to be a source of the "sometimes too long, sometimes too short"
  // error rather than a cure: its correction depends on the motion state, so
  // the same spot ranged differently standing and walking, and a calibration
  // taken standing was wrong once walking. It is still computed for the
  // diagnostics, but no longer applied to ranging.
  SHADOW_ENVELOPE_RANGING: false,

  // The user's own body. A phone held in front of you with the beacon BEHIND
  // you loses several dB through your torso, which reads as 30-80 % too far -
  // the single largest ranging error measured. The app knows which way you
  // face (heading) and where the beacon is relative to you (map), so it
  // supplies the fraction of that loss that applies (0 facing, 1 directly
  // behind) via setBodyShadow(), and the loss is added back before ranging.
  // 4 dB is deliberately conservative: it beat no correction whether the real
  // loss was 3, 7 or 11 dB, whereas assuming a larger value backfires when the
  // real loss is small.
  BODY_SHADOW_LOSS_DB: 4.0,
  // A body-shadow fraction older than this is ignored (e.g. the Fusion Map is
  // closed, so nothing knows the user's position any more).
  BODY_SHADOW_STALE_MS: 3000,

  // Standing still the true range is CONSTANT, so the best estimate is the
  // average of everything since the user stopped. The averaging window grows
  // from 0.5 s to this as the user keeps standing, and restarts instantly on a
  // step or a turn. This replaced a 0.3 m/s rate limit, which was calm far
  // from a beacon but let +-20 % through up close, and froze the reading for
  // 15+ s after the user turned round.
  STILL_AVERAGE_TAU_MAX_S: 10.0,
  // ...unless the live level walks away from that average and stays away.
  // Steps are not always detected (phone moved by hand, very slow walking),
  // and without this escape the reading sat on the old value - "stuck".
  STILL_RELEASE_DB: 3.0,
  STILL_RELEASE_MS: 1200,

  // Output smoothing in log-distance while NOT standing still. Range noise is
  // multiplicative, so smoothing ln(d) is unbiased where smoothing metres is
  // not. Time constant in seconds; 0 disables.
  MOVING_SMOOTH_TAU_S: 1.0, // simulated best: walking jitter -35 %, no added lag; 1.5 s began to lag

  // A metres-per-second limit on how fast the distance may change. Off: range
  // noise is multiplicative, so a linear limit clips the upward spikes harder
  // than the downward ones and biased every approach to a beacon by +15-30 %.
  // The Kalman filter's own rate cap (MAX_RSSI_RATE_DB_S) already rules out
  // physically impossible jumps.
  DISTANCE_SLEW_CLAMP: false,

  // Priors for the calibration fit (see PathLossCalibrator.fitModel). They
  // let a single calibration point already fix the 1 m level, while several
  // points spread over the room fit the decay too.
  // 4 dB, not wider: auto-calibration points mostly lie several metres out,
  // and with a loose prior the fit pushed RSSI@1m wherever the far points
  // pulled it, ruining distances near the beacon (simulated: +45 % at < 4 m).
  // The configured RSSI@1m (-59) was observed to be right close up, so it is
  // trusted to about this much; points near the beacon still override it.
  CALIB_PRIOR_TX_SIGMA_DB: 4.0,
  CALIB_PRIOR_N_SIGMA: 0.4,
  CALIB_POINT_SIGMA_DB: 2.0,

  // ── Distance-dependent RSSI@1m (attenuation-factor model) ──────────────────
  // Field observation: with n = 2.9 the RSSI@1m that gives the right answer
  // is about -59/-60 dBm close to the beacon but about -73/-74 dBm at 10 m.
  // One fixed RSSI@1m therefore cannot be right everywhere. Indoors every
  // extra metre crosses more desks, partitions and people, each costing a few
  // dB, so the loss grows with distance faster than the log-distance law
  // alone. That is the attenuation-factor model (Seidel & Rappaport, 1992;
  // ITU-R P.1238 uses the same idea per wall/floor):
  //
  //   RSSI(d) = A - 10 n log10(d) - alpha (d - 1)        (d >= 1 m)
  //
  // read the way it was observed: the "effective RSSI@1m" at distance d is
  //   Tx_eff(d) = A - alpha (d - 1)
  // i.e. it drops by alpha dB for every metre away.
  //
  // Default 0, learned per beacon. A fixed 1.5 dB/m (the value one 10 m test
  // suggested) was tried and was wrong for the other beacon: with -59 @ 1 m
  // and n 2.9 it turned a true 10 m into 5.7 m. That 10 m test went through
  // walls, and walls are a property of the PATH, not of every metre - they
  // are handled by the radio map (setLocationCorrection) instead.
  DEFAULT_EXCESS_LOSS_DB_PER_M: 0,
  EXCESS_LOSS_MAX_DB_PER_M: 3.0,
  CALIB_PRIOR_ALPHA_SIGMA: 0.5,

  // Location correction from the radio map (walls, pillars, cabins): dB to
  // add at the user's current position, supplied by the Fusion Map. Ignored
  // once older than this.
  LOCATION_CORRECTION_STALE_MS: 3000,
  // Typical error of a range level in dB where nothing better is known
  // (office shadowing). The radio map lowers it where it has data. Turned
  // into a distance uncertainty (rangeSigmaM) for the position filter, so a
  // far beacon - where 1 dB is many centimetres - is trusted less.
  RANGE_SIGMA_DB_DEFAULT: 5.0,
  // Robust fit: points further than this many sigma from the model are
  // down-weighted (Huber), so one reading taken while someone stood in the
  // way cannot tilt the whole model.
  CALIB_HUBER_K: 1.5,
  // Auto-calibration points kept per beacon (oldest dropped first).
  AUTO_CALIB_MAX_POINTS: 80,

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
// PATH-LOSS MODEL (shared by calibrated and uncalibrated ranging)
// ============================================================================

/**
 * Received level predicted at distance d (metres):
 *   A - 10 n log10(d) - alpha * max(0, d - 1)
 * A is RSSI@1m, n the log-distance exponent and alpha the extra loss per
 * metre (see DEFAULT_EXCESS_LOSS_DB_PER_M).
 */
export function predictLevelDb(d, A, n, alpha = 0) {
  const dd = Math.max(0.05, d);
  return A - 10.0 * n * Math.log10(dd) - (alpha > 0 ? alpha * Math.max(0, dd - 1) : 0);
}

/**
 * Inverse of predictLevelDb: the distance at which the model gives `level`.
 * The model falls monotonically with distance, so there is exactly one
 * answer; it is found by bisection on ln(d), which is exact to < 1 mm.
 */
export function solveDistanceM(level, A, n, alpha = 0, maxM = 200) {
  const logOnly = Math.pow(10, (A - level) / (10.0 * n));
  if (!(alpha > 0) || !(logOnly > 1)) return logOnly;
  // The alpha term only lowers the predicted level, so the answer lies
  // between 1 m and the log-only distance.
  let lo = 0, hi = Math.log(Math.min(logOnly, maxM));
  if (predictLevelDb(Math.exp(hi), A, n, alpha) > level) return Math.exp(hi);
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (predictLevelDb(Math.exp(mid), A, n, alpha) > level) lo = mid;
    else hi = mid;
  }
  return Math.exp(0.5 * (lo + hi));
}

/** Solves M x = v by Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(M, v) {
  const n = v.length;
  const A = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (!(Math.abs(A[piv][c]) > 1e-12)) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = A[r][n];
    for (let k = r + 1; k < n; k++) sum -= A[r][k] * x[k];
    x[r] = sum / A[r][r];
  }
  return x;
}

/** Solves the 3x3 system M x = v (Cramer's rule); null when singular. */
function solve3x3(M, v) {
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (!(Math.abs(D) > 1e-12)) return null;
  return [0, 1, 2].map((k) => det(M.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)))) / D);
}

/** The "RSSI@1m" that, with exponent n alone, gives the right answer at d. */
export function effectiveTx1m(d, A, alpha = 0) {
  return A - (alpha > 0 ? alpha * Math.max(0, d - 1) : 0);
}

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
    this.isLagging =
      stats.count >= (config.STATIONARY_MIN_SAMPLES ?? 6) &&
      stats.trendRatio > (config.LAG_TREND_MIN ?? 0.6) &&
      stats.meanAbs > (config.LAG_INNOV_SIGMA_MIN ?? 1.0) * sigma;
    this.isStationary =
      motionHint !== null
        ? !motionHint && !this.isLagging
        : stats.count >= (config.STATIONARY_MIN_SAMPLES ?? 6) &&
          stats.trendRatio < (config.STATIONARY_TREND_MAX ?? 0.35) &&
          stats.meanAbs < (config.STATIONARY_INNOV_SIGMA_MAX ?? 1.0) * sigma &&
          Math.abs(this.v) < (config.STATIONARY_MAX_RATE_DB_S ?? 1.0);

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
      isLagging: Boolean(this.isLagging),
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
    // Extra loss per metre (see DEFAULT_EXCESS_LOSS_DB_PER_M).
    this.fittedAlpha = DEFAULT_ADAPTIVE_CONFIG.DEFAULT_EXCESS_LOSS_DB_PER_M;
    this.rSquared = null;
    this.isCalibrated = false;
    // Points collected automatically while walking (RangeAutoCalibrator):
    // { distanceM, rssi, shape, sigmaDb, timestamp, source }. Kept apart from
    // the hand-logged referencePoints so the calibration list stays readable.
    this.autoPoints = [];
    // Prior on A used by the last fit, reused by automatic refits.
    this.priorTx = null;
    // RSSI@1m typed by hand (or set by Match Beacons): a fixed value, NOT a
    // measurement. It used to be saved as a measured point at 1 m, so a test
    // value typed once (e.g. -73) silently bent the beacon's model for good.
    this.txOverride = null;
    // Bumped on every refit, so the radio map knows to rebuild.
    this.version = 0;
    // Loss per obstacle crossed (dB), OBSTACLE_TYPES order, fitted with A and
    // n - see ObstacleMap.js. Starts at typical values.
    this.fittedWallLoss = OBSTACLE_TYPES.map((t) => t.lossDb);
    // (point {x,y} in feet) -> obstacle crossing counts between that point
    // and this beacon. Set by the scanner from the drawn obstacles; null when
    // nothing is drawn or the beacon's place on the plan is unknown.
    this.wallFeatureFn = null;

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
  addReferencePoint(distanceM, rssi, meta = {}) {
    if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(rssi)) return;
    const point = {
      distanceM: Number(distanceM.toFixed(2)),
      rssi: Number(rssi.toFixed(1)),
      timestamp: Date.now(),
    };
    // Fraction of body loss that applied while this point was measured
    // (0 = facing the beacon, 1 = beacon behind the user). Unknown = null,
    // treated as 0, which is what the instructions for manual points ask for.
    if (Number.isFinite(meta.shape)) point.shape = Number(meta.shape.toFixed(2));
    if (meta.source) point.source = meta.source;
    // Where on the floor plan it was measured (feet), for the radio map.
    if (Number.isFinite(meta.x) && Number.isFinite(meta.y)) {
      point.x = Number(meta.x.toFixed(1));
      point.y = Number(meta.y.toFixed(1));
      // How exactly that place is known (feet): a tap on the plan.
      point.posSigmaFt = Number.isFinite(meta.posSigmaFt) ? meta.posSigmaFt : 1.0;
    }
    this.referencePoints.push(point);
  }

  /**
   * Regularised, robust fit of RSSI = A - 10 n log10(d) - alpha (d - 1) over
   * points whose level has had the body loss they were measured with added
   * back. Each point is weighted by its own uncertainty (sigmaDb).
   *
   * Plain least squares needs well-separated distances before it means
   * anything, and with only a few points one noisy reading swings the slope
   * to an absurd value. Gaussian priors on A (weak), n and alpha (moderate)
   * fix both: one point already gives a good 1 m level with the decay held
   * near its prior, and as points spread over the room the data takes over.
   * A few Huber reweighting passes then stop a single bad point (someone
   * walked between phone and beacon) from tilting the model.
   */
  _ridgeFit(pts, opts = {}) {
    const cfg = DEFAULT_ADAPTIVE_CONFIG;
    const tx0 = Number.isFinite(opts.priorTx) ? opts.priorTx : cfg.DEFAULT_TX_POWER_1M;
    const n0 = Number.isFinite(opts.priorN) ? opts.priorN : cfg.DEFAULT_PATH_LOSS_N;
    const al0 = Number.isFinite(opts.priorAlpha) ? opts.priorAlpha : (cfg.DEFAULT_EXCESS_LOSS_DB_PER_M ?? 0);
    const sTx = Number.isFinite(opts.priorTxSigma) ? opts.priorTxSigma : (cfg.CALIB_PRIOR_TX_SIGMA_DB ?? 8.0);
    const sN = cfg.CALIB_PRIOR_N_SIGMA ?? 0.4;
    const sAl = cfg.CALIB_PRIOR_ALPHA_SIGMA ?? 1.0;
    const huberK = cfg.CALIB_HUBER_K ?? 1.5;
    const s0 = cfg.CALIB_POINT_SIGMA_DB ?? 2.0;
    const bodyDb = Number.isFinite(opts.bodyLossDb) ? opts.bodyLossDb : (cfg.BODY_SHADOW_LOSS_DB ?? 0);
    // Parameters: [A, n, alpha, L_type0 .. L_typeK]. Model:
    //   y = A - n * 10 log10(d) - alpha * max(0, d - 1) - SUM_k L_k * crossings_k
    const prior = [
      [tx0, sTx],
      [n0, sN],
      [al0, sAl],
      ...OBSTACLE_TYPES.map((t) => [t.lossDb, t.sigmaDb]),
    ];
    const P = prior.length;
    const rows = pts.map((p) => {
      const c = this._countsFor(p);
      return {
        f: [1, -10.0 * Math.log10(p.distanceM), -Math.max(0, p.distanceM - 1), ...c.map((v) => -v)],
        y: p.rssi + bodyDb * (Number.isFinite(p.shape) ? p.shape : 0),
        s: Number.isFinite(p.sigmaDb) && p.sigmaDb > 0 ? p.sigmaDb : s0,
        w: 1,
      };
    });
    // Parameters pinned at a floor (alpha >= 0, losses >= 0.5 dB) when the
    // free fit wants them below it.
    const floors = [null, null, 0, ...OBSTACLE_TYPES.map(() => 0.5)];
    const pinned = new Set();
    const solve = () => {
      const M = Array.from({ length: P }, () => new Array(P).fill(0));
      const v = new Array(P).fill(0);
      prior.forEach(([mu, sd], i) => {
        const [m, s] = pinned.has(i) ? [floors[i], 1e-3] : [mu, sd];
        M[i][i] += 1 / s ** 2;
        v[i] += m / s ** 2;
      });
      for (const r of rows) {
        const w = r.w / r.s ** 2;
        for (let i = 0; i < P; i++) {
          if (r.f[i] === 0) continue;
          v[i] += w * r.f[i] * r.y;
          for (let j = 0; j < P; j++) M[i][j] += w * r.f[i] * r.f[j];
        }
      }
      return solveLinear(M, v);
    };
    let theta = null;
    for (let pass = 0; pass < 4; pass++) {
      for (let guard = 0; guard < P; guard++) {
        theta = solve();
        if (!theta) return null;
        const low = theta.findIndex((x, i) => floors[i] !== null && !pinned.has(i) && x < floors[i]);
        if (low < 0) break;
        pinned.add(low);
      }
      for (const r of rows) {
        const res = Math.abs(r.y - r.f.reduce((acc, f, i) => acc + f * theta[i], 0));
        r.w = res > huberK * r.s ? (huberK * r.s) / res : 1;
      }
    }
    return {
      tx: theta[0],
      n: theta[1],
      alpha: Math.max(0, theta[2]),
      wallLoss: theta.slice(3).map((x) => Math.max(0.5, x)),
    };
  }

  /** Obstacle crossings between a calibration point and this beacon. */
  _countsFor(p) {
    if (this.wallFeatureFn && Number.isFinite(p?.x) && Number.isFinite(p?.y)) {
      const c = this.wallFeatureFn({ x: p.x, y: p.y, posSigmaFt: p.posSigmaFt });
      if (Array.isArray(c) && c.length === OBSTACLE_TYPES.length) return c;
    }
    return OBSTACLE_TYPES.map(() => 0);
  }

  /** Level the model predicts at distance d from place p (feet), obstacles included. */
  predictAt(distanceM, p = null) {
    const L = p ? ObstacleMap.lossFromCounts(this._countsFor(p), this.fittedWallLoss) : 0;
    return this._predictRssi(distanceM) - L;
  }

  /**
   * A point measured automatically (position from the walked track, so its
   * distance carries some uncertainty - sigmaDb says how much, in dB).
   */
  addAutoPoint(distanceM, rssi, meta = {}) {
    if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(rssi)) return false;
    this.autoPoints.push({
      distanceM: Number(distanceM.toFixed(2)),
      rssi: Number(rssi.toFixed(1)),
      shape: Number.isFinite(meta.shape) ? Number(meta.shape.toFixed(2)) : null,
      sigmaDb: Number((Number.isFinite(meta.sigmaDb) ? meta.sigmaDb : 4).toFixed(2)),
      source: meta.source || "auto",
      x: Number.isFinite(meta.x) ? Number(meta.x.toFixed(1)) : null,
      y: Number.isFinite(meta.y) ? Number(meta.y.toFixed(1)) : null,
      // Uncertainty of the walked-track position (feet).
      posSigmaFt: Number.isFinite(meta.posSigmaFt) ? Number(meta.posSigmaFt.toFixed(1)) : 3.0,
      timestamp: Date.now(),
    });
    const max = DEFAULT_ADAPTIVE_CONFIG.AUTO_CALIB_MAX_POINTS ?? 80;
    if (this.autoPoints.length > max) this.autoPoints.splice(0, this.autoPoints.length - max);
    return true;
  }

  /** Every point the fit uses, each with its own uncertainty. */
  _allFitPoints() {
    const s0 = DEFAULT_ADAPTIVE_CONFIG.CALIB_POINT_SIGMA_DB ?? 2.0;
    return [
      ...this.referencePoints.map((p) => ({ ...p, sigmaDb: s0 })),
      ...this.autoPoints,
    ];
  }

  removeReferencePoint(index) {
    if (index >= 0 && index < this.referencePoints.length) {
      this.referencePoints.splice(index, 1);
    }
  }

  clear() {
    this.referencePoints = [];
    this.autoPoints = [];
    this.fittedWallLoss = OBSTACLE_TYPES.map((t) => t.lossDb);
    this.txOverride = null;
    this.version += 1;
    this.fittedAlpha = DEFAULT_ADAPTIVE_CONFIG.DEFAULT_EXCESS_LOSS_DB_PER_M;
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
  set1MeterTxPower(txPower1m, opts = {}) {
    const val = Number(Number(txPower1m).toFixed(1));
    this.autoCalibrated = false;
    if (opts.measured) {
      // Really measured at 1 m: a calibration point like any other.
      this.txOverride = null;
      const idx = this.referencePoints.findIndex((p) => p.source === "1m");
      const point = { distanceM: 1.0, rssi: val, timestamp: Date.now(), source: "1m" };
      if (idx >= 0) this.referencePoints[idx] = point;
      else this.referencePoints.unshift(point);
    } else {
      // Typed: fixes RSSI@1m; the decay is still fitted from any real points.
      this.txOverride = val;
    }
    this.fitModel();
    this.fittedTxPower1m = Number.isFinite(this.txOverride) ? this.txOverride : this.fittedTxPower1m;
    this.isCalibrated = true;
    this.saveToStorage();
    return { success: true, txPower1m: this.fittedTxPower1m };
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
  fitModel(opts = {}) {
    const pts = this._allFitPoints();
    const override = Number.isFinite(this.txOverride);
    if (pts.length < 1 && !override) {
      return null;
    }
    if (Number.isFinite(opts.priorTx)) this.priorTx = opts.priorTx;
    const ridge = this._ridgeFit(pts, {
      ...opts,
      priorTx: override ? this.txOverride : (opts.priorTx ?? this.priorTx ?? undefined),
      priorTxSigma: override ? 0.2 : undefined,
    });
    if (!ridge) return null;
    this.version += 1;

    const cfg = DEFAULT_ADAPTIVE_CONFIG;
    this.fittedN = Number(Math.max(1.6, Math.min(4.5, ridge.n)).toFixed(2));
    this.fittedTxPower1m = Number(Math.max(-95.0, Math.min(-35.0, ridge.tx)).toFixed(1));
    this.fittedAlpha = Number(Math.max(0, Math.min(cfg.EXCESS_LOSS_MAX_DB_PER_M ?? 4, ridge.alpha)).toFixed(2));
    this.fittedWallLoss = ridge.wallLoss.map((x) => Number(Math.min(25, x).toFixed(1)));
    // The extra-loss term replaces the old near/far (dual-slope) split: it
    // describes the same "decays faster far away" behaviour with one smooth
    // curve and needs no breakpoint.
    this.hasFarSegment = false;
    this.fittedNFar = null;
    this.rssiAtBreakpoint = null;

    // ── Goodness of fit (R²) and typical miss, over every point ──
    const bodyDb = cfg.BODY_SHADOW_LOSS_DB ?? 0;
    const ys = pts.map((p) => p.rssi + bodyDb * (Number.isFinite(p.shape) ? p.shape : 0));
    const meanY = ys.reduce((acc, y) => acc + y, 0) / ys.length;
    let ssTot = 0;
    let ssRes = 0;
    pts.forEach((p, i) => {
      ssTot += (ys[i] - meanY) ** 2;
      ssRes += (ys[i] - this.predictAt(p.distanceM, p)) ** 2;
    });
    const r2 = ssTot > 0 ? Math.max(0.0, 1.0 - ssRes / ssTot) : 1.0;

    this.rSquared = Number(r2.toFixed(3));
    this.rmsDb = pts.length ? Number(Math.sqrt(ssRes / pts.length).toFixed(2)) : null;
    this.isCalibrated = true;
    this.autoCalibrated = false;

    return {
      n: this.fittedN,
      alpha: this.fittedAlpha,
      nFar: null,
      hasFarSegment: false,
      breakpointDistanceM: this.breakpointDistanceM,
      txPower1m: this.fittedTxPower1m,
      wallLoss: this.fittedWallLoss,
      rSquared: this.rSquared,
      rmsDb: this.rmsDb,
      pointCount: this.referencePoints.length,
      autoPointCount: this.autoPoints.length,
    };
  }

  /**
   * Predicts RSSI at a given distance under the currently fitted model
   * (dual-slope if active, otherwise single-slope). Inverse of distanceFromRssi().
   */
  _predictRssi(distanceM) {
    return predictLevelDb(distanceM, this.fittedTxPower1m, this.fittedN, this.fittedAlpha);
  }

  /**
   * Converts a ranging level to distance with the fitted model. This is the
   * single source of truth for level -> distance once a beacon is calibrated.
   *
   * @param {number} rssi
   * @returns {number} distance in metres (>= 0)
   */
  distanceFromRssi(rssi) {
    const d = solveDistanceM(rssi, this.fittedTxPower1m, this.fittedN, this.fittedAlpha);
    return Number.isFinite(d) && d >= 0 ? d : 1.0;
  }

  /**
   * Points measured at a known place on the floor plan, with how far each
   * one sits from the fitted model (dB, + = stronger than the model). This
   * difference is what walls, pillars and cabins do at that place - the
   * radio map interpolates it between points.
   */
  getRadioMapPoints() {
    const cfg = DEFAULT_ADAPTIVE_CONFIG;
    const bodyDb = cfg.BODY_SHADOW_LOSS_DB ?? 0;
    const s0 = cfg.CALIB_POINT_SIGMA_DB ?? 2.0;
    const out = [];
    for (const p of [...this.referencePoints, ...this.autoPoints]) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const y = p.rssi + bodyDb * (Number.isFinite(p.shape) ? p.shape : 0);
      out.push({
        x: p.x,
        y: p.y,
        // What the drawn obstacles do not explain (people, furniture, walls
        // not drawn, reflections). The map is built on this, i.e. the drawn
        // obstacles are its prior mean - the Bayesian way to combine the two.
        residualDb: y - this.predictAt(p.distanceM, p),
        sigmaDb: Number.isFinite(p.sigmaDb) ? p.sigmaDb : s0,
      });
    }
    return out;
  }

  /** Effective RSSI@1m at distance d (A - alpha (d - 1)), for display. */
  txAtDistance(distanceM) {
    return effectiveTx1m(distanceM, this.fittedTxPower1m, this.fittedAlpha);
  }

  async saveToStorage() {
    try {
      const data = {
        beaconId: this.beaconId,
        referencePoints: this.referencePoints,
        fittedN: this.fittedN,
        fittedTxPower1m: this.fittedTxPower1m,
        fittedAlpha: this.fittedAlpha,
        autoPoints: this.autoPoints,
        priorTx: this.priorTx,
        txOverride: this.txOverride,
        fittedWallLoss: this.fittedWallLoss,
        modelVersion: 3,
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
        // A model written by the removed automatic calibration replaced the
        // measured RSSI@1m and n. It is ignored, so the baseline is always a
        // measured calibration (or the advertised/default values) and only the
        // bounded adaptive layer corrects on top of it.
        if (parsed.autoCalibrated) {
          console.log(`[PathLossCalibrator] ignoring auto-learned model for ${this.beaconId}`);
          return;
        }
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
        this.autoPoints = Array.isArray(parsed.autoPoints) ? parsed.autoPoints : [];
        this.priorTx = Number.isFinite(parsed.priorTx) ? parsed.priorTx : null;
        this.fittedAlpha = Number.isFinite(parsed.fittedAlpha)
          ? parsed.fittedAlpha
          : DEFAULT_ADAPTIVE_CONFIG.DEFAULT_EXCESS_LOSS_DB_PER_M;
        this.txOverride = Number.isFinite(parsed.txOverride) ? parsed.txOverride : null;
        if (Array.isArray(parsed.fittedWallLoss) && parsed.fittedWallLoss.length === OBSTACLE_TYPES.length) {
          this.fittedWallLoss = parsed.fittedWallLoss;
        }
        if (parsed.modelVersion !== 3) {
          // Older saves: auto points from the first auto-calibration were too
          // noisy to keep, and a 1 m point without a source may be a value
          // TYPED into Signal Lab rather than measured - which is how one test
          // value could bend a beacon for good. Both are dropped; spot and
          // two-stand points are kept.
          this.autoPoints = [];
          this.referencePoints = this.referencePoints.filter(
            (p) => p.source || Math.abs(p.distanceM - 1.0) >= 0.05
          );
          this.fittedAlpha = DEFAULT_ADAPTIVE_CONFIG.DEFAULT_EXCESS_LOSS_DB_PER_M;
          if (this._allFitPoints().length > 0) this.fitModel();
          else this.isCalibrated = false;
          this.saveToStorage();
        }
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
    if (motionHint !== null) {
      // "Still" from the step detector is trusted unless the signal itself
      // proves the range is changing (see LAG_TREND_MIN).
      if (kalmanOut.isLagging) {
        if (!Number.isFinite(entry.lagSince)) entry.lagSince = timestamp;
      } else {
        entry.lagSince = null;
      }
      const sustainedLag =
        Number.isFinite(entry.lagSince) &&
        timestamp - entry.lagSince >= (this.config.LAG_OVERRIDE_MS ?? 2500);
      motionMode = motionHint ? "moving" : sustainedLag ? "unknown" : "still";
    } else {
      motionMode = kalmanOut.isStationary ? "still" : "unknown";
    }
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
    let envDecayRate = Math.min(
      this.config.ENVELOPE_MAX_DECAY_DB_S ?? 12.0,
      (this.config.ENVELOPE_DECAY_DB_S ?? 0.35)
        + Math.max(0, tSincePeakSec - envHoldSec) * envRamp
    );

    // Trend release (see TREND_RELEASE_*): a sustained fall is movement, not a
    // fade, so the envelope must follow it instead of holding the old peak.
    const rate = Number.isFinite(kalmanOut.rateDbPerS) ? kalmanOut.rateDbPerS : 0;
    if (rate < -(this.config.TREND_RELEASE_RATE_DB_S ?? 0.8)) {
      if (!Number.isFinite(entry.fallSince)) entry.fallSince = timestamp;
    } else {
      entry.fallSince = null;
    }
    const sustainedFall =
      Number.isFinite(entry.fallSince) &&
      timestamp - entry.fallSince >= (this.config.TREND_RELEASE_AFTER_MS ?? 700);
    if (sustainedFall && !treatAsStill && Number.isFinite(entry.shadowEnvelopeDb)) {
      const gap = Math.max(0, entry.shadowEnvelopeDb - safeFilteredRssi);
      envDecayRate = Math.max(envDecayRate, -rate + gap / (this.config.TREND_CLOSE_S ?? 0.8));
    }
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
    const shadowCorrectionDb = this.config.SHADOW_ENVELOPE_RANGING
      ? Math.min(
          this.config.MAX_ENVELOPE_CORRECTION_DB ?? 9.0,
          shadowGapDb * (this.config.ENVELOPE_WEIGHT ?? 0.75)
        )
      : 0;
    // The level calibration is measured against: filtered, before the body
    // correction and before standing-still averaging (both are re-applied
    // identically when ranging, so calibration and ranging stay consistent).
    const levelDb = safeFilteredRssi + shadowCorrectionDb;

    // 5c. Body shadow (see BODY_SHADOW_LOSS_DB).
    const shadowFresh =
      Number.isFinite(entry.bodyShadowAt) &&
      timestamp - entry.bodyShadowAt <= (this.config.BODY_SHADOW_STALE_MS ?? 3000);
    const bodyLossDb = shadowFresh
      ? (this.config.BODY_SHADOW_LOSS_DB ?? 0) * Math.max(0, Math.min(1, entry.bodyShadow))
      : 0;

    // 5d. Standing still: average since the user stopped (STILL_AVERAGE_TAU_MAX_S).
    // 5c'. Radio map (see setLocationCorrection): what the walls between this
    // place and the beacon take away, added back.
    const locFresh =
      Number.isFinite(entry.locCorrAt) &&
      timestamp - entry.locCorrAt <= (this.config.LOCATION_CORRECTION_STALE_MS ?? 3000);
    const locationCorrectionDb = locFresh ? entry.locCorrDb : 0;
    let rangingRssi = levelDb + bodyLossDb + locationCorrectionDb;
    // Release: the live level has stayed well away from the average - the
    // range really changed even though no step was seen.
    if (treatAsStill && Number.isFinite(entry.stillAvgDb)) {
      if (Math.abs(rangingRssi - entry.stillAvgDb) > (this.config.STILL_RELEASE_DB ?? 3)) {
        if (!Number.isFinite(entry.stillDivergeSince)) entry.stillDivergeSince = timestamp;
      } else {
        entry.stillDivergeSince = null;
      }
      if (
        Number.isFinite(entry.stillDivergeSince) &&
        timestamp - entry.stillDivergeSince >= (this.config.STILL_RELEASE_MS ?? 1200)
      ) {
        entry.stillAvgDb = null; // restart from the current level below
        entry.stillDivergeSince = null;
      }
    }
    if (treatAsStill && Number.isFinite(entry.stillAvgDb)) {
      const dtA = Math.min(1.0, Math.max(0.02, (timestamp - entry.stillLastT) / 1000.0));
      const tau = Math.max(
        0.5,
        Math.min(this.config.STILL_AVERAGE_TAU_MAX_S ?? 10, (timestamp - entry.stillSince) / 1000.0)
      );
      entry.stillAvgDb += (rangingRssi - entry.stillAvgDb) * Math.min(1, dtA / tau);
      rangingRssi = entry.stillAvgDb;
    } else {
      entry.stillAvgDb = rangingRssi;
      entry.stillSince = timestamp;
    }
    entry.stillLastT = timestamp;

    let slantDistM;
    const safeAlpha = entry.calibrator.isCalibrated
      ? entry.calibrator.fittedAlpha
      : (this.config.DEFAULT_EXCESS_LOSS_DB_PER_M ?? 0);
    if (entry.calibrator.isCalibrated) {
      slantDistM = entry.calibrator.distanceFromRssi(rangingRssi);
    } else {
      // Uncalibrated: same model with the default/advertised RSSI@1m, default
      // n and the default extra loss per metre.
      slantDistM = solveDistanceM(rangingRssi, safeTx, safeN, safeAlpha);
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
    if (
      this.config.DISTANCE_SLEW_CLAMP &&
      entry.totalPackets > 2 && prevDist !== null && Number.isFinite(prevDist)
    ) {
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

    // Moving: light smoothing in log-distance (see MOVING_SMOOTH_TAU_S).
    const smoothTau = this.config.MOVING_SMOOTH_TAU_S ?? 0;
    if (smoothTau > 0 && !treatAsStill && clampedDistM > 0 && Number.isFinite(entry.smoothLnD)) {
      const dtS = Math.min(1.0, Math.max(0.02, (timestamp - (entry.smoothT ?? timestamp)) / 1000.0));
      entry.smoothLnD += (Math.log(clampedDistM) - entry.smoothLnD) * Math.min(1, dtS / smoothTau);
      clampedDistM = Math.exp(entry.smoothLnD);
    } else if (clampedDistM > 0) {
      entry.smoothLnD = Math.log(clampedDistM);
    }
    entry.smoothT = timestamp;

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
      // Calibration level (no body correction, no standing average) and the
      // body correction that was applied - see levelDb / bodyLossDb above.
      levelDb: Number(levelDb.toFixed(2)),
      bodyLossDb: Number(bodyLossDb.toFixed(2)),
      packetGapMs: gapMs,
      stdDev: entry.profile.getStdDev(),
      stabilityScore: Number.isFinite(stabilityScore) ? stabilityScore : 0.5,
      confidenceScore,
      currentN: safeN,
      txPower1m: safeTx,
      // Extra loss per metre, and the RSSI@1m actually in effect at this range
      // (A - alpha (d - 1)) - the number observed by hand at known distances.
      excessLossDbPerM: safeAlpha,
      locationCorrectionDb: Number(locationCorrectionDb.toFixed(2)),
      // 1-sigma distance uncertainty: level error / slope of the model here.
      rangeSigmaM: Number(
        (slantDistM * ((locFresh && Number.isFinite(entry.locSigmaDb)
          ? entry.locSigmaDb
          : (this.config.RANGE_SIGMA_DB_DEFAULT ?? 5)) /
          ((10 * safeN) / Math.LN10 + safeAlpha * Math.max(slantDistM, 0.1)))).toFixed(2)
      ),
      txAtDistance: Number(effectiveTx1m(slantDistM, safeTx, safeAlpha).toFixed(1)),
      autoPointsCount: entry.calibrator.autoPoints.length,
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
  /**
   * How much of the body loss applies to this beacon right now: 0 when the
   * user faces it, 1 when it is directly behind them. Supplied by whoever
   * knows the user's heading and position (the Fusion Map).
   */
  /**
   * Radio-map correction at the user's current position: dB to add to this
   * beacon's level (positive = something here weakens the signal), and how
   * sure the map is (1-sigma, dB).
   */
  setLocationCorrection(beaconId, db, sigmaDb = null, timestamp = Date.now()) {
    if (!beaconId || !Number.isFinite(db)) return;
    const entry = this._getOrCreate(beaconId);
    entry.locCorrDb = Math.max(-15, Math.min(15, db));
    entry.locSigmaDb = Number.isFinite(sigmaDb) ? sigmaDb : null;
    entry.locCorrAt = timestamp;
  }

  setBodyShadow(beaconId, fraction, timestamp = Date.now()) {
    if (!beaconId || !Number.isFinite(fraction)) return;
    const entry = this._getOrCreate(beaconId);
    entry.bodyShadow = Math.max(0, Math.min(1, fraction));
    entry.bodyShadowAt = timestamp;
  }

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
