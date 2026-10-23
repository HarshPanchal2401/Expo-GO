// node --no-warnings --test tests/trail.test.mjs   (synthetic: fake steps and beacon ranges)
import { test } from "node:test";
import assert from "node:assert/strict";
import { FusionEngine } from "../services/FusionEngine.js";

function setup(pf) {
  const e = new FusionEngine();
  e.setParticleFilterEnabled(pf);
  e.setRoomSize(72, 72);
  e.setBleAnchors({ x: 10, y: 10 }, { x: 60, y: 10 });
  e.setManualPosition(30, 20);
  e.beginNavigation();
  return e;
}

for (const pf of [true, false]) {
  test(`trail is made of steps only, beacon fixes do not add or bend points (particle filter ${pf})`, () => {
    const e = setup(pf);
    for (let i = 0; i < 10; i++) {
      e.predict(2.3, 0); // straight north
      e.correct(25 + (i % 2) * 6, 45 - (i % 3) * 5, 0.9, 0.9, 3, 3);
      e.correct(26, 44, 0.9, 0.9, 3, 3);
    }
    const trail = e.getState().trail;
    assert.equal(trail.length, 11, "start point + one point per step");
    for (let i = 1; i < trail.length; i++) {
      const d = Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y);
      assert.ok(d > 1.2 && d < 3.4, `segment ${i} is ${d.toFixed(2)} ft`);
    }
  });
}

test("a lower beacon weight moves the position less per fix", () => {
  const move = (w) => {
    const e = setup(true);
    e.setBleWeight(w);
    for (let i = 0; i < 6; i++) e.predict(2.3, 0);
    const before = e.getState();
    for (let i = 0; i < 6; i++) e.correct(40, 40, 1, 1, 3, 3);
    const after = e.getState();
    return Math.hypot(after.x - before.x, after.y - before.y);
  };
  assert.ok(move(0.15) < move(1) * 0.7, `weak ${move(0.15).toFixed(2)} ft vs full ${move(1).toFixed(2)} ft`);
});

// ── Path stays on the green (real floor plan) ──
import { floorplanGrid } from "../services/WalkableGrid.js";

test("the drawn path never crosses gray: every point and every line is on the walkable area", () => {
  floorplanGrid.setRoom(70, 72);
  const e = new FusionEngine();
  e.setRoomSize(70, 72);
  e.setWalkableGrid(floorplanGrid);
  e.setBleAnchors({ x: 15, y: 66 }, { x: 60, y: 10 });
  e.setManualPosition(30, 40); // open area
  e.beginNavigation();
  // Walk west into the Meeting / CEO cabin block and around: many steps would cut through gray.
  let seed = 3;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const headings = [-90, -90, -90, -90, -90, -90, -90, 0, 0, 0, 0, 0, 90, 90, 180, 180, -60, -60, -60, -60, -60, 30, 30, 30];
  for (let lap = 0; lap < 4; lap++) {
    for (const h of headings) {
      e.predict(2.3, h + 25 * (rnd() - 0.5));
      if (rnd() < 0.3) e.correct(20 + 30 * rnd(), 20 + 30 * rnd(), 0.8, 0.8, 4, 4);
    }
  }
  const t = e.getState().trail;
  assert.ok(t.length > 10, `trail has ${t.length} points`);
  for (const p of t) assert.ok(floorplanGrid.isWalkable(p.x, p.y), `point on gray: ${JSON.stringify(p)}`);
  for (let i = 1; i < t.length; i++) {
    assert.ok(floorplanGrid.segmentWalkable(t[i - 1].x, t[i - 1].y, t[i].x, t[i].y), `line ${i} crosses gray: ${JSON.stringify(t[i - 1])} -> ${JSON.stringify(t[i])}`);
  }
  const st = e.getState();
  assert.ok(floorplanGrid.isWalkable(st.x, st.y), "the dot is on the green");
});

test("when every possible position walks into a wall, the dot moves along it instead of freezing", async () => {
  const { ParticleFilter } = await import("../services/ParticleFilter.js");
  floorplanGrid.setRoom(70, 72);
  const run = () => {
    const e = new FusionEngine();
    e.setRoomSize(70, 72); e.setWalkableGrid(floorplanGrid);
    e.setBleAnchors({ x: 15, y: 66 }, { x: 60, y: 10 });
    e.setManualPosition(12.5, 8); e.beginNavigation();
    let stuck = 0, prev = e.getState();
    for (let i = 0; i < 22; i++) { e.predict(2.3, 35); const st = e.getState(); if (Math.hypot(st.x - prev.x, st.y - prev.y) < 0.5) stuck++; prev = st; }
    return stuck;
  };
  let slide = 0; for (let k = 0; k < 8; k++) slide += run();
  const orig = ParticleFilter.prototype._slide;
  ParticleFilter.prototype._slide = () => null;
  let hold = 0; try { for (let k = 0; k < 8; k++) hold += run(); } finally { ParticleFilter.prototype._slide = orig; }
  assert.ok(slide < hold, `stuck steps: sliding ${slide}, holding ${hold}`);
});
