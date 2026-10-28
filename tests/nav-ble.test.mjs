// node --no-warnings --test tests/nav-ble.test.mjs   (synthetic: fake steps, ranges, sensors; clock mocked)
import { test } from "node:test";
import assert from "node:assert/strict";
import { FusionEngine } from "../services/FusionEngine.js";
import { HeadingFilter } from "../services/HeadingFilter.js";
import { WheelchairEngine } from "../services/WheelchairEngine.js";

/** Runs fn with Date.now() on a fake clock; fn gets advance(ms). */
function withClock(fn) {
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    return fn((ms) => { t += ms; });
  } finally {
    Date.now = realNow;
  }
}

/** Navigating from (30, 20), beacons at (10,10) and (60,10), beacon weight as in the app. */
function navigating(pf, weight = 0.15) {
  const e = new FusionEngine();
  e.setParticleFilterEnabled(pf);
  e.setRoomSize(72, 72);
  e.setBleAnchors({ x: 10, y: 10 }, { x: 60, y: 10 });
  e.setManualPosition(30, 20);
  e.beginNavigation();
  e.setBleWeight(weight);
  return e;
}

// Ranges that say the user is ~8 ft east of where the dot is, with noise.
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const wrongRanges = (e) => {
  const st = e.getState();
  const tx = st.x + 8, ty = st.y;
  return [Math.hypot(tx - 10, ty - 10) + 2 * (rnd() - 0.5), Math.hypot(tx - 60, ty - 10) + 2 * (rnd() - 0.5)];
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

for (const pf of [true, false]) {
  test(`standing still while navigating: beacons do not move the dot at all (particle filter ${pf})`, () => {
    withClock((advance) => {
      const e = navigating(pf);
      for (let i = 0; i < 6; i++) { e.predict(2.3, 0); advance(500); }
      advance(3000); // stopped
      const before = e.getState();
      for (let i = 0; i < 120; i++) { // 60 s of packets
        advance(500);
        const [d1, d2] = wrongRanges(e);
        e.correct(d1, d2, 0.9, 0.9, 3, 3);
        if (i % 2) e.tick();
      }
      const after = e.getState();
      assert.equal(after.bleHeld, "still");
      assert.equal(dist(before, after), 0, `moved ${dist(before, after).toFixed(2)} ft`);
    });
  });
}

test("while the start is being settled (full beacon weight) beacons still correct a standing user", () => {
  withClock((advance) => {
    const e = navigating(true, 1);
    const before = e.getState();
    for (let i = 0; i < 40; i++) {
      advance(500);
      e.correct(...wrongRanges(e), 0.9, 0.9, 3, 3);
    }
    assert.ok(dist(before, e.getState()) > 0.5, "settling still uses the beacons");
  });
});

test("the first steps of a walk are not pulled by beacons; after them, they are", () => {
  withClock((advance) => {
    const e = navigating(true);
    const changes = [];
    for (let i = 0; i < 12; i++) {
      e.predict(2.3, 0);
      advance(250);
      const before = e.getState();
      e.correct(...wrongRanges(e), 0.9, 0.9, 3, 3);
      const after = e.getState();
      changes.push({ step: i + 1, held: after.bleHeld, moved: dist(before, after) });
      advance(350);
    }
    for (const c of changes.slice(0, 4)) {
      assert.equal(c.held, "walk-start", `step ${c.step}`);
      assert.equal(c.moved, 0, `step ${c.step} moved ${c.moved}`);
    }
    assert.ok(changes.slice(4).some((c) => c.held === null && c.moved > 0), "walking straight, beacons nudge it");
  });
});

test("in a turn beacons are held off, and come back once walking straight again", () => {
  withClock((advance) => {
    const e = navigating(true);
    const step = (h) => { e.predict(2.3, h); advance(600); };
    for (let i = 0; i < 8; i++) step(0);
    step(45); step(90); // turning east
    const before = e.getState();
    e.correct(...wrongRanges(e), 0.9, 0.9, 3, 3);
    assert.equal(e.getState().bleHeld, "turning");
    assert.equal(dist(before, e.getState()), 0);
    for (let i = 0; i < 6; i++) step(90); // 3.6 s straight
    e.correct(...wrongRanges(e), 0.9, 0.9, 3, 3);
    assert.equal(e.getState().bleHeld, null);
  });
});

test("the PF beacon nudge while walking straight stays small (no visible jump per update)", () => {
  withClock((advance) => {
    const e = navigating(true);
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      e.predict(2.3, 0);
      advance(250);
      const before = e.getState();
      e.correct(...wrongRanges(e), 0.9, 0.9, 3, 3);
      worst = Math.max(worst, dist(before, e.getState()));
      advance(350);
    }
    assert.ok(worst < 1.0, `largest beacon move ${worst.toFixed(2)} ft`);
  });
});

// ── Heading while standing ──
function standingWithBentCompass(moving) {
  return withClock((advance) => {
    const f = new HeadingFilter();
    f.setCarry({ mode: "texting", version: 0, transitioning: false }, Date.now());
    f.updateMagneticField(50);
    f.setMoving(moving);
    let first = true;
    for (let i = 0; i < 8 * 50; i++) { // 8 s
      advance(20);
      f.updateMotion({ rotationRate: { alpha: 0, beta: 0, gamma: 0 }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 }, interval: 20 }, "android");
      if (first) { f.reset(10); first = false; }
      // A desk's steel bends the direction by 40 deg without changing the field strength.
      f.updateAbsolute(i < 50 ? 10 : 50);
    }
    return f.heading;
  });
}

test("standing still, a bent compass does not swing the arrow (it did while moving)", () => {
  const still = standingWithBentCompass(false);
  const moving = standingWithBentCompass(true);
  assert.ok(Math.abs(still - 10) < 1, `standing: arrow at ${still.toFixed(1)} deg (true 10)`);
  assert.ok(Math.abs(moving - 50) < 5, `moving: arrow follows the compass to ${moving.toFixed(1)} deg`);
});

// ── Wheelchair ──
function roll(seconds, speedMps = 0.8) {
  const w = new WheelchairEngine();
  w.setSettings({ speedMps, sensitivity: "medium", auto: true });
  const moves = [];
  w.onMove = (m) => moves.push(m);
  let t = 1_000_000;
  let s = 3;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const G = 9.81;
  for (let i = 0; i < (seconds + 3) * 50; i++) {
    t += 20;
    w.pushHeading(t, 0);
    const on = i < seconds * 50;
    // Wheels on a floor: broadband buzz ~0.06 g (well over the 0.02 g start level).
    const vx = on ? 0.06 * G * r() * 2 : 0.002 * G * r();
    const vy = on ? 0.06 * G * r() * 2 : 0.002 * G * r();
    const vz = on ? 0.06 * G * r() * 2 : 0.002 * G * r();
    w.ingest({
      acceleration: { x: vx, y: vy, z: vz },
      accelerationIncludingGravity: { x: vx, y: vy, z: G + vz },
      rotationRate: { alpha: 0.5 * r(), beta: 0.5 * r(), gamma: 0.5 * r() },
    }, t);
  }
  return moves;
}

test("wheelchair rolling: small moves (no big hops), total close to speed x time", () => {
  const moves = roll(6);
  assert.ok(moves.length > 8, `${moves.length} moves`);
  for (const m of moves) assert.ok(m.lengthM <= 0.35 + 1e-9, `move of ${m.lengthM} m`);
  const total = moves.reduce((a, m) => a + m.lengthM, 0);
  // 6 s at 0.8 m/s, less half the 1 s start ramp, less the dropped ~1 s at the end.
  assert.ok(total > 3.0 && total < 4.6, `total ${total.toFixed(2)} m`);
});

test("wheelchair push button: a push is handed over in parts of at most 0.5 m", () => {
  const w = new WheelchairEngine();
  w.setSettings({ pushM: 1.2 });
  const moves = [];
  w.onMove = (m) => moves.push(m);
  w.push(1_000_000);
  assert.equal(moves.length, 3);
  for (const m of moves) assert.ok(Math.abs(m.lengthM - 0.4) < 1e-9);
});

test("a short wheelchair move reaches the map at its own length (not rounded up to a step)", () => {
  withClock((advance) => {
    const e = navigating(true);
    const before = e.getState();
    e.predict(0.3 * 3.2808, 0); // a 0.3 m push part
    advance(100);
    const d = dist(before, e.getState());
    assert.ok(d < 2.0, `moved ${d.toFixed(2)} ft for a 0.98 ft move`);
  });
});
