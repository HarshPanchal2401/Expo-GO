// node --no-warnings --test tests/floorplan-migration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateTo70x72 } from "../services/FloorplanMigration.js";

const mem = (init = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return { m, getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v) };
};
const get = (s, k) => JSON.parse(s.m.get(k));

test("old 72 x 72 saves move onto the 70 ft wide drawing (x * 70/72), once", async () => {
  const s = mem({
    "@v2_fusion_place_size_ft": { widthFt: 72, heightFt: 72 },
    "@v2_fusion_anchors_ft": { b1: { x: 72, y: 10 }, b2: { x: 36, y: 60 } },
    "@v2_obstacle_map_v1": { items: [{ type: "wall", x1: 0, y1: 1, x2: 72, y2: 1 }, { type: "pillar", x: 36, y: 5, r: 1 }] },
    "@start_spots_v1": [{ id: "1", name: "Entrance", x: 54, y: 2 }],
  });
  const r = await migrateTo70x72(s);
  assert.deepEqual(r.done, ["size", "anchors", "obstacles", "start-spots"]);
  assert.deepEqual(get(s, "@v2_fusion_place_size_ft"), { widthFt: 70, heightFt: 72 });
  assert.deepEqual(get(s, "@v2_fusion_anchors_ft"), { b1: { x: 70, y: 10 }, b2: { x: 35, y: 60 } });
  const ob = get(s, "@v2_obstacle_map_v1").items;
  assert.deepEqual([ob[0].x1, ob[0].x2, ob[0].y1, ob[1].x, ob[1].y], [0, 70, 1, 35, 5]);
  assert.equal(get(s, "@start_spots_v1")[0].x, 52.5);
  // second run changes nothing
  assert.equal((await migrateTo70x72(s)).ran, false);
  assert.equal(get(s, "@v2_fusion_anchors_ft").b1.x, 70);
});

test("a room size the user typed is left alone", async () => {
  const s = mem({ "@v2_fusion_place_size_ft": { widthFt: 50, heightFt: 40 }, "@v2_fusion_anchors_ft": { b1: { x: 50, y: 1 }, b2: { x: 1, y: 1 } } });
  const r = await migrateTo70x72(s);
  assert.equal(r.reason, "custom-room-size");
  assert.equal(get(s, "@v2_fusion_anchors_ft").b1.x, 50);
});

test("a fresh install (nothing saved) just marks it done", async () => {
  const s = mem();
  const r = await migrateTo70x72(s);
  assert.equal(r.ran, true);
  assert.deepEqual(r.done, []);
  assert.equal(s.m.get("@v2_fusion_place_size_ft"), undefined);
});
