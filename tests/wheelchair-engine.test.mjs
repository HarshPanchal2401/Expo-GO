// node --no-warnings --test tests/wheelchair-engine.test.mjs
// SYNTHETIC vibration (random noise at 50 Hz), not a real wheelchair: it checks how the
// logic reacts, not how a real chair behaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WheelchairEngine } from "../services/WheelchairEngine.js";

function sim(profile, settings = {}) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const w = new WheelchairEngine();
  w.setSettings({ speedMps: 1.0, sensitivity: "medium", ...settings });
  const moves = [];
  w.onMove = (m) => moves.push(m.lengthM);
  let t = 1_000_000;
  for (const seg of profile) {
    for (let i = 0; i < seg.s / 0.02; i++) {
      t += 20;
      const x = seg.amp * gauss(), y = seg.amp * gauss(), z = seg.amp * gauss();
      w.ingest({
        acceleration: { x: x * 9.80665, y: y * 9.80665, z: z * 9.80665 },
        accelerationIncludingGravity: { x: x * 9.80665, y: y * 9.80665, z: (-1 + z) * 9.80665 },
        rotationRate: { alpha: 2 * gauss(), beta: 2 * gauss(), gamma: 2 * gauss() },
      }, t);
    }
  }
  return { moves, total: moves.reduce((a, b) => a + b, 0) };
}

test("distance does not depend on how rough the floor is (same speed, 60 s)", () => {
  const totals = [0.035, 0.06, 0.12, 0.25].map((amp) => sim([{ s: 60, amp }]).total);
  const spread = Math.max(...totals) - Math.min(...totals);
  assert.ok(spread < 1, `totals differ by ${spread.toFixed(1)} m: ${totals.map((x) => x.toFixed(1))}`);
  assert.ok(totals.every((x) => x > 55 && x < 61), `expected about 59 m, got ${totals.map((x) => x.toFixed(1))}`);
});

test("a stop adds almost nothing after the roll (no ~0.7 m overshoot)", () => {
  // 2 s of rolling at 0.8 m/s set speed, then the chair stops.
  const { total } = sim([{ s: 2, amp: 0.005 }, { s: 2, amp: 0.06 }, { s: 6, amp: 0.005 }], { speedMps: 0.8 });
  assert.ok(total > 0.9 && total < 1.7, `2 s at 0.8 m/s should count near 1.6 m (ramp-up and stop lag take some), got ${total.toFixed(2)}`);
});

test("smooth patches of floor do not lose a large part of a continuous roll", () => {
  const prof = [];
  for (let k = 0; k < 8; k++) { prof.push({ s: 6, amp: 0.06 }); prof.push({ s: 2.5, amp: 0.008 }); }
  const { total } = sim(prof); // true 68 m at 1.0 m/s
  assert.ok(total > 62, `counted ${total.toFixed(1)} m of 68 m`);
});

test("the engine does hand over moves under 0.4 m (the app must not turn them into 0.70 m)", () => {
  const all = [];
  for (let roll = 1.5; roll <= 3.5; roll += 0.1) {
    all.push(...sim([{ s: 2, amp: 0.005 }, { s: roll, amp: 0.06 }, { s: 6, amp: 0.005 }]).moves);
  }
  assert.ok(all.every((m) => m > 0 && m <= 1.0), JSON.stringify(all));
  assert.ok(all.some((m) => m < 0.4), "some stops leave a leftover under 0.4 m, below walking's 0.40 m minimum");
});
