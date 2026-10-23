// node --no-warnings --test tests/initial-position.test.mjs   (synthetic ranges)
import { test } from "node:test";
import assert from "node:assert/strict";
import { intersectRangeCircles, solveInitialPosition } from "../services/InitialPositionSolver.js";

const A1 = { x: 10, y: 36 }, A2 = { x: 62, y: 36 }; // 52 ft apart
const room = { width: 72, height: 72 };
const dist = (p, a) => Math.hypot(p.x - a.x, p.y - a.y);

test("circles that do not meet: the closer beacon's range is kept, the farther one is adjusted more", () => {
  // Real spot 8 ft from B1 on the line; B2 reads too short (28 instead of 44), so the circles fall 16 ft short.
  const w = intersectRangeCircles(A1, 8, A2, 28);
  const eq = intersectRangeCircles(A1, 8, A2, 28, undefined, { s1: 10, s2: 10 }); // equal trust, for comparison
  assert.equal(w.adjusted, true);
  const dW = dist(w.candidates[0], A1);
  const dE = dist(eq.candidates[0], A1);
  assert.ok(Math.abs(dW - 8) < Math.abs(dE - 8), `weighted ${dW.toFixed(1)} ft from B1 vs equal ${dE.toFixed(1)} ft (measured 8)`);
  assert.ok(dW < 8 + 16 * 0.2, `most of the 16 ft goes to the far beacon, B1 at ${dW.toFixed(1)} ft`);
});

test("no intersection gives ONE position, never two options", () => {
  for (const [d1, d2] of [[8, 28], [20, 12], [5, 70], [60, 4]]) {
    const r = solveInitialPosition({ anchor1: A1, anchor2: A2, d1, d2, room });
    assert.equal(r.status, "ok", `${d1}/${d2}: ${r.status}`);
    assert.equal(r.alternate, null, `${d1}/${d2}`);
    assert.ok(r.position, `${d1}/${d2}`);
  }
});

test("containment (one circle swallows the other) also moves the less certain range more", () => {
  const r = intersectRangeCircles(A1, 6, A2, 70); // 70 - 6 = 64 > 52
  assert.equal(r.adjusted, true);
  const d1 = dist(r.candidates[0], A1);
  assert.ok(Math.abs(d1 - 6) < 3, `B1 stays near its 6 ft reading (${d1.toFixed(1)} ft)`);
});

test("two spots too close to tell apart become one answer", () => {
  const near = solveInitialPosition({ anchor1: A1, anchor2: A2, d1: 26.2, d2: 26, room }); // the two spots are about 4.6 ft apart
  assert.equal(near.alternate, null);
  assert.equal(near.status, "ok");
});

test("a low-confidence beacon is adjusted more than a confident one", () => {
  const r = solveInitialPosition({ anchor1: A1, anchor2: A2, d1: 15, d2: 15, conf1: 1, conf2: 0.35, room, requireConfidence: false });
  const e1 = Math.abs(dist(r.position, A1) - 15);
  const e2 = Math.abs(dist(r.position, A2) - 15);
  assert.ok(e1 < e2, `B1 off by ${e1.toFixed(1)}, B2 (low confidence) off by ${e2.toFixed(1)}`);
});

// ── Priority engine, with a floor plan: everything walkable except one box (a cabin / desk block) ──
const plan = (box) => (p) => {
  const inside = p.x > box.x1 && p.x < box.x2 && p.y > box.y1 && p.y < box.y2;
  if (!inside) return { x: p.x, y: p.y, distFt: 0 };
  const opts = [
    { x: box.x1, y: p.y, distFt: p.x - box.x1 }, { x: box.x2, y: p.y, distFt: box.x2 - p.x },
    { x: p.x, y: box.y1, distFt: p.y - box.y1 }, { x: p.x, y: box.y2, distFt: box.y2 - p.y },
  ];
  return opts.sort((a, b) => a.distFt - b.distFt)[0];
};
// d1 = d2 = 30 with the beacons 52 ft apart: crossing points at (36, 51) and (36, 21).
const both = { anchor1: A1, anchor2: A2, d1: 30, d2: 30, room };

test("priority 1: within 2 m of a beacon gives one spot next to it, never A/B", () => {
  const r = solveInitialPosition({ anchor1: A1, anchor2: A2, d1: 4, d2: 50, room, snap: plan({ x1: -1, y1: -1, x2: -1, y2: -1 }) });
  assert.equal(r.status, "ok");
  assert.equal(r.alternate, null);
  assert.match(r.reason, /next-to-beacon-1/);
  assert.ok(dist(r.position, A1) <= 6.6, `${dist(r.position, A1).toFixed(1)} ft from B1`);
});

test("priority 1 also when both crossing points are impossible: the spot by the beacon", () => {
  const r = solveInitialPosition({ anchor1: A1, anchor2: A2, d1: 5, d2: 49, room, snap: plan({ x1: 0, y1: 0, x2: 30, y2: 72 }) });
  assert.equal(r.status, "ok");
  assert.ok(r.position, "a position, not a failure");
});

test("a crossing point inside a wall / cabin (beside it) is offered as an option, moved onto the floor", () => {
  const r = solveInitialPosition({ ...both, snap: plan({ x1: 30, y1: 45, x2: 42, y2: 58 }) }); // (36,51) is 6 ft inside
  assert.equal(r.status, "ambiguous", r.reason);
  assert.ok(Math.abs(r.position.y - 21) < 0.5, "the point on the floor is shown first");
  assert.ok(r.alternate && Math.abs(r.alternate.y - 45) < 0.5, `the wall point moved to the cabin edge: ${JSON.stringify(r.alternate)}`);
});

test("a crossing point deep inside an unwalkable block (> 10 ft) is not offered", () => {
  const r = solveInitialPosition({ ...both, snap: plan({ x1: 14, y1: 40, x2: 58, y2: 72 }) }); // (36,51) is 11 ft inside
  assert.equal(r.status, "ok");
  assert.ok(Math.abs(r.position.y - 21) < 0.5);
});

test("only the wall point is possible: it is the answer, on the floor beside the wall", () => {
  // (36,21) is outside the room's walkable area entirely (box covers the lower half deeply); (36,51) is 3 ft into a wall.
  const r = solveInitialPosition({ ...both, snap: (p) => (p.y < 36 ? { x: p.x, y: 48, distFt: 48 - p.y } : plan({ x1: 33, y1: 45, x2: 39, y2: 58 })(p)) });
  assert.equal(r.status, "ok", r.reason);
  assert.ok(r.position.y >= 45, JSON.stringify(r.position));
});

test("two points both on the floor and far apart still ask A or B", () => {
  const r = solveInitialPosition({ ...both, snap: plan({ x1: -1, y1: -1, x2: -1, y2: -1 }) });
  assert.equal(r.status, "ambiguous");
  assert.ok(r.alternate);
});

test("two points that land on the same floor spot once moved are one answer", () => {
  // Only a corridor along the beacon line is walkable (y 34..38). Crossing points (36, 36 +- 7.3) are
  // both beside its walls and move to (36, 38) and (36, 34): 4 ft apart, one answer between them.
  const corridor = (p) => {
    const y = Math.min(38, Math.max(34, p.y));
    return { x: p.x, y, distFt: Math.abs(y - p.y) };
  };
  const r = solveInitialPosition({ anchor1: A1, anchor2: A2, d1: 27, d2: 27, room, snap: corridor });
  assert.equal(r.status, "ok", r.reason);
  assert.equal(r.alternate, null);
  assert.ok(Math.abs(r.position.y - 36) < 0.6, JSON.stringify(r.position));
});

test("next to a beacon with a far range that disagrees: placed by that beacon, small doubt, other range ignored", () => {
  // B2 reads 1.6 ft, B1 reads 66 ft although the beacons are only 52 ft apart (66 - 1.6 > 52).
  const r = solveInitialPosition({ anchor1: A1, anchor2: A2, d1: 66, d2: 1.6, room, snap: plan({ x1: -1, y1: -1, x2: -1, y2: -1 }) });
  assert.equal(r.nearBeacon, 2);
  assert.match(r.reason, /far-range-disagrees/);
  assert.ok(dist(r.position, A2) < 1, `${dist(r.position, A2).toFixed(1)} ft from B2`);
  assert.ok(r.uncertaintyFt <= 3.5, `doubt ${r.uncertaintyFt} ft, not the 2-beacon geometry's`);
});

test("a beacon placed in a wall: the start is the nearest clear floor spot, moved inside, not on the wall line", () => {
  // Beacon B2 inside a block x 55..70; corridor floor to its left. inside() pushes 1.5 ft into the floor.
  const block = plan({ x1: 55, y1: 0, x2: 75, y2: 72 });
  const inside = (p) => ({ x: Math.min(p.x, 55 - 1.5), y: p.y });
  const r = solveInitialPosition({ anchor1: A1, anchor2: A2, d1: 66, d2: 1.6, room, snap: block, inside });
  assert.ok(Math.abs(r.position.x - 53.5) < 0.01, JSON.stringify(r.position));
});
