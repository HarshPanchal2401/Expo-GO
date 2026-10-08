// ============================================================================
// StepLengthModel.js — Per-User Step Length Estimation & Distance Calibration
//
// WHY THIS EXISTS AS ITS OWN MODULE:
// Step COUNTING and step LENGTH are different problems with different failure
// modes. The accelerometer state machine counts steps almost perfectly, which
// is why PDR traces look the right shape — but the distance walked is only as
// good as the length assigned to each step, and that part was buried inside the
// app's sensor callback where it could not be tested or calibrated. All of the
// length maths now lives here so it can be simulated against known walks.
//
// TWO INDEPENDENT ERROR SOURCES ARE CORRECTED:
//
// 1. FILTER ATTENUATION (a systematic, speed-dependent under-read).
//    The step length model L = K·(peak-to-valley)^(1/4) assumes it is fed the
//    TRUE acceleration swing. In practice the signal is low-pass filtered first
//    to make peak detection robust, and the previous filter's cutoff (~1.9 Hz)
//    sat in the middle of the human gait band (1.2-2.6 Hz). It therefore shrank
//    the very amplitude the model depends on, and shrank it MORE the faster the
//    user walked — so distance read short, and progressively shorter with pace.
//    Measured: -2.7% at a slow 1.2 Hz, -10.9% at a brisk 2.4 Hz.
//    Fixed in two stages: the filter is widened so the gait band is nearly flat,
//    and whatever attenuation remains is divided back out analytically using the
//    filter's exact frequency response at the measured step rate.
//
// 2. PERSONAL SCALE (a constant factor that no formula can know).
//    Weinberg's K depends on the person's leg length and gait. A single shipped
//    constant cannot be right for everyone, and no amount of signal processing
//    fixes it — if K is 10% off, every distance is 10% off. calibrate() solves
//    this directly: walk a measured distance, and the model back-solves the
//    scale that makes its own output match. This is what turns "the shape is
//    right" into "10 ft on the floor reads 10 ft on the map".
// ============================================================================

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@pdr_step_length_model_v1";

const M_TO_FT = 3.280839895;

export const STEP_MODEL_CONFIG = {
  // Accelerometer sampling period the filter gain is computed against. Must
  // match Accelerometer.setUpdateInterval() in the app.
  SAMPLE_INTERVAL_MS: 30,

  // Low-pass coefficient for the detection signal: y += alpha * (x - y).
  // Chosen so the cutoff lands ABOVE the gait band (~5 Hz at a 30 ms period)
  // rather than inside it, while still removing high-frequency sensor hash.
  LPF_ALPHA: 0.61,

  // Weinberg coefficient, used as the starting point before personal
  // calibration. Only ever a starting point — see calibrate().
  WEINBERG_K: 0.74,

  // Physiological bounds on a single human step, in metres. Applied last, after
  // scaling, so a corrupt sample cannot inject an absurd distance.
  MIN_STEP_LENGTH_M: 0.4,
  MAX_STEP_LENGTH_M: 1.2,

  // Plausible cadence range in steps/second. Outside this the step interval is
  // treated as unreliable and no filter compensation is applied.
  MIN_CADENCE_HZ: 0.6,
  MAX_CADENCE_HZ: 3.2,

  // Never divide the amplitude by a gain smaller than this. Guards against a
  // wild compensation factor if the cadence estimate is briefly wrong.
  MIN_FILTER_GAIN: 0.5,

  // Bounds on the learned personal scale. A genuine person needs well under
  // 2x correction; anything beyond indicates a bad calibration walk.
  MIN_PERSONAL_SCALE: 0.55,
  MAX_PERSONAL_SCALE: 1.8,

  // A calibration walk shorter than this proves little, because a one-step
  // counting error is then a large fraction of the total.
  // These two thresholds must stay CONSISTENT with each other: at a typical
  // 0.72 m stride, 15 steps is about 11 m, so a distance minimum below that
  // would advertise walks that the step minimum then rejects. They are set as
  // a matched pair, and the calibration UI's suggested distance is chosen to
  // clear both comfortably.
  MIN_CALIBRATION_STEPS: 15,
  MIN_CALIBRATION_DISTANCE_M: 11,

  // Step length from the step RATE, for a phone not held in front (pocket,
  // swinging hand, at the ear). There the bounce Weinberg needs is dominated
  // by the leg or arm swing instead of the body's bounce, so it says little
  // about the step; the step rate is the same however the phone is carried.
  // Adult walking: ~0.50 m at 1.4 steps/s, ~0.70 m at 1.85, ~0.80 m at 2.1.
  CADENCE_SLOPE_M: 0.425,
  CADENCE_OFFSET_M: -0.09,
  CADENCE_MIN_HZ: 1.0,
  CADENCE_MAX_HZ: 2.6,
  // The cadence model is fitted to THIS user while the phone is held in
  // front: Weinberg length / cadence length, averaged over that many steps.
  CADENCE_RATIO_MIN_STEPS: 8,
  CADENCE_RATIO_RATE: 0.05,
};

/**
 * Magnitude of a one-pole low-pass filter's frequency response.
 *
 *   y[n] = y[n-1] + alpha * (x[n] - y[n-1])
 *   |H(f)| = alpha / |1 - (1-alpha)·e^(-j·2πf·dt)|
 *
 * This is the exact factor by which the filter shrinks a sinusoid at frequency
 * f, and therefore exactly what has to be divided back out to recover the true
 * acceleration swing from the filtered one.
 */
export function lowPassGain(freqHz, alpha, dtSec) {
  if (!Number.isFinite(freqHz) || freqHz <= 0) return 1.0;
  const w = 2 * Math.PI * freqHz * dtSec;
  const oneMinus = 1 - alpha;
  const re = 1 - oneMinus * Math.cos(w);
  const im = oneMinus * Math.sin(w);
  const denom = Math.hypot(re, im);
  if (!Number.isFinite(denom) || denom < 1e-9) return 1.0;
  return alpha / denom;
}

/** Cutoff (-3 dB) frequency of the same one-pole filter, for diagnostics. */
export function lowPassCutoffHz(alpha, dtSec) {
  return -Math.log(Math.max(1e-9, 1 - alpha)) / (2 * Math.PI * dtSec);
}

export class StepLengthModel {
  constructor(config = {}) {
    this.cfg = { ...STEP_MODEL_CONFIG, ...config };

    // Learned multiplier applied to the raw model output. 1.0 = uncalibrated.
    this.personalScale = 1.0;
    this.calibratedAt = null;
    this.calibrationSamples = 0;
    this.calibrationDistanceM = 0;
    // The Weinberg K that was in force when the scale was solved. Stored
    // because the app exposes K as a user setting, and the scale is only
    // meaningful relative to the K it was fitted against — see effectiveScale().
    this.calibrationK = null;

    // Accumulator used while a calibration walk is in progress.
    this._calibrating = false;
    this._calRawSumM = 0;
    this._calSteps = 0;

    // Raw Weinberg length / cadence-model length for this user (texting).
    this.cadenceRatio = null;
    this.cadenceRatioSteps = 0;
    this._ratioUnsaved = 0;
  }

  /** Population step length (m) at a step rate (steps/s). */
  cadenceLength(cadenceHz) {
    const c = this.cfg;
    const f = Math.min(c.CADENCE_MAX_HZ, Math.max(c.CADENCE_MIN_HZ, cadenceHz));
    return c.CADENCE_SLOPE_M * f + c.CADENCE_OFFSET_M;
  }

  /**
   * Step length for any way of carrying the phone.
   *
   * Held in front (texting): Weinberg from the bounce, as estimate(); and
   * those steps teach the cadence model this user's stride. Otherwise: the
   * cadence model, scaled to the user, then the personal (calibration) scale
   * - so one calibration walk serves every carry mode.
   *
   * @param {number} bounceG
   * @param {object} info  { cadenceHz, carry: texting|vertical|swinging|unknown }
   */
  estimateCarry(bounceG, info = {}) {
    const f = Number.isFinite(info.cadenceHz) && info.cadenceHz > 0 ? info.cadenceHz : null;
    const carry = info.carry || "unknown";
    if (carry === "texting" || carry === "unknown" || f === null) {
      const est = this.estimate(bounceG, null);
      if (carry === "texting" && f !== null) this._learnCadenceRatio(est.rawLengthM / this.cadenceLength(f));
      return { ...est, model: "weinberg" };
    }
    const ratio = this.cadenceRatioSteps >= this.cfg.CADENCE_RATIO_MIN_STEPS && this.cadenceRatio
      ? this.cadenceRatio
      : 1 / this.effectiveScale();
    const raw = this.cadenceLength(f) * ratio;
    const lengthM = Math.min(this.cfg.MAX_STEP_LENGTH_M, Math.max(this.cfg.MIN_STEP_LENGTH_M, raw * this.effectiveScale()));
    if (this._calibrating) {
      this._calRawSumM += raw;
      this._calSteps += 1;
    }
    return {
      lengthM,
      lengthFt: lengthM * M_TO_FT,
      rawLengthM: raw,
      cadenceHz: f,
      isCalibrated: this.calibrationK !== null,
      model: "cadence",
    };
  }

  _learnCadenceRatio(r) {
    if (!Number.isFinite(r) || r < 0.5 || r > 2) return;
    const n = this.cadenceRatioSteps;
    const rate = Math.max(this.cfg.CADENCE_RATIO_RATE, 1 / (n + 1));
    this.cadenceRatio = this.cadenceRatio === null ? r : this.cadenceRatio + rate * (r - this.cadenceRatio);
    this.cadenceRatioSteps = n + 1;
    if (++this._ratioUnsaved >= 40) {
      this._ratioUnsaved = 0;
      this.save();
    }
  }

  // --------------------------------------------------------------------------
  // ESTIMATION
  // --------------------------------------------------------------------------

  /**
   * Raw, uncalibrated step length in metres from one confirmed step.
   *
   * @param {number} bounceG - peak-to-valley swing of the FILTERED dynamic
   *        acceleration, in g, as measured by the detector.
   * @param {number|null} stepIntervalMs - time since the previous confirmed
   *        step. Used to recover the gait frequency so the filter's attenuation
   *        at that frequency can be divided back out. Pass null on the first
   *        step of a walk, where no interval exists yet.
   * @returns {{ lengthM: number, cadenceHz: number|null, filterGain: number, correctedBounceG: number }}
   */
  rawEstimate(bounceG, stepIntervalMs = null) {
    const dtSec = this.cfg.SAMPLE_INTERVAL_MS / 1000;
    const safeBounce = Number.isFinite(bounceG) && bounceG > 0 ? bounceG : 0;

    // Recover gait frequency from the step interval. One confirmed step is one
    // cycle of the heel-strike oscillation, so cadence IS that frequency.
    let cadenceHz = null;
    if (Number.isFinite(stepIntervalMs) && stepIntervalMs > 0) {
      const f = 1000 / stepIntervalMs;
      if (f >= this.cfg.MIN_CADENCE_HZ && f <= this.cfg.MAX_CADENCE_HZ) cadenceHz = f;
    }

    // Undo the filter's attenuation at that frequency. Without this the model
    // is fed a shrunken amplitude and reports a short step - by an amount that
    // varies with walking speed, which is precisely what made the distance
    // wrong in a speed-dependent way rather than merely wrong by a constant.
    let filterGain = 1.0;
    if (cadenceHz !== null) {
      filterGain = Math.max(
        this.cfg.MIN_FILTER_GAIN,
        Math.min(1.0, lowPassGain(cadenceHz, this.cfg.LPF_ALPHA, dtSec))
      );
    }
    const correctedBounceG = safeBounce / filterGain;

    const lengthM = this.cfg.WEINBERG_K * Math.pow(correctedBounceG, 0.25);
    return { lengthM, cadenceHz, filterGain, correctedBounceG };
  }

  /**
   * The scale to actually apply, corrected for any change to Weinberg K since
   * calibration.
   *
   * Raw length is exactly proportional to K, so the product (scale · K) is the
   * quantity the calibration walk really pinned down. If K is later moved by
   * the settings slider, holding the stored scale fixed would silently shift
   * every distance by the same ratio and quietly undo the calibration. Scaling
   * inversely with K keeps that product constant, so an existing calibration
   * survives a K change instead of being invalidated by it.
   */
  effectiveScale() {
    if (!Number.isFinite(this.calibrationK) || this.calibrationK <= 0) return this.personalScale;
    const currentK = Number.isFinite(this.cfg.WEINBERG_K) && this.cfg.WEINBERG_K > 0
      ? this.cfg.WEINBERG_K
      : this.calibrationK;
    return this.personalScale * (this.calibrationK / currentK);
  }

  /**
   * Final calibrated step length in metres, clamped to physiological bounds.
   * This is the value that should be handed to the PDR / fusion engine.
   */
  estimate(bounceG, stepIntervalMs = null) {
    const raw = this.rawEstimate(bounceG, stepIntervalMs);
    const scaled = raw.lengthM * this.effectiveScale();
    const lengthM = Math.min(
      this.cfg.MAX_STEP_LENGTH_M,
      Math.max(this.cfg.MIN_STEP_LENGTH_M, scaled)
    );

    // While a calibration walk is running, accumulate the RAW (unscaled) length.
    // Accumulating raw is what lets calibrate() solve for the scale directly,
    // and makes a re-calibration independent of whatever scale is loaded now.
    if (this._calibrating) {
      this._calRawSumM += raw.lengthM;
      this._calSteps += 1;
    }

    return {
      lengthM,
      lengthFt: lengthM * M_TO_FT,
      rawLengthM: raw.lengthM,
      cadenceHz: raw.cadenceHz,
      filterGain: raw.filterGain,
      correctedBounceG: raw.correctedBounceG,
      isCalibrated: this.calibrationK !== null,
    };
  }

  // --------------------------------------------------------------------------
  // CALIBRATION
  // --------------------------------------------------------------------------

  /** Begins a calibration walk. Call, walk a measured distance, then calibrate(). */
  beginCalibration() {
    this._calibrating = true;
    this._calRawSumM = 0;
    this._calSteps = 0;
  }

  /** Abandons an in-progress calibration walk without changing the model. */
  cancelCalibration() {
    this._calibrating = false;
    this._calRawSumM = 0;
    this._calSteps = 0;
  }

  /** Live progress of the walk in flight, for showing the user their count. */
  getCalibrationProgress() {
    return {
      active: this._calibrating,
      steps: this._calSteps,
      estimatedDistanceM: this._calRawSumM * this.effectiveScale(),
      estimatedDistanceFt: this._calRawSumM * this.effectiveScale() * M_TO_FT,
    };
  }

  /**
   * Closes the calibration walk against the true distance covered and solves
   * for the personal scale.
   *
   * The model is linear in the scale, so this is exact rather than iterative:
   *   actualDistance = scale · Σ(rawStepLengths)  =>  scale = actual / Σ(raw)
   *
   * @param {number} actualDistanceM - the real distance walked, measured.
   * @returns {{ ok: boolean, reason?: string, scale?: number, previousScale?: number, steps?: number, impliedStepLengthM?: number }}
   */
  calibrate(actualDistanceM) {
    if (!this._calibrating) return { ok: false, reason: "No calibration walk in progress." };

    const steps = this._calSteps;
    const rawSum = this._calRawSumM;
    this._calibrating = false;

    if (!Number.isFinite(actualDistanceM) || actualDistanceM <= 0) {
      return { ok: false, reason: "Distance walked must be a positive number." };
    }
    // A short walk cannot calibrate reliably: with only a handful of steps, a
    // single missed or double-counted step is a large share of the total and
    // would be baked into the scale permanently.
    if (steps < this.cfg.MIN_CALIBRATION_STEPS) {
      return { ok: false, reason: `Only ${steps} steps recorded — walk at least ${this.cfg.MIN_CALIBRATION_STEPS}.` };
    }
    if (actualDistanceM < this.cfg.MIN_CALIBRATION_DISTANCE_M) {
      return { ok: false, reason: `Walk at least ${this.cfg.MIN_CALIBRATION_DISTANCE_M} m (${(this.cfg.MIN_CALIBRATION_DISTANCE_M * M_TO_FT).toFixed(0)} ft) for a reliable result.` };
    }
    if (!Number.isFinite(rawSum) || rawSum <= 0) {
      return { ok: false, reason: "No usable step data was recorded." };
    }

    const solved = actualDistanceM / rawSum;
    const clamped = Math.min(this.cfg.MAX_PERSONAL_SCALE, Math.max(this.cfg.MIN_PERSONAL_SCALE, solved));
    const previousScale = this.personalScale;

    // A scale that had to be clamped means the walk disagrees with the model by
    // more than any real person's gait can explain — far more likely a wrong
    // distance entry or a miscounted walk than a genuine physiology. Reject it
    // rather than quietly storing a half-applied correction.
    if (Math.abs(clamped - solved) > 1e-9) {
      return {
        ok: false,
        reason: `Implied correction (${solved.toFixed(2)}x) is outside the plausible range — check the distance entered and that tracking ran for the whole walk.`,
      };
    }

    this.personalScale = clamped;
    this.calibrationK = this.cfg.WEINBERG_K;
    this.calibratedAt = Date.now();
    this.calibrationSamples = steps;
    this.calibrationDistanceM = actualDistanceM;

    return {
      ok: true,
      scale: clamped,
      previousScale,
      steps,
      impliedStepLengthM: actualDistanceM / steps,
    };
  }

  /** Discards calibration and returns to the shipped default. */
  resetCalibration() {
    this.personalScale = 1.0;
    this.calibrationK = null;
    this.calibratedAt = null;
    this.calibrationSamples = 0;
    this.calibrationDistanceM = 0;
  }

  // --------------------------------------------------------------------------
  // PERSISTENCE
  // --------------------------------------------------------------------------

  toJSON() {
    return {
      personalScale: this.personalScale,
      calibrationK: this.calibrationK,
      calibratedAt: this.calibratedAt,
      calibrationSamples: this.calibrationSamples,
      calibrationDistanceM: this.calibrationDistanceM,
      cadenceRatio: this.cadenceRatio,
      cadenceRatioSteps: this.cadenceRatioSteps,
    };
  }

  fromJSON(obj) {
    if (!obj || typeof obj !== "object") return;
    const s = Number(obj.personalScale);
    if (Number.isFinite(s) && s >= this.cfg.MIN_PERSONAL_SCALE && s <= this.cfg.MAX_PERSONAL_SCALE) {
      this.personalScale = s;
    }
    const k = Number(obj.calibrationK);
    this.calibrationK = Number.isFinite(k) && k > 0 ? k : null;
    this.calibratedAt = obj.calibratedAt ?? null;
    this.calibrationSamples = obj.calibrationSamples ?? 0;
    this.calibrationDistanceM = obj.calibrationDistanceM ?? 0;
    const cr = Number(obj.cadenceRatio);
    if (obj.cadenceRatio != null && Number.isFinite(cr) && cr >= 0.5 && cr <= 2) {
      this.cadenceRatio = cr;
      this.cadenceRatioSteps = Number(obj.cadenceRatioSteps) || 0;
    }
  }

  async save() {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      return true;
    } catch (err) {
      console.warn("[StepLengthModel] save failed:", err);
      return false;
    }
  }

  async load() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) this.fromJSON(JSON.parse(raw));
      return true;
    } catch (err) {
      console.warn("[StepLengthModel] load failed:", err);
      return false;
    }
  }
}

/** Shared instance used by the app's step detector. */
export const stepLengthModel = new StepLengthModel();
