// ============================================================================
// CellularWorldMap.js — the phone's cell-based position on a real world map
//
// OpenStreetMap tiles drawn as plain Images (no map library, so it also works
// in an OTA update). The blue dot is the estimated phone position, the circle
// its accuracy; orange triangles are tower locations when known.
// Needs internet for the tiles. Map data © OpenStreetMap contributors.
// ============================================================================

import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import Svg, { Circle, Polygon } from "react-native-svg";

const SIZE = 320;
const TILE = 256;
const UA = { "User-Agent": "NexusIndoorNav-CellTest/1.0" };

// Web-Mercator world pixel (at zoom z) of a lat/lon.
function worldPx(lat, lon, z) {
  const n = TILE * 2 ** z;
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

/** Largest zoom (3..17) at which the accuracy circle still fits well inside the view. */
export function zoomFor(lat, accuracyM) {
  const r = Math.max(accuracyM || 300, 100);
  for (let z = 17; z >= 3; z--) {
    const mPerPx = (Math.cos((lat * Math.PI) / 180) * 40075016.686) / (TILE * 2 ** z);
    if (r / mPerPx <= SIZE * 0.3) return z;
  }
  return 3;
}

/** phone: { lat, lon, uncertaintyM }, towers: [{ lat, lon, serving }] */
export default function CellularWorldMap({ phone, towers = [] }) {
  if (!phone) return null;
  const z = zoomFor(phone.lat, phone.uncertaintyM);
  const c = worldPx(phone.lat, phone.lon, z);
  const left = c.x - SIZE / 2, top = c.y - SIZE / 2;
  const n = 2 ** z;
  const tiles = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + SIZE) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + SIZE) / TILE); tx++) {
      const wx = ((tx % n) + n) % n;
      tiles.push({ key: `${tx}/${ty}`, uri: `https://tile.openstreetmap.org/${z}/${wx}/${ty}.png`, x: tx * TILE - left, y: ty * TILE - top });
    }
  }
  const mPerPx = (Math.cos((phone.lat * Math.PI) / 180) * 40075016.686) / (TILE * 2 ** z);
  const rPx = phone.uncertaintyM ? Math.min(phone.uncertaintyM / mPerPx, SIZE) : 0;
  return (
    <View style={styles.wrap}>
      <View style={styles.map}>
        {tiles.map((t) => (
          <Image key={t.key} source={{ uri: t.uri, headers: UA }} style={{ position: "absolute", left: t.x, top: t.y, width: TILE, height: TILE }} />
        ))}
        <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
          {towers.map((t, i) => {
            const p = worldPx(t.lat, t.lon, z);
            const x = p.x - left, y = p.y - top;
            if (x < -10 || y < -10 || x > SIZE + 10 || y > SIZE + 10) return null;
            return <Polygon key={i} points={`${x},${y - 8} ${x - 7},${y + 6} ${x + 7},${y + 6}`} fill="#f0883e" stroke="#fff" strokeWidth={1} />;
          })}
          {rPx > 0 && <Circle cx={SIZE / 2} cy={SIZE / 2} r={rPx} fill="rgba(88,166,255,0.18)" stroke="#58a6ff" strokeWidth={1.5} />}
          <Circle cx={SIZE / 2} cy={SIZE / 2} r={7} fill="#1f6feb" stroke="#fff" strokeWidth={2.5} />
        </Svg>
      </View>
      <Text style={styles.credit}>© OpenStreetMap contributors · zoom {z}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", marginTop: 10 },
  map: { width: SIZE, height: SIZE, overflow: "hidden", borderRadius: 8, backgroundColor: "#d8dee4" },
  credit: { color: "#8b949e", fontSize: 10, marginTop: 4 },
});
