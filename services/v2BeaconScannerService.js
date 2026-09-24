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

const STORAGE_KEY = "@v2_beacon_config_v3";

export const DEFAULT_V2_CONFIG = {
  beacon1Id: null, // Hardware MAC address (device.id)
  beacon1Name: "Beacon 1",
  beacon2Id: null, // Hardware MAC address (device.id)
  beacon2Name: "Beacon 2",
  beacon1TxPower: -59,
  beacon2TxPower: -59,
  pathLossN: 2.2,
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
export function calculateV2BeaconDistance(rssi, txPower = -59, pathLossN = 2.2) {
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
    this._lastStepAt = null;
    this._motionReportingActive = false;
    this.stepIdleTimeoutMs = 1200;

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

      // Start native scan: LowLatency (scanMode: 2) & allowDuplicates for high frequency
      manager.startDeviceScan(
        null,
        { allowDuplicates: true, scanMode: 2 },
        (error, device) => {
          if (error) {
            console.warn("[V2Scanner] Scan error:", error);
            this.stopScan();
            return;
          }
          if (!device) return;
          this._processBlePacket(device);
        }
      );
      return { success: true };
    } catch (e) {
      console.warn("[V2Scanner] startScan error:", e);
      this.scanning = false;
      this.emitStatus();
      return { success: false, error: e?.message || String(e) };
    }
  }

  stopScan() {
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
    const txPower = beaconNum === 1 ? this.config.beacon1TxPower : this.config.beacon2TxPower;

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
      adaptiveEngine.setMotionState(sinceStepMs < this.stepIdleTimeoutMs, now);
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

    // Packet log entry
    const packetEntry = {
      id: `${now}-${beaconNum}-${statObj.totalPackets}`,
      time: new Date(now).toTimeString().split(" ")[0] + "." + String(now % 1000).padStart(3, "0"),
      beaconNum,
      mac: deviceObj.id,
      rawRssi,
      filteredRssi: adaptiveData.filteredRssi,
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

  logCalibrationPoint(beaconNum, distanceM) {
    const beaconId = beaconNum === 1 ? this.config.beacon1Id : this.config.beacon2Id;
    if (!beaconId) return { success: false, error: "Beacon not selected" };
    const calibrator = adaptiveEngine.getCalibrator(beaconId);
    const stat = this.stats[beaconNum === 1 ? "b1" : "b2"];
    const currentRssi = stat.filteredRssi !== null ? stat.filteredRssi : stat.rawRssi;
    if (currentRssi === null) return { success: false, error: "No signal received yet" };
    calibrator.addReferencePoint(distanceM, currentRssi);
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
    const s1 = this.stats.b1;
    const s2 = this.stats.b2;
    if (!this.config.beacon1Id || !this.config.beacon2Id) {
      return { success: false, error: "Select both B1 and B2 first." };
    }
    const r1 = Number.isFinite(s1.filteredRssi) ? s1.filteredRssi : s1.rawRssi;
    const r2 = Number.isFinite(s2.filteredRssi) ? s2.filteredRssi : s2.rawRssi;
    if (!Number.isFinite(r1) || !Number.isFinite(r2)) {
      return { success: false, error: "Both beacons need a live signal before matching." };
    }

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

  set1MeterTxPower(beaconNum, txPower1m) {
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
          calibrator.set1MeterTxPower(val);
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
  notifyStep(timestamp = Date.now()) {
    this._lastStepAt = timestamp;
    this._motionReportingActive = true;
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
