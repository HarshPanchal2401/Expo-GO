// ============================================================================
// TWO-BEACON INDOOR POSITIONING SERVICES
// All positioning math lives here. Completely isolated from existing PDR/BLE.
// ============================================================================

import { OneEuroFilter } from "./BleScannerService.js";
import { getAppSettings } from "./appSettingsStorage.js";

// ============================================================================
// ROOM CONSTANTS
// ============================================================================
export const ROOM_WIDTH_FT  = 18;  // X: 0 → 18 ft
export const ROOM_HEIGHT_FT = 15;  // Y: 0 → 15 ft

// ============================================================================
// COORDINATE CONVERTER  (feet ↔ screen pixels)
// ============================================================================
export function feetToScreen(realX, realY, mapPixelWidth, mapPixelHeight, roomW = ROOM_WIDTH_FT, roomH = ROOM_HEIGHT_FT) {
  const safeRoomW = (typeof roomW === "number" && isFinite(roomW) && roomW > 0) ? roomW : ROOM_WIDTH_FT;
  const safeRoomH = (typeof roomH === "number" && isFinite(roomH) && roomH > 0) ? roomH : ROOM_HEIGHT_FT;
  const safeW = (typeof mapPixelWidth === "number" && isFinite(mapPixelWidth) && mapPixelWidth > 0) ? mapPixelWidth : 300;
  const safeH = (typeof mapPixelHeight === "number" && isFinite(mapPixelHeight) && mapPixelHeight > 0) ? mapPixelHeight : 250;
  const safeX = (typeof realX === "number" && isFinite(realX)) ? realX : safeRoomW / 2;
  const safeY = (typeof realY === "number" && isFinite(realY)) ? realY : safeRoomH / 2;
  return {
    sx: (safeX / safeRoomW) * safeW,
    sy: safeH - (safeY / safeRoomH) * safeH,
  };
}

export function screenToFeet(sx, sy, mapPixelWidth, mapPixelHeight, roomW = ROOM_WIDTH_FT, roomH = ROOM_HEIGHT_FT) {
  const safeRoomW = (typeof roomW === "number" && isFinite(roomW) && roomW > 0) ? roomW : ROOM_WIDTH_FT;
  const safeRoomH = (typeof roomH === "number" && isFinite(roomH) && roomH > 0) ? roomH : ROOM_HEIGHT_FT;
  const safeW = (typeof mapPixelWidth === "number" && isFinite(mapPixelWidth) && mapPixelWidth > 0) ? mapPixelWidth : 300;
  const safeH = (typeof mapPixelHeight === "number" && isFinite(mapPixelHeight) && mapPixelHeight > 0) ? mapPixelHeight : 250;
  const safeSX = (typeof sx === "number" && isFinite(sx)) ? sx : 0;
  const safeSY = (typeof sy === "number" && isFinite(sy)) ? sy : 0;
  return {
    realX: (safeSX / safeW) * safeRoomW,
    realY: ((safeH - safeSY) / safeH) * safeRoomH,
  };
}

export function clampToRoom(x, y, roomW = ROOM_WIDTH_FT, roomH = ROOM_HEIGHT_FT) {
  const safeRoomW = (typeof roomW === "number" && isFinite(roomW) && roomW > 0) ? roomW : ROOM_WIDTH_FT;
  const safeRoomH = (typeof roomH === "number" && isFinite(roomH) && roomH > 0) ? roomH : ROOM_HEIGHT_FT;
  const safeX = (typeof x === "number" && isFinite(x)) ? x : safeRoomW / 2;
  const safeY = (typeof y === "number" && isFinite(y)) ? y : safeRoomH / 2;
  return {
    x: Math.max(0, Math.min(safeRoomW, safeX)),
    y: Math.max(0, Math.min(safeRoomH, safeY)),
  };
}

// ============================================================================
// RSSI FILTER PIPELINE (per-beacon)
// Multi-stage filtering: Outlier rejection -> Rolling Median -> One-Euro Filter -> Asymmetric EMA
// ============================================================================
const RSSI_BUFFER_SIZE = 7;      // rolling sample buffer for median
const RSSI_MIN = -105;          // reject impossible low
const RSSI_MAX = -5;            // reject impossible high (close contact can reach -8 to -14 dBm)

export class RssiFilterPipeline {
  constructor() {
    this.buffer          = [];
    // Ultra-smooth OneEuroFilter: low minCutoff (0.20) eliminates jitter when stationary, beta (0.05) tracks motion
    this.oneEuro         = new OneEuroFilter(0.20, 0.05);
    this.rawRssi         = null;
    this.filteredRssi    = null;
    this.smoothedDistance= null;
    this.lastSeen        = null;
  }

  addPacket(rawRssi, timestamp = Date.now()) {
    if (typeof rawRssi !== "number" || isNaN(rawRssi)) return false;
    if (rawRssi < RSSI_MIN || rawRssi > RSSI_MAX) return false;  // outlier reject

    this.rawRssi  = rawRssi;
    this.lastSeen = timestamp;

    // Rolling buffer
    this.buffer.push(rawRssi);
    if (this.buffer.length > RSSI_BUFFER_SIZE) this.buffer.shift();

    // 1. Median filter to strip impulse spikes & channel hopping anomalies
    const sorted = [...this.buffer].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // 2. One-Euro filter on top of median for sub-dBm smooth progression
    const smoothVal = this.oneEuro.filter(median, timestamp);
    
    // 3. Asymmetric EMA blending:
    // When signal weakens (drop in dBm / body blockage), filter more heavily to prevent false jumps.
    // When signal strengthens (approaching), respond more quickly.
    if (this.filteredRssi === null) {
      this.filteredRssi = smoothVal;
    } else {
      const alpha = smoothVal > this.filteredRssi ? 0.35 : 0.20;
      this.filteredRssi = alpha * smoothVal + (1 - alpha) * this.filteredRssi;
    }

    return true;
  }

  getState() {
    return {
      rawRssi:      this.rawRssi,
      // Retain continuous floating point precision for distance calculation, rounded for UI display
      filteredRssi: this.filteredRssi !== null ? Number(this.filteredRssi.toFixed(2)) : null,
      lastSeen:     this.lastSeen,
    };
  }

  reset() {
    this.buffer          = [];
    this.oneEuro         = new OneEuroFilter(0.20, 0.05);
    this.rawRssi         = null;
    this.filteredRssi    = null;
    this.smoothedDistance= null;
    this.lastSeen        = null;
  }

  // Collect calibration samples for N ms, return median RSSI
  async collectCalibration(durationMs = 3000, onProgress) {
    return new Promise(resolve => {
      const samples = [];
      const start   = Date.now();
      const interval = setInterval(() => {
        if (this.rawRssi !== null) samples.push(this.rawRssi);
        const elapsed = Date.now() - start;
        if (onProgress) onProgress(elapsed / durationMs);
        if (elapsed >= durationMs) {
          clearInterval(interval);
          if (samples.length === 0) { resolve(null); return; }
          const sorted = [...samples].sort((a, b) => a - b);
          resolve(sorted[Math.floor(sorted.length / 2)]);
        }
      }, 100);
    });
  }
}

// ============================================================================
// RSSI → DISTANCE  (smooth path-loss model with kinematic limits, returns feet)
// ============================================================================
export function rssiToDistance(filteredRssi, txPower, n, prevDistFt = null) {
  if (filteredRssi === null || filteredRssi === 0 || isNaN(filteredRssi)) return null;
  const settings = getAppSettings();
  const satRssi = settings.nearFieldSaturationRssi ?? -43;

  const ratio    = (txPower - filteredRssi) / (10 * Math.max(1.0, n));
  let meters     = Math.pow(10, ratio);

  // Near-field saturation correction: scale smoothly to 0 when touching beacon antenna
  if (settings.enableNearFieldCurve && filteredRssi >= -50) {
    if (filteredRssi >= satRssi) {
      meters = 0.0;
    } else {
      const span = satRssi - (-50);
      const progress = Math.max(0, Math.min(1, (filteredRssi - (-50)) / span));
      meters = meters * Math.pow(1 - progress, 1.4);
    }
  }

  const rawFeet  = meters * 3.28084;
  if (!isFinite(rawFeet) || rawFeet < 0) return null;

  // If previous distance exists, apply kinematic rate-limiting and smooth blending
  if (prevDistFt !== null && prevDistFt > 0) {
    const diff = rawFeet - prevDistFt;
    const absDiff = Math.abs(diff);

    // Max plausible walking displacement in a 100ms cycle (~0.6 ft per tick = ~6 ft/s)
    const maxChangePerTick = 0.60;
    const clampedFeet = prevDistFt + Math.sign(diff) * Math.min(absDiff, maxChangePerTick);

    // Progressive easing
    const alpha = absDiff > 2.0 ? 0.30 : 0.18;
    return Number((alpha * clampedFeet + (1 - alpha) * prevDistFt).toFixed(2));
  }

  return Number(rawFeet.toFixed(2));
}

// ============================================================================
// HEIGHT CORRECTION  (slant → horizontal distance, in same units)
// ============================================================================
export function applyHeightCorrection(slantDist, beaconHeightFt, phoneHeightFt) {
  if (slantDist === null || isNaN(slantDist)) return { correctedDist: null, heightValidity: 0 };
  const vertDiff = Math.abs(beaconHeightFt - phoneHeightFt);
  const slantSq  = slantDist * slantDist;
  const vertSq   = vertDiff  * vertDiff;

  if (slantDist < vertDiff) {
    // Physically inconsistent reading
    return { correctedDist: 0.1, heightValidity: 0.1 };
  }
  const horizontal = Math.sqrt(Math.max(0, slantSq - vertSq));
  const validity   = Math.min(1, slantDist / Math.max(1, vertDiff + 1));
  return { correctedDist: horizontal, heightValidity: validity };
}

// ============================================================================
// RSSI STABILITY SCORE  (based on std-dev of recent raw RSSI values)
// ============================================================================
function stabilityScore(rssiBuffer) {
  if (!rssiBuffer || rssiBuffer.length < 2) return 0.5;
  const mean = rssiBuffer.reduce((s, v) => s + v, 0) / rssiBuffer.length;
  const variance = rssiBuffer.reduce((s, v) => s + (v - mean) ** 2, 0) / rssiBuffer.length;
  const stdDev = Math.sqrt(variance);
  // stdDev < 2 → excellent, > 10 → very noisy
  return Math.max(0, Math.min(1, 1 - (stdDev / 10)));
}

// ============================================================================
// WEIGHTING ENGINE
// ============================================================================
const WEIGHT_COEFFICIENTS = {
  stability:         0.30,
  strength:          0.20,
  freshness:         0.15,
  distance:          0.15,
  motionConsistency: 0.15,
  heightValidity:    0.05,
};

export function computeWeight({
  rssiBuffer,          // recent raw RSSI history array
  filteredRssi,        // latest filtered RSSI (dBm)
  lastSeenMs,          // ms since last packet
  distanceFt,          // estimated horizontal distance in ft
  prevDistanceFt,      // previous distance estimate
  prevPosition,        // { x, y }
  blePosition,         // { x, y } — raw BLE estimate
  heightValidity = 1,  // 0..1 from height correction
  heightCorrectionOn = false,
}) {
  // 1. Stability
  const stab = stabilityScore(rssiBuffer);

  // 2. Strength
  let strength;
  if      (filteredRssi > -60)  strength = 1.0;
  else if (filteredRssi > -70)  strength = 0.75;
  else if (filteredRssi > -80)  strength = 0.45;
  else if (filteredRssi > -88)  strength = 0.20;
  else                          strength = 0.05;

  // 3. Freshness
  let fresh;
  if      (lastSeenMs < 200)    fresh = 1.0;
  else if (lastSeenMs < 500)    fresh = 0.75;
  else if (lastSeenMs < 1000)   fresh = 0.40;
  else if (lastSeenMs < 2000)   fresh = 0.15;
  else                          fresh = 0.0;

  // 4. Distance reliability (penalise very large estimates)
  let distScore;
  if      (distanceFt === null) distScore = 0;
  else if (distanceFt < 5)      distScore = 1.0;
  else if (distanceFt < 10)     distScore = 0.75;
  else if (distanceFt < 18)     distScore = 0.45;
  else                          distScore = 0.15;

  // 5. Motion consistency
  let motionScore = 0.5;  // default neutral
  if (prevPosition && blePosition) {
    const jumpDist = Math.hypot(
      blePosition.x - prevPosition.x,
      blePosition.y - prevPosition.y,
    );
    // If position jumps > 5 ft in < 1 update cycle → likely noise
    if      (jumpDist < 1)   motionScore = 1.0;
    else if (jumpDist < 2.5) motionScore = 0.75;
    else if (jumpDist < 5)   motionScore = 0.45;
    else                     motionScore = 0.1;
  }

  // 6. Height validity (only matters when height correction is ON)
  const hv = heightCorrectionOn ? heightValidity : 1.0;

  const c = WEIGHT_COEFFICIENTS;
  let weight =
    c.stability         * stab        +
    c.strength          * strength    +
    c.freshness         * fresh       +
    c.distance          * distScore   +
    c.motionConsistency * motionScore +
    c.heightValidity    * hv;

  if (!heightCorrectionOn) {
    // Redistribute height coefficient to stability when not used
    weight += c.heightValidity * stab;
    weight = Math.min(1, weight);
  }

  return Math.max(0, Math.min(1, weight));
}

// ============================================================================
// TWO-BEACON POSITION SOLVER
// Fast analytical circle intersection + weighted least-squares refinement
// ============================================================================
export function solveTwoBeaconPosition(b1, b2, d1, d2, w1 = 0.5, w2 = 0.5, prevX = 9, prevY = 7.5, roomW = ROOM_WIDTH_FT, roomH = ROOM_HEIGHT_FT) {
  // b1/b2 = { x, y } in feet
  // d1/d2 = estimated distances to B1/B2 in feet
  // w1/w2 = weights 0..1
  const safeRoomW = (typeof roomW === "number" && isFinite(roomW) && roomW > 0) ? roomW : ROOM_WIDTH_FT;
  const safeRoomH = (typeof roomH === "number" && isFinite(roomH) && roomH > 0) ? roomH : ROOM_HEIGHT_FT;

  const safePrevX = (typeof prevX === "number" && isFinite(prevX)) ? prevX : safeRoomW / 2;
  const safePrevY = (typeof prevY === "number" && isFinite(prevY)) ? prevY : safeRoomH / 2;
  const safeB1 = {
    x: (typeof b1?.x === "number" && isFinite(b1.x)) ? b1.x : 0,
    y: (typeof b1?.y === "number" && isFinite(b1.y)) ? b1.y : safeRoomH,
  };
  const safeB2 = {
    x: (typeof b2?.x === "number" && isFinite(b2.x)) ? b2.x : safeRoomW,
    y: (typeof b2?.y === "number" && isFinite(b2.y)) ? b2.y : safeRoomH,
  };

  const validD1 = typeof d1 === "number" && isFinite(d1) && d1 > 0;
  const validD2 = typeof d2 === "number" && isFinite(d2) && d2 > 0;

  if (!validD1 && !validD2) {
    return { x: safePrevX, y: safePrevY, confidence: 0 };
  }

  const safeW1 = validD1 ? Math.max(0, (typeof w1 === "number" && isFinite(w1) ? w1 : 0.5)) : 0;
  const safeW2 = validD2 ? Math.max(0, (typeof w2 === "number" && isFinite(w2) ? w2 : 0.5)) : 0;
  const totalW = safeW1 + safeW2;

  if (totalW === 0) return { x: safePrevX, y: safePrevY, confidence: 0 };

  // If only one beacon available — constrain along its circle, biased to prev position
  if (!validD1 || safeW1 < 0.05) return _oneBeaconEstimate(safeB2, d2, safePrevX, safePrevY, safeRoomW, safeRoomH);
  if (!validD2 || safeW2 < 0.05) return _oneBeaconEstimate(safeB1, d1, safePrevX, safePrevY, safeRoomW, safeRoomH);

  // Both beacons available — analytical 2-circle intersection
  const dx = safeB2.x - safeB1.x;
  const dy = safeB2.y - safeB1.y;
  const D = Math.hypot(dx, dy);

  let candidateX = safePrevX;
  let candidateY = safePrevY;

  if (D > 0.1) {
    const ux = dx / D;
    const uy = dy / D;

    // Baseline projection distance from B1
    let a = (d1 * d1 - d2 * d2 + D * D) / (2 * D);
    // Clamp 'a' to reasonable bounds between beacons
    if (d1 + d2 < D) {
      // Circles too small to touch — take proportional point along baseline
      a = (d1 / (d1 + d2)) * D;
    } else if (Math.abs(d1 - d2) > D) {
      // One circle inside another
      a = d1 < d2 ? d1 : D - d2;
    }

    const hSq = d1 * d1 - a * a;
    const p0x = safeB1.x + a * ux;
    const p0y = safeB1.y + a * uy;

    if (hSq > 0) {
      const h = Math.sqrt(hSq);
      // Two possible intersection points (perpendicular to baseline)
      const p1x = p0x - h * uy;
      const p1y = p0y + h * ux;
      const p2x = p0x + h * uy;
      const p2y = p0y - h * ux;

      // Pick the point inside the room [0..roomW, 0..roomH] or closest to previous / room center
      const p1In = p1x >= -0.5 && p1x <= safeRoomW + 0.5 && p1y >= -0.5 && p1y <= safeRoomH + 0.5;
      const p2In = p2x >= -0.5 && p2x <= safeRoomW + 0.5 && p2y >= -0.5 && p2y <= safeRoomH + 0.5;

      if (p1In && !p2In) {
        candidateX = p1x; candidateY = p1y;
      } else if (p2In && !p1In) {
        candidateX = p2x; candidateY = p2y;
      } else {
        // Both in or both out — choose closest to previous position
        const dist1 = Math.hypot(p1x - safePrevX, p1y - safePrevY);
        const dist2 = Math.hypot(p2x - safePrevX, p2y - safePrevY);
        if (dist1 <= dist2) {
          candidateX = p1x; candidateY = p1y;
        } else {
          candidateX = p2x; candidateY = p2y;
        }
      }
    } else {
      // Midpoint on baseline
      candidateX = p0x;
      candidateY = p0y;
    }
  }

  // Continuous weighted refinement: if beacon weights differ, shift smoothly toward more confident circle
  if (totalW > 0 && Math.abs(safeW1 - safeW2) > 0.10) {
    const wRatio = safeW1 / totalW;
    const curD1 = Math.hypot(candidateX - safeB1.x, candidateY - safeB1.y);
    const curD2 = Math.hypot(candidateX - safeB2.x, candidateY - safeB2.y);
    const res1 = d1 - curD1;
    const res2 = d2 - curD2;
    if (curD1 > 0.1 && curD2 > 0.1) {
      const u1x = (candidateX - safeB1.x) / curD1;
      const u1y = (candidateY - safeB1.y) / curD1;
      const u2x = (candidateX - safeB2.x) / curD2;
      const u2y = (candidateY - safeB2.y) / curD2;
      candidateX += 0.20 * (wRatio * res1 * u1x + (1 - wRatio) * res2 * u2x);
      candidateY += 0.20 * (wRatio * res1 * u1y + (1 - wRatio) * res2 * u2y);
    }
  }

  const finalX = isFinite(candidateX) ? candidateX : safePrevX;
  const finalY = isFinite(candidateY) ? candidateY : safePrevY;
  const clamped = clampToRoom(finalX, finalY, safeRoomW, safeRoomH);
  const curD1 = Math.hypot(clamped.x - safeB1.x, clamped.y - safeB1.y);
  const curD2 = Math.hypot(clamped.x - safeB2.x, clamped.y - safeB2.y);
  const totalErr = Math.sqrt((safeW1 * (curD1 - d1) ** 2 + safeW2 * (curD2 - d2) ** 2) / Math.max(0.01, totalW));
  const rawConf = 1 - totalErr / 12;
  const confidence = isFinite(rawConf) ? Math.max(0.2, Math.min(1.0, rawConf)) : 0.5;

  return { x: clamped.x, y: clamped.y, confidence };
}

function _oneBeaconEstimate(beacon, dist, prevX, prevY, roomW = ROOM_WIDTH_FT, roomH = ROOM_HEIGHT_FT) {
  const safeRoomW = (typeof roomW === "number" && isFinite(roomW) && roomW > 0) ? roomW : ROOM_WIDTH_FT;
  const safeRoomH = (typeof roomH === "number" && isFinite(roomH) && roomH > 0) ? roomH : ROOM_HEIGHT_FT;
  const safePrevX = (typeof prevX === "number" && isFinite(prevX)) ? prevX : safeRoomW / 2;
  const safePrevY = (typeof prevY === "number" && isFinite(prevY)) ? prevY : safeRoomH / 2;
  const safeB = {
    x: (typeof beacon?.x === "number" && isFinite(beacon.x)) ? beacon.x : 0,
    y: (typeof beacon?.y === "number" && isFinite(beacon.y)) ? beacon.y : safeRoomH,
  };
  if (typeof dist !== "number" || !isFinite(dist) || dist <= 0) {
    return { x: safePrevX, y: safePrevY, confidence: 0.2 };
  }
  // Use bearing from beacon toward previous position, at distance
  let angle = Math.atan2(safePrevY - safeB.y, safePrevX - safeB.x);
  if (!isFinite(angle)) angle = 0;
  const ex = safeB.x + dist * Math.cos(angle);
  const ey = safeB.y + dist * Math.sin(angle);
  const clamped = clampToRoom(ex, ey, safeRoomW, safeRoomH);
  return { x: clamped.x, y: clamped.y, confidence: 0.35 };
}

// ============================================================================
// ============================================================================
// DATA MODELS & HELPER STRUCTURES
// ============================================================================
export function createBLEMeasurement({
  b1Rssi = null,
  b2Rssi = null,
  b1Dist = null,
  b2Dist = null,
  bleX = 9,
  bleY = 7.5,
  timestamp = Date.now(),
  confidence = 0,
}) {
  return {
    beacon1RSSI: b1Rssi,
    beacon2RSSI: b2Rssi,
    beacon1Distance: b1Dist,
    beacon2Distance: b2Dist,
    bleX,
    bleY,
    timestamp,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

export function createPDRState({
  x = 9,
  y = 7.5,
  stepCount = 0,
  stepLength = 0.70,
  heading = 0,
  lastStepTime = Date.now(),
}) {
  return {
    x,
    y,
    stepCount,
    stepLength,
    heading,
    lastStepTime,
  };
}

export function createTrajectoryPoint({
  timestamp = Date.now(),
  bleX = 9,
  bleY = 7.5,
  pdrX = 9,
  pdrY = 7.5,
  fusedX = 9,
  fusedY = 7.5,
  activeX = 9,
  activeY = 7.5,
  heading = 0,
  stepLength = 0.70,
  stepNumber = 0,
  beacon1RSSI = null,
  beacon2RSSI = null,
  beacon1Distance = null,
  beacon2Distance = null,
  bleConfidence = 0,
  kalmanConfidence = 0,
  bleResidual = 0,
  bleAccepted = true,
  mode = "kalman",
}) {
  const safeTime = (typeof timestamp === "number" && isFinite(timestamp)) ? timestamp : Date.now();
  const d = new Date(safeTime);
  const timeStr = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;

  const toSafeNum = (v, fallback = 0, decimals = 2) => {
    const n = (typeof v === "number" && isFinite(v)) ? v : fallback;
    return Number(n.toFixed(decimals));
  };

  return {
    timestamp: safeTime,
    timeStr,
    bleX: toSafeNum(bleX, 9),
    bleY: toSafeNum(bleY, 7.5),
    pdrX: toSafeNum(pdrX, 9),
    pdrY: toSafeNum(pdrY, 7.5),
    fusedX: toSafeNum(fusedX, 9),
    fusedY: toSafeNum(fusedY, 7.5),
    activeX: toSafeNum(activeX, 9),
    activeY: toSafeNum(activeY, 7.5),
    heading: toSafeNum(heading, 0, 1),
    stepLength: toSafeNum(stepLength, 0.70),
    stepNumber: (typeof stepNumber === "number" && isFinite(stepNumber)) ? stepNumber : 0,
    beacon1RSSI: (typeof beacon1RSSI === "number" && isFinite(beacon1RSSI)) ? beacon1RSSI : null,
    beacon2RSSI: (typeof beacon2RSSI === "number" && isFinite(beacon2RSSI)) ? beacon2RSSI : null,
    beacon1Distance: (typeof beacon1Distance === "number" && isFinite(beacon1Distance)) ? toSafeNum(beacon1Distance, 0) : null,
    beacon2Distance: (typeof beacon2Distance === "number" && isFinite(beacon2Distance)) ? toSafeNum(beacon2Distance, 0) : null,
    bleConfidence: toSafeNum(bleConfidence, 0),
    kalmanConfidence: toSafeNum(kalmanConfidence, 0),
    bleResidual: toSafeNum(bleResidual, 0),
    bleAccepted: bleAccepted ? 1 : 0,
    mode: mode || "kalman",
  };
}

// ============================================================================
// HEADING & CARDINAL DIRECTION HELPERS
// ============================================================================
export function normalizeHeading(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return Number(d.toFixed(1));
}

export function getCardinalDirection(headingDeg) {
  const norm = normalizeHeading(headingDeg);
  if (norm >= 337.5 || norm < 22.5)  return "North (N)";
  if (norm >= 22.5  && norm < 67.5)  return "North-East (NE)";
  if (norm >= 67.5  && norm < 112.5) return "East (E)";
  if (norm >= 112.5 && norm < 157.5) return "South-East (SE)";
  if (norm >= 157.5 && norm < 202.5) return "South (S)";
  if (norm >= 202.5 && norm < 247.5) return "South-West (SW)";
  if (norm >= 247.5 && norm < 292.5) return "West (W)";
  return "North-West (NW)";
}

// ============================================================================
// BLE CONFIDENCE ESTIMATOR (0.0 to 1.0)
// Evaluates RSSI stability, freshness, distance plausibility & geometry consistency
// ============================================================================
export function computeBleConfidence({
  s1, s2, d1, d2, b1Pos, b2Pos, blePos, now = Date.now(),
  roomW = ROOM_WIDTH_FT, roomH = ROOM_HEIGHT_FT,
}) {
  try {
    let score = 0.5;
    const validD1 = typeof d1 === "number" && isFinite(d1) && d1 > 0;
    const validD2 = typeof d2 === "number" && isFinite(d2) && d2 > 0;
    if (!s1 || !s2 || (!validD1 && !validD2)) return 0.0;

    // 1. Packet freshness (penalize if packets are stale)
    const age1 = s1.lastSeen ? now - s1.lastSeen : 9999;
    const age2 = s2.lastSeen ? now - s2.lastSeen : 9999;
    let freshnessScore = 1.0;
    if (age1 > 2000 || age2 > 2000) freshnessScore = 0.2;
    else if (age1 > 1000 || age2 > 1000) freshnessScore = 0.5;
    else if (age1 > 500 || age2 > 500) freshnessScore = 0.8;

    // 2. Dual-beacon availability
    const hasBoth = validD1 && validD2;
    const availScore = hasBoth ? 1.0 : 0.45;

    // 3. Distance plausibility scaled to room size (diagonal + 4 ft margin)
    const safeRoomW = (typeof roomW === "number" && isFinite(roomW) && roomW > 0) ? roomW : ROOM_WIDTH_FT;
    const safeRoomH = (typeof roomH === "number" && isFinite(roomH) && roomH > 0) ? roomH : ROOM_HEIGHT_FT;
    const maxRoomDist = Math.hypot(safeRoomW, safeRoomH) + 4.0;
    let distPlausibility = 1.0;
    if (validD1 && (d1 < 0.2 || d1 > maxRoomDist)) distPlausibility *= 0.6;
    if (validD2 && (d2 < 0.2 || d2 > maxRoomDist)) distPlausibility *= 0.6;

    // 4. Circle intersection consistency
    let geomScore = 0.8;
    if (hasBoth && b1Pos && b2Pos && blePos && isFinite(blePos.x) && isFinite(blePos.y)) {
      const meas1 = Math.hypot(blePos.x - b1Pos.x, blePos.y - b1Pos.y);
      const meas2 = Math.hypot(blePos.x - b2Pos.x, blePos.y - b2Pos.y);
      const err = Math.abs(meas1 - d1) + Math.abs(meas2 - d2);
      if (err < 2.0) geomScore = 1.0;
      else if (err < 5.0) geomScore = 0.75;
      else if (err < 8.0) geomScore = 0.50;
      else geomScore = 0.25;
    }

    score = freshnessScore * 0.30 + availScore * 0.30 + distPlausibility * 0.20 + geomScore * 0.20;
    return isFinite(score) ? Number(Math.max(0.05, Math.min(1.0, score)).toFixed(2)) : 0.5;
  } catch (err) {
    return 0.5;
  }
}

// ============================================================================
// ADAPTIVE KALMAN FILTER 2D WITH OUTLIER REJECTION & VELOCITY TRACKING
// Predicts via PDR, corrects via BLE measurements with dynamic confidence scaling
// ============================================================================
export class AdaptiveKalman2D {
  constructor(roomW = ROOM_WIDTH_FT, roomH = ROOM_HEIGHT_FT) {
    this.roomW = (typeof roomW === "number" && isFinite(roomW) && roomW > 0) ? roomW : ROOM_WIDTH_FT;
    this.roomH = (typeof roomH === "number" && isFinite(roomH) && roomH > 0) ? roomH : ROOM_HEIGHT_FT;
    this.reset(this.roomW / 2, this.roomH / 2);
  }

  setRoomDimensions(roomW, roomH) {
    if (typeof roomW === "number" && isFinite(roomW) && roomW > 0) this.roomW = roomW;
    if (typeof roomH === "number" && isFinite(roomH) && roomH > 0) this.roomH = roomH;
  }

  reset(initX = 9, initY = 7.5) {
    const defaultX = (typeof this.roomW === "number" && isFinite(this.roomW)) ? this.roomW / 2 : 9;
    const defaultY = (typeof this.roomH === "number" && isFinite(this.roomH)) ? this.roomH / 2 : 7.5;

    // State estimate: [x, y, vx, vy] (feet, ft/s)
    this.x  = (typeof initX === "number" && isFinite(initX)) ? initX : defaultX;
    this.y  = (typeof initY === "number" && isFinite(initY)) ? initY : defaultY;
    this.vx = 0.0;
    this.vy = 0.0;

    // Error covariance (position & velocity uncertainty)
    this.Px  = 2.0;
    this.Py  = 2.0;
    this.Pvx = 1.0;
    this.Pvy = 1.0;

    // Process noise floor (ft²/s)
    this.Q_pos = 0.10;
    this.Q_vel = 0.25;

    // Baseline measurement noise covariance (ft²)
    this.R_base = 3.5;

    // Diagnostic readouts
    this.lastResidual    = 0.0;
    this.lastBleAccepted = true;
    this.lastKalmanGain  = 0.5;
    this.totalUpdates    = 0;
    this.rejectedUpdates = 0;
  }

  /**
   * Time update step (called on calculation interval dt).
   * Propagates velocity and prevents covariance freeze.
   */
  timeUpdate(dtSeconds = 0.1) {
    const dt = (typeof dtSeconds === "number" && isFinite(dtSeconds)) ? Math.max(0.02, Math.min(0.5, dtSeconds)) : 0.1;

    // Continuous motion propagation from velocity
    if (isFinite(this.vx) && isFinite(this.vy)) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.vx *= Math.pow(0.85, dt / 0.1);
      this.vy *= Math.pow(0.85, dt / 0.1);
    } else {
      this.vx = 0.0;
      this.vy = 0.0;
    }

    // Process noise accumulation
    this.Px  = (isFinite(this.Px) ? this.Px : 2.0) + this.Q_pos * dt;
    this.Py  = (isFinite(this.Py) ? this.Py : 2.0) + this.Q_pos * dt;
    this.Pvx = (isFinite(this.Pvx) ? this.Pvx : 1.0) + this.Q_vel * dt;
    this.Pvy = (isFinite(this.Pvy) ? this.Pvy : 1.0) + this.Q_vel * dt;

    // Cap covariance ceiling to prevent numerical explosion
    this.Px  = Math.min(this.Px, 8.0);
    this.Py  = Math.min(this.Py, 8.0);
    this.Pvx = Math.min(this.Pvx, 5.0);
    this.Pvy = Math.min(this.Pvy, 5.0);

    const c = clampToRoom(this.x, this.y, this.roomW, this.roomH);
    this.x = c.x;
    this.y = c.y;
  }

  /**
   * PDR step prediction.
   * dx/dy in feet. dtSeconds = estimated step duration.
   */
  predict(dx, dy, dtSeconds = 0.40) {
    if (typeof dx !== "number" || !isFinite(dx) || typeof dy !== "number" || !isFinite(dy)) return;
    const defaultX = (typeof this.roomW === "number" && isFinite(this.roomW)) ? this.roomW / 2 : 9;
    const defaultY = (typeof this.roomH === "number" && isFinite(this.roomH)) ? this.roomH / 2 : 7.5;
    this.x = (isFinite(this.x) ? this.x : defaultX) + dx;
    this.y = (isFinite(this.y) ? this.y : defaultY) + dy;

    // Update velocity estimate from step kinematic impulse
    const dtSafe = (typeof dtSeconds === "number" && isFinite(dtSeconds)) ? Math.max(0.15, dtSeconds) : 0.40;
    const curVx = isFinite(this.vx) ? this.vx : 0;
    const curVy = isFinite(this.vy) ? this.vy : 0;
    this.vx = 0.5 * curVx + 0.5 * (dx / dtSafe);
    this.vy = 0.5 * curVy + 0.5 * (dy / dtSafe);

    // PDR motion increases process uncertainty so filter responds promptly to correction
    this.Px = (isFinite(this.Px) ? this.Px : 2.0) + 1.4;
    this.Py = (isFinite(this.Py) ? this.Py : 2.0) + 1.4;

    const c = clampToRoom(this.x, this.y, this.roomW, this.roomH);
    this.x = c.x;
    this.y = c.y;
  }

  /**
   * BLE measurement update with Innovation Residual Outlier Rejection.
   * bleX/bleY in feet.
   * confidence: 0.0 .. 1.0
   * isStationary: boolean
   */
  update(bleX, bleY, confidence = 0.5, isStationary = false) {
    if (typeof bleX !== "number" || !isFinite(bleX) || typeof bleY !== "number" || !isFinite(bleY)) {
      return { accepted: false, residual: this.lastResidual || 0, kGain: 0 };
    }

    this.totalUpdates++;

    // 1. Calculate Innovation Residual: residual = ||BLE_pos - Predicted_pos||
    const resX = bleX - this.x;
    const resY = bleY - this.y;
    const residual = Math.hypot(resX, resY);
    this.lastResidual = Number(residual.toFixed(2));

    // 2. Outlier Rejection Gating:
    // Innovation gate scales with position uncertainty: gate = max(5.5 ft, 2.5 * sigma_pos)
    const posSigma = Math.sqrt(Math.max(this.Px, this.Py));
    const outlierGate = Math.max(5.5, 2.5 * posSigma);

    if (residual > outlierGate) {
      // Outlier detected: reject or heavily down-weight to prevent erratic teleportation jumps
      this.lastBleAccepted = false;
      this.rejectedUpdates++;
      return { accepted: false, residual: this.lastResidual, kGain: 0 };
    }

    this.lastBleAccepted = true;

    // 3. Dynamic Measurement Noise Covariance R:
    // High confidence -> R decreases -> Kalman gain increases -> stronger correction
    // Low confidence  -> R increases -> Kalman gain decreases -> softer correction
    const conf = Math.max(0.10, Math.min(1.0, confidence));
    let R = this.R_base / conf;

    if (isStationary) {
      R *= 1.8; // Suppress stationary jitter
    }

    // Minimum covariance floor
    this.Px = Math.max(this.Px, 0.35);
    this.Py = Math.max(this.Py, 0.35);

    // 4. Compute Kalman Gains
    let Kx = this.Px / (this.Px + R);
    let Ky = this.Py / (this.Py + R);

    // Micro-noise deadband when stationary (< 0.15 ft)
    if (residual < 0.15 && isStationary) {
      Kx *= 0.30;
      Ky *= 0.30;
    }

    this.lastKalmanGain = Number(((Kx + Ky) / 2).toFixed(3));

    // 5. State Update
    this.x += Kx * resX;
    this.y += Ky * resY;

    // Gentle velocity correction
    this.vx += 0.25 * (Kx * resX);
    this.vy += 0.25 * (Ky * resY);

    // 6. Covariance Update
    this.Px = (1 - Kx) * this.Px;
    this.Py = (1 - Ky) * this.Py;

    // Clamp inside room boundaries
    const c = clampToRoom(this.x, this.y, this.roomW, this.roomH);
    this.x = c.x;
    this.y = c.y;

    return {
      accepted: true,
      residual: this.lastResidual,
      kGain: this.lastKalmanGain,
    };
  }

  getPosition() {
    const defaultX = (typeof this.roomW === "number" && isFinite(this.roomW)) ? this.roomW / 2 : 9;
    const defaultY = (typeof this.roomH === "number" && isFinite(this.roomH)) ? this.roomH / 2 : 7.5;
    return {
      x: (typeof this.x === "number" && isFinite(this.x)) ? Number(this.x.toFixed(2)) : Number(defaultX.toFixed(2)),
      y: (typeof this.y === "number" && isFinite(this.y)) ? Number(this.y.toFixed(2)) : Number(defaultY.toFixed(2)),
      vx: (typeof this.vx === "number" && isFinite(this.vx)) ? Number(this.vx.toFixed(2)) : 0,
      vy: (typeof this.vy === "number" && isFinite(this.vy)) ? Number(this.vy.toFixed(2)) : 0,
    };
  }

  getDiagnostics() {
    return {
      x: (typeof this.x === "number" && isFinite(this.x)) ? Number(this.x.toFixed(2)) : 9,
      y: (typeof this.y === "number" && isFinite(this.y)) ? Number(this.y.toFixed(2)) : 7.5,
      vx: (typeof this.vx === "number" && isFinite(this.vx)) ? Number(this.vx.toFixed(2)) : 0,
      vy: (typeof this.vy === "number" && isFinite(this.vy)) ? Number(this.vy.toFixed(2)) : 0,
      Px: (typeof this.Px === "number" && isFinite(this.Px)) ? Number(this.Px.toFixed(2)) : 2.0,
      Py: (typeof this.Py === "number" && isFinite(this.Py)) ? Number(this.Py.toFixed(2)) : 2.0,
      lastResidual: this.lastResidual || 0,
      lastBleAccepted: this.lastBleAccepted,
      lastKalmanGain: this.lastKalmanGain || 0.5,
      totalUpdates: this.totalUpdates || 0,
      rejectedUpdates: this.rejectedUpdates || 0,
    };
  }
}

// ============================================================================
// BENCHMARK ERROR STATISTICS (MAE, RMSE, Max, Median)
// ============================================================================
export function computeBenchmarkStats(errorSamples) {
  if (!Array.isArray(errorSamples)) {
    return { count: 0, mae: 0, rmse: 0, max: 0, min: 0, median: 0 };
  }
  const valid = errorSamples.filter(s => typeof s === "number" && isFinite(s));
  if (valid.length === 0) {
    return { count: 0, mae: 0, rmse: 0, max: 0, min: 0, median: 0 };
  }
  const n = valid.length;
  const sum = valid.reduce((a, b) => a + b, 0);
  const mae = sum / n;
  const sumSq = valid.reduce((a, b) => a + b * b, 0);
  const rmse = Math.sqrt(sumSq / n);
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  const sorted = [...valid].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];

  return {
    count: n,
    mae: isFinite(mae) ? Number(mae.toFixed(2)) : 0,
    rmse: isFinite(rmse) ? Number(rmse.toFixed(2)) : 0,
    max: isFinite(max) ? Number(max.toFixed(2)) : 0,
    min: isFinite(min) ? Number(min.toFixed(2)) : 0,
    median: isFinite(median) ? Number(median.toFixed(2)) : 0,
  };
}

// ============================================================================
// TRAJECTORY EXPORTERS (CSV & JSON)
// ============================================================================
export function exportTrajectoryAsCsv(trajectoryPoints) {
  if (!trajectoryPoints || trajectoryPoints.length === 0) {
    return "timestamp,timeStr,bleX,bleY,pdrX,pdrY,fusedX,fusedY,activeX,activeY,heading,stepLength,stepNumber,beacon1RSSI,beacon2RSSI,beacon1Distance,beacon2Distance,bleConfidence,kalmanConfidence,bleResidual,bleAccepted,mode\n";
  }

  const headers = [
    "timestamp",
    "timeStr",
    "bleX",
    "bleY",
    "pdrX",
    "pdrY",
    "fusedX",
    "fusedY",
    "activeX",
    "activeY",
    "heading",
    "stepLength",
    "stepNumber",
    "beacon1RSSI",
    "beacon2RSSI",
    "beacon1Distance",
    "beacon2Distance",
    "bleConfidence",
    "kalmanConfidence",
    "bleResidual",
    "bleAccepted",
    "mode",
  ];

  const rows = trajectoryPoints.map(p => [
    p.timestamp,
    p.timeStr,
    p.bleX,
    p.bleY,
    p.pdrX,
    p.pdrY,
    p.fusedX,
    p.fusedY,
    p.activeX,
    p.activeY,
    p.heading,
    p.stepLength,
    p.stepNumber,
    p.beacon1RSSI ?? "",
    p.beacon2RSSI ?? "",
    p.beacon1Distance ?? "",
    p.beacon2Distance ?? "",
    p.bleConfidence,
    p.kalmanConfidence,
    p.bleResidual,
    p.bleAccepted,
    p.mode,
  ].join(","));

  return [headers.join(","), ...rows].join("\n");
}

export function exportTrajectoryAsJson(trajectoryPoints) {
  return JSON.stringify(trajectoryPoints, null, 2);
}

// ============================================================================
// MOVEMENT SANITY CHECK
// ============================================================================
export function isSaneMovement(prevX, prevY, newX, newY, dtMs) {
  if (dtMs <= 0) return true;
  const distFt = Math.hypot(newX - prevX, newY - prevY);
  // In an 18x15 ft room, allow up to 25 ft/s to permit natural movement and fast convergence
  const speedFtS = distFt / Math.max(0.05, dtMs / 1000);
  return speedFtS <= 25;
}


