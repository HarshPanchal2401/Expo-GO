// ============================================================================
// Places.js — named destinations for "Where to?"
//
// Saved on the phone as { id, name, x, y, category } in the floor plan's feet, the
// same way StartSpots.js keeps start spots. A place is snapped onto the green when
// it is saved (inside the corridor, not on its wall line), so a route to it always
// ends where a person can stand. PLACES_SEED (placesSeed.js) is the list every phone
// starts with.
// ============================================================================

import { floorplanGrid } from "./WalkableGrid.js";
import { PLACES_SEED } from "./placesSeed.js";

let AsyncStorage = null;
try {
  const mod = require("@react-native-async-storage/async-storage");
  AsyncStorage = mod.default || mod;
} catch (e) {
  AsyncStorage = null; // memory only
}

const KEY = "@places_v1";
export const MAX_PLACES = 60;
export const MAX_PLACE_NAME = 24;

let cache = null;
let loadPromise = null; // shared, so a save during the first read cannot overwrite the saved places

/** A point on the green near p (a place in a wall is moved into the corridor), or null. */
export function snapToGreen(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  const inside = floorplanGrid.inside(p, 1.5, 3);
  if (inside) return inside;
  const n = floorplanGrid.nearest(p, 6);
  return n ? { x: n.x, y: n.y } : null;
}

const clean = (s) =>
  s && typeof s.name === "string" && s.name.trim() && Number.isFinite(s.x) && Number.isFinite(s.y)
    ? { id: String(s.id), name: s.name.trim().slice(0, MAX_PLACE_NAME), x: s.x, y: s.y, category: typeof s.category === "string" ? s.category : "" }
    : null;

/** The saved places (always the current list, also after saves). */
export async function loadPlaces() {
  if (!loadPromise) {
    loadPromise = (async () => {
      let list = [];
      try {
        const raw = AsyncStorage ? await AsyncStorage.getItem(KEY) : null;
        const parsed = JSON.parse(raw || "[]");
        if (Array.isArray(parsed)) list = parsed.map(clean).filter(Boolean);
      } catch (e) {
        /* unreadable: start from the seed */
      }
      // The seed fills in names the phone does not have yet.
      for (const s of PLACES_SEED.map(clean).filter(Boolean)) {
        if (!list.some((p) => p.name.toLowerCase() === s.name.toLowerCase())) list.push(s);
      }
      cache = list.slice(0, MAX_PLACES);
    })();
  }
  await loadPromise;
  return cache;
}

async function persist() {
  try {
    if (AsyncStorage) await AsyncStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {
    /* memory copy still works this run */
  }
}

/**
 * Saves (or moves, if the name exists) a place, snapped onto the green.
 * Returns { ok, reason?, list }: ok is false when nothing was saved.
 */
export async function savePlace(name, x, y, category = "") {
  await loadPlaces();
  const n = String(name || "").trim().slice(0, MAX_PLACE_NAME);
  const p = snapToGreen({ x, y });
  if (!n) return { ok: false, reason: "Enter a name for the place.", list: cache };
  if (!p) return { ok: false, reason: "Pick a point on the walkway.", list: cache };
  const i = cache.findIndex((s) => s.name.toLowerCase() === n.toLowerCase());
  if (i >= 0) cache = cache.map((s, k) => (k === i ? { ...s, name: n, x: p.x, y: p.y, category } : s));
  else if (cache.length < MAX_PLACES) cache = [...cache, { id: String(Date.now()), name: n, x: p.x, y: p.y, category }];
  else return { ok: false, reason: `You can keep ${MAX_PLACES} places. Long-press one to delete it first.`, list: cache };
  await persist();
  return { ok: true, list: cache };
}

export async function removePlace(id) {
  await loadPlaces();
  cache = cache.filter((s) => s.id !== id);
  await persist();
  return cache;
}

/**
 * The places whose name contains the query (case-insensitive; empty = all), nearest
 * to `from` first. Each result also carries distFt (straight line) when `from` is given.
 */
export function searchPlaces(list, query = "", from = null) {
  const q = String(query || "").trim().toLowerCase();
  const out = (list || [])
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q))
    .map((p) => (from && Number.isFinite(from.x) ? { ...p, distFt: Math.hypot(p.x - from.x, p.y - from.y) } : { ...p }));
  if (from && Number.isFinite(from.x)) out.sort((a, b) => a.distFt - b.distFt);
  else out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
