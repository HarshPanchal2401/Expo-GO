// ============================================================================
// APP SETTINGS STORAGE
// Centralized, persistent configuration storage for all app tuning parameters.
// Allows configuring PDR, BLE filters, near-field curves, and room size
// directly inside the app without rebuilding or committing code.
// ============================================================================

let AsyncStorage = null;
try {
  const mod = require("@react-native-async-storage/async-storage");
  AsyncStorage = mod.default || mod;
} catch (e) {
  console.log("[AppSettingsStorage] Native AsyncStorage not available, using memory fallback.");
}

const STORAGE_KEY = "@app_config_settings_v2";

export const DEFAULT_APP_SETTINGS = {
  // ─── BLE Distance & Filtering ─────────────────────────────────────────────
  txPower: -59,                    // Measured RSSI at 1 meter (dBm)
  // 2.9 = furnished indoor office. 2.0 is free space and 2.2 is an open
  // corridor; using either indoors inflates every reported distance by more
  // than 2x at 10 m, because n is the exponent that sets the whole distance
  // scale. See DEFAULT_PATH_LOSS_N in AdaptiveBeaconEngine.js.
  pathLossN: 2.9,                  // Environmental path loss exponent n (typically 1.8 - 3.5)
  deadZone: 0.03,                  // Hysteresis dead-band (meters) — 0.03m avoids freezing offset
  oneEuroMinCutoff: 0.35,          // Baseline One-Euro cutoff frequency (Hz)
  oneEuroBeta: 0.06,               // One-Euro speed responsiveness factor
  medianWindow: 5,                 // Rolling median sample window (strips channel hopping)
  distanceUnit: "m",               // Default distance display unit: "m" | "ft" | "in"

  // ─── Near-Field / 0 cm Touch Correction ───────────────────────────────────
  nearFieldCorrectionOn: true,     // Enable smooth near-field curve to eliminate 18-21cm floor
  enableNearFieldCurve: true,      // Alias for nearFieldCorrectionOn
  nearFieldSaturationRssi: -43,    // Phone BLE hardware saturation threshold at 0 cm (dBm)

  // ─── PDR & Step Detector ──────────────────────────────────────────────────
  motionEngine: "v2",              // "v2" (MotionEngine.js) | "classic" step detector
  particleFilter: true,            // map matching while navigating (ParticleFilter.js)
  stepShakeFilter: true,           // Refuse phone shakes as steps (services/StepGate.js)
  weinbergK: 0.74,                 // Weinberg dynamic step length coefficient (0.50 - 1.20)
  zuptVariance: 0.0008,            // ZUPT stationary gate (g²) — sensitive for natural handheld walking
  peakThreshold: 0.04,             // Accelerometer heel-strike peak threshold (g)
  valleyThreshold: -0.02,          // Accelerometer swing-phase valley threshold (g)
  bounceDiffMin: 0.06,             // Minimum peak-valley bounce amplitude (g)
  minCadenceMs: 240,               // Fastest allowable step cadence (~4.1 steps/sec)
  maxCadenceMs: 1800,              // Slowest allowable step cadence (~0.55 steps/sec)

  // ─── Room & Map Environment ───────────────────────────────────────────────
  roomWidthFt: 18,                 // Room width in feet (X axis)
  roomHeightFt: 15,                // Room height in feet (Y axis)

  // ─── Experimental RTT Ranging ──────────────────────────────────────────────
  rttOffsetNs: 50000.0,            // Hardware/system turnaround delay offset in nanoseconds
  rttAveragingWindow: 5,           // Rolling average filter sample window size
  rttOutlierFilterEnabled: true,   // Enable MAD / Hampel outlier rejection
  groundTruthDistanceM: 1.0,       // Default ground truth benchmark distance in meters
};

// In-memory active cache for immediate synchronous access by high-frequency loops
let cachedSettings = { ...DEFAULT_APP_SETTINGS };
let listeners = new Set();

function normalizeSettings(raw) {
  const s = { ...DEFAULT_APP_SETTINGS, ...(raw || {}) };
  // Keep key aliases in sync
  if (s.enableNearFieldCurve !== undefined && s.nearFieldCorrectionOn === undefined) {
    s.nearFieldCorrectionOn = s.enableNearFieldCurve;
  }
  s.enableNearFieldCurve = !!s.nearFieldCorrectionOn;
  if (s.defaultTxPower !== undefined && s.txPower === undefined) {
    s.txPower = s.defaultTxPower;
  }
  s.defaultTxPower = s.txPower;
  if (s.defaultPathLossN !== undefined && s.pathLossN === undefined) {
    s.pathLossN = s.defaultPathLossN;
  }
  s.defaultPathLossN = s.pathLossN;
  if (s.preferredUnit !== undefined && s.distanceUnit === undefined) {
    s.distanceUnit = s.preferredUnit;
  }
  s.preferredUnit = s.distanceUnit;

  // Sanitize thresholds to ensure old cached high values never block handheld walking
  if (s.peakThreshold > 0.05) s.peakThreshold = 0.04;
  if (s.bounceDiffMin > 0.07) s.bounceDiffMin = 0.06;
  if (s.zuptVariance > 0.0015) s.zuptVariance = 0.0008;

  // One-time correction of the old free-space default. 2.2 shipped as the
  // default for long enough that it is sitting in most installs' storage, and
  // it is far too low for an indoor deployment - it was the single largest
  // contributor to distances reading 2-3x too long. Nobody chose it
  // deliberately, so migrate it once and record that we did, which leaves a
  // deliberately chosen 2.2 alone on every subsequent launch.
  if (!s.pathLossDefaultMigrated) {
    if (!Number.isFinite(s.pathLossN) || Math.abs(s.pathLossN - 2.2) < 1e-6) {
      s.pathLossN = DEFAULT_APP_SETTINGS.pathLossN;
      s.defaultPathLossN = s.pathLossN;
    }
    s.pathLossDefaultMigrated = true;
  }

  return s;
}

/**
 * Returns currently active settings synchronously
 */
export function getAppSettings() {
  return cachedSettings;
}

/**
 * Loads saved settings from AsyncStorage on startup and updates memory cache
 */
export async function loadAppSettings() {
  if (!AsyncStorage || typeof AsyncStorage.getItem !== "function") {
    return cachedSettings;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cachedSettings = normalizeSettings(DEFAULT_APP_SETTINGS);
      return cachedSettings;
    }
    const parsed = JSON.parse(raw);
    cachedSettings = normalizeSettings(parsed);
    notifyListeners();
    return cachedSettings;
  } catch (e) {
    console.warn("[AppSettingsStorage] Error loading settings:", e);
    return cachedSettings;
  }
}

/**
 * Merges updates, saves to AsyncStorage, and updates active memory cache
 */
export async function saveAppSettings(updates) {
  cachedSettings = normalizeSettings({ ...cachedSettings, ...updates });
  notifyListeners();

  if (AsyncStorage && typeof AsyncStorage.setItem === "function") {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cachedSettings));
    } catch (e) {
      console.warn("[AppSettingsStorage] Error saving settings:", e);
    }
  }
  return cachedSettings;
}

/**
 * Resets all settings back to factory defaults
 */
export async function resetAppSettings() {
  cachedSettings = normalizeSettings(DEFAULT_APP_SETTINGS);
  notifyListeners();

  if (AsyncStorage && typeof AsyncStorage.removeItem === "function") {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn("[AppSettingsStorage] Error resetting settings:", e);
    }
  }
  return cachedSettings;
}

/**
 * Subscribe to settings changes for live hot-reloading
 */
export function subscribeAppSettings(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners() {
  listeners.forEach((fn) => {
    try {
      fn(cachedSettings);
    } catch (e) {
      console.warn("[AppSettingsStorage] listener error:", e);
    }
  });
}

// Initial load on import
loadAppSettings();
