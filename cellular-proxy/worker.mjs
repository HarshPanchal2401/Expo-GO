// ============================================================================
// Cellular Test proxy — a Cloudflare Worker (free plan is enough)
//
// Holds the OpenCelliD API key so it is never in the app, in Git or in logs.
//
//   GET /cell?radio=LTE&mcc=404&mnc=10&lac=1234&cellid=56789
//   -> { ok: true, found: true,  tower: { lat, lon, range, samples, changeable,
//                                         averageSignalStrength, radio } }
//   -> { ok: true, found: false }
//   -> { ok: false, error: { code, message } }
//
// Environment (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   OPENCELLID_KEY   (Secret, required)  your OpenCelliD API key
//   PROXY_TOKEN      (Secret, optional)  if set, the app must send it in the
//                                        X-Proxy-Token header (stops strangers
//                                        using up your 1,000 daily lookups)
//
// Parameter names verified against https://wiki.opencellid.org/docs/api/cell-position
// (GET https://opencellid.org/cell/get ; key, mcc, mnc, lac, cellid, radio, format=json).
// ============================================================================

const UPSTREAM = "https://opencellid.org/cell/get";
const RADIOS = {
  GSM: { area: 65535, cell: 65535 },
  UMTS: { area: 65535, cell: 268435455 },
  LTE: { area: 65535, cell: 268435455 },
  NR: { area: 16777215, cell: 68719476735 },
};
const TIMEOUT_MS = 6000;
const FOUND_TTL_S = 24 * 3600;
const NOT_FOUND_TTL_S = 3600;
// Per client, per isolate (best effort): at most this many requests a minute.
const MAX_PER_MINUTE = 20;
const hits = new Map();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (status, code, message) => json({ ok: false, error: { code, message } }, status);

/** Whole number in [min, max] from a digit string, else null. */
function intIn(s, min, max) {
  if (typeof s !== "string" || !/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/** Checks the query; returns { params } or { error }. */
export function validate(url) {
  const q = url.searchParams;
  const radio = (q.get("radio") || "").toUpperCase();
  const lim = RADIOS[radio];
  if (!lim) return { error: "radio must be one of GSM, UMTS, LTE, NR" };
  const mcc = intIn(q.get("mcc"), 100, 999);
  const mnc = intIn(q.get("mnc"), 0, 999);
  const lac = intIn(q.get("lac"), 1, lim.area);
  const cellid = intIn(q.get("cellid"), 1, lim.cell);
  if (mcc === null) return { error: "mcc must be 100-999" };
  if (mnc === null) return { error: "mnc must be 0-999" };
  if (lac === null) return { error: `lac must be 1-${lim.area}` };
  if (cellid === null) return { error: `cellid must be 1-${lim.cell}` };
  return { params: { radio, mcc, mnc, lac, cellid } };
}

function limited(ip, now) {
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > MAX_PER_MINUTE;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET") return fail(405, "method-not-allowed", "Use GET.");
    if (url.pathname !== "/cell") return fail(404, "not-found", "Use /cell.");
    if (!env.OPENCELLID_KEY) return fail(500, "not-configured", "OPENCELLID_KEY is not set on the proxy.");
    if (env.PROXY_TOKEN && request.headers.get("X-Proxy-Token") !== env.PROXY_TOKEN) {
      return fail(401, "unauthorized", "Missing or wrong proxy token.");
    }
    const v = validate(url);
    if (v.error) return fail(400, "invalid-input", v.error);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (limited(ip, Date.now())) return fail(429, "rate-limited", "Too many requests. Wait a minute.");

    // Cache by identifiers only (the key is never part of the cache key).
    const cacheKey = new Request(`https://cellular-proxy.cache/${v.params.radio}/${v.params.mcc}/${v.params.mnc}/${v.params.lac}/${v.params.cellid}`);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return new Response(hit.body, { status: 200, headers: { "Content-Type": "application/json", "X-Proxy-Cache": "hit", "Cache-Control": "no-store" } });
    }

    const up = new URL(UPSTREAM);
    up.searchParams.set("key", env.OPENCELLID_KEY);
    for (const [k, val] of Object.entries(v.params)) up.searchParams.set(k, String(val));
    up.searchParams.set("format", "json");

    let res, text;
    try {
      res = await fetch(up.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      text = await res.text();
    } catch (e) {
      return fail(504, e?.name === "TimeoutError" ? "upstream-timeout" : "upstream-unreachable", "OpenCelliD did not answer.");
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON: handled below */
    }
    // Errors can come with HTTP 200 and a plain-text or JSON body (see the OpenCelliD errors page).
    if (res.status === 429 || body?.code === 7) return fail(429, "rate-limited", "OpenCelliD daily limit reached.");
    if (res.status === 401 || body?.code === 2 || /Invalid token/i.test(text)) return fail(502, "upstream-key-rejected", "OpenCelliD rejected the proxy's API key.");
    if (body?.code === 1 || /not found/i.test(body?.error || "")) {
      const out = JSON.stringify({ ok: true, found: false });
      if (cache) ctx?.waitUntil?.(cache.put(cacheKey, new Response(out, { headers: { "Cache-Control": `max-age=${NOT_FOUND_TTL_S}` } })));
      return new Response(out, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (!res.ok || !body || body.error) return fail(502, "upstream-error", `OpenCelliD answered HTTP ${res.status}.`);
    const lat = Number(body.lat), lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail(502, "malformed-upstream", "OpenCelliD answer has no coordinates.");
    const out = JSON.stringify({
      ok: true,
      found: true,
      tower: {
        lat, lon,
        range: body.range ?? null,
        samples: body.samples ?? null,
        changeable: body.changeable ?? null,
        averageSignalStrength: body.averageSignalStrength ?? null,
        radio: body.radio ?? v.params.radio,
      },
    });
    if (cache) ctx?.waitUntil?.(cache.put(cacheKey, new Response(out, { headers: { "Cache-Control": `max-age=${FOUND_TTL_S}` } })));
    return new Response(out, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  },
};
