// ============================================================================
// ObstacleMap.js — walls, glass, pillars and cabinets on the floor plan
//
// Why distances come out too LONG behind obstacles: every wall, pillar or
// metal cabinet between phone and beacon takes a few dB out of the signal, and
// the distance formula reads any missing dB as extra metres. 6 dB through one
// partition at n = 2.9 is x1.6 the distance; a concrete pillar can double it.
// Without obstacles the formula is nearly right - which is exactly what was
// observed in the office.
//
// This is the multi-wall model (Motley-Keenan; COST 231; ITU-R P.1238):
//
//   RSSI(d) = A - 10 n log10(d) - SUM over obstacles crossed by the ray
//                                     phone->beacon of  L(type)
//
// The obstacles are drawn once on the floor plan. For any position the ray to
// each beacon is traced, the obstacles it crosses are counted per type, and
// their loss is added back to the level BEFORE it is turned into a distance.
// The loss per type starts from typical 2.4 GHz values and is then fitted to
// this office from the calibration points (PathLossCalibrator fits it with A
// and n), because real walls vary a lot.
//
// Units: feet, map frame.
// ============================================================================

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@v2_obstacle_map_v1";

/**
 * Obstacle types, fixed order (the calibration fit uses this order).
 * lossDb: typical one-crossing loss at 2.4 GHz, the starting point that
 * calibration refines. sigmaDb: how far a real one of this kind may differ.
 */
export const OBSTACLE_TYPES = [
  { key: "wall", label: "Wall / partition", icon: "🧱", lossDb: 5, sigmaDb: 3, color: "#d29922" },
  { key: "glass", label: "Glass / cabin", icon: "🪟", lossDb: 3, sigmaDb: 2.5, color: "#58a6ff" },
  { key: "concrete", label: "Concrete wall", icon: "🏗", lossDb: 10, sigmaDb: 4, color: "#f85149" },
  { key: "pillar", label: "Pillar", icon: "⬛", lossDb: 8, sigmaDb: 4, color: "#a371f7", point: true },
  { key: "metal", label: "Metal cabinet", icon: "🗄", lossDb: 10, sigmaDb: 5, color: "#8b949e" },
];
export const OBSTACLE_KEYS = OBSTACLE_TYPES.map((t) => t.key);

/**
 * Areas nobody can walk into (cabins, desks, reception counters). Drawn as a
 * rectangle by two opposite corners. They do NOT weaken the BLE signal (walls
 * and glass do that) - they only stop the walked track, see ParticleFilter.
 */
export const AREA_TYPES = [
  { key: "nowalk", label: "No-walk area", icon: "🚫", color: "#f85149", area: true },
];
export const AREA_KEYS = AREA_TYPES.map((t) => t.key);
const ALL_KEYS = [...OBSTACLE_KEYS, ...AREA_KEYS];
export const DEFAULT_OBSTACLE_LOSS = OBSTACLE_TYPES.map((t) => t.lossDb);

// A radio wave also gets round obstacles (reflections, diffraction through
// doors and over partitions), so the loss of many obstacles is less than the
// sum. Total loss is capped here.
export const MAX_PATH_OBSTACLE_LOSS_DB = 25;
// Default pillar radius when tapped (feet).
export const DEFAULT_PILLAR_RADIUS_FT = 1.2;

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
  return t > 0 && t < 1 && u >= 0 && u <= 1;
}

/** Distance from (x, y) to a rectangle given by corners x1,y1 / x2,y2 (0 inside). */
function rectDist(x, y, r) {
  const x1 = Math.min(r.x1, r.x2), x2 = Math.max(r.x1, r.x2);
  const y1 = Math.min(r.y1, r.y2), y2 = Math.max(r.y1, r.y2);
  const dx = Math.max(x1 - x, 0, x - x2);
  const dy = Math.max(y1 - y, 0, y - y2);
  return Math.hypot(dx, dy);
}

/** Distance from point (px,py) to segment a-b. */
function pointSegDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

export class ObstacleMap {
  constructor() {
    /** @type {{id:string, type:string, x1?:number, y1?:number, x2?:number, y2?:number, x?:number, y?:number, r?:number}[]} */
    this.items = [];
    this.version = 0;
  }

  add(item) {
    if (!item || !ALL_KEYS.includes(item.type)) return null;
    const it = { ...item, id: `${Date.now()}-${Math.round(Math.random() * 1e6)}` };
    this.items.push(it);
    this.version += 1;
    return it;
  }

  removeLast() {
    const it = this.items.pop();
    if (it) this.version += 1;
    return it;
  }

  /** Removes the obstacle nearest to (x, y) if within maxFt. */
  removeNear(x, y, maxFt = 3) {
    let best = -1, bestD = maxFt;
    this.items.forEach((it, i) => {
      const d = AREA_KEYS.includes(it.type)
        ? rectDist(x, y, it)
        : it.x1 !== undefined
        ? pointSegDist(x, y, it.x1, it.y1, it.x2, it.y2)
        : Math.hypot(x - it.x, y - it.y) - (it.r || 0);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return null;
    this.version += 1;
    return this.items.splice(best, 1)[0];
  }

  clear() {
    this.items = [];
    this.version += 1;
  }

  /**
   * How many obstacles of each type the straight line p -> b crosses,
   * in OBSTACLE_TYPES order.
   */
  crossingCounts(p, b) {
    const counts = OBSTACLE_TYPES.map(() => 0);
    if (!p || !b || !Number.isFinite(p.x) || !Number.isFinite(b.x)) return counts;
    for (const it of this.items) {
      const k = OBSTACLE_KEYS.indexOf(it.type);
      if (k < 0) continue;
      if (it.x1 !== undefined) {
        if (segmentsCross(p.x, p.y, b.x, b.y, it.x1, it.y1, it.x2, it.y2)) counts[k] += 1;
      } else if (Number.isFinite(it.x)) {
        const r = it.r || DEFAULT_PILLAR_RADIUS_FT;
        // Standing inside the pillar's own footprint (tapping error) or
        // touching it does not count: the beacon must be BEHIND it.
        if (Math.hypot(p.x - it.x, p.y - it.y) <= r || Math.hypot(b.x - it.x, b.y - it.y) <= r) continue;
        if (pointSegDist(it.x, it.y, p.x, p.y, b.x, b.y) < r) counts[k] += 1;
      }
    }
    return counts;
  }

  /** Loss (dB) for given crossing counts and per-type losses, capped. */
  static lossFromCounts(counts, lossByType = DEFAULT_OBSTACLE_LOSS) {
    let L = 0;
    for (let k = 0; k < counts.length; k++) L += counts[k] * (lossByType[k] ?? DEFAULT_OBSTACLE_LOSS[k]);
    return Math.min(MAX_PATH_OBSTACLE_LOSS_DB, L);
  }

  /**
   * Expected obstacle loss from p to beacon b when p is only known to within
   * sigmaFt. Averaged over a small cloud of positions around p, so that an
   * estimate drifting across a wall changes the correction smoothly instead
   * of switching several dB - and the range by metres - at once.
   */
  expectedLoss(p, b, sigmaFt = 0, lossByType = DEFAULT_OBSTACLE_LOSS) {
    if (!this.items.length) return { lossDb: 0, counts: OBSTACLE_TYPES.map(() => 0) };
    const s = Math.max(0, Math.min(8, sigmaFt));
    const offsets = s < 0.3 ? [[0, 0]] : RING.map(([u, v]) => [u * s, v * s]);
    let sum = 0;
    let counts = null;
    for (const [ox, oy] of offsets) {
      const c = this.crossingCounts({ x: p.x + ox, y: p.y + oy }, b);
      if (!counts) counts = c;
      sum += ObstacleMap.lossFromCounts(c, lossByType);
    }
    return { lossDb: sum / offsets.length, counts };
  }

  /**
   * Expected crossing counts (per type, fractional) when p is only known to
   * within sigmaFt. The calibration fit uses these for points whose place came
   * from the walked track: a hard count there is often wrong for a narrow
   * pillar, and wrong counts drag every fitted loss toward zero.
   */
  expectedCounts(p, b, sigmaFt = 0) {
    const s = Math.max(0, Math.min(8, sigmaFt));
    const offsets = s < 0.3 ? [[0, 0]] : RING.map(([u, v]) => [u * s, v * s]);
    const sum = OBSTACLE_TYPES.map(() => 0);
    for (const [ox, oy] of offsets) {
      const c = this.crossingCounts({ x: p.x + ox, y: p.y + oy }, b);
      for (let k = 0; k < c.length; k++) sum[k] += c[k];
    }
    return sum.map((v) => v / offsets.length);
  }

  /**
   * Geometry for the particle filter: what blocks WALKING. Walls, glass and
   * metal cabinets as segments, pillars as circles, no-walk areas as
   * rectangles.
   */
  walkableMap(room = null) {
    const walls = [], circles = [], areas = [];
    for (const it of this.items) {
      if (AREA_KEYS.includes(it.type)) areas.push({ x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2 });
      else if (it.x1 !== undefined) walls.push({ x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2 });
      else if (Number.isFinite(it.x)) circles.push({ x: it.x, y: it.y, r: it.r || DEFAULT_PILLAR_RADIUS_FT });
    }
    return { walls, circles, areas, room };
  }

  toJSON() {
    return { items: this.items };
  }

  async save() {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
    } catch (e) {
      console.warn("[ObstacleMap] save error:", e);
    }
  }

  async load() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      this.items = Array.isArray(parsed.items) ? parsed.items.filter((it) => ALL_KEYS.includes(it.type)) : [];
      this.version += 1;
    } catch (e) {
      console.warn("[ObstacleMap] load error:", e);
    }
  }
}

// Centre plus two rings (unit sigma), for expectedLoss().
const RING = [[0, 0]];
for (let i = 0; i < 6; i++) RING.push([0.7 * Math.cos((i * Math.PI) / 3), 0.7 * Math.sin((i * Math.PI) / 3)]);
for (let i = 0; i < 6; i++) RING.push([1.4 * Math.cos(((i + 0.5) * Math.PI) / 3), 1.4 * Math.sin(((i + 0.5) * Math.PI) / 3)]);

/** One map shared by the app. */
export const obstacleMap = new ObstacleMap();
