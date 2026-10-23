// ============================================================================
// FloorplanMigration.js — one-time move of saved positions onto the current plan
//
// The office drawing has been replaced twice: 72 x 72 ft (first image), then
// 70 x 72 ft, now 70 x 70 ft (assets/floorplans/office-70x70.png). Each image
// is stretched over the room, so everything saved on the phone in feet - beacon
// positions, start spots, drawn obstacles - sits at a place ON THE DRAWING. When
// the room size changes, x and y are scaled by new/old size so each of them stays
// on the same spot of the drawing.
//
// Runs once (flag), and only when the saved room size is one of the earlier
// drawings' sizes (or was never set). A room size the user typed in is left
// alone. Everything that reads these values waits for it: ensureFloorplanMigrated().
// ============================================================================

let AsyncStorage = null;
try {
  const mod = require("@react-native-async-storage/async-storage");
  AsyncStorage = mod.default || mod;
} catch (e) {
  AsyncStorage = null;
}

export const FLOORPLAN_W_FT = 70;
export const FLOORPLAN_H_FT = 70;
// Sizes of the earlier drawings: a saved size equal to one of these is moved.
const OLD_SIZES = [
  { w: 72, h: 72 },
  { w: 70, h: 72 },
];

const FLAG_KEY = "@floorplan_migrated_70x70_v1";
const SIZE_KEY = "@v2_fusion_place_size_ft";
const ANCHORS_KEY = "@v2_fusion_anchors_ft";
const OBSTACLES_KEY = "@v2_obstacle_map_v1";
const SPOTS_KEY = "@start_spots_v1";

const sc = (v, f) => (Number.isFinite(v) ? Number((v * f).toFixed(2)) : v);

async function readJson(storage, key) {
  const raw = await storage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

/** The migration itself. Returns what it did (for logs / tests). */
export async function migrateFloorplan(storage = AsyncStorage) {
  if (!storage) return { ran: false, reason: "no-storage" };
  try {
    if (await storage.getItem(FLAG_KEY)) return { ran: false, reason: "already-done" };
    const size = await readJson(storage, SIZE_KEY).catch(() => null);
    const w = Number(size?.widthFt), h = Number(size?.heightFt);
    if (size && w === FLOORPLAN_W_FT && h === FLOORPLAN_H_FT) {
      await storage.setItem(FLAG_KEY, "already-current");
      return { ran: false, reason: "already-current" };
    }
    // Nothing saved yet = the first drawing's default (72 x 72).
    const from = size ? OLD_SIZES.find((o) => o.w === w && o.h === h) : OLD_SIZES[0];
    if (!from) {
      await storage.setItem(FLAG_KEY, "custom-size-kept");
      return { ran: false, reason: "custom-room-size" };
    }
    const fx = FLOORPLAN_W_FT / from.w;
    const fy = FLOORPLAN_H_FT / from.h;
    const pt = (p) => ({ ...p, x: sc(p.x, fx), y: sc(p.y, fy) });
    const done = [];

    if (size) {
      await storage.setItem(SIZE_KEY, JSON.stringify({ widthFt: FLOORPLAN_W_FT, heightFt: FLOORPLAN_H_FT }));
      done.push("size");
    }
    const anchors = await readJson(storage, ANCHORS_KEY).catch(() => null);
    if (anchors?.b1 && anchors?.b2) {
      await storage.setItem(ANCHORS_KEY, JSON.stringify({ b1: pt(anchors.b1), b2: pt(anchors.b2) }));
      done.push("anchors");
    }
    const obstacles = await readJson(storage, OBSTACLES_KEY).catch(() => null);
    if (Array.isArray(obstacles?.items) && obstacles.items.length) {
      const items = obstacles.items.map((it) => ({
        ...it,
        ...(it.x !== undefined ? { x: sc(it.x, fx) } : {}),
        ...(it.y !== undefined ? { y: sc(it.y, fy) } : {}),
        ...(it.x1 !== undefined ? { x1: sc(it.x1, fx) } : {}),
        ...(it.y1 !== undefined ? { y1: sc(it.y1, fy) } : {}),
        ...(it.x2 !== undefined ? { x2: sc(it.x2, fx) } : {}),
        ...(it.y2 !== undefined ? { y2: sc(it.y2, fy) } : {}),
      }));
      await storage.setItem(OBSTACLES_KEY, JSON.stringify({ ...obstacles, items }));
      done.push("obstacles");
    }
    const spots = await readJson(storage, SPOTS_KEY).catch(() => null);
    if (Array.isArray(spots) && spots.length) {
      await storage.setItem(SPOTS_KEY, JSON.stringify(spots.map(pt)));
      done.push("start-spots");
    }
    await storage.setItem(FLAG_KEY, "done");
    return { ran: true, done, from };
  } catch (e) {
    // Not flagged: it is tried again on the next start.
    console.warn("[FloorplanMigration] failed:", e);
    return { ran: false, reason: "error" };
  }
}

let once = null;
/** Runs the migration once per app run; everything that loads saved positions awaits this. */
export function ensureFloorplanMigrated() {
  if (!once) once = migrateFloorplan();
  return once;
}
