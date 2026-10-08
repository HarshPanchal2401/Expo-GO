// ============================================================================
// StepGate.js — decides whether an accelerometer "step" is really walking
//
// The step detector in App.*.js finds every peak-valley bounce that is big
// enough. Shaking the phone makes those too, so on its own it walked the user
// forward while they stood still. Every candidate step now passes through
// this gate, which only counts it if it looks like walking:
//
//   1. Up-and-down: walking bounces the phone along gravity; a shake is mostly
//      sideways. Candidates whose motion is mostly NOT vertical are refused
//      (verticalRatio = vertical energy / total dynamic energy).
//   2. Little twisting: a wrist shake rotates the phone fast (hundreds of
//      deg/s); a phone held while walking hardly rotates. Candidates with a
//      large rotation peak are refused.
//   3. Rhythm: walking is periodic at about 1-2.5 steps per second with
//      evenly spaced steps. Walking only STARTS after START_STEPS candidates
//      in a row at a walking pace and evenly spaced; those steps are then
//      released together, so no distance is lost. Once walking the rhythm
//      must CONTINUE: each interval within RHYTHM_TOLERANCE_WALKING of the
//      recent median. Real steps vary by ~5-10 %; a shake that happened to
//      look regular for 4 beats rarely stays regular, and two misses in a
//      row end walking.
//   4. Stop: no accepted step for STOP_AFTER_MS ends walking, and the rhythm
//      has to be shown again.
//
// API (used by App.android.js / App.ios.js):
//   candidate({ t, bounce, verticalRatio, rotDps, step }) -> steps to count
//       (array of the `step` payloads; empty when refused or still deciding)
//   isWalking(now)  - for other step sources (the OS pedometer)
//   lastReason      - why the last candidate was not counted (status text)
//   reset()
// ============================================================================

export const STEP_GATE_CONFIG = {
  // 1. Share of the motion that is along gravity. Walking with the phone in
  //    the hand: ~0.5-0.8. Shaking: usually < 0.3.
  // Kept low: walking also has strong FORWARD acceleration, and a tilting
  // phone leaks some gravity into the horizontal part. 0.35 refused real
  // walking in the field.
  MIN_VERTICAL_RATIO: 0.2,
  // 2. Fastest rotation (deg/s) around a step. Walking with the phone held:
  //    < ~120. A shake: 300-800.
  // Kept high: a phone in a trouser pocket or a swinging hand turns
  // 200-350 deg/s on every step. Only clearly violent twisting is refused.
  MAX_ROTATION_DPS: 450,
  // 3. Walking pace: interval between steps (ms). 300 = 3.3 steps/s (fast),
  //    1100 = 0.9 steps/s (very slow walk).
  MIN_INTERVAL_MS: 300,
  MAX_INTERVAL_MS: 1100,
  // Steps in a row needed to START walking, and how even they must be: each
  // interval within this fraction of their median.
  START_STEPS: 3,
  RHYTHM_TOLERANCE: 0.35,
  // While walking: each interval within this fraction of the median of the
  //    last few (looser than at the start, to allow speeding up/slowing down
  //    gradually), and this many misses in a row end walking.
  RHYTHM_TOLERANCE_WALKING: 0.4,
  RHYTHM_WINDOW: 6,
  MAX_RHYTHM_MISSES: 3,
  // 4. Once walking: a slower interval is still accepted up to this (e.g.
  //    slowing down at a door), and walking stops after this long without a
  //    step.
  WALKING_MAX_INTERVAL_MS: 1500,
  STOP_AFTER_MS: 2000,
};

export class StepGate {
  constructor(config = {}) {
    this.cfg = { ...STEP_GATE_CONFIG, ...config };
    this.reset();
  }

  reset() {
    this.walking = false;
    this.pending = [];        // candidates waiting for the rhythm to be shown
    this.intervals = [];      // recent accepted step intervals (ms)
    this.misses = 0;          // rhythm misses in a row while walking
    this.lastAcceptedAt = null;
    this.lastCandidateAt = null;
    this.lastReason = "";
    this.stats = { accepted: 0, refusedShake: 0, refusedRhythm: 0 };
  }

  isWalking(now = Date.now()) {
    if (this.walking && this.lastAcceptedAt !== null && now - this.lastAcceptedAt > this.cfg.STOP_AFTER_MS) {
      this.walking = false;
      this.pending = [];
    }
    return this.walking;
  }

  /** Reason the candidate is not a walking step, or null if it could be. */
  _shakeReason(c) {
    if (Number.isFinite(c.verticalRatio) && c.verticalRatio < this.cfg.MIN_VERTICAL_RATIO) {
      return `shake (motion ${Math.round(c.verticalRatio * 100)}% vertical)`;
    }
    if (Number.isFinite(c.rotDps) && c.rotDps > this.cfg.MAX_ROTATION_DPS) {
      return `shake (phone rotating ${Math.round(c.rotDps)}°/s)`;
    }
    return null;
  }

  candidate(c) {
    const t = Number.isFinite(c?.t) ? c.t : Date.now();
    const cfg = this.cfg;
    const sinceLast = this.lastCandidateAt === null ? null : t - this.lastCandidateAt;
    this.lastCandidateAt = t;
    this.isWalking(t); // applies the stop timeout

    const shake = this._shakeReason(c);
    if (shake) {
      this.lastReason = shake;
      this.stats.refusedShake++;
      // A shake in the middle of a start sequence breaks the rhythm.
      this.pending = [];
      return [];
    }

    // ── Already walking: a plausible interval is enough ──
    if (this.walking) {
      const since = t - this.lastAcceptedAt;
      if (since < cfg.MIN_INTERVAL_MS) {
        this.lastReason = `too soon after the last step (${since} ms)`;
        this.stats.refusedRhythm++;
        return [];
      }
      if (since > cfg.WALKING_MAX_INTERVAL_MS) {
        // Paused: start again, this step being the first of a new rhythm.
        this.walking = false;
        this.pending = [];
        this.intervals = [];
      } else {
        const sorted = [...this.intervals].sort((a, b) => a - b);
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : since;
        // About twice the usual interval = the detector missed one step in
        // between (common): count both, the missed one included.
        const missedOne = Math.abs(since - 2 * median) <= cfg.RHYTHM_TOLERANCE_WALKING * median;
        if (missedOne) {
          this.misses = 0;
          this.lastAcceptedAt = t;
          this.stats.accepted += 2;
          this.lastReason = "";
          return [c.step, c.step];
        }
        if (Math.abs(since - median) > cfg.RHYTHM_TOLERANCE_WALKING * median) {
          this.misses++;
          this.stats.refusedRhythm++;
          if (this.misses >= cfg.MAX_RHYTHM_MISSES) {
            // Not walking any more (or never was): rhythm must be shown again.
            this.walking = false;
            this.pending = [];
            this.intervals = [];
            this.misses = 0;
            this.lastReason = "rhythm lost - not walking";
          } else {
            this.lastReason = `off rhythm (${since} ms vs ${median} ms)`;
          }
          return [];
        }
        this.misses = 0;
        this.intervals.push(since);
        if (this.intervals.length > cfg.RHYTHM_WINDOW) this.intervals.shift();
        this.lastAcceptedAt = t;
        this.stats.accepted++;
        this.lastReason = "";
        return [c.step];
      }
    }

    // ── Not walking yet: collect a rhythm ──
    if (sinceLast !== null && (sinceLast < cfg.MIN_INTERVAL_MS || sinceLast > cfg.MAX_INTERVAL_MS)) {
      // Out of walking pace: restart the sequence from this candidate.
      this.pending = [];
    }
    this.pending.push({ t, step: c.step });
    if (this.pending.length > cfg.START_STEPS) this.pending.shift();

    if (this.pending.length < cfg.START_STEPS) {
      this.lastReason = `checking walking rhythm (${this.pending.length}/${cfg.START_STEPS})`;
      this.stats.refusedRhythm++;
      return [];
    }

    const intervals = [];
    for (let i = 1; i < this.pending.length; i++) intervals.push(this.pending[i].t - this.pending[i - 1].t);
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const even = intervals.every((iv) => Math.abs(iv - median) <= cfg.RHYTHM_TOLERANCE * median);
    if (!even) {
      this.lastReason = "uneven rhythm - not walking";
      this.stats.refusedRhythm++;
      // Keep the latest few: the rhythm may settle on the next step.
      this.pending.shift();
      return [];
    }

    // Walking confirmed: release every step of the sequence.
    this.walking = true;
    this.intervals = intervals.slice();
    this.misses = 0;
    this.lastAcceptedAt = t;
    const released = this.pending.map((p) => p.step);
    this.pending = [];
    this.stats.accepted += released.length;
    this.lastReason = "";
    return released;
  }
}
