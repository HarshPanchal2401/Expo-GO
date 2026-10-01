// ============================================================================
// FusionEngine.js — Async EKF Fusion Engine (PDR Prediction + BLE Correction)
//
// Implements a lightweight 2D Extended Kalman Filter that fuses:
//   • PDR (Pedestrian Dead Reckoning) prediction steps — fires on every step
//   • BLE weighted-distance correction — fires on every beacon packet
//
// With only 2 beacons (not enough for true trilateration), this engine uses
// WEIGHTED PROXIMITY BLENDING:
//   — Each beacon defines a distance circle.
//   — We estimate position along the B1→B2 baseline, weighted by confidence².
//   — PDR fills in the lateral (perpendicular) component.
//
// UNITS: this entire engine operates in FEET, matching the office floor plan's
// foot-based grid. PDR step length arrives from the accelerometer model in
// metres — convert with metresToFeet() (see PdrEngine.js) before calling
// predict(). BLE distances from AdaptiveBeaconEngine are in metres — convert
// the same way before calling correct(). Converting once, at these two call
// sites, is what keeps every downstream number (anchors, room bounds,
// uncertainty radius, rendered map) in a single unit with no room for a
// missed conversion.
//
// State vector: [x, y]  (2×1 position in FEET)
// Covariance:   P       (2×2 error covariance, feet²)
//
// PDR → Prediction step  (updates x, y, grows P)
// BLE → Correction step  (computes Kalman gain K, shrinks P)
// ============================================================================

import { pdrEngine } from './PdrEngine.js';
import { solveInitialPosition, isWalkable, RangeFixAccumulator } from './InitialPositionSolver.js';

// ============================================================================
// FUSION CONFIGURATION (all spatial constants in FEET / FEET²)
// ============================================================================

export const FUSION_CONFIG = {
  // PDR process noise: fraction of step length used as positional σ per step.
  // Larger value = EKF trusts PDR less = BLE pulls harder. Lowered from 0.12
  // so PDR's own uncertainty grows more slowly between BLE fixes, keeping the
  // filter confident in dead-reckoning rather than getting readily swayed by
  // every BLE reading (PDR is the more trustworthy sensor over short walks;
  // BLE should nudge, not override).
  PDR_STEP_NOISE_FACTOR: 0.06,

  // Minimum BLE measurement noise (R). Raised so even a "perfect confidence"
  // BLE reading pulls gently rather than strongly — BLE now acts as a slow
  // corrective drift-anchor, not a per-packet override of PDR's track.
  BLE_R_MIN_FT2: 4.0,        // ≈ (2.0 ft)² (was 0.97 ≈ (0.98 ft)²)

  // Maximum BLE measurement noise (R). Low-confidence beacon = very weak pull.
  BLE_R_MAX_FT2: 400.0,      // ≈ (20 ft)² (was 172.2 ≈ (13.12 ft)²)

  // If implied correction speed exceeds this, the beacon is likely lying (multipath).
  // Down-weight the correction instead of accepting it blindly. (3.0 m/s)
  JUMP_GUARD_SPEED_FPS: 9.84,

  // Factor by which R is multiplied when jump guard fires.
  JUMP_GUARD_R_MULTIPLIER: 8.0,

  // ── Baseline geometry quality penalty ──
  // With only 2 beacons, correct() resolves position by dividing by the
  // beacon-to-beacon baseline length (see the "1D observation" math below).
  // The shorter that baseline, the more any RSSI-distance noise gets
  // geometrically amplified into position error — beacons placed a few feet
  // apart (rather than at opposite walls) turn ordinary signal jitter into
  // large, erratic swings, which is what makes a straight retraced walk come
  // back looking like a loop instead of overlapping itself. This penalty
  // inflates R for short baselines, roughly canceling that amplification.
  // GOOD_BASELINE_FT is the length below which the penalty kicks in; capping
  // at MAX_BASELINE_PENALTY prevents an extremely short baseline from
  // effectively disabling BLE correction outright.
  GOOD_BASELINE_FT: 15.0,
  MAX_BASELINE_PENALTY: 25.0,

  // ── Perpendicular (off-baseline) observation ──
  // Two beacons give two distances, which is two pieces of information. The
  // engine previously used only one of them: it solved for the position ALONG
  // the beacon-to-beacon line and threw the rest away, leaving the
  // perpendicular axis entirely to dead reckoning and letting heading drift
  // accumulate there uncorrected. But once the along-baseline coordinate t is
  // known, the perpendicular offset follows from Pythagoras: h = sqrt(d1² - t²).
  // Only its SIGN is ambiguous, and with beacons on a wall the room lies on one
  // side, so the current estimate resolves it.
  // That observation is much noisier than the along-baseline one and becomes
  // ill-conditioned close to the beacon line (where h is small, a tiny distance
  // error swings h wildly), so its noise is scaled by the derivative
  // dh/dd = d1/h rather than being trusted equally - see correct().
  //
  // DEFAULT OFF, because measurement said so. The along-baseline solve uses
  // (d1² - d2²), a DIFFERENCE, so a common-mode range bias — both beacons
  // reading long — largely cancels. The perpendicular solve uses d1 directly,
  // so the same bias passes straight through and pushes the position away from
  // the beacon wall. Swept against realistic bias (the BLE engine still leaves
  // a few feet), mean / worst-case RMSE over -4..+6 ft of bias came out:
  //     disabled      2.35 / 2.36 ft
  //     PERP_R_SCALE 2   2.78 / 3.64 ft
  //     PERP_R_SCALE 15  2.35 / 2.50 ft
  // It wins only at near-zero bias (2.23 vs 2.35 ft) and loses everywhere else,
  // so enabling it costs robustness for a gain that does not survive contact
  // with real ranging error. Worth revisiting if range bias is ever driven near
  // zero by better calibration, or if a third beacon makes the perpendicular
  // axis properly observable instead of inferred.
  ENABLE_PERPENDICULAR_FIX: false,
  PERP_R_SCALE: 15.0,
  MAX_PERP_R_FT2: 2500.0,
  MIN_PERP_HEIGHT_FT: 3.0,

  // Initial position uncertainty (ft²) on cold-start. (0.25 m² = (0.5m)²)
  INITIAL_COVARIANCE_FT2: 2.69,

  // Passive covariance growth (ft²/s) when standing still.
  // Prevents the filter from becoming overconfident while stationary. (0.001 m²/s)
  Q_PASSIVE_FT2_PER_S: 0.0108,

  // Minimum uncertainty radius reported in UI (never shows 0 ft exactly). (0.15 m)
  MIN_UNCERTAINTY_FT: 0.49,

  // Maximum uncertainty radius reported. (8.0 m)
  MAX_UNCERTAINTY_FT: 26.25,

  // ── Motion gating ──
  // A person standing still has a CONSTANT true position, so every foot the
  // dot moves while they stand is movement the map invented. BLE cannot tell
  // the difference on its own — its distance noise looks identical whether or
  // not you are walking — so the filter has to be told. It already is: every
  // step calls predict(), so the time since the last step is a reliable
  // "is the user walking" signal with no extra plumbing.
  // While stationary the measurement noise is inflated and the process noise
  // cut, which shrinks the Kalman gain. BLE then still pulls the position to
  // where it belongs, but as a slow creep instead of a per-packet vibration.
  STATIONARY_AFTER_MS: 1400,
  STATIONARY_R_MULTIPLIER: 6.0,
  STATIONARY_Q_SCALE: 0.15,

  // ── Two-candidate (mirror) ambiguity resolution ──
  // Two range circles meet at two points mirrored about the beacon line, and no
  // amount of further ranging separates them while the user moves parallel to
  // that line — both candidates stay exactly as far from both beacons. The
  // symmetry only breaks when the user moves ACROSS the line, after which the
  // two predict measurably different ranges. So both are carried as live
  // hypotheses, scored on how well each explains incoming ranges, and the loser
  // is dropped once the evidence is decisive. A candidate that walks out of the
  // floor plan is dropped immediately — the map is the strongest evidence there
  // is, and it usually settles the question on the first reading.
  AMBIGUITY_LOG_ODDS_TO_RESOLVE: 10.0,  // measured: resolves in ~4 steps when
                                        // the geometry allows it, and never
                                        // commits wrongly when it does not
  AMBIGUITY_EVIDENCE_DECAY: 0.97,       // forget stale evidence slowly
  AMBIGUITY_RANGE_SIGMA_FT: 5.0,        // range noise assumed when scoring
  // After this long unresolved the ambiguity is flagged STALE for the UI, but
  // deliberately NOT force-resolved. Committing on a timer was measurably
  // worse than admitting uncertainty: when the user happens to walk parallel to
  // the beacon line the symmetry is never broken, and a timed commit picked the
  // wrong position 25% of the time while presenting it as a normal fix. Holding
  // both and telling the user to cross the beacon line keeps the honest answer
  // available and is actionable.
  AMBIGUITY_STALE_SECONDS: 25,

  // Cold-start uncertainty accounting. The solver sizes its estimate assuming
  // COLD_START_ASSUMED_SIGMA_FT of range error; when the actual spread of the
  // collected samples is known, that assumption is replaced by the measured
  // value scaled by the same geometry factor. The floors stop an unusually
  // quiet burst of packets from being mistaken for a perfect fix — averaging
  // suppresses jitter but not the slow shadowing underneath it.
  COLD_START_ASSUMED_SIGMA_FT: 4.0,
  COLD_START_MIN_RANGE_SIGMA_FT: 1.5,
  COLD_START_MIN_UNCERTAINTY_FT: 2.0,

  // Weight on the floor-plan penalty when scoring hypotheses, and the debt at
  // which a hypothesis is abandoned outright.
  //
  // Room bounds are applied as an accumulated DEBT rather than an instant kill,
  // because the position is soft-clamped into the room: a hypothesis pushed
  // back at the wall looks perfectly in-bounds afterwards, so testing the
  // post-clamp position simply cannot see it. Worse, only the primary was being
  // clamped, so the alternate alone could ever appear out of bounds and the
  // test silently favoured the primary no matter what the ranges said. Charging
  // both hypotheses for how hard they have to be pushed back keeps the map as
  // evidence while treating the two identically.
  OOB_DEBT_WEIGHT: 0.6,
  OOB_DEBT_DECAY: 0.97,
  OOB_DEBT_KILL_FT: 25.0,

  // Minimum movement (ft) before a new trail point is recorded.
  // This is deliberately larger than the residual BLE jitter amplitude. At the
  // old 0.1 ft threshold every BLE packet qualified as "movement", so the trail
  // filled with correction noise and the fixed-size buffer discarded the start
  // of the walk — the map could only show the last few seconds rather than the
  // route taken. Sampling by real distance keeps the whole path.
  MIN_TRAIL_MOVE_FT: 1.0,

  // Trail capacity in points. With distance-based sampling this is a route
  // length budget: MAX_TRAIL_POINTS × MIN_TRAIL_MOVE_FT ≈ 300 ft of path.
  MAX_TRAIL_POINTS: 300,
};

// ============================================================================
// FusionEngine Class
// ============================================================================

export class FusionEngine {
  constructor(config = {}) {
    this._cfg = { ...FUSION_CONFIG, ...config };

    // EKF State: 2D position (feet)
    this._x = 0;
    this._y = 0;

    // EKF Error Covariance (diagonal 2×2, stored as [pxx, pyy], feet²)
    this._pxx = this._cfg.INITIAL_COVARIANCE_FT2;
    this._pyy = this._cfg.INITIAL_COVARIANCE_FT2;
    this._pxy = 0;  // cross-covariance

    // Beacon anchor positions in feet (user-configured real-world coordinates)
    this._anchor1 = { x: 0, y: 0 };
    this._anchor2 = { x: 10, y: 0 };  // default: 10 ft apart on x-axis

    // Room bounds for soft clamping (feet)
    this._roomWidth = null;   // feet, null = unconstrained
    this._roomHeight = null;

    // Timestamps
    this._lastCorrectionTime = null;
    this._lastTickTime = Date.now();
    this._lastStepAt = null;     // drives the stationary gate - see correct()

    // Optional second position hypothesis (the mirror candidate). null when the
    // fix is unambiguous, which is the normal case for wall-mounted beacons.
    this._alt = null;
    this._primaryLogLik = 0;
    this._primaryOobDebt = 0;
    this._ambiguousSince = null;
    this._ambiguityStale = false;
    this._lastAmbiguityResolution = null;

    // Cold-start range collection. A position fixed from a single BLE packet
    // inherits that packet's several feet of range error, and the intersection
    // geometry then amplifies it. Collecting a few seconds of packets first is
    // the single cheapest accuracy gain available at start-up.
    this._accumulator = new RangeFixAccumulator();
    this._locating = false;

    // Where this tracking session began, for net displacement reporting.
    this._startX = 0;
    this._startY = 0;

    // Scores for UI
    this._lastBleConf = 0;
    this._lastPdrConf = 0;
    this._lastCorrectionPos = null;

    // Trail of recent positions for the map (feet)
    this._trail = [];
    this._maxTrailLength = this._cfg.MAX_TRAIL_POINTS;
  }

  // --------------------------------------------------------------------------
  // CONFIGURATION
  // --------------------------------------------------------------------------

  /**
   * Set real-world anchor coordinates for both beacons, in FEET.
   * Call this whenever the user places/drags beacons on the floor plan.
   *
   * @param {{ x: number, y: number }} b1 - Beacon 1 world position (feet)
   * @param {{ x: number, y: number }} b2 - Beacon 2 world position (feet)
   */
  setBleAnchors(b1, b2) {
    this._anchor1 = { x: Number(b1.x) || 0, y: Number(b1.y) || 0 };
    this._anchor2 = { x: Number(b2.x) || 10, y: Number(b2.y) || 0 };
  }

  /**
   * Set room/floor-plan boundaries for soft position clamping, in FEET.
   * @param {number} widthFt
   * @param {number} heightFt
   */
  setRoomSize(widthFt, heightFt) {
    this._roomWidth = Number(widthFt) > 0 ? Number(widthFt) : null;
    this._roomHeight = Number(heightFt) > 0 ? Number(heightFt) : null;
  }

  /**
   * Cold-start reset — snaps position to known coordinates (feet) and resets covariance.
   * @param {number} x0 - feet
   * @param {number} y0 - feet
   */
  reset(x0 = 0, y0 = 0) {
    this._x = Number(x0) || 0;
    this._y = Number(y0) || 0;
    this._pxx = this._cfg.INITIAL_COVARIANCE_FT2;
    this._pyy = this._cfg.INITIAL_COVARIANCE_FT2;
    this._pxy = 0;
    this._lastCorrectionTime = null;
    this._lastTickTime = Date.now();
    this._lastStepAt = null;
    this._alt = null;
    this._primaryLogLik = 0;
    this._primaryOobDebt = 0;
    this._ambiguousSince = null;
    this._ambiguityStale = false;
    this._startX = this._x;
    this._startY = this._y;
    this._lastBleConf = 0;
    this._lastPdrConf = 0;
    this._trail = [{ x: this._x, y: this._y }];
    pdrEngine.reset(x0, y0);
  }

  /**
   * Cold start: establish the initial position from two beacon ranges.
   *
   * Dead reckoning only measures how you have MOVED, so something has to fix
   * where you began — and any error there is inherited by every position after
   * it, however good the tracking. This solves the two range circles properly
   * (see InitialPositionSolver) instead of the previous approach, which solved
   * only the along-baseline coordinate and discarded the perpendicular one,
   * placing the user somewhere on the line between the beacons no matter where
   * they actually stood.
   *
   * When the floor plan cannot rule out the mirror candidate, BOTH are kept and
   * carried until movement decides between them, rather than guessing one and
   * silently being wrong half the time.
   *
   * @returns the solver result, so the UI can explain what happened.
   */
  /**
   * Starts the LOCATING phase: collect ranges before committing to a position.
   * Call once when tracking begins, then feed every BLE reading to
   * feedLocatingSample() until it reports done.
   */
  beginLocating() {
    this._accumulator.reset();
    this._locating = true;
  }

  get isLocating() { return this._locating; }

  /**
   * Feeds one BLE reading into the cold-start fix.
   *
   * Returns progress while collecting and, once enough evidence has been
   * gathered, performs the fix and returns it. A provisional position is
   * offered early so the map can show something sensible immediately, but it is
   * explicitly marked provisional and is NOT committed to the filter — showing
   * an early guess is fine, inheriting one is not.
   *
   * @returns {{ done: boolean, progress: number, samples: number,
   *             provisional: {x,y}|null, fix: object|null }}
   */
  feedLocatingSample(d1, d2, conf1 = 1, conf2 = 1) {
    if (!this._locating) return { done: true, progress: 1, samples: 0, provisional: null, fix: null };

    // Right next to a beacon the range engine reports 0 (receiver saturated).
    // That is a genuine "you are at the beacon", not a missing reading, and it
    // used to be rejected as invalid - so standing near a beacon while
    // locating meant no sample was ever accepted.
    const MIN_RANGE_FT = 0.5;
    const r1 = Number.isFinite(d1) ? Math.max(MIN_RANGE_FT, d1) : d1;
    const r2 = Number.isFinite(d2) ? Math.max(MIN_RANGE_FT, d2) : d2;
    this._accumulator.add(r1, r2, conf1, conf2);
    return this._evaluateLocating();
  }

  /**
   * Re-checks the time limits without a new sample. Readiness used to be
   * evaluated only when a sample arrived, so if samples stopped - a beacon
   * gone quiet - even the timeout could never fire and locating never ended.
   * Call this from a periodic timer.
   */
  checkLocatingTimeout() {
    if (!this._locating) return null;
    return this._evaluateLocating();
  }

  _evaluateLocating() {
    const progress = this._accumulator.progress();

    if (!this._accumulator.isReady()) {
      let provisional = null;
      if (this._accumulator.hasProvisional()) {
        const c = this._accumulator.consolidate();
        const peek = solveInitialPosition({
          anchor1: this._anchor1, anchor2: this._anchor2,
          d1: c.d1, d2: c.d2, conf1: c.conf, conf2: c.conf,
          room: this._roomBounds(),
          requireConfidence: false,
        });
        if (peek.position) provisional = peek.position;
      }
      return { done: false, progress, samples: this._accumulator.sampleCount, provisional, fix: null };
    }

    const c = this._accumulator.consolidate();
    const fix = this.initializeFromBeacons({
      d1: c.d1, d2: c.d2, conf1: c.conf, conf2: c.conf,
      measuredRangeSigmaFt: Math.max(c.sigma1Ft ?? 0, c.sigma2Ft ?? 0, c.driftFt ?? 0),
      sampleCount: c.sampleCount,
      averaged: true,
    });
    if (!fix.position) {
      // The solve failed. Previously locating was switched off here anyway,
      // so the screen sat on "locating" forever with nothing left feeding it.
      // Start a fresh window instead and say why, so the user sees progress.
      this._accumulator.reset();
      return { done: false, progress: 0, samples: 0, provisional: null, fix: null, failure: fix };
    }
    this._locating = false;
    return { done: true, progress: 1, samples: c.sampleCount, provisional: null, fix };
  }

  /**
   * Begins NAVIGATING from the position just fixed.
   *
   * Deliberately not reset(): the whole point of the locating phase is the fix
   * it produced, so position, covariance and any unresolved candidate are all
   * preserved. What restarts is the JOURNEY — trail, odometry and the origin
   * that net displacement is measured from — so "walked" counts this trip
   * rather than including the standing-still period spent getting located.
   */
  beginNavigation() {
    this._startX = this._x;
    this._startY = this._y;
    this._trail = [{ x: Number(this._x.toFixed(2)), y: Number(this._y.toFixed(2)) }];
    this._lastStepAt = null;
    pdrEngine.reset(this._x, this._y);
  }

  /**
   * Commits the fix immediately from whatever has been collected so far.
   * Used when the user starts walking mid-locate: from that moment new ranges
   * describe a moving position, so waiting longer would only make the fix
   * worse. Returns null (and keeps locating) if there is not yet enough to
   * solve from.
   */
  finishLocatingNow() {
    if (!this._locating || !this._accumulator.hasProvisional()) return null;
    const c = this._accumulator.consolidate();
    const fix = this.initializeFromBeacons({
      d1: c.d1, d2: c.d2, conf1: c.conf, conf2: c.conf,
      measuredRangeSigmaFt: Math.max(c.sigma1Ft ?? 0, c.sigma2Ft ?? 0, c.driftFt ?? 0),
      sampleCount: c.sampleCount,
      averaged: true,
    });
    if (!fix.position) return null;
    this._locating = false;
    return fix;
  }

  /**
   * Starts from a position the USER chose on the map, instead of from beacons.
   *
   * The user knows where they are standing far better than two BLE ranges do,
   * so this is both the fallback when locating cannot decide and a shortcut
   * when it would take too long. Uncertainty is still seeded (a finger tap on
   * a phone-sized plan is only good to a few feet), so BLE corrections refine
   * it from the first update rather than being ignored.
   */
  setManualPosition(x, y, uncertaintyFt = 3.0) {
    this.cancelLocating();
    let px = Number(x) || 0;
    let py = Number(y) || 0;
    if (this._roomWidth !== null) px = Math.max(0, Math.min(this._roomWidth, px));
    if (this._roomHeight !== null) py = Math.max(0, Math.min(this._roomHeight, py));
    this.reset(px, py);
    const v = Math.max(this._cfg.INITIAL_COVARIANCE_FT2, uncertaintyFt ** 2);
    this._pxx = v;
    this._pyy = v;
    this._pxy = 0;
    return {
      status: "manual",
      reason: "chosen-on-map",
      position: { x: px, y: py },
      alternate: null,
      uncertaintyFt,
      sampleCount: 0,
    };
  }

  /**
   * Settles the two-candidate ambiguity by the user pointing at the mark they
   * are standing on. Returns false if there is nothing to choose between.
   */
  chooseHypothesisNear(x, y) {
    if (!this._alt) return false;
    const dPrimary = Math.hypot(this._x - x, this._y - y);
    const dAlt = Math.hypot(this._alt.x - x, this._alt.y - y);
    this._collapseTo(dAlt < dPrimary ? "alternate" : "primary", "user-chose-on-map");
    return true;
  }

  /** Abandons an in-progress locating phase. */
  cancelLocating() {
    this._locating = false;
    this._accumulator.reset();
  }

  _roomBounds() {
    return (this._roomWidth && this._roomHeight)
      ? { width: this._roomWidth, height: this._roomHeight }
      : null;
  }

  initializeFromBeacons({ d1, d2, conf1, conf2, keepPrior = false, measuredRangeSigmaFt = null, sampleCount = 1, averaged = false }) {
    const result = solveInitialPosition({
      anchor1: this._anchor1,
      anchor2: this._anchor2,
      d1, d2, conf1, conf2,
      // The per-packet confidence gate exists to stop ONE noisy packet becoming
      // the start position. An averaged window has already dealt with that
      // noise, and its measured spread sets the uncertainty below.
      requireConfidence: !averaged,
      room: this._roomBounds(),
      priorPosition: keepPrior ? { x: this._x, y: this._y } : null,
    });
    result.sampleCount = sampleCount;

    if (!result.position) return result;

    this.reset(result.position.x, result.position.y);

    // Seed the covariance from the geometry rather than a fixed constant: a fix
    // taken where the beacons are nearly in line with the user is genuinely
    // weaker than one taken broadside, and the filter should know that so BLE
    // and PDR are weighted honestly from the very first step.
    if (Number.isFinite(result.uncertaintyFt)) {
      // Prefer uncertainty derived from the ranges we actually measured over the
      // assumed constant: averaging N packets genuinely shrinks the range error,
      // and the filter should be allowed to start correspondingly confident
      // rather than being told to distrust a fix that earned its precision.
      // Floored, because averaging removes jitter but not slow shadowing, so a
      // small observed spread must never be read as a perfect fix.
      let reported = result.uncertaintyFt;
      if (Number.isFinite(measuredRangeSigmaFt) && measuredRangeSigmaFt > 0) {
        const geometryFactor = result.uncertaintyFt / (this._cfg.COLD_START_ASSUMED_SIGMA_FT || 4.0);
        reported = Math.max(
          this._cfg.COLD_START_MIN_UNCERTAINTY_FT,
          Math.max(measuredRangeSigmaFt, this._cfg.COLD_START_MIN_RANGE_SIGMA_FT) * geometryFactor
        );
        result.uncertaintyFt = Number(reported.toFixed(2));
      }
      const v = Math.max(this._cfg.INITIAL_COVARIANCE_FT2, reported ** 2);
      this._pxx = v;
      this._pyy = v;
      this._pxy = 0;
    }

    if (result.alternate) {
      this._alt = {
        x: result.alternate.x,
        y: result.alternate.y,
        pxx: this._pxx, pyy: this._pyy, pxy: this._pxy,
        logLik: 0,
        oobDebt: 0,
      };
      this._primaryLogLik = 0;
      this._ambiguousSince = Date.now();
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // EKF PREDICTION — called on every PDR step event
  // --------------------------------------------------------------------------

  /**
   * PDR prediction step. Moves the EKF state forward based on step + heading.
   * Also updates the shared pdrEngine for confidence tracking.
   *
   * @param {number} stepLengthFt - Weinberg step length in FEET (convert from
   *   metres with metresToFeet() before calling — see PdrEngine.js)
   * @param {number} headingDeg   - Smoothed heading (degrees, 0 = forward/north)
   */
  predict(stepLengthFt, headingDeg) {
    const len = Math.max(1.48, Math.min(3.44, stepLengthFt || 2.3));
    // A step IS the motion signal the correction step needs. Recording it here
    // means the stationary gate needs no separate sensor or external wiring.
    this._lastStepAt = Date.now();
    const rad = (headingDeg * Math.PI) / 180;

    // State transition — standard dead-reckoning
    this._x += len * Math.sin(rad);
    this._y += len * Math.cos(rad);

    // Process noise Q: step uncertainty modelled as σ_step = factor × length
    const sigma = this._cfg.PDR_STEP_NOISE_FACTOR * len;
    const Q = sigma * sigma;

    // Covariance prediction: P = P + Q·I (identity addition for isotropic noise)
    this._pxx += Q;
    this._pyy += Q;
    // pxy is unchanged by isotropic noise

    // Soft-clamp to room bounds
    this._clampToRoom();

    // The alternate hypothesis experiences the same movement. Note this does
    // NOT keep the two as mirror images: reflecting a position and then adding
    // a displacement is not the same as adding it and then reflecting, unless
    // the movement is parallel to the beacon line. That asymmetry is exactly
    // what eventually makes the two distinguishable from ranges.
    if (this._alt) {
      this._alt.x += len * Math.sin(rad);
      this._alt.y += len * Math.cos(rad);
      this._alt.pxx += Q;
      this._alt.pyy += Q;
    }

    // Update PDR engine for confidence tracking
    pdrEngine.applyStep(len, headingDeg);

    // Append to trail
    this._pushTrail(this._x, this._y);
  }

  // --------------------------------------------------------------------------
  // EKF CORRECTION — called on every BLE packet from both beacons
  // --------------------------------------------------------------------------

  /**
   * BLE correction step using weighted 2-beacon proximity blending.
   *
   * With only 2 beacons we cannot do full 2D trilateration. Instead:
   *   1. Compute the baseline vector B1→B2.
   *   2. Project each beacon's distance circle onto the baseline.
   *   3. Blend the intersection point weighted by (confidence)².
   *   4. Use the PDR y-component for the perpendicular axis.
   *
   * This gives us a 1D BLE observation (along the B1→B2 axis) fused
   * with PDR in the perpendicular direction.
   *
   * @param {number} d1  - Filtered distance to Beacon 1, in FEET (convert from
   *   AdaptiveBeaconEngine's metres with metresToFeet() before calling)
   * @param {number} d2  - Filtered distance to Beacon 2, in FEET
   * @param {number} c1  - Beacon 1 confidence [0, 1]
   * @param {number} c2  - Beacon 2 confidence [0, 1]
   */
  correct(d1, d2, c1, c2) {
    // Guard: both distances must be valid finite positives
    if (!Number.isFinite(d1) || !Number.isFinite(d2)) return;
    if (d1 <= 0 || d2 <= 0) return;

    const now = Date.now();
    const w1 = Math.max(0, c1 || 0) ** 2;
    const w2 = Math.max(0, c2 || 0) ** 2;
    const wTotal = w1 + w2;
    if (wTotal < 0.01) return;

    // ── Baseline geometry ──────────────────────────────────────────────────
    const bx = this._anchor2.x - this._anchor1.x;
    const by = this._anchor2.y - this._anchor1.y;
    const baselineLen = Math.sqrt(bx * bx + by * by);
    if (baselineLen < 0.33) return; // < ~10 cm — anchors not meaningfully separated

    // Unit vector along B1→B2 (observation direction)
    const ux = bx / baselineLen;
    const uy = by / baselineLen;

    // ── 1D observation: position along baseline from B1 ───────────────────
    // Law of cosines: t = (L² + d1² - d2²) / (2L)
    // This is the ONLY axis BLE can resolve with 2 beacons.
    // The perpendicular axis is unobservable by BLE alone — PDR covers it.
    const t_geom = (baselineLen ** 2 + d1 ** 2 - d2 ** 2) / (2 * baselineLen);
    const t_clamped = Math.max(0, Math.min(baselineLen, t_geom));

    // BLE's scalar observation of the state projected onto the baseline:
    //   z_measured = t_clamped     (distance from B1 along the B1→B2 axis)
    //   z_predicted = H · x        (current state projected onto baseline)
    //   H = [ux, uy]               (1×2 observation matrix)
    const z_measured = t_clamped;
    const z_predicted = ux * (this._x - this._anchor1.x)
                      + uy * (this._y - this._anchor1.y);
    const innovation = z_measured - z_predicted;

    // ── Position-jump guard ────────────────────────────────────────────────
    // Physical sanity check: correct() is called on every BLE packet, so
    // the "implied speed" from the innovation should not exceed human running.
    let R = this._bleConfidenceToR(wTotal);

    // ── Short-baseline geometry penalty ─────────────────────────────────────
    // t_geom above divides by baselineLen, so RSSI-distance noise gets scaled
    // by roughly 1/baselineLen into position error. Inflating R by
    // (GOOD_BASELINE_FT / baselineLen)² approximately cancels that
    // amplification for beacons placed close together instead of at opposite
    // walls, so BLE doesn't inject the erratic swings a short baseline would
    // otherwise cause.
    if (baselineLen < this._cfg.GOOD_BASELINE_FT) {
      const geomPenalty = Math.min(
        this._cfg.MAX_BASELINE_PENALTY,
        (this._cfg.GOOD_BASELINE_FT / baselineLen) ** 2
      );
      R *= geomPenalty;
    }

    // ── Stationary gate ────────────────────────────────────────────────────
    // Standing still, the true position is not changing, so any position
    // change the filter makes is noise being rendered as movement. Inflating R
    // here shrinks the Kalman gain so BLE anchors the dot slowly rather than
    // jittering it every packet. It is not disabled: a genuinely wrong
    // position still converges, just smoothly.
    const isWalking = this._lastStepAt !== null
      && now - this._lastStepAt < this._cfg.STATIONARY_AFTER_MS;
    if (!isWalking) R *= this._cfg.STATIONARY_R_MULTIPLIER;

    if (this._lastCorrectionTime !== null) {
      const dtSec = (now - this._lastCorrectionTime) / 1000;
      if (dtSec > 0.05) {
        // Innovation in feet / elapsed seconds = implied lateral speed (ft/s)
        const impliedSpeed = Math.abs(innovation) / dtSec;
        if (impliedSpeed > this._cfg.JUMP_GUARD_SPEED_FPS) {
          R *= this._cfg.JUMP_GUARD_R_MULTIPLIER;
        }
      }
    }

    // ── Proper 1D EKF Update with H = [ux, uy] ───────────────────────────
    //
    // Innovation covariance:  S = H·P·Hᵀ + R  (scalar)
    //   S = ux²·Pxx + 2·ux·uy·Pxy + uy²·Pyy + R
    //
    // Kalman gain:  K = P·Hᵀ / S  (2×1 column vector)
    //   Kx = (ux·Pxx + uy·Pxy) / S
    //   Ky = (ux·Pxy + uy·Pyy) / S
    //
    // State update:  x = x + K · innovation
    // Covariance:    P = (I - K·H) · P
    //
    // This is the mathematically correct form for a 1D observation of a 2D state.
    // It only pulls the position in the DIRECTION we actually have information about.

    const S = ux * ux * this._pxx
            + 2 * ux * uy * this._pxy
            + uy * uy * this._pyy
            + R;

    if (S < 1e-9) return; // degenerate

    const Kx = (ux * this._pxx + uy * this._pxy) / S;
    const Ky = (ux * this._pxy + uy * this._pyy) / S;

    // State correction — moves position in the baseline direction only
    this._x += Kx * innovation;
    this._y += Ky * innovation;

    // Covariance update — Joseph form for numerical stability:
    // P_new = P - K·H·P
    //   ΔPxx = Kx·(ux·Pxx + uy·Pxy)
    //   ΔPyy = Ky·(ux·Pxy + uy·Pyy)
    //   ΔPxy = Kx·(ux·Pxy + uy·Pyy)  [or equivalently Ky*(ux*Pxx+uy*Pxy)]
    const dPxx = Kx * (ux * this._pxx + uy * this._pxy);
    const dPyy = Ky * (ux * this._pxy + uy * this._pyy);
    const dPxy = Kx * (ux * this._pxy + uy * this._pyy);

    this._pxx = Math.max(1e-6, this._pxx - dPxx);
    this._pyy = Math.max(1e-6, this._pyy - dPyy);
    this._pxy = this._pxy - dPxy;

    // ── Second observation: perpendicular offset from the baseline ─────────
    // Uses the information the along-baseline solve left on the table. Applied
    // as its own scalar EKF update with the geometry-derived noise above, so it
    // corrects PDR heading drift on the axis BLE was previously blind to,
    // without being trusted beyond what the geometry actually supports.
    if (this._cfg.ENABLE_PERPENDICULAR_FIX) {
      this._applyPerpendicularFix(d1, t_clamped, ux, uy, R);
    }

    // ── Carry and judge the alternate hypothesis ───────────────────────────
    // It gets the identical measurement and the identical update, then both are
    // scored on how well they explain the raw ranges. Scoring uses the full
    // ranges rather than the along-baseline projection alone, because the
    // projection is the one quantity the two hypotheses always agree on — it is
    // precisely the perpendicular component that tells them apart.
    if (this._alt) {
      this._updateAlongBaseline(this._alt, z_measured, ux, uy, R);
      this._scoreHypotheses(d1, d2);
      this._resolveAmbiguity();
    }

    // Soft-clamp to room bounds
    this._clampToRoom();

    // Sync corrected position back to PDR engine
    const newUncertainty = this._getUncertaintyRadius();
    pdrEngine.applyCorrection(this._x, this._y, newUncertainty);

    this._lastCorrectionTime = now;
    this._lastBleConf = Math.min(1.0, (w1 + w2) / 2);
    this._pushTrail(this._x, this._y);
  }

  // --------------------------------------------------------------------------
  // PASSIVE TICK — call from setInterval (1 Hz) for passive drift
  // --------------------------------------------------------------------------

  tick() {
    const now = Date.now();
    const dtSec = (now - this._lastTickTime) / 1000;
    this._lastTickTime = now;

    // Grow covariance passively while not stepping (sensor drift).
    // Scaled down when genuinely stationary: an unmoving position accumulates
    // far less true uncertainty than a walking one, and letting P grow as if it
    // did keeps the Kalman gain high, which is what lets BLE noise wander the
    // dot while the user stands.
    const isWalking = this._lastStepAt !== null
      && now - this._lastStepAt < this._cfg.STATIONARY_AFTER_MS;
    const qScale = isWalking ? 1.0 : this._cfg.STATIONARY_Q_SCALE;
    const Q_passive = this._cfg.Q_PASSIVE_FT2_PER_S * dtSec * qScale;
    this._pxx += Q_passive;
    this._pyy += Q_passive;

    // Cap covariance (prevents indefinite growth during long BLE dropout)
    const maxP = this._cfg.MAX_UNCERTAINTY_FT ** 2;
    this._pxx = Math.min(maxP, this._pxx);
    this._pyy = Math.min(maxP, this._pyy);

    pdrEngine.tickPassiveDrift(dtSec);
    this._lastPdrConf = pdrEngine.getConfidence();
  }

  // --------------------------------------------------------------------------
  // STATE ACCESSOR
  // --------------------------------------------------------------------------

  /**
   * Returns the current fused position and diagnostics for the UI (feet).
   * @returns {{
   *   x: number, y: number,
   *   uncertaintyRadius: number,
   *   bleConfidence: number,
   *   pdrConfidence: number,
   *   fusionWeightBle: number,
   *   fusionWeightPdr: number,
   *   stepCount: number,
   *   totalDistanceFt: number,
   *   trail: Array<{x, y}>
   * }}
   */
  getState() {
    const pdrState = pdrEngine.getState();
    const bleConf = this._lastBleConf;
    const pdrConf = this._lastPdrConf || pdrState.confidence;
    const total = bleConf + pdrConf + 0.001;
    const wBle = bleConf / total;
    const wPdr = pdrConf / total;

    return {
      x: Number(this._x.toFixed(2)),
      y: Number(this._y.toFixed(2)),
      uncertaintyRadius: this._getUncertaintyRadius(),
      bleConfidence: Number(bleConf.toFixed(3)),
      pdrConfidence: Number(pdrConf.toFixed(3)),
      fusionWeightBle: Number(wBle.toFixed(3)),
      fusionWeightPdr: Number(wPdr.toFixed(3)),
      stepCount: pdrState.stepCount,
      // Distance ACTUALLY WALKED: the sum of measured step lengths (odometry).
      // Deliberately NOT the length of the fused track, which also contains
      // BLE correction movement the user never made and would over-report.
      totalDistanceFt: pdrState.totalDistanceFt,
      // Straight-line distance from where tracking started. Together the two
      // describe the walk honestly: 144 ft walked with 0 ft net displacement
      // is a closed loop, not a stalled tracker.
      netDisplacementFt: Number(
        Math.hypot(this._x - this._startX, this._y - this._startY).toFixed(2)
      ),
      isWalking: this._lastStepAt !== null
        && Date.now() - this._lastStepAt < this._cfg.STATIONARY_AFTER_MS,
      // Surfaced so the map can show BOTH possibilities rather than presenting
      // a coin-flip as if it were a fix. It clears itself once resolved.
      positionAmbiguous: this._alt !== null,
      alternatePosition: this._alt
        ? { x: Number(this._alt.x.toFixed(2)), y: Number(this._alt.y.toFixed(2)) }
        : null,
      ambiguityLogOdds: this._alt
        ? Number((this._primaryLogLik - this._alt.logLik).toFixed(2))
        : null,
      ambiguityStale: Boolean(this._ambiguityStale),
      ambiguityResolution: this._lastAmbiguityResolution,
      trail: [...this._trail],
    };
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  /**
   * Converts total beacon confidence weight to EKF measurement noise R.
   * High confidence (near 2.0) → small R → strong BLE pull.
   * Low confidence (near 0.0) → large R → weak BLE pull, PDR dominates.
   *
   * @param {number} wTotal - Sum of confidence² weights for both beacons [0, 2]
   * @returns {number} Measurement noise variance R (ft²)
   */
  /**
   * Scalar EKF update along the axis PERPENDICULAR to the beacon baseline.
   *
   * Given the along-baseline coordinate t and the measured range d1, the
   * off-baseline distance is h = sqrt(d1² - t²). The sign is taken from the
   * current estimate, which is safe here because the beacons sit on a wall and
   * the whole walkable area is on one side of them — the filter is choosing
   * between "in the room" and "inside the wall".
   *
   * Conditioning: dh/dd1 = d1/h, so the same range error produces a much larger
   * error in h when h is small. The measurement noise is scaled by that factor
   * squared, which makes this update fade out automatically near the baseline
   * instead of injecting large errors exactly where it is least reliable.
   */
  _applyPerpendicularFix(d1, tAlong, ux, uy, baseR) {
    const hSq = d1 * d1 - tAlong * tAlong;
    if (!(hSq > 0)) return;
    const h = Math.sqrt(hSq);
    if (h < this._cfg.MIN_PERP_HEIGHT_FT) return; // too ill-conditioned to use

    // Perpendicular unit vector (left-hand normal of the baseline direction).
    const px = -uy;
    const py = ux;

    // Current estimate's perpendicular offset resolves the sign ambiguity.
    const perpPredicted = px * (this._x - this._anchor1.x)
                        + py * (this._y - this._anchor1.y);
    const sign = perpPredicted >= 0 ? 1 : -1;
    const perpMeasured = sign * h;
    const innovation = perpMeasured - perpPredicted;

    // Noise scaled by the geometric amplification factor (d1/h)².
    const amp = (d1 / h) ** 2;
    const R = Math.min(this._cfg.MAX_PERP_R_FT2, baseR * this._cfg.PERP_R_SCALE * amp);

    const S = px * px * this._pxx
            + 2 * px * py * this._pxy
            + py * py * this._pyy
            + R;
    if (S < 1e-9) return;

    const Kx = (px * this._pxx + py * this._pxy) / S;
    const Ky = (px * this._pxy + py * this._pyy) / S;

    this._x += Kx * innovation;
    this._y += Ky * innovation;

    const dPxx = Kx * (px * this._pxx + py * this._pxy);
    const dPyy = Ky * (px * this._pxy + py * this._pyy);
    const dPxy = Kx * (px * this._pxy + py * this._pyy);

    this._pxx = Math.max(1e-6, this._pxx - dPxx);
    this._pyy = Math.max(1e-6, this._pyy - dPyy);
    this._pxy = this._pxy - dPxy;
  }

  /**
   * The same scalar along-baseline EKF update used for the primary state,
   * applied to a hypothesis object. Kept as one implementation so the alternate
   * cannot silently drift from the primary's behaviour.
   */
  _updateAlongBaseline(h, zMeasured, ux, uy, R) {
    const zPredicted = ux * (h.x - this._anchor1.x) + uy * (h.y - this._anchor1.y);
    const innovation = zMeasured - zPredicted;

    const S = ux * ux * h.pxx + 2 * ux * uy * h.pxy + uy * uy * h.pyy + R;
    if (S < 1e-9) return;

    const Kx = (ux * h.pxx + uy * h.pxy) / S;
    const Ky = (ux * h.pxy + uy * h.pyy) / S;

    h.x += Kx * innovation;
    h.y += Ky * innovation;

    const dPxx = Kx * (ux * h.pxx + uy * h.pxy);
    const dPyy = Ky * (ux * h.pxy + uy * h.pyy);
    const dPxy = Kx * (ux * h.pxy + uy * h.pyy);

    h.pxx = Math.max(1e-6, h.pxx - dPxx);
    h.pyy = Math.max(1e-6, h.pyy - dPyy);
    h.pxy = h.pxy - dPxy;
  }

  /**
   * Accumulates evidence for each hypothesis from the raw ranges.
   *
   * Log-likelihood of a hypothesis under Gaussian range error is -(residual²)/2σ².
   * Evidence is accumulated with a decay so that a hypothesis is judged on
   * recent readings rather than being locked in by a stale early run of luck,
   * and so the comparison can recover if the user's situation changes.
   *
   * A systematic range bias (both beacons reading long) shifts both hypotheses'
   * residuals in the same direction, so it largely cancels in the DIFFERENCE
   * between their scores — which is the only thing used to decide.
   */
  _scoreHypotheses(d1, d2) {
    const sigma2 = this._cfg.AMBIGUITY_RANGE_SIGMA_FT ** 2;
    const decay = this._cfg.AMBIGUITY_EVIDENCE_DECAY;

    const scoreOf = (x, y) => {
      const r1 = Math.hypot(x - this._anchor1.x, y - this._anchor1.y);
      const r2 = Math.hypot(x - this._anchor2.x, y - this._anchor2.y);
      const e1 = d1 - r1;
      const e2 = d2 - r2;
      return -0.5 * (e1 * e1 + e2 * e2) / sigma2;
    };

    const w = this._cfg.OOB_DEBT_WEIGHT;
    this._primaryLogLik = this._primaryLogLik * decay
      + scoreOf(this._x, this._y) - w * (this._primaryOobDebt || 0);
    this._alt.logLik = this._alt.logLik * decay
      + scoreOf(this._alt.x, this._alt.y) - w * (this._alt.oobDebt || 0);
  }

  /**
   * Decides whether the mirror ambiguity can be closed.
   *
   * Three ways it ends, in order of strength:
   *   1. A hypothesis leaves the floor plan. The map is hard evidence — a
   *      person is not inside a wall — so this settles it outright.
   *   2. The accumulated log-odds exceed the threshold, meaning the ranges have
   *      clearly favoured one for long enough.
   *   3. A timeout: after this long the leader is taken regardless, because
   *      showing an unresolved pair indefinitely is less useful than committing
   *      to the better-supported one and letting later corrections fix it.
   */
  _resolveAmbiguity() {
    if (!this._alt) return;

    const room = (this._roomWidth && this._roomHeight)
      ? { width: this._roomWidth, height: this._roomHeight }
      : null;

    // Floor plan first: a hypothesis the map has had to shove back repeatedly
    // is not where the user is. Both are judged by the same rule.
    if (room) {
      const kill = this._cfg.OOB_DEBT_KILL_FT;
      const pDebt = this._primaryOobDebt || 0;
      const aDebt = this._alt.oobDebt || 0;
      if (aDebt > kill && pDebt <= kill) return this._collapseTo("primary", "alternate-kept-leaving-the-floor-plan");
      if (pDebt > kill && aDebt <= kill) return this._collapseTo("alternate", "primary-kept-leaving-the-floor-plan");
    }

    const margin = this._primaryLogLik - this._alt.logLik;
    if (Math.abs(margin) >= this._cfg.AMBIGUITY_LOG_ODDS_TO_RESOLVE) {
      return this._collapseTo(margin > 0 ? "primary" : "alternate", "ranges-favoured-one-position");
    }

    // No timed force-resolve. If the user has only ever moved parallel to the
    // beacon line, the two positions remain genuinely indistinguishable and
    // guessing would be wrong half the time. Flag it so the UI can ask for the
    // one thing that actually settles it: a few steps across that line.
    if (this._ambiguousSince !== null) {
      const elapsed = (Date.now() - this._ambiguousSince) / 1000;
      this._ambiguityStale = elapsed > this._cfg.AMBIGUITY_STALE_SECONDS;
    }
    return undefined;
  }

  _collapseTo(which, reason) {
    if (!this._alt) return;
    if (which === "alternate") {
      this._x = this._alt.x;
      this._y = this._alt.y;
      this._pxx = this._alt.pxx;
      this._pyy = this._alt.pyy;
      this._pxy = this._alt.pxy;
      this._primaryOobDebt = this._alt.oobDebt || 0;
      // The trail recorded so far belongs to the rejected hypothesis, so it is
      // not the path this user walked. Restart it from the accepted position
      // rather than drawing a jump between two different interpretations.
      this._trail = [{ x: Number(this._x.toFixed(2)), y: Number(this._y.toFixed(2)) }];
    }
    this._alt = null;
    this._primaryLogLik = 0;
    this._primaryOobDebt = 0;
    this._ambiguousSince = null;
    this._ambiguityStale = false;
    this._lastAmbiguityResolution = { which, reason, at: Date.now() };
  }

  _bleConfidenceToR(wTotal) {
    // Normalize to [0, 1] (both beacons at full confidence → wTotal = 2.0)
    const normalized = Math.min(1.0, wTotal / 2.0);
    // Interpolate R from BLE_R_MAX to BLE_R_MIN (feet²)
    const R = this._cfg.BLE_R_MAX_FT2 - normalized * (this._cfg.BLE_R_MAX_FT2 - this._cfg.BLE_R_MIN_FT2);
    return Math.max(this._cfg.BLE_R_MIN_FT2, R);
  }

  _getUncertaintyRadius() {
    // The 1-sigma uncertainty in position is √(trace(P)/2), in feet
    const sigma = Math.sqrt((this._pxx + this._pyy) / 2);
    return Number(Math.max(this._cfg.MIN_UNCERTAINTY_FT, Math.min(this._cfg.MAX_UNCERTAINTY_FT, sigma)).toFixed(2));
  }

  _clampToRoom() {
    const moved = this._clampPoint(this);
    this._primaryOobDebt = (this._primaryOobDebt || 0) * this._cfg.OOB_DEBT_DECAY + moved;
    if (this._alt) {
      const altMoved = this._clampPoint(this._alt);
      this._alt.oobDebt = (this._alt.oobDebt || 0) * this._cfg.OOB_DEBT_DECAY + altMoved;
    }
  }

  /**
   * Soft-clamps a point into the floor plan and returns how far it had to move.
   * That distance is the evidence: a position the map keeps having to push back
   * is a position the user is probably not standing in.
   */
  _clampPoint(h) {
    let moved = 0;
    if (this._roomWidth !== null) {
      if (h.x < 0) { moved += -h.x; h.x = 0; }
      else if (h.x > this._roomWidth) { moved += h.x - this._roomWidth; h.x = this._roomWidth; }
    }
    if (this._roomHeight !== null) {
      if (h.y < 0) { moved += -h.y; h.y = 0; }
      else if (h.y > this._roomHeight) { moved += h.y - this._roomHeight; h.y = this._roomHeight; }
    }
    return moved;
  }

  _pushTrail(x, y) {
    // Sample by real distance travelled, not per event. The threshold sits
    // above the residual BLE jitter, so correction noise no longer consumes
    // trail slots and push the walked route out of the buffer.
    const last = this._trail[this._trail.length - 1];
    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      const minMove = this._cfg.MIN_TRAIL_MOVE_FT;
      if (dx * dx + dy * dy < minMove * minMove) return;
    }
    this._trail.push({ x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) });
    if (this._trail.length > this._maxTrailLength) {
      this._trail.shift();
    }
  }
}

// Export a shared singleton — FusionMapScreen imports this directly.
export const fusionEngine = new FusionEngine();
