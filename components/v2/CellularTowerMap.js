// ============================================================================
// CellularTowerMap.js — where OpenCelliD says the TOWER(s) are (Cellular Test)
//
// A plain plot (no map tiles, no extra dependency): north is up, a scale bar
// shows the distance. For real streets use "Open in Maps" on the screen.
//
//   🗼 orange triangle   a cell TOWER'S location (the database's, not yours)
//   dashed circle        its coverage range - a coverage estimate, NOT a distance to the phone
//   blue dot             the PHONE - drawn only if a phone position is actually
//                        estimated, which this experiment never does with one tower
// ============================================================================

import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle, Line, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { layoutPlot, formatMeters } from "../../services/cellular/CellularLocationUtils.js";

const C = { bg: "#0d1117", grid: "#21262d", text: "#e6edf3", sub: "#8b949e", tower: "#f0883e", towerNb: "#a371f7", phone: "#58a6ff" };
const SIZE = 300;

/** towers: [{ lat, lon, rangeM, serving, label }], phone: { lat, lon, uncertaintyM } | null */
export default function CellularTowerMap({ towers = [], phone = null }) {
  const pts = [
    ...towers.map((t) => ({ ...t, kind: "tower" })),
    ...(phone ? [{ ...phone, rangeM: phone.uncertaintyM, kind: "phone" }] : []),
  ];
  const { items, scaleBarM, metersPerPx } = layoutPlot(pts, SIZE);
  const barPx = scaleBarM / metersPerPx;
  return (
    <View style={styles.wrap}>
      <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <Rect x={0} y={0} width={SIZE} height={SIZE} fill={C.bg} />
        {[1, 2, 3].map((i) => (
          <React.Fragment key={i}>
            <Line x1={(SIZE / 4) * i} y1={0} x2={(SIZE / 4) * i} y2={SIZE} stroke={C.grid} strokeWidth={1} />
            <Line x1={0} y1={(SIZE / 4) * i} x2={SIZE} y2={(SIZE / 4) * i} stroke={C.grid} strokeWidth={1} />
          </React.Fragment>
        ))}
        {items.map((p, i) => {
          const col = p.kind === "phone" ? C.phone : p.serving ? C.tower : C.towerNb;
          return (
            <React.Fragment key={i}>
              {p.radiusPx > 0 && (
                <Circle cx={p.px} cy={p.py} r={p.radiusPx} fill={col} fillOpacity={0.08} stroke={col} strokeWidth={1.5} strokeDasharray="5 4" />
              )}
              {p.kind === "phone" ? (
                <Circle cx={p.px} cy={p.py} r={6} fill={C.phone} stroke="#fff" strokeWidth={2} />
              ) : (
                <Polygon points={`${p.px},${p.py - 9} ${p.px - 8},${p.py + 7} ${p.px + 8},${p.py + 7}`} fill={col} stroke="#fff" strokeWidth={1.5} />
              )}
              {p.label ? (
                <SvgText x={p.px + 11} y={p.py + 4} fontSize="11" fontWeight="bold" fill={C.text}>{p.label}</SvgText>
              ) : null}
            </React.Fragment>
          );
        })}
        <SvgText x={SIZE - 18} y={16} fontSize="12" fontWeight="bold" fill={C.sub}>N ↑</SvgText>
        <Line x1={12} y1={SIZE - 14} x2={12 + barPx} y2={SIZE - 14} stroke={C.text} strokeWidth={2} />
        <SvgText x={12} y={SIZE - 20} fontSize="11" fill={C.text}>{formatMeters(scaleBarM)}</SvgText>
      </Svg>
      <View style={styles.legend}>
        <Text style={[styles.legendTxt, { color: C.tower }]}>▲ serving tower</Text>
        <Text style={[styles.legendTxt, { color: C.towerNb }]}>▲ neighbour tower</Text>
        <Text style={[styles.legendTxt, { color: C.phone }]}>● phone estimate{phone ? "" : " (none)"}</Text>
      </View>
      <Text style={styles.note}>
        Tower position from OpenCelliD. Dashed circle = coverage range estimate, not a distance to you.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", marginTop: 8 },
  legend: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 12, marginTop: 6 },
  legendTxt: { fontSize: 11, fontWeight: "700" },
  note: { color: C.sub, fontSize: 11, textAlign: "center", marginTop: 4 },
});
