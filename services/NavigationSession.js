// ============================================================================
// NavigationSession.js — where the user is along a route, and what to say next
//
// Reads the dot (x, y, heading) only; it never moves it. Given a route from
// Router.js it keeps:
//   - progress: how far along the route (ft), never going backwards. The point
//     on the route is searched just ahead of the last progress, so a route that
//     passes near itself cannot make the progress jump;
//   - remaining distance and time left;
//   - the next instruction ("Turn left in 12 ft", "You have arrived");
//   - off-route: farther than OFF_ROUTE_FT from the route for OFF_ROUTE_S seconds
//     asks for a new route (reroute: true), at most every REROUTE_GAP_S. The dot
//     wobbles by a foot or two and PDR drifts, so a short stray never reroutes.
//
// Units: feet, seconds. Heading and bearings: clockwise from the map's up.
// ============================================================================

export const NAV_CONFIG = {
  ARRIVE_FT: 3,
  OFF_ROUTE_FT: 6,
  OFF_ROUTE_S: 3,
  REROUTE_GAP_S: 5,
  // The route is searched this far ahead of the progress for the user's place on it (ft).
  LOOKAHEAD_FT: 30,
  // Turn instructions from this far (ft); farther away just says how far to go.
  TURN_CALL_FT: 40,
  // A turn that is "now" (ft).
  TURN_NOW_FT: 4,
  // At the start, the user must face the first leg within this (deg) before it says "go".
  FACE_DEG: 50,
  WALK_SPEED_MPS: 1.0,
};

const FT_PER_M = 3.28084;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
// Said distances: whole feet when close, steps of 5 farther away.
const roundFt = (v) => (v < 10 ? Math.max(1, Math.round(v)) : Math.round(v / 5) * 5);

/** Closest point of segment a→b to p: { s (ft from a), d (distance to p) }. */
function onSegment(a, b, p) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  const qx = a.x + t * vx, qy = a.y + t * vy;
  return { s: t * Math.sqrt(len2), d: Math.hypot(p.x - qx, p.y - qy) };
}

export class NavigationSession {
  constructor(config = {}) {
    this.cfg = { ...NAV_CONFIG, ...config };
    this.route = null;
    this.speedMps = this.cfg.WALK_SPEED_MPS;
    this.lastRerouteMs = -Infinity;
    this.reset();
  }

  reset() {
    this.progressFt = 0;
    this.arrived = false;
    this._offSince = null;
    this._starts = [];
  }

  /** Begin (or continue after a reroute) along `route`; speedMps for the time left. */
  start(route, speedMps) {
    this.route = route;
    if (speedMps > 0) this.speedMps = speedMps;
    this.reset();
    let acc = 0;
    for (const l of route.legs) {
      this._starts.push(acc);
      acc += l.lengthFt;
    }
    this.totalFt = acc;
  }

  /** Where the user is on the route: { s, d } (s = ft along, d = ft from the route). */
  _locate(p) {
    const { legs } = this.route;
    let best = null, window = null;
    for (let i = 0; i < legs.length; i++) {
      const r = onSegment(legs[i].from, legs[i].to, p);
      const s = this._starts[i] + r.s;
      if (!best || r.d < best.d) best = { s, d: r.d };
      if (s >= this.progressFt - 1 && s <= this.progressFt + this.cfg.LOOKAHEAD_FT && (!window || r.d < window.d)) window = { s, d: r.d };
    }
    // Near the route just ahead: that is the place. Otherwise only the distance from it counts.
    if (window && window.d <= this.cfg.OFF_ROUTE_FT) return window;
    return { s: this.progressFt, d: best ? best.d : Infinity };
  }

  /**
   * The user is at {x, y}, facing heading (deg, optional), at nowMs. Returns
   * { state: "navigating" | "arrived", progressFt, remainingFt, etaS, offRouteFt,
   *   instruction, turn, turnInFt, reroute }.
   */
  update({ x, y, heading }, nowMs = Date.now()) {
    if (!this.route) return null;
    const c = this.cfg;
    if (!this.arrived) {
      const loc = this._locate({ x, y });
      this.progressFt = Math.max(this.progressFt, Math.min(loc.s, this.totalFt));
      this._offRouteFt = loc.d;
    }
    const remainingFt = Math.max(0, this.totalFt - this.progressFt);
    const end = this.route.points[this.route.points.length - 1];
    if (!this.arrived && (remainingFt <= c.ARRIVE_FT || (Math.hypot(x - end.x, y - end.y) <= c.ARRIVE_FT && remainingFt <= c.ARRIVE_FT * 3))) {
      this.arrived = true;
      this.progressFt = this.totalFt;
    }

    let reroute = false;
    if (!this.arrived && this._offRouteFt > c.OFF_ROUTE_FT) {
      if (this._offSince === null) this._offSince = nowMs;
      if (nowMs - this._offSince >= c.OFF_ROUTE_S * 1000 && nowMs - this.lastRerouteMs >= c.REROUTE_GAP_S * 1000) {
        reroute = true;
        this.lastRerouteMs = nowMs;
        this._offSince = null;
      }
    } else {
      this._offSince = null;
    }

    const { instruction, turn, turnInFt } = this._instruction(remainingFt, heading);
    return {
      state: this.arrived ? "arrived" : "navigating",
      progressFt: this.progressFt,
      remainingFt,
      etaS: remainingFt / FT_PER_M / this.speedMps,
      offRouteFt: this._offRouteFt ?? 0,
      offRoute: !this.arrived && this._offRouteFt > c.OFF_ROUTE_FT,
      instruction,
      turn,
      turnInFt,
      reroute,
    };
  }

  _instruction(remainingFt, heading) {
    const c = this.cfg;
    if (this.arrived) return { instruction: "You have arrived", turn: null, turnInFt: 0 };
    const { legs } = this.route;
    let cur = 0;
    while (cur < legs.length - 1 && this._starts[cur + 1] <= this.progressFt) cur++;

    // Before the first steps: face the way of the route.
    if (this.progressFt < 4 && Number.isFinite(heading)) {
      const off = wrap180(legs[0].bearing - heading);
      if (Math.abs(off) > c.FACE_DEG) {
        const turn = Math.abs(off) >= 150 ? "u-turn" : off > 0 ? "right" : "left";
        return { instruction: turn === "u-turn" ? "Turn around" : `Turn ${turn} to face the route`, turn, turnInFt: 0 };
      }
    }

    // The next real turn after this leg.
    let n = cur + 1;
    while (n < legs.length && legs[n].turn === "straight") n++;
    if (n >= legs.length) {
      return { instruction: `Continue ${roundFt(remainingFt)} ft to your destination`, turn: null, turnInFt: remainingFt };
    }
    const turnInFt = Math.max(0, this._starts[n] - this.progressFt);
    const turn = legs[n].turn;
    const word = turn === "u-turn" ? "turn around" : `turn ${turn}`;
    if (turnInFt <= c.TURN_NOW_FT) return { instruction: `${word[0].toUpperCase()}${word.slice(1)} now`, turn, turnInFt };
    if (turnInFt <= c.TURN_CALL_FT) return { instruction: `In ${roundFt(turnInFt)} ft, ${word}`, turn, turnInFt };
    return { instruction: `Go straight ${roundFt(turnInFt)} ft, then ${word}`, turn, turnInFt };
  }
}
