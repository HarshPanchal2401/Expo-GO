let AsyncStorage = null;
try {
  const mod = require("@react-native-async-storage/async-storage");
  AsyncStorage = mod.default || mod;
} catch (e) {
  console.log("[PathStorage] Native AsyncStorage not available, using in-memory session storage fallback.");
}

const STORAGE_KEY = "@pdr_saved_paths";
// Which saved paths the Fusion Map draws, so they are still shown after the
// app is closed and opened again.
const SHOWN_KEY = "@fusion_map_shown_paths_v1";
let memoryStore = [];
// True when the last read of the saved paths worked. While it is false the
// stored list is unknown, so nothing is written over it (a transient read error
// must not replace the saved paths with a short or empty list).
let diskTrusted = true;

const hasStorage = (fn) => AsyncStorage && typeof AsyncStorage[fn] === "function";

export async function getSavedPaths() {
  if (!hasStorage("getItem")) return memoryStore;
  let data;
  try {
    data = await AsyncStorage.getItem(STORAGE_KEY);
  } catch (error) {
    // Transient: use the in-memory copy for this call only, and try the disk again next time.
    diskTrusted = false;
    console.warn("[PathStorage] Could not read saved paths:", error);
    return memoryStore;
  }
  try {
    const parsed = data ? JSON.parse(data) : [];
    memoryStore = Array.isArray(parsed) ? parsed : [];
    diskTrusted = true;
    return memoryStore;
  } catch (error) {
    // Corrupt value: keep a copy for recovery, then start a clean list so saving works again.
    console.warn("[PathStorage] Saved paths were unreadable; keeping a backup and starting a clean list.", error);
    try { await AsyncStorage.setItem(STORAGE_KEY + "_corrupt", data); } catch (e) { /* best effort */ }
    memoryStore = [];
    diskTrusted = true;
    return memoryStore;
  }
}

async function writePaths(list) {
  if (!hasStorage("setItem")) return;
  if (!diskTrusted) {
    console.warn("[PathStorage] Not writing: the stored paths could not be read, so they would be overwritten.");
    return;
  }
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (error) {
    console.warn("[PathStorage] Could not save paths:", error);
  }
}

export async function savePath(pathData) {
  const newEntry = {
    id: Date.now().toString(),
    name: pathData.name || `Path ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
    timestamp: new Date().toLocaleString(),
    steps: pathData.steps || 0,
    distance: pathData.distance || 0,
    points: pathData.points || [],
    // Which screen recorded it and in what unit. The PDR tracker saves metres
    // from its own origin while the Fusion Map saves floor-plan feet, and the
    // two cannot be drawn on the same map without knowing which is which.
    ...(pathData.source ? { source: pathData.source } : {}),
    ...(pathData.units ? { units: pathData.units } : {}),
  };

  const existing = await getSavedPaths();
  const updated = [newEntry, ...existing];
  memoryStore = updated;
  await writePaths(updated);
  return updated;
}

export async function deleteSavedPath(id) {
  const existing = await getSavedPaths();
  const updated = existing.filter(item => item.id !== id);
  memoryStore = updated;
  await writePaths(updated);
  return updated;
}

export async function getShownPathIds() {
  if (!hasStorage("getItem")) return [];
  try {
    const data = await AsyncStorage.getItem(SHOWN_KEY);
    const ids = data ? JSON.parse(data) : [];
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch (error) {
    return [];
  }
}

export async function setShownPathIds(ids) {
  if (!hasStorage("setItem")) return;
  try {
    await AsyncStorage.setItem(SHOWN_KEY, JSON.stringify([...ids]));
  } catch (error) {
    // Not critical: the paths themselves are saved; only the on/off state is lost.
  }
}

export async function clearAllSavedPaths() {
  memoryStore = [];
  if (hasStorage("removeItem")) {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
      diskTrusted = true;
    } catch (error) {
      console.warn("[PathStorage] Could not clear saved paths:", error);
    }
  }
  return [];
}
