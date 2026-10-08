// ============================================================================
// CarryDetector.js — how the phone is being carried, and when that changes
//
// PDR has to work whether the phone is held in front of the face, in a trouser
// pocket, swinging in the hand or held at the ear. Those differ in exactly the
// two things PDR depends on:
//
//   HEADING. The compass-based orientation (rotation.alpha) is only meaningful
//   while the phone is held roughly flat - then the top of the phone points
//   where the user walks. Held upright (pocket, ear) the angle is undefined and
//   jumps around (gimbal lock), and the phone's top no longer points forward
//   anyway. So the compass is only used in TEXTING mode; otherwise the gyro
//   carries the walking direction on its own (its turn rate about gravity is
//   the same however the phone is held).
//
//   REPOSITIONING. Moving the phone (into a pocket, up to the ear) rotates it,
//   and the gyro would turn the walking direction with it. That is detected
//   here as a change of the phone's average tilt (the gravity direction in the
//   phone's frame), which walking turns never change, and the heading filter
//   holds the walking direction through it: the user keeps walking where they
//   were walking.
//
// Modes:
//   texting   steady, screen facing up-ish (within ~63 deg of flat)
//   vertical  steady and upright: phone at the ear, chest/jacket pocket
//   swinging  the phone moves with a limb: swinging hand, trouser pocket
//   unknown   not enough data yet
//
// Units: gravity as a unit vector in the device frame, deg/s, ms.
// ============================================================================

export const CARRY_CONFIG = {
  WINDOW_S: 2.0,
  // Resultant length of the unit gravity vectors in the window: 1 = the tilt
  // never changes; a limb swinging +-25 deg gives ~0.95.
  SWING_MAX_R: 0.975,
  // Mean rotation rate (deg/s) about horizontal axes that also means swinging.
  SWING_TILT_ROT_DPS: 60,
  // |gravity . screen normal| at least this = screen facing up (or down): texting.
  TEXTING_MIN_GZ: 0.45,
  // A new mode must hold this long before it is reported.
  MODE_HOLD_S: 0.8,
  // Average tilt moving this far from the settled one = the phone is being
  // repositioned; it has settled once the average holds still again.
  TRANSITION_DEG: 35,
  // Faster onset: the last 0.4 s alone this far from the settled tilt. The
  // heading is rewound to the last moment the tilt was within CALM_DEG of it.
  SHORT_WINDOW_S: 0.4,
  FAST_TRANSITION_DEG: 45,
  // Calm = the recent tilt this close to the settled one and, for a phone that
  // was held steady, not tilting faster than CALM_ROT_DPS (deg/s, ~0.2 s mean).
  CALM_DEG: 10,
  CALM_DEG_SWINGING: 20,
  CALM_ROT_DPS: 60,
  // ...and not rotating faster than a walking turn in any direction (a phone
  // being pocketed often twists flat before it tilts).
  CALM_TOTAL_ROT_DPS: 100,
  MAX_REWIND_S: 3,
  SETTLE_DEG: 12,
  SETTLE_S: 0.8,
  // A repositioning so slow it never settles is ended anyway.
  MAX_TRANSITION_S: 8,
};

const angleDeg = (a, b) => {
  const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return (Math.acos(d) * 180) / Math.PI;
};

/**
 * Gravity in the device frame (g), from a DeviceMotion event.
 *
 * Preferably the phone's own sensor fusion: accelerationIncludingGravity minus
 * (or plus - platforms differ) the gravity-free acceleration. Unlike a low-pass
 * filter it follows a swinging phone instantly. Falls back to a low-pass of
 * accelerationIncludingGravity on devices without a usable linear
 * acceleration sensor (some report zeros).
 */
export class GravityTracker {
  constructor(tauS = 0.8) {
    this.tauS = tauS;
    this.reset();
  }

  reset() {
    this.grav = null;
    this.unit = null;        // sensor units per g (9.81 or 1)
    this.signVote = 0;       // >0: gravity = incl - linear; <0: incl + linear
    this.linearBroken = 0;   // evidence that "acceleration" is all zeros
  }

  /** Returns { g: {x,y,z} gravity (g), a: {x,y,z} total (g) } or null. */
  update(data, dt) {
    const a = data?.accelerationIncludingGravity;
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return null;
    const mag = Math.hypot(a.x, a.y, a.z);
    if (this.unit === null && mag > 0.3) this.unit = mag > 4 ? 9.80665 : 1;
    const u = this.unit || 9.80665;
    const ax = a.x / u, ay = a.y / u, az = a.z / u;

    const la = data.acceleration;
    let hasLinear = la && Number.isFinite(la.x) && Number.isFinite(la.y) && Number.isFinite(la.z);
    if (hasLinear) {
      const lm = Math.hypot(la.x, la.y, la.z) / u;
      if (lm < 1e-4 && Math.abs(mag / u - 1) > 0.03) this.linearBroken = Math.min(50, this.linearBroken + 1);
      else if (lm > 1e-3) this.linearBroken = Math.max(0, this.linearBroken - 1);
      if (this.linearBroken >= 25) hasLinear = false;
    }
    if (hasLinear) {
      // Whichever sign gives a gravity nearer 1 g is the platform's; vote.
      const lx = la.x / u, ly = la.y / u, lz = la.z / u;
      const mMinus = Math.hypot(ax - lx, ay - ly, az - lz);
      const mPlus = Math.hypot(ax + lx, ay + ly, az + lz);
      const diff = Math.abs(mPlus - 1) - Math.abs(mMinus - 1);
      this.signVote = Math.max(-50, Math.min(50, this.signVote + Math.sign(diff) * Math.min(1, Math.abs(diff) * 20)));
      const sg = this.signVote >= 0 ? -1 : 1;
      this.grav = { x: ax + sg * lx, y: ay + sg * ly, z: az + sg * lz };
    } else {
      if (!this.grav) this.grav = { x: ax, y: ay, z: az };
      const kg = Math.min(1, dt / this.tauS);
      this.grav.x += kg * (ax - this.grav.x);
      this.grav.y += kg * (ay - this.grav.y);
      this.grav.z += kg * (az - this.grav.z);
    }
    return { g: this.grav, a: { x: ax, y: ay, z: az } };
  }
}

/**
 * Gyro rate (deg/s) as a device-frame vector. expo-sensors names the axes
 * differently per platform: Android alpha=x, beta=y, gamma=z; iOS alpha=z,
 * beta=y, gamma=x.
 */
export function gyroVector(rr, platform) {
  if (!rr || !Number.isFinite(rr.alpha) || !Number.isFinite(rr.beta) || !Number.isFinite(rr.gamma)) return null;
  return platform === "ios"
    ? { x: rr.gamma, y: rr.beta, z: rr.alpha }
    : { x: rr.alpha, y: rr.beta, z: rr.gamma };
}

export class CarryDetector {
  constructor(config = {}) {
    this.cfg = { ...CARRY_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.win = [];             // {t, x, y, z, rt}
    this.sx = 0; this.sy = 0; this.sz = 0; this.srt = 0;
    this.hist = [];            // {t, g} average tilt every 100 ms
    this.ref = null;           // settled average tilt
    this.mode = "unknown";
    this.candidate = null;
    this.candidateSince = 0;
    this.transitioning = false;
    this.transitionStart = 0;
    this.lastCalmT = 0;        // last time the recent tilt matched the settled one
    this.rtFast = 0;           // ~0.2 s mean tilting rate (deg/s)
    this.rotFast = 0;          // ~0.2 s mean total rotation rate (deg/s)
    this.transitionFromT = null;
    this.version = 0;          // +1 each time the phone settles in a new position
    this.stats = { r: 1, gz: 0, tiltRotDps: 0 };
    this.gMean = null;         // average gravity direction (unit, device frame)
  }

  /**
   * @param {number} t      ms
   * @param {object} g      gravity, device frame (any length)
   * @param {number} tiltRotDps  rotation rate about horizontal axes (deg/s)
   * @param {number} rotDps      total rotation rate (deg/s)
   */
  update(t, g, tiltRotDps = 0, rotDps = tiltRotDps) {
    const cfg = this.cfg;
    const n0 = Math.hypot(g.x, g.y, g.z);
    if (!(n0 > 0.2)) return;
    const s = { t, x: g.x / n0, y: g.y / n0, z: g.z / n0, rt: Number.isFinite(tiltRotDps) ? tiltRotDps : 0 };
    const prevT = this.win.length ? this.win[this.win.length - 1].t : t;
    const kf = Math.min(1, (t - prevT) / 200);
    this.rtFast += kf * (s.rt - this.rtFast);
    if (Number.isFinite(rotDps)) this.rotFast += kf * (rotDps - this.rotFast);
    this.win.push(s);
    this.sx += s.x; this.sy += s.y; this.sz += s.z; this.srt += s.rt;
    const cut = t - cfg.WINDOW_S * 1000;
    while (this.win.length && this.win[0].t < cut) {
      const o = this.win.shift();
      this.sx -= o.x; this.sy -= o.y; this.sz -= o.z; this.srt -= o.rt;
    }
    const n = this.win.length;
    if (n < 10 || t - this.win[0].t < cfg.WINDOW_S * 800) return;

    const mx = this.sx / n, my = this.sy / n, mz = this.sz / n;
    const r = Math.hypot(mx, my, mz) || 1e-9;
    const gm = { x: mx / r, y: my / r, z: mz / r };
    const tiltRot = this.srt / n;
    this.gMean = gm;
    this.stats = { r: Number(r.toFixed(3)), gz: Number(gm.z.toFixed(2)), tiltRotDps: Math.round(tiltRot) };

    if (!this.hist.length || t - this.hist[this.hist.length - 1].t >= 100) {
      this.hist.push({ t, g: gm });
      while (this.hist.length && this.hist[0].t < t - 3000) this.hist.shift();
    }

    let cand;
    if (r < cfg.SWING_MAX_R || tiltRot > cfg.SWING_TILT_ROT_DPS) cand = "swinging";
    else if (Math.abs(gm.z) >= cfg.TEXTING_MIN_GZ) cand = "texting";
    else cand = "vertical";

    if (!this.ref) {
      this.ref = gm;
      this.mode = cand;
      this.lastCalmT = t;
      return;
    }

    if (!this.transitioning) {
      // Recent tilt (last SHORT_WINDOW_S) against the settled one.
      let qx = 0, qy = 0, qz = 0;
      const qcut = t - cfg.SHORT_WINDOW_S * 1000;
      for (let i = this.win.length - 1; i >= 0 && this.win[i].t >= qcut; i--) {
        qx += this.win[i].x; qy += this.win[i].y; qz += this.win[i].z;
      }
      const ql = Math.hypot(qx, qy, qz) || 1e-9;
      const shortAng = angleDeg({ x: qx / ql, y: qy / ql, z: qz / ql }, this.ref);
      const calm = this.mode === "swinging"
        ? shortAng < cfg.CALM_DEG_SWINGING
        : shortAng < cfg.CALM_DEG && this.rtFast < cfg.CALM_ROT_DPS && this.rotFast < cfg.CALM_TOTAL_ROT_DPS;
      if (calm) this.lastCalmT = t;
      if (shortAng > cfg.FAST_TRANSITION_DEG || angleDeg(gm, this.ref) > cfg.TRANSITION_DEG) {
        this.transitioning = true;
        this.transitionStart = t;
        this.transitionFromT = Math.max(this.lastCalmT, t - cfg.MAX_REWIND_S * 1000);
      }
    }
    if (this.transitioning) {
      let past = null;
      for (const h of this.hist) { if (h.t <= t - cfg.SETTLE_S * 1000) past = h; else break; }
      const settled = past && angleDeg(gm, past.g) < cfg.SETTLE_DEG && t - this.transitionStart >= cfg.SETTLE_S * 1000;
      if (settled || t - this.transitionStart > cfg.MAX_TRANSITION_S * 1000) {
        this.transitioning = false;
        this.ref = gm;
        this.lastCalmT = t;
        this.version++;
        this.mode = cand;
        this.candidate = null;
      }
      return;
    }

    if (cand === this.mode) {
      this.candidate = null;
    } else if (cand !== this.candidate) {
      this.candidate = cand;
      this.candidateSince = t;
    } else if (t - this.candidateSince >= cfg.MODE_HOLD_S * 1000) {
      this.mode = cand;
      this.candidate = null;
    }
  }

  getState() {
    return {
      mode: this.mode,
      transitioning: this.transitioning,
      // When the current repositioning began (ms): hold the heading from here.
      transitionFromT: this.transitioning ? this.transitionFromT : null,
      version: this.version,
      gMean: this.gMean,
      ...this.stats,
    };
  }
}
