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
    const stepsOnly = [];
    for (let i = 0; i < 10; i++) {
      e.predict(2.3, 0); // straight north
      // a noisy beacon range pair, every step, pointing somewhere else
      e.correct(25 + (i % 2) * 6, 45 - (i % 3) * 5, 0.9, 0.9, 3, 3);
      e.correct(26, 44, 0.9, 0.9, 3, 3);
      stepsOnly.push(e.getState().trail.length);
    }
    const trail = e.getState().trail;
    assert.equal(trail.length, 11, "start point + one point per step");
    // each trail segment is close to one step long, never the jump of a correction
    for (let i = 1; i < trail.length; i++) {
      const d = Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y);
      assert.ok(d > 1.2 && d < 3.4, `segment ${i} is ${d.toFixed(2)} ft`);
    }
  });
}

test("a weaker beacon weight moves the position less per fix", () => {
  const move = (w) => {
    const e = setup(true);
    e.setBleWeight(w);
    for (let i = 0; i < 6; i++) e.predict(2.3, 0);
    const before = e.getState();
    for (let i = 0; i < 6; i++) e.correct(40, 40, 1, 1, 3, 3);
    const after = e.getState();
    return Math.hypot(after.x - before.x, after.y - before.y);
  };
  assert.ok(move(0.25) < move(1), `weak ${move(0.25).toFixed(2)} ft vs full ${move(1).toFixed(2)} ft`);
});
