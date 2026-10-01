// ============================================================================
// RSSI SIGNAL GRAPH (V2)
// Real-time SVG time-series chart plotting raw and filtered BLE RSSI streams.
// Features dual-beacon curves, dBm reference grid lines, packet markers,
// and time window scrolling.
// ============================================================================

import React, { useState } from "react";
import { View, Text, StyleSheet, Dimensions } from "react-native";
import Svg, { Line, Polyline, Circle, Text as SvgText, Rect, G } from "react-native-svg";

const DEFAULT_HEIGHT = 220;
const MARGIN_LEFT = 42;
const MARGIN_RIGHT = 12;
const MARGIN_TOP = 16;
const MARGIN_BOTTOM = 22;

const RSSI_MAX = -30;  // Top of Y-axis (strongest signal)
const RSSI_MIN = -95;  // Bottom of Y-axis (weakest signal)

const GRID_STEPS = [-40, -50, -60, -70, -80, -90];

export default function RssiSignalGraph({
  history = { b1: [], b2: [] },
  mode = "both", // "raw" | "both" | "filtered"
  windowSec = 20, // display window in seconds
  b1Name = "Beacon 1",
  b2Name = "Beacon 2",
  latestB1 = null,
  latestB2 = null,
  darkMode = true,
}) {
  const [layoutWidth, setLayoutWidth] = useState(Dimensions.get("window").width - 32);

  const safeLayoutW = Number.isFinite(layoutWidth) && layoutWidth > 0 ? layoutWidth : (Dimensions.get("window").width - 32);
  const plotW = Math.max(100, safeLayoutW - MARGIN_LEFT - MARGIN_RIGHT);
  const plotH = Math.max(80, DEFAULT_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM);

  // Same beacon colours as the Fusion Map, so B1/B2 read identically everywhere.
  const b1Color = darkMode ? "#58a6ff" : "#0969da";
  const b2Color = darkMode ? "#bc8cff" : "#8250df";

  // Y-axis mapping: RSSI (-30 to -95) -> screen Y
  const rssiToY = (rssi) => {
    const val = Number.isFinite(rssi) ? rssi : -90;
    const clamped = Math.max(RSSI_MIN, Math.min(RSSI_MAX, val));
    const ratio = (clamped - RSSI_MAX) / (RSSI_MIN - RSSI_MAX); // 0 (at -30) to 1 (at -95)
    return MARGIN_TOP + ratio * plotH;
  };

  // Time window: [now - windowSec*1000, now]
  const now = Date.now();
  const windowMs = Math.max(1000, (Number.isFinite(windowSec) ? windowSec : 20) * 1000);
  const tMin = now - windowMs;

  const timeToX = (t) => {
    const val = Number.isFinite(t) ? t : now;
    const clamped = Math.max(tMin, Math.min(now, val));
    const ratio = (clamped - tMin) / windowMs; // 0 to 1
    return MARGIN_LEFT + ratio * plotW;
  };

  // Build points string for Polyline
  const buildPoints = (dataArray, key) => {
    if (!Array.isArray(dataArray) || dataArray.length === 0) return "";
    const visible = dataArray.filter(
      (p) => p && Number.isFinite(p.t) && p.t >= tMin - 1000 && Number.isFinite(p[key])
    );
    return visible
      .map((p) => {
        const x = timeToX(p.t);
        const y = rssiToY(p[key]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  };

  const b1RawPoints = mode !== "filtered" ? buildPoints(history?.b1, "raw") : "";
  const b1FilteredPoints = mode !== "raw" ? buildPoints(history?.b1, "filtered") : "";

  const b2RawPoints = mode !== "filtered" ? buildPoints(history?.b2, "raw") : "";
  const b2FilteredPoints = mode !== "raw" ? buildPoints(history?.b2, "filtered") : "";

  // Visible recent markers for raw points (last 20 for performance)
  const visibleB1 = Array.isArray(history?.b1)
    ? history.b1.filter((p) => p && Number.isFinite(p.t) && p.t >= tMin && Number.isFinite(p.raw)).slice(-20)
    : [];
  const visibleB2 = Array.isArray(history?.b2)
    ? history.b2.filter((p) => p && Number.isFinite(p.t) && p.t >= tMin && Number.isFinite(p.raw)).slice(-20)
    : [];

  const hasData = (Array.isArray(history?.b1) && history.b1.length > 0) || (Array.isArray(history?.b2) && history.b2.length > 0);

  return (
    <View
      style={[styles.container, darkMode && styles.containerDark]}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (Number.isFinite(w) && w > 0 && Math.abs(w - layoutWidth) > 5) {
          setLayoutWidth(w);
        }
      }}
    >
      {/* Legend & Current RSSI Readout Header */}
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: b1Color }]} />
          <Text style={[styles.legendLabel, darkMode && styles.legendLabelDark]}>
            {b1Name || "Beacon 1"}:{" "}
            <Text style={{ fontWeight: "700", color: b1Color }}>
              {Number.isFinite(latestB1) ? `${latestB1} dBm` : "—"}
            </Text>
          </Text>
        </View>

        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: b2Color }]} />
          <Text style={[styles.legendLabel, darkMode && styles.legendLabelDark]}>
            {b2Name || "Beacon 2"}:{" "}
            <Text style={{ fontWeight: "700", color: b2Color }}>
              {Number.isFinite(latestB2) ? `${latestB2} dBm` : "—"}
            </Text>
          </Text>
        </View>

        <View style={[styles.windowBadge, darkMode && styles.windowBadgeDark]}>
          <Text style={[styles.windowBadgeText, darkMode && styles.windowBadgeTextDark]}>⏱ {windowSec}s Window</Text>
        </View>
      </View>

      {/* SVG Canvas */}
      <View style={styles.svgWrapper}>
        <Svg width={layoutWidth} height={DEFAULT_HEIGHT}>
          {/* Background plot rectangle */}
          <Rect
            x={MARGIN_LEFT}
            y={MARGIN_TOP}
            width={plotW}
            height={plotH}
            fill={darkMode ? "#0d1117" : "#f8fafc"}
            stroke={darkMode ? "#30363d" : "#e2e8f0"}
            strokeWidth="1"
            rx="6"
          />

          {/* Horizontal Grid lines with dBm labels */}
          {GRID_STEPS.map((step) => {
            const y = rssiToY(step);
            return (
              <G key={`grid-${step}`}>
                <Line
                  x1={MARGIN_LEFT}
                  y1={y}
                  x2={MARGIN_LEFT + plotW}
                  y2={y}
                  stroke={darkMode ? "#21262d" : "#cbd5e1"}
                  strokeWidth="0.8"
                  strokeDasharray="4,4"
                />
                <SvgText
                  x={MARGIN_LEFT - 6}
                  y={y + 3.5}
                  fontSize="9"
                  fill={darkMode ? "#8b949e" : "#64748b"}
                  textAnchor="end"
                  fontWeight="600"
                >
                  {step}
                </SvgText>
              </G>
            );
          })}

          {/* Time axis marks */}
          <SvgText
            x={MARGIN_LEFT + 2}
            y={DEFAULT_HEIGHT - 6}
            fontSize="9"
            fill={darkMode ? "#8b949e" : "#94a3b8"}
            textAnchor="start"
          >
            -{windowSec}s
          </SvgText>
          <SvgText
            x={MARGIN_LEFT + plotW / 2}
            y={DEFAULT_HEIGHT - 6}
            fontSize="9"
            fill={darkMode ? "#8b949e" : "#94a3b8"}
            textAnchor="middle"
          >
            -{Math.round(windowSec / 2)}s
          </SvgText>
          <SvgText
            x={MARGIN_LEFT + plotW}
            y={DEFAULT_HEIGHT - 6}
            fontSize="9"
            fill={darkMode ? "#8b949e" : "#94a3b8"}
            textAnchor="end"
            fontWeight="700"
          >
            Now
          </SvgText>

          {/* Plot Data Lines */}
          {hasData && (
            <>
              {/* BEACON 1 CURVES */}
              {/* Filtered smooth line */}
              {b1FilteredPoints.length > 0 && (
                <Polyline
                  points={b1FilteredPoints}
                  fill="none"
                  stroke={b1Color}
                  strokeWidth={mode === "both" ? "2.2" : "2.6"}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {/* Raw jittery line */}
              {b1RawPoints.length > 0 && (
                <Polyline
                  points={b1RawPoints}
                  fill="none"
                  stroke={mode === "both" ? (darkMode ? "rgba(56, 189, 248, 0.4)" : "rgba(9, 105, 218, 0.45)") : b1Color}
                  strokeWidth={mode === "both" ? "1.2" : "1.8"}
                  strokeDasharray={mode === "both" ? "2,2" : undefined}
                />
              )}

              {/* Raw sample dots for B1 */}
              {mode !== "filtered" &&
                visibleB1.map((p, idx) => (
                  <Circle
                    key={`b1-pt-${idx}`}
                    cx={timeToX(p.t)}
                    cy={rssiToY(p.raw)}
                    r="2.8"
                    fill={b1Color}
                    stroke={darkMode ? "#0d1117" : "#ffffff"}
                    strokeWidth="1"
                  />
                ))}

              {/* BEACON 2 CURVES */}
              {/* Filtered smooth line */}
              {b2FilteredPoints.length > 0 && (
                <Polyline
                  points={b2FilteredPoints}
                  fill="none"
                  stroke={b2Color}
                  strokeWidth={mode === "both" ? "2.2" : "2.6"}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {/* Raw jittery line */}
              {b2RawPoints.length > 0 && (
                <Polyline
                  points={b2RawPoints}
                  fill="none"
                  stroke={mode === "both" ? (darkMode ? "rgba(192, 132, 252, 0.4)" : "rgba(130, 80, 223, 0.45)") : b2Color}
                  strokeWidth={mode === "both" ? "1.2" : "1.8"}
                  strokeDasharray={mode === "both" ? "2,2" : undefined}
                />
              )}

              {/* Raw sample dots for B2 */}
              {mode !== "filtered" &&
                visibleB2.map((p, idx) => (
                  <Circle
                    key={`b2-pt-${idx}`}
                    cx={timeToX(p.t)}
                    cy={rssiToY(p.raw)}
                    r="2.8"
                    fill={b2Color}
                    stroke={darkMode ? "#0d1117" : "#ffffff"}
                    strokeWidth="1"
                  />
                ))}
            </>
          )}

          {/* Empty overlay if no data */}
          {!hasData && (
            <SvgText
              x={MARGIN_LEFT + plotW / 2}
              y={MARGIN_TOP + plotH / 2}
              fontSize="12"
              fill={darkMode ? "#6e7681" : "#94a3b8"}
              textAnchor="middle"
              fontWeight="500"
            >
              No beacon packets yet. Tap "Start BLE Scan" above.
            </SvgText>
          )}
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: "#e1e4e8",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    marginVertical: 6,
  },
  containerDark: {
    backgroundColor: "#161b22",
    borderColor: "#30363d",
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
    paddingHorizontal: 4,
    flexWrap: "wrap",
    gap: 6,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  legendLabel: {
    fontSize: 12,
    color: "#24292f",
    fontWeight: "500",
  },
  legendLabelDark: {
    color: "#e6edf3",
  },
  windowBadge: {
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  windowBadgeDark: {
    backgroundColor: "#21262d",
  },
  windowBadgeText: {
    fontSize: 10,
    color: "#64748b",
    fontWeight: "600",
  },
  windowBadgeTextDark: {
    color: "#8b949e",
  },
  svgWrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
});

