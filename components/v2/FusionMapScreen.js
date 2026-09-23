// ============================================================================
// FusionMapScreen.js — Live PDR + BLE Fusion Navigation Map (Version 2)
//
// 3-step setup wizard:
//   Step 1: Define place size (width × height in metres)
//   Step 2: Place beacons (set anchor (x,y) for each)
//   Step 3: Start fusion tracking
//
// Live SVG 2D canvas:
//   • To-scale room boundary rectangle
//   • Beacon icons at anchor positions
//   • User dot + uncertainty halo
//   • Movement trail (last 80 positions)
//   • Distance rings around each beacon
// ============================================================================

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Switch,
  Dimensions,
  Alert,
} from "react-native";
import Svg, {
  Rect,
  Circle,
  Polyline,
  Line,
  Text as SvgText,
  Defs,
  RadialGradient,
  Stop,
  G,
} from "react-native-svg";
import { fusionEngine } from "../../services/FusionEngine.js";
import { v2Scanner } from "../../services/v2BeaconScannerService.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const SCREEN_W = Dimensions.get("window").width;
const MAP_PADDING = 28; // canvas margin (px)
const MAP_SIZE = SCREEN_W - 32; // square canvas width (px)
const CANVAS_SIZE = MAP_SIZE - MAP_PADDING * 2; // drawable area

const TRAIL_OPACITY_MIN = 0.12;
const TRAIL_OPACITY_MAX = 0.80;
const BEACON_RADIUS_PX = 14;
const USER_DOT_RADIUS = 9;

// Color palette
const C = {
  bg: "#0d1117",
  surface: "#161b22",
  surfaceAlt: "#1c2128",
  border: "#30363d",
  accent: "#58a6ff",
  accentGreen: "#3fb950",
  accentOrange: "#d29922",
  accentRed: "#f85149",
  beacon1: "#58a6ff",
  beacon2: "#bc8cff",
  userDot: "#3fb950",
  halo: "#3fb950",
  trail: "#3fb950",
  roomBorder: "#30363d",
  textPrimary: "#e6edf3",
  textSecondary: "#8b949e",
  textMuted: "#484f58",
  stepActive: "#1f6feb",
  stepDone: "#238636",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function parseFloatSafe(str, fallback = 0) {
  const v = parseFloat(str);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Compute the scale factor and offsets to convert world metres to canvas pixels.
 * The room rectangle is centred in the canvas with equal margins.
 */
function computeTransform(roomW, roomH, canvasSize) {
  const scaleX = canvasSize / roomW;
  const scaleY = canvasSize / roomH;
  const scale = Math.min(scaleX, scaleY) * 0.88; // 88% fill with breathing room
  const offsetX = (canvasSize - roomW * scale) / 2;
  const offsetY = (canvasSize - roomH * scale) / 2;
  return { scale, offsetX, offsetY };
}

function worldToCanvas(wx, wy, transform) {
  return {
    cx: MAP_PADDING + transform.offsetX + wx * transform.scale,
    cy: MAP_PADDING + transform.offsetY + wy * transform.scale,
  };
}

// ─── Step Header ─────────────────────────────────────────────────────────────

function StepBadge({ num, active, done }) {
  const bg = done ? C.stepDone : active ? C.stepActive : C.surfaceAlt;
  const borderColor = done ? C.accentGreen : active ? C.accent : C.border;
  return (
    <View style={[styles.stepBadge, { backgroundColor: bg, borderColor }]}>
      <Text style={styles.stepBadgeText}>{done ? "✓" : num}</Text>
    </View>
  );
}

function WizardStepHeader({ stepNum, title, subtitle, currentStep }) {
  const active = currentStep === stepNum;
  const done = currentStep > stepNum;
  return (
    <View style={styles.stepHeader}>
      <StepBadge num={stepNum} active={active} done={done} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={[styles.stepTitle, active && { color: C.textPrimary }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.stepSubtitle}>{subtitle}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ─── Metric Card ─────────────────────────────────────────────────────────────

function MetricPill({ label, value, color = C.accent }) {
  return (
    <View style={styles.metricPill}>
      <Text style={styles.metricPillLabel}>{label}</Text>
      <Text style={[styles.metricPillValue, { color }]}>{value}</Text>
    </View>
  );
}

// ─── Live Fusion Map SVG ──────────────────────────────────────────────────────

function FusionMapCanvas({ roomW, roomH, anchor1, anchor2, fusionState, d1, d2 }) {
  const { x, y, uncertaintyRadius, trail } = fusionState;
  const transform = useMemo(
    () => computeTransform(roomW, roomH, CANVAS_SIZE),
    [roomW, roomH]
  );

  // Convert world coords to canvas pixels
  const toCanvas = useCallback(
    (wx, wy) => worldToCanvas(wx, wy, transform),
    [transform]
  );

  const roomPx = {
    x: MAP_PADDING + transform.offsetX,
    y: MAP_PADDING + transform.offsetY,
    w: roomW * transform.scale,
    h: roomH * transform.scale,
  };

  const b1px = toCanvas(anchor1.x, anchor1.y);
  const b2px = toCanvas(anchor2.x, anchor2.y);
  const userpx = toCanvas(x, y);
  const haloPx = uncertaintyRadius * transform.scale;

  // Trail polyline points
  const trailPoints = trail
    .map((pt) => {
      const { cx, cy } = toCanvas(pt.x, pt.y);
      return `${cx.toFixed(1)},${cy.toFixed(1)}`;
    })
    .join(" ");

  // Live distance ring radii from actual beacon measurements
  // Only draw if valid
  const ring1Px = Number.isFinite(d1) && d1 > 0 ? d1 * transform.scale : null;
  const ring2Px = Number.isFinite(d2) && d2 > 0 ? d2 * transform.scale : null;

  // Reference grid rings (faint) at 1m, 2m, 3m
  const refRings = [1, 2, 3];

  return (
    <View style={styles.mapCanvasWrapper}>
      <Svg width={MAP_SIZE} height={MAP_SIZE}>
        <Defs>
          {/* User halo gradient */}
          <RadialGradient id="haloGrad" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={C.halo} stopOpacity="0.25" />
            <Stop offset="100%" stopColor={C.halo} stopOpacity="0.00" />
          </RadialGradient>
          {/* Beacon 1 glow */}
          <RadialGradient id="b1Glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={C.beacon1} stopOpacity="0.35" />
            <Stop offset="100%" stopColor={C.beacon1} stopOpacity="0.00" />
          </RadialGradient>
          {/* Beacon 2 glow */}
          <RadialGradient id="b2Glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={C.beacon2} stopOpacity="0.35" />
            <Stop offset="100%" stopColor={C.beacon2} stopOpacity="0.00" />
          </RadialGradient>
        </Defs>

        {/* ── Room boundary ── */}
        <Rect
          x={roomPx.x}
          y={roomPx.y}
          width={roomPx.w}
          height={roomPx.h}
          fill="#0d1117"
          stroke={C.roomBorder}
          strokeWidth={1.5}
          rx={4}
        />

        {/* ── Grid lines (every 1 m) ── */}
        {Array.from({ length: Math.floor(roomW) }).map((_, i) => {
          const wx = i + 1;
          if (wx >= roomW) return null;
          const { cx } = toCanvas(wx, 0);
          return (
            <Line
              key={`vg${i}`}
              x1={cx} y1={roomPx.y}
              x2={cx} y2={roomPx.y + roomPx.h}
              stroke={C.border} strokeWidth={0.5} strokeDasharray="3,4"
            />
          );
        })}
        {Array.from({ length: Math.floor(roomH) }).map((_, i) => {
          const wy = i + 1;
          if (wy >= roomH) return null;
          const { cy } = toCanvas(0, wy);
          return (
            <Line
              key={`hg${i}`}
              x1={roomPx.x} y1={cy}
              x2={roomPx.x + roomPx.w} y2={cy}
              stroke={C.border} strokeWidth={0.5} strokeDasharray="3,4"
            />
          );
        })}

        {/* ── Reference distance rings (faint, every 1 m) ── */}
        {refRings.map((dm) => (
          <Circle
            key={`b1ref${dm}`}
            cx={b1px.cx} cy={b1px.cy}
            r={dm * transform.scale}
            fill="none" stroke={C.beacon1} strokeWidth={0.4}
            strokeDasharray="2,6" strokeOpacity={0.15}
          />
        ))}
        {refRings.map((dm) => (
          <Circle
            key={`b2ref${dm}`}
            cx={b2px.cx} cy={b2px.cy}
            r={dm * transform.scale}
            fill="none" stroke={C.beacon2} strokeWidth={0.4}
            strokeDasharray="2,6" strokeOpacity={0.15}
          />
        ))}

        {/* ── LIVE measured distance rings (actual d1 / d2 from BLE) ── */}
        {ring1Px !== null && (
          <>
            <Circle
              cx={b1px.cx} cy={b1px.cy}
              r={Math.min(ring1Px, CANVAS_SIZE * 1.5)}
              fill="none" stroke={C.beacon1} strokeWidth={2}
              strokeDasharray="6,4" strokeOpacity={0.75}
            />
            {/* Distance label on the ring */}
            <SvgText
              x={b1px.cx + Math.min(ring1Px, CANVAS_SIZE * 0.45)}
              y={b1px.cy - 4}
              fontSize={10} fill={C.beacon1} fontWeight="bold"
            >
              {`${d1.toFixed(2)}m`}
            </SvgText>
          </>
        )}
        {ring2Px !== null && (
          <>
            <Circle
              cx={b2px.cx} cy={b2px.cy}
              r={Math.min(ring2Px, CANVAS_SIZE * 1.5)}
              fill="none" stroke={C.beacon2} strokeWidth={2}
              strokeDasharray="6,4" strokeOpacity={0.75}
            />
            <SvgText
              x={b2px.cx - Math.min(ring2Px, CANVAS_SIZE * 0.45)}
              y={b2px.cy - 4}
              fontSize={10} fill={C.beacon2} fontWeight="bold"
            >
              {`${d2.toFixed(2)}m`}
            </SvgText>
          </>
        )}

        {/* ── Distance lines: beacon → user dot ── */}
        {ring1Px !== null && (
          <Line
            x1={b1px.cx} y1={b1px.cy}
            x2={userpx.cx} y2={userpx.cy}
            stroke={C.beacon1} strokeWidth={1}
            strokeDasharray="3,4" strokeOpacity={0.4}
          />
        )}
        {ring2Px !== null && (
          <Line
            x1={b2px.cx} y1={b2px.cy}
            x2={userpx.cx} y2={userpx.cy}
            stroke={C.beacon2} strokeWidth={1}
            strokeDasharray="3,4" strokeOpacity={0.4}
          />
        )}

        {/* ── Beacon glows ── */}
        <Circle cx={b1px.cx} cy={b1px.cy} r={BEACON_RADIUS_PX * 2.5} fill="url(#b1Glow)" />
        <Circle cx={b2px.cx} cy={b2px.cy} r={BEACON_RADIUS_PX * 2.5} fill="url(#b2Glow)" />

        {/* ── Trail ── */}
        {trail.length > 1 && (
          <Polyline
            points={trailPoints}
            fill="none"
            stroke={C.trail}
            strokeWidth={2.5}
            strokeOpacity={0.55}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* ── User uncertainty halo ── */}
        {haloPx > 2 && (
          <Circle
            cx={userpx.cx} cy={userpx.cy}
            r={Math.min(haloPx, CANVAS_SIZE)}
            fill="url(#haloGrad)"
          />
        )}

        {/* ── Beacon 1 icon ── */}
        <Circle cx={b1px.cx} cy={b1px.cy} r={BEACON_RADIUS_PX} fill={C.beacon1} fillOpacity={0.9} />
        <SvgText x={b1px.cx} y={b1px.cy + 4.5} textAnchor="middle" fontSize={10} fill="#fff" fontWeight="bold">B1</SvgText>
        <SvgText x={b1px.cx} y={b1px.cy + BEACON_RADIUS_PX + 12} textAnchor="middle" fontSize={9} fill={C.beacon1}>
          {`(${anchor1.x},${anchor1.y})`}
        </SvgText>

        {/* ── Beacon 2 icon ── */}
        <Circle cx={b2px.cx} cy={b2px.cy} r={BEACON_RADIUS_PX} fill={C.beacon2} fillOpacity={0.9} />
        <SvgText x={b2px.cx} y={b2px.cy + 4.5} textAnchor="middle" fontSize={10} fill="#fff" fontWeight="bold">B2</SvgText>
        <SvgText x={b2px.cx} y={b2px.cy + BEACON_RADIUS_PX + 12} textAnchor="middle" fontSize={9} fill={C.beacon2}>
          {`(${anchor2.x},${anchor2.y})`}
        </SvgText>

        {/* ── User position dot ── */}
        <Circle cx={userpx.cx} cy={userpx.cy} r={USER_DOT_RADIUS + 4} fill={C.userDot} fillOpacity={0.2} />
        <Circle cx={userpx.cx} cy={userpx.cy} r={USER_DOT_RADIUS} fill={C.userDot} />
        <Circle cx={userpx.cx} cy={userpx.cy} r={USER_DOT_RADIUS - 3} fill="#fff" fillOpacity={0.6} />

        {/* ── Room size label ── */}
        <SvgText
          x={roomPx.x + roomPx.w / 2}
          y={roomPx.y + roomPx.h + 16}
          textAnchor="middle"
          fontSize={9}
          fill={C.textMuted}
        >
          {`${roomW} m × ${roomH} m`}
        </SvgText>
      </Svg>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function FusionMapScreen({ pdrStepCallbackRef, headingRef }) {
  // ── Setup wizard state ──
  const [wizardStep, setWizardStep] = useState("running"); // "running" | 1 | 2

  // Step 1 — Place size
  const [roomWidthStr, setRoomWidthStr] = useState("8");
  const [roomHeightStr, setRoomHeightStr] = useState("6");

  // Step 2 — Beacon anchors
  const [b1XStr, setB1XStr] = useState("0");
  const [b1YStr, setB1YStr] = useState("0");
  const [b2XStr, setB2XStr] = useState("8");  // auto-filled from room width
  const [b2YStr, setB2YStr] = useState("0");

  // Step 3 / Running
  const [isRunning, setIsRunning] = useState(true);
  const [fusionState, setFusionState] = useState(() => {
    // Cold start in center of default 8x6 room (x=4, y=3) so user is not clamped in corner
    fusionEngine.reset(4.0, 3.0);
    fusionEngine.setRoomSize(8, 6);
    fusionEngine.setBleAnchors({ x: 0, y: 0 }, { x: 8, y: 0 });
    return { ...fusionEngine.getState() };
  });

  // BLE stats subscription
  const [bleStats, setBleStats] = useState({ b1: null, b2: null });

  const tickIntervalRef = useRef(null);
  const statsUnsubRef = useRef(null);

  // Derived values
  const roomW = parseFloatSafe(roomWidthStr, 8);
  const roomH = parseFloatSafe(roomHeightStr, 6);
  const anchor1 = {
    x: parseFloatSafe(b1XStr, 0),
    y: parseFloatSafe(b1YStr, 0),
  };
  const anchor2 = {
    x: parseFloatSafe(b2XStr, roomW),
    y: parseFloatSafe(b2YStr, 0),
  };

  // ── Load saved config on mount ──
  useEffect(() => {
    (async () => {
      const [size, anchors] = await Promise.all([
        v2Scanner.getPlaceSize(),
        v2Scanner.getBeaconAnchors(),
      ]);
      if (size) {
        setRoomWidthStr(String(size.widthM));
        setRoomHeightStr(String(size.heightM));
        if (!anchors) setB2XStr(String(size.widthM));
        fusionEngine.setRoomSize(size.widthM, size.heightM);
      }
      if (anchors) {
        setB1XStr(String(anchors.b1.x));
        setB1YStr(String(anchors.b1.y));
        setB2XStr(String(anchors.b2.x));
        setB2YStr(String(anchors.b2.y));
        fusionEngine.setBleAnchors(anchors.b1, anchors.b2);
      }
      setWizardStep("running");
      setIsRunning(true);
    })();
  }, []);

  // Auto-fill B2 X when room width changes and B2 X is still default
  useEffect(() => {
    if (wizardStep === 1 || wizardStep === 2) {
      setB2XStr(String(roomW));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomW]);

  // ── BLE stats subscription ──
  useEffect(() => {
    statsUnsubRef.current = v2Scanner.subscribeStats((stats) => {
      setBleStats({ b1: stats.b1, b2: stats.b2 });

      if (isRunning) {
        const d1 = stats.b1?.distanceM;
        const d2 = stats.b2?.distanceM;
        const c1 = stats.b1?.confidenceScore ?? 0;
        const c2 = stats.b2?.confidenceScore ?? 0;
        if (Number.isFinite(d1) && Number.isFinite(d2)) {
          fusionEngine.correct(d1, d2, c1, c2);
          setFusionState({ ...fusionEngine.getState() });
        }
      }
    });
    return () => statsUnsubRef.current?.();
  }, [isRunning]);

  // ── PDR step hook ──
  useEffect(() => {
    if (pdrStepCallbackRef) {
      pdrStepCallbackRef.current = ({ stepLengthMeters, heading }) => {
        fusionEngine.predict(stepLengthMeters, heading);
        setFusionState({ ...fusionEngine.getState() });
      };
      return () => {
        pdrStepCallbackRef.current = null;
      };
    }
  }, [pdrStepCallbackRef]);

  // ── Tick interval (passive drift + UI refresh) ──
  useEffect(() => {
    if (isRunning) {
      tickIntervalRef.current = setInterval(() => {
        fusionEngine.tick();
        setFusionState({ ...fusionEngine.getState() });
      }, 1000);
    } else {
      clearInterval(tickIntervalRef.current);
    }
    return () => clearInterval(tickIntervalRef.current);
  }, [isRunning]);

  // ── Handlers ──

  const handleStep1Next = () => {
    if (roomW <= 0 || roomH <= 0) {
      Alert.alert("Invalid Size", "Please enter a valid width and height greater than 0.");
      return;
    }
    setWizardStep(2);
  };

  const handleStep2Next = async () => {
    // Validate beacons are inside room
    const beaconsValid =
      anchor1.x >= 0 && anchor1.x <= roomW &&
      anchor1.y >= 0 && anchor1.y <= roomH &&
      anchor2.x >= 0 && anchor2.x <= roomW &&
      anchor2.y >= 0 && anchor2.y <= roomH;

    if (!beaconsValid) {
      Alert.alert(
        "Beacons Out of Bounds",
        `Both beacons must be within the room (0–${roomW} m wide, 0–${roomH} m tall).`
      );
      return;
    }

    const distBetween = Math.sqrt(
      (anchor2.x - anchor1.x) ** 2 + (anchor2.y - anchor1.y) ** 2
    );
    if (distBetween < 0.5) {
      Alert.alert("Beacons Too Close", "Place beacons at least 0.5 m apart.");
      return;
    }

    // Persist
    await Promise.all([
      v2Scanner.setPlaceSize({ widthM: roomW, heightM: roomH }),
      v2Scanner.setBeaconAnchors(anchor1, anchor2),
    ]);

    // Apply to engines
    fusionEngine.setBleAnchors(anchor1, anchor2);
    fusionEngine.setRoomSize(roomW, roomH);

    setWizardStep("running");
  };

  const handleStartFusion = () => {
    const startX = roomW / 2;
    const startY = roomH / 2;
    fusionEngine.reset(startX, startY);
    fusionEngine.setBleAnchors(anchor1, anchor2);
    fusionEngine.setRoomSize(roomW, roomH);
    setFusionState({ ...fusionEngine.getState() });
    setIsRunning(true);
  };

  const handleStop = () => {
    setIsRunning(false);
  };

  const handleReconfigure = () => {
    setIsRunning(false);
    setWizardStep(1);
  };

  const handleResetPosition = () => {
    const startX = roomW / 2;
    const startY = roomH / 2;
    fusionEngine.reset(startX, startY);
    setFusionState({ ...fusionEngine.getState() });
  };

  // ── Confidence bar ──
  const renderConfBar = (value, color) => {
    const pct = clamp(value, 0, 1) * 100;
    return (
      <View style={styles.confBarBg}>
        <View style={[styles.confBarFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
    );
  };

  // ── Wizard: Step 1 — Place Size ──
  if (wizardStep === 1) {
    return (
      <KeyboardAvoidingView style={styles.screenBg} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Text style={styles.screenTitle}>🗺️ Fusion Navigation Setup</Text>

          <View style={styles.card}>
            <WizardStepHeader stepNum={1} title="Define Your Space" subtitle="Enter the real-world size of the area" currentStep={1} />

            <View style={styles.inputRow}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Width (m)</Text>
                <TextInput
                  style={styles.textInput}
                  value={roomWidthStr}
                  onChangeText={setRoomWidthStr}
                  keyboardType="decimal-pad"
                  placeholderTextColor={C.textMuted}
                  placeholder="e.g. 8"
                />
              </View>
              <Text style={styles.inputDivider}>×</Text>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Height (m)</Text>
                <TextInput
                  style={styles.textInput}
                  value={roomHeightStr}
                  onChangeText={setRoomHeightStr}
                  keyboardType="decimal-pad"
                  placeholderTextColor={C.textMuted}
                  placeholder="e.g. 6"
                />
              </View>
            </View>

            <Text style={styles.hintText}>
              📐 This defines the boundary walls of the map. Example: a 8 m × 6 m room, or a 20 m × 3 m corridor.
            </Text>

            <TouchableOpacity style={styles.primaryBtn} onPress={handleStep1Next}>
              <Text style={styles.primaryBtnText}>Next → Place Beacons</Text>
            </TouchableOpacity>
          </View>

          {/* Preview of room shape */}
          {roomW > 0 && roomH > 0 && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Room Preview</Text>
              <Svg width={CANVAS_SIZE} height={Math.min(CANVAS_SIZE, (roomH / roomW) * CANVAS_SIZE + 40)} style={{ alignSelf: "center" }}>
                <Rect
                  x={MAP_PADDING} y={MAP_PADDING}
                  width={CANVAS_SIZE - MAP_PADDING * 2}
                  height={Math.min(CANVAS_SIZE - MAP_PADDING * 2, ((roomH / roomW) * (CANVAS_SIZE - MAP_PADDING * 2)))}
                  fill={C.surfaceAlt} stroke={C.accent} strokeWidth={1.5} rx={4}
                />
                <SvgText x={CANVAS_SIZE / 2} y={MAP_PADDING - 6} textAnchor="middle" fontSize={10} fill={C.textSecondary}>
                  {`${roomW} m wide`}
                </SvgText>
                <SvgText x={MAP_PADDING - 4} y={MAP_PADDING + 20} fontSize={9} fill={C.textSecondary} rotation="-90" origin={`${MAP_PADDING - 4}, ${MAP_PADDING + 20}`}>
                  {`${roomH} m`}
                </SvgText>
              </Svg>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── Wizard: Step 2 — Beacon Positions ──
  if (wizardStep === 2) {
    return (
      <KeyboardAvoidingView style={styles.screenBg} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Text style={styles.screenTitle}>🗺️ Fusion Navigation Setup</Text>

          <View style={styles.progressRow}>
            <WizardStepHeader stepNum={1} title="Place Size" currentStep={2} />
            <WizardStepHeader stepNum={2} title="Beacon Positions" subtitle={`Room: ${roomW} m × ${roomH} m`} currentStep={2} />
          </View>

          {/* Beacon 1 */}
          <View style={styles.card}>
            <Text style={[styles.cardTitle, { color: C.beacon1 }]}>🔵 Beacon 1</Text>
            <Text style={styles.hintText}>Where is Beacon 1 placed in the room? (metres from top-left corner)</Text>
            <View style={styles.inputRow}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>X (m)</Text>
                <TextInput style={styles.textInput} value={b1XStr} onChangeText={setB1XStr} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={C.textMuted} />
              </View>
              <Text style={styles.inputDivider}>,</Text>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Y (m)</Text>
                <TextInput style={styles.textInput} value={b1YStr} onChangeText={setB1YStr} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={C.textMuted} />
              </View>
            </View>
          </View>

          {/* Beacon 2 */}
          <View style={styles.card}>
            <Text style={[styles.cardTitle, { color: C.beacon2 }]}>🟣 Beacon 2</Text>
            <Text style={styles.hintText}>Where is Beacon 2 placed? (auto-set to opposite end of room)</Text>
            <View style={styles.inputRow}>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>X (m)</Text>
                <TextInput style={styles.textInput} value={b2XStr} onChangeText={setB2XStr} keyboardType="decimal-pad" placeholder={String(roomW)} placeholderTextColor={C.textMuted} />
              </View>
              <Text style={styles.inputDivider}>,</Text>
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Y (m)</Text>
                <TextInput style={styles.textInput} value={b2YStr} onChangeText={setB2YStr} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={C.textMuted} />
              </View>
            </View>
          </View>

          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => setWizardStep(1)}>
              <Text style={styles.secondaryBtnText}>← Back</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.primaryBtn, { flex: 1, marginLeft: 10 }]} onPress={handleStep2Next}>
              <Text style={styles.primaryBtnText}>Next → Start Fusion</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── Step 3 / Running Screen ──
  const { uncertaintyRadius, bleConfidence, pdrConfidence, stepCount, totalDistanceM } = fusionState;
  const d1 = bleStats.b1?.distanceM;
  const d2 = bleStats.b2?.distanceM;

  return (
    <ScrollView style={styles.screenBg} contentContainerStyle={styles.scrollContent}>
      {/* Header */}
      <View style={styles.runHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.screenTitle}>
            {isRunning ? "🟢 Fusion Active" : "⚪ Fusion Paused"}
          </Text>
          <Text style={styles.runSubtitle}>
            {`Room: ${roomW} m × ${roomH} m  •  ${stepCount} steps`}
          </Text>
        </View>
        <TouchableOpacity style={styles.reconfigBtn} onPress={handleReconfigure}>
          <Text style={styles.reconfigBtnText}>⚙ Reconfigure</Text>
        </TouchableOpacity>
      </View>

      {/* Live Map Canvas */}
      <FusionMapCanvas
        roomW={roomW}
        roomH={roomH}
        anchor1={anchor1}
        anchor2={anchor2}
        fusionState={fusionState}
        d1={d1}
        d2={d2}
      />

      {/* Control buttons */}
      <View style={styles.btnRow}>
        {!isRunning ? (
          <TouchableOpacity style={[styles.primaryBtn, { flex: 1 }]} onPress={handleStartFusion}>
            <Text style={styles.primaryBtnText}>▶ Start Fusion</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.stopBtn, { flex: 1 }]} onPress={handleStop}>
            <Text style={styles.primaryBtnText}>⏹ Stop</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[styles.secondaryBtn, { marginLeft: 10 }]} onPress={handleResetPosition}>
          <Text style={styles.secondaryBtnText}>📍 Reset Pos</Text>
        </TouchableOpacity>
      </View>

      {/* Live metrics */}
      <View style={styles.metricsGrid}>
        <MetricPill
          label="Position"
          value={`(${fusionState.x.toFixed(2)}, ${fusionState.y.toFixed(2)}) m`}
          color={C.accentGreen}
        />
        <MetricPill
          label="Uncertainty"
          value={`± ${uncertaintyRadius.toFixed(2)} m`}
          color={uncertaintyRadius > 2 ? C.accentRed : C.accentOrange}
        />
        <MetricPill
          label="B1 Distance"
          value={Number.isFinite(d1) ? `${d1.toFixed(2)} m` : "—"}
          color={C.beacon1}
        />
        <MetricPill
          label="B2 Distance"
          value={Number.isFinite(d2) ? `${d2.toFixed(2)} m` : "—"}
          color={C.beacon2}
        />
        <MetricPill
          label="Total Distance"
          value={`${totalDistanceM.toFixed(1)} m`}
          color={C.accent}
        />
        <MetricPill
          label="Steps"
          value={String(stepCount)}
          color={C.accent}
        />
      </View>

      {/* Confidence bars */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Sensor Confidence</Text>
        <View style={styles.confRow}>
          <Text style={styles.confLabel}>BLE</Text>
          {renderConfBar(bleConfidence, C.beacon1)}
          <Text style={styles.confValue}>{(bleConfidence * 100).toFixed(0)}%</Text>
        </View>
        <View style={styles.confRow}>
          <Text style={styles.confLabel}>PDR</Text>
          {renderConfBar(pdrConfidence, C.accentGreen)}
          <Text style={styles.confValue}>{(pdrConfidence * 100).toFixed(0)}%</Text>
        </View>
        <View style={styles.confRow}>
          <Text style={styles.confLabel}>BLE Weight</Text>
          {renderConfBar(fusionState.fusionWeightBle, C.beacon2)}
          <Text style={styles.confValue}>{(fusionState.fusionWeightBle * 100).toFixed(0)}%</Text>
        </View>
      </View>

      {/* Beacon info strip */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Beacon Info</Text>
        <View style={styles.beaconInfoRow}>
          <View style={[styles.beaconChip, { borderColor: C.beacon1 }]}>
            <Text style={[styles.beaconChipLabel, { color: C.beacon1 }]}>B1 @ ({anchor1.x},{anchor1.y})</Text>
            <Text style={styles.beaconChipValue}>
              {bleStats.b1?.name || "—"} • {bleStats.b1?.rawRssi != null ? `${bleStats.b1.rawRssi} dBm` : "no signal"}
            </Text>
          </View>
          <View style={[styles.beaconChip, { borderColor: C.beacon2 }]}>
            <Text style={[styles.beaconChipLabel, { color: C.beacon2 }]}>B2 @ ({anchor2.x},{anchor2.y})</Text>
            <Text style={styles.beaconChipValue}>
              {bleStats.b2?.name || "—"} • {bleStats.b2?.rawRssi != null ? `${bleStats.b2.rawRssi} dBm` : "no signal"}
            </Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screenBg: {
    flex: 1,
    backgroundColor: C.bg,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  screenTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: C.textPrimary,
    marginBottom: 4,
  },
  card: {
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    marginBottom: 14,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: C.textSecondary,
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  stepHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBadgeText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#fff",
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: C.textSecondary,
  },
  stepSubtitle: {
    fontSize: 12,
    color: C.textMuted,
    marginTop: 2,
  },
  progressRow: {
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginBottom: 12,
  },
  inputGroup: {
    flex: 1,
  },
  inputLabel: {
    fontSize: 12,
    color: C.textSecondary,
    marginBottom: 6,
  },
  textInput: {
    backgroundColor: C.surfaceAlt,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    color: C.textPrimary,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputDivider: {
    color: C.textMuted,
    fontSize: 20,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  hintText: {
    fontSize: 12,
    color: C.textMuted,
    lineHeight: 18,
    marginBottom: 16,
  },
  primaryBtn: {
    backgroundColor: C.stepActive,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryBtnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  stopBtn: {
    backgroundColor: "#5a1e1e",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  secondaryBtn: {
    backgroundColor: C.surfaceAlt,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: C.border,
  },
  secondaryBtnText: {
    color: C.textSecondary,
    fontWeight: "600",
    fontSize: 14,
  },
  btnRow: {
    flexDirection: "row",
    marginBottom: 14,
  },
  mapCanvasWrapper: {
    alignSelf: "center",
    marginBottom: 14,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.border,
  },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 14,
  },
  metricPill: {
    backgroundColor: C.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: "47%",
    flex: 1,
  },
  metricPillLabel: {
    fontSize: 10,
    color: C.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  metricPillValue: {
    fontSize: 15,
    fontWeight: "700",
  },
  runHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  runSubtitle: {
    fontSize: 12,
    color: C.textMuted,
    marginTop: 2,
  },
  reconfigBtn: {
    backgroundColor: C.surfaceAlt,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  reconfigBtnText: {
    fontSize: 12,
    color: C.textSecondary,
  },
  confRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  confLabel: {
    width: 68,
    fontSize: 12,
    color: C.textSecondary,
  },
  confBarBg: {
    flex: 1,
    height: 6,
    backgroundColor: C.surfaceAlt,
    borderRadius: 3,
    overflow: "hidden",
    marginRight: 10,
  },
  confBarFill: {
    height: 6,
    borderRadius: 3,
  },
  confValue: {
    width: 36,
    fontSize: 12,
    color: C.textSecondary,
    textAlign: "right",
  },
  beaconInfoRow: {
    gap: 10,
  },
  beaconChip: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  beaconChipLabel: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4,
  },
  beaconChipValue: {
    fontSize: 12,
    color: C.textMuted,
  },
});
