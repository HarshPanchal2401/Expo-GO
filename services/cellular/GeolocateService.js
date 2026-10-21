// ============================================================================
// GeolocateService.js — where is the PHONE, from the cells it hears
//
// Uses BeaconDB (https://beacondb.net), a free, key-less service that speaks the
// MLS/Ichnaea "geolocate" API:
//   POST https://api.beacondb.net/v1/geolocate
//   { considerIp: false, cellTowers: [{ radioType, mobileCountryCode,
//     mobileNetworkCode, locationAreaCode, cellId, signalStrength }] }
//   -> { location: { lat, lng }, accuracy }      (404 when it knows none of them)
//
// The answer is a phone position with an accuracy radius (usually hundreds of
// metres to a few km from cell towers alone). It is cell-level, never room-level.
// No fetch import here, so it runs in plain Node: pass { fetchImpl }.
// ============================================================================

export const GEOLOCATE_CONFIG = {
  URL: "https://api.beacondb.net/v1/geolocate",
  TIMEOUT_MS: 8000,
  MAX_CELLS: 8,
  CACHE_TTL_MS: 10 * 60 * 1000,
};

const RADIO = { LTE: "lte", NR: "nr", GSM: "gsm", UMTS: "wcdma" };

export class GeolocateService {
  constructor({ fetchImpl, now = () => Date.now(), config = {} } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.cfg = { ...GEOLOCATE_CONFIG, ...config };
    this.cache = new Map(); // cell-set key -> { at, result }
  }

  /**
   * cells: normalised cells (CellularTypes.normalizeCell). Only lookupable ones are sent.
   * Resolves to { status: "found" | "not-found" | "error" | "no-cells",
   *   lat?, lon?, accuracyM?, cellsUsed, error?, latencyMs, cache }.
   */
  async locate(cells) {
    const usable = (cells || []).filter((c) => c.lookupable && RADIO[c.radio]).slice(0, this.cfg.MAX_CELLS);
    if (!usable.length) return { status: "no-cells", cellsUsed: 0, latencyMs: 0, cache: "none" };
    const key = usable.map((c) => `${c.radio}:${c.mcc}:${c.mnc}:${c.areaCode}:${c.cellId}`).sort().join("|");
    const hit = this.cache.get(key);
    const t0 = this.now();
    if (hit && t0 - hit.at < this.cfg.CACHE_TTL_MS) return { ...hit.result, latencyMs: 0, cache: "hit" };
    if (typeof this.fetch !== "function") return { status: "error", cellsUsed: usable.length, error: { code: "no-fetch", message: "fetch is not available" }, latencyMs: 0, cache: "miss" };

    const body = {
      considerIp: false,
      cellTowers: usable.map((c) => ({
        radioType: RADIO[c.radio],
        mobileCountryCode: c.mcc,
        mobileNetworkCode: c.mnc,
        locationAreaCode: c.areaCode,
        cellId: c.cellId,
        ...(c.signalDbm !== null ? { signalStrength: c.signalDbm } : {}),
      })),
    };
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.cfg.TIMEOUT_MS) : null;
    try {
      const res = await this.fetch(this.cfg.URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "NexusIndoorNav-CellTest/1.0" },
        body: JSON.stringify(body),
        signal: ctrl?.signal,
      });
      const latencyMs = this.now() - t0;
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* handled below */
      }
      if (res.status === 404) {
        const result = { status: "not-found", cellsUsed: usable.length };
        this.cache.set(key, { at: this.now(), result });
        return { ...result, latencyMs, cache: "miss" };
      }
      const lat = Number(json?.location?.lat), lon = Number(json?.location?.lng);
      if (res.ok && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
        const acc = Number(json.accuracy);
        const result = { status: "found", lat, lon, accuracyM: Number.isFinite(acc) && acc > 0 ? acc : null, cellsUsed: usable.length };
        this.cache.set(key, { at: this.now(), result });
        return { ...result, latencyMs, cache: "miss" };
      }
      return { status: "error", cellsUsed: usable.length, error: { code: `http-${res.status}`, message: json?.error?.message || `BeaconDB answered HTTP ${res.status}.` }, latencyMs, cache: "miss" };
    } catch (e) {
      const aborted = e?.name === "AbortError";
      return {
        status: "error",
        cellsUsed: usable.length,
        error: aborted ? { code: "timeout", message: `No answer in ${this.cfg.TIMEOUT_MS / 1000} s.` } : { code: "network", message: "No internet connection to BeaconDB." },
        latencyMs: this.now() - t0,
        cache: "miss",
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
