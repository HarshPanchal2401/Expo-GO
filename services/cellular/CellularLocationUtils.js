// ============================================================================
// CellularLocationUtils.js — small geographic helpers for the Cellular Test
//
// Geographic coordinates (latitude, longitude in degrees) only. They are NOT
// the office floor plan's local feet, and nothing here converts between them.
// ============================================================================

const EARTH_R_M = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** East / north offset (m) of p from origin o (flat-earth, fine for a few km). */
export function offsetM(o, p) {
  return {
    x: rad(p.lon - o.lon) * EARTH_R_M * Math.cos(rad(o.lat)),
    y: rad(p.lat - o.lat) * EARTH_R_M,
  };
}

export const isLatLon = (p) =>
  Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

export function formatLatLon(p) {
  return isLatLon(p) ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : "—";
}

export function formatMeters(m) {
  if (!Number.isFinite(m)) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

/** Android map-app link (opens any installed maps app). */
export function geoUri(p, label = "Cell tower") {
  return `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}(${encodeURIComponent(label)})`;
}

/**
 * Layout for the tower plot: the points (towers, and a phone estimate if one
 * exists), centred, fitted into size x size px. Returns { items, metersPerPx,
 * scaleBarM } where each item has pixel x, y (y down) and radiusPx for its range.
 */
export function layoutPlot(points, size, pad = 28) {
  const valid = points.filter((p) => isLatLon(p));
  if (!valid.length) return { items: [], metersPerPx: 1, scaleBarM: 100 };
  const o = {
    lat: valid.reduce((a, p) => a + p.lat, 0) / valid.length,
    lon: valid.reduce((a, p) => a + p.lon, 0) / valid.length,
  };
  const off = valid.map((p) => ({ p, ...offsetM(o, p) }));
  // Half-extent in metres including each range circle (capped, so a huge range cannot flatten everything).
  const half = Math.max(
    150,
    ...off.map((q) => Math.max(Math.abs(q.x), Math.abs(q.y)) + Math.min(q.p.rangeM || 0, 20000))
  );
  const mPerPx = (half * 1.1) / (size / 2 - pad / 2);
  const items = off.map((q) => ({
    ...q.p,
    px: size / 2 + q.x / mPerPx,
    py: size / 2 - q.y / mPerPx,
    radiusPx: q.p.rangeM ? Math.min(q.p.rangeM / mPerPx, size) : 0,
  }));
  // A round scale-bar length (1, 2, 5 x 10^k) about a quarter of the width.
  const target = (size / 4) * mPerPx;
  const k = 10 ** Math.floor(Math.log10(target));
  const scaleBarM = [1, 2, 5, 10].map((m) => m * k).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  return { items, metersPerPx: mPerPx, scaleBarM };
}
