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
let useMemoryFallback = false;

export async function getSavedPaths() {
  if (useMemoryFallback || !AsyncStorage || typeof AsyncStorage.getItem !== "function") {
    return memoryStore;
  }
  try {
    const data = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = data ? JSON.parse(data) : [];
    memoryStore = parsed;
    return parsed;
  } catch (error) {
    useMemoryFallback = true;
    return memoryStore;
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

  if (!useMemoryFallback && AsyncStorage && typeof AsyncStorage.setItem === "function") {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (error) {
      useMemoryFallback = true;
    }
  }

  return updated;
}

export async function deleteSavedPath(id) {
  const existing = await getSavedPaths();
  const updated = existing.filter(item => item.id !== id);
  memoryStore = updated;

  if (!useMemoryFallback && AsyncStorage && typeof AsyncStorage.setItem === "function") {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (error) {
      useMemoryFallback = true;
    }
  }

  return updated;
}

export async function getShownPathIds() {
  if (useMemoryFallback || !AsyncStorage || typeof AsyncStorage.getItem !== "function") return [];
  try {
    const data = await AsyncStorage.getItem(SHOWN_KEY);
    const ids = data ? JSON.parse(data) : [];
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch (error) {
    return [];
  }
}

export async function setShownPathIds(ids) {
  if (useMemoryFallback || !AsyncStorage || typeof AsyncStorage.setItem !== "function") return;
  try {
    await AsyncStorage.setItem(SHOWN_KEY, JSON.stringify([...ids]));
  } catch (error) {
    // Not critical: the paths themselves are saved; only the on/off state is lost.
  }
}

export async function clearAllSavedPaths() {
  memoryStore = [];
  if (!useMemoryFallback && AsyncStorage && typeof AsyncStorage.removeItem === "function") {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      useMemoryFallback = true;
    }
  }
  return [];
}
