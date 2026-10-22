// ============================================================================
// WheelchairEngine.js — movement for wheelchair users, where there are no steps
//
// The step engine (MotionEngine) finds walking from the up-down bounce of
// footsteps. A wheelchair user makes none, so the dot never moved. This engine
// replaces "steps" with two other sources of movement, and hands the result
// to the app as ordinary step-sized moves, so map matching, beacons and the
// trail all work unchanged:
//
//   1. ROLLING, detected automatically. Wheels rolling on a floor make the
//      phone buzz (lap, armrest, holder): a steady vibration well above the
//      rhythm of body movement. While that vibration lasts, the user is moved
//      forward at their wheelchair speed (Settings, or a calibration roll).
//      Rotating the phone by hand (picking it up, using it) is not rolling,
//      and spinning the chair on the spot moves no distance.
//   2. PUSH BUTTON. Each tap of the Push button on the Fusion Map moves the
//      user one push length. Works on carpet, where wheels barely vibrate,
//      and for anyone who prefers to say exactly when they moved.
//
// Direction comes from the gyro (HeadingFilter), the same as for walking: the
// chair turning turns the phone with it.
//
// The vibration threshold has NOT been tuned on a real wheelchair yet. The
// Sensitivity setting and the live vibration level on the PDR tab (and in a
// recorded test walk) are there to set it from real data.
//
// Units: g, deg/s, metres, ms.
// ============================================================================

import { GravityTracker, gyroVector } from "./CarryDetector.js";

export const WHEELCHAIR_CONFIG = {
  // High-pass on the gravity-free acceleration: keeps the wheels' buzz,
  // removes the slower movement of the body and arms (cutoff ~2.7 Hz).
  HP_TAU_S: 0.06,
  // Vibration level = RMS over this window (starting a roll), and a fast
  // average with this time constant (stopping, spinning).
  WINDOW_S: 1.0,
  SHORT_TAU_S: 0.3,
  // Faster average used only to see that the vibration has stopped. The 0.3 s one kept
  // reading "rolling" for about a second after the chair stopped, adding ~0.7 m to every stop.
  STOP_TAU_S: 0.1,
  // What is left of that lag is taken off the distance when a roll ends (s of full speed).
  STOP_TAIL_S: 0.15,
  // Vibration (g RMS) that starts rolling, by Sensitivity. Rolling stops once
  // it drops below EXIT_FRAC of that.
  // Raised from 0.035 / 0.02 / 0.012: tremor and small bumps at 0.02-0.03 g
  // were starting a full-speed roll with no rolling at all.
  START_RMS_G: { low: 0.05, medium: 0.03, high: 0.018 },
  EXIT_FRAC: 0.5,
  // The vibration must last this long to start, and be gone this long to stop.
  // A longer stop time lets the chair cross a smooth patch of floor without
  // the roll ending (and needing ENTER_S again to restart).
  ENTER_S: 0.8, // short, so the dot starts sooner (the start level stays raised against small vibration)
  EXIT_S: 3.0, // was 2.0
  // Speed follows the vibration: counted speed = set speed x sqrt(level / reference),
  // limited to FACTOR_MIN..FACTOR_MAX. The reference is the level measured in a
  // calibration roll (Settings), or REF_OVER_START x the start level before one.
  // Small vibration then moves the dot slowly and strong vibration faster, instead
  // of one fixed speed for any vibration above the threshold.
  FACTOR_MIN: 0.5,
  FACTOR_MAX: 1.5,
  REF_OVER_START: 3,
  // A chair starts from rest: over this long from the start of a roll the
  // counted speed builds up from 0 to the set speed (half the distance of
  // full speed). Counting full speed from the first jolt made the first one
  // or two moves much bigger than the chair had really moved.
  START_RAMP_S: 0.5,
  // The phone being handled: tilting faster than this (deg/s, window mean)
  // is the hand moving the phone, not the wheels.
  HANDLING_TILT_DPS: 90, // was 45: rocking over bumps and turning stopped the roll
  // Spinning the chair on the spot: turning faster than this (deg/s) adds no
  // forward distance.
  SPIN_YAW_DPS: 150, // was 70: an ordinary turn while rolling must still move you
  // Distance handed to the app per move while rolling (m). Matches a step,
  // which is what the position filters expect.
  SEGMENT_M: 0.7,
  // A leftover shorter than this when rolling stops is dropped.
  MIN_SEGMENT_M: 0.15,
  // A push longer than this is handed over in equal parts.
  MAX_SEGMENT_M: 1.0,
  // Speed / push length limits (m/s, m).
  MIN_SPEED: 0.2,
  MAX_SPEED: 2.5,
  MIN_PUSH_M: 0.3,
  MAX_PUSH_M: 3.0,
  // A calibration roll shorter than this (s) proves little.
  MIN_CAL_ROLL_S: 5,
  HEADING_HISTORY_S: 6,
};

/** Circular mean (deg) of heading samples with t in (t0, t1]; null if none. */
function meanHeading(hist, t0, t1) {
  let s = 0, c = 0, n = 0;
  for (const h of hist) {
    if (h.t > t0 && h.t <= t1) {
      const r = (h.h * Math.PI) / 180;
      s += Math.sin(r);
      c += Math.cos(r);
      n++;
    }
  }
  return n ? (Math.atan2(s, c) * 180) / Math.PI : null;
}

export class WheelchairEngine {
  constructor(config = {}) {
    this.cfg = { ...WHEELCHAIR_CONFIG, ...config };
    this.onMove = null;        // ({t, lengthM, headingDeg, source: "roll"|"push"})
    this.platform = "android";
    // scale: false = distance is rolling time x the set speed. Scaling it by the vibration made the same
    // real speed count as 35% to 148% depending on how rough the floor was (the buzz is the floor, not the speed).
    this.settings = { speedMps: 0.8, pushM: 1.0, sensitivity: "medium", auto: true, scale: false, refRmsG: null };
    this.gravity = new GravityTracker();
    this.reset();
  }

  /** Forget headings measured before a new heading zero (they are in the old reference). */
  clearHeadings() {
    this.headings = [];
  }

  reset() {
    this.gravity.reset();
    this.hp = null;            // high-pass state {x, y, z}
    this.lastT = null;
    this.win = [];             // {t, e (g²), rt (tilt deg/s), yaw (deg/s)}
    this.sumE = 0; this.sumRt = 0; this.sumYaw = 0;
    this.headings = [];        // {t, h}
    this.rolling = false;
    this.aboveSince = null;
    this.belowSince = null;
    this.pending = 0;          // distance rolled, not yet handed over (m)
    this.heldS = 0;            // rolling time held while the vibration dipped (s)
    this.eShort = 0;           // fast vibration energy (g²)
    this.eStop = 0;            // faster vibration energy, for seeing a stop (g²)
    this.yawShort = 0;         // fast turn rate (deg/s)
    this.segmentStartT = null;
    this.rollStartT = null;    // when the current roll began (ms), for START_RAMP_S
    this.stats = { rmsG: 0, tiltDps: 0, yawDps: 0 };
    this.reason = "still";
    this._cal = null;
  }

  /** {speedMps, pushM, sensitivity: "low"|"medium"|"high", auto: bool} */
  setSettings(patch = {}) {
    const s = { ...this.settings };
    const cfg = this.cfg;
    if (Number.isFinite(patch.speedMps)) s.speedMps = Math.min(cfg.MAX_SPEED, Math.max(cfg.MIN_SPEED, patch.speedMps));
    if (Number.isFinite(patch.pushM)) s.pushM = Math.min(cfg.MAX_PUSH_M, Math.max(cfg.MIN_PUSH_M, patch.pushM));
    if (cfg.START_RMS_G[patch.sensitivity]) s.sensitivity = patch.sensitivity;
    if (typeof patch.auto === "boolean") s.auto = patch.auto;
    if (typeof patch.scale === "boolean") s.scale = patch.scale;
    if (patch.refRmsG === null) s.refRmsG = null;
    else if (Number.isFinite(patch.refRmsG)) s.refRmsG = Math.min(1, Math.max(0.01, patch.refRmsG));
    if (!s.auto && this.rolling) this._stopRolling(this.lastT ?? Date.now());
    this.settings = s;
  }

  get startRmsG() {
    return this.cfg.START_RMS_G[this.settings.sensitivity] || this.cfg.START_RMS_G.medium;
  }

  /** How much of the set speed the current vibration level means (FACTOR_MIN..FACTOR_MAX). */
  _speedFactor() {
    const cfg = this.cfg;
    if (!this.settings.scale) return 1;
    const ref = this.settings.refRmsG || this.startRmsG * cfg.REF_OVER_START;
    const r = this.stats.rmsG / ref;
    if (!(r > 0)) return cfg.FACTOR_MIN;
    return Math.min(cfg.FACTOR_MAX, Math.max(cfg.FACTOR_MIN, Math.sqrt(r)));
  }

  /** Heading sample (deg, app convention). Call alongside every motion sample. */
  pushHeading(t, headingDeg) {
    if (!Number.isFinite(headingDeg)) return;
    this.headings.push({ t, h: headingDeg });
    const cut = t - this.cfg.HEADING_HISTORY_S * 1000;
    while (this.headings.length && this.headings[0].t < cut) this.headings.shift();
  }

  /** One DeviceMotion event (expo-sensors), t in ms. */
  ingest(data, t = Date.now()) {
    const cfg = this.cfg;
    if (this.lastT !== null && t <= this.lastT) return;
    const dt = this.lastT === null ? 0.02 : Math.min(0.2, Math.max(0.005, (t - this.lastT) / 1000));
    this.lastT = t;
    const gt = this.gravity.update(data, dt);
    if (!gt) return;
    const { g, a } = gt;
    const gn = Math.hypot(g.x, g.y, g.z) || 1;

    // Vibration: high-passed gravity-free acceleration (first-order RC
    // high-pass, correct at any sample rate).
    const lin = { x: a.x - g.x, y: a.y - g.y, z: a.z - g.z };
    if (!this.hp) this.hp = { px: lin.x, py: lin.y, pz: lin.z, x: 0, y: 0, z: 0 };
    const h = this.hp;
    const al = cfg.HP_TAU_S / (cfg.HP_TAU_S + dt);
    h.x = al * (h.x + lin.x - h.px); h.y = al * (h.y + lin.y - h.py); h.z = al * (h.z + lin.z - h.pz);
    h.px = lin.x; h.py = lin.y; h.pz = lin.z;
    const e = h.x * h.x + h.y * h.y + h.z * h.z;

    // Rotation: turning (about gravity) vs tilting (the phone being handled).
    const w = gyroVector(data.rotationRate, this.platform);
    let yaw = 0, rt = 0;
    if (w) {
      const rot = Math.hypot(w.x, w.y, w.z);
      yaw = Math.abs((w.x * g.x + w.y * g.y + w.z * g.z) / gn);
      rt = Math.sqrt(Math.max(0, rot * rot - yaw * yaw));
    }

    // Fast averages (~0.3 s): stopping and spinning must take effect at once,
    // not a whole window later.
    const ks = Math.min(1, dt / cfg.SHORT_TAU_S);
    this.eShort += ks * (e - this.eShort);
    this.eStop += Math.min(1, dt / cfg.STOP_TAU_S) * (e - this.eStop);
    this.yawShort += ks * (yaw - this.yawShort);

    const s = { t, e, rt, yaw };
    this.win.push(s);
    this.sumE += e; this.sumRt += rt; this.sumYaw += yaw;
    const cut = t - cfg.WINDOW_S * 1000;
    while (this.win.length && this.win[0].t < cut) {
      const o = this.win.shift();
      this.sumE -= o.e; this.sumRt -= o.rt; this.sumYaw -= o.yaw;
    }
    const n = this.win.length;
    if (n < 5) return;
    const rmsG = Math.sqrt(Math.max(0, this.sumE / n));
    const tiltDps = this.sumRt / n;
    const yawDps = this.sumYaw / n;
    this.stats = { rmsG, tiltDps, yawDps };

    if (!this.settings.auto) {
      this.reason = "push button only";
      return;
    }

    const handled = tiltDps > cfg.HANDLING_TILT_DPS;
    const spinning = this.yawShort > cfg.SPIN_YAW_DPS;

    if (!this.rolling) {
      // Start: the 1 s level, so a single bump does not start a roll.
      if (rmsG >= this.startRmsG && !handled) {
        if (this.aboveSince === null) this.aboveSince = t;
        if (t - this.aboveSince >= cfg.ENTER_S * 1000) {
          this.rolling = true;
          this.belowSince = null;
          this.heldS = 0;
          // The roll began when the vibration did: count that time too
          // (building up from rest, START_RAMP_S).
          this.segmentStartT = this.aboveSince;
          this.rollStartT = this.aboveSince;
          this._advance(t, (t - this.aboveSince) / 1000, spinning);
        }
      } else {
        this.aboveSince = null;
      }
      this.reason = handled ? "phone being handled" : rmsG >= this.startRmsG * 0.5 ? "slight vibration" : "still";
      return;
    }

    // Rolling: the fast level against a lower threshold. While it is low the
    // distance is HELD, not counted: if the vibration comes back it was only
    // a smooth patch of floor and the held distance is added; if it stays
    // away for EXIT_S the chair had stopped and it is dropped.
    const vibrating = Math.sqrt(this.eStop) >= this.startRmsG * cfg.EXIT_FRAC && !handled;
    if (vibrating) {
      if (this.belowSince !== null) {
        this.belowSince = null;
        this._advance(t, this.heldS, false);
        this.heldS = 0;
      }
      this._advance(t, dt, spinning);
      this.reason = spinning ? "turning on the spot" : "rolling";
    } else {
      if (this.belowSince === null) this.belowSince = t;
      if (!spinning) this.heldS += dt;
      if (t - this.belowSince >= cfg.EXIT_S * 1000) this._stopRolling(t);
      else this.reason = "rolling (checking stop)";
    }
  }

  /** Seconds at full speed equivalent to the interval (t - dtS, t] of this roll. */
  _rampedS(t, dtS) {
    const R = this.cfg.START_RAMP_S;
    if (!(R > 0) || this.rollStartT === null) return dtS;
    // Integral of min(1, time since roll start / R).
    const F = (tt) => {
      const u = Math.max(0, (tt - this.rollStartT) / 1000);
      return u < R ? (u * u) / (2 * R) : R / 2 + (u - R);
    };
    return Math.max(0, F(t) - F(t - dtS * 1000));
  }

  _advance(t, dtS, spinning) {
    if (spinning) return;
    // Calibration counts the same full-speed-equivalent time, so a
    // calibrated speed matches how distance is counted.
    const effS = this._rampedS(t, dtS);
    const d = this.settings.speedMps * this._speedFactor() * effS;
    this.pending += d;
    if (this._cal) {
      // Unscaled time and the vibration it happened at: the calibrated speed
      // is the speed AT that average level (factor 1 there).
      this._cal.rollS += effS;
      this._cal.rmsSum += this.stats.rmsG * effS;
    }
    while (this.pending >= this.cfg.SEGMENT_M) {
      this.pending -= this.cfg.SEGMENT_M;
      this._emit(t, this.cfg.SEGMENT_M, "roll");
    }
  }

  _stopRolling(t) {
    // The time held since the vibration dropped was not rolling: it is
    // dropped. What was rolled before it is handed over.
    // The stop was seen about STOP_TAIL_S late: that distance was not rolled.
    this.pending = Math.max(0, this.pending - this.settings.speedMps * this.cfg.STOP_TAIL_S);
    if (this.pending >= this.cfg.MIN_SEGMENT_M) this._emit(t, this.pending, "roll");
    this.pending = 0;
    this.heldS = 0;
    this.rolling = false;
    this.rollStartT = null;
    this.aboveSince = null;
    this.belowSince = null;
    this.reason = "stopped";
  }

  /** One push of the wheels (Push button). */
  push(t = Date.now()) {
    const total = this.settings.pushM;
    const parts = Math.max(1, Math.ceil(total / this.cfg.MAX_SEGMENT_M));
    if (this._cal) this._cal.pushes += 1;
    for (let i = 0; i < parts; i++) this._emit(t, total / parts, "push");
  }

  _emit(t, lengthM, source) {
    const from = this.segmentStartT !== null && this.segmentStartT < t ? this.segmentStartT : t - 1500;
    let headingDeg = meanHeading(this.headings, from, t);
    if (headingDeg === null && this.headings.length) headingDeg = this.headings[this.headings.length - 1].h;
    this.segmentStartT = t;
    if (this._cal) this._cal.distanceM += lengthM;
    if (this.onMove) this.onMove({ t, lengthM, headingDeg, source });
  }

  // ── Calibration: roll (or push) a measured distance ─────────────────────

  beginCalibration() {
    this._cal = { rollS: 0, rmsSum: 0, pushes: 0, distanceM: 0, startedAt: Date.now() };
  }

  cancelCalibration() {
    this._cal = null;
  }

  getCalibrationProgress() {
    if (!this._cal) return { active: false };
    return { active: true, rollS: this._cal.rollS, pushes: this._cal.pushes, estimatedM: this._cal.distanceM };
  }

  /**
   * Ends the calibration against the real distance. Pushes counted -> push
   * length; otherwise rolling time -> speed.
   * @returns {{ok, reason?, speedMps?, pushM?}}
   */
  finishCalibration(actualM) {
    const c = this._cal;
    this._cal = null;
    const cfg = this.cfg;
    if (!c) return { ok: false, reason: "No calibration in progress." };
    if (!Number.isFinite(actualM) || actualM <= 0) return { ok: false, reason: "Enter the distance you moved." };
    if (c.pushes > 0) {
      const pushM = actualM / c.pushes;
      if (pushM < cfg.MIN_PUSH_M || pushM > cfg.MAX_PUSH_M) {
        return { ok: false, reason: `${pushM.toFixed(2)} m per push is outside ${cfg.MIN_PUSH_M}–${cfg.MAX_PUSH_M} m. Check the distance.` };
      }
      return { ok: true, pushM: Number(pushM.toFixed(2)), pushes: c.pushes };
    }
    if (c.rollS < cfg.MIN_CAL_ROLL_S) {
      return { ok: false, reason: `Only ${c.rollS.toFixed(1)} s of rolling was detected — roll for at least ${cfg.MIN_CAL_ROLL_S} s, or raise Sensitivity.` };
    }
    const speedMps = actualM / c.rollS;
    if (speedMps < cfg.MIN_SPEED || speedMps > cfg.MAX_SPEED) {
      return { ok: false, reason: `${speedMps.toFixed(2)} m/s is outside ${cfg.MIN_SPEED}–${cfg.MAX_SPEED} m/s. Check the distance.` };
    }
    const refRmsG = c.rmsSum > 0 ? Number((c.rmsSum / c.rollS).toFixed(4)) : null;
    return { ok: true, speedMps: Number(speedMps.toFixed(2)), rollS: Number(c.rollS.toFixed(1)), refRmsG };
  }

  getStatus() {
    return {
      rolling: this.rolling,
      reason: this.reason,
      rmsG: Number(this.stats.rmsG.toFixed(4)),
      thresholdG: this.startRmsG,
      tiltDps: Math.round(this.stats.tiltDps),
      yawDps: Math.round(this.stats.yawDps),
      speedFactor: Number(this._speedFactor().toFixed(2)),
      ...this.settings,
    };
  }
}

/** Shared instance: the app feeds it, the Fusion Map's Push button and Settings use it. */
export const wheelchairEngine = new WheelchairEngine();
