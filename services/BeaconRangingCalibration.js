// ============================================================================
// BEACON RANGING CALIBRATION — two-stand geometric calibration
// ============================================================================
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Two beacons of the same model, in the same room, report wildly different
// distances from the same spot — one says 8 m while the other says 24 m. That
// is not noise and no filter can remove it, because it is not a random error
// at all. The log-distance model
//
//     d = 10 ^ ((Tx1m − RSSI) / (10·n))
//
// has exactly two free parameters per beacon, and both of them are per-device
// physical constants that the app cannot know in advance:
//
//   Tx1m — the RSSI the phone sees at 1 m. Depends on the beacon's configured
//          output power (Moko units are settable from +4 down to −20 dBm, a
//          24 dB span), its antenna orientation, what it is stuck to (metal
//          and concrete detune it), and its battery level. A Δ dB error here
//          turns into a CONSTANT RATIO error in distance: 12 dB at n = 2.9 is
//          a factor of 2.6. This is why one beacon reads 3x the other.
//
//   n    — how fast the signal decays through THIS beacon's particular path.
//          A beacon across an open floor sees n ≈ 2.4; one behind a plaster
//          wall or a row of filing cabinets sees n ≈ 3.5. A wrong n does not
//          shift distance by a constant factor, it BENDS the curve, so the
//          error grows with range — which is precisely the regime an initial
//          position fix depends on.
//
// Both must be measured per beacon. That normally means a tape measure, a
// notebook, and several trips across the room.
//
// THE SHORTCUT
// ------------
// The app already knows where both beacons are: the user places them on the
// floor plan, so the baseline distance B between them is known exactly. That
// single known length is enough to calibrate both beacons from two stands and
// no measuring at all:
//
//   Stand A — stand at Beacon 1.   B1 is at NEAR_REF_M.  B2 is at B.
//   Stand B — stand at Beacon 2.   B2 is at NEAR_REF_M.  B1 is at B.
//
// Every stand yields a reading from BOTH beacons, so two stands give each
// beacon two reference points at two very different distances — exactly the
// two points needed to solve the two unknowns, with a long lever arm between
// them so the fit is well conditioned.
//
// The far point being the baseline is what makes this work without a tape
// measure, and it is also the honest one to use: it is measured through the
// real room, across the real obstacles, at the kind of range the system will
// actually be asked to work at.
//
// WHY THE NEAR POINT IS 1 m AND NOT 0 m
// -------------------------------------
// Standing with the phone touching the beacon puts the receiver into
// saturation, where RSSI stops responding to distance at all, and into the
// radiating near field, where the log-distance model does not hold. 1 m is
// far enough out for both to be true and close enough that essentially no
// obstruction or multipath is involved, so it isolates Tx1m cleanly.
//
// UNITS: the calibration solver and session work in metres throughout, matching
// PathLossCalibrator, so callers holding feet (the floor plan does) convert at
// the boundary. checkRangeGeometry at the bottom of this file is the exception:
// it is pure geometry, so it takes whichever unit the caller is already in.
// ============================================================================

export const RANGING_CALIB_CONFIG = {
  // Distance from the beacon the user stands at during its own stand.
  NEAR_REF_M: 1.0,

  // Below this baseline the two reference points are too close together in
  // log-distance for the slope to mean anything: with B = 2 m the lever arm is
  // 10·log10(2) = 3 dB, so 1 dB of measurement noise moves n by a third. At
  // B = 5 m the arm is 7 dB and at 10 m it is 10 dB.
  MIN_BASELINE_M: 3.0,

  // Sampling. TARGET is when the stand auto-completes; MIN is the fewest that
  // may be committed manually. A Moko beacon at a 300-400 ms advertising
  // interval produces roughly 3 packets a second, so 40 samples is about 13 s.
  MIN_SAMPLES_PER_BEACON: 12,
  TARGET_SAMPLES_PER_BEACON: 40,
  MAX_STAND_MS: 25000,

  // Packets arriving in the first moments of a stand are thrown away.
  //
  // The user has just walked across the room, so both beacons' Kalman filters
  // are still catching up from the previous spot and their shadow envelopes
  // are still holding peaks from it. Recording during that window does not add
  // noise, it adds BIAS - every sample is pulled toward the old location, and
  // for the beacon the user just walked away from that pull is the full swing
  // between 1 m and the baseline, tens of dB. Measured directly, a stand with
  // no settle window fitted an exponent of 1.9 where the truth was 3.0.
  //
  // Long enough to cover the outlier gate walking the rolling median across a
  // 30 dB step (about 2 s at a 350 ms advertising interval) with margin.
  SETTLE_MS: 4000,

  // Fraction trimmed from EACH end before averaging. RSSI during a still stand
  // is not Gaussian — it is a tight core with a one-sided tail of deep fades
  // whenever a person walks past or the user's own body swings between phone
  // and beacon. A plain mean is dragged down by that tail and a median throws
  // away most of the data; a symmetric trim keeps the core and discards both
  // tails. 0.2 leaves the middle 60%.
  TRIM_FRACTION: 0.2,

  // Plausible parameter ranges. A solve landing outside these is reported as
  // clamped rather than silently applied, because it nearly always means the
  // user was not standing where they thought they were.
  MIN_N: 1.8,
  MAX_N: 4.5,
  MIN_TX_1M: -85.0,
  MAX_TX_1M: -35.0,

  // Above this spread within a single stand the reading is too unsettled to
  // fit — usually someone walking around, or the stand was cut short.
  MAX_SIGMA_DB: 6.0,

  // Inter-beacon output-power difference above which we tell the user their
  // two beacons are not configured alike. Not an error — the calibration
  // handles it — but worth knowing, since it costs range on the weaker one.
  NOTABLE_TX_MISMATCH_DB: 6.0,
};

// ============================================================================
// Statistics helpers
// ============================================================================

/**
 * Symmetric trimmed mean. Returns null for an empty input.
 * @param {number[]} values
 * @param {number} trimFraction - removed from EACH end, 0 to 0.45
 */
export function trimmedMean(values, trimFraction = RANGING_CALIB_CONFIG.TRIM_FRACTION) {
  const clean = (values || []).filter((v) => Number.isFinite(v));
  if (clean.length === 0) return null;
  if (clean.length < 5) {
    return clean.reduce((a, b) => a + b, 0) / clean.length;
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const frac = Math.max(0, Math.min(0.45, trimFraction));
  const cut = Math.floor(sorted.length * frac);
  const kept = sorted.slice(cut, sorted.length - cut);
  const use = kept.length > 0 ? kept : sorted;
  return use.reduce((a, b) => a + b, 0) / use.length;
}

/** Population standard deviation. Returns 0 for fewer than 2 values. */
export function stdDev(values) {
  const clean = (values || []).filter((v) => Number.isFinite(v));
  if (clean.length < 2) return 0;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const varsum = clean.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return Math.sqrt(varsum / clean.length);
}

// ============================================================================
// The solve
// ============================================================================

/**
 * Solves Tx1m and n for one beacon from two (distance, RSSI) reference points.
 *
 * The log-distance model is linear in log-distance:
 *     RSSI(d) = Tx1m − 10·n·log10(d)
 * so with two points the slope gives n directly and either point then fixes
 * the intercept:
 *     n     = (RSSI_near − RSSI_far) / (10·log10(d_far / d_near))
 *     Tx1m  = RSSI_near + 10·n·log10(d_near)
 *
 * If n comes out beyond the plausible range it is clamped, and the intercept
 * is then chosen by least squares across BOTH points instead of pinned to the
 * near one. Pinning would honour the near reading exactly and push the entire
 * residual out to the far end, which is the end that matters for positioning.
 *
 * @param {number} nearRssi - dBm measured at nearM
 * @param {number} nearM    - metres (small)
 * @param {number} farRssi  - dBm measured at farM
 * @param {number} farM     - metres (large)
 * @returns {{ok: boolean, error?: string, n?: number, txPower1m?: number,
 *            nRaw?: number, clamped?: boolean, leverArmDb?: number,
 *            predictedFarRssi?: number, farResidualDb?: number}}
 */
export function solveTwoPoint(nearRssi, nearM, farRssi, farM) {
  if (![nearRssi, nearM, farRssi, farM].every(Number.isFinite)) {
    return { ok: false, error: "Non-numeric input" };
  }
  if (nearM <= 0 || farM <= 0) {
    return { ok: false, error: "Distances must be positive" };
  }
  if (farM <= nearM * 1.5) {
    return { ok: false, error: "The two reference distances are too close together" };
  }

  // Lever arm in dB of log-distance. Also the denominator of the slope, so it
  // is exactly the factor by which RSSI noise is divided down into n error.
  const leverArmDb = 10.0 * Math.log10(farM / nearM);

  const nRaw = (nearRssi - farRssi) / leverArmDb;
  const n = Math.max(RANGING_CALIB_CONFIG.MIN_N, Math.min(RANGING_CALIB_CONFIG.MAX_N, nRaw));
  const clamped = Math.abs(n - nRaw) > 1e-9;

  let txPower1m;
  if (!clamped) {
    // Exact fit through both points.
    txPower1m = nearRssi + 10.0 * n * Math.log10(nearM);
  } else {
    // n is fixed; place the line to minimise squared error over both points.
    const iNear = nearRssi + 10.0 * n * Math.log10(nearM);
    const iFar = farRssi + 10.0 * n * Math.log10(farM);
    txPower1m = (iNear + iFar) / 2.0;
  }
  txPower1m = Math.max(
    RANGING_CALIB_CONFIG.MIN_TX_1M,
    Math.min(RANGING_CALIB_CONFIG.MAX_TX_1M, txPower1m)
  );

  const predictedFarRssi = txPower1m - 10.0 * n * Math.log10(farM);

  return {
    ok: true,
    n: Number(n.toFixed(3)),
    nRaw: Number(nRaw.toFixed(3)),
    txPower1m: Number(txPower1m.toFixed(1)),
    clamped,
    leverArmDb: Number(leverArmDb.toFixed(2)),
    predictedFarRssi: Number(predictedFarRssi.toFixed(2)),
    farResidualDb: Number((farRssi - predictedFarRssi).toFixed(2)),
  };
}

/**
 * Distance an uncalibrated model would report, given a calibrated truth.
 * Used to show the user how much the calibration actually changed.
 */
export function distanceFromModel(rssi, txPower1m, n) {
  if (![rssi, txPower1m, n].every(Number.isFinite) || n <= 0) return null;
  return Math.pow(10, (txPower1m - rssi) / (10.0 * n));
}

// ============================================================================
// Session — accumulates the two stands
// ============================================================================

/**
 * Drives the two-stand procedure and holds its samples.
 *
 * Lifecycle:
 *     const s = new RangingCalibrationSession(baselineM);
 *     s.beginStand(1);                       // user is standing at Beacon 1
 *     s.addSample(1, rssi); s.addSample(2, rssi); ...
 *     s.commitStand();                       // stores trimmed means
 *     s.beginStand(2); ... s.commitStand();  // repeat at Beacon 2
 *     const result = s.solve();
 *
 * The session deliberately stores per-stand RAW sample arrays rather than a
 * running average, so a stand can be discarded and redone without disturbing
 * the other one — which matters, because a stand is easy to get wrong (phone
 * in a pocket, standing on the wrong side of a partition) and redoing a single
 * stand is far less annoying than redoing the whole procedure.
 */
export class RangingCalibrationSession {
  /**
   * @param {number} baselineM - straight-line distance between the two beacons
   */
  constructor(baselineM) {
    this.baselineM = Number.isFinite(baselineM) ? baselineM : null;
    this.nearRefM = RANGING_CALIB_CONFIG.NEAR_REF_M;
    // stands[k] = readings taken while the user stood at beacon k
    this.stands = { 1: null, 2: null };
    this.active = null; // { standAt, startedAt, samples: {1: [], 2: []} }
  }

  setBaseline(baselineM) {
    this.baselineM = Number.isFinite(baselineM) ? baselineM : null;
  }

  baselineIsUsable() {
    return (
      Number.isFinite(this.baselineM) &&
      this.baselineM >= RANGING_CALIB_CONFIG.MIN_BASELINE_M
    );
  }

  /** @param {1|2} standAt - which beacon the user is standing next to */
  beginStand(standAt) {
    if (standAt !== 1 && standAt !== 2) {
      return { ok: false, error: "standAt must be 1 or 2" };
    }
    if (!this.baselineIsUsable()) {
      return {
        ok: false,
        error: `Beacons must be at least ${RANGING_CALIB_CONFIG.MIN_BASELINE_M} m apart on the floor plan before calibrating.`,
      };
    }
    this.active = { standAt, startedAt: Date.now(), samples: { 1: [], 2: [] } };
    return { ok: true };
  }

  /**
   * @param {1|2} beaconNum - which beacon this reading came FROM
   * @param {number} rssi   - the level ranging consumes (rangingRssi), dBm
   */
  addSample(beaconNum, rssi, timestamp = Date.now()) {
    if (!this.active) return false;
    if (beaconNum !== 1 && beaconNum !== 2) return false;
    if (!Number.isFinite(rssi) || rssi < -120 || rssi > 0) return false;
    // Settling window - see SETTLE_MS.
    if (timestamp - this.active.startedAt < RANGING_CALIB_CONFIG.SETTLE_MS) return false;
    this.active.samples[beaconNum].push(rssi);
    return true;
  }

  /** True while the stand is still discarding samples to let the filters settle. */
  isSettling(now = Date.now()) {
    if (!this.active) return false;
    return now - this.active.startedAt < RANGING_CALIB_CONFIG.SETTLE_MS;
  }

  /**
   * Progress of the stand in [0, 1], limited by whichever beacon is behind.
   * The far beacon is always the slower one — it is weaker, so more of its
   * packets fail CRC and never reach the app — and the stand is only as good
   * as its weakest half, so it must gate completion.
   */
  standProgress() {
    if (!this.active) return { progress: 0, counts: { 1: 0, 2: 0 }, done: false, elapsedMs: 0 };
    const c1 = this.active.samples[1].length;
    const c2 = this.active.samples[2].length;
    const target = RANGING_CALIB_CONFIG.TARGET_SAMPLES_PER_BEACON;
    const elapsedMs = Date.now() - this.active.startedAt;
    const settling = elapsedMs < RANGING_CALIB_CONFIG.SETTLE_MS;
    const progress = Math.max(0, Math.min(1, Math.min(c1, c2) / target));
    const enough = Math.min(c1, c2) >= RANGING_CALIB_CONFIG.MIN_SAMPLES_PER_BEACON;
    return {
      progress,
      settling,
      counts: { 1: c1, 2: c2 },
      // Complete on either a full sample count or the time limit, but never
      // before the minimum — a time-out with too few samples is a failure, not
      // a completion, and the caller must be able to tell the difference.
      done: !settling && (progress >= 1 || (elapsedMs >= RANGING_CALIB_CONFIG.MAX_STAND_MS && enough)),
      timedOut: elapsedMs >= RANGING_CALIB_CONFIG.MAX_STAND_MS + RANGING_CALIB_CONFIG.SETTLE_MS && !enough,
      enough,
      elapsedMs,
    };
  }

  /** Stores the active stand's trimmed means. Does not solve. */
  commitStand() {
    if (!this.active) return { ok: false, error: "No stand in progress" };
    const { standAt, samples } = this.active;
    const minSamples = RANGING_CALIB_CONFIG.MIN_SAMPLES_PER_BEACON;
    if (samples[1].length < minSamples || samples[2].length < minSamples) {
      return {
        ok: false,
        error:
          `Need ${minSamples} packets from each beacon (got B1 ${samples[1].length}, ` +
          `B2 ${samples[2].length}). Move so both beacons are in clear view and retry.`,
      };
    }
    const record = {
      standAt,
      at: Date.now(),
      rssi: { 1: trimmedMean(samples[1]), 2: trimmedMean(samples[2]) },
      sigma: { 1: stdDev(samples[1]), 2: stdDev(samples[2]) },
      counts: { 1: samples[1].length, 2: samples[2].length },
    };
    this.stands[standAt] = record;
    this.active = null;
    return { ok: true, stand: record };
  }

  cancelStand() {
    this.active = null;
  }

  clearStand(standAt) {
    if (standAt === 1 || standAt === 2) this.stands[standAt] = null;
  }

  isComplete() {
    return Boolean(this.stands[1] && this.stands[2]);
  }

  reset() {
    this.stands = { 1: null, 2: null };
    this.active = null;
  }

  /**
   * Solves both beacons from the two committed stands.
   *
   * @returns {{ok: boolean, error?: string, baselineM?: number,
   *            beacons?: {1: object, 2: object}, warnings?: string[]}}
   */
  solve() {
    if (!this.isComplete()) {
      return { ok: false, error: "Both stands must be completed first." };
    }
    if (!this.baselineIsUsable()) {
      return { ok: false, error: "Beacon separation is too small to calibrate against." };
    }

    const standA = this.stands[1]; // stood at beacon 1
    const standB = this.stands[2]; // stood at beacon 2
    const near = this.nearRefM;
    const far = this.baselineM;
    const warnings = [];

    // Beacon 1: near reading comes from standing at it, far from standing at 2.
    const b1 = solveTwoPoint(standA.rssi[1], near, standB.rssi[1], far);
    // Beacon 2: mirror image.
    const b2 = solveTwoPoint(standB.rssi[2], near, standA.rssi[2], far);

    if (!b1.ok) return { ok: false, error: `Beacon 1: ${b1.error}` };
    if (!b2.ok) return { ok: false, error: `Beacon 2: ${b2.error}` };

    const maxSigma = RANGING_CALIB_CONFIG.MAX_SIGMA_DB;
    for (const [label, stand] of [["at Beacon 1", standA], ["at Beacon 2", standB]]) {
      for (const k of [1, 2]) {
        if (stand.sigma[k] > maxSigma) {
          warnings.push(
            `Beacon ${k} was unsteady during the stand ${label} ` +
              `(±${stand.sigma[k].toFixed(1)} dB). Stand still, hold the phone at chest ` +
              `height and keep your body out of the line to the beacon.`
          );
        }
      }
    }

    // A clamped exponent nearly always means the geometry was not what the
    // procedure assumed, so say so rather than quietly applying a bad fit.
    if (b1.clamped) {
      warnings.push(
        `Beacon 1 fitted an implausible decay (n = ${b1.nRaw}, clamped to ${b1.n}). ` +
          `Check that Beacon 1 is on the floor plan where it physically is.`
      );
    }
    if (b2.clamped) {
      warnings.push(
        `Beacon 2 fitted an implausible decay (n = ${b2.nRaw}, clamped to ${b2.n}). ` +
          `Check that Beacon 2 is on the floor plan where it physically is.`
      );
    }

    const txGap = Math.abs(b1.txPower1m - b2.txPower1m);
    if (txGap >= RANGING_CALIB_CONFIG.NOTABLE_TX_MISMATCH_DB) {
      const weaker = b1.txPower1m < b2.txPower1m ? 1 : 2;
      warnings.push(
        `The two beacons transmit ${txGap.toFixed(0)} dB apart — Beacon ${weaker} is much ` +
          `weaker. Calibration corrects the distance error this caused, but the weaker ` +
          `beacon will still be noisier at range. Raising its output power in the Moko ` +
          `app would improve accuracy further.`
      );
    }

    // How far off the previous (uncalibrated) model was at the baseline. This
    // is the number that tells the user whether calibrating was worth it.
    const before = {
      1: distanceFromModel(standB.rssi[1], -59.0, 2.9),
      2: distanceFromModel(standA.rssi[2], -59.0, 2.9),
    };

    return {
      ok: true,
      baselineM: far,
      nearRefM: near,
      beacons: {
        1: { ...b1, nearRssi: standA.rssi[1], farRssi: standB.rssi[1], uncalibratedFarM: before[1] },
        2: { ...b2, nearRssi: standB.rssi[2], farRssi: standA.rssi[2], uncalibratedFarM: before[2] },
      },
      txMismatchDb: Number(txGap.toFixed(1)),
      warnings,
    };
  }
}

// ============================================================================
// Geometric health check — runs continuously, needs no calibration
// ============================================================================

/**
 * Checks a live pair of ranges against the one thing that is known exactly:
 * the distance between the two beacons.
 *
 * Wherever the user stands, the triangle inequality must hold:
 *
 *     |d1 − d2|  ≤  B  ≤  d1 + d2
 *
 * and additionally neither range may exceed the room's own diagonal. These
 * are not statistical tests — they are geometry, so a violation is proof of a
 * calibration fault rather than evidence of one, which makes this the only
 * self-check available that cannot produce a false alarm from noise alone
 * (beyond the tolerance allowed for genuine measurement error).
 *
 * Which way it fails is diagnostic:
 *   d1 + d2 < B      both ranges read SHORT  (Tx too low, or n too high)
 *   |d1 − d2| > B    the two disagree by more than the room allows, so at
 *                    least one has the wrong Tx — the classic symptom of two
 *                    beacons at different output powers
 *   either > diagonal  that range is longer than the building
 *
 * UNITS: unit-agnostic. Every length argument must be in the SAME unit, and
 * the returned lengths come back in it. Callers pass metres from the Signal
 * Lab and feet from the Fusion Map, so `unit` only labels the messages.
 *
 * @param {number} d1
 * @param {number} d2
 * @param {number} baseline - known beacon separation
 * @param {number|null} roomDiagonal - optional
 * @param {number} tolerance - slack for honest measurement error
 * @param {string} unit - label used in the generated messages
 */
export function checkRangeGeometry(d1, d2, baseline, roomDiagonal = null, tolerance = 2.0, unit = "m") {
  if (![d1, d2, baseline].every(Number.isFinite) || baseline <= 0) {
    return { ok: true, status: "unknown", issues: [] };
  }
  const issues = [];
  const sum = d1 + d2;
  const diff = Math.abs(d1 - d2);
  const u = " " + unit;

  if (sum < baseline - tolerance) {
    issues.push({
      kind: "both-short",
      severity: Number((baseline - sum).toFixed(2)),
      message:
        `Both ranges together (${sum.toFixed(1)}${u}) are shorter than the gap between the ` +
        `beacons (${baseline.toFixed(1)}${u}), which is geometrically impossible. ` +
        `Run ranging calibration.`,
    });
  }
  if (diff > baseline + tolerance) {
    const suspect = d1 > d2 ? 1 : 2;
    issues.push({
      kind: "tx-mismatch",
      severity: Number((diff - baseline).toFixed(2)),
      suspectBeacon: suspect,
      message:
        `The two ranges differ by ${diff.toFixed(1)}${u}, more than the ${baseline.toFixed(1)}${u} ` +
        `between the beacons allows. Beacon ${suspect} is reading far too long — its 1 m ` +
        `reference is wrong. Run ranging calibration.`,
    });
  }
  if (Number.isFinite(roomDiagonal) && roomDiagonal > 0) {
    for (const [i, d] of [[1, d1], [2, d2]]) {
      if (d > roomDiagonal + tolerance) {
        issues.push({
          kind: "beyond-room",
          suspectBeacon: i,
          severity: Number((d - roomDiagonal).toFixed(2)),
          message:
            `Beacon ${i} reports ${d.toFixed(1)}${u}, further than the room's own diagonal ` +
            `(${roomDiagonal.toFixed(1)}${u}). Run ranging calibration.`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? "consistent" : issues[0].kind,
    sum: Number(sum.toFixed(2)),
    diff: Number(diff.toFixed(2)),
    baseline: Number(baseline.toFixed(2)),
    unit,
    issues,
  };
}
