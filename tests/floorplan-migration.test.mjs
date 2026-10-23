// node --no-warnings --test tests/floorplan-migration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateFloorplan } from "../services/FloorplanMigration.js";

const mem = (init = {}) => {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return { m, getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v) };
};
const get = (s, k) => JSON.parse(s.m.get(k));

test("70 x 72 saves move onto the 70 x 70 drawing (y * 70/72), once", async () => {
  const s = mem({
    "@v2_fusion_place_size_ft": { widthFt: 70, heightFt: 72 },
    "@v2_fusion_anchors_ft": { b1: { x: 70, y: 72 }, b2: { x: 35, y: 36 } },
    "@v2_obstacle_map_v1": { items: [{ type: "wall", x1: 0, y1: 72, x2: 70, y2: 0 }, { type: "pillar", x: 35, y: 36, r: 1 }] },
    "@start_spots_v1": [{ id: "1", name: "Entrance", x: 50, y: 7.2 }],
  });
  const r = await migrateFloorplan(s);
  assert.deepEqual(r.done, ["size", "anchors", "obstacles", "start-spots"]);
  assert.deepEqual(get(s, "@v2_fusion_place_size_ft"), { widthFt: 70, heightFt: 70 });
  assert.deepEqual(get(s, "@v2_fusion_anchors_ft"), { b1: { x: 70, y: 70 }, b2: { x: 35, y: 35 } });
  const ob = get(s, "@v2_obstacle_map_v1").items;
  assert.deepEqual([ob[0].x1, ob[0].y1, ob[0].x2, ob[0].y2, ob[1].x, ob[1].y, ob[1].r], [0, 70, 70, 0, 35, 35, 1]);
  assert.deepEqual([get(s, "@start_spots_v1")[0].x, get(s, "@start_spots_v1")[0].y], [50, 7]);
  assert.equal((await migrateFloorplan(s)).ran, false, "only once");
  assert.equal(get(s, "@v2_fusion_anchors_ft").b1.y, 70);
});

test("the first 72 x 72 saves are moved too (x and y * 70/72)", async () => {
  const s = mem({ "@v2_fusion_place_size_ft": { widthFt: 72, heightFt: 72 }, "@v2_fusion_anchors_ft": { b1: { x: 72, y: 36 }, b2: { x: 0, y: 72 } } });
  await migrateFloorplan(s);
  assert.deepEqual(get(s, "@v2_fusion_anchors_ft"), { b1: { x: 70, y: 35 }, b2: { x: 0, y: 70 } });
});

test("a room size the user typed is left alone; an already-current one too", async () => {
  const s = mem({ "@v2_fusion_place_size_ft": { widthFt: 50, heightFt: 40 }, "@v2_fusion_anchors_ft": { b1: { x: 50, y: 1 }, b2: { x: 1, y: 1 } } });
  assert.equal((await migrateFloorplan(s)).reason, "custom-room-size");
  assert.equal(get(s, "@v2_fusion_anchors_ft").b1.x, 50);
  const c = mem({ "@v2_fusion_place_size_ft": { widthFt: 70, heightFt: 70 }, "@v2_fusion_anchors_ft": { b1: { x: 70, y: 70 }, b2: { x: 1, y: 1 } } });
  assert.equal((await migrateFloorplan(c)).reason, "already-current");
  assert.equal(get(c, "@v2_fusion_anchors_ft").b1.y, 70);
});

test("a fresh install (nothing saved) just marks it done", async () => {
  const s = mem();
  const r = await migrateFloorplan(s);
  assert.equal(r.ran, true);
  assert.deepEqual(r.done, []);
  assert.equal(s.m.get("@v2_fusion_place_size_ft"), undefined);
});
