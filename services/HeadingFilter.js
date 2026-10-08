// ============================================================================
// HeadingFilter.js — Gyro + compass complementary heading filter for PDR
//
// WHY THE OLD HEADING WAS UNCERTAIN:
// Heading came straight from the OS orientation (rotation vector / attitude),
// which is anchored to the magnetometer. Indoors the magnetic field is bent by
// steel, cabling and electronics, so that heading wanders by tens of degrees as
// you walk past them — and PDR places every step with x += len·sin(heading), so
// every degree of wander becomes sideways position error. On top of that each
// step used the heading at the instant the step was detected, which catches the
// phone mid-sway (hand-held phones swing several degrees each stride).
//
// WHAT THIS DOES:
//   • The gyroscope drives the heading. Its turn rate is projected onto the
//     gravity vector, so the yaw rate is correct however the phone is tilted
//     (not just when it is held flat). Gyros are unaffected by magnetic fields
//     and very accurate over seconds; their only weakness is slow drift.
//   • The absolute (compass-based) heading only removes that slow drift, with a
//     time constant of a few seconds. While the magnetic field STRENGTH is off
//     its clean baseline the compass is known to be bent and is nearly
//     ignored; the pull is also suspended while turning, when the absolute
//     sensors lag.
//   • Each step gets the CIRCULAR MEAN heading over that stride, which cancels
//     the symmetric left/right sway of the phone.
//
// ANY CARRY (setCarry, from CarryDetector):
//   • The compass correction is only applied while the phone is held in front
//     (texting). Upright - pocket, ear - the orientation angle is undefined
//     and jumps (gimbal lock), and the phone's top does not point where the
//     user walks. The gyro then carries the walking direction alone.
//   • The gyro's gravity comes from the phone's sensor fusion, not a low-pass:
//     a swinging phone tilts back and forth twice a second, and a lagging
//     gravity leaked that tilting into the turn rate.
//   • While the phone is being repositioned (into a pocket, up to the ear) the
//     heading is held at what it was just before - the user is still walking
//     the same way; the phone's own rotation is not a turn.
//
// HEADING CONVENTION: degrees, clockwise-positive, relative to the calibrated
// zero (0 = map +Y / forward, 90 = +X / right), range (-180, 180].
// ============================================================================

import { GravityTracker, gyroVector } from "./CarryDetector.js";

export const HEADING_CONFIG = {
  // How quickly the absolute heading removes gyro drift (seconds) while the
  // magnetic field looks clean. Short enough that a heading the gyro lost track
  // of is pulled back within a few seconds instead of appearing stuck.
  ABS_TIME_CONSTANT_S: 3.0,
  // The same pull while the magnetic field is disturbed: the compass is then
  // known to be wrong, so it is almost ignored and the gyro carries the heading.
  ABS_TIME_CONSTANT_DISTURBED_S: 40.0,
  // Magnetic disturbance test: steel and electronics that bend the compass
  // also change the field's STRENGTH. A reading more than this fraction away
  // from the recent clean baseline marks the compass as untrustworthy.
  //
  // This replaced judging the compass by how much it disagreed with the gyro.
  // That could not tell "compass disturbed" from "gyro lost track": both look
  // like a large disagreement, and treating every large one as a disturbance
  // is what froze the heading - after a lost turn the correct compass was
  // ignored for up to 8 seconds.
  MAG_DISTURBED_FRACTION: 0.12,
  // Slow baseline for the field strength (per-sample EMA factor at ~20 Hz).
  MAG_BASELINE_LPF: 0.01,
  // Without field-strength data, fall back to softly down-weighting large
  // disagreements (deg at which the weight halves).
  ABS_DISAGREE_SOFT_DEG: 35,
  // No absolute correction while turning faster than this (deg/s): orientation
  // sensors lag during turns and would drag the heading backwards.
  TURN_RATE_GATE_DPS: 40,
  // A disagreement larger than RESYNC_DISAGREE_DEG that persists is not a
  // passing disturbance - the gyro heading itself is wrong - so snap to the
  // absolute. Much faster when the field is known to be clean.
  RESYNC_DISAGREE_DEG: 30,
  RESYNC_AFTER_CLEAN_S: 1.5,
  RESYNC_AFTER_S: 6,
  // Gaps between gyro samples are INTEGRATED up to this long. Android delivers
  // DeviceMotion through the JS thread, so a busy moment (BLE burst, map
  // redraw) easily delays a sample past 0.25 s; the old limit threw those gaps
  // away and with them any turn made during them. Beyond this (app in the
  // background, sensor paused) the gap is skipped and resync recovers it.
  MAX_DT_S: 1.0,
  // Before any gyro sample arrives (device without one), fall back to smoothing
  // the absolute heading with this factor per sample, as the app did before.
  ABS_ONLY_SMOOTHING: 0.25,
  // A repositioning is recognised a little late (the tilt has to move first);
  // without a start time from the detector, the heading is held at its value
  // this long before that.
  REPOSITION_REWIND_S: 1.5,
  // After the phone settles, the new axis's direction is averaged this long
  // (about a stride) before the held heading is handed over to it, so a
  // swinging phone is anchored on its average, not wherever the swing was.
  ANCHOR_S: 1.2,
  // How fast the orientation's tilt is pulled to gravity (1/s).
  ATTITUDE_GAIN: 2.0,
};

const wrap180 = (d) => {
  let x = ((d % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return x;
};

export class HeadingFilter {
  constructor(config = {}) {
    this.cfg = { ...HEADING_CONFIG, ...config };
    this._heading = 0;
    this._initialized = false;
    this._hasGyro = false;
    this._down = null;          // low-passed gravity direction, device frame
    this._lastGyroT = null;     // seconds
    this._yawRateDps = 0;
    this._prevRateDps = null;
    this._magBaseline = null;
    this._magDisturbed = null;  // null = no field-strength data
    this._lastAbs = null;
    this._lastAbsT = null;
    this._disagreeSince = null;
    this._stepSin = 0;
    this._stepCos = 0;
    this._stepN = 0;
    this._gravity = new GravityTracker();
    this._lastMotionMs = null;
    this._carry = null;         // CarryDetector state
    this._held = false;         // heading held while the phone is repositioned
    this._anchor = null;        // averaging the new axis after it settled
    this._history = [];         // {t (ms), h} for the rewind
    this._carryVersion = null;
    this._q = null;             // orientation, see _attitudeStep()
    this._axis = null;          // phone-fixed axis whose direction is followed
    this._prevAz = null;
    this._prevW = null;
  }

  get heading() { return Number(this._heading.toFixed(2)); }
  /** How the phone is carried, as last reported by setCarry(). */
  get carryMode() { return this._carry?.mode || "unknown"; }
  /** The compass is only trusted while the phone is held in front. */
  get compassUsable() {
    const m = this._carry?.mode;
    return !this._held && (!m || m === "texting" || m === "unknown");
  }

  /**
   * CarryDetector state, every motion sample. Holds the heading through a
   * repositioning of the phone and switches the compass on/off by carry mode.
   */
  setCarry(carry, nowMs = Date.now()) {
    if (!carry) return;
    this._carry = carry;
    // The phone settled in a new position: follow a new level axis.
    if (carry.version !== this._carryVersion) {
      this._carryVersion = carry.version;
      this._axis = null;
      this._prevAz = null;
    }
    if (carry.transitioning && !this._held) {
      this._held = true;
      // Back to before the phone started moving.
      // (The detector's "calm" uses ~0.2 s averages, so the phone was already
      // moving a little before transitionFromT: go back a bit further.)
      const cut = Number.isFinite(carry.transitionFromT)
        ? carry.transitionFromT - 400
        : nowMs - this.cfg.REPOSITION_REWIND_S * 1000;
      // The average over the second before that: the phone sways each step.
      let s = 0, c = 0;
      for (const p of this._history) {
        if (p.t > cut) break;
        if (p.t < cut - 1000) continue;
        s += Math.sin((p.h * Math.PI) / 180);
        c += Math.cos((p.h * Math.PI) / 180);
      }
      let h = s || c ? (Math.atan2(s, c) * 180) / Math.PI : null;
      if (h === null && this._history.length) h = this._history[0].h;
      if (h !== null) this._heading = wrap180(h);
      this._anchor = null;
      this._clearStepWindow();
    } else if (!carry.transitioning && this._held && !this._anchor) {
      this._anchor = { until: nowMs + this.cfg.ANCHOR_S * 1000, s: 0, c: 0 };
    }
  }

  /** Hand the held heading over to the new axis, on its average direction. */
  _anchorStep(az, nowMs) {
    const a = this._anchor;
    if (az !== null) {
      a.s += Math.sin((az * Math.PI) / 180);
      a.c += Math.cos((az * Math.PI) / 180);
    }
    if (nowMs < a.until || !(a.s || a.c) || az === null) return;
    const mean = (Math.atan2(a.s, a.c) * 180) / Math.PI;
    this._heading = wrap180(this._heading + wrap180(az - mean));
    this._prevAz = az;
    this._anchor = null;
    this._held = false;
    this._disagreeSince = null;
    this._lastAbsT = null;
  }
  get yawRateDps() { return this._yawRateDps; }
  get magneticallyDisturbed() { return this._magDisturbed === true; }

  /**
   * Magnetometer field strength (any unit, e.g. µT). Used only to judge
   * whether the compass can currently be trusted.
   */
  updateMagneticField(total) {
    if (!Number.isFinite(total) || total <= 0) return;
    if (this._magBaseline === null) { this._magBaseline = total; this._magDisturbed = false; return; }
    const dev = Math.abs(total - this._magBaseline) / this._magBaseline;
    this._magDisturbed = dev > this.cfg.MAG_DISTURBED_FRACTION;
    // Learn the baseline only from clean readings, so walking past a steel
    // pillar does not teach the filter that the pillar's field is normal.
    // A slow drift of the whole building's field still gets followed, because
    // readings just inside the threshold keep nudging the baseline.
    if (!this._magDisturbed) this._magBaseline += this.cfg.MAG_BASELINE_LPF * (total - this._magBaseline);
  }

  /** Snap the heading to a known value (e.g. 0 right after Zero Heading). */
  reset(headingDeg = 0) {
    this._heading = wrap180(headingDeg);
    this._initialized = true;
    this._lastAbs = null;
    this._lastAbsT = null;
    this._disagreeSince = null;
    this._clearStepWindow();
  }

  /**
   * Re-take the heading from the next absolute reading. Call when the zero
   * reference changes (e.g. the saved zero is restored after start-up), since
   * the gyro-held heading is then offset by exactly that change.
   */
  resync() {
    this._initialized = false;
    this._disagreeSince = null;
  }

  /**
   * Gyro + gravity sample from expo-sensors DeviceMotion.
   *
   * expo-sensors names the rotationRate axes differently per platform:
   *   Android: alpha = x, beta = y, gamma = z   (deg/s)
   *   iOS:     alpha = z, beta = y, gamma = x   (deg/s)
   * accelerationIncludingGravity points DOWN on both (Android's module flips
   * the raw sensor sign; iOS reports CoreMotion gravity, which points down).
   *
   * @param {object} data     DeviceMotion event
   * @param {string} platform "android" | "ios"
   */
  updateMotion(data, platform) {
    const rr = data?.rotationRate;
    const w = gyroVector(rr, platform);
    if (!w) return;

    // Gravity from the phone's sensor fusion (follows a swinging phone);
    // low-pass of accelerationIncludingGravity when that is unavailable.
    const nowMs = Date.now();
    const gdt = this._lastMotionMs === null ? 0.02 : Math.min(0.2, Math.max(0.005, (nowMs - this._lastMotionMs) / 1000));
    this._lastMotionMs = nowMs;
    const gt = this._gravity.update(data, gdt);
    if (gt) this._down = { x: gt.g.x, y: gt.g.y, z: gt.g.z };

    // Unit "down" vector; without one, assume the phone is held roughly flat.
    let dx = 0, dy = 0, dz = -1;
    if (this._down) {
      const n = Math.hypot(this._down.x, this._down.y, this._down.z);
      if (n > 1e-3) { dx = this._down.x / n; dy = this._down.y / n; dz = this._down.z / n; }
    }

    // Turn rate about the vertical (pauses the compass pull during turns).
    // Gyro rates are right-handed (counter-clockwise positive about each
    // axis), so the CCW rate about "up" is -(w·down); the app's heading is
    // clockwise-positive, which flips it back.
    const headingRate = w.x * dx + w.y * dy + w.z * dz;
    this._yawRateDps = headingRate;

    const t = Number.isFinite(rr.timestamp) && rr.timestamp > 0 ? rr.timestamp : Date.now() / 1000;
    const dt = this._lastGyroT === null ? 0 : t - this._lastGyroT;
    this._lastGyroT = t;
    this._hasGyro = true;

    if (dt <= 0) return; // repeated (stale) gyro event - nothing new

    // Full orientation (gyro, tilt held to gravity), and from it the compass
    // direction of a phone-fixed axis that is level in the current carry.
    //
    // Integrating only the gyro's vertical component is not enough once the
    // phone swings: an arm swinging while the wrist twists traces a loop, and
    // the vertical rate summed over a loop is not zero ("coning") - the
    // heading crept ~2 deg/s. The direction of a fixed axis is a function of
    // the orientation itself, so a swing that comes back comes back to the
    // same heading.
    // Trapezoidal: the rate is a point sample, so across a longer gap the
    // average of both ends is a much better estimate than either one.
    const wAvg = this._prevW ? { x: 0.5 * (w.x + this._prevW.x), y: 0.5 * (w.y + this._prevW.y), z: 0.5 * (w.z + this._prevW.z) } : w;
    this._prevW = w;
    this._attitudeStep(wAvg, { x: dx, y: dy, z: dz }, dt <= this.cfg.MAX_DT_S ? dt : 0);
    if (!this._axis) this._chooseAxis(this._carry?.gMean || { x: dx, y: dy, z: dz });
    const az = this._axisAzimuth();
    if (this._anchor) this._anchorStep(az, nowMs);
    else if (az !== null && this._prevAz !== null && this._initialized && dt <= this.cfg.MAX_DT_S && !this._held) {
      this._heading = wrap180(this._heading + wrap180(az - this._prevAz));
    }
    if (az !== null) this._prevAz = az;
    this._prevRateDps = headingRate;
    this._sampleForStep();
    const last = this._history[this._history.length - 1];
    if (!last || nowMs - last.t >= 50) {
      this._history.push({ t: nowMs, h: this._heading });
      while (this._history.length && this._history[0].t < nowMs - 4000) this._history.shift();
    }
  }

  /**
   * Orientation update: rotate by the gyro, then nudge the tilt so the
   * estimated "down" agrees with gravity (Mahony). Gravity fixes tilt only;
   * the rotation about vertical is left to the gyro (and the compass, above).
   * this._q: unit quaternion [w, x, y, z], phone frame -> a level frame with z up.
   */
  _attitudeStep(wDeg, down, dt) {
    const upx = -down.x, upy = -down.y, upz = -down.z;
    if (!this._q) {
      // Start level with gravity; the starting yaw is arbitrary (only changes
      // of direction are used).
      const c = upz, ax = upy, ay = -upx; // axis = up x Z
      const s = Math.hypot(ax, ay);
      if (s < 1e-6) this._q = c > 0 ? [1, 0, 0, 0] : [0, 1, 0, 0];
      else {
        const th = Math.atan2(s, c);
        const k = Math.sin(th / 2) / s;
        this._q = [Math.cos(th / 2), ax * k, ay * k, 0];
      }
      return;
    }
    if (!(dt > 0)) return;
    const [qw, qx, qy, qz] = this._q;
    // Estimated up in the phone frame = third row of R(q).
    const ex = 2 * (qx * qz - qw * qy), ey = 2 * (qy * qz + qw * qx), ez = 1 - 2 * (qx * qx + qy * qy);
    // Correction rate: measured up x estimated up (rad/s).
    const kp = this.cfg.ATTITUDE_GAIN;
    const D = Math.PI / 180;
    const ox = wDeg.x * D + kp * (upy * ez - upz * ey);
    const oy = wDeg.y * D + kp * (upz * ex - upx * ez);
    const oz = wDeg.z * D + kp * (upx * ey - upy * ex);
    // q <- q * exp(omega dt / 2)
    const wn = Math.hypot(ox, oy, oz);
    const ha = 0.5 * wn * dt;
    const sk = wn > 1e-9 ? Math.sin(ha) / wn : 0.5 * dt;
    const pw = Math.cos(ha), px = ox * sk, py = oy * sk, pz = oz * sk;
    const nw = qw * pw - qx * px - qy * py - qz * pz;
    const nx = qw * px + qx * pw + qy * pz - qz * py;
    const ny = qw * py - qx * pz + qy * pw + qz * px;
    const nz = qw * pz + qx * py - qy * px + qz * pw;
    const n = Math.hypot(nw, nx, ny, nz) || 1;
    this._q = [nw / n, nx / n, ny / n, nz / n];
  }

  /**
   * The phone-fixed axis whose direction is followed: the phone's top when it
   * is held in front, otherwise whichever phone axis is most level in the
   * current carry - made exactly level for the average tilt `down`.
   */
  _chooseAxis(down) {
    const n = Math.hypot(down.x, down.y, down.z);
    if (!(n > 1e-3)) return;
    const g = { x: down.x / n, y: down.y / n, z: down.z / n };
    const axes = [{ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }];
    let e = axes[0];
    if (Math.abs(g.y) > 0.8) {
      e = axes.reduce((best, a) => (Math.abs(a.x * g.x + a.y * g.y + a.z * g.z) < Math.abs(best.x * g.x + best.y * g.y + best.z * g.z) ? a : best));
    }
    const d = e.x * g.x + e.y * g.y + e.z * g.z;
    const a = { x: e.x - d * g.x, y: e.y - d * g.y, z: e.z - d * g.z };
    const l = Math.hypot(a.x, a.y, a.z);
    if (!(l > 1e-3)) return;
    this._axis = { x: a.x / l, y: a.y / l, z: a.z / l };
    this._prevAz = this._axisAzimuth();
  }

  /** Clockwise direction (deg) of the followed axis in the level frame; null if it points up/down. */
  _axisAzimuth() {
    if (!this._q || !this._axis) return null;
    const [w, x, y, z] = this._q;
    const a = this._axis;
    const vx = (1 - 2 * (y * y + z * z)) * a.x + 2 * (x * y - w * z) * a.y + 2 * (x * z + w * y) * a.z;
    const vy = 2 * (x * y + w * z) * a.x + (1 - 2 * (x * x + z * z)) * a.y + 2 * (y * z - w * x) * a.z;
    if (Math.hypot(vx, vy) < 0.3) return null;
    return (Math.atan2(vx, vy) * 180) / Math.PI;
  }

  /**
   * Absolute heading (compass-anchored), already converted to the app's
   * convention relative to the calibrated zero.
   */
  updateAbsolute(relHeadingDeg) {
    if (!Number.isFinite(relHeadingDeg)) return;
    const now = Date.now() / 1000;

    if (!this._initialized) {
      this.reset(relHeadingDeg);
      this._lastAbsT = now;
      return;
    }

    // Pocket / ear / swinging / being repositioned: the angle is meaningless.
    if (this._hasGyro && !this.compassUsable) {
      this._lastAbsT = now;
      this._disagreeSince = null;
      return;
    }

    const err = wrap180(relHeadingDeg - this._heading);

    if (!this._hasGyro) {
      // No gyro: best available is a smoothed absolute heading.
      this._heading = wrap180(this._heading + this.cfg.ABS_ONLY_SMOOTHING * err);
      this._sampleForStep();
      this._lastAbsT = now;
      return;
    }

    const dt = this._lastAbsT === null ? 0 : Math.min(this.cfg.MAX_DT_S, now - this._lastAbsT);
    this._lastAbsT = now;
    if (!(dt > 0)) return;
    if (Math.abs(this._yawRateDps) > this.cfg.TURN_RATE_GATE_DPS) return;

    const clean = this._magDisturbed === false;
    const disturbed = this._magDisturbed === true;

    if (Math.abs(err) > this.cfg.RESYNC_DISAGREE_DEG && !disturbed) {
      if (this._disagreeSince === null) this._disagreeSince = now;
      else if (now - this._disagreeSince > (clean ? this.cfg.RESYNC_AFTER_CLEAN_S : this.cfg.RESYNC_AFTER_S)) {
        this.reset(relHeadingDeg);
        return;
      }
    } else {
      this._disagreeSince = null;
    }

    let k;
    if (disturbed) {
      k = dt / this.cfg.ABS_TIME_CONSTANT_DISTURBED_S;
    } else if (clean) {
      k = dt / this.cfg.ABS_TIME_CONSTANT_S;
    } else {
      const soft = this.cfg.ABS_DISAGREE_SOFT_DEG;
      k = (dt / this.cfg.ABS_TIME_CONSTANT_S) / (1 + (err / soft) ** 2);
    }
    this._heading = wrap180(this._heading + Math.min(1, k) * err);
  }

  /**
   * Heading to use for the step just detected: the circular mean over the
   * stride since the previous step, which cancels the phone's side-to-side
   * sway. Resets the window for the next stride.
   */
  takeStepHeading() {
    const h = this._stepN > 0
      ? (Math.atan2(this._stepSin, this._stepCos) * 180) / Math.PI
      : this._heading;
    this._clearStepWindow();
    return Number(wrap180(h).toFixed(2));
  }

  _sampleForStep() {
    const r = (this._heading * Math.PI) / 180;
    this._stepSin += Math.sin(r);
    this._stepCos += Math.cos(r);
    this._stepN += 1;
    // A long pause between steps: keep only recent orientation.
    if (this._stepN > 60) {
      this._stepSin *= 0.5;
      this._stepCos *= 0.5;
      this._stepN = 30;
    }
  }

  _clearStepWindow() {
    this._stepSin = 0;
    this._stepCos = 0;
    this._stepN = 0;
  }
}

export const headingFilter = new HeadingFilter();
