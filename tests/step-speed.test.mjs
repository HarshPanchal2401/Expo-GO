// node --no-warnings --test tests/step-speed.test.mjs   (synthetic bounce values, not real walks)
import { test } from "node:test";
import assert from "node:assert/strict";
import { StepLengthModel } from "../services/StepLengthModel.js";

// Bounce (g) that a Weinberg K=0.74 model turns into `m` metres: bounce = (m/K)^4.
const bounceFor = (m) => (m / 0.74) ** 4;
// A rough stride-vs-pace relation for an adult: 0.50 m at 1.4 Hz, 0.80 m at 2.1 Hz.
const truth = (f) => 0.425 * f - 0.09;
// Weinberg alone reads far less than the stride when walking faster: model it as a 0.25-power law of pace.
const weinbergSees = (f) => 0.62 * (f / 1.8) ** 0.55;

function walk(f, n = 30, m = new StepLengthModel()) {
  m.cfg.WEINBERG_K = 0.74;
  let last;
  for (let i = 0; i < n; i++) last = m.estimateCarry(bounceFor(weinbergSees(f)), { cadenceHz: f, carry: "texting" });
  return { m, len: last.lengthM };
}

test("fast walking is longer than Weinberg alone says, and closer to the real stride", () => {
  const m = new StepLengthModel();
  walk(1.8, 40, m); // an ordinary pace first: the ratio is learned here
  const fast = walk(2.4, 30, m).len;
  const weinbergOnly = Math.max(0.4, Math.min(1.2, weinbergSees(2.4)));
  assert.ok(fast > weinbergOnly + 0.03, `blended ${fast.toFixed(2)} m vs Weinberg ${weinbergOnly.toFixed(2)} m`);
  assert.ok(Math.abs(fast - truth(2.4)) < Math.abs(weinbergOnly - truth(2.4)), `real ${truth(2.4).toFixed(2)} m`);
});

test("ordinary pace barely changes", () => {
  const m = new StepLengthModel();
  walk(1.8, 40, m);
  const len = walk(1.8, 10, m).len;
  assert.ok(Math.abs(len - weinbergSees(1.8)) < 0.04, `${len.toFixed(2)} vs ${weinbergSees(1.8).toFixed(2)}`);
});

test("fast walking does not teach the cadence model the short length", () => {
  const m = new StepLengthModel();
  walk(1.8, 40, m);
  const before = m.cadenceRatio;
  walk(2.5, 80, m);
  assert.equal(m.cadenceRatio, before, "the ratio only learns between 1.4 and 2.0 steps/s");
});

test("before the ratio is learned the length is Weinberg only", () => {
  const m = new StepLengthModel();
  const r = m.estimateCarry(bounceFor(0.6), { cadenceHz: 2.4, carry: "texting" });
  assert.equal(r.model, "weinberg");
});
