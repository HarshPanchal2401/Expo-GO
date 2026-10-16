// ============================================================================
// OpenCelliDService.js — cell tower lookup through YOUR proxy (never the key)
//
//   app  --GET {proxy}/cell?radio&mcc&mnc&lac&cellid-->  proxy  -->  opencellid.org/cell/get
//
// The OpenCelliD API key lives only in the proxy's environment
// (cellular-proxy/). The app stores the proxy address, and optionally a shared
// token, on the phone. Each answer says where the tower is - NOT where the
// phone is.
//
// Protecting the 1,000 requests per day OpenCelliD allows per key:
//   - every answer is cached by cell key (found: 7 days, not found: 6 hours);
//   - the same cell is never requested twice at once;
//   - a limit of MAX_NETWORK_LOOKUPS requests per app run, and a gap of
//     MIN_GAP_MS between them;
//   - after a rate-limit answer nothing is sent for RATE_LIMIT_PAUSE_MS.
// Errors are never cached.
//
// No storage / fetch import here, so it runs (and is tested) in plain Node:
// pass { fetchImpl, storage, now }.
// ============================================================================

import { cellKey, lookupParams } from "./CellularTypes.js";

export const SERVICE_CONFIG = {
  TIMEOUT_MS: 8000,
  FOUND_TTL_MS: 7 * 24 * 3600 * 1000,
  NOT_FOUND_TTL_MS: 6 * 3600 * 1000,
  MAX_CACHE_ENTRIES: 200,
  MAX_NETWORK_LOOKUPS: 100,
  MIN_GAP_MS: 1000,
  RATE_LIMIT_PAUSE_MS: 10 * 60 * 1000,
};

const CACHE_KEY = "@cellular_cache_v1";
const CONFIG_KEY = "@cellular_config_v1";

const err = (code, message) => ({ code, message });

/** https only (a local proxy on the phone / emulator may use http). */
export function validProxyUrl(u) {
  if (typeof u !== "string") return false;
  return /^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?(\/[^\s]*)?$/i.test(u);
}

export class OpenCelliDService {
  constructor({ fetchImpl, storage, now = () => Date.now(), config = {} } = {}) {
    this.fetch = fetchImpl;
    this.storage = storage || null;
    this.now = now;
    this.cfg = { ...SERVICE_CONFIG, ...config };
    this.proxy = { url: "", token: "" };
    this.cache = new Map(); // key -> { at, found, tower }
    this.loaded = false;
    this.inflight = new Map();
    this.networkLookups = 0;
    this.lastNetworkAt = 0;
    this.pausedUntil = 0;
  }

  async _load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    try {
      const c = JSON.parse((await this.storage.getItem(CONFIG_KEY)) || "null");
      if (c && validProxyUrl(c.url)) this.proxy = { url: c.url, token: String(c.token || "") };
      const raw = JSON.parse((await this.storage.getItem(CACHE_KEY)) || "null");
      if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) this.cache.set(k, v);
    } catch {
      /* unreadable storage: start empty */
    }
  }

  async _saveCache() {
    if (!this.storage) return;
    const entries = [...this.cache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, this.cfg.MAX_CACHE_ENTRIES);
    try {
      await this.storage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* the cache is an optimisation only */
    }
  }

  async getProxy() {
    await this._load();
    return { ...this.proxy };
  }

  /** Saves the proxy address (and optional token). Returns { ok, error? }. */
  async setProxy(url, token = "") {
    await this._load();
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (u && !validProxyUrl(u)) return { ok: false, error: "The proxy address must start with https://" };
    this.proxy = { url: u, token: String(token || "").trim() };
    if (this.storage) await this.storage.setItem(CONFIG_KEY, JSON.stringify(this.proxy));
    return { ok: true };
  }

  getUsage() {
    return {
      networkLookups: this.networkLookups,
      limit: this.cfg.MAX_NETWORK_LOOKUPS,
      pausedUntil: this.pausedUntil > this.now() ? this.pausedUntil : 0,
      cached: this.cache.size,
    };
  }

  async clearCache() {
    await this._load();
    this.cache.clear();
    await this._saveCache();
  }

  /**
   * One lookup. Always resolves to
   * { status: "found" | "not-found" | "invalid" | "error", key, tower?, error?,
   *   latencyMs, cache: "hit" | "miss" | "none" }
   * tower = { lat, lon, rangeM, samples, changeable, avgSignalDbm, radio } (the TOWER).
   */
  async lookup(cell, { force = false } = {}) {
    await this._load();
    const v = lookupParams(cell);
    if (!v.ok) {
      return { status: "invalid", key: null, error: err("invalid-cell", v.problems.join("; ")), latencyMs: 0, cache: "none" };
    }
    const key = cellKey(cell);
    const t0 = this.now();
    const hit = this.cache.get(key);
    if (hit && !force) {
      const ttl = hit.found ? this.cfg.FOUND_TTL_MS : this.cfg.NOT_FOUND_TTL_MS;
      if (t0 - hit.at < ttl) {
        return { status: hit.found ? "found" : "not-found", key, tower: hit.tower, latencyMs: 0, cache: "hit" };
      }
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this._network(key, v.params).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async _network(key, params) {
    const fail = (e, latencyMs = 0) => ({ status: "error", key, error: e, latencyMs, cache: "miss" });
    if (!this.proxy.url) return fail(err("proxy-not-configured", "Set the proxy address first (Cellular Test > Proxy)."));
    if (typeof this.fetch !== "function") return fail(err("no-fetch", "fetch is not available"));
    const t0 = this.now();
    if (t0 < this.pausedUntil) {
      return fail(err("rate-limited", `Daily limit reached. Paused for ${Math.ceil((this.pausedUntil - t0) / 60000)} min.`));
    }
    if (this.networkLookups >= this.cfg.MAX_NETWORK_LOOKUPS) {
      return fail(err("session-limit", `${this.cfg.MAX_NETWORK_LOOKUPS} lookups used in this run. Restart the app to continue.`));
    }
    if (t0 - this.lastNetworkAt < this.cfg.MIN_GAP_MS) {
      return fail(err("too-fast", "Lookups are limited to one per second."));
    }
    this.networkLookups++;
    this.lastNetworkAt = t0;

    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.cfg.TIMEOUT_MS) : null;
    try {
      const headers = { Accept: "application/json" };
      if (this.proxy.token) headers["X-Proxy-Token"] = this.proxy.token;
      const res = await this.fetch(`${this.proxy.url}/cell?${qs}`, { headers, signal: ctrl?.signal });
      const latencyMs = this.now() - t0;
      let body = null;
      try {
        body = await res.json();
      } catch {
        return fail(err("malformed-response", `The proxy answered HTTP ${res.status} with something that is not JSON.`), latencyMs);
      }
      if (res.status === 429 || body?.error?.code === "rate-limited" || body?.error?.code === 7) {
        this.pausedUntil = this.now() + this.cfg.RATE_LIMIT_PAUSE_MS;
        return fail(err("rate-limited", "OpenCelliD daily limit (or the proxy limit) reached."), latencyMs);
      }
      if (body && body.ok === true && body.found === false) {
        this.cache.set(key, { at: this.now(), found: false, tower: null });
        this._saveCache();
        return { status: "not-found", key, tower: null, latencyMs, cache: "miss" };
      }
      if (body && body.ok === true && body.found === true) {
        const tower = parseTower(body.tower);
        if (!tower) return fail(err("malformed-response", "The tower record has no valid coordinates."), latencyMs);
        this.cache.set(key, { at: this.now(), found: true, tower });
        this._saveCache();
        return { status: "found", key, tower, latencyMs, cache: "miss" };
      }
      const e = body?.error;
      return fail(err(String(e?.code ?? `http-${res.status}`), String(e?.message ?? `The proxy answered HTTP ${res.status}.`)), latencyMs);
    } catch (e) {
      const aborted = e?.name === "AbortError";
      return fail(
        aborted ? err("timeout", `No answer in ${this.cfg.TIMEOUT_MS / 1000} s.`) : err("network", "No connection to the proxy."),
        this.now() - t0
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** The proxy's tower record -> a checked tower, or null. */
export function parseTower(t) {
  const lat = Number(t?.lat), lon = Number(t?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null; // "null island": a missing value, not a place
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
  return {
    lat,
    lon,
    rangeM: num(t.range),
    samples: num(t.samples),
    changeable: t.changeable === undefined || t.changeable === null ? null : Number(t.changeable) === 1 || t.changeable === true,
    avgSignalDbm: num(t.averageSignalStrength) !== null && Number(t.averageSignalStrength) !== 0 ? Number(t.averageSignalStrength) : null,
    radio: t.radio ? String(t.radio) : null,
  };
}
