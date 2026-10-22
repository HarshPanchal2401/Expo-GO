// node --no-warnings --test tests/start-spots.test.mjs   (memory only: no AsyncStorage in Node)
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStartSpots, saveStartSpot, removeStartSpot, MAX_SPOTS } from "../services/StartSpots.js";

test("start spots: loads share one read, same name moves the spot, bad input is refused", async () => {
  const [a, b] = await Promise.all([loadStartSpots(), loadStartSpots()]);
  assert.equal(a, b);
  let r = await saveStartSpot("Entrance", 10, 20);
  assert.deepEqual([r.ok, r.list.length], [true, 1]);
  r = await saveStartSpot("entrance", 11, 21);
  assert.deepEqual([r.ok, r.list.length, r.list[0].x], [true, 1, 11]);
  assert.equal((await saveStartSpot("", 1, 1)).ok, false);
  assert.equal((await saveStartSpot("X", NaN, 1)).ok, false);
});

test("start spots: a full list says so and keeps the saved spots; deleting frees a place", async () => {
  let r;
  for (let i = 0; i < MAX_SPOTS + 3; i++) r = await saveStartSpot(`S${i}`, i, i);
  assert.equal(r.ok, false);
  assert.equal(r.list.length, MAX_SPOTS);
  assert.match(r.reason, /delete/);
  await removeStartSpot(r.list[0].id);
  assert.equal((await saveStartSpot("New", 1, 1)).ok, true);
});
