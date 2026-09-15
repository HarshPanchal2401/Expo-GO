// ============================================================================
// BLE SCANNER & DISTANCE FILTER CONFIGURATION
// Multi-Stage Processing Pipeline:
// 1. Outlier Gating: Discards corrupted/unphysical RSSI values outside [-105, -15] dBm.
// 2. Rolling Median Filter: 5-sample window strips channel-hopping noise (ch 37/38/39).
// 3. One-Euro Adaptive Low-Pass Filter: Suppresses jitter at rest (0.35 Hz) with 0-lag tracking on movement.
// 4. Asymmetric dBm EMA: Smooths signal drops (body occlusion) more heavily than signal gains.
// 5. Log-Distance Path Loss: Converts filtered dBm to physical distance in meters.
// 6. Kinematic Slew-Rate Limiter: Restricts maximum displacement per tick to human walking speed (~1.6 m/s).
// 7. Stationary Hysteresis Dead-Zone: Locks distance output when micro-fluctuations occur at rest.
// ============================================================================

/** Number of initial packets required before locking initial distance estimate */
export const INITIAL_SAMPLE_SIZE = 3;

/** Rolling buffer size for median filtering (eliminates advertising channel-hopping spikes) */
export const MEDIAN_WINDOW = 5;

/** UI & state update interval in milliseconds (50ms = 20 FPS refresh rate) */
export const UI_UPDATE_INTERVAL_MS = 50;

/** Maximum allowed physical distance change (meters) per 50ms tick when stationary (~1.6 m/s max) */
export const STATIONARY_STEP_LIMIT = 0.08;

/** Maximum allowed physical distance change (meters) per 50ms tick during active movement */
export const MOVING_STEP_LIMIT = 0.15;

/** Hysteresis dead-band threshold (meters) to suppress numeric flickering at rest */
export const DEAD_ZONE = 0.15;

/** Speed reaction multiplier when distance is decreasing (approaching beacon) */
export const APPROACH_SENSITIVITY = 1.25;

/** Damping multiplier when distance is increasing (guards against human body shadowing dips) */
export const AWAY_SENSITIVITY = 1.05;

/** One-Euro baseline cutoff frequency (Hz). Lower = smoother at rest (eliminates stationary jitter) */
export const ONE_EURO_MIN_CUTOFF = 0.35;

/** One-Euro speed responsiveness factor (beta). Higher = faster response to sudden movements */
export const ONE_EURO_BETA = 0.06;

/** Default measured RSSI at exactly 1 meter distance (dBm) for calibration */
export const DEFAULT_TX_POWER = -59;

/** Default path loss exponent (n) for indoor multi-path environment (typically 2.0 to 2.8) */
export const DEFAULT_ENV_N = 2.2;
// ============================================================================

import { Platform, PermissionsAndroid, Alert, Linking, NativeModules } from "react-native";
import { getAppSettings } from "./appSettingsStorage.js";

let BleManager = null;
try {
  const bleModule = require("react-native-ble-plx");
  BleManager = bleModule.BleManager;
} catch (e) {
  console.warn("react-native-ble-plx could not be loaded:", e);
}

// Singleton BLE manager instance
let bleManagerInstance = null;
let bleInitError = null;

/**
 * Checks if native Bluetooth LE scanning is supported in the current runtime.
 */
export function isBleSupported() {
  return !!(
    BleManager &&
    (NativeModules.BleClientModule || NativeModules.BleClient || NativeModules.RNBLE)
  );
}

/**
 * Retrieves or lazily creates the singleton BleManager instance.
 */
export function getBleManager() {
  if (bleInitError) return null;
  if (!bleManagerInstance) {
    if (!BleManager) {
      bleInitError = "BLE module not loaded";
      return null;
    }
    try {
      bleManagerInstance = new BleManager();
    } catch (err) {
      console.warn("Failed to instantiate BleManager (Expo Go does not support native BLE without custom build):", err);
      bleInitError = err;
      return null;
    }
  }
  return bleManagerInstance;
}

/**
 * Helper to decode base64 string to a raw byte array
 */
export function base64ToBytes(base64) {
  if (!base64 || typeof base64 !== "string") return [];
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let bytes = [];
  let str = base64.replace(/=+$/, "");
  for (
    let bc = 0, bs = 0, buffer, idx = 0;
    (buffer = str.charAt(idx++));
    ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
      ? bytes.push(255 & (bs >> ((-2 * bc) & 6)))
      : 0
  ) {
    buffer = chars.indexOf(buffer);
  }
  return bytes;
}

/**
 * Parses Apple iBeacon and Eddystone advertising packets from BLE payload
 */
export function parseBeaconPayload(manufacturerDataBase64, serviceData, localName) {
  const result = {
    isBeacon: false,
    beaconType: null, // "iBeacon" | "Eddystone"
    uuid: null,
    major: null,
    minor: null,
    calibratedTxPower: null,
    displayName: localName || null,
  };

  if (manufacturerDataBase64) {
    try {
      const bytes = base64ToBytes(manufacturerDataBase64);

      // Standard Apple iBeacon: Length >= 25, starts with 0x4C 0x00 0x02 0x15
      if (bytes.length >= 25 && bytes[0] === 0x4c && bytes[1] === 0x00 && bytes[2] === 0x02 && bytes[3] === 0x15) {
        let hex = [];
        for (let i = 0; i < 16; i++) {
          hex.push((bytes[4 + i] || 0).toString(16).padStart(2, "0").toUpperCase());
        }
        const uuid = `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
        const major = ((bytes[20] || 0) << 8) | (bytes[21] || 0);
        const minor = ((bytes[22] || 0) << 8) | (bytes[23] || 0);
        const rawTx = bytes[24] !== undefined ? bytes[24] : 197;
        const tx = rawTx < 128 ? rawTx : rawTx - 256;

        result.isBeacon = true;
        result.beaconType = "iBeacon";
        result.uuid = uuid;
        result.major = major;
        result.minor = minor;
        result.calibratedTxPower = tx;
        result.displayName = localName || `iBeacon (M:${major} m:${minor})`;
      } else if (bytes.length >= 23 && bytes[0] === 0x02 && bytes[1] === 0x15) {
        // iBeacon without Company ID: starts with 0x02 0x15
        let hex = [];
        for (let i = 0; i < 16; i++) {
          hex.push((bytes[2 + i] || 0).toString(16).padStart(2, "0").toUpperCase());
        }
        const uuid = `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
        const major = ((bytes[18] || 0) << 8) | (bytes[19] || 0);
        const minor = ((bytes[20] || 0) << 8) | (bytes[21] || 0);
        const rawTx = bytes[22] !== undefined ? bytes[22] : 197;
        const tx = rawTx < 128 ? rawTx : rawTx - 256;

        result.isBeacon = true;
        result.beaconType = "iBeacon";
        result.uuid = uuid;
        result.major = major;
        result.minor = minor;
        result.calibratedTxPower = tx;
        result.displayName = localName || `iBeacon (M:${major} m:${minor})`;
      }
    } catch (e) {
      // ignore
    }
  }

  // Check Eddystone via serviceData
  if (!result.isBeacon && serviceData && typeof serviceData === "object") {
    const keys = Object.keys(serviceData);
    const eddystoneKey = keys.find((k) => k.toLowerCase().includes("feaa"));
    if (eddystoneKey) {
      result.isBeacon = true;
      result.beaconType = "Eddystone";
      result.displayName = localName || "Eddystone Beacon";
    }
  }

  return result;
}

// ============================================================================
// LOW-PASS & ONE-EURO FILTER IMPLEMENTATION
// Reference: Casiez et al., "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input"
// ============================================================================
class LowPassFilter {
  constructor(alpha = 1.0, initVal = 0) {
    this.alpha = alpha;
    this.s = initVal;
    this.initialized = false;
  }

  filter(val, alpha = this.alpha) {
    if (!this.initialized) {
      this.s = val;
      this.initialized = true;
      return val;
    }
    this.s = alpha * val + (1.0 - alpha) * this.s;
    return this.s;
  }

  last() {
    return this.s;
  }

  reset() {
    this.initialized = false;
  }
}

/**
 * Adaptive One-Euro Filter
 * Dynamically adjusts cutoff frequency based on input signal rate of change (derivative).
 */
export class OneEuroFilter {
  constructor(minCutoff = ONE_EURO_MIN_CUTOFF, beta = ONE_EURO_BETA, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter(1);
    this.dxFilter = new LowPassFilter(1);
    this.lastTime = null;
  }

  alpha(cutoff, dt) {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(val, timestamp = Date.now(), betaOverride = null, minCutoffOverride = null) {
    if (this.lastTime === null) {
      this.lastTime = timestamp;
      this.xFilter.filter(val);
      this.dxFilter.filter(0);
      return val;
    }

    const dt = Math.max(0.001, (timestamp - this.lastTime) / 1000.0);
    this.lastTime = timestamp;

    const prevX = this.xFilter.last();
    const dx = (val - prevX) / dt;
    const edx = this.dxFilter.filter(dx, this.alpha(this.dCutoff, dt));

    const curBeta = betaOverride !== null ? betaOverride : this.beta;
    const curMinCutoff = minCutoffOverride !== null ? minCutoffOverride : this.minCutoff;

    const cutoff = curMinCutoff + curBeta * Math.abs(edx);
    return this.xFilter.filter(val, this.alpha(cutoff, dt));
  }

  reset() {
    this.lastTime = null;
    this.xFilter.reset();
    this.dxFilter.reset();
  }
}

// ============================================================================
// PER-DEVICE FAST & SMOOTH DISTANCE TRACKER
// Manages the complete signal filtering lifecycle for an individual BLE beacon.
// ============================================================================
export class DeviceDistanceTracker {
  constructor(deviceId, txPower = DEFAULT_TX_POWER, envN = DEFAULT_ENV_N) {
    this.deviceId = deviceId;
    this.txPower = txPower;
    this.envN = envN;

    this.initialSamples = [];
    this.rollingWindow = [];
    this.recentDistances = [];
    this.isLocked = false;

    this.oneEuro = new OneEuroFilter(ONE_EURO_MIN_CUTOFF, ONE_EURO_BETA);

    this.rawRssi = null;
    this.filteredRssi = null;
    this.targetDistance = null;
    this.currentDistance = null;
    this.trend = "stationary"; // "approaching" | "stationary" | "moving_away"
    this.lastPacketTime = Date.now();
  }

  updateParams(txPower, envN) {
    this.txPower = txPower;
    this.envN = envN;
    if (this.filteredRssi !== null) {
      this.targetDistance = this.rssiToDistance(this.filteredRssi);
    }
  }

  rssiToDistance(rssi) {
    if (!rssi || rssi === 0) return null;
    const settings = getAppSettings();
    const tx = this.txPower || settings.txPower || DEFAULT_TX_POWER;
    const n = this.envN || settings.pathLossN || DEFAULT_ENV_N;
    const ratio = (tx - rssi) / (10 * Math.max(1.0, n));
    const rawMeters = Math.pow(10, ratio);

    // Near-field smooth touch curve (eliminates 18-21cm floor)
    if (settings.nearFieldCorrectionOn) {
      const satRssi = settings.nearFieldSaturationRssi || -43;
      if (rssi >= satRssi) {
        return 0.0;
      }
      const nearFieldStart = -50; // zone where proximity touch curve takes effect
      if (rssi > nearFieldStart) {
        // Smoothly blend from rawMeters down to 0 as RSSI approaches satRssi
        const factor = (satRssi - rssi) / (satRssi - nearFieldStart);
        return rawMeters * Math.max(0, Math.min(1, factor));
      }
    }

    return rawMeters;
  }


  addPacket(rawRssi, timestamp = Date.now()) {
    if (typeof rawRssi !== "number" || isNaN(rawRssi)) return;

    // Gated outlier rejection for impossible BLE RSSI values (close contact can reach -8 to -14 dBm)
    if (rawRssi < -105 || rawRssi > -5) return;

    this.rawRssi = rawRssi;
    this.lastPacketTime = timestamp;

    // ------------------------------------------------------------------------
    // PHASE 1: Fast Initial Lock (Show instant estimate on packet #1 & #2)
    // ------------------------------------------------------------------------
    if (!this.isLocked) {
      this.initialSamples.push(rawRssi);
      this.rollingWindow.push(rawRssi);

      const initDist = this.rssiToDistance(rawRssi);
      this.targetDistance = initDist;
      if (this.currentDistance === null) {
        this.currentDistance = initDist;
        this.recentDistances = [initDist];
      }
      this.filteredRssi = rawRssi;

      if (this.initialSamples.length >= INITIAL_SAMPLE_SIZE) {
        const sorted = [...this.initialSamples].sort((a, b) => a - b);
        const medianRssi = sorted[Math.floor(sorted.length / 2)];
        this.filteredRssi = medianRssi;
        this.oneEuro.filter(medianRssi, timestamp);
        const refinedDist = this.rssiToDistance(medianRssi);
        this.targetDistance = refinedDist;
        this.currentDistance = refinedDist;
        this.recentDistances = [refinedDist];
        this.isLocked = true;
      }
      return;
    }

    // ------------------------------------------------------------------------
    // PHASE 2: Tracking Mode (Rolling Median + One-Euro Filter + Asymmetric EMA)
    // ------------------------------------------------------------------------
    this.rollingWindow.push(rawRssi);
    if (this.rollingWindow.length > MEDIAN_WINDOW) {
      this.rollingWindow.shift();
    }

    // 1. Median filter to eliminate single-packet spikes & channel-hopping jitter
    const sortedWindow = [...this.rollingWindow].sort((a, b) => a - b);
    const medianWindowRssi = sortedWindow[Math.floor(sortedWindow.length / 2)];

    // 2. Measure local variance to detect stationarity
    const mean = this.rollingWindow.reduce((acc, v) => acc + v, 0) / this.rollingWindow.length;
    const variance = this.rollingWindow.reduce((acc, v) => acc + (v - mean) ** 2, 0) / this.rollingWindow.length;
    const isQuiet = variance < 2.0; // stdDev < 1.4 dBm

    // 3. Adaptive One-Euro tuning based on trend & variance
    let beta = ONE_EURO_BETA;
    let minCutoff = ONE_EURO_MIN_CUTOFF;

    if (this.trend === "approaching") {
      beta *= APPROACH_SENSITIVITY;
      minCutoff *= 1.4;
    } else if (this.trend === "moving_away") {
      beta *= AWAY_SENSITIVITY;
      minCutoff *= 1.1;
    } else if (isQuiet) {
      // Stationary: clamp low cutoff for zero jitter
      minCutoff = 0.20;
    }

    const oneEuroVal = this.oneEuro.filter(medianWindowRssi, timestamp, beta, minCutoff);

    // 4. Asymmetric blending in dBm domain
    // (Body occlusion causes artificial RSSI drops; filter drops more heavily than signal increases)
    if (this.filteredRssi === null) {
      this.filteredRssi = oneEuroVal;
    } else {
      const alpha = oneEuroVal > this.filteredRssi ? 0.35 : 0.20;
      this.filteredRssi = alpha * oneEuroVal + (1.0 - alpha) * this.filteredRssi;
    }

    this.targetDistance = this.rssiToDistance(this.filteredRssi);

    // Update movement trend
    this.updateTrend(this.targetDistance);
  }

  updateTrend(newTargetDist) {
    if (newTargetDist === null) return;
    this.recentDistances.push(newTargetDist);
    if (this.recentDistances.length > 5) {
      this.recentDistances.shift();
    }

    if (this.recentDistances.length < 2) {
      this.trend = "stationary";
      return;
    }

    const first = this.recentDistances[0];
    const last = this.recentDistances[this.recentDistances.length - 1];
    const diff = last - first;

    if (diff < -0.25) {
      this.trend = "approaching";
    } else if (diff > 0.30) {
      this.trend = "moving_away";
    } else {
      this.trend = "stationary";
    }
  }

  // --------------------------------------------------------------------------
  // Kinematic Rate Limiter & Hysteresis Dead Zone Step (Smooth & Continuous)
  // --------------------------------------------------------------------------
  stepDistance() {
    if (this.targetDistance === null) return null;
    if (this.currentDistance === null) {
      this.currentDistance = this.targetDistance;
      return Number(this.currentDistance.toFixed(2));
    }

    const diff = this.targetDistance - this.currentDistance;
    const absDiff = Math.abs(diff);

    // If within 2 cm of target, smoothly lock directly onto target
    if (absDiff <= 0.02) {
      this.currentDistance = this.targetDistance;
      const finalDist = Number(this.currentDistance.toFixed(2));
      if (!this.distanceHistory) this.distanceHistory = [];
      this.distanceHistory.push(finalDist);
      if (this.distanceHistory.length > 20) this.distanceHistory.shift();
      return finalDist;
    }

    // Adaptive step limit (kinematic walking speed limit)
    let stepLimit;
    if (this.trend === "approaching") {
      stepLimit = MOVING_STEP_LIMIT * APPROACH_SENSITIVITY;
    } else if (this.trend === "moving_away") {
      stepLimit = MOVING_STEP_LIMIT * AWAY_SENSITIVITY;
    } else {
      stepLimit = STATIONARY_STEP_LIMIT;
    }

    // Smooth proportional easing with kinematic ceiling
    const dynamicStep = Math.min(stepLimit, Math.max(0.015, absDiff * 0.25));
    const step = Math.sign(diff) * Math.min(absDiff, dynamicStep);
    this.currentDistance += step;

    const roundedDist = Number(this.currentDistance.toFixed(2));
    
    // Maintain distance history for live chart (last 20 points)
    if (!this.distanceHistory) this.distanceHistory = [];
    this.distanceHistory.push(roundedDist);
    if (this.distanceHistory.length > 20) {
      this.distanceHistory.shift();
    }

    return roundedDist;
  }

  getState() {
    return {
      isLocked: this.isLocked,
      sampleCount: this.initialSamples.length,
      rawRssi: this.rawRssi,
      filteredRssi: this.filteredRssi !== null ? Math.round(this.filteredRssi) : this.rawRssi,
      distance: this.currentDistance !== null ? Number(this.currentDistance.toFixed(2)) : null,
      targetDistance: this.targetDistance !== null ? Number(this.targetDistance.toFixed(2)) : null,
      trend: this.trend,
      lastSeen: this.lastPacketTime,
      distanceHistory: this.distanceHistory || []
    };
  }

  reset() {
    this.initialSamples = [];
    this.rollingWindow = [];
    this.recentDistances = [];
    this.distanceHistory = [];
    this.isLocked = false;
    this.oneEuro.reset();
    this.rawRssi = null;
    this.filteredRssi = null;
    this.targetDistance = null;
    this.currentDistance = null;
    this.trend = "stationary";
  }
}

/**
 * Calculates raw estimated physical distance (in meters) from RSSI
 */
export function calculateDistance(rssi, measuredPower = null, pathLossExponent = null) {
  if (!rssi || rssi === 0) return null;
  const settings = getAppSettings();
  const tx = measuredPower !== null ? measuredPower : (settings.txPower || DEFAULT_TX_POWER);
  const n = pathLossExponent !== null ? pathLossExponent : (settings.pathLossN || DEFAULT_ENV_N);
  const ratio = (tx - rssi) / (10 * Math.max(1.0, n));
  let dist = Math.pow(10, ratio);

  // Near-field smooth touch curve (eliminates 18-21cm floor)
  if (settings.nearFieldCorrectionOn) {
    const satRssi = settings.nearFieldSaturationRssi || -43;
    if (rssi >= satRssi) return 0.0;
    if (rssi > -50) {
      const factor = (satRssi - rssi) / (satRssi - (-50));
      dist = dist * Math.max(0, Math.min(1, factor));
    }
  }

  return Number(dist.toFixed(2));
}


/**
 * Converts distance in meters to target unit ('m' | 'ft' | 'in')
 */
export function convertMeters(meters, unit = "m") {
  if (meters === null || meters === undefined || isNaN(meters)) return null;
  if (unit === "ft") {
    return Number((meters * 3.28084).toFixed(2));
  }
  if (unit === "in") {
    return Number((meters * 39.3701).toFixed(1));
  }
  return Number(meters.toFixed(2));
}

/**
 * Formats distance in meters according to selected unit
 */
export function formatDistance(meters, unit = "m") {
  const label = unit === "ft" ? "feet" : unit === "in" ? "inches" : "meters";
  if (meters === null || meters === undefined || isNaN(meters)) {
    return { value: "--", unit, label };
  }
  if (unit === "ft") {
    return { value: (meters * 3.28084).toFixed(2), unit: "ft", label };
  }
  if (unit === "in") {
    return { value: (meters * 39.3701).toFixed(1), unit: "in", label };
  }
  return { value: meters.toFixed(2), unit: "m", label };
}

/**
 * Returns formatted distance strings in all three units simultaneously
 */
export function getDistanceConversions(meters) {
  if (meters === null || meters === undefined || isNaN(meters)) {
    return { m: "--", ft: "--", in: "--" };
  }
  return {
    m: `${meters.toFixed(2)} m`,
    ft: `${(meters * 3.28084).toFixed(2)} ft`,
    in: `${(meters * 39.3701).toFixed(1)} in`,
  };
}



/**
 * Categorize RSSI into human readable signal quality and color scheme
 */
export function getSignalQuality(rssi) {
  if (rssi >= -60) {
    return { label: "Excellent", color: "#1a7f37", bg: "#dafbe1", percentage: 100 };
  } else if (rssi >= -72) {
    return { label: "Good", color: "#0969da", bg: "#ddf4ff", percentage: 75 };
  } else if (rssi >= -85) {
    return { label: "Fair", color: "#d29922", bg: "#fff8c5", percentage: 45 };
  } else {
    return { label: "Weak", color: "#cf222e", bg: "#ffebe9", percentage: 20 };
  }
}

/**
 * Request all necessary Bluetooth and Location permissions across Android versions
 */
export async function requestBluetoothPermissions() {
  if (Platform.OS === "android") {
    const apiLevel = Platform.Version;

    // Android 12+ (API level 31+)
    if (apiLevel >= 31) {
      try {
        const scanCheck = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
        const connectCheck = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
        const fineCheck = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
        const coarseCheck = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);

        if (scanCheck && connectCheck && (fineCheck || coarseCheck)) {
          return true;
        }

        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);

        const scanGranted = granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED || scanCheck;
        const connectGranted = granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED || connectCheck;
        const locationGranted = granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED || fineCheck || coarseCheck;

        return scanGranted && connectGranted && locationGranted;
      } catch (e) {
        console.warn("Permission check error:", e);
        return false;
      }
    } else {
      // Android < 12 requires Location permission to scan for BLE beacons
      try {
        const fineCheck = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
        const coarseCheck = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);
        if (fineCheck || coarseCheck) return true;

        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ]);

        const fineGranted = granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
        const coarseGranted = granted[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;

        return fineGranted || coarseGranted;
      } catch (e) {
        console.warn("Permission check error:", e);
        return false;
      }
    }
  }

  // iOS permissions are handled automatically via Info.plist dialog upon initial BLE call
  return true;
}

/**
 * Prompt user to enable Bluetooth adapter if it's currently powered off
 */
export async function ensureBluetoothEnabled() {
  const manager = getBleManager();
  if (!manager) return false;
  try {
    let state = await manager.state();

    // If adapter is starting up, wait up to 1.5s for state to settle
    if (state === "Unknown" || state === "Resetting") {
      state = await new Promise((resolve) => {
        let resolved = false;
        const sub = manager.onStateChange((newState) => {
          if (newState !== "Unknown" && newState !== "Resetting" && !resolved) {
            resolved = true;
            sub?.remove?.();
            resolve(newState);
          }
        }, true);
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            sub?.remove?.();
            resolve(state);
          }
        }, 1500);
      });
    }

    if (state === "PoweredOff") {
      return new Promise((resolve) => {
        Alert.alert(
          "Bluetooth is Turned Off",
          "Bluetooth is required to scan for nearby BLE beacons and estimate distance. Would you like to turn it on now?",
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            {
              text: "Turn On",
              onPress: async () => {
                try {
                  if (Platform.OS === "android" && manager.enable) {
                    await manager.enable();
                    resolve(true);
                  } else {
                    Linking.openSettings();
                    resolve(false);
                  }
                } catch (e) {
                  Linking.openSettings();
                  resolve(false);
                }
              },
            },
          ]
        );
      });
    }
    return state === "PoweredOn";
  } catch (err) {
    console.warn("Error checking Bluetooth state:", err);
    return false;
  }
}
