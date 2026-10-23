// node --no-warnings --test tests/heading-align.test.mjs   (synthetic sensor data, clock mocked)
import { test } from "node:test";
import assert from "node:assert/strict";
import { HeadingFilter } from "../services/HeadingFilter.js";

/** Phone held flat and still; the gyro heading starts `driftDeg` away from the compass reading `compassDeg`. */
function standing({ compassDeg = 0, driftDeg = 8, seconds = 2, disturbed = false, swayDeg = 3 }) {
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    const f = new HeadingFilter();
    f.setCarry({ mode: "texting", version: 0, transitioning: false }, t);
    f.updateMagneticField(50);
    for (let i = 0; i < seconds * 50; i++) {
      t += 20;
      f.updateMotion({ rotationRate: { alpha: 0, beta: 0, gamma: 0 }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 }, interval: 20 }, "android");
      if (i === 0) f.reset(compassDeg + driftDeg); // the gyro-held heading, a few degrees off
      if (disturbed) f.updateMagneticField(80);
      const sway = swayDeg * Math.sin(i / 8);
      f.updateAbsolute(compassDeg + sway);
    }
    return { f, nowS: t / 1000 };
  } finally {
    Date.now = realNow;
  }
}

test("walking starts: the heading is set to the compass at once (averaging the sway)", () => {
  const { f, nowS } = standing({ compassDeg: 20, driftDeg: 9, seconds: 0.5 });
  const before = f.heading;
  const d = f.alignToCompass(nowS);
  assert.ok(Math.abs(d) > 2, `change ${d}`);
  assert.ok(Math.abs(f.heading - 20) < Math.abs(before - 20), `before ${before}, after ${f.heading}`);
  assert.ok(Math.abs(f.heading - 20) < 3, `after ${f.heading}`);
});

test("a disturbed compass is not used", () => {
  const { f, nowS } = standing({ compassDeg: 20, driftDeg: 9, seconds: 0.5, disturbed: true });
  assert.equal(f.alignToCompass(nowS), 0);
});

test("a tiny difference is left alone, a huge one is left to the resync logic", () => {
  const small = standing({ compassDeg: 0, driftDeg: 1, seconds: 0.5, swayDeg: 0 });
  assert.equal(small.f.alignToCompass(small.nowS), 0);
  const huge = standing({ compassDeg: 0, driftDeg: 60, seconds: 0.3, swayDeg: 0 });
  assert.equal(huge.f.alignToCompass(huge.nowS), 0);
});
