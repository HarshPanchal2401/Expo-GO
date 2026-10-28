// node --no-warnings --test tests/fast-turn.test.mjs   (synthetic phone: tests/fast-turn-sim.mjs; clock mocked)
import { test } from "node:test";
import assert from "node:assert/strict";
import { HeadingFilter } from "../services/HeadingFilter.js";
import { phoneEvents, turn } from "./fast-turn-sim.mjs";

const wrap = (a) => ((a + 540) % 360) - 180;
// The screen is busy now and then: frames skipped, sometimes 50-150 ms at once.
const JANKY = { dropProb: 0.15, burstDropProb: 0.04 };

/** Heading error at the end (deg). edit(events) may alter the events first. */
function finalError(bearing, opts = {}, edit = null, cfg = {}) {
  const real = Date.now;
  let now = 5e6;
  Date.now = () => now;
  try {
    const f = new HeadingFilter(cfg);
    f.setCarry({ mode: "texting", version: 0, transitioning: false }, now);
    f.setMoving(false); // standing, turning on the spot: no compass help
    const ev = phoneEvents(bearing, { durationS: 8, ...opts });
    if (edit) edit(ev);
    // The arrow is lined up with the truth once the filter has started (0.3 s).
    let first = true;
    for (const e of ev) {
      now = 5e6 + e.tMs;
      f.updateMotion(e.data, "android");
      if (first && e.tMs >= 300) { f.reset(e.truth); first = false; }
    }
    return Math.abs(wrap(f.heading - ev[ev.length - 1].truth));
  } finally {
    Date.now = real;
  }
}

const flicks = (t) => [0, 1, 2, 3, 4].reduce((a, k) => a + turn(t, 1 + k * 1.2, 0.3, k % 2 ? -90 : 90), 0);
const OFF = { FAST_TURN_DPS: 1e9 }; // the gyro alone, as before

test("fast turns keep their full angle even when the screen skips frames", () => {
  for (const [name, b] of [
    ["90 deg in 0.3 s", (t) => turn(t, 1, 0.3, 90)],
    ["180 deg in 0.4 s", (t) => turn(t, 1, 0.4, 180)],
    ["5 flicks of 90 deg", flicks],
  ]) {
    for (let seed = 1; seed <= 6; seed++) {
      const err = finalError(b, { ...JANKY, seed });
      assert.ok(err < 3, `${name}, seed ${seed}: off by ${err.toFixed(1)} deg`);
    }
  }
});

test("the gyro alone lost a large part of quick flicks (what this fixes)", () => {
  const worst = Math.max(...[1, 2, 3, 4, 5].map((seed) => finalError(flicks, { ...JANKY, seed }, null, OFF)));
  assert.ok(worst > 15, `gyro alone: ${worst.toFixed(1)} deg`);
});

test("slow turns are unchanged (gyro)", () => {
  for (let seed = 1; seed <= 4; seed++) {
    assert.ok(finalError((t) => turn(t, 1, 3, 90), { ...JANKY, seed }) < 1);
    assert.ok(finalError((t) => turn(t, 1, 4, -135), { ...JANKY, seed }) < 1);
  }
});

test("a jump of the phone's orientation without any turn (compass recalibrating) does not turn the arrow", () => {
  const err = finalError(() => 0, {}, (ev) => {
    for (const e of ev) {
      if (e.tMs > 3000) e.data.rotation = { ...e.data.rotation, alpha: e.data.rotation.alpha - (30 * Math.PI) / 180 };
    }
  });
  assert.ok(err < 0.5, `moved ${err.toFixed(1)} deg`);
});

/** The heading after every sample (deg), with the given config; edit(events) first. */
function headingTrace(bearing, opts, edit, cfg = {}) {
  const real = Date.now;
  let now = 5e6;
  Date.now = () => now;
  try {
    const f = new HeadingFilter(cfg);
    f.setCarry({ mode: "texting", version: 0, transitioning: false }, now);
    f.setMoving(true);
    const ev = phoneEvents(bearing, { durationS: 4, ...opts });
    if (edit) edit(ev);
    const out = [];
    let first = true;
    for (const e of ev) {
      now = 5e6 + e.tMs;
      f.updateMotion(e.data, "android");
      if (first && e.tMs >= 300) { f.reset(e.truth); first = false; }
      out.push(f.heading);
    }
    return out;
  } finally {
    Date.now = real;
  }
}

// Walking from 1 s: the hand sways the phone (peaks ~50 deg/s, like a fast turn's rate).
const walkSway = (t) => (t < 1 ? 0 : Math.min(1, (t - 1) / 0.3) * (7 * Math.sin(2 * Math.PI * 0.9 * (t - 1)) + 3 * Math.sin(2 * Math.PI * 1.8 * (t - 1))));

test("starting to walk: a short glitch of the phone's orientation (the jolt) does not flick the arrow", () => {
  const glitch = (ev) => {
    for (const e of ev) {
      if (e.tMs >= 1200 && e.tMs < 1500) e.data.rotation = { ...e.data.rotation, alpha: e.data.rotation.alpha - (10 * Math.PI) / 180 };
    }
  };
  for (let seed = 1; seed <= 4; seed++) {
    for (const opts of [{ seed }, { ...JANKY, seed }]) {
      const withGlitch = headingTrace(walkSway, opts, glitch);
      const gyroOnly = headingTrace(walkSway, opts, null, OFF);
      const worst = Math.max(...withGlitch.map((h, i) => Math.abs(wrap(h - gyroOnly[i]))));
      assert.ok(worst < 0.5, `seed ${seed}: the arrow moved ${worst.toFixed(1)} deg with the glitch`);
    }
  }
});

test("the hand's sway while walking is not taken for a fast turn (the gyro alone carries it)", () => {
  for (let seed = 1; seed <= 4; seed++) {
    const a = headingTrace(walkSway, { ...JANKY, seed });
    const b = headingTrace(walkSway, { ...JANKY, seed }, null, OFF);
    assert.ok(a.every((h, i) => Math.abs(wrap(h - b[i])) < 1e-9), `seed ${seed}`);
  }
});

test("phone held nearly upright: the orientation's angle is not used (gyro), no crash", () => {
  const err = finalError((t) => turn(t, 1, 3, 90), { pitchDeg: 80 });
  assert.ok(Number.isFinite(err) && err < 2, `off by ${err}`);
});
