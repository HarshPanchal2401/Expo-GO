// ============================================================================
// StartSpots.js — named places the user can start from with one tap
//
// An exact, known start beats any radio estimate: the user stands at a marked
// place (Entrance, Desk 4, Cabin) and picks its name. Spots are saved on the
// phone as { id, name, x, y } in the floor plan's feet, so they never depend on
// beacons or on the signal at that moment.
// ============================================================================
                                                                                                               
let AsyncStorage = null;
try {
  const mod = require("@react-native-async-storage/async-storage");
  AsyncStorage = mod.default || mod;
} catch (e) {
  AsyncStorage = null; // memory only
}

const KEY = "@start_spots_v1";
export const MAX_SPOTS = 12;
export const MAX_NAME = 20;

let cache = null;

const clean = (s) =>
  s && typeof s.name === "string" && s.name && Number.isFinite(s.x) && Number.isFinite(s.y)
    ? { id: String(s.id), name: s.name.slice(0, MAX_NAME), x: s.x, y: s.y }
    : null;

export async function loadStartSpots() {
  if (cache) return cache;
  cache = [];
  try {
    const raw = AsyncStorage ? await AsyncStorage.getItem(KEY) : null;
    const list = JSON.parse(raw || "[]");
    if (Array.isArray(list)) cache = list.map(clean).filter(Boolean).slice(0, MAX_SPOTS);
  } catch (e) {
    /* unreadable: start empty */
  }
  return cache;
}

async function persist() {
  try {
    if (AsyncStorage) await AsyncStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {
    /* memory copy still works this run */
  }
}

/** Saves (or renames / moves, if the name exists) a spot. Returns the new list. */
export async function saveStartSpot(name, x, y) {
  await loadStartSpots();
  const n = String(name || "").trim().slice(0, MAX_NAME);
  if (!n || !Number.isFinite(x) || !Number.isFinite(y)) return cache;
  const i = cache.findIndex((s) => s.name.toLowerCase() === n.toLowerCase());
  if (i >= 0) cache = cache.map((s, k) => (k === i ? { ...s, name: n, x, y } : s));
  else if (cache.length < MAX_SPOTS) cache = [...cache, { id: String(Date.now()), name: n, x, y }];
  await persist();
  return cache;
}

export async function removeStartSpot(id) {
  await loadStartSpots();
  cache = cache.filter((s) => s.id !== id);
  await persist();
  return cache;
}
