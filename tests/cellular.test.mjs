// Tests for the Cellular Test experiment. Plain Node:
//   node --no-warnings --test tests/cellular.test.mjs
// All data below is SYNTHETIC (fake cells, fake network). It checks the logic,
// not real towers - real results need a real phone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCell, cellKey, lookupParams, maskId, toInt } from "../services/cellular/CellularTypes.js";
import { OpenCelliDService, validProxyUrl, parseTower } from "../services/cellular/OpenCelliDService.js";
import { CellularPositioningEngine } from "../services/cellular/CellularPositioningEngine.js";
import { haversineM, layoutPlot, geoUri } from "../services/cellular/CellularLocationUtils.js";
import worker, { validate } from "../cellular-proxy/worker.mjs";

const LTE = { radio: "LTE", registered: true, mcc: "404", mnc: "10", areaCode: 1234, cellId: "56789", pci: 12, signalDbm: -95, ageMs: 200, supported: true };
const memStorage = () => {
  const m = new Map();
  return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k) };
};
const jsonRes = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });

function makeService(fetchImpl, over = {}) {
  let t = 1_000_000;
  const svc = new OpenCelliDService({ fetchImpl, storage: memStorage(), now: () => t, config: { MIN_GAP_MS: 0, ...over } });
  svc.tick = (ms) => { t += ms; };
  return svc;
}

// ── identifiers ────────────────────────────────────────────────────────────
test("normalizeCell: a good LTE cell is lookupable and keeps real values", () => {
  const c = normalizeCell(LTE, 5);
  assert.equal(c.lookupable, true);
  assert.deepEqual([c.radio, c.mcc, c.mnc, c.areaCode, c.cellId, c.serving], ["LTE", 404, 10, 1234, 56789, true]);
});

test("normalizeCell: missing values stay null (never 0) and block the lookup", () => {
  const c = normalizeCell({ ...LTE, cellId: null, areaCode: null, mcc: null }, 5);
  assert.equal(c.cellId, null);
  assert.equal(c.areaCode, null);
  assert.equal(c.lookupable, false);
  assert.equal(lookupParams(c).ok, false);
  assert.ok(c.problems.length >= 3);
});

test("normalizeCell: out-of-range ids, id 0 and unsupported radios are rejected", () => {
  assert.equal(normalizeCell({ ...LTE, cellId: "268435456" }).lookupable, false); // > 28 bits
  assert.equal(normalizeCell({ ...LTE, cellId: "0" }).lookupable, false);
  assert.equal(normalizeCell({ radio: "GSM", registered: true, mcc: "404", mnc: "10", areaCode: 10, cellId: "70000", supported: true }).lookupable, false); // GSM cid is 16 bits
  assert.equal(normalizeCell({ radio: "CDMA", registered: true, supported: false }).lookupable, false);
  assert.equal(normalizeCell({ ...LTE, mcc: "99" }).lookupable, false);
});

test("normalizeCell: NR 36-bit identity is accepted; implausible signal becomes null", () => {
  const nr = normalizeCell({ radio: "NR", registered: true, mcc: "404", mnc: "10", areaCode: 100, cellId: "34359738367", signalDbm: 2147483647, supported: true });
  assert.equal(nr.lookupable, true);
  assert.equal(nr.signalDbm, null);
});

test("lookupParams: OpenCelliD parameter names; cellKey differs per radio; maskId; toInt", () => {
  const c = normalizeCell(LTE);
  assert.deepEqual(lookupParams(c).params, { radio: "LTE", mcc: 404, mnc: 10, lac: 1234, cellid: 56789 });
  assert.notEqual(cellKey(c), cellKey({ ...c, radio: "UMTS" }));
  assert.equal(maskId(56789), "••789");
  assert.equal(maskId(null), "—");
  assert.equal(toInt("12a"), null);
  assert.equal(toInt("007"), 7);
});

// ── service ────────────────────────────────────────────────────────────────
const FOUND = { ok: true, found: true, tower: { lat: 19.07, lon: 72.87, range: 1500, samples: 12, changeable: 1, averageSignalStrength: -90, radio: "LTE" } };

test("service: needs a proxy; the request carries cell parameters and the token, no api key", async () => {
  const calls = [];
  const svc = makeService(async (u, o) => { calls.push({ u, o }); return jsonRes(FOUND); });
  const c = normalizeCell(LTE);
  assert.equal((await svc.lookup(c)).error.code, "proxy-not-configured");
  assert.equal((await svc.setProxy("http://example.com")).ok, false);
  assert.equal((await svc.setProxy("https://p.example.workers.dev/", "tok")).ok, true);
  const r = await svc.lookup(c);
  assert.equal(r.status, "found");
  assert.equal(r.cache, "miss");
  assert.equal(r.tower.rangeM, 1500);
  assert.match(calls[0].u, /^https:\/\/p\.example\.workers\.dev\/cell\?radio=LTE&mcc=404&mnc=10&lac=1234&cellid=56789$/);
  assert.equal(calls[0].o.headers["X-Proxy-Token"], "tok");
  assert.ok(!/key=/i.test(calls[0].u));
});

test("service: caches found and not-found; the same cell is not requested again", async () => {
  let n = 0;
  const svc = makeService(async () => { n++; return jsonRes(n === 1 ? FOUND : { ok: true, found: false }); });
  await svc.setProxy("https://p.example.dev");
  const a = normalizeCell(LTE), b = normalizeCell({ ...LTE, cellId: "999" });
  await svc.lookup(a);
  const again = await svc.lookup(a);
  assert.deepEqual([again.status, again.cache, n], ["found", "hit", 1]);
  assert.equal((await svc.lookup(b)).status, "not-found");
  assert.equal((await svc.lookup(b)).cache, "hit");
  assert.equal(n, 2);
  svc.tick(7 * 3600 * 1000); // not-found expires after 6 h, found does not
  assert.equal((await svc.lookup(a)).cache, "hit");
  await svc.lookup(b);
  assert.equal(n, 3);
});

test("service: simultaneous lookups of one cell share one request", async () => {
  let n = 0;
  const svc = makeService(async () => { n++; await new Promise((r) => setTimeout(r, 5)); return jsonRes(FOUND); });
  await svc.setProxy("https://p.example.dev");
  const c = normalizeCell(LTE);
  const [x, y] = await Promise.all([svc.lookup(c), svc.lookup(c)]);
  assert.equal(n, 1);
  assert.equal(x.status, y.status);
});

test("service: errors are reported, never cached", async () => {
  let mode = "network";
  const svc = makeService(async () => {
    if (mode === "network") throw new Error("offline");
    if (mode === "html") return { status: 502, ok: false, json: async () => { throw new Error("bad json"); } };
    if (mode === "nocoords") return jsonRes({ ok: true, found: true, tower: { lat: "x" } });
    return jsonRes(FOUND);
  });
  await svc.setProxy("https://p.example.dev");
  const c = normalizeCell(LTE);
  assert.equal((await svc.lookup(c)).error.code, "network");
  mode = "html";
  assert.equal((await svc.lookup(c)).error.code, "malformed-response");
  mode = "nocoords";
  assert.equal((await svc.lookup(c)).error.code, "malformed-response");
  mode = "ok";
  assert.equal((await svc.lookup(c)).status, "found"); // nothing bad was cached
});

test("service: a rate-limit answer pauses all lookups; a run limit is enforced", async () => {
  let n = 0;
  const svc = makeService(async () => { n++; return jsonRes({ ok: false, error: { code: "rate-limited", message: "x" } }, 429); }, { MAX_NETWORK_LOOKUPS: 3 });
  await svc.setProxy("https://p.example.dev");
  const c = normalizeCell(LTE), d = normalizeCell({ ...LTE, cellId: "2" });
  assert.equal((await svc.lookup(c)).error.code, "rate-limited");
  assert.equal((await svc.lookup(d)).error.code, "rate-limited");
  assert.equal(n, 1, "nothing is sent while paused");
  svc.tick(11 * 60 * 1000);
  const svc2 = makeService(async () => { n++; return jsonRes(FOUND); }, { MAX_NETWORK_LOOKUPS: 2 });
  await svc2.setProxy("https://p.example.dev");
  await svc2.lookup(normalizeCell({ ...LTE, cellId: "1" }));
  await svc2.lookup(normalizeCell({ ...LTE, cellId: "2" }));
  assert.equal((await svc2.lookup(normalizeCell({ ...LTE, cellId: "3" }))).error.code, "session-limit");
});

test("service: a slow proxy times out", async () => {
  const svc = makeService((u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" })))), { TIMEOUT_MS: 20 });
  await svc.setProxy("https://p.example.dev");
  assert.equal((await svc.lookup(normalizeCell(LTE))).error.code, "timeout");
});

test("service: invalid cells are never sent; parseTower rejects 0,0 and bad coordinates", async () => {
  let n = 0;
  const svc = makeService(async () => { n++; return jsonRes(FOUND); });
  await svc.setProxy("https://p.example.dev");
  assert.equal((await svc.lookup(normalizeCell({ ...LTE, cellId: null }))).status, "invalid");
  assert.equal(n, 0);
  assert.equal(parseTower({ lat: 0, lon: 0 }), null);
  assert.equal(parseTower({ lat: 91, lon: 5 }), null);
  assert.equal(parseTower({ lat: 19, lon: 72, range: "1500", changeable: 0 }).rangeM, 1500);
  assert.equal(validProxyUrl("https://a.b/c"), true);
  assert.equal(validProxyUrl("http://a.b"), false);
});

// ── engine ─────────────────────────────────────────────────────────────────
const fakeNative = (resp) => ({ isAvailable: true, calls: 0, getCellInfo: async function () { this.calls++; return typeof resp === "function" ? resp(this.calls) : resp; } });
const RAW = (cells, extra = {}) => ({ hasTelephony: true, permissionGranted: true, locationServicesOn: true, simState: 5, operatorName: "X", operator: "40410", apiLevel: 34, cells, ...extra });

function makeEngine(native, fetchImpl) {
  const svc = makeService(fetchImpl || (async () => jsonRes(FOUND)));
  const eng = new CellularPositioningEngine({ native, service: svc, storage: memStorage(), config: { MIN_INTERVAL_MS: 5, ERROR_RETRY_MS: 50 } });
  return { eng, svc };
}

test("engine: reports a missing native module, no telephony and no permission", async () => {
  const a = makeEngine({ isAvailable: false });
  assert.equal((await a.eng.getCellInfo()).reason, "native-module-missing");
  assert.equal((await a.eng.findLocation()).status, "unavailable");
  const b = makeEngine(fakeNative({ hasTelephony: false, permissionGranted: true, cells: [] }));
  assert.equal((await b.eng.getCellInfo()).reason, "no-telephony");
  const c = makeEngine(fakeNative(RAW([], { permissionGranted: false })));
  assert.equal((await c.eng.findLocation()).status, "permission-denied");
  assert.equal(c.eng.getStatus().permissionGranted, false);
  const d = makeEngine({ isAvailable: true, getCellInfo: async () => { throw new Error("boom"); } });
  assert.equal((await d.eng.getCellInfo()).reason, "native-error");
});

test("engine: findLocation gives a tower, never a phone position", async () => {
  const { eng, svc } = makeEngine(fakeNative(RAW([LTE, { ...LTE, registered: false, cellId: "777", pci: 3 }])));
  await svc.setProxy("https://p.example.dev");
  const r = await eng.findLocation({ label: "Outdoors" });
  assert.equal(r.status, "tower-found");
  assert.equal(r.phoneEstimate, null);
  assert.match(r.note, /not where the phone is/);
  assert.equal(r.towers.length, 1);
  assert.equal(r.towers[0].serving, true);
  assert.equal(r.neighbourLookups.length, 0, "neighbours are not looked up unless asked");
  const h = await eng.getHistory();
  assert.equal(h[0].label, "Outdoors");
  assert.equal(h[0].cell, "••789", "history keeps identifiers masked");
  assert.equal(eng.getStatus().state, "idle");
  assert.ok(eng.getStatus().lastLookupAt);
});

test("engine: no serving cell, an unusable one, a missing record and lookup errors are told apart", async () => {
  const n1 = makeEngine(fakeNative(RAW([{ ...LTE, registered: false }])));
  await n1.svc.setProxy("https://p.example.dev");
  assert.equal((await n1.eng.findLocation()).status, "no-serving-cell");
  const n2 = makeEngine(fakeNative(RAW([{ ...LTE, cellId: null }])));
  assert.equal((await n2.eng.findLocation()).status, "serving-not-lookupable");
  const n3 = makeEngine(fakeNative(RAW([LTE])), async () => jsonRes({ ok: true, found: false }));
  await n3.svc.setProxy("https://p.example.dev");
  assert.equal((await n3.eng.findLocation()).status, "tower-not-found");
  const n4 = makeEngine(fakeNative(RAW([LTE])), async () => { throw new Error("x"); });
  await n4.svc.setProxy("https://p.example.dev");
  assert.equal((await n4.eng.findLocation()).status, "lookup-error");
});

test("engine: duplicate cells are merged; a 5G+LTE phone keeps both serving records", async () => {
  const nr = { radio: "NR", registered: true, mcc: "404", mnc: "10", areaCode: 99, cellId: "5000", pci: 1, supported: true };
  const { eng } = makeEngine(fakeNative(RAW([LTE, LTE, nr])));
  const info = await eng.getCellInfo();
  assert.equal(info.cells.length, 2);
  assert.equal(info.servingAll.length, 2);
});

test("engine: monitoring looks up only a changed cell, and stop leaves no timer or late updates", async () => {
  let cellId = "100";
  const native = fakeNative(() => RAW([{ ...LTE, cellId }]));
  let fetches = 0;
  const { eng, svc } = makeEngine(native, async () => { fetches++; return jsonRes(FOUND); });
  await svc.setProxy("https://p.example.dev");
  assert.equal(eng.startMonitoring({ intervalMs: 1 }), true);
  assert.equal(eng.startMonitoring(), false, "starting twice does nothing");
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(native.calls >= 3, "cell info is refreshed repeatedly");
  assert.equal(fetches, 1, "the unchanged cell is looked up once");
  cellId = "101";
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fetches, 2, "a changed cell is looked up");
  eng.stopMonitoring();
  assert.equal(eng.timer, null);
  assert.equal(eng.getStatus().monitoring, false);
  const calls = native.calls;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(native.calls, calls, "nothing runs after stop");
});

test("engine: a failed lookup while monitoring is retried only after the back-off", async () => {
  const native = fakeNative(() => RAW([LTE]));
  let fetches = 0;
  const { eng, svc } = makeEngine(native, async () => { fetches++; throw new Error("offline"); });
  await svc.setProxy("https://p.example.dev");
  eng.startMonitoring({ intervalMs: 1 });
  await new Promise((r) => setTimeout(r, 30));
  eng.stopMonitoring();
  assert.equal(fetches, 1, "one attempt, then waits");
});

test("engine: stopMonitoring during a slow lookup drops the late answer", async () => {
  const native = fakeNative(() => RAW([LTE]));
  const { eng, svc } = makeEngine(native, () => new Promise((r) => setTimeout(() => r(jsonRes(FOUND)), 30)));
  await svc.setProxy("https://p.example.dev");
  eng.startMonitoring({ intervalMs: 1 });
  await new Promise((r) => setTimeout(r, 10));
  eng.stopMonitoring();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(eng.getStatus().lastResult, null);
});

// ── utils ──────────────────────────────────────────────────────────────────
test("utils: distance, plot layout keeps towers apart and in view, geo link", () => {
  assert.ok(Math.abs(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111195) < 200);
  const L = layoutPlot([{ lat: 19.07, lon: 72.87, rangeM: 1000 }, { lat: 19.08, lon: 72.88, rangeM: 800 }], 300);
  assert.equal(L.items.length, 2);
  for (const i of L.items) assert.ok(i.px > 0 && i.px < 300 && i.py > 0 && i.py < 300);
  assert.ok(L.items[0].px < L.items[1].px && L.items[0].py > L.items[1].py);
  assert.match(geoUri({ lat: 1, lon: 2 }, "Tower"), /^geo:1,2\?q=1,2\(Tower\)$/);
});

// ── proxy worker ───────────────────────────────────────────────────────────
const ask = (path, env, headers = {}) => worker.fetch(new Request(`https://p.dev${path}`, { headers: { "CF-Connecting-IP": `ip${Math.random()}`, ...headers } }), env, { waitUntil() {} });
const Q = "/cell?radio=LTE&mcc=404&mnc=10&lac=1234&cellid=56789";

test("worker: validates input before anything leaves the proxy", async () => {
  const realFetch = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = async () => { upstream++; return new Response("{}"); };
  try {
    const env = { OPENCELLID_KEY: "SECRETKEY" };
    for (const bad of ["/cell?radio=CDMA&mcc=404&mnc=10&lac=1&cellid=1", "/cell?radio=LTE&mcc=40&mnc=10&lac=1&cellid=1", "/cell?radio=LTE&mcc=404&mnc=10&lac=0&cellid=1", "/cell?radio=LTE&mcc=404&mnc=10&lac=1&cellid=268435456", "/cell?radio=LTE&mcc=404&mnc=1x&lac=1&cellid=1", "/cell"]) {
      assert.equal((await ask(bad, env)).status, 400, bad);
    }
    assert.equal((await ask("/other", env)).status, 404);
    assert.equal(upstream, 0);
    assert.equal((await ask(Q, {})).status, 500, "no key configured");
    assert.equal((await ask(Q, { OPENCELLID_KEY: "K", PROXY_TOKEN: "t" })).status, 401);
    assert.equal(validate(new URL("https://x" + Q)).params.cellid, 56789);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("worker: adds the key upstream, normalises the answer, never returns the key", async () => {
  const realFetch = globalThis.fetch;
  let seen = "";
  globalThis.fetch = async (u) => { seen = String(u); return new Response(JSON.stringify({ lat: 19.07, lon: 72.87, mcc: 404, range: 1500, samples: 9, changeable: 1, averageSignalStrength: -88, radio: "LTE" })); };
  try {
    const res = await ask(Q, { OPENCELLID_KEY: "SECRETKEY", PROXY_TOKEN: "t" }, { "X-Proxy-Token": "t" });
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.found, true);
    assert.equal(body.tower.range, 1500);
    assert.ok(!text.includes("SECRETKEY"));
    const u = new URL(seen);
    assert.equal(u.origin + u.pathname, "https://opencellid.org/cell/get");
    assert.deepEqual([u.searchParams.get("key"), u.searchParams.get("mcc"), u.searchParams.get("mnc"), u.searchParams.get("lac"), u.searchParams.get("cellid"), u.searchParams.get("radio"), u.searchParams.get("format")], ["SECRETKEY", "404", "10", "1234", "56789", "LTE", "json"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("worker: not found, limits, bad key, timeouts and junk answers map to clear errors", async () => {
  const realFetch = globalThis.fetch;
  const env = { OPENCELLID_KEY: "K" };
  const answer = async (impl) => { globalThis.fetch = impl; const r = await ask(Q, env); return [r.status, await r.json()]; };
  try {
    let [s, b] = await answer(async () => new Response(JSON.stringify({ error: "Cell not found", code: 1 })));
    assert.deepEqual([s, b.ok, b.found], [200, true, false]);
    [s, b] = await answer(async () => new Response(JSON.stringify({ error: "limit", code: 7 }), { status: 429 }));
    assert.deepEqual([s, b.error.code], [429, "rate-limited"]);
    [s, b] = await answer(async () => new Response(JSON.stringify({ error: "API Key not known", code: 2 }), { status: 401 }));
    assert.deepEqual([s, b.error.code], [502, "upstream-key-rejected"]);
    [s, b] = await answer(async () => new Response("Err: Invalid token"));
    assert.equal(b.error.code, "upstream-key-rejected");
    [s, b] = await answer(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); });
    assert.deepEqual([s, b.error.code], [504, "upstream-timeout"]);
    [s, b] = await answer(async () => new Response("<html>oops</html>", { status: 500 }));
    assert.equal(s, 502);
    [s, b] = await answer(async () => new Response(JSON.stringify({ lat: "x" })));
    assert.equal(b.error.code, "malformed-upstream");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("worker: limits requests per client", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Cell not found", code: 1 }));
  try {
    const env = { OPENCELLID_KEY: "K" };
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await worker.fetch(new Request(`https://p.dev${Q}`, { headers: { "CF-Connecting-IP": "same" } }), env, {})).status;
    assert.equal(last, 429);
  } finally {
    globalThis.fetch = realFetch;
  }
});
