// ============================================================================
// Router.js — the shortest walkable route from A to B on the floor plan
//
// The walkways are a graph of nodes and edges built from the map by itself
// (NavGraph.js: centre lines of the corridors and rooms, nodes where they meet or
// end). A route joins the start and the end to the nearest centre line and takes the
// shortest way over the edges, so it runs down the middle of the corridors and turns
// at the junctions, like a road map. If the graph cannot join the two (a point it
// cannot reach), the route falls back to A* over the walkable grid: a straight step
// costs 1, a diagonal 1.414, cells near a wall cost extra, and the cell path is cut
// to the corners that are needed. Wheelchair mode keeps a wider berth.
//
// The route is split into legs, each with its bearing and the turn made at its start.
//
// Pure: no UI, no storage. Units: feet, y up. Bearing: clockwise from the map's
// up (the same as the heading), in [-180, 180).
// ============================================================================

import { floorplanGrid } from "./WalkableGrid.js";
import { Heap } from "./Heap.js";
import { getNavGraph, graphRoute } from "./NavGraph.js";

export const ROUTER_CONFIG = {
  // Keep this far from walls when the floor allows it (ft).
  CLEAR_FT: 1.5,
  CLEAR_FT_WHEELCHAIR: 2.5,
  // Cost added to a step in a cell touching a wall, falling to 0 at CLEAR_FT.
  WALL_PENALTY: 1.5,
  // A bend smaller than this is "straight on" (deg); a bend beyond U_TURN_DEG turns back.
  STRAIGHT_DEG: 25,
  U_TURN_DEG: 150,
  // The first and last stretch of a route may cut straight to the route, this far from walls (ft).
  END_CLEAR_FT: 1.0,
  // ...but only where it cuts off a detour: the skipped points are within this of the line (ft).
  END_CUT_TOL_FT: 1.5,
  // ...or where the way round is this many times longer than the straight line.
  END_DETOUR_RATIO: 1.6,
  // Wheelchair mode avoids walkways narrower than this (clear distance to the wall, ft), if it can.
  WHEELCHAIR_MIN_CLEAR_FT: 1.25,
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
 * A route over the graph starts by walking from the start point to the centre line and
 * ends by walking from it to the end point. Where the start (or end) can see farther along
 * the route in a straight line, keeping `need` ft from the walls, that line is used instead,
 * so a short trip inside a room does not go out to the centre line and back.
 */
function trimEnds(pts, grid, clear, need, tol, ratio) {
  // Distance from p to the segment a-b.
  const off = (p, a, b) => {
    const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  };
  // Only a detour is cut: the points skipped lie near the new straight line, or the way they
  // make is much longer than that line (out to the centre line and back). Not a corner.
  const cuts = (list, i, j) => {
    const skipped = list.slice(i + 1, j);
    if (skipped.every((p) => off(p, list[i], list[j]) <= tol)) return true;
    let way = 0;
    for (let k = i + 1; k <= j; k++) way += Math.hypot(list[k].x - list[k - 1].x, list[k].y - list[k - 1].y);
    return way > ratio * Math.hypot(list[j].x - list[i].x, list[j].y - list[i].y) + 2;
  };
  let out = pts;
  for (let j = out.length - 1; j >= 2; j--) {
    if (cuts(out, 0, j) && pieceClear(grid, clear, out[0], out[j], need)) { out = [out[0], ...out.slice(j)]; break; }
  }
  for (let j = 0; j < out.length - 2; j++) {
    if (cuts(out, j, out.length - 1) && pieceClear(grid, clear, out[j], out[out.length - 1], need)) { out = [...out.slice(0, j + 1), out[out.length - 1]]; break; }
  }
  return out;
}

/**
 * Drops the points that are only on a straight stretch, and short spikes where the
 * line goes out and straight back (joining the start to the centre line), keeping every
 * piece on the green.
 */
export function tidyPoints(points, grid, cfg = ROUTER_CONFIG) {
  let pts = points.map((p) => ({ x: p.x, y: p.y }));
  for (let changed = true; changed && pts.length > 2;) {
    changed = false;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], p = pts[i], b = pts[i + 1];
      const l1 = Math.hypot(p.x - a.x, p.y - a.y), l2 = Math.hypot(b.x - p.x, b.y - p.y);
      const turn = Math.abs(wrap180(bearingOf(p, b) - bearingOf(a, p)));
      const straight = turn < 3 || l1 < 1e-6 || l2 < 1e-6;
      const spike = turn > cfg.U_TURN_DEG && Math.min(l1, l2) < 2;
      if ((straight || spike) && grid.segmentWalkable(a.x, a.y, b.x, b.y)) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/**
 * The route from a to b: { points, legs, totalFt } (points start at a and end at b),
 * or null when b cannot be reached. opts: { wheelchair, grid, graph (false = A* only) }.
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

  if (opts.graph !== false) {
    const graph = getNavGraph(grid, (x, y) => clearanceAt(grid, clear, x, y));
    let pts = null;
    if (opts.wheelchair) pts = graphRoute(graph, grid, sa, sb, { minClear: cfg.WHEELCHAIR_MIN_CLEAR_FT });
    if (!pts) pts = graphRoute(graph, grid, sa, sb);
    if (pts) {
      const points = tidyPoints(trimEnds(pts, grid, clear, cfg.END_CLEAR_FT, cfg.END_CUT_TOL_FT, cfg.END_DETOUR_RATIO), grid, cfg);
      if (points.length < 2) points.push({ x: sb.x, y: sb.y });
      const legs = buildLegs(points, cfg);
      return { points, legs, totalFt: legs.reduce((s, l) => s + l.lengthFt, 0), start: sa, end: sb, viaGraph: true };
    }
  }

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
