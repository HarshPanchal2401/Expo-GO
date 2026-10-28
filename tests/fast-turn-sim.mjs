// Synthetic phone for heading tests: true orientation -> Expo Android DeviceMotion events.
// Held in front (tilted pitchDeg, top up), turning by bearing(tS) (deg, clockwise).
// Expo Android sends, once per screen frame (>= intervalMs apart), the LATEST gyro reading
// (instantaneous rate) and the LATEST rotation vector (Euler, radians).
const G = 9.80665;
const D = Math.PI / 180;

function rotMatrix(psiDeg, pitchDeg) {
  // device -> world (East, North, Up): R = Rz(-psi) * Rx(pitch)
  const p = -psiDeg * D, t = pitchDeg * D;
  const cz = Math.cos(p), sz = Math.sin(p), cx = Math.cos(t), sx = Math.sin(t);
  // Rz * Rx
  return [
    [cz, -sz * cx, sz * sx],
    [sz, cz * cx, -cz * sx],
    [0, sx, cx],
  ];
}

/**
 * bearing(tS): true heading (deg). Returns events [{tMs, data}].
 * opts: durationS, frameMs (16.7), intervalMs (20), dropProb (frames skipped), seed.
 */
export function phoneEvents(bearing, { durationS = 10, pitchDeg = 30, frameMs = 1000 / 60, intervalMs = 20, dropProb = 0, burstDropProb = 0, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out = [];
  const gyroHz = 200, rvHz = 100;
  let lastEmit = -1e9;
  let skip = 0;
  for (let f = 0; f * frameMs < durationS * 1000; f++) {
    const tMs = f * frameMs;
    if (skip > 0) { skip--; continue; }
    if (rnd() < burstDropProb) { skip = 3 + Math.floor(rnd() * 6); continue; } // UI thread busy: 50-150 ms
    if (rnd() < dropProb) continue;
    if (tMs - lastEmit <= intervalMs) continue;
    lastEmit = tMs;
    // latest gyro / rotation-vector sensor events before this frame
    const tg = Math.floor(tMs / 1000 * gyroHz) / gyroHz;
    const tr = Math.floor(tMs / 1000 * rvHz) / rvHz;
    const R = rotMatrix(bearing(tg), pitchDeg);
    const h = 1e-4;
    const dpsi = (bearing(tg + h) - bearing(tg - h)) / (2 * h); // deg/s clockwise
    // world angular velocity: about Up, CCW positive = -dpsi
    const wz = -dpsi;
    // device frame = R^T * (0,0,wz)
    const w = { x: R[2][0] * wz, y: R[2][1] * wz, z: R[2][2] * wz };
    const Rr = rotMatrix(bearing(tr), pitchDeg);
    const az = Math.atan2(Rr[0][1], Rr[1][1]);
    const pitch = Math.asin(-Rr[2][1]);
    const roll = Math.atan2(-Rr[2][0], Rr[2][2]);
    // gravity (down) in device frame = R^T * (0,0,-1)
    const down = { x: -R[2][0], y: -R[2][1], z: -R[2][2] };
    out.push({
      tMs,
      truth: bearing(tMs / 1000),
      data: {
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: down.x * G, y: down.y * G, z: down.z * G },
        rotationRate: { alpha: w.x, beta: w.y, gamma: w.z, timestamp: tg },
        rotation: { alpha: -az, beta: -pitch, gamma: roll, timestamp: tr },
      },
    });
  }
  return out;
}

/** Smooth turn of `deg` taking `secs`, starting at t0 (s): rate ~ sin^2. */
export function turn(t, t0, secs, deg) {
  if (t <= t0) return 0;
  if (t >= t0 + secs) return deg;
  const u = (t - t0) / secs;
  return deg * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI));
}
