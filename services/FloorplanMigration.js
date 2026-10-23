// ============================================================================
// FloorplanMigration.js — one-time move from the 72 x 72 ft plan to 70 x 72 ft
//
// The office drawing was replaced by an accurate one (assets/floorplans/
// office-70x72.png): same office, but 70 ft wide, not 72. The old image was
// stretched over 72 ft, so everything saved on the phone in feet - beacon
// positions, start spots, drawn obstacles - sat at the same place ON THE
// DRAWING but at x on a 72 ft scale. Scaling x by 70/72 keeps each of them on
// the same spot of the drawing. y is unchanged (72 ft both times).
//
// Runs once (flag), and only when the saved room size is the old default
// 72 x 72 (or was never set). A room size the user typed in is left alone.
// Everything that reads these values waits for it: ensureFloorplanMigrated().
// ============================================================================

let AsyncStorage = null;
try {
  const mod = require("@react-native-async-storage/async-storage");
  AsyncStorage = mod.default || mod;
} catch (e) {
  AsyncStorage = null;
}

export const FLOORPLAN_W_FT = 70;
export const FLOORPLAN_H_FT = 72;
const OLD_W_FT = 72;
const OLD_H_FT = 72;

const FLAG_KEY = "@floorplan_migrated_70x72_v1";
const SIZE_KEY = "@v2_fusion_place_size_ft";
const ANCHORS_KEY = "@v2_fusion_anchors_ft";
const OBSTACLES_KEY = "@v2_obstacle_map_v1";
const SPOTS_KEY = "@start_spots_v1";

const sx = (x, f) => (Number.isFinite(x) ? Number((x * f).toFixed(2)) : x);

async function readJson(storage, key) {
  const raw = await storage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

/** The migration itself. Returns what it did (for logs / tests). */
export async function migrateTo70x72(storage = AsyncStorage) {
  if (!storage) return { ran: false, reason: "no-storage" };
  try {
    if (await storage.getItem(FLAG_KEY)) return { ran: false, reason: "already-done" };
    const size = await readJson(storage, SIZE_KEY).catch(() => null);
    const wasOldDefault = !size || (Number(size.widthFt) === OLD_W_FT && Number(size.heightFt) === OLD_H_FT);
    if (!wasOldDefault) {
      await storage.setItem(FLAG_KEY, "custom-size-kept");
      return { ran: false, reason: "custom-room-size" };
    }
    const f = FLOORPLAN_W_FT / OLD_W_FT;
    const done = [];

    if (size) {
      await storage.setItem(SIZE_KEY, JSON.stringify({ widthFt: FLOORPLAN_W_FT, heightFt: FLOORPLAN_H_FT }));
      done.push("size");
    }
    const anchors = await readJson(storage, ANCHORS_KEY).catch(() => null);
    if (anchors?.b1 && anchors?.b2) {
      await storage.setItem(ANCHORS_KEY, JSON.stringify({
        b1: { ...anchors.b1, x: sx(anchors.b1.x, f) },
        b2: { ...anchors.b2, x: sx(anchors.b2.x, f) },
      }));
      done.push("anchors");
    }
    const obstacles = await readJson(storage, OBSTACLES_KEY).catch(() => null);
    if (Array.isArray(obstacles?.items) && obstacles.items.length) {
      const items = obstacles.items.map((it) => ({
        ...it,
        ...(it.x !== undefined ? { x: sx(it.x, f) } : {}),
        ...(it.x1 !== undefined ? { x1: sx(it.x1, f) } : {}),
        ...(it.x2 !== undefined ? { x2: sx(it.x2, f) } : {}),
      }));
      await storage.setItem(OBSTACLES_KEY, JSON.stringify({ ...obstacles, items }));
      done.push("obstacles");
    }
    const spots = await readJson(storage, SPOTS_KEY).catch(() => null);
    if (Array.isArray(spots) && spots.length) {
      await storage.setItem(SPOTS_KEY, JSON.stringify(spots.map((s) => ({ ...s, x: sx(s.x, f) }))));
      done.push("start-spots");
    }
    await storage.setItem(FLAG_KEY, "done");
    return { ran: true, done };
  } catch (e) {
    // Not flagged: it is tried again on the next start.
    console.warn("[FloorplanMigration] failed:", e);
    return { ran: false, reason: "error" };
  }
}

let once = null;
/** Runs the migration once per app run; everything that loads saved positions awaits this. */
export function ensureFloorplanMigrated() {
  if (!once) once = migrateTo70x72();
  return once;
}
