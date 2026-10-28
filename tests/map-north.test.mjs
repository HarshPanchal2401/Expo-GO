// node --no-warnings --test tests/map-north.test.mjs   (synthetic sensor readings)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AlphaNorthCheck, defaultAlphaNorth, mapHeadingZero, mapHeadingFromBearing, MAP_ROTATION_DEG } from "../services/MapNorth.js";

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const norm = (d) => ((d % 360) + 360) % 360;
// What the app does with rotation.alpha: heading = zero - alpha.
const heading = (zero, alpha) => wrap180(zero - norm(alpha));
// alpha each platform reports when the phone's top faces `bearing`.
const alphaFor = { android: (b) => -b, ios: (b) => 270 - b };

// The map's up is compass bearing 90 - MAP_ROTATION_DEG (80): the drawing is turned 10 deg.
const R = MAP_ROTATION_DEG;

test("the map is turned 10 deg from north-on-the-left", () => {
  assert.equal(R, 10);
  assert.equal(mapHeadingFromBearing(80), 0, "facing bearing 80 points the arrow straight up");
});

test("north is on the left of the map (turned by MAP_ROTATION_DEG)", () => {
  assert.equal(mapHeadingFromBearing(0), -90 + R);
  assert.equal(mapHeadingFromBearing(90), 0 + R);
  assert.equal(mapHeadingFromBearing(180), 90 + R);
  assert.equal(mapHeadingFromBearing(270), wrap180(-180 + R));
});

for (const platform of ["android", "ios"]) {
  test(`${platform}: the arrow follows real north with no Zero Heading`, () => {
    const zero = mapHeadingZero(defaultAlphaNorth(platform));
    for (const [bearing, want] of [[0, -90], [90, 0], [180, 90], [45, -45], [300, -150]]) {
      assert.equal(heading(zero, alphaFor[platform](bearing)), wrap180(want + R), `${platform} facing ${bearing}`);
    }
  });
}

test("the magnetometer check corrects a phone whose alpha is turned a quarter from the default", () => {
  let seed = 4;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  // An iPhone-default check on a phone that reports alpha like Android, indoors (±15° noise).
  const c = new AlphaNorthCheck("ios");
  let changed = null;
  for (let i = 0; i < 60; i++) {
    const bearing = 120 + 10 * rnd();
    changed = c.add(norm(alphaFor.android(bearing)), bearing + 30 * rnd()) ?? changed;
  }
  assert.equal(changed, 0);
  assert.equal(heading(mapHeadingZero(c.value), alphaFor.android(0)), -90 + R, "now north is left on this phone too");
});

test("the check leaves the default when the readings do not agree (disturbed field)", () => {
  let seed = 9;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const c = new AlphaNorthCheck("android");
  for (let i = 0; i < 60; i++) assert.equal(c.add(rnd() * 360, rnd() * 360), null);
  assert.equal(c.value, 0);
  assert.equal(c.done, true);
});

test("Settings can change the map rotation: the arrow turns by the same amount", async () => {
  const { setMapRotationDeg, getMapRotationDeg } = await import("../services/MapNorth.js");
  try {
    assert.equal(setMapRotationDeg(15), true);
    assert.equal(mapHeadingFromBearing(90), 15);
    assert.equal(heading(mapHeadingZero(defaultAlphaNorth("android")), alphaFor.android(90)), 15);
    assert.equal(setMapRotationDeg(15), false, "same value: no change");
    setMapRotationDeg(99);
    assert.equal(getMapRotationDeg(), 45, "kept within +-45");
  } finally {
    setMapRotationDeg(MAP_ROTATION_DEG);
  }
});
