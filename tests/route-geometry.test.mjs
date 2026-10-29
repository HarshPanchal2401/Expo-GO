// node --no-warnings --test tests/route-geometry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRoute, fitView } from "../services/RouteGeometry.js";

const route = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };

test("the walked part and the part ahead meet at the point reached", () => {
  const { behind, ahead } = splitRoute(route, 15);
  assert.deepEqual(behind, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]);
  assert.deepEqual(ahead, [{ x: 10, y: 5 }, { x: 10, y: 10 }]);
});

test("nothing done: all ahead; everything done: nothing ahead but the end", () => {
  assert.equal(splitRoute(route, 0).ahead.length, 3);
  const end = splitRoute(route, 999);
  assert.deepEqual(end.ahead, [{ x: 10, y: 10 }]);
  assert.equal(end.behind.length, 3);
  assert.deepEqual(splitRoute(null, 5), { behind: [], ahead: [] });
});

test("the fitted view is centred on the points; a long route zooms out, a short one in", () => {
  const long = fitView([{ x: 5, y: 5 }, { x: 65, y: 60 }], 70, 70);
  assert.deepEqual([long.cx, long.cy], [35, 32.5]);
  assert.equal(long.zoom, 1);
  const short = fitView([{ x: 10, y: 10 }, { x: 20, y: 14 }], 70, 70);
  assert.ok(short.zoom > 2 && short.zoom <= 4);
});
