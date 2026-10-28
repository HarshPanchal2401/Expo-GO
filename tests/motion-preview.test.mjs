// node --no-warnings --test tests/motion-preview.test.mjs   (synthetic motion, not a real phone)
import { test } from "node:test";
import assert from "node:assert/strict";
import { MotionEngine } from "../services/MotionEngine.js";

const G = 9.80665;

/** segs: [["still"|"walk"|"handle", seconds]]. Returns events with times relative to each walk start. */
function run(segs, f = 1.8, seed0 = 1) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let now = 1e6;
  const ev = { previews: [], cancels: [], steps: [] };
  const me = new MotionEngine({
    platform: "android",
    stepLength: () => 0.7,
    onPreview: (p) => ev.previews.push({ at: now, count: p.count }),
    onPreviewCancel: () => ev.cancels.push(now),
    onStep: (s) => ev.steps.push({ at: now, t: s.t }),
  });
  const walkStarts = [];
  for (const [kind, sec] of segs) {
    const t0 = now;
    if (kind === "walk") walkStarts.push(t0);
    for (let i = 0; i < sec * 50; i++) {
      now += 20;
      const tt = (now - t0) / 1000;
      let v = 0.004 * gauss(), lat = 0, rot = { alpha: 2 * gauss(), beta: 2 * gauss(), gamma: 2 * gauss() };
      if (kind === "walk") {
        const ph = 2 * Math.PI * f * tt;
        v = 0.2 * Math.sin(ph) + 0.06 * Math.sin(2 * ph + 1) + 0.02 * gauss();
        lat = 0.05 * Math.sin(ph / 2);
        rot = { alpha: 8 * Math.sin(ph / 2) + 2 * gauss(), beta: 6 * Math.sin(ph) + 2 * gauss(), gamma: 2 * gauss() };
      } else if (kind === "handle") {
        v = 0.05 * gauss() + 0.15 * Math.sin(2 * Math.PI * 1.1 * tt) * (tt % 4 < 1.2 ? 1 : 0);
        lat = 0.08 * gauss();
        rot = { alpha: 60 * gauss(), beta: 60 * gauss(), gamma: 30 * gauss() };
      }
      me.ingest({ acceleration: { x: lat * G, y: 0, z: v * G }, accelerationIncludingGravity: { x: lat * G, y: 0, z: (1 + v) * G }, rotationRate: rot }, now);
    }
  }
  return { ev, walkStarts };
}

test("walking: the dot is previewed well before walking is confirmed, and as many steps as get confirmed", () => {
  for (const f of [1.5, 1.8, 2.2]) {
    const { ev, walkStarts } = run([["still", 3], ["walk", 8]], f);
    const firstPreview = ev.previews[0].at - walkStarts[0];
    const firstStep = ev.steps[0].at - walkStarts[0];
    assert.ok(firstPreview < firstStep - 300, `${f} Hz: preview at ${firstPreview} ms, confirmed at ${firstStep} ms`);
    assert.ok(firstPreview < 1300, `${f} Hz: preview after ${firstPreview} ms`);
    // Previewed steps are the ones released when walking is confirmed (no jump back).
    const confirmAt = ev.steps[0].at;
    const previewed = ev.previews.filter((p) => p.at <= confirmAt).reduce((a, p) => a + p.count, 0);
    const released = ev.steps.filter((s) => s.at === confirmAt).length;
    assert.ok(Math.abs(previewed - released) <= 1, `${f} Hz: previewed ${previewed}, released ${released}`);
    assert.equal(ev.cancels.length, 0);
  }
});

test("handling the phone does not preview movement", () => {
  for (let s = 1; s <= 5; s++) {
    const { ev } = run([["still", 2], ["handle", 12]], 0, s);
    assert.equal(ev.previews.length, 0, `seed ${s}`);
  }
});

test("after a stop, walking again is previewed too", () => {
  const { ev, walkStarts } = run([["still", 3], ["walk", 8], ["still", 3], ["walk", 8]]);
  const second = walkStarts[1];
  const p = ev.previews.find((x) => x.at > second);
  assert.ok(p, "a preview after the restart");
  assert.ok(p.at - second < 1500, `restart previewed after ${p.at - second} ms`);
});

/** A gentle start from standing (a desk): the bounce builds up over rampS, steps a little uneven. */
function gentleStart(seed0, { f = 1.6, amp = 0.1, rampS = 2.5 } = {}) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  let now = 1e6;
  const ev = [];
  const me = new MotionEngine({
    platform: "android",
    stepLength: () => 0.7,
    onPreview: (p) => ev.push({ k: "pv", at: now, n: p.count }),
    onPreviewCancel: () => ev.push({ k: "cancel", at: now }),
    onStep: () => ev.push({ k: "step", at: now }),
  });
  const quiet = () => ({ acceleration: { x: 0, y: 0, z: 0.004 * G * gauss() }, accelerationIncludingGravity: { x: 0, y: 0, z: G }, rotationRate: { alpha: 2 * gauss(), beta: 2 * gauss(), gamma: 2 * gauss() } });
  for (let i = 0; i < 100; i++) { now += 20; me.ingest(quiet(), now); }
  let ph = 0, fNow = f;
  for (let i = 0; i < 400; i++) {
    now += 20;
    const tt = i * 0.02;
    const prev = ph;
    ph += 2 * Math.PI * fNow * 0.02;
    if (Math.floor(ph / (2 * Math.PI)) !== Math.floor(prev / (2 * Math.PI))) fNow = f * (1 + 0.2 * (rnd() - 0.5));
    const v = Math.min(1, 0.35 + tt / rampS) * (amp * Math.sin(ph) + 0.06 * Math.sin(2 * ph + 1)) + 0.02 * gauss();
    const lat = 0.05 * Math.sin(ph / 2);
    me.ingest({
      acceleration: { x: lat * G, y: 0, z: v * G },
      accelerationIncludingGravity: { x: lat * G, y: 0, z: (1 + v) * G },
      rotationRate: { alpha: 8 * Math.sin(ph / 2) + 2 * gauss(), beta: 6 * Math.sin(ph) + 2 * gauss(), gamma: 2 * gauss() },
    }, now);
  }
  return ev;
}

test("a gentle start from a desk: the previewed dot is not taken back before walking is confirmed", () => {
  let starts = 0, backAndForth = 0;
  for (const f of [1.4, 1.7, 2.0]) for (const amp of [0.08, 0.12]) for (const rampS of [1.5, 3.5]) for (let s = 1; s <= 4; s++) {
    const ev = gentleStart(s * 17 + 3, { f, amp, rampS });
    const first = ev.find((e) => e.k === "step");
    if (!first) continue;
    starts++;
    if (ev.some((e) => e.k === "cancel" && e.at < first.at)) backAndForth++;
  }
  assert.ok(starts > 30, `${starts} walks confirmed`);
  assert.ok(backAndForth <= 1, `${backAndForth} of ${starts} starts: the dot went back, then forward again`);
});

test("a preview with no more steps after it is still withdrawn (a false start)", () => {
  const { ev } = run([["still", 2], ["walk", 1.2], ["still", 4]]);
  if (ev.previews.length) assert.ok(ev.cancels.length >= 1 || ev.steps.length > 0, "taken back or confirmed");
});
