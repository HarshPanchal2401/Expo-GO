// node --no-warnings --test tests/router.test.mjs   (synthetic grids + the real office plan)
import { test } from "node:test";
import assert from "node:assert/strict";
import { WalkableGrid, floorplanGrid } from "../services/WalkableGrid.js";
import { findRoute } from "../services/Router.js";

/** A grid from text rows (top row first): '.' walkable, '#' blocked. One cell = 1 ft. */
function makeGrid(rows) {
  const R = rows.length, C = rows[0].length;
  const bytes = new Uint8Array(Math.ceil((R * C) / 8));
  for (let r = 0; r < R; r++) {
    const line = rows[R - 1 - r]; // row 0 is the bottom
    for (let c = 0; c < C; c++) {
      if (line[c] === ".") {
        const i = r * C + c;
        bytes[i >> 3] |= 1 << (i & 7);
      }
    }
  }
  const g = new WalkableGrid({ cols: C, rows: R, bits: Buffer.from(bytes).toString("base64") });
  g.setRoom(C, R);
  return g;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const open = makeGrid(Array.from({ length: 20 }, () => ".".repeat(30)));

test("open floor: the route is the straight line", () => {
  const r = findRoute({ x: 3.5, y: 3.5 }, { x: 25.5, y: 15.5 }, { grid: open });
  assert.ok(r, "route found");
  assert.equal(r.points.length, 2);
  assert.ok(Math.abs(r.totalFt - dist({ x: 3.5, y: 3.5 }, { x: 25.5, y: 15.5 })) < 1e-6);
  assert.equal(r.legs.length, 1);
});

test("a wall in the way: goes round it, never crosses a blocked cell", () => {
  const g = makeGrid([
    "..............",
    "..............",
    "......#.......",
    "......#.......",
    "......#.......",
    "......#.......",
    "..............",
  ]);
  const r = findRoute({ x: 1.5, y: 3.5 }, { x: 12.5, y: 3.5 }, { grid: g });
  assert.ok(r);
  for (const l of r.legs) assert.ok(g.segmentWalkable(l.from.x, l.from.y, l.to.x, l.to.y), "leg on the green");
  assert.ok(r.totalFt > 11 && r.totalFt < 16, `length ${r.totalFt.toFixed(1)}`);
});

test("unreachable: null", () => {
  const g = makeGrid([
    "....#....",
    "....#....",
    "....#....",
  ]);
  assert.equal(findRoute({ x: 1.5, y: 1.5 }, { x: 7.5, y: 1.5 }, { grid: g }), null);
  assert.equal(findRoute({ x: 1.5, y: 1.5 }, { x: NaN, y: 1 }, { grid: g }), null);
});

test("a start or end inside a wall is moved onto the green", () => {
  const g = makeGrid([
    "..........",
    "....##....",
    "..........",
  ]);
  const r = findRoute({ x: 1.5, y: 1.5 }, { x: 4.5, y: 1.5 }, { grid: g }); // end is on '#'
  assert.ok(r);
  assert.ok(g.isWalkable(r.end.x, r.end.y));
});

test("same cell: a one-point hop, no crash", () => {
  const r = findRoute({ x: 5.2, y: 5.2 }, { x: 5.4, y: 5.4 }, { grid: open });
  assert.ok(r && r.points.length >= 2 && r.totalFt < 1);
});

test("legs: turns are named from the bearing change", () => {
  const g = makeGrid([
    "#######.#######",
    "#######.#######",
    "#######.#######",
    "#######.#######",
    "...............",
    "...............",
  ]);
  // From the left end, east along the bottom, then north up the gap: a left turn (map up is north).
  const r = findRoute({ x: 1.5, y: 0.5 }, { x: 7.5, y: 8.5 }, { grid: g, config: { CLEAR_FT: 0.5 } });
  assert.ok(r);
  const turns = r.legs.map((l) => l.turn).filter((t) => t !== "straight");
  assert.ok(turns.length >= 1 && turns.every((t) => t === "left"), `turns: ${r.legs.map((l) => l.turn)}`);
});

test("round a corner the route keeps clear of the inside wall (and a bit longer for it)", () => {
  // An L-shaped corridor 7 ft wide: down the left arm, then east along the top arm. Inside corner at (7, 13).
  const rows = [];
  for (let y = 0; y < 20; y++) rows.push(Array.from({ length: 30 }, (_, x) => (y < 7 || x < 7 ? "." : "#")).join(""));
  const g = makeGrid(rows);
  const a = { x: 3.5, y: 1.5 }, b = { x: 28.5, y: 16.5 };
  const tight = findRoute(a, b, { grid: g, config: { WALL_PENALTY: 0 } });
  const clear = findRoute(a, b, { grid: g });
  const away = (r) => Math.min(...r.points.slice(1, -1).map((p) => dist(p, { x: 7, y: 13 })));
  assert.ok(away(clear) > away(tight) + 0.5, `clear ${away(clear).toFixed(1)} ft vs tight ${away(tight).toFixed(1)} ft`);
  assert.ok(clear.totalFt < tight.totalFt * 1.1, "not much longer");
});

test("the real office: a route between two far points stays on the green and is not much longer than the straight line", () => {
  const g = floorplanGrid;
  const pts = [];
  for (let y = 2; y < 68; y += 4) for (let x = 2; x < 68; x += 4) if (g.isWalkable(x, y)) pts.push({ x, y });
  assert.ok(pts.length > 50, "walkable samples");
  let checked = 0, ratioWorst = 0;
  for (let i = 0; i < pts.length; i += 7) {
    const a = pts[i], b = pts[(i * 5 + 11) % pts.length];
    const r = findRoute(a, b);
    if (!r) continue; // separate areas of the plan
    checked++;
    for (const l of r.legs) assert.ok(g.segmentWalkable(l.from.x, l.from.y, l.to.x, l.to.y), "leg crosses gray");
    const old = g.route(a, b);
    if (old) {
      let oldLen = 0, p = a;
      for (const q of old) { oldLen += dist(p, q); p = q; }
      ratioWorst = Math.max(ratioWorst, r.totalFt / Math.max(oldLen, 1));
    }
  }
  assert.ok(checked > 5, `${checked} routes checked`);
  assert.ok(ratioWorst < 1.25, `worst route is ${ratioWorst.toFixed(2)}x the old one`);
});
