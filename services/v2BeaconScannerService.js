// ============================================================================
// V2 BEACON SCANNER SERVICE
// Open multi-beacon scanner & real-time signal analysis laboratory for Version 2.
// Scans ALL nearby Bluetooth beacons and devices, sorts them by RSSI strength.
// The two SELECTED (B1/B2) beacons are filtered entirely by AdaptiveBeaconEngine
// (per-beacon adaptive Kalman filtering + calibrated path loss + kinematic
// plausibility clamp — see AdaptiveBeaconEngine.js). This file only runs a
// lightweight raw log-distance estimate for the ambient/unselected device list.
// ============================================================================

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getBleManager,
  requestBluetoothPermissions,
  ensureBluetoothEnabled,
  parseBeaconPayload,
} from "./BleScannerService.js";
import { adaptiveEngine } from "./AdaptiveBeaconEngine.js";
import { getAppSettings, subscribeAppSettings } from "./appSettingsStorage.js";

const STORAGE_KEY = "@v2_beacon_config_v3";
// Scan watchdog (see _startScanWatchdog).
const SCAN_STALL_MS = 6000;
const SCAN_RESTART_MIN_MS = 7000;

export const DEFAULT_V2_CONFIG = {
  beacon1Id: null, // Hardware MAC address (device.id)
  beacon1Name: "Beacon 1",
  beacon2Id: null, // Hardware MAC address (device.id)
  beacon2Name: "Beacon 2",
  beacon1TxPower: -59,
  beacon2TxPower: -59,
  pathLossN: 2.9, // indoor office; see DEFAULT_PATH_LOSS_N in AdaptiveBeaconEngine.js
  distanceUnit: "m", // 'm' | 'ft' | 'in'
  targetBeaconsOnly: true, // When true and B1/B2 are set, drops all other ambient BLE devices to eliminate phone CPU load
  beaconHeightM: null, // Ceiling/wall mount height in metres; null = same height as phone (no correction)
  phoneHeightM: 1.1,
};

// ============================================================================
// LIGHTWEIGHT DISTANCE ESTIMATE (ambient/unselected device list only)
// ============================================================================

/**
 * Calibrated Log-Distance Path Loss with Near-Field Touch Polynomial
 * Converts smoothed RSSI into physical distance in meters.
 * Eliminates the artificial 20 cm floor when touching the beacon antenna.
 *
 * @param {number} rssi - Smoothed RSSI in dBm
 * @param {number} txPower - Calibrated RSSI at 1 meter (default -59 dBm)
 * @param {number} pathLossN - Environmental path-loss exponent (default 2.2)
 * @returns {number|null} Distance in meters
 */
// Calibration averaging: how long a stand's readings are kept, the window a
// logged point averages over, the fewest readings that window must hold, and
// the spread above which a stand is reported as unsteady.
const RANGING_HISTORY_MS = 20000;
const CALIB_WINDOW_MS = 6000;
const CALIB_MIN_SAMPLES = 8;
const CALIB_MAX_SIGMA_DB = 6.0;

/** A usable RSSI-at-1m value: outside this range it is a malformed or unset field. */
export function isPlausibleTx1m(tx) {
  return Number.isFinite(tx) && tx <= -30 && tx >= -100;
}

export function calculateV2BeaconDistance(rssi, txPower = -59, pathLossN = 2.9) {
  if (!rssi || !Number.isFinite(rssi)) return null;

  // Standard Log-Distance: d_raw = 10 ^ ((TxPower - RSSI) / (10 * n))
  const safeN = Math.max(1.2, Math.min(4.5, pathLossN));
  const ratio = (txPower - rssi) / (10.0 * safeN);
  const rawDistMeters = Math.pow(10, ratio);

  // Near-field touch polynomial correction:
  // Receivers saturate around -43 dBm. At -43 dBm and above, distance is 0.00 m.
  // Smoothly interpolate between -50 dBm and -43 dBm.
  const TOUCH_THRESHOLD = -43.0;
  const NEAR_FIELD_LIMIT = -50.0;

  let correctedMeters = rawDistMeters;
  if (rssi >= TOUCH_THRESHOLD) {
    correctedMeters = 0.0;
  } else if (rssi > NEAR_FIELD_LIMIT) {
    const touchFactor = (TOUCH_THRESHOLD - rssi) / (TOUCH_THRESHOLD - NEAR_FIELD_LIMIT);
    correctedMeters = rawDistMeters * touchFactor;
  }

  return Number(Math.max(0, correctedMeters).toFixed(3));
}

// ============================================================================
// MAIN V2 SCANNER SERVICE CLASS
// ============================================================================

class V2BeaconScannerService {
  constructor() {
    this.config = { ...DEFAULT_V2_CONFIG };
    this.scanning = false;
    this.totalPacketsReceived = 0;

    // ── Motion state relay (PDR step detector -> AdaptiveBeaconEngine) ──
    // The ranging engine cannot tell a person walking away from a person being
    // blocked by a wall or a passing body: both simply lower RSSI. A step
    // detector can, so the app forwards steps here via notifyStep() and the
    // scanner keeps the engine continuously informed. Motion reporting stays
    // OFF until the first step is seen, so a screen that never reports steps
    // leaves the engine on its own (more conservative) internal estimate rather
    // than being told it is permanently stationary.
    // Reported from the start: the app's step detector runs all the time, so
    // "no step yet" genuinely means standing. Waiting for a first step left the
    // engine guessing - and noisier - for the whole first stand.
    this._lastStepAt = 0;
    this._motionReportingActive = true;
    this.stepIdleTimeoutMs = 1200;
    // Turn detection (see notifyHeading).
    this._lastTurnAt = -Infinity;
    this._turnRefHeading = null;
    this._turnRefAt = 0;
    this.turnThresholdDeg = 35;
    this.turnWindowMs = 1500;
    this.turnHoldMs = 1500;
    // Last body-shadow fraction per beacon, recorded with calibration samples.
    this._bodyShadow = { b1: null, b2: null };

    // Discovered devices: Map<deviceId, deviceObject>
    this.discoveredDevices = new Map();

    // Rolling raw samples buffer for graph: Array<{ t, raw, filtered, dist }>
    this.maxGraphPoints = 150;
    this.graphHistory = {
      b1: [],
      b2: [],
    };

    // Rolling packet log (last 40 packets)
    this.packetLog = [];
    this.maxLogEntries = 40;

    this.lastDistanceUpdate = {
      b1: { dist: null, time: null },
      b2: { dist: null, time: null },
    };

    // Live statistics for Beacon 1 and Beacon 2
    this.stats = {
      b1: this._createInitialBeaconStats(1),
      b2: this._createInitialBeaconStats(2),
    };

    // Timestamps for packet rate (Hz) calculation (last 15 packets)
    this.timestampWindows = {
      b1: [],
      b2: [],
    };

    // Listeners
    this.listeners = {
      onPacket: new Set(),
      onStats: new Set(),
      onStatus: new Set(),
      onDiscovered: new Set(),
    };

    this.loadConfig();
  }

  _createInitialBeaconStats(num) {
    return {
      beaconNum: num,
      name: `Beacon ${num}`,
      id: null,
      mac: null,
      major: null,
      minor: null,
      uuid: null,
      rawRssi: null,
      filteredRssi: null,
      distanceM: null,
      distanceFt: null,
      distanceIn: null,
      stabilityScore: 100, // 0 - 100%
      confidenceScore: 1.0, // 0.0 - 1.0
      packetRateHz: 0,
      totalPackets: 0,
      minRssi: null,
      maxRssi: null,
      jitter: 0,
      variance: 0,
      stdDev: 0,
      currentN: 2.2,
      txPower1m: -59,
      kalmanQ: 0.01,
      kalmanR: 1.0,
      kalmanGain: 0.5,
      outlierCount: 0,
      isCalibrated: false,
      calibrationR2: null,
      calibrationPointsCount: 0,
      lastSeen: null,
      txPower: -59,
    };
  }

  async loadConfig() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        this.config = { ...DEFAULT_V2_CONFIG, ...saved };
        if (this.config.beacon1Id) {
          this.stats.b1.id = this.config.beacon1Id;
          this.stats.b1.mac = this.config.beacon1Id;
          this.stats.b1.name = this.config.beacon1Name || "Beacon 1";
        }
        if (this.config.beacon2Id) {
          this.stats.b2.id = this.config.beacon2Id;
          this.stats.b2.mac = this.config.beacon2Id;
          this.stats.b2.name = this.config.beacon2Name || "Beacon 2";
        }
        adaptiveEngine.setHeights(this.config.beaconHeightM, this.config.phoneHeightM);
      }
      // The Settings screen owns the fallback path-loss model, so push it into
      // the engine now and again on every change. Previously nothing did, and
      // the engine silently kept its own constants regardless of the setting.
      this.applyPathLossSettings(getAppSettings());
      if (!this._settingsUnsub) {
        this._settingsUnsub = subscribeAppSettings((s) => this.applyPathLossSettings(s));
      }
    } catch (e) {
      console.warn("[V2Scanner] Failed to load config:", e);
    }
  }

  async saveConfig(updates) {
    try {
      this.config = { ...this.config, ...updates };
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
      this.emitStats();
    } catch (e) {
      console.warn("[V2Scanner] Failed to save config:", e);
    }
  }

  setPathLossN(newN) {
    if (Number.isFinite(newN) && newN >= 1.2 && newN <= 4.5) {
      this.saveConfig({ pathLossN: Number(newN.toFixed(2)) });
    }
  }

  setDistanceUnit(unit) {
    if (["m", "ft", "in"].includes(unit)) {
      this.saveConfig({ distanceUnit: unit });
    }
  }

  /**
   * Writes one slot (1 or 2) without any conflict checking. Internal only —
   * callers must go through selectBeacon()/swapBeacons(), which guarantee the
   * two slots never point at the same physical beacon.
   */
  _assignSlot(beaconNum, deviceId, displayName, txPower) {
    const key = beaconNum === 1 ? "b1" : "b2";
    const device = this.discoveredDevices.get(deviceId);

    this.config[beaconNum === 1 ? "beacon1Id" : "beacon2Id"] = deviceId;
    this.config[beaconNum === 1 ? "beacon1Name" : "beacon2Name"] = displayName;
    if (Number.isFinite(txPower)) {
      this.config[beaconNum === 1 ? "beacon1TxPower" : "beacon2TxPower"] = txPower;
    }

    this.graphHistory[key] = [];
    if (this.rangingHistory) this.rangingHistory[key] = [];
    this.timestampWindows[key] = [];
    this.lastDistanceUpdate[key] = { dist: null, time: null };
    this.stats[key] = {
      ...this._createInitialBeaconStats(beaconNum),
      id: deviceId,
      mac: deviceId,
      name: displayName,
      major: device?.major || null,
      minor: device?.minor || null,
      uuid: device?.uuid || null,
      txPower: this.config[beaconNum === 1 ? "beacon1TxPower" : "beacon2TxPower"],
    };
  }

  /**
   * Explicitly select a beacon as Beacon 1 or Beacon 2 from the discovered list.
   *
   * If the chosen device is ALREADY occupying the other slot, the two slots are
   * SWAPPED rather than both ending up pointing at the same physical beacon.
   * Without this, tapping "Set B1" on the current B2 left beacon1Id ===
   * beacon2Id, so both traces/names/RSSI readouts showed one and the same
   * beacon — which reads as the B1/B2 labels having swapped or duplicated.
   *
   * Per-slot calibrated TxPower travels with the device across a swap, since
   * it is a property of the physical beacon, not of the slot it sits in.
   * (The OLS path-loss calibration in AdaptiveBeaconEngine is keyed by MAC, so
   * that already follows the device automatically.)
   */
  selectBeacon(beaconNum, deviceId, customName = null) {
    if (!deviceId || (beaconNum !== 1 && beaconNum !== 2)) return;

    const otherNum = beaconNum === 1 ? 2 : 1;
    const currentOwnId = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    const otherId = otherNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;

    // Already in the requested slot — nothing to do.
    if (currentOwnId === deviceId) return;

    const device = this.discoveredDevices.get(deviceId);
    const displayName = customName || device?.name || `Beacon (${deviceId.slice(-5)})`;
    const ownTx = beaconNum === 1 ? this.config.beacon1TxPower : this.config.beacon2TxPower;
    const otherTx = otherNum === 1 ? this.config.beacon1TxPower : this.config.beacon2TxPower;

    if (otherId && otherId === deviceId) {
      // ── Conflict: the device lives in the other slot. Swap the two. ──
      const displacedName =
        (beaconNum === 1 ? this.config.beacon1Name : this.config.beacon2Name) ||
        (currentOwnId ? `Beacon (${currentOwnId.slice(-5)})` : null);

      this._assignSlot(beaconNum, deviceId, displayName, otherTx);
      if (currentOwnId) {
        this._assignSlot(otherNum, currentOwnId, displacedName, ownTx);
      } else {
        this._clearSlot(otherNum);
      }
    } else {
      this._assignSlot(beaconNum, deviceId, displayName, ownTx);
    }

    this.saveConfig({
      beacon1Id: this.config.beacon1Id,
      beacon1Name: this.config.beacon1Name,
      beacon1TxPower: this.config.beacon1TxPower,
      beacon2Id: this.config.beacon2Id,
      beacon2Name: this.config.beacon2Name,
      beacon2TxPower: this.config.beacon2TxPower,
    });

    if (device && Number.isFinite(device.rawRssi)) {
      this._updateBeaconStream(beaconNum, device, device.rawRssi, Date.now());
    } else {
      this.emitStats();
    }
  }

  /** Empties a slot back to its unassigned placeholder state. */
  _clearSlot(beaconNum) {
    const key = beaconNum === 1 ? "b1" : "b2";
    this.config[beaconNum === 1 ? "beacon1Id" : "beacon2Id"] = null;
    this.config[beaconNum === 1 ? "beacon1Name" : "beacon2Name"] = `Beacon ${beaconNum}`;
    this.graphHistory[key] = [];
    this.timestampWindows[key] = [];
    this.lastDistanceUpdate[key] = { dist: null, time: null };
    this.stats[key] = this._createInitialBeaconStats(beaconNum);
  }

  /**
   * Swaps which physical beacon is B1 and which is B2, carrying each one's
   * calibrated TxPower with it. Useful when the auto-assignment (first beacon
   * seen becomes B1) doesn't match how they're laid out on the floor plan.
   */
  swapBeacons() {
    const id1 = this.config.beacon1Id;
    const id2 = this.config.beacon2Id;
    if (!id1 || !id2) return { success: false, error: "Both beacons must be selected first." };

    const name1 = this.config.beacon1Name;
    const name2 = this.config.beacon2Name;
    const tx1 = this.config.beacon1TxPower;
    const tx2 = this.config.beacon2TxPower;

    this._assignSlot(1, id2, name2, tx2);
    this._assignSlot(2, id1, name1, tx1);

    this.saveConfig({
      beacon1Id: this.config.beacon1Id,
      beacon1Name: this.config.beacon1Name,
      beacon1TxPower: this.config.beacon1TxPower,
      beacon2Id: this.config.beacon2Id,
      beacon2Name: this.config.beacon2Name,
      beacon2TxPower: this.config.beacon2TxPower,
    });
    this.emitStats();
    return { success: true };
  }

  /**
   * Auto-picks the top 2 strongest discovered beacons as B1 and B2
   */
  autoSelectTopTwo() {
    const list = this.getDiscoveredDevices();
    if (list.length >= 1) {
      this.selectBeacon(1, list[0].id, list[0].name);
    }
    if (list.length >= 2) {
      this.selectBeacon(2, list[1].id, list[1].name);
    }
  }

  // Listener subscriptions
  subscribePackets(fn) {
    this.listeners.onPacket.add(fn);
    return () => this.listeners.onPacket.delete(fn);
  }

  subscribeStats(fn) {
    this.listeners.onStats.add(fn);
    fn(this.getStats());
    return () => this.listeners.onStats.delete(fn);
  }

  subscribeStatus(fn) {
    this.listeners.onStatus.add(fn);
    fn(this.scanning);
    return () => this.listeners.onStatus.delete(fn);
  }

  subscribeDiscovered(fn) {
    this.listeners.onDiscovered.add(fn);
    fn(this.getDiscoveredDevices());
    return () => this.listeners.onDiscovered.delete(fn);
  }

  emitStats() {
    const s = this.getStats();
    for (const fn of this.listeners.onStats) fn(s);
  }

  emitStatus() {
    for (const fn of this.listeners.onStatus) fn(this.scanning);
  }

  emitDiscovered() {
    const list = this.getDiscoveredDevices();
    for (const fn of this.listeners.onDiscovered) fn(list);
  }

  _throttledEmitDiscovered() {
    const now = Date.now();
    if (!this._lastDiscoveredEmit || now - this._lastDiscoveredEmit > 350) {
      this._lastDiscoveredEmit = now;
      this.emitDiscovered();
    }
  }

  _throttledEmitStats() {
    const now = Date.now();
    if (!this._lastStatsEmit || now - this._lastStatsEmit > 80) {
      this._lastStatsEmit = now;
      this.emitStats();
    }
  }

  setTargetBeaconsOnly(enabled) {
    this.config.targetBeaconsOnly = Boolean(enabled);
    this.saveConfig({ targetBeaconsOnly: this.config.targetBeaconsOnly });
    this.emitStats();
  }

  getStats() {
    return {
      b1: { ...this.stats.b1, txPower: this.config.beacon1TxPower },
      b2: { ...this.stats.b2, txPower: this.config.beacon2TxPower },
      beacon1Id: this.config.beacon1Id,
      beacon2Id: this.config.beacon2Id,
      pathLossN: this.config.pathLossN,
      distanceUnit: this.config.distanceUnit || "m",
      targetBeaconsOnly: this.config.targetBeaconsOnly !== false,
      scanning: this.scanning,
      totalDiscovered: this.discoveredDevices.size,
      totalPacketsReceived: this.totalPacketsReceived,
    };
  }

  getGraphHistory() {
    return {
      b1: [...this.graphHistory.b1],
      b2: [...this.graphHistory.b2],
    };
  }

  getPacketLog() {
    return [...this.packetLog];
  }

  /**
   * Returns all discovered devices sorted by RSSI descending (strongest first)
   */
  getDiscoveredDevices() {
    const arr = Array.from(this.discoveredDevices.values());
    return arr.sort((a, b) => (b.rawRssi || -999) - (a.rawRssi || -999));
  }

  clearBuffers() {
    this.graphHistory.b1 = [];
    this.graphHistory.b2 = [];
    this.packetLog = [];
    this.timestampWindows.b1 = [];
    this.timestampWindows.b2 = [];
    this.lastDistanceUpdate.b1 = { dist: null, time: null };
    this.lastDistanceUpdate.b2 = { dist: null, time: null };
    this.stats.b1 = this._createInitialBeaconStats(1);
    this.stats.b2 = this._createInitialBeaconStats(2);
    this.totalPacketsReceived = 0;
    this.discoveredDevices.clear();
    this.emitStats();
    this.emitDiscovered();
  }

  async startScan() {
    if (this.scanning) return { success: true };

    try {
      const hasPerms = await requestBluetoothPermissions();
      if (!hasPerms) {
        return {
          success: false,
          error: "Bluetooth and Location permissions are required to scan for beacons.",
        };
      }

      const manager = getBleManager();
      if (!manager) {
        return {
          success: false,
          error: "Native BLE Manager is unavailable in this build.",
        };
      }

      // Check Bluetooth adapter state safely
      try {
        const state = await manager.state();
        if (state === "PoweredOff") {
          const enabled = await ensureBluetoothEnabled();
          if (!enabled) {
            return {
              success: false,
              error: "Bluetooth is turned off. Please turn on Bluetooth to scan.",
            };
          }
        }
      } catch (se) {
        // Transient state check error, proceed to scan
      }

      this.scanning = true;
      this.emitStatus();
      this._startNativeScan(manager);
      this._startScanWatchdog();
      return { success: true };
    } catch (e) {
      console.warn("[V2Scanner] startScan error:", e);
      this.scanning = false;
      this.emitStatus();
      return { success: false, error: e?.message || String(e) };
    }
  }

  /**
   * Starts (or restarts) the native scan. A scan error used to call stopScan(),
   * which ended scanning for good - every distance then froze on its last value
   * until the user restarted the scan by hand. Errors now schedule a restart.
   */
  _startNativeScan(manager = getBleManager()) {
    if (!manager || !this.scanning) return;
    try { manager.stopDeviceScan(); } catch (e) { /* not running */ }
    this._lastNativeStartAt = Date.now();
    this._lastAnyPacketAt = Date.now();
    // LowLatency (scanMode: 2) & allowDuplicates for high frequency
    manager.startDeviceScan(
      null,
      { allowDuplicates: true, scanMode: 2 },
      (error, device) => {
        if (error) {
          console.warn("[V2Scanner] Scan error, restarting:", error?.message || error);
          this._scheduleScanRestart();
          return;
        }
        if (!device) return;
        this._processBlePacket(device);
      }
    );
  }

  _scheduleScanRestart() {
    if (!this.scanning || this._restartTimer) return;
    // Android refuses more than 5 scan starts in 30 s (and then silently
    // delivers nothing), so restarts are spaced at least SCAN_RESTART_MIN_MS.
    const wait = Math.max(1500, SCAN_RESTART_MIN_MS - (Date.now() - (this._lastNativeStartAt || 0)));
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this.scanning) {
        this.scanRestarts = (this.scanRestarts || 0) + 1;
        this._startNativeScan();
      }
    }, wait);
  }

  /**
   * Some Android phones quietly stop delivering packets during a long scan
   * (or deliver only the first advertisement per device). If nothing has
   * arrived for SCAN_STALL_MS - or the two selected beacons have gone silent
   * while scanning - the native scan is restarted automatically.
   */
  _startScanWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(() => {
      if (!this.scanning) return;
      const now = Date.now();
      const silentAll = now - (this._lastAnyPacketAt || 0) > SCAN_STALL_MS;
      const ids = [this.stats.b1, this.stats.b2].filter((b) => b?.id);
      const silentTargets = ids.length > 0 && ids.every((b) => !Number.isFinite(b.lastSeen) || now - b.lastSeen > SCAN_STALL_MS * 2);
      if ((silentAll || silentTargets) && now - (this._lastNativeStartAt || 0) > SCAN_RESTART_MIN_MS) {
        console.warn(`[V2Scanner] No packets for a while (${silentAll ? "any device" : "selected beacons"}) - restarting scan`);
        this._scheduleScanRestart();
      }
    }, 2000);
  }

  stopScan() {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (!this.scanning) return;
    this.scanning = false;
    const manager = getBleManager();
    if (manager) {
      try {
        manager.stopDeviceScan();
      } catch (e) {
        // ignore
      }
    }
    this.emitStatus();
  }

  /**
   * Internal packet processor:
   * Ingests any BLE device, decodes payload, updates the sorted device registry,
   * and runs the multi-stage filter pipeline for selected beacons.
   */
  _processBlePacket(device) {
    this._lastAnyPacketAt = Date.now();
    const rawRssi = device.rssi;
    // Reject invalid or impossible RSSI
    if (!rawRssi || rawRssi === 0 || rawRssi < -115 || rawRssi > -5) return;

    const deviceId = device.id; // Unique hardware address (MAC)

    // =========================================================================
    // HIGH-PERFORMANCE TARGET BEACONS ONLY FILTER:
    // If targetBeaconsOnly is active and B1 or B2 is already chosen,
    // IMMEDIATELY discard any packet that does not belong to Beacon 1 or 2!
    // Eliminates all base64 decoding, memory allocation, and React state storms.
    // =========================================================================
    const isB1 = this.config.beacon1Id && this.config.beacon1Id === deviceId;
    const isB2 = this.config.beacon2Id && this.config.beacon2Id === deviceId;

    if (this.config.targetBeaconsOnly && (this.config.beacon1Id || this.config.beacon2Id)) {
      if (!isB1 && !isB2) {
        return; // DISCARD IMMEDIATELY! Zero phone load.
      }
    }

    this.totalPacketsReceived++;
    const now = Date.now();

    // Decode beacon payload
    const parsed = parseBeaconPayload(
      device.manufacturerData,
      device.serviceData,
      device.name
    );

    const displayName = parsed.displayName || device.name || `Device (${deviceId.slice(-5)})`;

    const hasRealName = Boolean(
      (parsed.displayName && parsed.displayName.trim().length > 0) ||
      (device.name && device.name.trim().length > 0 && !device.name.toLowerCase().includes("unnamed") && !device.name.toLowerCase().includes("unknown"))
    );

    // Update discovered devices registry
    const existing = this.discoveredDevices.get(deviceId) || {};
    const updatedDevice = {
      id: deviceId,
      name: displayName,
      hasRealName,
      rawRssi,
      isBeacon: parsed.isBeacon,
      beaconType: parsed.beaconType,
      uuid: parsed.uuid || existing.uuid || null,
      major: parsed.major !== null ? parsed.major : existing.major ?? null,
      minor: parsed.minor !== null ? parsed.minor : existing.minor ?? null,
      txPower: parsed.calibratedTxPower || existing.txPower || -59,
      // The beacon's own "measured power" (RSSI at 1 m) from its iBeacon
      // packet, kept separately from txPower above so a real advertised value
      // can be told apart from the -59 placeholder.
      advertisedTxPower: isPlausibleTx1m(parsed.calibratedTxPower)
        ? parsed.calibratedTxPower
        : existing.advertisedTxPower ?? null,
      estimatedDistM: calculateV2BeaconDistance(rawRssi, parsed.calibratedTxPower || existing.txPower || -59, this.config.pathLossN),
      lastSeen: now,
      packetCount: (existing.packetCount || 0) + 1,
    };
    this.discoveredDevices.set(deviceId, updatedDevice);

    // =========================================================================
    // AUTO-ASSIGNMENT IF NOT YET SELECTED
    // =========================================================================
    if (!this.config.beacon1Id && parsed.isBeacon) {
      this.selectBeacon(1, deviceId, displayName);
    } else if (!this.config.beacon2Id && parsed.isBeacon && deviceId !== this.config.beacon1Id) {
      this.selectBeacon(2, deviceId, displayName);
    } else {
      // FEED DATA TO SELECTED BEACON 1 OR BEACON 2
      let targetNum = null;
      if (this.config.beacon1Id && this.config.beacon1Id === deviceId) {
        targetNum = 1;
      } else if (this.config.beacon2Id && this.config.beacon2Id === deviceId) {
        targetNum = 2;
      }

      if (targetNum !== null) {
        this._updateBeaconStream(targetNum, updatedDevice, rawRssi, now);
      }
    }

    this._throttledEmitDiscovered();
    this._throttledEmitStats();
  }

  /**
   * Runs the Adaptive, Per-Beacon Signal Processing & Kinematic Distance Pipeline
   */
  _updateBeaconStream(beaconNum, deviceObj, rawRssi, now) {
    const targetKey = beaconNum === 1 ? "b1" : "b2";
    const statObj = this.stats[targetKey];
    // 1 m reference used while this beacon is NOT calibrated (once calibrated,
    // the engine uses the fitted value and ignores this). Priority:
    //   1. the beacon's own advertised measured power, from its iBeacon packet
    //   2. null -> the engine's default, i.e. the Settings screen value
    //
    // This used to pass beacon1TxPower/beacon2TxPower, which are -59 unless a
    // calibration has written them. So every uncalibrated beacon ranged off
    // -59 regardless of how it was configured - a Moko set to a different
    // transmit power was off by a constant factor (6 dB = 1.6x at n = 2.9),
    // differently per beacon - and the Settings default could never take
    // effect either, because a non-null value always overrode it.
    const advertisedTx = deviceObj.advertisedTxPower;
    const txPower = isPlausibleTx1m(advertisedTx) ? advertisedTx : null;

    statObj.id = deviceObj.id;
    statObj.mac = deviceObj.id;
    statObj.name = deviceObj.name;
    statObj.major = deviceObj.major;
    statObj.minor = deviceObj.minor;
    statObj.uuid = deviceObj.uuid;
    statObj.lastSeen = now;
    statObj.totalPackets++;

    // -------------------------------------------------------------------------
    // ADAPTIVE, PER-BEACON SIGNAL PROCESSING ENGINE
    // Outlier Gating -> Live Variance -> Adaptive Kalman Filter (Dynamic Q & R)
    // -> Calibrated Path Loss / Near-Field Touch -> Kinematic Slew Limiter
    // -------------------------------------------------------------------------
    // Relay the current motion verdict before ingesting, so the engine can hold
    // its shadow envelope firm while standing still and release it the moment
    // real walking starts. "Moving" means a step landed recently; after
    // stepIdleTimeoutMs of no steps the user is treated as standing.
    if (this._motionReportingActive) {
      const sinceStepMs = now - this._lastStepAt;
      const sinceTurnMs = now - this._lastTurnAt;
      adaptiveEngine.setMotionState(
        sinceStepMs < this.stepIdleTimeoutMs || sinceTurnMs < this.turnHoldMs,
        now
      );
    }

    let adaptiveData = null;
    try {
      adaptiveData = adaptiveEngine.ingestReading(
        deviceObj.id,
        rawRssi,
        txPower,
        now,
        { name: deviceObj.name }
      );
    } catch (err) {
      console.warn("[V2Scanner] ingestReading error:", err);
    }

    statObj.rawRssi = rawRssi;

    if (!adaptiveData) {
      statObj.filteredRssi = rawRssi;
      return;
    }

    const safeFiltered = Number.isFinite(adaptiveData.filteredRssi) ? adaptiveData.filteredRssi : rawRssi;
    const safeDist = Number.isFinite(adaptiveData.distanceM) ? adaptiveData.distanceM : null;

    statObj.filteredRssi = safeFiltered;
    // The level the path-loss inversion was actually fed. Ranging calibration
    // fits against this, not filteredRssi - see rangingRssi in the engine.
    statObj.rangingRssi = Number.isFinite(adaptiveData.rangingRssi)
      ? adaptiveData.rangingRssi
      : safeFiltered;
    statObj.packetGapMs = Number.isFinite(adaptiveData.packetGapMs) ? adaptiveData.packetGapMs : null;
    statObj.distanceM = safeDist;
    statObj.distanceFt = safeDist !== null ? Number((safeDist * 3.28084).toFixed(2)) : null;
    statObj.distanceIn = safeDist !== null ? Number((safeDist * 39.3701).toFixed(1)) : null;

    statObj.variance = Number.isFinite(adaptiveData.variance) ? adaptiveData.variance : 0;
    statObj.stdDev = Number.isFinite(adaptiveData.stdDev) ? adaptiveData.stdDev : 0;
    statObj.stabilityScore = Number.isFinite(adaptiveData.stabilityScore)
      ? Math.round(adaptiveData.stabilityScore * 100)
      : 50;
    statObj.confidenceScore = Number.isFinite(adaptiveData.confidenceScore)
      ? adaptiveData.confidenceScore
      : 0.5;
    statObj.currentN = Number.isFinite(adaptiveData.currentN) ? adaptiveData.currentN : 2.2;
    statObj.txPower1m = Number.isFinite(adaptiveData.txPower1m) ? adaptiveData.txPower1m : -59;
    statObj.kalmanQ = Number.isFinite(adaptiveData.kalmanQ) ? adaptiveData.kalmanQ : 0.01;
    statObj.kalmanR = Number.isFinite(adaptiveData.kalmanR) ? adaptiveData.kalmanR : 1.0;
    statObj.kalmanGain = Number.isFinite(adaptiveData.kalmanGain) ? adaptiveData.kalmanGain : 0.5;
    statObj.outlierCount = adaptiveData.outlierCount || 0;
    statObj.isCalibrated = Boolean(adaptiveData.isCalibrated);
    statObj.advertisedTxPower = isPlausibleTx1m(advertisedTx) ? advertisedTx : null;
    // Where the 1 m reference in use came from, so the UI can say plainly
    // whether distances are calibrated or running on an assumption.
    statObj.txSource = statObj.isCalibrated
      ? "calibrated"
      : txPower !== null ? "advertised" : "default";

    // Body-shadow correction and the calibration level, for the UI and for
    // spot calibration (see BODY_SHADOW_LOSS_DB in AdaptiveBeaconEngine).
    statObj.levelDb = Number.isFinite(adaptiveData.levelDb) ? adaptiveData.levelDb : statObj.rangingRssi;
    statObj.bodyLossDb = Number.isFinite(adaptiveData.bodyLossDb) ? adaptiveData.bodyLossDb : 0;
    statObj.motionMode = adaptiveData.motionMode || null;
    // Distance-dependent RSSI@1m (see DEFAULT_EXCESS_LOSS_DB_PER_M).
    statObj.excessLossDbPerM = Number.isFinite(adaptiveData.excessLossDbPerM) ? adaptiveData.excessLossDbPerM : 0;
    statObj.txAtDistance = Number.isFinite(adaptiveData.txAtDistance) ? adaptiveData.txAtDistance : statObj.txPower1m;
    statObj.autoPointsCount = adaptiveData.autoPointsCount || 0;
    statObj.locationCorrectionDb = Number.isFinite(adaptiveData.locationCorrectionDb) ? adaptiveData.locationCorrectionDb : 0;
    statObj.rangeSigmaM = Number.isFinite(adaptiveData.rangeSigmaM) ? adaptiveData.rangeSigmaM : null;

    try {
      const calibrator = adaptiveEngine.getCalibrator(deviceObj.id);
      statObj.calibrationPointsCount = Array.isArray(calibrator?.referencePoints) ? calibrator.referencePoints.length : 0;
      statObj.calibrationR2 = calibrator?.rSquared ?? null;
    } catch (e) {
      statObj.calibrationPointsCount = 0;
      statObj.calibrationR2 = null;
    }

    // -------------------------------------------------------------------------
    // Live Packet Rate (Hz) & Signal Statistics
    // -------------------------------------------------------------------------
    const tWindow = this.timestampWindows[targetKey];
    tWindow.push(now);
    if (tWindow.length > 15) tWindow.shift();

    if (tWindow.length >= 3) {
      const durationSec = (tWindow[tWindow.length - 1] - tWindow[0]) / 1000.0;
      if (durationSec > 0.1) {
        const hz = (tWindow.length - 1) / durationSec;
        statObj.packetRateHz = Number(hz.toFixed(1));
      }
    }

    // Jitter (Min, Max, Peak-to-Peak)
    if (statObj.minRssi === null || rawRssi < statObj.minRssi) statObj.minRssi = rawRssi;
    if (statObj.maxRssi === null || rawRssi > statObj.maxRssi) statObj.maxRssi = rawRssi;
    statObj.jitter = statObj.maxRssi - statObj.minRssi;

    // Rolling Graph History
    const hist = this.graphHistory[targetKey];
    hist.push({ t: now, raw: rawRssi, filtered: adaptiveData.filteredRssi, dist: adaptiveData.distanceM });
    if (hist.length > this.maxGraphPoints) hist.shift();

    // Recent RANGING levels, for calibration. Calibration must be fitted on the
    // same level the distance formula inverts (rangingRssi = filtered + shadow
    // correction), averaged over a stand - see getRecentRangingLevel().
    if (!this.rangingHistory) this.rangingHistory = { b1: [], b2: [] };
    if (Number.isFinite(statObj.levelDb)) {
      const rh = this.rangingHistory[targetKey];
      // levelDb, not rangingRssi: the calibration fit re-applies the body
      // correction itself from the recorded shape, and must not see the
      // standing-still average twice.
      const bs = this._bodyShadow[targetKey];
      const shape = bs && now - bs.at <= 3000 ? bs.f : null;
      rh.push({ t: now, level: statObj.levelDb, shape });
      while (rh.length && now - rh[0].t > RANGING_HISTORY_MS) rh.shift();
    }

    // Packet log entry
    const packetEntry = {
      id: `${now}-${beaconNum}-${statObj.totalPackets}`,
      time: new Date(now).toTimeString().split(" ")[0] + "." + String(now % 1000).padStart(3, "0"),
      beaconNum,
      mac: deviceObj.id,
      rawRssi,
      filteredRssi: adaptiveData.filteredRssi,
      // The level the path-loss inversion consumed. Ranging calibration must
      // fit against this so the model it produces matches the model in use.
      rangingRssi: statObj.rangingRssi,
      // Calibration level (no body correction, no standing average).
      levelDb: statObj.levelDb,
      distanceM: adaptiveData.distanceM,
      major: deviceObj.major,
      minor: deviceObj.minor,
    };

    this.packetLog.unshift(packetEntry);
    if (this.packetLog.length > this.maxLogEntries) this.packetLog.pop();

    for (const fn of this.listeners.onPacket) fn(packetEntry);
  }

  // =========================================================================
  // CALIBRATION & LOCALIZATION CONVENIENCE METHODS
  // =========================================================================

  /**
   * Logs a calibration point at a known distance from the AVERAGE ranging
   * level over the last few seconds of standing there.
   *
   * It used to log a single instant of filteredRssi, which was wrong twice:
   *   - wrong LEVEL: ranging inverts rangingRssi (filtered + shadow correction),
   *     and that correction grows with range, because a longer path fades more.
   *     A model fitted on filtered RSSI was close up near and increasingly off
   *     far away - "short range accurate, long range not".
   *   - one INSTANT: a single reading carries the full few dB of noise, which
   *     tilts the fitted slope differently every time, so two beacons
   *     calibrated the same way still disagreed.
   */
  logCalibrationPoint(beaconNum, distanceM) {
    const beaconId = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (!beaconId) return { success: false, error: "Beacon not selected" };
    const calibrator = adaptiveEngine.getCalibrator(beaconId);
    const avg = this.getRecentRangingLevel(beaconNum);
    if (!avg.ok) return { success: false, error: avg.error };
    calibrator.addReferencePoint(distanceM, avg.level);
    this.emitStats();
    return {
      success: true,
      count: calibrator.referencePoints.length,
      level: avg.level,
      sigmaDb: avg.sigmaDb,
      samples: avg.samples,
      unsteady: avg.sigmaDb > CALIB_MAX_SIGMA_DB,
    };
  }

  /**
   * Trimmed mean of this beacon's ranging level over the last windowMs.
   * Requires enough packets that the average means something.
   */
  getRecentRangingLevel(beaconNum, windowMs = CALIB_WINDOW_MS) {
    const key = beaconNum === 1 ? "b1" : "b2";
    const now = Date.now();
    const rh = (this.rangingHistory && this.rangingHistory[key]) || [];
    const recent = rh.filter((p) => now - p.t <= windowMs);
    const vals = recent.map((p) => p.level);
    const shapes = recent.map((p) => p.shape).filter(Number.isFinite);
    if (vals.length < CALIB_MIN_SAMPLES) {
      return {
        ok: false,
        samples: vals.length,
        error:
          `Only ${vals.length} readings from Beacon ${beaconNum} in the last ${Math.round(windowMs / 1000)} s ` +
          `(need ${CALIB_MIN_SAMPLES}). Stand still at the distance a few more seconds, ` +
          `with the phone at chest height facing the beacon, then try again.`,
      };
    }
    const sorted = [...vals].sort((a, b) => a - b);
    const cut = Math.floor(sorted.length * 0.2);
    const kept = sorted.slice(cut, sorted.length - cut);
    const level = kept.reduce((a, v) => a + v, 0) / kept.length;
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    const sigmaDb = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
    return {
      ok: true,
      level: Number(level.toFixed(2)),
      sigmaDb: Number(sigmaDb.toFixed(2)),
      samples: vals.length,
      // Mean body-shadow fraction over the window, or null when unknown.
      shape: shapes.length >= vals.length / 2
        ? Number((shapes.reduce((a, v) => a + v, 0) / shapes.length).toFixed(2))
        : null,
    };
  }

  /**
   * Pushes the app-wide fallback path-loss model into the ranging engine.
   *
   * Without this the Settings screen's path-loss controls were inert: they
   * were persisted and used only for the rough estimate beside unselected
   * devices in the discovery list, while every distance that mattered came
   * from the engine's own hardcoded constants.
   *
   * @param {{pathLossN?: number, txPower?: number}} settings
   */
  applyPathLossSettings(settings = {}) {
    const n = Number(settings.pathLossN);
    const tx = Number(settings.txPower);
    const applied = adaptiveEngine.setDefaultPathLoss(
      Number.isFinite(n) ? n : null,
      Number.isFinite(tx) ? tx : null
    );
    if (Number.isFinite(n)) this.config.pathLossN = applied.pathLossN;
    return applied;
  }

  /**
   * Writes a completed two-stand geometric calibration into both beacons'
   * per-beacon path-loss models, replacing whatever was there.
   *
   * The result is stored as two reference points per beacon rather than as
   * bare coefficients, so it shows up in the calibration point list exactly
   * like manually logged points, can be inspected and extended, and survives
   * through the same persistence PathLossCalibrator already has.
   *
   * @param {object} solveResult - output of RangingCalibrationSession.solve()
   */
  applyGeometricCalibration(solveResult) {
    if (!solveResult || !solveResult.ok) {
      return { success: false, error: solveResult?.error || "Calibration did not solve." };
    }
    if (!this.config.beacon1Id || !this.config.beacon2Id) {
      return { success: false, error: "Select both beacons first." };
    }
    const nearM = Number.isFinite(solveResult.nearRefM) ? solveResult.nearRefM : 1.0;
    const farM = solveResult.baselineM;
    const applied = {};

    for (const beaconNum of [1, 2]) {
      const beaconId = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
      const fit = solveResult.beacons[beaconNum];
      if (!fit || !fit.ok) continue;
      const calibrator = adaptiveEngine.getCalibrator(beaconId);

      calibrator.clear();
      calibrator.addReferencePoint(nearM, fit.nearRssi);
      calibrator.addReferencePoint(farM, fit.farRssi);
      // Both points sit on the exact line solveTwoPoint found, so the OLS fit
      // reproduces it; assigning afterwards keeps the two in step even when
      // the exponent had to be clamped, where OLS alone would not.
      calibrator.fitModel();
      calibrator.fittedN = fit.n;
      calibrator.fittedTxPower1m = fit.txPower1m;
      // Two points define a straight line in log-distance: the exponent
      // already includes the extra loss between the two stands.
      calibrator.fittedAlpha = 0;
      calibrator.isCalibrated = true;
      calibrator.saveToStorage();

      this.config[beaconNum === 1 ? "beacon1TxPower" : "beacon2TxPower"] = fit.txPower1m;
      this.stats[beaconNum === 1 ? "b1" : "b2"].txPower = fit.txPower1m;
      applied[beaconNum] = { n: fit.n, txPower1m: fit.txPower1m };
    }

    this.saveConfig({
      beacon1TxPower: this.config.beacon1TxPower,
      beacon2TxPower: this.config.beacon2TxPower,
    });
    this.emitStats();
    return { success: true, applied };
  }

  /**
   * Clears both selected beacons' shadow envelopes. Called when the phone has
   * just been carried somewhere else, so a peak held at the old spot cannot be
   * mistaken for a fade at the new one - see resetShadowEnvelope() in
   * AdaptiveBeaconEngine.
   */
  resetShadowEnvelopes() {
    for (const id of [this.config.beacon1Id, this.config.beacon2Id]) {
      if (id) adaptiveEngine.resetShadowEnvelope(id);
    }
  }

  /** Deletes one logged calibration point (e.g. one taken while someone walked past). */
  removeCalibrationPoint(beaconNum, index) {
    const beaconId = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (!beaconId) return { success: false, error: "Beacon not selected" };
    const calibrator = adaptiveEngine.getCalibrator(beaconId);
    calibrator.removeReferencePoint(index);
    calibrator.saveToStorage();
    this.emitStats();
    return { success: true, count: calibrator.referencePoints.length };
  }

  fitPathLossModel(beaconNum) {
    const beaconId = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (!beaconId) return { success: false, error: "Beacon not selected" };
    const calibrator = adaptiveEngine.getCalibrator(beaconId);
    const res = calibrator.fitModel();
    if (!res) return { success: false, error: "Need at least 2 distinct distance measurements" };
    calibrator.saveToStorage();
    this.emitStats();
    return { success: true, ...res };
  }

  /**
   * Equalizes the two beacons so that standing at one spot yields the SAME
   * reported distance from both.
   *
   * WHY THIS IS NEEDED: two beacons of the same model still differ in actual
   * radiated power by several dB (manufacturing tolerance, antenna orientation,
   * mounting surface, battery level). In the log-distance model, a TxPower
   * mismatch of Δ dB turns into a CONSTANT RATIO between the two reported
   * distances — so one beacon reads e.g. 4 m while the other reads 7 m from the
   * exact same spot. No amount of filtering fixes that; it is a calibration
   * offset, not noise.
   *
   * The user stands where both beacons are genuinely equidistant and calls
   * this. Both TxPowers are then moved symmetrically about their mean so the
   * two agree at that point, while the overall scale (and therefore absolute
   * distance accuracy) is left untouched:
   *     tx_i_new = txMean + (rssi_i − rssiMean)
   *
   * @returns {{success: boolean, error?: string, b1TxPower?: number, b2TxPower?: number, deltaDb?: number}}
   */
  matchBeaconPair() {
    if (!this.config.beacon1Id || !this.config.beacon2Id) {
      return { success: false, error: "Select both B1 and B2 first." };
    }
    // Same level ranging uses, averaged over a stand, for the same reasons as
    // logCalibrationPoint(): one instant of filteredRssi matched the two
    // beacons to noise and on the wrong level.
    const a1 = this.getRecentRangingLevel(1);
    const a2 = this.getRecentRangingLevel(2);
    if (!a1.ok) return { success: false, error: a1.error };
    if (!a2.ok) return { success: false, error: a2.error };
    const r1 = a1.level;
    const r2 = a2.level;

    const tx1 = Number.isFinite(this.config.beacon1TxPower) ? this.config.beacon1TxPower : -59;
    const tx2 = Number.isFinite(this.config.beacon2TxPower) ? this.config.beacon2TxPower : -59;
    const txMean = (tx1 + tx2) / 2;
    const rssiMean = (r1 + r2) / 2;

    const newTx1 = Number((txMean + (r1 - rssiMean)).toFixed(1));
    const newTx2 = Number((txMean + (r2 - rssiMean)).toFixed(1));

    this.set1MeterTxPower(1, newTx1);
    this.set1MeterTxPower(2, newTx2);

    return {
      success: true,
      b1TxPower: newTx1,
      b2TxPower: newTx2,
      deltaDb: Number((r1 - r2).toFixed(1)),
    };
  }

  /**
   * @param {{measured?: boolean}} opts measured: true when the value is an
   *   average actually measured 1 m from the beacon (Signal Lab 1 m
   *   calibration); otherwise it is a typed override, not a measurement.
   */
  set1MeterTxPower(beaconNum, txPower1m, opts = {}) {
    const val = Number(Number(txPower1m).toFixed(1));
    const isB1 = beaconNum === 1;
    if (isB1) {
      this.config.beacon1TxPower = val;
      this.stats.b1.txPower = val;
      this.saveConfig({ beacon1TxPower: val });
    } else {
      this.config.beacon2TxPower = val;
      this.stats.b2.txPower = val;
      this.saveConfig({ beacon2TxPower: val });
    }
    const beaconId = isB1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (beaconId) {
      try {
        const calibrator = adaptiveEngine.getCalibrator(beaconId);
        if (calibrator && typeof calibrator.set1MeterTxPower === "function") {
          calibrator.set1MeterTxPower(val, opts);
        }
      } catch (e) {
        console.warn("[V2Scanner] set1MeterTxPower error:", e);
      }
    }
    this.emitStats();
    return { success: true, txPower1m: val };
  }

  getCalibrationState(beaconNum) {
    const beaconId = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (!beaconId) return null;
    try {
      const calibrator = adaptiveEngine.getCalibrator(beaconId);
      return {
        referencePoints: Array.isArray(calibrator?.referencePoints) ? [...calibrator.referencePoints] : [],
        fittedN: calibrator?.fittedN ?? 2.2,
        fittedTxPower1m: calibrator?.fittedTxPower1m ?? -59,
        rSquared: calibrator?.rSquared ?? null,
        isCalibrated: Boolean(calibrator?.isCalibrated),
        // Dual-slope (near/far breakpoint) fields — hasFarSegment is true once
        // at least 2 reference points exist on each side of breakpointDistanceM.
        hasFarSegment: Boolean(calibrator?.hasFarSegment),
        fittedNFar: calibrator?.fittedNFar ?? null,
        breakpointDistanceM: calibrator?.breakpointDistanceM ?? 6.0,
      };
    } catch (e) {
      console.warn("[V2Scanner] getCalibrationState error:", e);
      return null;
    }
  }

  clearCalibration(beaconNum) {
    const beaconId = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (!beaconId) return;
    try {
      const calibrator = adaptiveEngine.getCalibrator(beaconId);
      calibrator?.clear();
      calibrator?.saveToStorage();
      this.emitStats();
    } catch (e) {
      console.warn("[V2Scanner] clearCalibration error:", e);
    }
  }

  computeWeightedPosition(anchors) {
    try {
      return adaptiveEngine.computeWeightedPosition(anchors);
    } catch (e) {
      console.warn("[V2Scanner] computeWeightedPosition error:", e);
      return null;
    }
  }

  /**
   * Configures ceiling/wall-mount height correction (3D slant -> 2D floor
   * distance) applied to both tracked beacons. Pass null to disable.
   * Persists alongside the rest of the v2 config so it survives app restarts.
   *
   * @param {number|null} beaconHeightM
   * @param {number} phoneHeightM
   */
  /**
   * Reports a detected footstep from the PDR engine. Call this on every step;
   * the scanner derives a live moving/standing verdict from the gap between
   * steps and forwards it to the ranging engine. Knowing this is what lets the
   * engine reject multi-second signal fades without also lagging real movement.
   */
  notifyStep(timestamp = Date.now(), step = null) {
    this._lastStepAt = timestamp;
    this._motionReportingActive = true;
  }

  /**
   * Reports the live heading (degrees, map frame). Used only to detect TURNS:
   * turning round swaps which beacons are in front of and behind the user, so
   * the signal legitimately changes by several dB while standing still. The
   * engine must treat that as movement, not as a fade to be averaged away -
   * otherwise the reading stays stuck at the old orientation for many seconds.
   */
  notifyHeading(headingDeg, timestamp = Date.now()) {
    if (!Number.isFinite(headingDeg)) return;
    if (!Number.isFinite(this._turnRefHeading)) {
      this._turnRefHeading = headingDeg;
      this._turnRefAt = timestamp;
      return;
    }
    let diff = headingDeg - this._turnRefHeading;
    diff = ((diff % 360) + 540) % 360 - 180;
    if (Math.abs(diff) >= this.turnThresholdDeg) {
      this._lastTurnAt = timestamp;
      this._turnRefHeading = headingDeg;
      this._turnRefAt = timestamp;
    } else if (timestamp - this._turnRefAt > this.turnWindowMs) {
      this._turnRefHeading = headingDeg;
      this._turnRefAt = timestamp;
    }
  }

  /**
   * Fraction of body loss that currently applies to each beacon, 0 when the
   * user faces it and 1 when it is directly behind them. Supplied by the
   * Fusion Map, the only place that knows both heading and position.
   * @param {{b1?: number, b2?: number}} fractions
   */
  setBodyShadow(fractions = {}, timestamp = Date.now()) {
    for (const [key, id] of [["b1", this.config.beacon1Id], ["b2", this.config.beacon2Id]]) {
      const f = fractions[key];
      if (!id || !Number.isFinite(f)) continue;
      adaptiveEngine.setBodyShadow(id, f, timestamp);
      this._bodyShadow[key] = { f, at: timestamp };
    }
  }

  /** Beacons moved or the plan was resized. */
  async _onGeometryChanged() {
    this.emitStats();
  }

  /**
   * Spot calibration: the user stood still at a known point on the floor plan,
   * so the true distance to each beacon is known from the map. Each beacon gets
   * one reference point from the average level over the last windowMs, tagged
   * with how much of the user's body was between phone and beacon, and its
   * model is refitted. One spot already fixes RSSI@1m; spots spread over the
   * room fit the decay rate as well.
   *
   * @param {{b1?: number, b2?: number}} distancesM true distances, metres
   * @returns {{ok: boolean, beacons: object}}
   */
  addSpotCalibration(distancesM, windowMs = 6000, pointFt = null) {
    const out = {};
    let anyOk = false;
    for (const [num, key, id] of [[1, "b1", this.config.beacon1Id], [2, "b2", this.config.beacon2Id]]) {
      const d = distancesM?.[key];
      if (!id) { out[key] = { ok: false, error: `Beacon ${num} is not selected.` }; continue; }
      if (!Number.isFinite(d) || d <= 0) { out[key] = { ok: false, error: "No distance for this beacon." }; continue; }
      const avg = this.getRecentRangingLevel(num, windowMs);
      if (!avg.ok) { out[key] = { ok: false, error: avg.error }; continue; }
      // The path-loss model is fitted on the straight-line (slant) range. With
      // beacons mounted above phone height the map's floor distance is shorter.
      const bh = adaptiveEngine.config.BEACON_HEIGHT_M;
      const ph = Number.isFinite(adaptiveEngine.config.PHONE_HEIGHT_M) ? adaptiveEngine.config.PHONE_HEIGHT_M : 1.1;
      const slantM = Number.isFinite(bh) ? Math.hypot(d, bh - ph) : d;
      const calibrator = adaptiveEngine.getCalibrator(id);
      // A measurement supersedes a typed RSSI@1m.
      calibrator.txOverride = null;
      calibrator.addReferencePoint(slantM, avg.level, {
        shape: avg.shape,
        source: "spot",
        x: pointFt?.x,
        y: pointFt?.y,
      });
      const adv = this.stats[key]?.advertisedTxPower;
      const fit = calibrator.fitModel({
        priorTx: isPlausibleTx1m(adv) ? adv : adaptiveEngine.config.DEFAULT_TX_POWER_1M,
      });
      calibrator.saveToStorage();
      anyOk = true;
      out[key] = {
        ok: true,
        distanceM: Number(d.toFixed(2)),
        level: avg.level,
        sigmaDb: avg.sigmaDb,
        unsteady: avg.sigmaDb > CALIB_MAX_SIGMA_DB,
        points: calibrator.referencePoints.length,
        txPower1m: fit?.txPower1m ?? calibrator.fittedTxPower1m,
        n: fit?.n ?? calibrator.fittedN,
      };
    }
    this.emitStats();
    return { ok: anyOk, beacons: out };
  }

  /**
   * Mean calibration level and body-shadow fraction of one beacon's packets
   * between fromT and toT (ms timestamps). Used by RangeAutoCalibrator.
   */
  getLevelWindow(beaconNum, fromT, toT = Date.now()) {
    const key = beaconNum === 1 ? "b1" : "b2";
    const rh = (this.rangingHistory && this.rangingHistory[key]) || [];
    const w = rh.filter((p) => p.t >= fromT && p.t <= toT);
    if (!w.length) return { ok: false, samples: 0 };
    const level = w.reduce((a, p) => a + p.level, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, p) => a + (p.level - level) ** 2, 0) / w.length);
    const shapes = w.map((p) => p.shape).filter(Number.isFinite);
    return {
      ok: true,
      samples: w.length,
      level,
      sigmaDb: sd,
      shape: shapes.length >= w.length / 2 ? shapes.reduce((a, v) => a + v, 0) / shapes.length : null,
    };
  }

  /**
   * One automatically measured calibration point: the user's position came
   * from the walked track, so the distance is known only to within
   * sigmaDb (already converted to dB by the caller). The beacon's model is
   * refitted straight away.
   *
   * @param {1|2} beaconNum
   * @param {number} floorDistanceM distance on the floor plan, metres
   */
  addAutoCalibrationPoint(beaconNum, floorDistanceM, level, shape, sigmaDb, atFt = null, expectedOffsetDb = 0) {
    const key = beaconNum === 1 ? "b1" : "b2";
    const id = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (!id || !Number.isFinite(floorDistanceM) || !Number.isFinite(level)) return null;
    const bh = adaptiveEngine.config.BEACON_HEIGHT_M;
    const ph = Number.isFinite(adaptiveEngine.config.PHONE_HEIGHT_M) ? adaptiveEngine.config.PHONE_HEIGHT_M : 1.1;
    const slantM = Number.isFinite(bh) ? Math.hypot(floorDistanceM, bh - ph) : floorDistanceM;
    const calibrator = adaptiveEngine.getCalibrator(id);
    // Gate: a point far from what the model (plus the radio map at that
    // place) expects is a wrong track or a person in the way, not a lesson.
    if (calibrator.isCalibrated) {
      const bodyDb = adaptiveEngine.config.BODY_SHADOW_LOSS_DB ?? 0;
      const y = level + bodyDb * (Number.isFinite(shape) ? shape : 0);
      const miss = y - (calibrator.predictAt(slantM, atFt) + (Number.isFinite(expectedOffsetDb) ? expectedOffsetDb : 0));
      if (Math.abs(miss) > Math.max(8, 2.5 * (sigmaDb || 4))) return null;
    }
    if (!calibrator.addAutoPoint(slantM, level, {
      shape, sigmaDb, source: "auto", x: atFt?.x, y: atFt?.y, posSigmaFt: atFt?.sigmaFt,
    })) return null;
    const adv = this.stats[key]?.advertisedTxPower;
    const fit = calibrator.fitModel({
      priorTx: Number.isFinite(calibrator.priorTx)
        ? calibrator.priorTx
        : isPlausibleTx1m(adv) ? adv : adaptiveEngine.config.DEFAULT_TX_POWER_1M,
    });
    // Saving rewrites the whole point list, so not on every point.
    this._autoSaveCount = (this._autoSaveCount || 0) + 1;
    if (this._autoSaveCount % 4 === 0) calibrator.saveToStorage();
    return fit;
  }

  /**
   * Tells both beacons' calibrations which obstacles lie between any point and
   * them (see ObstacleMap.js), and refits, so the loss per obstacle type is
   * learned from the calibration points already taken. Call whenever the
   * obstacles or the beacons' places on the plan change.
   */
  setObstacleGeometry(map, anchor1, anchor2) {
    for (const [id, anchor] of [[this.config.beacon1Id, anchor1], [this.config.beacon2Id, anchor2]]) {
      if (!id) continue;
      const c = adaptiveEngine.getCalibrator(id);
      c.wallFeatureFn = map && map.items.length && anchor
        ? (p) => map.expectedCounts(p, anchor, Number.isFinite(p.posSigmaFt) ? p.posSigmaFt : 1)
        : null;
      if (c.isCalibrated && (c.referencePoints.length || c.autoPoints.length || Number.isFinite(c.txOverride))) {
        c.fitModel();
        c.saveToStorage();
      }
    }
    this.emitStats();
  }

  /** Fitted loss per obstacle type (dB, ObstacleMap OBSTACLE_TYPES order). */
  getWallLosses(beaconNum) {
    const id = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    return id ? [...adaptiveEngine.getCalibrator(id).fittedWallLoss] : null;
  }

  /** Calibration points with a floor-plan position, for the radio map. */
  getRadioMapPoints(beaconNum) {
    const id = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (!id) return [];
    return adaptiveEngine.getCalibrator(id).getRadioMapPoints();
  }

  /** Changes whenever a beacon's model is refitted (radio map must rebuild). */
  getCalibrationVersion(beaconNum) {
    const id = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (!id) return "none";
    return `${id}:${adaptiveEngine.getCalibrator(id).version}`;
  }

  /**
   * Radio-map correction at the user's current position, per beacon:
   * { b1: {db, sdDb}, b2: {db, sdDb} } - db is added to the level.
   */
  setLocationCorrection(corr = {}, timestamp = Date.now()) {
    for (const [key, id] of [["b1", this.config.beacon1Id], ["b2", this.config.beacon2Id]]) {
      const c = corr[key];
      if (!id || !c || !Number.isFinite(c.db)) continue;
      adaptiveEngine.setLocationCorrection(id, c.db, c.sdDb, timestamp);
    }
  }

  /** Persists both beacons' calibrations now (e.g. when auto-calibration pauses). */
  saveCalibrations() {
    for (const id of [this.config.beacon1Id, this.config.beacon2Id]) {
      if (id) adaptiveEngine.getCalibrator(id).saveToStorage();
    }
  }

  /** The model a beacon is ranging with, for slope (dB per metre) estimates. */
  getRangingModel(beaconNum) {
    const id = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    const cfg = adaptiveEngine.config;
    if (!id) return { A: cfg.DEFAULT_TX_POWER_1M, n: cfg.DEFAULT_PATH_LOSS_N, alpha: cfg.DEFAULT_EXCESS_LOSS_DB_PER_M ?? 0 };
    const c = adaptiveEngine.getCalibrator(id);
    return c.isCalibrated
      ? { A: c.fittedTxPower1m, n: c.fittedN, alpha: c.fittedAlpha ?? 0 }
      : { A: cfg.DEFAULT_TX_POWER_1M, n: cfg.DEFAULT_PATH_LOSS_N, alpha: cfg.DEFAULT_EXCESS_LOSS_DB_PER_M ?? 0 };
  }

  setBeaconHeights(beaconHeightM, phoneHeightM = 1.1) {
    adaptiveEngine.setHeights(beaconHeightM, phoneHeightM);
    this.saveConfig({
      beaconHeightM: Number.isFinite(beaconHeightM) ? beaconHeightM : null,
      phoneHeightM: Number.isFinite(phoneHeightM) ? phoneHeightM : 1.1,
    });
  }

  /**
   * Caps every beacon's computed distance at this many metres — normally the
   * real floor plan's diagonal. Nothing legitimate should measure farther
   * than the deployment space physically allows; without this, a weak
   * signal combined with an uncalibrated or sparsely-calibrated path-loss
   * model can extrapolate to a "hallucinated" distance far outside the room.
   */
  setMaxPlausibleDistance(maxDistanceM) {
    adaptiveEngine.setMaxPlausibleDistance(maxDistanceM);
  }

  // =========================================================================
  // OFFICE MAP — FLOOR-PLAN SIZE & BEACON ANCHOR PERSISTENCE (all in FEET)
  // Storage keys are versioned "_ft" — distinct from the old metre-based keys
  // so a prior metre-based room/anchor save is never silently reinterpreted
  // as feet.
  // =========================================================================

  /**
   * Persist floor-plan dimensions for the Office Map, in FEET.
   * @param {{ widthFt: number, heightFt: number }} size
   */
  async setPlaceSize({ widthFt, heightFt }) {
    try {
      await AsyncStorage.setItem(
        "@v2_fusion_place_size_ft",
        JSON.stringify({ widthFt: Number(widthFt), heightFt: Number(heightFt) })
      );
      await this._onGeometryChanged();
    } catch (e) {
      console.warn("[V2Scanner] setPlaceSize error:", e);
    }
  }

  /**
   * Load saved floor-plan dimensions. Returns null if not yet configured.
   * @returns {Promise<{ widthFt: number, heightFt: number } | null>}
   */
  async getPlaceSize() {
    try {
      const raw = await AsyncStorage.getItem("@v2_fusion_place_size_ft");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        Number.isFinite(parsed.widthFt) && parsed.widthFt > 0 &&
        Number.isFinite(parsed.heightFt) && parsed.heightFt > 0
      ) {
        return { widthFt: parsed.widthFt, heightFt: parsed.heightFt };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Persist world-coordinate anchor positions for both beacons, in FEET.
   * @param {{ x: number, y: number }} b1 - Beacon 1 world position (feet)
   * @param {{ x: number, y: number }} b2 - Beacon 2 world position (feet)
   */
  async setBeaconAnchors(b1, b2) {
    try {
      await AsyncStorage.setItem(
        "@v2_fusion_anchors_ft",
        JSON.stringify({
          b1: { x: Number(b1.x), y: Number(b1.y) },
          b2: { x: Number(b2.x), y: Number(b2.y) },
        })
      );
      // Beacons moved on the plan: what was learned for the old layout no
      // longer describes their distances.
      await this._onGeometryChanged();
    } catch (e) {
      console.warn("[V2Scanner] setBeaconAnchors error:", e);
    }
  }

  /**
   * Load saved beacon anchor positions (feet).
   * Returns null if not yet configured.
   * @returns {Promise<{ b1: {x,y}, b2: {x,y} } | null>}
   */
  async getBeaconAnchors() {
    try {
      const raw = await AsyncStorage.getItem("@v2_fusion_anchors_ft");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const validCoord = (p) =>
        p && Number.isFinite(p.x) && Number.isFinite(p.y);
      if (validCoord(parsed.b1) && validCoord(parsed.b2)) {
        return { b1: parsed.b1, b2: parsed.b2 };
      }
      return null;
    } catch (e) {
      return null;
    }
  }
}

// Export singleton instance
export const v2Scanner = new V2BeaconScannerService();
