// node --no-warnings --test tests/wheelchair.test.mjs
// SYNTHETIC vibration only (seeded noise): it checks the engine's logic, not a real wheelchair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WheelchairEngine } from "../services/WheelchairEngine.js";

function sim(segs, settings = {}) {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const gauss = () => (rnd() + rnd() + rnd() + rnd()) * 1.7;
  const e = new WheelchairEngine();
  e.setSettings(settings);
  let moved = 0;
  e.onMove = (m) => { moved += m.lengthM; };
  let t = 1000;
  for (const sg of segs) {
    for (let i = 0; i < sg.s * 50; i++) {
      t += 20;
      const v = sg.rms || 0;
      e.pushHeading(t, 0);
      e.ingest({
        accelerationIncludingGravity: { x: v * gauss(), y: v * gauss(), z: -1 + v * gauss() },
        rotationRate: { alpha: (sg.yaw || 0) + 2 * rnd(), beta: (sg.tilt || 0) * Math.sin(i / 6) + 2 * rnd(), gamma: 2 * rnd() },
      }, t);
    }
  }
  return { moved, e };
}

test("speed follows vibration: weak < medium < strong, and the old fixed speed is still available", () => {
  const w = sim([{ s: 10, rms: 0.03 }]).moved, m = sim([{ s: 10, rms: 0.12 }]).moved, s = sim([{ s: 10, rms: 0.4 }]).moved;
  assert.ok(w < m && m < s, `${w} < ${m} < ${s}`);
  assert.ok(w > 0.3 * m, "weak vibration still moves, only slower");
  const a = sim([{ s: 10, rms: 0.03 }], { scale: false }).moved, b = sim([{ s: 10, rms: 0.4 }], { scale: false }).moved;
  assert.equal(a, b, "scale off = one fixed speed");
});

test("a short smooth patch or a turn does not stop a continuous roll", () => {
  const steady = sim([{ s: 10, rms: 0.1 }]).moved;
  const patch = sim([{ s: 3, rms: 0.1 }, { s: 1.3, rms: 0.004 }, { s: 6, rms: 0.1 }]).moved;
  const turn = sim([{ s: 3, rms: 0.1 }, { s: 3, rms: 0.1, yaw: 80 }, { s: 3, rms: 0.1 }]).moved;
  assert.ok(patch >= 0.8 * steady, `patch ${patch} vs steady ${steady}`);
  assert.ok(turn >= 0.8 * steady * 0.9, `turn ${turn} vs steady ${steady}`);
});

test("rolling stops after real stillness, and spinning on the spot moves nothing", () => {
  const { e } = sim([{ s: 6, rms: 0.1 }, { s: 5, rms: 0.002 }]);
  assert.equal(e.rolling, false);
  const spin = sim([{ s: 8, rms: 0.1, yaw: 220 }]).moved;
  assert.equal(spin, 0);
});

test("the phone being handled (fast tilting) is not rolling", () => {
  assert.equal(sim([{ s: 6, rms: 0.1, tilt: 220 }]).moved, 0);
});

test("calibration roll returns the speed and the vibration level it happened at", () => {
  const { e } = (() => {
    const r = sim([{ s: 0.1, rms: 0 }]);
    return r;
  })();
  e.beginCalibration();
  let seed = 3;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  let t = 100000;
  for (let i = 0; i < 12 * 50; i++) {
    t += 20;
    const g = (rnd() + rnd() + rnd() + rnd()) * 1.7;
    e.pushHeading(t, 0);
    e.ingest({ accelerationIncludingGravity: { x: 0.1 * g, y: 0.1 * g, z: -1 + 0.1 * g }, rotationRate: { alpha: 1, beta: 1, gamma: 1 } }, t);
  }
  const res = e.finishCalibration(8);
  assert.equal(res.ok, true);
  assert.ok(res.speedMps > 0.2 && res.speedMps < 2.5);
  assert.ok(res.refRmsG > 0.05 && res.refRmsG < 0.4, `ref ${res.refRmsG}`);
});
