// node --no-warnings --test tests/places.test.mjs   (memory only: no AsyncStorage here)
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlaces, savePlace, removePlace, searchPlaces, snapToGreen } from "../services/Places.js";
import { floorplanGrid } from "../services/WalkableGrid.js";

// A point on the green, and one on gray.
let green = null, gray = null;
for (let y = 2; y < 68 && !(green && gray); y += 2) {
  for (let x = 2; x < 68; x += 2) {
    if (floorplanGrid.isWalkable(x, y)) green = green || { x, y };
    else gray = gray || { x, y };
  }
}

test("a saved place is on the green, even when tapped on gray", async () => {
  const res = await savePlace("Cabin 3", gray.x, gray.y);
  assert.ok(res.ok, res.reason);
  const p = res.list.find((s) => s.name === "Cabin 3");
  assert.ok(floorplanGrid.isWalkable(p.x, p.y));
});

test("same name moves the place; empty name or bad point is refused", async () => {
  await savePlace("Pantry", green.x, green.y);
  const n = (await loadPlaces()).length;
  const res = await savePlace("pantry", green.x, green.y);
  assert.equal(res.list.length, n, "no duplicate");
  assert.equal((await savePlace("  ", 1, 1)).ok, false);
  assert.equal((await savePlace("X", NaN, 1)).ok, false);
});

test("search: by part of the name, nearest first; remove deletes", async () => {
  await savePlace("Meeting Room A", green.x, green.y);
  const list = await loadPlaces();
  assert.equal(searchPlaces(list, "meet").length, 1);
  assert.equal(searchPlaces(list, "MEETING")[0].name, "Meeting Room A");
  assert.equal(searchPlaces(list, "nothing here").length, 0);
  const far = { x: 100, y: 100 };
  const sorted = searchPlaces(list, "", far);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].distFt >= sorted[i - 1].distFt);
  const id = list.find((p) => p.name.toLowerCase() === "pantry").id;
  assert.ok(!(await removePlace(id)).some((p) => p.id === id));
});

test("snapToGreen: a point on the green is kept near where it was", () => {
  const p = snapToGreen(green);
  assert.ok(p && Math.hypot(p.x - green.x, p.y - green.y) <= 3.1);
  assert.equal(snapToGreen({ x: NaN, y: 0 }), null);
});
