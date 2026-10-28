// ============================================================================
// MapNorth.js — ties the heading to the floor plan's real north
//
// The office drawing has real north on its LEFT, so the map's "up" (heading 0)
// is compass east, and a compass bearing b is map heading b - 90 - turned by
// MAP_ROTATION_DEG, as the drawing is not exactly square to north.
//
// The app turns the phone's orientation angle (DeviceMotion rotation.alpha,
// degrees) into a heading with   heading = zero - alpha.   alpha falls as the
// phone turns clockwise, and what it reads when the phone's top faces north
// ("alpha north") differs by platform: 0 on Android, 270 on iPhone (expo-sensors
// reports them in different frames). The zero follows from it:
//   zero = alphaNorth - 90 + MAP_ROTATION_DEG.
//
// Some phones report alpha in the other platform's frame. AlphaNorthCheck
// confirms alpha north once, against the magnetometer's own bearing while the
// phone is held flat: each reading gives alpha + bearing = alpha north. When
// enough readings agree and they point clearly at a different quarter turn, it
// switches to that; readings that disagree (disturbed field) change nothing.
//
// Units: degrees. Bearing: clockwise from north. Map heading: clockwise from the
// map's up, in [-180, 180).
// ============================================================================

const norm = (d) => ((d % 360) + 360) % 360;
const wrap180 = (d) => norm(d + 180) - 180;

// The drawing is not exactly square to north: its "up" is compass bearing
// 90 - this (deg). Measured in the office: the arrow pointed 10 deg left of
// the real walking direction with north exactly on the left.
export const MAP_ROTATION_DEG = 10;
// Settings can change it (mapRotationDeg), within this range (deg).
export const MAP_ROTATION_LIMIT_DEG = 45;
let rotationDeg = MAP_ROTATION_DEG;

/** The map rotation in use (deg). */
export function getMapRotationDeg() {
  return rotationDeg;
}

/** Sets the map rotation (Settings). Returns true if it changed. */
export function setMapRotationDeg(deg) {
  const d = Number.isFinite(deg)
    ? Math.max(-MAP_ROTATION_LIMIT_DEG, Math.min(MAP_ROTATION_LIMIT_DEG, deg))
    : MAP_ROTATION_DEG;
  if (d === rotationDeg) return false;
  rotationDeg = d;
  return true;
}
// Which side of the drawing real north is on (the map shows an N marker there).
export const MAP_NORTH_SIDE = "left";

export const MAP_NORTH_CONFIG = {
  // Readings collected before deciding.
  SAMPLES: 40,
  // They must agree this well (resultant length of the unit vectors, 0..1).
  MIN_AGREEMENT: 0.8,
  // ...and their mean be this close to a quarter turn (deg).
  MAX_OFF_QUARTER_DEG: 25,
};

/** What alpha reads when the phone's top faces north, by default (deg). */
export function defaultAlphaNorth(platform) {
  return platform === "ios" ? 270 : 0;
}

/** The heading zero for `heading = zero - alpha` (deg). */
export function mapHeadingZero(alphaNorth) {
  return norm(alphaNorth - 90 + rotationDeg);
}

/** Compass bearing (deg) to map heading: north is on the map's left (MAP_ROTATION_DEG). */
export function mapHeadingFromBearing(bearingDeg) {
  return wrap180(bearingDeg - 90 + rotationDeg);
}

/** One-time check of alpha north against the magnetometer (see top). */
export class AlphaNorthCheck {
  constructor(platform, config = {}) {
    this.cfg = { ...MAP_NORTH_CONFIG, ...config };
    this.value = defaultAlphaNorth(platform);
    this.done = false;
    this._s = 0;
    this._c = 0;
    this._n = 0;
  }

  /**
   * A reading: alpha (deg) and the magnetometer bearing (deg) at the same
   * moment, phone held flat. Returns the new alpha north when it changed,
   * otherwise null.
   */
  add(alphaDeg, bearingDeg) {
    if (this.done || !Number.isFinite(alphaDeg) || !Number.isFinite(bearingDeg)) return null;
    const r = (norm(alphaDeg + bearingDeg) * Math.PI) / 180;
    this._s += Math.sin(r);
    this._c += Math.cos(r);
    this._n++;
    if (this._n < this.cfg.SAMPLES) return null;
    this.done = true;
    const agreement = Math.hypot(this._s, this._c) / this._n;
    if (agreement < this.cfg.MIN_AGREEMENT) return null;
    const mean = norm((Math.atan2(this._s, this._c) * 180) / Math.PI);
    const quarter = norm(Math.round(mean / 90) * 90);
    if (Math.abs(wrap180(mean - quarter)) > this.cfg.MAX_OFF_QUARTER_DEG) return null;
    if (quarter === norm(this.value)) return null;
    this.value = quarter;
    return quarter;
  }
}
