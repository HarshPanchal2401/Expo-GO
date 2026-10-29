// Route drawing helpers (feet), kept apart from the screen so they can be tested.

/** The route's points, and the point `distFt` along it. Returns { behind, ahead }. */
export function splitRoute(route, distFt) {
  if (!route) return { behind: [], ahead: [] };
  const pts = route.points;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + len >= distFt) {
      const f = len > 0 ? (distFt - acc) / len : 0;
      const p = { x: pts[i - 1].x + f * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + f * (pts[i].y - pts[i - 1].y) };
      return { behind: [...pts.slice(0, i), p], ahead: [p, ...pts.slice(i)] };
    }
    acc += len;
  }
  return { behind: [...pts], ahead: [pts[pts.length - 1]] };
}

/** Zoom and centre that show all of `pts` (feet), for animateView. */
export function fitView(pts, roomW, roomH) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0) + 14;
  return {
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    zoom: Math.max(1, Math.min(4, Math.max(roomW, roomH) / span)),
  };
}
