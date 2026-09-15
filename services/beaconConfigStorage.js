// ============================================================================
// BEACON CONFIG STORAGE
// Persists all 2-beacon module configuration using AsyncStorage.
// Completely isolated from PathStorage.js used by the PDR module.
// ============================================================================

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@two_beacon_config_v1";

export const DEFAULT_CONFIG = {
  // Selected devices
  beacon1Id:   null,
  beacon1Name: "",
  beacon2Id:   null,
  beacon2Name: "",

  // Map positions (feet)
  beacon1X: 0,
  beacon1Y: 15,
  beacon2X: 18,
  beacon2Y: 15,

  // Room / Test Area Dimensions (feet)
  roomWidthFt:       18,
  roomHeightFt:      15,
  askAreaBeforeTest: true,

  // Calibration (RSSI at 1m, i.e. txPower)
  beacon1TxPower: -59,
  beacon2TxPower: -59,
  pathLossN:      2.2,

  // Height correction
  heightCorrectionOn: false,
  beacon1HeightFt:    9.0,
  beacon2HeightFt:    9.0,
  phoneHeightFt:      3.5,
};

export async function loadBeaconConfig() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    console.warn("[beaconConfigStorage] load error:", e);
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveBeaconConfig(updates) {
  try {
    const existing = await loadBeaconConfig();
    const merged   = { ...existing, ...updates };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    return merged;
  } catch (e) {
    console.warn("[beaconConfigStorage] save error:", e);
  }
}

export async function resetBeaconConfig() {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return { ...DEFAULT_CONFIG };
  } catch (e) {
    console.warn("[beaconConfigStorage] reset error:", e);
    return { ...DEFAULT_CONFIG };
  }
}
