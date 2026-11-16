// ============================================================================
// NavGraph.js — the walkways as nodes and edges, built from the map by itself
//
// The walkable grid (WalkableGrid.js) is thinned to its centre lines (skeleton:
// the line down the middle of every corridor and room). Where lines meet, end or
// bend into a different corridor there is a NODE; the line between two nodes is an
// EDGE (a polyline in feet that stays on the green). A route is then a walk over
// nodes and edges, so it runs down the middle of the corridors and turns at the
// junctions, like a road map, instead of wandering over the open floor.
//
// To route, the start and end points are joined to the nearest centre line they can
// see in a straight line (a virtual node on that edge), then Dijkstra picks the
// shortest way over the edges.
//
// Built once per map (getNavGraph caches it); building takes a few milliseconds.
// Units: feet, y up (0 at the bottom of the plan).
// ============================================================================

import { Heap } from "./Heap.js";

export const GRAPH_CONFIG = {
  // A branch ending in nothing and shorter than this is noise of the thinning (ft).
  SPUR_FT: 4,
  // Edge polylines are simplified to within this of the centre line (ft).
  SIMPLIFY_FT: 1.0,
  // A start or end point is joined to a centre line at most this far away (ft).
  SNAP_MAX_FT: 30,
  // Pieces of skeleton smaller than this are dropped (cells).
  MIN_PIECE_CELLS: 4,
};

// Neighbours clockwise from "up" (row - 1). Even indices are the 4 straight ones.
const RING = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];

/** Zhang-Suen thinning: the centre lines of the 1-cells, one cell wide. */
function thin(src, R, C) {
  const a = Uint8Array.from(src);
  const at = (r, c) => (r < 0 || c < 0 || r >= R || c >= C ? 0 : a[r * C + c]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const del = [];
      for (let r = 0; r < R; r++) {
        for (let c = 0; c < C; c++) {
          if (!a[r * C + c]) continue;
          const p = RING.map(([dr, dc]) => at(r + dr, c + dc));
          const B = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
          if (B < 2 || B > 6) continue;
          let A = 0;
          for (let k = 0; k < 8; k++) if (p[k] === 0 && p[(k + 1) % 8] === 1) A++;
          if (A !== 1) continue;
          const [p2, , p4, , p6, , p8] = p;
          if (pass === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          del.push(r * C + c);
        }
      }
      for (const i of del) a[i] = 0;
      if (del.length) changed = true;
    }
  }
  return a;
}

/** Perpendicular distance from p to the line a-b. */
const lineDist = (p, a, b) => {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l = Math.hypot(vx, vy);
  return l ? Math.abs((p.x - a.x) * vy - (p.y - a.y) * vx) / l : Math.hypot(p.x - a.x, p.y - a.y);
};

/** Douglas-Peucker; a piece is also split when its straight line would leave the green. */
function simplify(pts, tol, grid) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j <= i + 1) continue;
    let worst = -1, wi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = lineDist(pts[k], pts[i], pts[j]);
      if (d > worst) { worst = d; wi = k; }
    }
    if (worst > tol || !grid.segmentWalkable(pts[i].x, pts[i].y, pts[j].x, pts[j].y)) {
      keep[wi] = 1;
      stack.push([i, wi], [wi, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

const polyLen = (pts) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
};

/**
 * The graph of the walkable area: { nodes: [{id,x,y}], edges: [{a,b,points,len,minClear}] }.
 * clearAt(x, y) (optional) gives the distance to the nearest wall, for each edge's minClear.
 */
export function buildNavGraph(grid, clearAt = null, config = {}) {
  const cfg = { ...GRAPH_CONFIG, ...config };
  const { rows: R, cols: C } = grid;
  const cell = Math.min(grid.cw, grid.ch);
  const sk = thin(grid.cells, R, C);
  const at = (r, c) => (r < 0 || c < 0 || r >= R || c >= C ? 0 : sk[r * C + c]);
  const toPt = (r, c) => ({ x: (c + 0.5) * grid.cw, y: (r + 0.5) * grid.ch });

  // Crossing number: how many separate branches meet at a cell (1 end, 2 line, 3+ junction).
  const crossing = (r, c) => {
    const p = RING.map(([dr, dc]) => at(r + dr, c + dc));
    let n = 0;
    for (let k = 0; k < 8; k++) if (p[k] === 0 && p[(k + 1) % 8] === 1) n++;
    return n;
  };

  // Drop specks of skeleton.
  const seen = new Uint8Array(R * C);
  for (let s = 0; s < R * C; s++) {
    if (!sk[s] || seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let q = 0; q < comp.length; q++) {
      const r = Math.floor(comp[q] / C), c = comp[q] % C;
      for (const [dr, dc] of RING) {
        const rr = r + dr, cc = c + dc, j = rr * C + cc;
        if (at(rr, cc) && !seen[j]) { seen[j] = 1; comp.push(j); }
      }
    }
    if (comp.length < cfg.MIN_PIECE_CELLS) for (const j of comp) sk[j] = 0;
  }

  // Nodes: junction cells (grouped when they touch) and the ends of lines.
  const nodeOf = new Int32Array(R * C).fill(-1);
  const nodes = [];
  const kind = new Int8Array(R * C); // 1 end, 3 junction
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (!at(r, c)) continue;
      const n = crossing(r, c);
      kind[r * C + c] = n >= 3 ? 3 : n === 1 ? 1 : 0;
    }
  }
  for (let s = 0; s < R * C; s++) {
    if (!kind[s] || nodeOf[s] >= 0) continue;
    const id = nodes.length;
    const group = [s];
    nodeOf[s] = id;
    if (kind[s] === 3) {
      for (let q = 0; q < group.length; q++) {
        const r = Math.floor(group[q] / C), c = group[q] % C;
        for (const [dr, dc] of RING) {
          const rr = r + dr, cc = c + dc, j = rr * C + cc;
          if (at(rr, cc) && kind[j] === 3 && nodeOf[j] < 0) { nodeOf[j] = id; group.push(j); }
        }
      }
    }
    let sr = 0, sc = 0;
    for (const j of group) { sr += Math.floor(j / C); sc += j % C; }
    nodes.push({ id, ...toPt(sr / group.length, sc / group.length), cells: group });
  }

  // Edges: walk the single-cell-wide lines from each node to the next.
  const visited = new Uint8Array(R * C);
  let edges = [];
  const walk = (startNode, fromCell, firstCell) => {
    const chain = [firstCell];
    visited[firstCell] = 1;
    let prev = fromCell, cur = firstCell;
    for (let guard = 0; guard < R * C; guard++) {
      const r = Math.floor(cur / C), c = cur % C;
      let end = -1, next = -1, nextStraight = false;
      for (let k = 0; k < 8; k++) {
        const rr = r + RING[k][0], cc = c + RING[k][1], j = rr * C + cc;
        if (!at(rr, cc) || j === prev || chain.includes(j)) continue;
        if (nodeOf[j] >= 0) { // a node: the end, except right at the start (the node's own cells)
          if (nodeOf[j] === startNode && chain.length < 3) continue;
          end = j;
          break;
        }
        if (visited[j]) continue;
        const straight = k % 2 === 0;
        if (next < 0 || (straight && !nextStraight)) { next = j; nextStraight = straight; }
      }
      if (end >= 0) return { chain, endNode: nodeOf[end], endCell: end };
      if (next < 0) return null; // a stub that goes nowhere
      visited[next] = 1;
      chain.push(next);
      prev = cur;
      cur = next;
    }
    return null;
  };
  const addEdge = (a, b, cells) => {
    const pts = [{ x: nodes[a].x, y: nodes[a].y }, ...cells.map((j) => toPt(Math.floor(j / C), j % C)), { x: nodes[b].x, y: nodes[b].y }];
    edges.push({ a, b, points: simplify(pts, cfg.SIMPLIFY_FT, grid) });
  };
  for (const n of nodes) {
    for (const s of n.cells) {
      const r = Math.floor(s / C), c = s % C;
      for (const [dr, dc] of RING) {
        const rr = r + dr, cc = c + dc, j = rr * C + cc;
        if (!at(rr, cc) || nodeOf[j] === n.id) continue;
        if (nodeOf[j] >= 0) { // two nodes side by side
          if (nodeOf[j] > n.id) addEdge(n.id, nodeOf[j], []);
          continue;
        }
        if (visited[j]) continue;
        const w = walk(n.id, s, j);
        if (w && (w.endNode !== n.id || w.chain.length >= 6)) addEdge(n.id, w.endNode, w.chain);
      }
    }
  }
  // A ring of line with no node on it (round a pillar): one node, one looping edge.
  for (let s = 0; s < R * C; s++) {
    if (!sk[s] || visited[s] || nodeOf[s] >= 0) continue;
    const id = nodes.length;
    nodeOf[s] = id;
    nodes.push({ id, ...toPt(Math.floor(s / C), s % C), cells: [s] });
    const r = Math.floor(s / C), c = s % C;
    for (const [dr, dc] of RING) {
      const rr = r + dr, cc = c + dc, j = rr * C + cc;
      if (!at(rr, cc) || visited[j] || nodeOf[j] >= 0) continue;
      const w = walk(id, s, j);
      if (w && w.endNode === id && w.chain.length >= 6) addEdge(id, id, w.chain);
      break;
    }
  }

  // Short dead ends are noise of the thinning: remove them, then join the pieces left at
  // a bend (a node with two edges is not a junction).
  const incident = (id) => edges.filter((e) => e.a === id || e.b === id);
  for (let changed = true; changed;) {
    changed = false;
    for (const n of nodes) {
      const inc = incident(n.id);
      if (inc.length !== 1 || inc[0].a === inc[0].b) continue;
      if (polyLen(inc[0].points) < cfg.SPUR_FT) { edges = edges.filter((e) => e !== inc[0]); changed = true; }
    }
    for (const n of nodes) {
      const inc = incident(n.id);
      if (inc.length !== 2 || inc[0] === inc[1] || inc[0].a === inc[0].b || inc[1].a === inc[1].b) continue;
      const [e1, e2] = inc;
      const p1 = e1.b === n.id ? e1.points : [...e1.points].reverse(), o1 = e1.b === n.id ? e1.a : e1.b;
      const p2 = e2.a === n.id ? e2.points : [...e2.points].reverse(), o2 = e2.a === n.id ? e2.b : e2.a;
      edges = edges.filter((e) => e !== e1 && e !== e2);
      edges.push({ a: o1, b: o2, points: simplify([...p1, ...p2.slice(1)], cfg.SIMPLIFY_FT, grid) });
      changed = true;
      break;
    }
  }

  // Keep the nodes still in use, renumbered.
  const used = new Map();
  const outNodes = [];
  const idOf = (old) => {
    if (!used.has(old)) { used.set(old, outNodes.length); outNodes.push({ id: outNodes.length, x: nodes[old].x, y: nodes[old].y }); }
    return used.get(old);
  };
  const outEdges = edges.map((e) => {
    const a = idOf(e.a), b = idOf(e.b);
    const points = e.points.map((p) => ({ x: p.x, y: p.y }));
    points[0] = { x: outNodes[a].x, y: outNodes[a].y };
    points[points.length - 1] = { x: outNodes[b].x, y: outNodes[b].y };
    let minClear = Infinity;
    if (clearAt) {
      const len = polyLen(points);
      const steps = Math.max(1, Math.ceil(len / cell));
      for (let k = 0; k <= steps; k++) {
        let f = (k / steps) * len, i = 1;
        while (i < points.length - 1 && f > Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)) {
          f -= Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
          i++;
        }
        const s0 = points[i - 1], s1 = points[i], sl = Math.hypot(s1.x - s0.x, s1.y - s0.y) || 1;
        minClear = Math.min(minClear, clearAt(s0.x + ((s1.x - s0.x) * f) / sl, s0.y + ((s1.y - s0.y) * f) / sl));
      }
    }
    return { a, b, points, len: polyLen(points), minClear };
  });
  const adj = outNodes.map(() => []);
  outEdges.forEach((e, i) => { adj[e.a].push(i); if (e.b !== e.a) adj[e.b].push(i); });
  return { nodes: outNodes, edges: outEdges, adj, skeleton: sk };
}

const cache = new WeakMap();
/** The graph of a grid, built once (again if the room is resized). */
export function getNavGraph(grid, clearAt = null) {
  const hit = cache.get(grid);
  if (hit && hit.cw === grid.cw && hit.ch === grid.ch) return hit.graph;
  const graph = buildNavGraph(grid, clearAt);
  cache.set(grid, { cw: grid.cw, ch: grid.ch, graph });
  return graph;
}

// ── Routing over the graph ──

/** Closest point of segment a-b to p: { q, t (0..1), d }. */
function nearOnSegment(a, b, p) {
  const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
  const q = { x: a.x + t * vx, y: a.y + t * vy };
  return { q, t, d: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** The nearest point on the graph that p can reach in a straight line over the green. */
export function snapToGraph(graph, grid, p, { minClear = 0, maxFt = GRAPH_CONFIG.SNAP_MAX_FT } = {}) {
  let best = null;
  graph.edges.forEach((e, ei) => {
    if (e.minClear < minClear) return;
    let acc = 0;
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1], b = e.points[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const r = nearOnSegment(a, b, p);
      if (r.d <= maxFt && (!best || r.d < best.d) && grid.segmentWalkable(p.x, p.y, r.q.x, r.q.y)) {
        best = { edge: ei, along: acc + r.t * segLen, q: r.q, d: r.d };
      }
      acc += segLen;
    }
  });
  return best;
}

/** The points of an edge from distance s0 to s1 along it (either direction). */
function slice(edge, s0, s1) {
  const pts = edge.points;
  const at = (s) => {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (acc + l >= s || i === pts.length - 1) {
        const f = l ? Math.max(0, Math.min(1, (s - acc) / l)) : 0;
        return { i, p: { x: pts[i - 1].x + f * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + f * (pts[i].y - pts[i - 1].y) } };
      }
      acc += l;
    }
    return { i: 1, p: pts[0] };
  };
  const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
  const A = at(lo), B = at(hi);
  const out = [A.p, ...pts.slice(A.i, B.i), B.p];
  return s0 <= s1 ? out : out.reverse();
}

/**
 * The shortest way over the graph from a to b (both on the green): the points from a
 * to b, or null when they cannot be joined. opts: { minClear }.
 */
export function graphRoute(graph, grid, a, b, opts = {}) {
  const sa = snapToGraph(graph, grid, a, opts), sb = snapToGraph(graph, grid, b, opts);
  if (!sa || !sb) return null;
  const N = graph.nodes.length, S = N, E = N + 1;
  const ok = (ei) => graph.edges[ei].minClear >= (opts.minClear || 0);
  const neighbours = (u) => {
    const out = [];
    if (u === S || u === E) {
      const s = u === S ? sa : sb, e = graph.edges[s.edge];
      out.push([e.a, s.along, { edge: s.edge, from: s.along, to: 0 }], [e.b, e.len - s.along, { edge: s.edge, from: s.along, to: e.len }]);
      if (u === S && sb.edge === sa.edge) out.push([E, Math.abs(sb.along - sa.along), { edge: sa.edge, from: sa.along, to: sb.along }]);
      return out;
    }
    for (const ei of graph.adj[u]) {
      if (!ok(ei)) continue;
      const e = graph.edges[ei];
      if (e.a === e.b) continue;
      const other = e.a === u ? e.b : e.a;
      out.push([other, e.len, e.a === u ? { edge: ei, from: 0, to: e.len } : { edge: ei, from: e.len, to: 0 }]);
    }
    for (const [vs, s] of [[S, sa], [E, sb]]) {
      const e = graph.edges[s.edge];
      if (e.a === u) out.push([vs, s.along, { edge: s.edge, from: 0, to: s.along }]);
      if (e.b === u) out.push([vs, e.len - s.along, { edge: s.edge, from: e.len, to: s.along }]);
    }
    return out;
  };
  const dist = new Float64Array(N + 2).fill(Infinity), prev = new Array(N + 2).fill(null);
  const heap = new Heap();
  dist[S] = 0;
  heap.push(0, S);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > dist[u]) continue;
    if (u === E) break;
    for (const [v, w, how] of neighbours(u)) {
      if (d + w < dist[v]) { dist[v] = d + w; prev[v] = { u, how }; heap.push(dist[v], v); }
    }
  }
  if (!Number.isFinite(dist[E])) return null;
  const steps = [];
  for (let v = E; v !== S; v = prev[v].u) steps.push(prev[v].how);
  steps.reverse();
  const pts = [{ x: a.x, y: a.y }, sa.q];
  for (const st of steps) pts.push(...slice(graph.edges[st.edge], st.from, st.to));
  pts.push(sb.q, { x: b.x, y: b.y });
  // No repeated points, and no point that is only on a straight stretch.
  const out = [];
  for (const p of pts) {
    if (out.length && Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) < 1e-6) continue;
    out.push(p);
  }
  return out;
}
