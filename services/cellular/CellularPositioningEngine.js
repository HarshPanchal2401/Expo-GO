// ============================================================================
// CellularPositioningEngine.js — EXPERIMENT: what can cell towers tell us?
//
// Completely separate from the indoor engines: it does not import or feed
// FusionEngine, PdrEngine, BLE, the particle filter or the floor plan, and
// nothing in them imports it. It uses no GPS, Wi-Fi, IP location, BLE or PDR.
//
// What it does:
//   getCellInfo()      the cells Android reports (serving + neighbours)
//   lookupCell(cell)   where OpenCelliD says that TOWER is
//   findLocation()     one test: read cells, look the serving cell up, record it
//   startMonitoring()  repeat the reading every few seconds; look up only a
//   stopMonitoring()   NEW cell (changed identifiers), never the same one twice
//   getStatus()        where the test stands
//
// What it does NOT do: put the phone on the map. A tower's coordinates are the
// tower's. With one tower (the normal case) there is no defensible phone
// position, so phoneEstimate is always null. Several towers do not make a
// trilateration without validated distances (a cell's range is a coverage
// estimate, not a distance to the phone), so none is claimed.
//
// Dependencies are passed in ({ native, service, storage }) so it runs in
// plain Node for tests; services/cellular/index.js wires the real ones.
// ============================================================================

import { normalizeCell, cellKey, maskId } from "./CellularTypes.js";

export const ENGINE_CONFIG = {
  // Monitoring: time between readings (ms), at least MIN_INTERVAL_MS.
  MONITOR_INTERVAL_MS: 10000,
  MIN_INTERVAL_MS: 3000,
  // After a failed lookup while monitoring, wait this long before trying again.
  ERROR_RETRY_MS: 30000,
  // Neighbour cells looked up per test when asked to (each costs one of the
  // 1,000 daily OpenCelliD requests).
  MAX_NEIGHBOUR_LOOKUPS: 4,
  HISTORY_MAX: 100,
};

export const NO_ESTIMATE_NOTE =
  "No phone position: OpenCelliD gives where a tower is, not where the phone is. " +
  "One tower cannot fix a position, and a cell's range is a coverage estimate, not a distance to you.";

const HISTORY_KEY = "@cellular_history_v1";

export class CellularPositioningEngine {
  constructor({ native, service, storage = null, requestPermission = null, now = () => Date.now(), config = {} } = {}) {
    this.native = native;
    this.service = service;
    this.storage = storage;
    this.requestPermission = requestPermission;
    this.now = now;
    this.cfg = { ...ENGINE_CONFIG, ...config };
    this.listeners = new Set();
    this.timer = null;
    this.monitoring = false;
    this.generation = 0; // bumped by stopMonitoring: late answers are dropped
    this.busy = false;
    this.lastLookedKey = null;
    this.retryAfter = 0;
    this.history = [];
    this.historyLoaded = false;
    this.status = {
      state: "idle", // idle | collecting | looking-up | monitoring | error
      available: null, // native module present
      permissionGranted: null,
      serviceAvailable: null, // SIM ready and an operator registered
      radio: null,
      servingAvailable: null,
      lastLookupAt: null,
      lastResult: null,
      info: null,
      monitoring: false,
      error: null,
    };
  }

  // ── subscriptions ─────────────────────────────────────────────────────────
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.getStatus());
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const s = this.getStatus();
    for (const fn of this.listeners) fn(s);
  }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this._emit();
  }

  getStatus() {
    return { ...this.status, monitoring: this.monitoring };
  }

  // ── getCellInfo ───────────────────────────────────────────────────────────
  /**
   * { ok, reason?, message?, observedAt, serving, servingAll, neighbours, cells,
   *   sim: { simState, operatorName, operator }, locationServicesOn, apiLevel }
   * reason: native-module-missing | no-telephony | permission-denied | native-error
   */
  async getCellInfo() {
    const observedAt = this.now();
    const done = (info) => {
      this._set({
        available: info.reason !== "native-module-missing",
        permissionGranted: info.reason === "permission-denied" ? false : info.permissionGranted ?? this.status.permissionGranted,
        serviceAvailable: info.serviceAvailable ?? null,
        radio: info.serving?.radio ?? null,
        servingAvailable: info.ok ? Boolean(info.serving) : null,
        info,
        error: info.ok ? null : info.message || info.reason,
      });
      return info;
    };
    if (!this.native?.isAvailable) {
      return done({ ok: false, reason: "native-module-missing", message: "This build has no cellular module (Expo Go, iOS, or an older APK). Install a new build.", observedAt });
    }
    let raw;
    try {
      raw = await this.native.getCellInfo();
    } catch (e) {
      return done({ ok: false, reason: "native-error", message: String(e?.message || e), observedAt });
    }
    const sim = { simState: raw?.simState ?? null, operatorName: raw?.operatorName ?? null, operator: raw?.operator ?? null };
    // SIM_STATE_READY = 5
    const serviceAvailable = Boolean(raw?.hasTelephony) && sim.simState === 5 && Boolean(sim.operator);
    const meta = { sim, serviceAvailable, permissionGranted: Boolean(raw?.permissionGranted), locationServicesOn: raw?.locationServicesOn ?? null, apiLevel: raw?.apiLevel ?? null, observedAt };
    if (!raw?.hasTelephony) return done({ ok: false, reason: "no-telephony", message: "This device has no cellular radio.", ...meta });
    if (!raw.permissionGranted) return done({ ok: false, reason: "permission-denied", message: "Location permission is needed to read cell information.", ...meta });

    const seen = new Set();
    const cells = [];
    for (const r of raw.cells || []) {
      const c = normalizeCell(r, observedAt);
      const k = c.lookupable ? cellKey(c) : null;
      if (k) {
        if (seen.has(k)) continue; // the same cell reported twice
        seen.add(k);
      }
      cells.push(c);
    }
    const servingAll = cells.filter((c) => c.serving);
    // First serving cell that can be looked up (a 5G NSA phone reports LTE + NR).
    const serving = servingAll.find((c) => c.lookupable) || servingAll[0] || null;
    const neighbours = cells.filter((c) => !c.serving);
    return done({
      ok: true,
      ...(raw.error ? { warning: raw.error } : {}),
      ...meta,
      cells,
      serving,
      servingAll,
      neighbours,
    });
  }

  // ── lookupCell ────────────────────────────────────────────────────────────
  lookupCell(cell, opts) {
    return this.service.lookup(cell, opts);
  }

  // ── findLocation: one test ────────────────────────────────────────────────
  /**
   * opts: { label?: string (where the test was made), includeNeighbours?: boolean }
   * Resolves to { at, label, status, info, serving, lookup, neighbourLookups,
   *   towers, phoneEstimate: null, note }.
   * status: tower-found | tower-not-found | no-serving-cell | serving-not-lookupable |
   *         lookup-error | permission-denied | unavailable
   */
  async findLocation({ label = "", includeNeighbours = false } = {}) {
    await this._loadHistory();
    this._set({ state: "collecting", error: null });
    const info = await this.getCellInfo();
    const base = { at: this.now(), label, info, serving: info.serving || null, lookup: null, neighbourLookups: [], towers: [], phoneEstimate: null, note: NO_ESTIMATE_NOTE };
    let result;
    if (!info.ok) {
      result = { ...base, status: info.reason === "permission-denied" ? "permission-denied" : "unavailable" };
    } else if (!info.serving) {
      result = { ...base, status: "no-serving-cell" };
    } else if (!info.serving.lookupable) {
      result = { ...base, status: "serving-not-lookupable" };
    } else {
      this._set({ state: "looking-up" });
      const lookup = await this.lookupCell(info.serving);
      const neighbourLookups = [];
      if (includeNeighbours) {
        const list = info.neighbours.filter((c) => c.lookupable).slice(0, this.cfg.MAX_NEIGHBOUR_LOOKUPS);
        for (const c of list) neighbourLookups.push({ cell: c, lookup: await this.lookupCell(c) });
      }
      const towers = [];
      if (lookup.status === "found") towers.push({ cell: info.serving, serving: true, tower: lookup.tower });
      for (const n of neighbourLookups) if (n.lookup.status === "found") towers.push({ cell: n.cell, serving: false, tower: n.lookup.tower });
      const status =
        lookup.status === "found" ? "tower-found" : lookup.status === "not-found" ? "tower-not-found" : "lookup-error";
      result = { ...base, status, lookup, neighbourLookups, towers };
      if (lookup.status === "found" || lookup.status === "not-found") this.lastLookedKey = lookup.key;
    }
    this._record(result);
    this._set({
      state: this.monitoring ? "monitoring" : "idle",
      lastResult: result,
      lastLookupAt: result.lookup && result.lookup.status !== "error" && result.lookup.status !== "invalid" ? this.now() : this.status.lastLookupAt,
    });
    return result;
  }

  // ── monitoring ────────────────────────────────────────────────────────────
  startMonitoring({ intervalMs = this.cfg.MONITOR_INTERVAL_MS, label = "monitor" } = {}) {
    if (this.monitoring) return false;
    const every = Math.max(this.cfg.MIN_INTERVAL_MS, Number(intervalMs) || this.cfg.MONITOR_INTERVAL_MS);
    this.monitoring = true;
    const gen = ++this.generation;
    this.lastLookedKey = null;
    const tick = async () => {
      if (!this.monitoring || gen !== this.generation || this.busy) return;
      this.busy = true;
      try {
        const info = await this.getCellInfo();
        if (!this.monitoring || gen !== this.generation) return;
        const s = info.serving;
        // Only a NEW (changed) serving cell is looked up; the same one never again.
        if (info.ok && s?.lookupable && cellKey(s) !== this.lastLookedKey && this.now() >= this.retryAfter) {
          this._set({ state: "looking-up" });
          const lookup = await this.lookupCell(s);
          if (!this.monitoring || gen !== this.generation) return;
          if (lookup.status === "found" || lookup.status === "not-found") {
            this.lastLookedKey = lookup.key;
            this.retryAfter = 0;
          } else {
            this.retryAfter = this.now() + this.cfg.ERROR_RETRY_MS;
          }
          const result = {
            at: this.now(), label, info, serving: s, lookup, neighbourLookups: [],
            towers: lookup.status === "found" ? [{ cell: s, serving: true, tower: lookup.tower }] : [],
            phoneEstimate: null, note: NO_ESTIMATE_NOTE,
            status: lookup.status === "found" ? "tower-found" : lookup.status === "not-found" ? "tower-not-found" : "lookup-error",
          };
          this._record(result);
          this._set({ lastResult: result, lastLookupAt: lookup.status === "error" ? this.status.lastLookupAt : this.now() });
        }
        this._set({ state: "monitoring" });
      } finally {
        this.busy = false;
      }
    };
    this._set({ state: "monitoring", error: null });
    tick();
    this.timer = setInterval(tick, every);
    return true;
  }

  stopMonitoring() {
    this.monitoring = false;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.busy = false;
    this._set({ state: "idle" });
  }

  // ── history ───────────────────────────────────────────────────────────────
  async _loadHistory() {
    if (this.historyLoaded) return;
    this.historyLoaded = true;
    if (!this.storage) return;
    try {
      const h = JSON.parse((await this.storage.getItem(HISTORY_KEY)) || "[]");
      if (Array.isArray(h)) this.history = h;
    } catch {
      /* start empty */
    }
  }

  async getHistory() {
    await this._loadHistory();
    return [...this.history];
  }

  async clearHistory() {
    this.history = [];
    this.historyLoaded = true;
    if (this.storage) await this.storage.removeItem(HISTORY_KEY);
  }

  /** One test as a plain, small record (identifiers masked). Real observations only. */
  _record(r) {
    const s = r.serving;
    const entry = {
      at: r.at,
      label: r.label || "",
      status: r.status,
      radio: s?.radio ?? null,
      mccMnc: s && s.mcc !== null ? `${s.mcc}-${s.mnc}` : null,
      cell: s ? maskId(s.cellId) : null,
      signalDbm: s?.signalDbm ?? null,
      lookup: r.lookup ? r.lookup.status : null,
      cache: r.lookup ? r.lookup.cache : null,
      latencyMs: r.lookup ? r.lookup.latencyMs : null,
      error: r.lookup?.error?.code ?? null,
      tower: r.towers[0] ? { lat: r.towers[0].tower.lat, lon: r.towers[0].tower.lon, rangeM: r.towers[0].tower.rangeM } : null,
    };
    this.history = [entry, ...this.history].slice(0, this.cfg.HISTORY_MAX);
    if (this.storage) this.storage.setItem(HISTORY_KEY, JSON.stringify(this.history)).catch(() => {});
  }
}
