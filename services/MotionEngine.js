// ============================================================================
// MotionEngine.js — step detection v2 (world frame + rhythm), for PDR
//
// Replaces the per-step rules (accelerometer magnitude peaks + StepGate) with
// the approach used by smartphone PDR systems:
//
//   1. WORLD FRAME. Gravity comes from the phone's own sensor fusion
//      (DeviceMotion: accelerationIncludingGravity minus the gravity-free
//      acceleration), which follows a swinging phone instantly; a low-pass of
//      accelerationIncludingGravity is the fallback. The dynamic acceleration
//      is split into its VERTICAL part (along gravity) and the rest. Walking is an up-down
//      bounce, so steps are found in the vertical part - the same whichever
//      way the phone is held, tilted or in a pocket.
//   2. ACTIVITY FROM RHYTHM. Every 250 ms the last 2.5 s of vertical motion is
//      checked: is it periodic at a walking pace (autocorrelation peak at a
//      0.3-1.25 s lag), strong enough, mostly vertical and not violently
//      twisting? Walking is decided on the whole window, not on one bump, so
//      shakes and taps do not start it and missed peaks do not stop it.
//   3. STEPS IN REAL TIME. Inside walking, each peak of the band-passed
//      vertical acceleration (adaptive threshold, minimum spacing from the
//      measured cadence) is one step, timestamped when it happens. Its heading
//      is the mean heading over THAT stride. Steps seen in the few seconds
//      before walking was confirmed are released once, each with its own time
//      and heading - nothing is guessed, nothing is lost.
//   4. STEP LENGTH. Weinberg (K * bounce^0.25) from the peak-to-valley of the
//      vertical acceleration, with the band-pass filter's attenuation at the
//      measured cadence divided back out. K and the personal scale come from
//      StepLengthModel (Settings, calibration walk).
//
//   5. ANY CARRY. A phone swinging in the hand or in a trouser pocket moves
//      with the limb: big sideways forces and fast rotation, which the shake
//      rules alone would reject. A limb swings once per STRIDE (two steps), so
//      the gyro turns back and forth at half the step rate - a signature a
//      shake does not have. With it, the shake rules are relaxed and the
//      step (not stride) period is taken. CarryDetector reports how the phone
//      is carried, for the heading filter and the step length.
//
// Limitation (no phone-only method can avoid it): shaking the phone straight
// up and down at a steady walking rhythm looks like walking. The particle
// filter catches that with BLE (the beacons' signals do not change).
//
// Units: g for acceleration, deg/s for rotation, ms timestamps.
// ============================================================================

import { CarryDetector, GravityTracker, gyroVector } from "./CarryDetector.js";

export const MOTION_CONFIG = {
  G: 9.80665,
  // Gravity estimate: low-pass of accelerationIncludingGravity.
  GRAVITY_TAU_S: 0.8,
  // Band-pass on the vertical acceleration: remove drift (high-pass), then
  // remove jitter above the gait band (low-pass).
  HP_TAU_S: 0.75,
  LP_CUTOFF_HZ: 3.0,
  // Vertical acceleration is clipped to this (g) before the band-pass.
  VERT_CLIP_G: 4,
  // Activity window and how often it is evaluated.
  WINDOW_S: 2.5,
  EVAL_EVERY_MS: 250,
  RESAMPLE_HZ: 50,
  // Step period range (s): 3.3 to 0.8 steps per second.
  MIN_PERIOD_S: 0.3,
  MAX_PERIOD_S: 1.25,
  // Walking: periodicity (normalised autocorrelation) and strength.
  WALK_MIN_CORR: 0.5,
  WALK_KEEP_CORR: 0.25,
  WALK_MIN_STD_G: 0.025,
  STILL_STD_G: 0.012,
  MIN_VERTICAL_SHARE: 0.2,
  MAX_ROT_MEAN_DPS: 300,
  // Without a limb swing, walking hardly tilts the phone back and forth; a
  // wrist shake does (mean deg/s about horizontal axes).
  MAX_TILT_ROT_DPS: 130,
  // ...also over just the last half second, so a shake that is building up
  // is caught before the whole window has filled with it.
  RECENT_TILT_S: 0.5,
  // Limb swing signature: the gyro's main rotation is anti-correlated at a
  // one-step lag and repeats at a two-step lag (it swings once per stride),
  // and is strong enough. One twist of the phone is not a swing.
  SWING_MIN_STD_DPS: 30,
  SWING_ANTI_CORR: -0.3,
  SWING_REPEAT_CORR: 0.3,
  MAX_ROT_SWING_DPS: 700,
  // Consecutive evaluations needed to start / stop walking.
  ENTER_EVALS: 2,
  // Walking only starts with at least this many evenly spaced peaks in the
  // window (a phone being picked up makes one or two).
  START_MIN_PEAKS: 3,
  // ...or only this many when the rhythm is already very clear (autocorrelation at
  // least START_FAST_CORR): the dot then starts moving about half a second sooner,
  // and a weak or irregular start still needs START_MIN_PEAKS.
  START_FAST_MIN_PEAKS: 2,
  START_FAST_CORR: 0.65,
  START_GAP_TOLERANCE: 0.35,
  // A peak must be at least this fraction of the recent steps' bounce
  // (slowing down / standing after a walk makes small bumps).
  MIN_BOUNCE_FRAC: 0.45,
  // ...and at most this multiple of it (more is a knock, not a step).
  MAX_BOUNCE_FRAC: 4,
  // ...unless it lands right on the beat: a phone in one trouser pocket feels
  // the far leg's steps much weaker than its own leg's.
  ON_BEAT_TOLERANCE: 0.25,
  ON_BEAT_MIN_BOUNCE_FRAC: 0.15,
  EXIT_EVALS: 3,
  // Peak detection.
  PEAK_STD_FRAC: 0.35,
  // Window samples beyond this many median absolute deviations are a jolt,
  // clipped before the spread and the rhythm are measured.
  JOLT_CLIP_MAD: 5,
  MIN_PEAK_G: 0.015,
  MIN_STEP_GAP_S: 0.25,
  GAP_PERIOD_FRAC: 0.6,
  // Walking also ends after this many step periods without a peak.
  STOP_NO_STEP_PERIODS: 2.5,
  // Candidate peaks are kept this long before walking is confirmed. When it
  // is, the steps of the confirming window are released and, before them,
  // every earlier peak that continues the same rhythm: confirming can take
  // several seconds (a restart with the phone in a pocket), and steps older
  // than the window used to be lost.
  PEAK_HISTORY_S: 8,
  // Heading samples kept for per-stride heading (covers PEAK_HISTORY_S).
  HEADING_HISTORY_S: 10,
};

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

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

/** Normalised autocorrelation of a (zero-mean-ish) series at lag k. */
function autocorr(x, k) {
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i + k < x.length; i++) {
    sxy += x[i] * x[i + k];
    sxx += x[i] * x[i];
    syy += x[i + k] * x[i + k];
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/**
 * The gyro rate along its main axis (mean removed): for a swinging limb, the
 * signed swing rate. Returns { s: series, std (deg/s) }.
 */
function principalSignal(gx, gy, gz) {
  const n = gx.length;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += gx[i]; my += gy[i]; mz += gz[i]; }
  mx /= n; my /= n; mz /= n;
  let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
  for (let i = 0; i < n; i++) {
    const a = gx[i] - mx, b = gy[i] - my, c = gz[i] - mz;
    cxx += a * a; cxy += a * b; cxz += a * c; cyy += b * b; cyz += b * c; czz += c * c;
  }
  // Main axis by power iteration.
  let e = [0.577, 0.577, 0.577];
  for (let it = 0; it < 12; it++) {
    const v = [cxx * e[0] + cxy * e[1] + cxz * e[2], cxy * e[0] + cyy * e[1] + cyz * e[2], cxz * e[0] + cyz * e[1] + czz * e[2]];
    const l = Math.hypot(v[0], v[1], v[2]);
    if (!(l > 0)) return { s: new Array(n).fill(0), std: 0 };
    e = [v[0] / l, v[1] / l, v[2] / l];
  }
  const s = new Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    s[i] = (gx[i] - mx) * e[0] + (gy[i] - my) * e[1] + (gz[i] - mz) * e[2];
    ss += s[i] * s[i];
  }
  return { s, std: Math.sqrt(ss / n) };
}

export class MotionEngine {
  /**
   * @param {object} opts
   *   onStep({t, lengthM, headingDeg, bounceG, cadenceHz, intervalMs, backfilled})
   *   stepLength(bounceG, {cadenceHz, carry, intervalMs}) -> metres
   *     (default Weinberg K 0.74)
   *   platform "android" | "ios" (gyro axis names differ)
   */
  constructor(opts = {}, config = {}) {
    this.cfg = { ...MOTION_CONFIG, ...config };
    this.onStep = opts.onStep || null;
    this.stepLength = opts.stepLength || ((b) => 0.74 * Math.pow(Math.max(0, b), 0.25));
    this.platform = opts.platform || "android";
    this.gravity = new GravityTracker(this.cfg.GRAVITY_TAU_S);
    this.carry = new CarryDetector();
    this.reset();
  }

  /** Forget headings measured before a new heading zero (they are in the old reference). */
  clearHeadings() {
    this.headings = [];
  }

  reset() {
    this.gravity.reset();
    this.carry.reset();
    this.recentBounces = [];   // last few step bounces (g)
    this.cadenceHz = null;     // smoothed step rate
    this.swing = false;        // limb swing signature in the last window
    this.hpMean = 0;           // high-pass state
    this.lp = 0;               // low-pass state (band-passed vertical, g)
    this.lastT = null;
    this.win = [];             // {t, v, h2, rot}
    this.prev1 = null;         // previous two filtered samples, for peaks
    this.prev2 = null;
    this.valleyMin = Infinity; // lowest value since the last peak
    this.peaks = [];           // candidate peaks before walking: {t, bounce}
    this.headings = [];        // {t, h}
    this.walking = false;
    this.enterCount = 0;
    this.exitCount = 0;
    this.lastEvalAt = 0;
    this.lastStepT = null;
    this.periodS = null;
    this.stats = { corr: 0, stdG: 0, vertShare: 0, rotDps: 0, periodS: null };
    this.peakSpreadG = null;   // robust spread of the window (g), for peaks
    this.steps = 0;
    this.reason = "standing";
    // Diagnostics for a recorded test walk (see takeDiag): samples dropped because
    // they arrived with the same timestamp, and the longest gap between samples.
    this.diag = { dropped: 0, maxGapMs: 0, samples: 0 };
  }

  /** Diagnostics since the last call, then cleared. */
  takeDiag() {
    const d = this.diag;
    this.diag = { dropped: 0, maxGapMs: 0, samples: 0 };
    return d;
  }

  /** Heading sample (deg, app convention). Call alongside every motion sample. */
  pushHeading(t, headingDeg) {
    if (!Number.isFinite(headingDeg)) return;
    this.headings.push({ t, h: headingDeg });
    const cut = t - this.cfg.HEADING_HISTORY_S * 1000;
    while (this.headings.length && this.headings[0].t < cut) this.headings.shift();
  }

  /**
   * One DeviceMotion event.
   * @param {object} data   expo-sensors DeviceMotion event
   * @param {number} t      timestamp, ms
   */
  ingest(data, t = Date.now()) {
    const a = data?.accelerationIncludingGravity;
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z)) return;
    const cfg = this.cfg;
    const dt = this.lastT === null ? 0.02 : Math.min(0.2, Math.max(0.005, (t - this.lastT) / 1000));
    if (this.lastT !== null && t <= this.lastT) { this.diag.dropped++; return; }
    if (this.lastT !== null) this.diag.maxGapMs = Math.max(this.diag.maxGapMs, t - this.lastT);
    this.diag.samples++;
    this.lastT = t;

    // 1. Gravity (the phone's own sensor fusion; see GravityTracker) and the
    // vertical part of the dynamic acceleration.
    const gt = this.gravity.update(data, dt);
    if (!gt) return;
    const grav = gt.g, acc = gt.a;
    const gn = Math.hypot(grav.x, grav.y, grav.z) || 1;
    const dx = acc.x - grav.x, dy = acc.y - grav.y, dz = acc.z - grav.z;
    // A knock is clipped to what walking can produce: unclipped, one large
    // sample stays in the band-pass filter's memory for seconds and hides
    // the steps that follow it.
    const vertRaw = (dx * grav.x + dy * grav.y + dz * grav.z) / gn;
    const vert = Math.max(-cfg.VERT_CLIP_G, Math.min(cfg.VERT_CLIP_G, vertRaw));
    const h2 = Math.max(0, dx * dx + dy * dy + dz * dz - vert * vert);

    // Band-pass.
    const khp = Math.min(1, dt / cfg.HP_TAU_S);
    this.hpMean += khp * (vert - this.hpMean);
    const hp = vert - this.hpMean;
    const rc = 1 / (2 * Math.PI * cfg.LP_CUTOFF_HZ);
    this.lp += (dt / (dt + rc)) * (hp - this.lp);
    const v = this.lp;

    // Rotation: total, and about horizontal axes (tilting) - turning a corner
    // is rotation about gravity and must not look like shaking.
    const w = gyroVector(data.rotationRate, this.platform);
    let rot = 0, rt = 0;
    if (w) {
      rot = Math.hypot(w.x, w.y, w.z);
      const yaw = (w.x * grav.x + w.y * grav.y + w.z * grav.z) / gn;
      rt = Math.sqrt(Math.max(0, rot * rot - yaw * yaw));
    }
    this.carry.update(t, grav, rt, rot);

    this.win.push({ t, v, h2, rot, rt, wx: w ? w.x : 0, wy: w ? w.y : 0, wz: w ? w.z : 0 });
    const cut = t - cfg.WINDOW_S * 1000;
    while (this.win.length && this.win[0].t < cut) this.win.shift();

    // 2. Activity, every EVAL_EVERY_MS.
    if (t - this.lastEvalAt >= cfg.EVAL_EVERY_MS) {
      this.lastEvalAt = t;
      this._evaluate(t);
    }

    // 3. Peaks (one sample late: prev1 is a peak if above both neighbours).
    if (this.prev1 && this.prev2) {
      const p = this.prev1;
      if (p.v < this.valleyMin) this.valleyMin = p.v;
      if (p.v > this.prev2.v && p.v >= v) this._onPeak(p);
    }
    this.prev2 = this.prev1;
    this.prev1 = { t, v };

    // Walking stops when the steps stop.
    if (this.walking && this.lastStepT !== null) {
      const period = this.periodS || 0.6;
      if (t - this.lastStepT > Math.max(1500, cfg.STOP_NO_STEP_PERIODS * period * 1000)) {
        this.walking = false;
        this.enterCount = 0;
        this.recentBounces = [];
        this.reason = "stopped";
      }
    }
  }

  _evaluate(t) {
    const cfg = this.cfg;
    const w = this.win;
    if (w.length < 10 || w[w.length - 1].t - w[0].t < cfg.WINDOW_S * 800) {
      this.reason = "collecting";
      return;
    }
    // Resample to a uniform grid for the autocorrelation.
    const step = 1000 / cfg.RESAMPLE_HZ;
    const t0 = w[0].t;
    const n = Math.floor((w[w.length - 1].t - t0) / step);
    const x = new Array(n);
    const gx = new Array(n), gy = new Array(n), gz = new Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const ti = t0 + i * step;
      while (j < w.length - 2 && w[j + 1].t < ti) j++;
      const a = w[j], b = w[j + 1] || a;
      const f = b.t > a.t ? (ti - a.t) / (b.t - a.t) : 0;
      x[i] = a.v + f * (b.v - a.v);
      gx[i] = a.wx + f * (b.wx - a.wx);
      gy[i] = a.wy + f * (b.wy - a.wy);
      gz[i] = a.wz + f * (b.wz - a.wz);
    }
    let mean = 0;
    for (const xi of x) mean += xi;
    mean /= n;
    for (let i = 0; i < n; i++) x[i] -= mean;
    // A single jolt (the phone knocked, put down, bumped in a pocket) is
    // tens of times bigger than a step. Left in, it swamps the spread - every
    // real step then falls under the peak threshold - and the rhythm check,
    // for the 2.5 s it stays in the window. So: a spread a jolt cannot move
    // (median absolute deviation; about the std for walking), and samples
    // beyond JOLT_CLIP_MAD of it clipped before the std and the rhythm.
    const absDev = x.map(Math.abs).sort((p, q) => p - q);
    const mad = Math.max(cfg.MIN_PEAK_G, absDev[Math.floor(n / 2)]);
    const clip = cfg.JOLT_CLIP_MAD * mad;
    let varV = 0;
    for (let i = 0; i < n; i++) {
      if (x[i] > clip) x[i] = clip;
      else if (x[i] < -clip) x[i] = -clip;
      varV += x[i] * x[i];
    }
    varV /= n;
    const stdG = Math.sqrt(varV);
    // Peak threshold spread: never above the plain std.
    this.peakSpreadG = Math.min(stdG, mad);

    const kMin = Math.max(1, Math.round(cfg.MIN_PERIOD_S * cfg.RESAMPLE_HZ));
    const kMax = Math.min(n - 10, Math.round(cfg.MAX_PERIOD_S * cfg.RESAMPLE_HZ));
    const r = new Array(kMax + 1).fill(0);
    let best = 0, bestK = null;
    for (let k = kMin; k <= kMax; k++) {
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i + k < n; i++) {
        sxy += x[i] * x[i + k];
        sxx += x[i] * x[i];
        syy += x[i + k] * x[i + k];
      }
      r[k] = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
      // Only local maxima of r count as a period.
      if (k > kMin && r[k - 1] > best && r[k - 1] >= r[k] && r[k - 1] >= (r[k - 2] ?? -1)) {
        best = r[k - 1];
        bestK = k - 1;
      }
    }
    // Left/right asymmetry (phone in a pocket) can make the STRIDE (two steps)
    // the strongest period; prefer the step period when it is nearly as strong.
    if (bestK !== null) {
      const half = Math.round(bestK / 2);
      if (half >= kMin) {
        let hBest = -1, hK = null;
        for (let k = Math.max(kMin, half - 2); k <= Math.min(kMax, half + 2); k++) {
          if (r[k] > hBest) { hBest = r[k]; hK = k; }
        }
        if (hK !== null && hBest >= 0.6 * best) { best = Math.max(best * 0.9, hBest); bestK = hK; }
      }
    }

    // Limb swing (swinging hand, trouser pocket): the gyro's main rotation
    // reverses every step - it swings once per stride. That also settles
    // which lag is the step: the one where the swing is anti-correlated.
    const swingSig = principalSignal(gx, gy, gz);
    let swing = false;
    if (bestK !== null && swingSig.std >= cfg.SWING_MIN_STD_DPS) {
      const rs = (k) => (k < n - 10 ? autocorr(swingSig.s, k) : 0);
      const half = Math.round(bestK / 2);
      if (half >= kMin && rs(half) <= cfg.SWING_ANTI_CORR && rs(2 * half) >= cfg.SWING_REPEAT_CORR) {
        // The vertical's best lag was the stride; take the step lag inside it.
        let hBest = -Infinity, hK = half;
        for (let k = Math.max(kMin, half - 2); k <= Math.min(kMax, half + 2); k++) {
          if (r[k] > hBest) { hBest = r[k]; hK = k; }
        }
        swing = true;
        bestK = hK;
      } else if (rs(bestK) <= cfg.SWING_ANTI_CORR && rs(2 * bestK) >= cfg.SWING_REPEAT_CORR) {
        swing = true;
      }
    }
    this.swing = swing;

    let h2 = 0, rot = 0, rt = 0, rtRecent = 0, nRecent = 0;
    const recentCut = t - cfg.RECENT_TILT_S * 1000;
    for (const s of w) {
      h2 += s.h2; rot += s.rot; rt += s.rt;
      if (s.t >= recentCut) { rtRecent += s.rt; nRecent++; }
    }
    h2 /= w.length;
    rot /= w.length;
    rt /= w.length;
    rtRecent = nRecent ? rtRecent / nRecent : 0;
    const vertShare = varV + h2 > 0 ? varV / (varV + h2) : 0;

    this.stats = {
      corr: Number(best.toFixed(2)),
      stdG: Number(stdG.toFixed(3)),
      vertShare: Number(vertShare.toFixed(2)),
      rotDps: Math.round(rot),
      tiltRotDps: Math.round(rt),
      swing,
      periodS: bestK ? Number((bestK / cfg.RESAMPLE_HZ).toFixed(2)) : null,
    };

    let walkingNow;
    let reason;
    if (stdG < cfg.STILL_STD_G) { walkingNow = false; reason = "standing"; }
    else if (rot > (swing ? cfg.MAX_ROT_SWING_DPS : cfg.MAX_ROT_MEAN_DPS)) { walkingNow = false; reason = `shaking (rotating ${Math.round(rot)}°/s)`; }
    else if (!swing && Math.max(rt, rtRecent) > cfg.MAX_TILT_ROT_DPS) { walkingNow = false; reason = `shaking (tilting ${Math.round(Math.max(rt, rtRecent))}°/s)`; }
    else if (!swing && vertShare < cfg.MIN_VERTICAL_SHARE) { walkingNow = false; reason = `shaking (${Math.round(vertShare * 100)}% vertical)`; }
    else if (best < (this.walking ? cfg.WALK_KEEP_CORR : cfg.WALK_MIN_CORR)) { walkingNow = false; reason = "no walking rhythm"; }
    else if (stdG < cfg.WALK_MIN_STD_G && !this.walking) { walkingNow = false; reason = "movement too small"; }
    else { walkingNow = true; reason = "walking"; }

    if (walkingNow) {
      this.periodS = bestK / cfg.RESAMPLE_HZ;
      this.exitCount = 0;
      if (!this.walking) {
        this.enterCount++;
        if (this.enterCount >= cfg.ENTER_EVALS) this._startWalking(t);
      }
    } else {
      this.enterCount = 0;
      if (this.walking) {
        this.exitCount++;
        if (this.exitCount >= cfg.EXIT_EVALS) { this.walking = false; this.exitCount = 0; }
      }
    }
    this.reason = this.walking ? "walking" : reason;
  }

  _startWalking(t) {
    const cfg = this.cfg;
    // The steps of the window that confirmed walking.
    const cut = t - cfg.WINDOW_S * 1000;
    const minGap = this._minGapMs();
    const sel = [];
    for (const p of this.peaks) {
      if (p.t < cut) continue;
      if (sel.length && p.t - sel[sel.length - 1].t < minGap) continue;
      sel.push(p);
    }
    // Drop weak bumps from before walking began (standing, hand tremor): a
    // released step must be as strong as the walking that confirmed it.
    if (sel.length >= 2) {
      const sb = sel.map((p) => p.bounce).sort((x, y) => x - y);
      const med = sb[Math.floor(sb.length / 2)];
      while (sel.length && sel[0].bounce < cfg.MIN_BOUNCE_FRAC * med) sel.shift();
    }
    // They must be enough, and evenly spaced at the measured cadence. A gap
    // of two periods is one step that made no peak - with the phone in one
    // trouser pocket the far leg's steps are often too weak - and counts as
    // that step (it cannot be a pause: walking is continuous here).
    const period = (this.periodS || 0.6) * 1000;
    const tol = cfg.START_GAP_TOLERANCE * period;
    const stepsIn = (gap) => (Math.abs(gap - period) <= tol ? 1 : Math.abs(gap - 2 * period) <= tol ? 2 : 0);
    const even = sel.slice(1).every((p, i) => stepsIn(p.t - sel[i].t) > 0);
    const minPeaks = (this.stats?.corr ?? 0) >= cfg.START_FAST_CORR ? cfg.START_FAST_MIN_PEAKS : cfg.START_MIN_PEAKS;
    if (sel.length < minPeaks || !even) {
      this.reason = "checking walking rhythm";
      return;
    }
    this.walking = true;
    this.enterCount = 0;
    // Earlier steps of the same walk: going back from the first released
    // step, each older peak one (or two) periods before it and as strong as
    // the walking. An extra bump in between is skipped; a longer gap or a
    // weak bump is where the walk began. Never before the last step already
    // counted. Confirming can take several seconds (a restart with the phone
    // in a pocket); these steps used to be lost.
    const relB = sel.map((p) => p.bounce).sort((x, y) => x - y);
    const medB = relB[Math.floor(relB.length / 2)];
    const earlier = [];
    let first = sel[0];
    for (let i = this.peaks.length - 1; i >= 0; i--) {
      const p = this.peaks[i];
      if (p.t >= first.t) continue;
      if (this.lastStepT !== null && p.t <= this.lastStepT) break;
      const gap = first.t - p.t;
      if (gap < period - tol) continue;
      if (!stepsIn(gap) || p.bounce < cfg.MIN_BOUNCE_FRAC * medB) break;
      earlier.unshift(p);
      first = p;
    }
    // Release them, each with its own time (and so its own heading), with
    // the missing step of a two-period gap half way between its neighbours.
    const all = [...earlier, ...sel];
    all.forEach((p, i) => {
      const prev = all[i - 1];
      if (prev && stepsIn(p.t - prev.t) === 2) {
        this._emit((prev.t + p.t) / 2, Math.min(prev.bounce, p.bounce), true);
      }
      this._emit(p.t, p.bounce, true);
    });
    this.peaks = [];
  }

  _minGapMs() {
    const cfg = this.cfg;
    const byPeriod = this.periodS ? cfg.GAP_PERIOD_FRAC * this.periodS : 0;
    return 1000 * Math.max(cfg.MIN_STEP_GAP_S, byPeriod);
  }

  _onPeak(p) {
    const cfg = this.cfg;
    const thr = Math.max(cfg.MIN_PEAK_G, cfg.PEAK_STD_FRAC * (this.peakSpreadG ?? this.stats.stdG ?? 0));
    if (p.v < thr) return;
    const bounce = p.v - (Number.isFinite(this.valleyMin) ? this.valleyMin : -p.v);
    this.valleyMin = Infinity;
    const lastT = this.walking ? this.lastStepT : (this.peaks.length ? this.peaks[this.peaks.length - 1].t : null);
    if (lastT !== null && p.t - lastT < this._minGapMs()) return;
    if (this.walking) {
      const rb = [...this.recentBounces].sort((a, b) => a - b);
      const med = rb.length >= 3 ? rb[Math.floor(rb.length / 2)] : null;
      // Far stronger than the steps so far: the phone was knocked or put
      // down (stopping often ends with one), not a step.
      if (med !== null && bounce > cfg.MAX_BOUNCE_FRAC * med) return;
      if (med !== null && bounce < cfg.MIN_BOUNCE_FRAC * med) {
        const period = (this.periodS || 0.6) * 1000;
        const onBeat = this.lastStepT !== null && Math.abs(p.t - this.lastStepT - period) <= cfg.ON_BEAT_TOLERANCE * period;
        if (!onBeat || bounce < cfg.ON_BEAT_MIN_BOUNCE_FRAC * med) return;
      }
      this._emit(p.t, bounce, false);
    } else {
      this.peaks.push({ t: p.t, bounce });
      const cut = p.t - this.cfg.PEAK_HISTORY_S * 1000;
      while (this.peaks.length && this.peaks[0].t < cut) this.peaks.shift();
    }
  }

  _emit(t, bounce, backfilled) {
    const cfg = this.cfg;
    const intervalMs = this.lastStepT !== null && t - this.lastStepT < cfg.MAX_PERIOD_S * 2000
      ? t - this.lastStepT : null;
    const period = intervalMs ? intervalMs / 1000 : this.periodS;
    // Undo the low-pass filter's attenuation at this cadence (first order).
    const f = period ? 1 / period : null;
    const gain = f ? 1 / Math.sqrt(1 + (f / cfg.LP_CUTOFF_HZ) ** 2) : 1;
    const bounceG = Math.max(0, bounce) / Math.max(0.5, gain);
    // Heading: mean over this stride (since the previous step), else the last
    // period before it.
    const from = this.lastStepT !== null && intervalMs ? this.lastStepT : t - 1000 * (period || 0.6);
    let headingDeg = meanHeading(this.headings, from, t);
    if (headingDeg === null && this.headings.length) headingDeg = this.headings[this.headings.length - 1].h;
    this.lastStepT = t;
    this.steps++;
    this.recentBounces.push(bounce);
    if (this.recentBounces.length > 6) this.recentBounces.shift();
    // Smoothed step rate: one interval is noisy, the length model wants pace.
    if (f && f >= 1 / cfg.MAX_PERIOD_S && f <= 1 / cfg.MIN_PERIOD_S) {
      this.cadenceHz = this.cadenceHz === null ? f : this.cadenceHz + 0.3 * (f - this.cadenceHz);
    } else if (this.cadenceHz === null && this.periodS) {
      this.cadenceHz = 1 / this.periodS;
    }
    const carry = this.carry.getState();
    const lengthM = this.stepLength(bounceG, { cadenceHz: this.cadenceHz, carry: carry.mode, intervalMs });
    if (this.onStep) {
      this.onStep({
        t,
        lengthM,
        headingDeg: headingDeg === null ? null : wrap180(headingDeg),
        bounceG,
        cadenceHz: this.cadenceHz,
        intervalMs,
        backfilled,
        carry: carry.mode,
        carryVersion: carry.version,
      });
    }
  }

  /** How the phone is carried (see CarryDetector). */
  getCarry() {
    return this.carry.getState();
  }

  getStatus() {
    return {
      walking: this.walking,
      reason: this.reason,
      steps: this.steps,
      cadenceHz: this.periodS ? Number((1 / this.periodS).toFixed(2)) : null,
      carry: this.carry.mode,
      ...this.stats,
    };
  }
}
