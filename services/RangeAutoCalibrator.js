// ============================================================================
// RangeAutoCalibrator.js — learns each beacon's distance model while you walk
//
// Calibration needs the TRUE distance next to a measured level. Spot
// calibration gets it from a tap on the map. This gets it from PDR: once the
// position is known at one moment (a start set on the map, a spot calibration,
// or a confident BLE fix), every step moves it by a known length and heading,
// so for a while the position - and with it the true distance to each beacon
// - is known without asking. Each such moment becomes a calibration point, and
// the beacon's model RSSI(d) = A - 10 n log10(d) - alpha (d - 1) is refitted
// (see PathLossCalibrator.fitModel). Over a normal walk that covers near and
// far distances, which is exactly what fixes the distance-dependent RSSI@1m.
//
// PDR drifts, so trust runs out: the position uncertainty starts at the
// anchor's and grows with every metre walked. Each point carries that
// uncertainty, converted to dB, as its weight; past MAX_POS_SIGMA_M collection
// pauses until the next anchor.
//
// Deliberately independent of the BLE-corrected (fused) position: fitting the
// ranges to a position the same ranges produced would only confirm whatever
// model is already in use. For the same reason a BLE-located start is NOT an
// anchor - only a start tapped on the map or a spot calibration is.
// ============================================================================

const FT_PER_M = 3.28084;

export const AUTO_CAL_CONFIG = {
  // Position uncertainty of each kind of anchor, metres.
  ANCHOR_SIGMA_M: { manual: 0.5, spot: 0.35 },
  // PDR error per metre walked (step length ~4 %, heading ~3°, combined).
  DRIFT_PER_M: 0.06,
  // Collection pauses once the track is this uncertain (about 30 m walked
  // from a tapped start). Points are weighted by it, so the late ones count
  // for little near a beacon but still pin the far end of the curve.
  MAX_POS_SIGMA_M: 2.5,
  // A track that leaves the room by more than this is wrong (heading off).
  OUTSIDE_TOLERANCE_FT: 3,

  // Standing: one point per stop, averaged over the stop.
  STOP_MIN_MS: 4000,       // standing this long makes a point
  STOP_SETTLE_MS: 1000,    // ignore the first second (filter catching up)
  STOP_MIN_SAMPLES: 3,
  // Walking: one point per beacon this often, from a short window. The level
  // lags the true position a little (filtering), so it is paired with where
  // the user was WALK_LAG_MS earlier.
  WALK_SAMPLE_MS: 2000,
  WALK_WINDOW_MS: 1200,
  WALK_LAG_MS: 600,
  WALK_MIN_SAMPLES: 2,

  // Error sources beyond the position, dB. SHADOW: each place has its own
  // few-dB offset that no model of distance can explain. WALK: gait, phone
  // swing and filter lag while walking.
  SHADOW_SIGMA_DB: 2.5,
  WALK_EXTRA_SIGMA_DB: 3.0,
  // Too close: the near field does not follow the model.
  MIN_DISTANCE_M: 0.8,
};

export class RangeAutoCalibrator {
  /**
   * @param {object} deps
   *   getLevelWindow(num, fromT, toT) -> {ok, samples, level, shape}
   *   addPoint(num, floorDistanceM, level, shape, sigmaDb, atFt) -> fit | null
   *   getModel(num) -> {A, n, alpha}
   *   save()
   */
  constructor(deps, config = {}) {
    this.deps = deps;
    this.cfg = { ...AUTO_CAL_CONFIG, ...config };
    this.beacons = { 1: null, 2: null }; // {x, y} feet, map frame
    this.room = null;                    // {w, h} feet
    this.enabled = true;
    this._reset();
  }

  _reset() {
    this.active = false;
    this.source = null;
    this.pos = null;          // {x, y} feet
    this.sigma0M = 0;
    this.walkedM = 0;
    this.track = [];          // [{t, x, y}] for the walking lag lookup
    this.lastStepAt = 0;
    this.stopStartedAt = 0;
    this.stopRecorded = false;
    this.lastWalkSampleAt = 0;
    this.pausedReason = "no-anchor";
  }

  setGeometry(anchor1, anchor2, roomW, roomH) {
    this.beacons = { 1: anchor1 ? { ...anchor1 } : null, 2: anchor2 ? { ...anchor2 } : null };
    this.room = Number.isFinite(roomW) && Number.isFinite(roomH) ? { w: roomW, h: roomH } : null;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.enabled) this.stop("disabled");
  }

  /**
   * The position is known right now (feet, map frame).
   * @param {"manual"|"spot"|"locate"} source
   */
  setAnchor(xFt, yFt, source = "manual", t = Date.now()) {
    if (!this.enabled || !Number.isFinite(xFt) || !Number.isFinite(yFt)) return;
    if (!(source in this.cfg.ANCHOR_SIGMA_M)) return;
    this._reset();
    this.active = true;
    this.source = source;
    this.pos = { x: xFt, y: yFt };
    this.sigma0M = this.cfg.ANCHOR_SIGMA_M[source] ?? 1.0;
    this.track = [{ t, x: xFt, y: yFt }];
    this.lastStepAt = t;
    this.stopStartedAt = t;
    this.pausedReason = null;
    this.points = { 1: 0, 2: 0 };
  }

  stop(reason = "stopped") {
    if (this.active) this.deps.save?.();
    const points = this.points;
    this._reset();
    this.points = points;
    this.pausedReason = reason;
  }

  /** Current track uncertainty, metres. */
  posSigmaM() {
    return this.sigma0M + this.cfg.DRIFT_PER_M * this.walkedM;
  }

  /**
   * One PDR step. headingDeg in the map frame (0 = +Y, clockwise), so the
   * heading must have been zeroed to the map - the caller only forwards steps
   * once it has.
   */
  onStep(lengthM, headingDeg, t = Date.now()) {
    if (!this.active || !Number.isFinite(lengthM) || !Number.isFinite(headingDeg)) return;
    const rad = (headingDeg * Math.PI) / 180;
    const lenFt = lengthM * FT_PER_M;
    this.pos = { x: this.pos.x + lenFt * Math.sin(rad), y: this.pos.y + lenFt * Math.cos(rad) };
    this.walkedM += lengthM;
    this.lastStepAt = t;
    this.stopStartedAt = t;
    this.stopRecorded = false;
    this.track.push({ t, x: this.pos.x, y: this.pos.y });
    while (this.track.length > 2 && t - this.track[1].t > 10000) this.track.shift();

    if (this.room) {
      const tol = this.cfg.OUTSIDE_TOLERANCE_FT;
      const { x, y } = this.pos;
      if (x < -tol || y < -tol || x > this.room.w + tol || y > this.room.h + tol) {
        this.stop("left-room");
        return;
      }
    }
    if (this.posSigmaM() > this.cfg.MAX_POS_SIGMA_M) this.stop("drift");
  }

  /** Where the track was at time t (the last step at or before t). */
  _posAt(t) {
    for (let i = this.track.length - 1; i >= 0; i--) {
      if (this.track[i].t <= t) return this.track[i];
    }
    return this.track[0];
  }

  /** Call a few times a second. Returns the points added (for the UI). */
  tick(t = Date.now()) {
    if (!this.active) return [];
    const c = this.cfg;
    const added = [];
    const standingMs = t - this.lastStepAt;

    if (standingMs >= c.STOP_MIN_MS && !this.stopRecorded) {
      this.stopRecorded = true;
      for (const num of [1, 2]) {
        const r = this._record(num, this.pos, this.stopStartedAt + c.STOP_SETTLE_MS, t, c.STOP_MIN_SAMPLES, 0);
        if (r) added.push(r);
      }
      this.deps.save?.();
    } else if (standingMs < 1200 && t - this.lastWalkSampleAt >= c.WALK_SAMPLE_MS && this.walkedM > 0) {
      this.lastWalkSampleAt = t;
      const at = this._posAt(t - c.WALK_LAG_MS - c.WALK_WINDOW_MS / 2);
      for (const num of [1, 2]) {
        const r = this._record(num, at, t - c.WALK_WINDOW_MS, t, c.WALK_MIN_SAMPLES, c.WALK_EXTRA_SIGMA_DB);
        if (r) added.push(r);
      }
    }
    return added;
  }

  _record(num, at, fromT, toT, minSamples, extraSigmaDb) {
    const b = this.beacons[num];
    if (!b || !at) return null;
    const dM = Math.hypot(at.x - b.x, at.y - b.y) / FT_PER_M;
    if (dM < this.cfg.MIN_DISTANCE_M) return null;
    const w = this.deps.getLevelWindow(num, fromT, toT);
    if (!w?.ok || w.samples < minSamples) return null;
    // Position error -> level error: the slope of the model at this distance.
    const m = this.deps.getModel(num) || {};
    const n = Number.isFinite(m.n) ? m.n : 2.9;
    const alpha = Number.isFinite(m.alpha) ? m.alpha : 0;
    const slopeDbPerM = (10 * n) / (Math.LN10 * dM) + alpha;
    const posDb = slopeDbPerM * this.posSigmaM();
    // Averaging more packets beats down fading, never the shadowing.
    const fadeDb = 4 / Math.sqrt(w.samples);
    const sigmaDb = Math.sqrt(
      this.cfg.SHADOW_SIGMA_DB ** 2 + extraSigmaDb ** 2 + posDb ** 2 + fadeDb ** 2
    );
    const fit = this.deps.addPoint(num, dM, w.level, w.shape, sigmaDb, {
      x: at.x, y: at.y, sigmaFt: this.posSigmaM() * FT_PER_M,
    });
    if (!fit) return null;
    this.points[num] = (this.points[num] || 0) + 1;
    return { num, distanceM: dM, level: w.level, sigmaDb, fit };
  }

  getStatus() {
    return {
      enabled: this.enabled,
      active: this.active,
      source: this.source,
      walkedM: Number(this.walkedM.toFixed(1)),
      posSigmaM: this.active ? Number(this.posSigmaM().toFixed(2)) : null,
      points: { ...(this.points || { 1: 0, 2: 0 }) },
      pausedReason: this.pausedReason,
    };
  }
}
