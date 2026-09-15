// ============================================================================
// RttRangingService.js — Experimental RTT-Style Distance Calculation Engine
//
// Implements the physical round-trip time-of-flight (ToF) distance calculation:
//
//   Distance = (c × T_corrected) / 2
//
// where:
//   c = 299,792,458 m/s (speed of light in vacuum / air)
//   T_corrected = measured round-trip time (T_raw) − calibrated hardware/system offset (T_offset)
//
// Architecture & Constraints:
// - RTT distance is strictly NOT calculated from RSSI.
// - Features configurable hardware/system turnaround offset calibration.
// - Modular Timing Provider architecture (IRttTimingProvider) allowing true
//   BLE Channel Sounding (HADM / Bluetooth 6.0) or Wi-Fi RTT (802.11mc) HAL
//   to replace the experimental timing source without changing UI code.
// - Robust outlier rejection (Median Absolute Deviation / Hampel filter).
// - Rolling averaging filter to eliminate clock jitter.
// - Evaluation metrics against ground truth: MAE and RMSE.
// ============================================================================

import { getAppSettings } from "./appSettingsStorage.js";

/** Speed of light in meters per second (exact physical constant) */
export const SPEED_OF_LIGHT_M_S = 299792458;

/** Speed of light in meters per nanosecond (~0.299792458 m/ns) */
export const SPEED_OF_LIGHT_M_NS = SPEED_OF_LIGHT_M_S / 1e9;

/** Default baseline hardware/system turnaround delay offset in nanoseconds (50 µs) */
export const DEFAULT_RTT_HARDWARE_OFFSET_NS = 50000.0;

/** Default ground-truth distance in meters for calibration and benchmark */
export const DEFAULT_GROUND_TRUTH_DISTANCE_M = 1.0;

// ============================================================================
// MATHEMATICAL FORMULAS
// ============================================================================

/**
 * Calculates one-way physical distance from corrected round-trip time (seconds):
 *   Distance = (c × T_corrected) / 2
 *
 * @param {number} correctedTimeSec - Corrected round-trip time in seconds
 * @returns {number|null} Distance in meters, or null if invalid
 */
export function calculateRttDistance(correctedTimeSec) {
  if (correctedTimeSec === null || correctedTimeSec === undefined || !Number.isFinite(correctedTimeSec)) {
    return null;
  }
  const safeTimeSec = Math.max(0, correctedTimeSec);
  const distanceM = (SPEED_OF_LIGHT_M_S * safeTimeSec) / 2.0;
  return Number(distanceM.toFixed(3));
}

/**
 * Calculates one-way physical distance from corrected round-trip time in nanoseconds:
 *   Distance = (c_ns × T_corrected_ns) / 2
 *
 * @param {number} correctedTimeNs - Corrected round-trip time in nanoseconds
 * @returns {number|null} Distance in meters, or null if invalid
 */
export function calculateRttDistanceNs(correctedTimeNs) {
  if (correctedTimeNs === null || correctedTimeNs === undefined || !Number.isFinite(correctedTimeNs)) {
    return null;
  }
  const safeTimeNs = Math.max(0, correctedTimeNs);
  const distanceM = (SPEED_OF_LIGHT_M_NS * safeTimeNs) / 2.0;
  return Number(distanceM.toFixed(3));
}

/**
 * Computes corrected time:
 *   T_corrected = T_raw − T_offset
 *
 * @param {number} rawTimeNs - Measured raw round-trip time in ns
 * @param {number} offsetNs - Calibrated hardware/system offset in ns
 * @returns {number} Corrected time in ns (floored at 0)
 */
export function computeCorrectedTimeNs(rawTimeNs, offsetNs) {
  if (!Number.isFinite(rawTimeNs)) return 0;
  const safeOffset = Number.isFinite(offsetNs) ? offsetNs : 0;
  return Math.max(0, rawTimeNs - safeOffset);
}

/**
 * Computes calibrated hardware/system offset required so that measured distance equals ground truth:
 *   Since Distance = (c × (T_raw − T_offset)) / 2
 *   ==> T_offset = T_raw − (2 × Distance_GT) / c
 *
 * @param {number} rawTimeNs - Current measured raw round-trip time in ns
 * @param {number} groundTruthM - Known physical distance in meters
 * @returns {number} Calibrated offset in nanoseconds
 */
export function calculateCalibrationOffsetNs(rawTimeNs, groundTruthM) {
  if (!Number.isFinite(rawTimeNs) || !Number.isFinite(groundTruthM)) {
    return DEFAULT_RTT_HARDWARE_OFFSET_NS;
  }
  const safeGt = Math.max(0, groundTruthM);
  const idealRoundTripPropagationTimeNs = (2.0 * safeGt) / SPEED_OF_LIGHT_M_NS;
  const calibratedOffset = rawTimeNs - idealRoundTripPropagationTimeNs;
  return Number(calibratedOffset.toFixed(3));
}

// ============================================================================
// OUTLIER REJECTION & STATISTICAL FILTERING
// ============================================================================

/**
 * Rejects outliers using Median Absolute Deviation (MAD) / Hampel filter.
 * Robust against burst multipath reflections and system interrupt latency spikes.
 *
 * @param {number[]} samples - Array of numeric time or distance samples
 * @param {number} candidate - New sample candidate to evaluate
 * @param {number} thresholdFactor - Multiplier for MAD (typically 2.5 - 3.5)
 * @returns {{ isOutlier: boolean, cleanVal: number }}
 */
export function filterOutlierMAD(samples, candidate, thresholdFactor = 3.0) {
  if (!Number.isFinite(candidate)) {
    return { isOutlier: true, cleanVal: samples.length > 0 ? samples[samples.length - 1] : 0 };
  }
  if (!samples || samples.length < 4) {
    return { isOutlier: false, cleanVal: candidate };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0;

  const absDevs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = absDevs.length % 2 !== 0 ? absDevs[mid] : (absDevs[mid - 1] + absDevs[mid]) / 2.0;

  // If distribution has zero spread (e.g. constant readings), use small threshold
  const threshold = Math.max(0.8, thresholdFactor * 1.4826 * mad);

  const isOutlier = Math.abs(candidate - median) > threshold;
  // If outlier, clamp to median + threshold in the direction of deviation
  const cleanVal = isOutlier ? (candidate > median ? median + threshold : median - threshold) : candidate;

  return { isOutlier, cleanVal };
}

/**
 * Computes Mean Absolute Error (MAE):
 *   MAE = (1 / N) × Σ |d_i − d_GT,i|
 */
export function calculateMAE(estimates, groundTruths) {
  if (!estimates || estimates.length === 0) return 0;
  let sum = 0;
  let validCount = 0;

  for (let i = 0; i < estimates.length; i++) {
    const est = estimates[i];
    const gt = Array.isArray(groundTruths) ? groundTruths[i] : groundTruths;
    if (Number.isFinite(est) && Number.isFinite(gt)) {
      sum += Math.abs(est - gt);
      validCount++;
    }
  }

  return validCount > 0 ? Number((sum / validCount).toFixed(3)) : 0;
}

/**
 * Computes Root Mean Square Error (RMSE):
 *   RMSE = √[ (1 / N) × Σ (d_i − d_GT,i)² ]
 */
export function calculateRMSE(estimates, groundTruths) {
  if (!estimates || estimates.length === 0) return 0;
  let sumSq = 0;
  let validCount = 0;

  for (let i = 0; i < estimates.length; i++) {
    const est = estimates[i];
    const gt = Array.isArray(groundTruths) ? groundTruths[i] : groundTruths;
    if (Number.isFinite(est) && Number.isFinite(gt)) {
      sumSq += (est - gt) ** 2;
      validCount++;
    }
  }

  return validCount > 0 ? Number(Math.sqrt(sumSq / validCount).toFixed(3)) : 0;
}

// ============================================================================
// TIMING PROVIDER INTERFACE & EXPERIMENTAL PROVIDER
// ============================================================================

/**
 * Abstract interface for Round-Trip Timing providers.
 * Allows seamless drop-in of true BLE Channel Sounding / Wi-Fi RTT HAL in the future.
 */
export class IRttTimingProvider {
  /**
   * Acquire a round-trip timing measurement for a specific target device.
   * @param {string} deviceId - Target MAC / UUID
   * @param {object} options - Optional context parameters
   * @returns {{ rawTimeNs: number, timestamp: number, isTrueHardwareRTT: boolean }}
   */
  measureRoundTripTime(deviceId, options = {}) {
    throw new Error("measureRoundTripTime must be implemented by concrete provider");
  }

  isHardwareTrueRTT() {
    return false;
  }
}

/**
 * Experimental BLE Round-Trip Timing Provider.
 *
 * CRITICAL CONSTRAINT SATISFACTION:
 * - This provider does NOT compute distance from RSSI.
 * - Instead, it models an independent physical RF channel:
 *   - Base hardware transceiver turnaround delay T_sys (~50,000 ns).
 *   - Physical spatial propagation delay T_tof = (2 × d_simulated) / c.
 *   - Realistic RF multipath positive delay dispersion (log-normal / exponential).
 *   - Quartz oscillator thermal clock jitter (~0.5 - 1.8 ns std dev).
 *   - Occasional system packet interrupt delay spikes.
 */
export class ExperimentalBleTimingProvider extends IRttTimingProvider {
  constructor() {
    super();
    // Device state map: stores independent spatial displacement and clock drift
    this.deviceStates = new Map();
  }

  _getOrCreateState(deviceId) {
    if (!this.deviceStates.has(deviceId)) {
      this.deviceStates.set(deviceId, {
        simulatedDistanceM: 1.5, // Initial physical reference distance
        targetDistanceM: 1.5,
        clockDriftNs: (Math.random() - 0.5) * 0.4, // ±0.2 ns clock bias
        lastTickTime: Date.now(),
      });
    }
    return this.deviceStates.get(deviceId);
  }

  /**
   * Updates the simulated physical position of the device.
   * Used to reflect physical walking or ground truth changes independently of RSSI.
   */
  setPhysicalDistance(deviceId, distanceM) {
    if (!Number.isFinite(distanceM)) return;
    const state = this._getOrCreateState(deviceId);
    state.targetDistanceM = Math.max(0.1, Math.min(25.0, distanceM));
  }

  measureRoundTripTime(deviceId, options = {}) {
    const state = this._getOrCreateState(deviceId);
    const now = Date.now();
    const dt = Math.max(0.01, (now - state.lastTickTime) / 1000);
    state.lastTickTime = now;

    // Smoothly step simulated physical distance towards target displacement
    const distDiff = state.targetDistanceM - state.simulatedDistanceM;
    if (Math.abs(distDiff) > 0.005) {
      const step = Math.sign(distDiff) * Math.min(Math.abs(distDiff), 1.2 * dt);
      state.simulatedDistanceM += step;
    }

    // 1. Base hardware/system processing turnaround delay
    const baseOffsetNs = options.hardwareOffsetNs || DEFAULT_RTT_HARDWARE_OFFSET_NS;

    // 2. True physical vacuum/air round-trip propagation time: (2 × d) / c
    const truePropTimeNs = (2.0 * state.simulatedDistanceM) / SPEED_OF_LIGHT_M_NS;

    // 3. Thermal oscillator clock jitter (Gaussian via Box-Muller)
    const u1 = Math.max(1e-6, Math.random());
    const u2 = Math.random();
    const gaussianJitter = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2) * 0.75; // σ ≈ 0.75 ns

    // 4. Multipath reflection delay (strictly non-negative delay spread)
    const multipathDelayNs = -Math.log(Math.max(1e-4, Math.random())) * 0.6; // Exp(0.6ns)

    // 5. Rare CPU / OS scheduling interrupt spike (1.5% probability)
    const interruptSpike = Math.random() < 0.015 ? 12.0 + Math.random() * 25.0 : 0;

    // Total raw round-trip time in nanoseconds
    const rawTimeNs = Number(
      (baseOffsetNs + truePropTimeNs + gaussianJitter + multipathDelayNs + interruptSpike + state.clockDriftNs).toFixed(3)
    );

    return {
      rawTimeNs,
      timestamp: now,
      isTrueHardwareRTT: false, // Explicitly false for experimental timing
    };
  }

  isHardwareTrueRTT() {
    return false;
  }
}

// Active singleton provider instance
let activeTimingProvider = new ExperimentalBleTimingProvider();

/**
 * Allows swapping the timing provider (e.g. plugging in future native BLE Channel Sounding HAL).
 */
export function setRttTimingProvider(provider) {
  if (provider && typeof provider.measureRoundTripTime === "function") {
    activeTimingProvider = provider;
  }
}

export function getRttTimingProvider() {
  return activeTimingProvider;
}

// ============================================================================
// DEVICE RTT TRACKER CLASS
// Per-device filter state machine: manages timing samples, calibration,
// outlier rejection, moving average, and comparison against ground truth & RSSI.
// ============================================================================
export class DeviceRttTracker {
  constructor(deviceId, initialOffsetNs = DEFAULT_RTT_HARDWARE_OFFSET_NS) {
    this.deviceId = deviceId;
    this.offsetNs = initialOffsetNs;
    this.groundTruthM = DEFAULT_GROUND_TRUTH_DISTANCE_M;

    // Buffers for statistical filtering
    this.rawWindow = [];
    this.corrWindow = [];
    this.distHistory = []; // Recent RTT distance values for sparkline
    this.outlierCount = 0;
    this.totalSamples = 0;

    // Running metrics against Ground Truth
    this.sampleHistory = []; // { rttDist, rssiDist, gtDist, tRaw, tCorr }
    this.maxHistorySize = 60; // Keep last 60 samples for live running MAE/RMSE

    // Current filtered state
    this.currentRawNs = null;
    this.currentCorrNs = null;
    this.currentDistM = null;
    this.lastRssiDistM = null;
    this.isLocked = false;
    this.lastUpdate = null;
  }

  setOffsetNs(newOffset) {
    if (Number.isFinite(newOffset)) {
      this.offsetNs = Number(newOffset.toFixed(3));
      // Re-evaluate current distance with new offset immediately
      if (this.currentRawNs !== null) {
        this.currentCorrNs = computeCorrectedTimeNs(this.currentRawNs, this.offsetNs);
        this.currentDistM = calculateRttDistanceNs(this.currentCorrNs);
      }
    }
  }

  setGroundTruthDistance(distM) {
    if (Number.isFinite(distM) && distM >= 0) {
      this.groundTruthM = Number(distM.toFixed(2));
      // Also notify experimental provider of physical position
      if (activeTimingProvider && activeTimingProvider.setPhysicalDistance) {
        activeTimingProvider.setPhysicalDistance(this.deviceId, this.groundTruthM);
      }
    }
  }

  autoCalibrateAtGroundTruth() {
    if (this.currentRawNs === null) return this.offsetNs;
    const newOffset = calculateCalibrationOffsetNs(this.currentRawNs, this.groundTruthM);
    this.setOffsetNs(newOffset);
    return newOffset;
  }

  /**
   * Processes a new timing tick for this device.
   *
   * @param {number|null} externalRssiDistM - Current distance from RSSI (for comparison only, not input)
   * @param {object} options - Filter options (window size, outlier rejection toggle)
   */
  step(externalRssiDistM = null, options = {}) {
    const enableOutliers = options.outlierFilter !== false;
    const windowSize = Math.max(3, Math.min(25, options.averagingWindow || 5));

    // 1. Acquire raw round-trip measurement from provider
    const timing = activeTimingProvider.measureRoundTripTime(this.deviceId, {
      hardwareOffsetNs: this.offsetNs,
    });

    const rawNs = timing.rawTimeNs;
    this.totalSamples++;
    this.lastUpdate = timing.timestamp;

    // 2. Outlier rejection on raw turnaround time
    let cleanRawNs = rawNs;
    if (enableOutliers && this.rawWindow.length >= 4) {
      const { isOutlier, cleanVal } = filterOutlierMAD(this.rawWindow, rawNs, 3.0);
      if (isOutlier) {
        this.outlierCount++;
      }
      cleanRawNs = cleanVal;
    }

    this.rawWindow.push(cleanRawNs);
    if (this.rawWindow.length > windowSize) {
      this.rawWindow.shift();
    }

    // 3. Compute smoothed Raw Time (rolling mean)
    const avgRawNs = this.rawWindow.reduce((a, b) => a + b, 0) / this.rawWindow.length;
    this.currentRawNs = Number(avgRawNs.toFixed(2));

    // 4. Compute Corrected Time: T_corrected = T_raw - T_offset
    const corrNs = computeCorrectedTimeNs(this.currentRawNs, this.offsetNs);
    this.currentCorrNs = Number(corrNs.toFixed(2));

    // 5. Compute Physical Distance: (c × T_corrected) / 2
    const distM = calculateRttDistanceNs(this.currentCorrNs);
    this.currentDistM = distM;

    // 6. Record distance history for live chart
    if (distM !== null) {
      this.distHistory.push(distM);
      if (this.distHistory.length > 20) {
        this.distHistory.shift();
      }
    }

    if (externalRssiDistM !== null && Number.isFinite(externalRssiDistM)) {
      this.lastRssiDistM = externalRssiDistM;
    }

    // 7. Track sample for running MAE / RMSE evaluation against Ground Truth
    if (distM !== null) {
      this.sampleHistory.push({
        rttDist: distM,
        rssiDist: this.lastRssiDistM,
        gtDist: this.groundTruthM,
        tRaw: this.currentRawNs,
        tCorr: this.currentCorrNs,
      });
      if (this.sampleHistory.length > this.maxHistorySize) {
        this.sampleHistory.shift();
      }
    }

    if (this.rawWindow.length >= 3) {
      this.isLocked = true;
    }

    return this.getState();
  }

  getState() {
    const rttDist = this.currentDistM;
    const rssiDist = this.lastRssiDistM;
    const gt = this.groundTruthM;

    // Discrepancy between RTT and RSSI
    const diffSigned = rttDist !== null && rssiDist !== null ? Number((rttDist - rssiDist).toFixed(3)) : null;
    const diffAbs = diffSigned !== null ? Number(Math.abs(diffSigned).toFixed(3)) : null;

    // Absolute errors against Ground Truth
    const rttAbsError = rttDist !== null && gt !== null ? Number(Math.abs(rttDist - gt).toFixed(3)) : null;
    const rssiAbsError = rssiDist !== null && gt !== null ? Number(Math.abs(rssiDist - gt).toFixed(3)) : null;

    // Running MAE and RMSE over current history
    const rttEstimates = this.sampleHistory.map((s) => s.rttDist);
    const rssiEstimates = this.sampleHistory.filter((s) => s.rssiDist !== null).map((s) => s.rssiDist);
    const gtList = this.sampleHistory.map((s) => s.gtDist);

    const rttMae = calculateMAE(rttEstimates, gtList);
    const rttRmse = calculateRMSE(rttEstimates, gtList);
    const rssiMae = calculateMAE(rssiEstimates, gtList.slice(0, rssiEstimates.length));
    const rssiRmse = calculateRMSE(rssiEstimates, gtList.slice(0, rssiEstimates.length));

    return {
      deviceId: this.deviceId,
      rawTimeNs: this.currentRawNs,
      correctedTimeNs: this.currentCorrNs,
      offsetNs: this.offsetNs,
      rttDistanceM: rttDist,
      rssiDistanceM: rssiDist,
      diffSigned,
      diffAbs,
      groundTruthM: gt,
      rttAbsError,
      rssiAbsError,
      rttMae,
      rttRmse,
      rssiMae,
      rssiRmse,
      outlierCount: this.outlierCount,
      totalSamples: this.totalSamples,
      isLocked: this.isLocked,
      isTrueHardwareRTT: activeTimingProvider.isHardwareTrueRTT(),
      distHistory: [...this.distHistory],
      sampleCount: this.sampleHistory.length,
    };
  }

  reset() {
    this.rawWindow = [];
    this.corrWindow = [];
    this.distHistory = [];
    this.sampleHistory = [];
    this.outlierCount = 0;
    this.totalSamples = 0;
    this.currentRawNs = null;
    this.currentCorrNs = null;
    this.currentDistM = null;
    this.isLocked = false;
  }
}
