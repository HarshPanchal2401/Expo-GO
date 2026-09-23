// ============================================================================
// PdrTrackerScreen.js — Accurate PDR Dead Reckoning Dashboard (Version 2)
//
// Features:
//   1. 50 Hz Peak-Valley Accelerometer Step Detector with ZUPT stationary gating
//   2. Dynamic Weinberg Step Length Estimation (L = K · Δa^0.25)
//   3. Compass & Gyro Tilt-Compensated Heading with 0° zero calibration
//   4. Interactive 2D Path SVG Map with heading arrow, start/end pins, and grid
//   5. Drift-elimination Loop Closure algorithm
//   6. Route persistence (Save route, list, overlay previous paths, delete)
//   7. Magnetometer B-field vector diagnostics
//   8. Sleek dark cyber-industrial theme matching V2 Signal Lab and Fusion Map
// ============================================================================

import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Dimensions,
  Platform,
} from "react-native";
import Svg, {
  Polyline,
  Circle,
  Line,
  Polygon,
  Text as SvgText,
  Rect,
  Defs,
  LinearGradient,
  Stop,
} from "react-native-svg";

const SCREEN_WIDTH = Dimensions.get("window").width;

// Theme palette matching V2
const C = {
  bg: "#0d1117",
  card: "#161b22",
  cardAlt: "#1c2128",
  border: "#30363d",
  borderLight: "#21262d",
  text: "#e6edf3",
  textMuted: "#8b949e",
  textDim: "#484f58",
  accent: "#58a6ff",
  accentHover: "#1f6feb",
  green: "#3fb950",
  orange: "#d29922",
  red: "#f85149",
  purple: "#bc8cff",
};

export default function PdrTrackerScreen({
  steps = 0,
  heading = 0,
  position = { x: 0, y: 0 },
  totalDistance = 0,
  currentStepLength = 0.70,
  lastBounce = 0,
  liveBounce = 0,
  available = "Checking sensors...",
  status = "Ready",
  path = [{ x: 0, y: 0 }],
  magneticField = { x: 0, y: 0, z: 0, total: 0 },
  running = true,
  start,
  stop,
  reset,
  setZero,
  closeLoop,
  handleSavePath,
  addStep,
  savedPaths = [],
  selectedPreviousPath = null,
  handleTogglePreviousPath,
  handleDeletePath,
  handleClearAllPaths,
  appSettings = {},
}) {
  const weinbergK = appSettings?.weinbergK ?? 0.74;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>🚶 PDR Dead Reckoning</Text>
          <Text style={styles.subtitle}>
            Dynamic Weinberg Stride • Inertial FSM • Loop Closure
          </Text>
        </View>
        <View style={[styles.runningBadge, running ? styles.badgeActive : styles.badgeIdle]}>
          <Text style={[styles.badgeText, running ? { color: C.green } : { color: C.orange }]}>
            {running ? "● TRACKING ACTIVE" : "⏸ PAUSED"}
          </Text>
        </View>
      </View>

      {/* ── Sensor Status Bar ── */}
      <View style={styles.card}>
        <View style={styles.sensorRow}>
          <Text style={styles.cardLabel}>HARDWARE SENSORS</Text>
          <Text style={styles.sensorInfo}>{available}</Text>
        </View>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      {/* ── Primary Metrics Grid ── */}
      <View style={styles.gridRow}>
        <MetricCard
          label="CONFIRMED STEPS"
          value={String(steps)}
          unit="steps"
          color={C.accent}
        />
        <MetricCard
          label="HEADING"
          value={`${heading >= 0 ? "+" : ""}${heading.toFixed(1)}°`}
          unit={heading >= 0 ? "CW" : "CCW"}
          color={C.purple}
        />
      </View>

      <View style={styles.gridRow}>
        <MetricCard
          label="X POSITION"
          value={`${position.x.toFixed(2)}`}
          unit="meters"
          color={C.text}
        />
        <MetricCard
          label="Y POSITION"
          value={`${position.y.toFixed(2)}`}
          unit="meters"
          color={C.text}
        />
      </View>

      <View style={styles.gridRow}>
        <MetricCard
          label="TOTAL DISTANCE"
          value={`${totalDistance.toFixed(2)}`}
          unit="meters"
          color={C.green}
        />
        <MetricCard
          label="DYNAMIC STRIDE"
          value={`${currentStepLength.toFixed(2)}`}
          unit="meters/step"
          color={C.orange}
        />
      </View>

      {/* ── Dynamic Weinberg Sensor Info & Test Step ── */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardLabel}>WEINBERG STRIDE ESTIMATION</Text>
          <View style={styles.pillBadge}>
            <Text style={styles.pillBadgeText}>K = {weinbergK.toFixed(2)}</Text>
          </View>
        </View>
        <Text style={styles.cardNote}>
          Stride length updates on every step via dynamic bounce amplitude
          {lastBounce > 0 ? ` (Last Swing: ${lastBounce.toFixed(2)}g)` : ""}.
        </Text>

        {/* Live Motion Activity Energy Bar */}
        <View style={styles.bounceMeterContainer}>
          <View style={styles.bounceMeterHeader}>
            <Text style={styles.bounceMeterLabel}>LIVE MOTION ACCELERATION</Text>
            <Text style={[styles.bounceMeterValue, liveBounce > 0.05 && { color: C.green }]}>
              {liveBounce.toFixed(3)} g
            </Text>
          </View>
          <View style={styles.bounceTrack}>
            <View
              style={[
                styles.bounceBar,
                {
                  width: `${Math.min(100, Math.max(4, (liveBounce / 0.30) * 100)).toFixed(0)}%`,
                  backgroundColor: liveBounce > 0.05 ? C.green : C.accent,
                },
              ]}
            />
          </View>
        </View>

        <Pressable
          onPress={() => addStep && addStep(0.70, 0.45)}
          style={({ pressed }) => [styles.testStepBtn, pressed && styles.btnPressed]}
        >
          <Text style={styles.testStepBtnText}>👣 Add Manual Test Step (0.70m)</Text>
        </Pressable>
      </View>

      {/* ── 2D Path Canvas ── */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardLabel}>2D TRAJECTORY CANVAS</Text>
          <Text style={styles.coordLabel}>
            ({position.x.toFixed(2)}, {position.y.toFixed(2)}) m
          </Text>
        </View>
        <PathCanvas points={path} heading={heading} previousPath={selectedPreviousPath} />
      </View>

      {/* ── Primary Action Controls ── */}
      <View style={styles.buttonRow}>
        <Pressable
          onPress={setZero}
          style={({ pressed }) => [styles.actionBtn, styles.btnOutline, pressed && styles.btnPressed]}
        >
          <Text style={styles.actionBtnText}>🎯 Set Zero</Text>
        </Pressable>

        <Pressable
          onPress={running ? stop : start}
          style={({ pressed }) => [
            styles.actionBtn,
            running ? styles.btnPause : styles.btnStart,
            pressed && styles.btnPressed,
          ]}
        >
          <Text style={[styles.actionBtnText, { color: "#ffffff", fontWeight: "800" }]}>
            {running ? "⏸ Pause Tracking" : "▶ Resume Tracking"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.buttonRow}>
        <Pressable
          onPress={handleSavePath}
          style={({ pressed }) => [styles.actionBtn, styles.btnSave, pressed && styles.btnPressed]}
        >
          <Text style={[styles.actionBtnText, { color: "#ffffff" }]}>💾 Save Route</Text>
        </Pressable>

        <Pressable
          onPress={closeLoop}
          style={({ pressed }) => [styles.actionBtn, styles.btnOutline, pressed && styles.btnPressed]}
        >
          <Text style={styles.actionBtnText}>🔄 Close Loop</Text>
        </Pressable>

        <Pressable
          onPress={reset}
          style={({ pressed }) => [styles.actionBtn, styles.btnOutline, pressed && styles.btnPressed]}
        >
          <Text style={styles.actionBtnText}>🗑 Reset</Text>
        </Pressable>
      </View>

      {/* ── Magnetometer Diagnostics ── */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardLabel}>MAGNETOMETER FLUX</Text>
          <Text style={styles.bFieldTotal}>{magneticField.total} μT</Text>
        </View>
        <Text style={styles.vectorText}>
          X: {magneticField.x} μT  •  Y: {magneticField.y} μT  •  Z: {magneticField.z} μT
        </Text>
      </View>

      {/* ── Live Waypoints History ── */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>WAYPOINTS BUFFER ({path.length} PTS)</Text>
        <ScrollView style={styles.waypointsList} nestedScrollEnabled>
          {path.map((pt, idx) => (
            <Text
              key={idx}
              style={[
                styles.waypointItem,
                idx === path.length - 1 ? styles.waypointActive : styles.waypointHistory,
              ]}
            >
              #{idx.toString().padStart(3, "0")}: X={pt.x.toFixed(2)}m, Y={pt.y.toFixed(2)}m{" "}
              {idx === 0 ? "🏁 [ORIGIN]" : idx === path.length - 1 ? "📍 [CURRENT]" : ""}
            </Text>
          ))}
        </ScrollView>
      </View>

      {/* ── Saved Paths History ── */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.cardLabel}>SAVED ROUTES ({savedPaths.length})</Text>
          {savedPaths.length > 0 && (
            <Pressable onPress={handleClearAllPaths}>
              <Text style={styles.clearText}>Clear All</Text>
            </Pressable>
          )}
        </View>

        {savedPaths.length === 0 ? (
          <Text style={styles.emptyText}>
            No saved routes yet. Walk a route and tap "Save Route" to store it here.
          </Text>
        ) : (
          <ScrollView style={styles.savedPathsList} nestedScrollEnabled>
            {savedPaths.map((item) => {
              const isSelected = selectedPreviousPath?.id === item.id;
              return (
                <View
                  key={item.id}
                  style={[styles.savedRouteCard, isSelected && styles.savedRouteCardActive]}
                >
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <Text style={styles.savedRouteTitle}>{item.name}</Text>
                    <Text style={styles.savedRouteMeta}>{item.timestamp}</Text>
                    <Text style={styles.savedRouteStats}>
                      {item.steps} steps • {item.distance.toFixed(2)}m • {item.points?.length || 0} pts
                    </Text>
                  </View>
                  <View style={styles.savedRouteActions}>
                    <Pressable
                      onPress={() => handleTogglePreviousPath(item)}
                      style={[styles.smallBtn, isSelected ? styles.smallBtnActive : styles.smallBtnOutline]}
                    >
                      <Text style={[styles.smallBtnText, isSelected && { color: "#ffffff" }]}>
                        {isSelected ? "Hide" : "Overlay"}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleDeletePath(item.id)}
                      style={[styles.smallBtn, styles.smallBtnDanger]}
                    >
                      <Text style={[styles.smallBtnText, { color: C.red }]}>Delete</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* ── Instructions Guide ── */}
      <View style={[styles.card, { marginBottom: 32 }]}>
        <Text style={styles.cardLabel}>QUICK USAGE GUIDE</Text>
        <Text style={styles.guideText}>
          1. Hold phone steady in front of you facing forward.{"\n"}
          2. Tap <Text style={{ color: C.accent, fontWeight: "700" }}>"Set Zero"</Text> to calibrate forward heading (0°).{"\n"}
          3. Tap <Text style={{ color: C.green, fontWeight: "700" }}>"Start Tracking"</Text> and walk naturally.{"\n"}
          4. Dynamic step lengths and coordinates stream live into both this canvas and the <Text style={{ color: C.accent, fontWeight: "700" }}>Fusion Map</Text>.
        </Text>
      </View>
    </ScrollView>
  );
}

// ── Metric Card Component ──
function MetricCard({ label, value, unit, color = C.accent }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <View style={styles.metricValueRow}>
        <Text style={[styles.metricValue, { color }]}>{value}</Text>
        {unit ? <Text style={styles.metricUnit}>{unit}</Text> : null}
      </View>
    </View>
  );
}

// ── 2D Path Canvas ──
function PathCanvas({ points, heading, previousPath }) {
  const canvasWidth = Math.max(280, Math.min(SCREEN_WIDTH - 48, 520));
  const canvasHeight = 320;
  const pad = 36;

  const validPts = points && points.length > 0 ? points : [{ x: 0, y: 0 }];
  let allPts = [...validPts];
  if (previousPath?.points?.length > 0) {
    allPts = [...allPts, ...previousPath.points];
  }

  let minX = 0,
    maxX = 0,
    minY = 0,
    maxY = 0;
  allPts.forEach((p) => {
    if (typeof p?.x === "number") {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    if (typeof p?.y === "number") {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  });

  const spanX = Math.max(4.0, maxX - minX);
  const spanY = Math.max(4.0, maxY - minY);
  const scale = Math.min((canvasWidth - pad * 2) / spanX, (canvasHeight - pad * 2) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const toCanvas = (p) => ({
    x: canvasWidth / 2 + (p.x - cx) * scale,
    y: canvasHeight / 2 - (p.y - cy) * scale, // SVG y is inverted
  });

  const originCanvas = toCanvas({ x: 0, y: 0 });
  const curPos = validPts[validPts.length - 1];
  const curCanvas = toCanvas(curPos);

  const polylineStr = validPts
    .map((p) => {
      const c = toCanvas(p);
      return `${c.x.toFixed(1)},${c.y.toFixed(1)}`;
    })
    .join(" ");

  const prevPolylineStr =
    previousPath?.points?.length > 1
      ? previousPath.points
          .map((p) => {
            const c = toCanvas(p);
            return `${c.x.toFixed(1)},${c.y.toFixed(1)}`;
          })
          .join(" ")
      : null;

  // Arrow calculations for heading
  const arrowLen = 22;
  const rad = (heading * Math.PI) / 180;
  const tipX = curCanvas.x + arrowLen * Math.sin(rad);
  const tipY = curCanvas.y - arrowLen * Math.cos(rad);

  const wingAngle = Math.PI / 6;
  const wingLen = 10;
  const wing1X = tipX - wingLen * Math.sin(rad - wingAngle);
  const wing1Y = tipY + wingLen * Math.cos(rad - wingAngle);
  const wing2X = tipX - wingLen * Math.sin(rad + wingAngle);
  const wing2Y = tipY + wingLen * Math.cos(rad + wingAngle);

  return (
    <View style={styles.canvasContainer}>
      <Svg width={canvasWidth} height={canvasHeight}>
        <Defs>
          <LinearGradient id="pathGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#58a6ff" />
            <Stop offset="100%" stopColor="#3fb950" />
          </LinearGradient>
        </Defs>

        {/* Background */}
        <Rect x={0} y={0} width={canvasWidth} height={canvasHeight} fill="#0d1117" rx={8} />

        {/* Grid lines (faint) */}
        {[-3, -2, -1, 0, 1, 2, 3].map((offset) => {
          const gx = canvasWidth / 2 + offset * 1.5 * scale;
          const gy = canvasHeight / 2 + offset * 1.5 * scale;
          return (
            <React.Fragment key={offset}>
              {gx >= 0 && gx <= canvasWidth && (
                <Line
                  x1={gx}
                  y1={0}
                  x2={gx}
                  y2={canvasHeight}
                  stroke="#21262d"
                  strokeWidth={0.7}
                  strokeDasharray="3,3"
                />
              )}
              {gy >= 0 && gy <= canvasHeight && (
                <Line
                  x1={0}
                  y1={gy}
                  x2={canvasWidth}
                  y2={gy}
                  stroke="#21262d"
                  strokeWidth={0.7}
                  strokeDasharray="3,3"
                />
              )}
            </React.Fragment>
          );
        })}

        {/* Origin Axes */}
        <Line
          x1={originCanvas.x}
          y1={0}
          x2={originCanvas.x}
          y2={canvasHeight}
          stroke="#30363d"
          strokeWidth={1}
        />
        <Line
          x1={0}
          y1={originCanvas.y}
          x2={canvasWidth}
          y2={originCanvas.y}
          stroke="#30363d"
          strokeWidth={1}
        />

        {/* Previous Saved Path Overlay (if selected) */}
        {prevPolylineStr && (
          <Polyline
            points={prevPolylineStr}
            fill="none"
            stroke="#8b949e"
            strokeWidth={2}
            strokeDasharray="4,4"
            strokeOpacity={0.6}
          />
        )}

        {/* Current Active Path */}
        {polylineStr ? (
          <Polyline
            points={polylineStr}
            fill="none"
            stroke="url(#pathGradient)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}

        {/* Origin Marker */}
        <Circle cx={originCanvas.x} cy={originCanvas.y} r={6} fill="#bc8cff" />
        <Circle cx={originCanvas.x} cy={originCanvas.y} r={9} fill="none" stroke="#bc8cff" strokeWidth={1} />
        <SvgText
          x={originCanvas.x + 8}
          y={originCanvas.y - 6}
          fontSize={10}
          fill="#bc8cff"
          fontWeight="bold"
        >
          (0,0)
        </SvgText>

        {/* Current Position Marker */}
        <Circle cx={curCanvas.x} cy={curCanvas.y} r={7} fill="#3fb950" />
        <Circle cx={curCanvas.x} cy={curCanvas.y} r={12} fill="none" stroke="#3fb950" strokeWidth={1.5} opacity={0.6} />

        {/* Direction Orientation Arrow */}
        <Line
          x1={curCanvas.x}
          y1={curCanvas.y}
          x2={tipX}
          y2={tipY}
          stroke="#58a6ff"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        <Polygon
          points={`${tipX},${tipY} ${wing1X},${wing1Y} ${wing2X},${wing2Y}`}
          fill="#58a6ff"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: C.bg,
  },
  container: {
    padding: 16,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: C.text,
  },
  subtitle: {
    fontSize: 12,
    color: C.textMuted,
    marginTop: 2,
  },
  runningBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  badgeActive: {
    backgroundColor: "#163c1e",
    borderColor: C.green,
  },
  badgeIdle: {
    backgroundColor: "#21262d",
    borderColor: C.border,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: C.card,
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 12,
  },
  sensorRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: C.textMuted,
    letterSpacing: 0.8,
  },
  sensorInfo: {
    fontSize: 12,
    color: C.accent,
    fontWeight: "600",
  },
  statusText: {
    fontSize: 13,
    color: C.text,
    fontFamily: Platform.OS === "android" ? "monospace" : "Menlo",
    marginTop: 2,
  },
  gridRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 10,
  },
  metricCard: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: C.textMuted,
    letterSpacing: 0.6,
  },
  metricValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
    marginTop: 4,
  },
  metricValue: {
    fontSize: 20,
    fontWeight: "800",
  },
  metricUnit: {
    fontSize: 11,
    color: C.textMuted,
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  pillBadge: {
    backgroundColor: "#1f6feb22",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.accent,
  },
  pillBadgeText: {
    fontSize: 11,
    color: C.accent,
    fontWeight: "700",
  },
  cardNote: {
    fontSize: 12,
    color: C.textMuted,
    marginBottom: 8,
  },
  bounceMeterContainer: {
    backgroundColor: C.cardAlt,
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: C.borderLight,
  },
  bounceMeterHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  bounceMeterLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: C.textMuted,
    letterSpacing: 0.5,
  },
  bounceMeterValue: {
    fontSize: 12,
    fontWeight: "800",
    color: C.accent,
    fontFamily: Platform.OS === "android" ? "monospace" : "Menlo",
  },
  bounceTrack: {
    height: 6,
    backgroundColor: "#21262d",
    borderRadius: 3,
    overflow: "hidden",
  },
  bounceBar: {
    height: "100%",
    borderRadius: 3,
  },
  testStepBtn: {
    backgroundColor: C.cardAlt,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: C.border,
  },
  testStepBtnText: {
    color: C.accent,
    fontWeight: "700",
    fontSize: 13,
  },
  coordLabel: {
    fontSize: 12,
    color: C.green,
    fontWeight: "700",
    fontFamily: Platform.OS === "android" ? "monospace" : "Menlo",
  },
  canvasContainer: {
    alignItems: "center",
    marginTop: 4,
    borderRadius: 8,
    overflow: "hidden",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  btnOutline: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
  },
  btnStart: {
    backgroundColor: "#238636",
    borderWidth: 1,
    borderColor: C.green,
  },
  btnPause: {
    backgroundColor: "#9e6a03",
    borderWidth: 1,
    borderColor: C.orange,
  },
  btnStop: {
    backgroundColor: "#da3633",
    borderWidth: 1,
    borderColor: C.red,
  },
  btnSave: {
    backgroundColor: "#1f6feb",
    borderWidth: 1,
    borderColor: C.accent,
  },
  actionBtnText: {
    color: C.text,
    fontSize: 13,
    fontWeight: "700",
  },
  btnPressed: {
    opacity: 0.7,
  },
  bFieldTotal: {
    fontSize: 13,
    color: C.accent,
    fontWeight: "700",
  },
  vectorText: {
    fontSize: 12,
    color: C.textMuted,
    fontFamily: Platform.OS === "android" ? "monospace" : "Menlo",
    marginTop: 2,
  },
  waypointsList: {
    maxHeight: 110,
    marginTop: 6,
  },
  waypointItem: {
    fontSize: 11,
    fontFamily: Platform.OS === "android" ? "monospace" : "Menlo",
    paddingVertical: 2,
  },
  waypointActive: {
    color: C.accent,
    fontWeight: "700",
  },
  waypointHistory: {
    color: C.textDim,
  },
  clearText: {
    fontSize: 11,
    color: C.red,
    fontWeight: "700",
  },
  emptyText: {
    fontSize: 12,
    color: C.textMuted,
    fontStyle: "italic",
    marginTop: 4,
  },
  savedPathsList: {
    maxHeight: 180,
    marginTop: 6,
  },
  savedRouteCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.cardAlt,
    borderRadius: 6,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: C.borderLight,
  },
  savedRouteCardActive: {
    borderColor: C.accent,
    backgroundColor: "#1f6feb15",
  },
  savedRouteTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: C.text,
  },
  savedRouteMeta: {
    fontSize: 11,
    color: C.textMuted,
    marginTop: 1,
  },
  savedRouteStats: {
    fontSize: 11,
    color: C.green,
    marginTop: 2,
    fontWeight: "600",
  },
  savedRouteActions: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  smallBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 5,
  },
  smallBtnOutline: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
  },
  smallBtnActive: {
    backgroundColor: C.accent,
  },
  smallBtnDanger: {
    backgroundColor: "#da363318",
    borderWidth: 1,
    borderColor: "#da363355",
  },
  smallBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: C.text,
  },
  guideText: {
    fontSize: 12,
    color: C.textMuted,
    lineHeight: 18,
    marginTop: 4,
  },
});
