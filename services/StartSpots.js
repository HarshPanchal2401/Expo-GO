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
let loadPromise = null; // shared, so a save during the first read cannot overwrite the saved spots

const clean = (s) =>
  s && typeof s.name === "string" && s.name && Number.isFinite(s.x) && Number.isFinite(s.y)
    ? { id: String(s.id), name: s.name.slice(0, MAX_NAME), x: s.x, y: s.y }
    : null;

export function loadStartSpots() {
  if (!loadPromise) {
    loadPromise = (async () => {
      let list = [];
      try {
        const raw = AsyncStorage ? await AsyncStorage.getItem(KEY) : null;
        const parsed = JSON.parse(raw || "[]");
        if (Array.isArray(parsed)) list = parsed.map(clean).filter(Boolean).slice(0, MAX_SPOTS);
      } catch (e) {
        /* unreadable: start empty */
      }
      cache = list;
      return cache;
    })();
  }
  return loadPromise;
}

async function persist() {
  try {
    if (AsyncStorage) await AsyncStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {
    /* memory copy still works this run */
  }
}

/**
 * Saves (or moves, if the name exists) a spot.
 * Returns { ok, reason?, list }: ok is false when nothing was saved (bad name / point, or the list is full).
 */
export async function saveStartSpot(name, x, y) {
  await loadStartSpots();
  const n = String(name || "").trim().slice(0, MAX_NAME);
  if (!n || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "Enter a name and pick a point on the map.", list: cache };
  const i = cache.findIndex((s) => s.name.toLowerCase() === n.toLowerCase());
  if (i >= 0) cache = cache.map((s, k) => (k === i ? { ...s, name: n, x, y } : s));
  else if (cache.length < MAX_SPOTS) cache = [...cache, { id: String(Date.now()), name: n, x, y }];
  else return { ok: false, reason: `You can keep ${MAX_SPOTS} start spots. Long-press one to delete it first.`, list: cache };
  await persist();
  return { ok: true, list: cache };
}

export async function removeStartSpot(id) {
  await loadStartSpots();
  cache = cache.filter((s) => s.id !== id);
  await persist();
  return cache;
}
