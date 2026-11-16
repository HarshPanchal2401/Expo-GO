// node --no-warnings --test tests/navgraph.test.mjs   (nodes and edges built from the map)
import { test } from "node:test";
import assert from "node:assert/strict";
import { WalkableGrid, floorplanGrid } from "../services/WalkableGrid.js";
import { buildNavGraph, getNavGraph, graphRoute } from "../services/NavGraph.js";
import { findRoute } from "../services/Router.js";

/** A grid from text rows (top row first): '.' walkable, '#' blocked. One cell = 1 ft. */
function makeGrid(rows) {
  const R = rows.length, C = rows[0].length;
  const bytes = new Uint8Array(Math.ceil((R * C) / 8));
  for (let r = 0; r < R; r++) {
    const line = rows[R - 1 - r];
    for (let c = 0; c < C; c++) if (line[c] === ".") { const i = r * C + c; bytes[i >> 3] |= 1 << (i & 7); }
  }
  const g = new WalkableGrid({ cols: C, rows: R, bits: Buffer.from(bytes).toString("base64") });
  g.setRoom(C, R);
  return g;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pathLen = (pts) => pts.slice(1).reduce((s, p, i) => s + dist(p, pts[i]), 0);

// A "T": a corridor 6 wide along the top, a corridor 8 wide going down from its middle.
const T = makeGrid([
  "#".repeat(30),
  ...Array.from({ length: 6 }, () => ".".repeat(30)),
  ...Array.from({ length: 12 }, () => "#".repeat(11) + ".".repeat(8) + "#".repeat(11)),
]);

test("the map becomes nodes and edges: a junction where corridors meet, ends where they stop", () => {
  const g = buildNavGraph(T);
  assert.ok(g.nodes.length >= 3, `${g.nodes.length} nodes`);
  assert.ok(g.edges.length >= 2);
  const degree = g.adj.map((a) => a.length);
  assert.ok(degree.some((d) => d >= 3), "a junction node");
  assert.ok(degree.filter((d) => d === 1).length >= 2, "dead-end nodes");
  for (const e of g.edges) {
    for (let i = 1; i < e.points.length; i++) {
      assert.ok(T.segmentWalkable(e.points[i - 1].x, e.points[i - 1].y, e.points[i].x, e.points[i].y), "edge on the green");
    }
  }
});

test("a route runs down the middle of the corridor, not along its wall", () => {
  // From the left end of the top corridor (y 12..18, middle 15) to the bottom of the stem.
  const r = findRoute({ x: 1.5, y: 17.5 }, { x: 14.5, y: 0.5 }, { grid: T });
  assert.ok(r && r.viaGraph, "route over the graph");
  const mid = r.points.filter((p) => p.x > 3 && p.x < 10);
  assert.ok(mid.every((p) => p.y > 13 && p.y < 17), JSON.stringify(mid));
  assert.ok(r.legs.some((l) => Math.abs(l.from.x - 15) < 1.5 && Math.abs(l.to.x - 15) < 1.5 && l.to.y < l.from.y - 8), "down the middle of the stem");
  for (const l of r.legs) assert.ok(T.segmentWalkable(l.from.x, l.from.y, l.to.x, l.to.y));
});

test("the shortest way over the graph: round a loop by the short side", () => {
  // A square ring of corridor round a block; start and end on the left side and the top.
  const rows = [];
  for (let y = 0; y < 21; y++) rows.push(Array.from({ length: 21 }, (_, x) => (x < 5 || x > 15 || y < 5 || y > 15 ? "." : "#")).join(""));
  const ring = makeGrid(rows);
  const a = { x: 2.5, y: 10.5 }, b = { x: 10.5, y: 18.5 }; // left side, top side
  const r = findRoute(a, b, { grid: ring });
  assert.ok(r && r.viaGraph);
  // Up the left side then along the top: about 8 + 8 = 16, not the 50 or so the other way.
  assert.ok(r.totalFt < 24, `${r.totalFt.toFixed(1)} ft`);
});

test("unreachable stays null, a start inside a wall is moved onto the walkway", () => {
  const split = makeGrid([
    "....#....",
    "....#....",
    "....#....",
    "....#....",
    "....#....",
  ]);
  assert.equal(findRoute({ x: 1.5, y: 2.5 }, { x: 7.5, y: 2.5 }, { grid: split }), null);
  const r = findRoute({ x: 4.5, y: 2.5 }, { x: 1.5, y: 2.5 }, { grid: split }); // start on the wall
  assert.ok(r && split.isWalkable(r.start.x, r.start.y));
});

test("a short trip inside one room does not go out to the centre line and back", () => {
  const room = makeGrid(Array.from({ length: 16 }, () => ".".repeat(24)));
  const a = { x: 3.5, y: 3.5 }, b = { x: 6.5, y: 3.5 };
  const r = findRoute(a, b, { grid: room });
  assert.ok(r.totalFt < dist(a, b) * 1.3, `${r.totalFt.toFixed(1)} ft for ${dist(a, b).toFixed(1)}`);
  assert.equal(findRoute(a, a, { grid: room }).totalFt < 0.5, true, "same point: no walk");
});

test("wheelchair mode avoids a walkway that is too narrow when another way exists", () => {
  // Two ways from left to right: a wide corridor on top (6 ft), a narrow one (2 ft) below, shorter.
  const g = makeGrid([
    "####################",
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    "#.##################",
    "#.##################",
    "#.##################",
    "#...................",
    "#...................",
    "####################",
  ]);
  const a = { x: 1.5, y: 8 }, b = { x: 18.5, y: 8 };
  const normal = findRoute(a, b, { grid: g });
  const chair = findRoute(a, b, { grid: g, wheelchair: true });
  assert.ok(normal && chair);
  for (const l of chair.legs) assert.ok(g.segmentWalkable(l.from.x, l.from.y, l.to.x, l.to.y));
});

test("the real office: edges stay on the green and the corridor, cabins and hall are all joined", () => {
  const g = getNavGraph(floorplanGrid);
  assert.ok(g.nodes.length >= 8 && g.edges.length >= 8, `${g.nodes.length} nodes, ${g.edges.length} edges`);
  for (const e of g.edges) {
    for (let i = 1; i < e.points.length; i++) {
      assert.ok(floorplanGrid.segmentWalkable(e.points[i - 1].x, e.points[i - 1].y, e.points[i].x, e.points[i].y), "edge on the green");
    }
  }
  // One connected piece.
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const u = stack.pop();
    for (const ei of g.adj[u]) for (const v of [g.edges[ei].a, g.edges[ei].b]) if (!seen.has(v)) { seen.add(v); stack.push(v); }
  }
  assert.equal(seen.size, g.nodes.length, "the graph is connected");
});

test("the real office: routes follow the graph, stay on the green, and are not much longer than the shortest", () => {
  const g = floorplanGrid;
  const pts = [];
  for (let y = 2; y < 68; y += 4) for (let x = 2; x < 68; x += 4) if (g.isWalkable(x, y)) pts.push({ x, y });
  let n = 0, worst = 0, viaGraph = 0;
  for (let i = 0; i < pts.length; i += 5) {
    for (let j = 3; j < pts.length; j += 13) {
      const a = pts[i], b = pts[j];
      const r = findRoute(a, b), o = findRoute(a, b, { graph: false });
      assert.ok(r && o, "both find a route");
      n++;
      if (r.viaGraph) viaGraph++;
      for (const l of r.legs) assert.ok(g.segmentWalkable(l.from.x, l.from.y, l.to.x, l.to.y), "leg crosses gray");
      if (o.totalFt > 15) worst = Math.max(worst, r.totalFt / o.totalFt);
    }
  }
  assert.ok(n > 40, `${n} routes`);
  assert.equal(viaGraph, n, "all over the graph");
  assert.ok(worst < 1.8, `worst ${worst.toFixed(2)}x the shortest grid route`);
});
