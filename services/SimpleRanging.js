// ============================================================================
// SimpleRanging.js — the simple distance calculation, shared by the Raw tab
// and Signal Lab
//
//   raw RSSI -> Kalman filter on RSSI (optional) -> formula
//            -> Kalman filter on DISTANCE (optional) -> distance shown / used
//
//   Distance (m) = 10 ^ ((Measured Power - RSSI) / (10 x n))
//
// Nothing else: no outlier gate, no averaging, no body / wall / radio-map
// correction, no calibration model. One instance, so both screens show the
// same numbers and a change of n or Measured Power on either applies to both.
// It is separate from the main ranging engine (AdaptiveBeaconEngine), which
// the Fusion Map still uses.
// ============================================================================

import AsyncStorage from "@react-native-async-storage/async-storage";
import { v2Scanner } from "./v2BeaconScannerService.js";

const STORAGE_KEY = "@raw_distance_settings_v1";
export const SIMPLE_DEFAULTS = {
  // n per beacon (n1 for B1, n2 for B2): two beacons in different spots see
  // different surroundings, so each gets its own path-loss exponent.
  n1: 2.0, n2: 2.0, mp1: -59, mp2: -59,
  kalman: true, smooth: "medium",          // Kalman on RSSI
  distKalman: true, distSmooth: "medium",  // Kalman on distance
};
export const N_MIN = 1.0;
export const N_MAX = 6.0;

// ── 1-D Kalman filter on RSSI ───────────────────────────────────────────────
// State: the true signal level (dBm), assumed to drift slowly (random walk).
//   predict:  P = P + Q
//   update:   K = P / (P + R);  x = x + K (rssi - x);  P = (1 - K) P
// R = measurement noise: BLE RSSI scatters about +-3 dB per packet -> 9 dB^2.
// Q = how much the true level may change per packet. Small Q = smoother but
// slower to follow walking; large Q = faster but jumpier. Steady-state gain
// per preset (fraction of each new packet taken in): light 0.28, medium 0.17,
// strong 0.09 - i.e. it settles over roughly 4 / 6 / 11 packets.
export const KALMAN_R = 9;
export const SMOOTH_PRESETS = {
  fast: { label: "Light", q: 1.0 },
  medium: { label: "Medium", q: 0.3 },
  strong: { label: "Strong", q: 0.08 },
};
// A beacon silent this long restarts its filter from the next packet, so an
// old level is not dragged into a new place.
const KALMAN_RESET_GAP_MS = 5000;

// ── 1-D Kalman filter on DISTANCE ──────────────────────────────────────────
// Second stage, after the formula. Even a smoothed RSSI turns into a jumpy
// distance, because the formula is exponential: the same 1 dB wobble is a few
// centimetres at 1 m but most of a metre at 10 m. So here:
//   R = (DIST_NOISE_FRAC x d)^2   - measurement noise grows with distance
//   Q = q x dt                    - the true distance changes with walking,
//                                   per SECOND (packet rate does not matter)
// q in m^2/s per preset. Steady-state gain at ~5 packets/s and 5 m:
// light 0.29, medium 0.16, strong 0.085 (about 3 / 6 / 12 packets to settle).
// Farther away the gain gets smaller automatically (noisier -> smoother).
export const DIST_NOISE_FRAC = 0.2;
export const DIST_SMOOTH_PRESETS = {
  fast: { label: "Light", q: 0.6 },
  medium: { label: "Medium", q: 0.15 },
  strong: { label: "Strong", q: 0.04 },
};

/** One distance-Kalman step. f = {x, p, t} or null (start). */
export function distanceKalmanStep(f, d, qPerS, t) {
  const r = Math.max(0.01, (DIST_NOISE_FRAC * d) ** 2);
  if (!f || !Number.isFinite(f.x) || t - f.t > KALMAN_RESET_GAP_MS) {
    return { x: d, p: r, t };
  }
  const dt = Math.min(2, Math.max(0.02, (t - f.t) / 1000));
  const pPred = f.p + qPerS * dt;
  const k = pPred / (pPred + r);
  return { x: Math.max(0, f.x + k * (d - f.x)), p: (1 - k) * pPred, t, k };
}

/** The formula, exactly. */
export function rawDistanceM(rssi, measuredPower, n) {
  return Math.pow(10, (measuredPower - rssi) / (10 * n));
}

/** One Kalman step. f = {x, p, t} or null (start). Returns the new state. */
export function kalmanStep(f, rssi, q, t, r = KALMAN_R) {
  if (!f || !Number.isFinite(f.x) || t - f.t > KALMAN_RESET_GAP_MS) {
    return { x: rssi, p: r, t };
  }
  const pPred = f.p + q;
  const k = pPred / (pPred + r);
  return { x: f.x + k * (rssi - f.x), p: (1 - k) * pPred, t, k };
}

class SimpleRanging {
  constructor() {
    this.settings = { ...SIMPLE_DEFAULTS };
    this.kf = { 1: null, 2: null };
    this.dkf = { 1: null, 2: null }; // distance Kalman state
    this.last = { 1: null, 2: null }; // { rssi, kf, dFormula, dKalman, t, count }
    this.listeners = new Set();
    this._unsub = null;
    this._loaded = false;
  }

  _ensureStarted() {
    if (!this._loaded) {
      this._loaded = true;
      AsyncStorage.getItem(STORAGE_KEY)
        .then((raw) => {
          if (raw) {
            const saved = JSON.parse(raw);
            // Older saves had one shared n: both beacons start from it.
            if (Number.isFinite(saved.n)) {
              if (!Number.isFinite(saved.n1)) saved.n1 = saved.n;
              if (!Number.isFinite(saved.n2)) saved.n2 = saved.n;
              delete saved.n;
            }
            this.settings = { ...SIMPLE_DEFAULTS, ...saved };
          }
          this._emit();
        })
        .catch(() => {});
    }
    if (!this._unsub) {
      this._unsub = v2Scanner.subscribePackets((pkt) => this._onPacket(pkt));
    }
  }

  _onPacket(pkt) {
    const num = pkt?.beaconNum;
    if ((num !== 1 && num !== 2) || !Number.isFinite(pkt.rawRssi)) return;
    const now = Date.now();
    const q = (SMOOTH_PRESETS[this.settings.smooth] || SMOOTH_PRESETS.medium).q;
    this.kf[num] = kalmanStep(this.kf[num], pkt.rawRssi, q, now);
    // Formula on the RSSI in use, then the distance filter on its result.
    const used = this.settings.kalman ? this.kf[num].x : pkt.rawRssi;
    const dFormula = rawDistanceM(used, this.measuredPower(num), this.pathLossN(num));
    const dq = (DIST_SMOOTH_PRESETS[this.settings.distSmooth] || DIST_SMOOTH_PRESETS.medium).q;
    this.dkf[num] = distanceKalmanStep(this.dkf[num], dFormula, dq, now);
    this.last[num] = {
      rssi: pkt.rawRssi,
      kf: this.kf[num].x,
      dFormula,
      dKalman: this.dkf[num].x,
      t: now,
      count: (this.last[num]?.count || 0) + 1,
    };
    this._emit();
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  /** fn(simpleRanging) on every packet and settings change. Returns unsubscribe. */
  subscribe(fn) {
    this._ensureStarted();
    this.listeners.add(fn);
    fn(this);
    return () => this.listeners.delete(fn);
  }

  setSettings(patch) {
    const next = { ...this.settings, ...patch };
    // setSettings({ n }) sets both beacons' n at once.
    if (Number.isFinite(patch.n)) { next.n1 = patch.n; next.n2 = patch.n; delete next.n; }
    for (const k of ["n1", "n2"]) {
      if (Number.isFinite(next[k])) next[k] = Math.max(N_MIN, Math.min(N_MAX, Number(next[k].toFixed(2))));
    }
    // Switching the filter on/off starts it fresh.
    if (patch.kalman !== undefined && patch.kalman !== this.settings.kalman) this.kf = { 1: null, 2: null };
    // Anything that changes the formula's output starts the distance filter
    // fresh, so it jumps straight to the new value instead of gliding to it.
    if (["n1", "n2", "mp1", "mp2", "kalman", "distKalman"].some((k) => next[k] !== this.settings[k])) {
      this.dkf = { 1: null, 2: null };
      for (const k of [1, 2]) if (this.last[k]) this.last[k] = { ...this.last[k], dKalman: null };
    }
    this.settings = next;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
    this._emit();
  }

  measuredPower(num) {
    return num === 1 ? this.settings.mp1 : this.settings.mp2;
  }

  pathLossN(num) {
    return num === 1 ? this.settings.n1 : this.settings.n2;
  }

  /**
   * Everything about one beacon: raw and Kalman RSSI, the RSSI used, and the
   * distance from it (and from the raw packet alone).
   */
  getBeacon(num) {
    const p = this.last[num];
    const mp = this.measuredPower(num);
    const n = this.pathLossN(num);
    if (!p) {
      return { num, mp, n, rssi: null, kf: null, used: null, distanceM: null, formulaDistanceM: null, rawDistanceM: null, t: null, count: 0 };
    }
    const used = this.settings.kalman && Number.isFinite(p.kf) ? p.kf : p.rssi;
    // Formula result on the RSSI in use (after a settings change, recomputed).
    const formulaDistanceM = rawDistanceM(used, mp, n);
    const distanceM = this.settings.distKalman && Number.isFinite(p.dKalman) ? p.dKalman : formulaDistanceM;
    return {
      num, mp, n,
      rssi: p.rssi,
      kf: p.kf,
      used,
      // The distance every screen shows and the Fusion Map uses.
      distanceM,
      // Before the distance filter, and from the raw packet alone.
      formulaDistanceM,
      rawDistanceM: rawDistanceM(p.rssi, mp, n),
      t: p.t,
      count: p.count,
    };
  }

  /**
   * Distance of any device from one raw reading (for device lists). n: that
   * beacon's own, or for other devices the average of B1's and B2's.
   */
  estimateM(rssi, measuredPower = -59, n = null) {
    if (!Number.isFinite(rssi)) return null;
    const useN = Number.isFinite(n) ? n : (this.settings.n1 + this.settings.n2) / 2;
    return rawDistanceM(rssi, Number.isFinite(measuredPower) ? measuredPower : -59, useN);
  }
}

export const simpleRanging = new SimpleRanging();
