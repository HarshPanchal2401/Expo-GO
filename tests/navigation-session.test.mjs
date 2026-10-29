// node --no-warnings --test tests/navigation-session.test.mjs   (synthetic walks along a route)
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationSession } from "../services/NavigationSession.js";
import { buildLegs } from "../services/Router.js";

// East 40 ft, then north 30 ft (a left turn, as map up is north and the heading is clockwise).
const pts = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }];
const legs = buildLegs(pts);
const route = { points: pts, legs, totalFt: 70 };

const session = () => { const s = new NavigationSession(); s.start(route, 1.0); return s; };
const at = (s, x, y, t, heading = 90) => s.update({ x, y, heading }, t);

test("legs: east then north is a left turn", () => {
  assert.equal(legs[1].turn, "left");
});

test("walking along the route: progress rises, distance and time left fall, never backwards", () => {
  const s = session();
  let last = -1, t = 0;
  for (let x = 0; x <= 40; x += 2) {
    const i = at(s, x, 0.8 * Math.sin(x), (t += 1000)); // a wobble of under a foot
    assert.ok(i.progressFt >= last);
    last = i.progressFt;
    assert.equal(i.reroute, false);
  }
  const i = at(s, 40, 10, (t += 1000), 0);
  assert.ok(Math.abs(i.progressFt - 50) < 0.5, `progress ${i.progressFt}`);
  assert.ok(Math.abs(i.remainingFt - 20) < 0.5);
  assert.ok(Math.abs(i.etaS - 20 / 3.28084) < 0.2);
});

test("instructions: straight, a turn coming, the turn now, the last stretch, arrival", () => {
  const s = session();
  assert.match(at(s, 20, 0, 2000).instruction, /^In 20 ft, turn left$/);
  assert.match(at(s, 30, 0, 3000).instruction, /^In 10 ft, turn left$/);
  assert.match(at(s, 38, 0, 4000).instruction, /^Turn left now$/);
  assert.match(at(s, 40, 12, 5000, 0).instruction, /^Continue .* ft to your destination$/);
  const end = at(s, 40, 29, 6000, 0);
  assert.equal(end.state, "arrived");
  assert.equal(end.instruction, "You have arrived");
  // Once arrived it stays arrived, even if the dot wobbles away.
  assert.equal(at(s, 36, 20, 7000, 0).state, "arrived");
});

test("a turn far away says to go straight first", () => {
  const long = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }];
  const l = buildLegs(long);
  const s = new NavigationSession();
  s.start({ points: long, legs: l, totalFt: 130 });
  assert.equal(at(s, 5, 0, 0).instruction, "Go straight 95 ft, then turn left");
});

test("at the start, facing the wrong way says to turn", () => {
  const s = session();
  assert.equal(at(s, 0.5, 0, 1000, 270).instruction, "Turn around");
  assert.match(at(s, 0.5, 0, 2000, 180).instruction, /^Turn left to face the route$/);
  assert.match(at(s, 0.5, 0, 3000, 90).instruction, /^In 40 ft, turn left$/);
});

test("a stray of a few feet, or a short one, does not reroute", () => {
  const s = session();
  at(s, 10, 0, 0);
  for (let t = 1000; t <= 20000; t += 1000) assert.equal(at(s, 12, 4, t).reroute, false); // 4 ft off: within the wobble
  const s2 = session();
  at(s2, 10, 0, 0);
  assert.equal(at(s2, 10, 9, 1000).reroute, false);
  assert.equal(at(s2, 10, 9, 2500).reroute, false); // under 3 s
  assert.equal(at(s2, 10, 0, 3000).reroute, false); // back on the route: the clock restarts
  assert.equal(at(s2, 10, 9, 4000).reroute, false);
  assert.equal(at(s2, 10, 9, 6000).reroute, false);
});

test("a wrong turn (more than 6 ft off for 3 s) reroutes once, then waits", () => {
  const s = session();
  at(s, 10, 0, 0);
  assert.equal(at(s, 10, 12, 1000).reroute, false);
  assert.equal(at(s, 10, 12, 2000).reroute, false);
  const r = at(s, 10, 12, 4100);
  assert.equal(r.reroute, true);
  assert.equal(r.offRoute, true);
  // Still off, but not again for 5 s.
  assert.equal(at(s, 10, 12, 5000).reroute, false);
  assert.equal(at(s, 10, 12, 8000).reroute, false);
  assert.equal(at(s, 10, 12, 9500).reroute, true);
});

test("standing still: nothing changes", () => {
  const s = session();
  const first = at(s, 20, 0, 0);
  for (let t = 1000; t <= 30000; t += 1000) {
    const i = at(s, 20 + 0.3 * Math.sin(t), 0.3 * Math.cos(t), t);
    assert.equal(i.reroute, false);
    assert.ok(Math.abs(i.progressFt - first.progressFt) < 1);
  }
});

test("a route that passes near itself does not make the progress jump ahead", () => {
  // A U: east 30, north 8, back west 30. The return leg is 8 ft from the first.
  const u = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 8 }, { x: 0, y: 8 }];
  const l = buildLegs(u);
  const s = new NavigationSession();
  s.start({ points: u, legs: l, totalFt: l.reduce((a, g) => a + g.lengthFt, 0) });
  const i = at(s, 5, 0, 0);
  assert.ok(i.progressFt < 8, `progress ${i.progressFt}`);
});
