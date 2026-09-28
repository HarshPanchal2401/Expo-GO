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
// HEADING CONVENTION: degrees, clockwise-positive, relative to the calibrated
// zero (0 = map +Y / forward, 90 = +X / right), range (-180, 180].
// ============================================================================

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
  // Gravity low-pass factor per sample. Walking adds large vertical/forward
  // accelerations; only the slow gravity direction is wanted for projection.
  GRAVITY_LPF: 0.08,
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
  }

  get heading() { return Number(this._heading.toFixed(2)); }
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
    if (!rr || !Number.isFinite(rr.alpha) || !Number.isFinite(rr.beta) || !Number.isFinite(rr.gamma)) return;

    const w = platform === "ios"
      ? { x: rr.gamma, y: rr.beta, z: rr.alpha }
      : { x: rr.alpha, y: rr.beta, z: rr.gamma };

    const g = data.accelerationIncludingGravity;
    if (g && Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.z)) {
      const a = this.cfg.GRAVITY_LPF;
      if (!this._down) this._down = { x: g.x, y: g.y, z: g.z };
      else {
        this._down.x += a * (g.x - this._down.x);
        this._down.y += a * (g.y - this._down.y);
        this._down.z += a * (g.z - this._down.z);
      }
    }

    // Unit "down" vector; without one, assume the phone is held roughly flat.
    let dx = 0, dy = 0, dz = -1;
    if (this._down) {
      const n = Math.hypot(this._down.x, this._down.y, this._down.z);
      if (n > 1e-3) { dx = this._down.x / n; dy = this._down.y / n; dz = this._down.z / n; }
    }

    // Rotation about the vertical. Gyro rates are right-handed (counter-
    // clockwise positive about each axis), so the CCW rate about "up" is
    // -(w·down); the app's heading is clockwise-positive, which flips it back.
    const headingRate = w.x * dx + w.y * dy + w.z * dz;
    this._yawRateDps = headingRate;

    const t = Number.isFinite(rr.timestamp) && rr.timestamp > 0 ? rr.timestamp : Date.now() / 1000;
    const dt = this._lastGyroT === null ? 0 : t - this._lastGyroT;
    this._lastGyroT = t;
    this._hasGyro = true;

    if (dt <= 0) return; // repeated (stale) gyro event - nothing new
    if (this._initialized && dt <= this.cfg.MAX_DT_S) {
      // Trapezoidal: the rate is a point sample, so across a longer gap the
      // average of both ends is a much better estimate than either one.
      const avgRate = this._prevRateDps === null ? headingRate : 0.5 * (headingRate + this._prevRateDps);
      this._heading = wrap180(this._heading + avgRate * dt);
    }
    this._prevRateDps = headingRate;
    this._sampleForStep();
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
