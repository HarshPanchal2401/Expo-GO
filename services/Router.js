// ============================================================================
// Router.js — the shortest walkable route from A to B on the floor plan
//
// A* over the walkable grid (WalkableGrid.js): a straight step costs 1, a
// diagonal 1.414, no cutting past a blocked corner. Cells close to a wall cost
// extra, so the route runs down the middle of a corridor: the dot wobbles by a
// foot or two, and a route scraping a wall would have it "off the route" often.
// Wheelchair mode keeps a wider berth.
//
// The cell path is then cut to the corners that are needed (a straight piece
// stays at least a little clear of the walls) and split into legs, each with its
// bearing and the turn made at its start.
//
// Pure: no UI, no storage. Units: feet, y up. Bearing: clockwise from the map's
// up (the same as the heading), in [-180, 180).
// ============================================================================

import { floorplanGrid } from "./WalkableGrid.js";

export const ROUTER_CONFIG = {
  // Keep this far from walls when the floor allows it (ft).
  CLEAR_FT: 1.5,
  CLEAR_FT_WHEELCHAIR: 2.5,
  // Cost added to a step in a cell touching a wall, falling to 0 at CLEAR_FT.
  WALL_PENALTY: 1.5,
  // A bend smaller than this is "straight on" (deg); a bend beyond U_TURN_DEG turns back.
  STRAIGHT_DEG: 25,
  U_TURN_DEG: 150,
  // How far a start or end point off the green may be moved onto it (ft).
  SNAP_FT: 6,
};

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const bearingOf = (a, b) => (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;

// ── Clearance: distance of every cell to the nearest blocked cell (ft) ──
const clearanceCache = new WeakMap();

function clearanceOf(grid) {
  const hit = clearanceCache.get(grid);
  if (hit && hit.cw === grid.cw && hit.ch === grid.ch) return hit.d;
  const { cols, rows, cells } = grid;
  const INF = 1e9;
  const d = new Float32Array(cols * rows);
  // Two-pass chamfer transform in cells (1 / 1.414); outside the plan is blocked.
  for (let i = 0; i < d.length; i++) d[i] = cells[i] ? INF : 0;
  const at = (r, c) => (r < 0 || c < 0 || r >= rows || c >= cols ? 0 : d[r * cols + c]);
  const D = Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(r, c - 1) + 1, at(r - 1, c) + 1, at(r - 1, c - 1) + D, at(r - 1, c + 1) + D);
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(r, c + 1) + 1, at(r + 1, c) + 1, at(r + 1, c + 1) + D, at(r + 1, c - 1) + D);
    }
  }
  const cell = Math.min(grid.cw, grid.ch);
  for (let i = 0; i < d.length; i++) d[i] = d[i] * cell - cell / 2; // centre of a cell to the edge of a blocked one
  clearanceCache.set(grid, { cw: grid.cw, ch: grid.ch, d });
  return d;
}

/** Distance (ft) from a point to the nearest wall or gray, 0 off the green. */
function clearanceAt(grid, d, x, y) {
  const i = grid._cell(x, y);
  return i < 0 || !grid.cells[i] ? 0 : Math.max(0, d[i]);
}

// ── A small binary heap of [priority, cell] ──
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(p, v) {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j][0] <= a[i][0]) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/** A point on the green near p (so a start or a place inside a wall still routes), or null. */
function snap(grid, p, cfg) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  if (grid.isWalkable(p.x, p.y)) return { x: p.x, y: p.y };
  const n = grid.nearest(p, cfg.SNAP_FT);
  return n && n.distFt <= cfg.SNAP_FT ? { x: n.x, y: n.y } : null;
}

/** Whether the straight piece a→b is on the green and keeps at least `need` ft from walls (except near its ends). */
function pieceClear(grid, d, a, b, need) {
  if (!grid.segmentWalkable(a.x, a.y, b.x, b.y)) return false;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / Math.min(grid.cw, grid.ch)));
  const lim = Math.min(need, clearanceAt(grid, d, a.x, a.y), clearanceAt(grid, d, b.x, b.y));
  for (let k = 1; k < n; k++) {
    const f = k / n;
    if (clearanceAt(grid, d, a.x + f * (b.x - a.x), a.y + f * (b.y - a.y)) < lim - 1e-6) return false;
  }
  return true;
}

/** Legs of a polyline: bearing, length, and the turn made at the start of each. */
export function buildLegs(points, cfg = ROUTER_CONFIG) {
  const legs = [];
  let prev = null;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i], to = points[i + 1];
    const lengthFt = Math.hypot(to.x - from.x, to.y - from.y);
    if (lengthFt < 1e-6) continue;
    const bearing = bearingOf(from, to);
    let turn = "straight", turnDeg = 0;
    if (prev !== null) {
      turnDeg = wrap180(bearing - prev);
      const m = Math.abs(turnDeg);
      if (m >= cfg.U_TURN_DEG) turn = "u-turn";
      else if (m >= cfg.STRAIGHT_DEG) turn = turnDeg > 0 ? "right" : "left";
    }
    legs.push({ from, to, lengthFt, bearing, turn, turnDeg });
    prev = bearing;
  }
  return legs;
}

/**
 * The route from a to b: { points, legs, totalFt } (points start at a and end at b),
 * or null when b cannot be reached. opts: { wheelchair, grid }.
 */
export function findRoute(a, b, opts = {}) {
  const grid = opts.grid || floorplanGrid;
  const cfg = { ...ROUTER_CONFIG, ...(opts.config || {}) };
  const clearFt = opts.wheelchair ? cfg.CLEAR_FT_WHEELCHAIR : cfg.CLEAR_FT;
  const sa = snap(grid, a, cfg), sb = snap(grid, b, cfg);
  if (!sa || !sb) return null;
  const ca = grid._cell(sa.x, sa.y), cb = grid._cell(sb.x, sb.y);
  const { cols, rows, cells } = grid;
  const clear = clearanceOf(grid);
  const cell = Math.min(grid.cw, grid.ch);

  let cellPath;
  if (ca === cb) {
    cellPath = [ca];
  } else {
    const G = new Float32Array(cols * rows).fill(Infinity);
    const prev = new Int32Array(cols * rows).fill(-1);
    const closed = new Uint8Array(cols * rows);
    const tc = cb % cols, tr = Math.floor(cb / cols);
    const h = (c, r) => Math.hypot((c - tc) * grid.cw, (r - tr) * grid.ch);
    const heap = new Heap();
    G[ca] = 0;
    heap.push(h(ca % cols, Math.floor(ca / cols)), ca);
    while (heap.size) {
      const [, i] = heap.pop();
      if (closed[i]) continue;
      closed[i] = 1;
      if (i === cb) break;
      const r = Math.floor(i / cols), c = i % cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const j = rr * cols + cc;
          if (!cells[j] || closed[j]) continue;
          if (dr && dc && (!cells[r * cols + cc] || !cells[rr * cols + c])) continue; // no cutting a blocked corner
          const step = Math.hypot(dc * grid.cw, dr * grid.ch);
          const near = Math.max(0, (clearFt - Math.max(0, clear[j])) / clearFt); // 1 touching a wall, 0 clear
          const g = G[i] + step * (1 + cfg.WALL_PENALTY * near);
          if (g < G[j]) {
            G[j] = g;
            prev[j] = i;
            heap.push(g + h(cc, rr), j);
          }
        }
      }
    }
    if (!closed[cb]) return null;
    cellPath = [];
    for (let i = cb; i !== -1; i = prev[i]) cellPath.push(i);
    cellPath.reverse();
  }

  const pts = cellPath.map((i) => ({ x: ((i % cols) + 0.5) * grid.cw, y: (Math.floor(i / cols) + 0.5) * grid.ch }));
  pts[0] = { x: sa.x, y: sa.y };
  if (pts.length > 1) pts[pts.length - 1] = { x: sb.x, y: sb.y };
  else pts.push({ x: sb.x, y: sb.y });

  // Keep the corners that are needed: from each kept point jump to the farthest one in clear sight.
  const need = Math.min(clearFt * 0.5, cell * 3);
  const out = [pts[0]];
  let k = 0;
  while (k < pts.length - 1) {
    let j = pts.length - 1;
    while (j > k + 1 && !pieceClear(grid, clear, pts[k], pts[j], need)) j--;
    out.push(pts[j]);
    k = j;
  }
  const points = out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y) > 1e-6);
  if (points.length < 2) points.push({ x: sb.x, y: sb.y });
  const legs = buildLegs(points, cfg);
  return { points, legs, totalFt: legs.reduce((s, l) => s + l.lengthFt, 0), start: sa, end: sb };
}
