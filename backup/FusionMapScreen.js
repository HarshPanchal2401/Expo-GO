// ============================================================================
// FusionMapScreen.js — Live PDR + BLE Fusion Navigation on the Real Office Map
//
// Renders the actual office floor plan (assets/floorplans/office-72x72.png)
// as the map background, with a live fused position tracked by FusionEngine
// (async EKF: PDR predicts every step, BLE corrects on every beacon packet).
//
// UNITS: this entire screen works in FEET, matching the floor plan's own
// foot-based grid — FusionEngine, PdrEngine and the room/anchor coordinates
// are all feet. The only two places metres appear are the RAW inputs from the
// sensors: PDR step length (Weinberg model, metres) and BLE distance
// (AdaptiveBeaconEngine, metres) — both are converted with metresToFeet()
// exactly once, right where they're handed to the fusion engine, so nothing
// downstream can be accidentally treated as the wrong unit.
//
// Two modes:
//   • Live tracking — shows the fused position, its uncertainty halo, the
//     movement trail, and a dashed "you're roughly here" ring per beacon
//     (NOT a precise fix — a proximity indicator, since 2 beacons alone can't
//     triangulate a unique point without PDR's help).
//   • Place Beacons — drag the B1 / B2 markers to their real position on the
//     floor plan (snapped to the 2 ft grid); positions persist and feed
//     straight into FusionEngine's baseline geometry.
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
  Dimensions,
  Alert,
  PanResponder,
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
  Image as SvgImage,
} from "react-native-svg";
import { fusionEngine } from "../../services/FusionEngine.js";
import { v2Scanner } from "../../services/v2BeaconScannerService.js";
import { metresToFeet, feetToMetres } from "../../services/PdrEngine.js";

// Floor plan image is gitignored (assets/floorplans/) — it only exists on the
// machine that runs `eas update`. Without the PNG on disk the bundle fails;
// set this to null to ship without the background image.
const FLOORPLAN_IMAGE = require("../../assets/floorplans/office-72x72.png");

// ─── Constants ───────────────────────────────────────────────────────────────

const SCREEN_W = Dimensions.get("window").width;
const MAP_PADDING = 20; // canvas margin (px)
const MAP_SIZE = SCREEN_W - 32; // canvas width (px) — height follows room aspect ratio
const CANVAS_SIZE = MAP_SIZE - MAP_PADDING * 2; // drawable area (px, square axis unit)

const DEFAULT_ROOM_W_FT = 72;
const DEFAULT_ROOM_H_FT = 72;
const GRID_MINOR_FT = 2;   // matches the floor plan's own printed grid
const GRID_MAJOR_FT = 10;  // heavier labeled lines every 10 ft
const BEACON_RADIUS_PX = 15;
const USER_DOT_RADIUS = 9;

// Uncertainty tiers (feet) — drive the "how much to trust this dot" messaging
const UNCERTAINTY_HIGH_FT = 3.5;   // below this: confident fix
const UNCERTAINTY_LOW_FT = 10;     // above this: general-area only

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
  gridMinor: "#2a3038",
  gridMajor: "#3d4451",
  textPrimary: "#e6edf3",
  textSecondary: "#8b949e",
  textMuted: "#484f58",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function parseFloatSafe(str, fallback = 0) {
  const v = parseFloat(str);
  return Number.isFinite(v) ? v : fallback;
}

function snapToGrid(ft, step = GRID_MINOR_FT) {
  return Math.round(ft / step) * step;
}

/**
 * Scale + offset to fit a roomW×roomH (feet) rectangle into a boxW×boxH (px)
 * bounding box, preserving aspect ratio with a small margin. Works for square
 * rooms (today's 72×72 ft office) and non-square ones (a future floor plan).
 */
function computeTransform(roomW, roomH, boxW, boxH) {
  const scaleX = boxW / roomW;
  const scaleY = boxH / roomH;
  const scale = Math.min(scaleX, scaleY) * 0.94;
  const offsetX = (boxW - roomW * scale) / 2;
  const offsetY = (boxH - roomH * scale) / 2;
  return { scale, offsetX, offsetY };
}

/**
 * World (feet, Y-up, origin bottom-left — matching the floor plan's own
 * printed axes and the app's heading convention where +Y = forward/north)
 * to screen pixel (Y-down, origin top-left, as SVG expects).
 */
function worldToScreen(wx, wy, transform, roomH) {
  return {
    cx: MAP_PADDING + transform.offsetX + wx * transform.scale,
    cy: MAP_PADDING + transform.offsetY + (roomH - wy) * transform.scale,
  };
}

function getPositionQuality(uncertaintyFt) {
  if (uncertaintyFt <= UNCERTAINTY_HIGH_FT) {
    return { label: "Confident fix", color: C.accentGreen, dotOpacity: 1.0 };
  }
  if (uncertaintyFt <= UNCERTAINTY_LOW_FT) {
    return { label: "Approximate position", color: C.accentOrange, dotOpacity: 0.75 };
  }
  return { label: "General area only — not a precise fix", color: C.accentRed, dotOpacity: 0.5 };
}

// ─── Metric Pill ─────────────────────────────────────────────────────────────

function MetricPill({ label, value, color = C.accent }) {
  return (
    <View style={styles.metricPill}>
      <Text style={styles.metricPillLabel}>{label}</Text>
      <Text style={[styles.metricPillValue, { color }]}>{value}</Text>
    </View>
  );
}

// ─── Draggable Beacon Marker ─────────────────────────────────────────────────

function BeaconMarker({
  id,
  label,
  color,
  worldPos,
  transform,
  roomH,
  draggable,
  deviceName,
  onDragEnd,
}) {
  const [dragOffsetPx, setDragOffsetPx] = useState({ dx: 0, dy: 0 });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => draggable,
        onMoveShouldSetPanResponder: () => draggable,
        onPanResponderMove: (_evt, gesture) => {
          setDragOffsetPx({ dx: gesture.dx, dy: gesture.dy });
        },
        onPanResponderRelease: (_evt, gesture) => {
          const dxFt = gesture.dx / transform.scale;
          const dyFt = -gesture.dy / transform.scale; // screen down = world Y down
          setDragOffsetPx({ dx: 0, dy: 0 });
          onDragEnd(id, worldPos.x + dxFt, worldPos.y + dyFt);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draggable, transform.scale, worldPos.x, worldPos.y]
  );

  const basePx = worldToScreen(worldPos.x, worldPos.y, transform, roomH);
  const cx = basePx.cx + dragOffsetPx.dx;
  const cy = basePx.cy + dragOffsetPx.dy;
  const subLabel = deviceName || `(${worldPos.x.toFixed(0)}, ${worldPos.y.toFixed(0)}) ft`;

  return (
    <>
      <Circle cx={cx} cy={cy} r={BEACON_RADIUS_PX * 2.2} fill={color} fillOpacity={0.18} />
      <Circle
        cx={cx}
        cy={cy}
        r={BEACON_RADIUS_PX}
        fill={color}
        fillOpacity={0.95}
        stroke={draggable ? "#fff" : "none"}
        strokeWidth={draggable ? 2 : 0}
        {...panResponder.panHandlers}
      />
      <SvgText x={cx} y={cy + 4.5} textAnchor="middle" fontSize={11} fill="#fff" fontWeight="bold">
        {label}
      </SvgText>
      <SvgText x={cx} y={cy + BEACON_RADIUS_PX + 13} textAnchor="middle" fontSize={9} fill={color}>
        {subLabel}
      </SvgText>
    </>
  );
}

// ─── Live Office Map SVG ─────────────────────────────────────────────────────

function OfficeMapCanvas({
  roomW,
  roomH,
  anchor1,
  anchor2,
  fusionState,
  d1Ft,
  d2Ft,
  b1Name,
  b2Name,
  headingDeg,
  placementMode,
  onBeaconDragEnd,
}) {
  const {
    x, y, uncertaintyRadius, trail,
    totalDistanceFt = 0,
    netDisplacementFt = 0,
    isWalking = false,
  } = fusionState;
  const canvasHeight = Math.min(CANVAS_SIZE * (roomH / roomW), CANVAS_SIZE * 1.6);
  const transform = useMemo(
    () => computeTransform(roomW, roomH, CANVAS_SIZE, canvasHeight),
    [roomW, roomH, canvasHeight]
  );

  const toScreen = useCallback(
    (wx, wy) => worldToScreen(wx, wy, transform, roomH),
    [transform, roomH]
  );

  const roomPx = {
    x: MAP_PADDING + transform.offsetX,
    y: MAP_PADDING + transform.offsetY,
    w: roomW * transform.scale,
    h: roomH * transform.scale,
  };

  const userPx = toScreen(x, y);
  const haloPx = uncertaintyRadius * transform.scale;
  const quality = getPositionQuality(uncertaintyRadius);

  const trailPoints = trail
    .map((pt) => {
      const { cx, cy } = toScreen(pt.x, pt.y);
      return `${cx.toFixed(1)},${cy.toFixed(1)}`;
    })
    .join(" ");

  const b1px = toScreen(anchor1.x, anchor1.y);
  const b2px = toScreen(anchor2.x, anchor2.y);
  const ring1Px = Number.isFinite(d1Ft) && d1Ft > 0 ? d1Ft * transform.scale : null;
  const ring2Px = Number.isFinite(d2Ft) && d2Ft > 0 ? d2Ft * transform.scale : null;

  // ── Memoized static grid (recomputed only when room/transform changes) ──
  const gridLines = useMemo(() => {
    const lines = [];
    for (let gx = 0; gx <= roomW + 0.001; gx += GRID_MINOR_FT) {
      const isMajor = Math.round(gx) % GRID_MAJOR_FT === 0;
      const { cx } = toScreen(gx, 0);
      lines.push(
        <Line
          key={`vg${gx}`}
          x1={cx} y1={roomPx.y}
          x2={cx} y2={roomPx.y + roomPx.h}
          stroke={isMajor ? C.gridMajor : C.gridMinor}
          strokeWidth={isMajor ? 0.9 : 0.4}
        />
      );
      if (isMajor && gx > 0) {
        lines.push(
          <SvgText key={`vgl${gx}`} x={cx} y={roomPx.y - 4} textAnchor="middle" fontSize={8} fill={C.textMuted}>
            {gx}
          </SvgText>
        );
      }
    }
    for (let gy = 0; gy <= roomH + 0.001; gy += GRID_MINOR_FT) {
      const isMajor = Math.round(gy) % GRID_MAJOR_FT === 0;
      const { cy } = toScreen(0, gy);
      lines.push(
        <Line
          key={`hg${gy}`}
          x1={roomPx.x} y1={cy}
          x2={roomPx.x + roomPx.w} y2={cy}
          stroke={isMajor ? C.gridMajor : C.gridMinor}
          strokeWidth={isMajor ? 0.9 : 0.4}
        />
      );
    }
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomW, roomH, transform.scale, transform.offsetX, transform.offsetY]);

  return (
    <View style={styles.mapCanvasWrapper}>
      <Svg width={MAP_SIZE} height={canvasHeight + MAP_PADDING * 2}>
        <Defs>
          <RadialGradient id="haloGrad" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={quality.color} stopOpacity="0.30" />
            <Stop offset="70%" stopColor={quality.color} stopOpacity="0.10" />
            <Stop offset="100%" stopColor={quality.color} stopOpacity="0.00" />
          </RadialGradient>
        </Defs>

        {/* ── Real floor plan background ── */}
        {FLOORPLAN_IMAGE && (
          <SvgImage
            x={roomPx.x}
            y={roomPx.y}
            width={roomPx.w}
            height={roomPx.h}
            href={FLOORPLAN_IMAGE}
            preserveAspectRatio="none"
            opacity={0.92}
          />
        )}

        {/* ── Grid overlay (2 ft minor / 10 ft major, matches floor plan's own grid) ── */}
        {gridLines}

        {/* ── Room boundary ── */}
        <Rect
          x={roomPx.x} y={roomPx.y} width={roomPx.w} height={roomPx.h}
          fill="none" stroke={C.border} strokeWidth={1.5} rx={2}
        />

        {/* ── "You're roughly here" proximity rings (NOT a precise fix) ── */}
        {ring1Px !== null && (
          <Circle
            cx={b1px.cx} cy={b1px.cy} r={ring1Px}
            fill="none" stroke={C.beacon1} strokeWidth={1.5}
            strokeDasharray="6,5" strokeOpacity={0.55}
          />
        )}
        {ring2Px !== null && (
          <Circle
            cx={b2px.cx} cy={b2px.cy} r={ring2Px}
            fill="none" stroke={C.beacon2} strokeWidth={1.5}
            strokeDasharray="6,5" strokeOpacity={0.55}
          />
        )}

        {/* ── Movement trail ── */}
        {trail.length > 1 && (
          <Polyline
            points={trailPoints}
            fill="none" stroke={C.trail} strokeWidth={2.5}
            strokeOpacity={0.55} strokeLinecap="round" strokeLinejoin="round"
          />
        )}

        {/* ── Uncertainty halo — grows honestly when the fix is unreliable ── */}
        {haloPx > 3 && (
          <Circle cx={userPx.cx} cy={userPx.cy} r={Math.min(haloPx, CANVAS_SIZE)} fill="url(#haloGrad)" />
        )}

        {/* ── Beacon markers (draggable in placement mode) ── */}
        <BeaconMarker
          id={1} label="B1" color={C.beacon1} worldPos={anchor1}
          transform={transform} roomH={roomH} draggable={placementMode}
          deviceName={b1Name} onDragEnd={onBeaconDragEnd}
        />
        <BeaconMarker
          id={2} label="B2" color={C.beacon2} worldPos={anchor2}
          transform={transform} roomH={roomH} draggable={placementMode}
          deviceName={b2Name} onDragEnd={onBeaconDragEnd}
        />

        {/* ── Fused user position — opacity reflects confidence, never overstates certainty ── */}
        {!placementMode && (
          <>
            <Circle cx={userPx.cx} cy={userPx.cy} r={USER_DOT_RADIUS + 4} fill={C.userDot} fillOpacity={quality.dotOpacity * 0.25} />
            <Circle cx={userPx.cx} cy={userPx.cy} r={USER_DOT_RADIUS} fill={C.userDot} fillOpacity={quality.dotOpacity} />
            <Circle cx={userPx.cx} cy={userPx.cy} r={USER_DOT_RADIUS - 3} fill="#fff" fillOpacity={quality.dotOpacity * 0.65} />
            {/* Heading indicator — short needle pointing the way the user is facing */}
            {Number.isFinite(headingDeg) && (() => {
              const rad = (headingDeg * Math.PI) / 180;
              const needleLenPx = USER_DOT_RADIUS + 10;
              // World heading (0°=+Y/up, 90°=+X/right) -> screen delta (Y flipped)
              const tipX = userPx.cx + Math.sin(rad) * needleLenPx;
              const tipY = userPx.cy - Math.cos(rad) * needleLenPx;
              return (
                <Line
                  x1={userPx.cx} y1={userPx.cy} x2={tipX} y2={tipY}
                  stroke="#fff" strokeWidth={2.5} strokeOpacity={quality.dotOpacity} strokeLinecap="round"
                />
              );
            })()}
          </>
        )}
      </Svg>

      {/* ── On-map distance readout ──────────────────────────────────────────
          Two numbers, because one alone is ambiguous. WALKED is the sum of
          measured step lengths — real odometry, so it counts only distance the
          user's legs actually covered. It is deliberately NOT the length of the
          drawn track, which also contains BLE correction movement and would
          over-report a walk. NET is the straight-line distance from where
          tracking started, so an out-and-back reads as a large WALKED with a
          near-zero NET rather than looking like a tracking failure. */}
      {!placementMode && (
        <View style={styles.mapDistanceOverlay} pointerEvents="none">
          <View style={styles.mapDistRow}>
            <Text style={styles.mapDistLabel}>WALKED</Text>
            <Text style={styles.mapDistValue}>{totalDistanceFt.toFixed(1)} ft</Text>
          </View>
          <View style={styles.mapDistDivider} />
          <View style={styles.mapDistRow}>
            <Text style={styles.mapDistLabel}>NET</Text>
            <Text style={styles.mapDistValueAlt}>{netDisplacementFt.toFixed(1)} ft</Text>
          </View>
          <View style={[styles.mapMotionDot, isWalking ? styles.mapMotionMoving : styles.mapMotionStill]} />
          <Text style={styles.mapMotionText}>{isWalking ? "moving" : "still"}</Text>
        </View>
      )}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function FusionMapScreen({ pdrStepCallbackRef, headingRef, onZeroHeading }) {
  const [isRunning, setIsRunning] = useState(true);
  const [placementMode, setPlacementMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  const [roomWidthStr, setRoomWidthStr] = useState(String(DEFAULT_ROOM_W_FT));
  const [roomHeightStr, setRoomHeightStr] = useState(String(DEFAULT_ROOM_H_FT));
  const roomW = parseFloatSafe(roomWidthStr, DEFAULT_ROOM_W_FT);
  const roomH = parseFloatSafe(roomHeightStr, DEFAULT_ROOM_H_FT);

  const [anchor1, setAnchor1] = useState({ x: 6, y: 6 });
  const [anchor2, setAnchor2] = useState({ x: 66, y: 6 });

  const [fusionState, setFusionState] = useState(() => {
    fusionEngine.reset(DEFAULT_ROOM_W_FT / 2, DEFAULT_ROOM_H_FT / 2);
    fusionEngine.setRoomSize(DEFAULT_ROOM_W_FT, DEFAULT_ROOM_H_FT);
    return { ...fusionEngine.getState() };
  });

  const [bleStats, setBleStats] = useState({ b1: null, b2: null });
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [headingZeroFlash, setHeadingZeroFlash] = useState(false);

  const tickIntervalRef = useRef(null);
  const statsUnsubRef = useRef(null);
  const statusUnsubRef = useRef(null);
  // false = the next good beacon reading should PLACE the user at the
  // beacon-estimated position (cold start / re-localize), rather than
  // nudging an arbitrary starting guess. Set back to false by Start and by
  // Reset Position so both re-estimate from the beacons instead of reusing
  // a stale or made-up point.
  const coldStartDoneRef = useRef(false);

  // ── This screen owns its own BLE scan — it must not depend on the user
  // having visited Signal Lab first and pressed Start there. startScan() is
  // idempotent (safe to call even if a scan is already running elsewhere).
  const ensureScanning = useCallback(async () => {
    setScanError(null);
    const res = await v2Scanner.startScan();
    if (!res?.success) {
      setScanError(res?.error || "Could not start BLE scan.");
    }
  }, []);

  useEffect(() => {
    statusUnsubRef.current = v2Scanner.subscribeStatus((scanning) => setIsScanning(scanning));
    ensureScanning();
    // Safety ceiling from the moment scanning starts, using the default room
    // size — refined to the real saved size by the next effect below.
    v2Scanner.setMaxPlausibleDistance(feetToMetres(Math.hypot(DEFAULT_ROOM_W_FT, DEFAULT_ROOM_H_FT)));
    return () => statusUnsubRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load saved floor-plan size + beacon anchors (feet) on mount ──
  useEffect(() => {
    (async () => {
      const [size, anchors] = await Promise.all([
        v2Scanner.getPlaceSize(),
        v2Scanner.getBeaconAnchors(),
      ]);
      const w = size?.widthFt || DEFAULT_ROOM_W_FT;
      const h = size?.heightFt || DEFAULT_ROOM_H_FT;
      setRoomWidthStr(String(w));
      setRoomHeightStr(String(h));
      fusionEngine.setRoomSize(w, h);
      // Nothing legitimate can measure farther than the room's own diagonal —
      // caps hallucinated distances from an uncalibrated/weak-signal reading.
      v2Scanner.setMaxPlausibleDistance(feetToMetres(Math.hypot(w, h)));

      if (anchors) {
        setAnchor1(anchors.b1);
        setAnchor2(anchors.b2);
        fusionEngine.setBleAnchors(anchors.b1, anchors.b2);
      } else {
        fusionEngine.setBleAnchors({ x: 6, y: 6 }, { x: w - 6, y: 6 });
      }
      fusionEngine.reset(w / 2, h / 2);
      setFusionState({ ...fusionEngine.getState() });
      setConfigLoaded(true);
    })();
  }, []);

  // ── BLE stats subscription: convert metres -> feet at this single boundary ──
  useEffect(() => {
    statsUnsubRef.current = v2Scanner.subscribeStats((stats) => {
      setBleStats({ b1: stats.b1, b2: stats.b2 });

      if (!isRunning || placementMode) return;

      const d1Ft = Number.isFinite(stats.b1?.distanceM) ? metresToFeet(stats.b1.distanceM) : null;
      const d2Ft = Number.isFinite(stats.b2?.distanceM) ? metresToFeet(stats.b2.distanceM) : null;
      const c1 = stats.b1?.confidenceScore ?? 0;
      const c2 = stats.b2?.confidenceScore ?? 0;
      if (!Number.isFinite(d1Ft) || !Number.isFinite(d2Ft)) return;

      if (!coldStartDoneRef.current) {
        // First good reading since Start/Reset — PLACE the user at the
        // beacon-estimated position instead of leaving them at an arbitrary
        // guess (previously always the room's geometric center) and waiting
        // for many EKF corrections to slowly walk the estimate over.
        const anchors = [
          stats.b1?.id ? { beaconId: stats.b1.id, x: anchor1.x, y: anchor1.y } : null,
          stats.b2?.id ? { beaconId: stats.b2.id, x: anchor2.x, y: anchor2.y } : null,
        ].filter(Boolean);
        const estimate = v2Scanner.computeWeightedPosition(anchors);
        if (estimate && Number.isFinite(estimate.x) && Number.isFinite(estimate.y)) {
          fusionEngine.reset(estimate.x, estimate.y);
          coldStartDoneRef.current = true;
          setFusionState({ ...fusionEngine.getState() });
          return; // this packet was consumed by the cold-start placement
        }
      }

      fusionEngine.correct(d1Ft, d2Ft, c1, c2);
      setFusionState({ ...fusionEngine.getState() });
    });
    return () => statsUnsubRef.current?.();
  }, [isRunning, placementMode, anchor1, anchor2]);

  // ── PDR step hook: convert metres -> feet at this single boundary ──
  useEffect(() => {
    if (pdrStepCallbackRef) {
      pdrStepCallbackRef.current = ({ stepLengthMeters, heading }) => {
        if (!isRunning || placementMode) return;
        const stepLengthFt = metresToFeet(stepLengthMeters);
        fusionEngine.predict(stepLengthFt, heading);
        setFusionState({ ...fusionEngine.getState() });
      };
      return () => {
        pdrStepCallbackRef.current = null;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdrStepCallbackRef, isRunning, placementMode]);

  // ── Tick interval (passive uncertainty growth + UI refresh) ──
  useEffect(() => {
    if (isRunning && !placementMode) {
      tickIntervalRef.current = setInterval(() => {
        fusionEngine.tick();
        setFusionState({ ...fusionEngine.getState() });
      }, 1000);
    } else if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
    }
    return () => clearInterval(tickIntervalRef.current);
  }, [isRunning, placementMode]);

  // ── Handlers ──

  const handleBeaconDragEnd = useCallback(
    (beaconId, rawX, rawY) => {
      const snapped = {
        x: clamp(snapToGrid(rawX), 0, roomW),
        y: clamp(snapToGrid(rawY), 0, roomH),
      };
      if (beaconId === 1) setAnchor1(snapped);
      else setAnchor2(snapped);
    },
    [roomW, roomH]
  );

  const handleSaveBeaconPositions = async () => {
    const distBetween = Math.sqrt((anchor2.x - anchor1.x) ** 2 + (anchor2.y - anchor1.y) ** 2);
    if (distBetween < 2) {
      Alert.alert("Beacons Too Close", "Place B1 and B2 at least 2 ft apart for a usable baseline.");
      return;
    }
    fusionEngine.setBleAnchors(anchor1, anchor2);
    await v2Scanner.setBeaconAnchors(anchor1, anchor2);
    setPlacementMode(false);
    Alert.alert("Saved", "Beacon positions updated on the map.");
  };

  const handleApplyRoomSize = async () => {
    if (roomW <= 0 || roomH <= 0) {
      Alert.alert("Invalid Size", "Enter a width and height greater than 0.");
      return;
    }
    fusionEngine.setRoomSize(roomW, roomH);
    v2Scanner.setMaxPlausibleDistance(feetToMetres(Math.hypot(roomW, roomH)));
    await v2Scanner.setPlaceSize({ widthFt: roomW, heightFt: roomH });
    setSettingsOpen(false);
  };

  const handleStartStop = () => {
    if (isRunning) {
      setIsRunning(false);
    } else {
      fusionEngine.setRoomSize(roomW, roomH);
      fusionEngine.setBleAnchors(anchor1, anchor2);
      coldStartDoneRef.current = false; // re-estimate position from beacons on resume
      setIsRunning(true);
    }
  };

  const handleResetPosition = () => {
    coldStartDoneRef.current = false;
    // Immediate fallback so the dot isn't stuck at a stale spot while
    // waiting for the next BLE packet — the very next valid reading will
    // then re-place it properly via computeWeightedPosition (see the BLE
    // stats subscription above).
    fusionEngine.reset(roomW / 2, roomH / 2);
    setFusionState({ ...fusionEngine.getState() });
  };

  // Whatever direction the phone is facing right now becomes 0° / forward.
  // Do this while physically facing the same direction as the floor plan's
  // printed "up" (+Y) so the heading needle and PDR step direction line up
  // with the map instead of some arbitrary earlier orientation.
  const handleZeroHeading = () => {
    if (!onZeroHeading) return;
    onZeroHeading();
    setHeadingZeroFlash(true);
    setTimeout(() => setHeadingZeroFlash(false), 2000);
  };

  const renderConfBar = (value, color) => {
    const pct = clamp(value, 0, 1) * 100;
    return (
      <View style={styles.confBarBg}>
        <View style={[styles.confBarFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
    );
  };

  if (!configLoaded) {
    return (
      <View style={[styles.screenBg, { alignItems: "center", justifyContent: "center" }]}>
        <Text style={styles.textMutedInline}>Loading floor plan…</Text>
      </View>
    );
  }

  const { uncertaintyRadius, bleConfidence, pdrConfidence, stepCount, totalDistanceFt } = fusionState;
  const d1Ft = Number.isFinite(bleStats.b1?.distanceM) ? metresToFeet(bleStats.b1.distanceM) : null;
  const d2Ft = Number.isFinite(bleStats.b2?.distanceM) ? metresToFeet(bleStats.b2.distanceM) : null;
  const quality = getPositionQuality(uncertaintyRadius);

  return (
    <ScrollView style={styles.screenBg} contentContainerStyle={styles.scrollContent}>
      {/* Header */}
      <View style={styles.runHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.screenTitle}>🏢 Office Map</Text>
          <Text style={styles.runSubtitle}>
            {headingZeroFlash
              ? "✓ Heading zeroed — this direction is now Forward (0°)"
              : placementMode
              ? "Drag markers to their real position, then Save"
              : `${roomW} × ${roomH} ft  •  ${stepCount} steps  •  ${quality.label}`}
          </Text>
        </View>
        <TouchableOpacity style={styles.reconfigBtn} onPress={handleZeroHeading}>
          <Text style={styles.reconfigBtnText}>🎯 Zero Heading</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.reconfigBtn, { marginLeft: 8 }]} onPress={() => setSettingsOpen((s) => !s)}>
          <Text style={styles.reconfigBtnText}>⚙ Floor Plan</Text>
        </TouchableOpacity>
      </View>

      {/* BLE scan status — makes a silently-dead feed impossible to miss */}
      {(() => {
        const b1Selected = Boolean(bleStats.b1?.id);
        const b2Selected = Boolean(bleStats.b2?.id);
        const b1Signal = Number.isFinite(bleStats.b1?.rawRssi);
        const b2Signal = Number.isFinite(bleStats.b2?.rawRssi);

        if (scanError) {
          return (
            <View style={[styles.statusBanner, styles.statusBannerError]}>
              <Text style={styles.statusBannerText}>⚠ BLE scan failed: {scanError}</Text>
              <TouchableOpacity style={styles.statusBannerBtn} onPress={ensureScanning}>
                <Text style={styles.statusBannerBtnText}>Retry</Text>
              </TouchableOpacity>
            </View>
          );
        }
        if (!isScanning) {
          return (
            <View style={[styles.statusBanner, styles.statusBannerError]}>
              <Text style={styles.statusBannerText}>⚠ BLE scan is not running — distances can't update.</Text>
              <TouchableOpacity style={styles.statusBannerBtn} onPress={ensureScanning}>
                <Text style={styles.statusBannerBtnText}>Start Scan</Text>
              </TouchableOpacity>
            </View>
          );
        }
        if (!b1Selected || !b2Selected) {
          return (
            <View style={[styles.statusBanner, styles.statusBannerWarn]}>
              <Text style={styles.statusBannerText}>
                📡 Scanning, but {!b1Selected && !b2Selected ? "no beacons are" : "one beacon isn't"} selected yet.
                Pick B1/B2 in the Signal Lab tab.
              </Text>
            </View>
          );
        }
        if (!b1Signal && !b2Signal) {
          return (
            <View style={[styles.statusBanner, styles.statusBannerWarn]}>
              <Text style={styles.statusBannerText}>
                📡 Scanning, beacons selected, but no packets received yet — check they're powered on and in range.
              </Text>
            </View>
          );
        }
        return (
          <View style={[styles.statusBanner, styles.statusBannerOk]}>
            <Text style={styles.statusBannerText}>
              📡 Scanning • B1 {b1Signal ? "✓" : "…"} • B2 {b2Signal ? "✓" : "…"}
            </Text>
          </View>
        );
      })()}

      {/* Floor plan size settings (collapsible) */}
      {settingsOpen && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Floor Plan Size (feet)</Text>
          <View style={styles.inputRow}>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Width (ft)</Text>
              <TextInput
                style={styles.textInput} value={roomWidthStr} onChangeText={setRoomWidthStr}
                keyboardType="decimal-pad" placeholderTextColor={C.textMuted}
              />
            </View>
            <Text style={styles.inputDivider}>×</Text>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Height (ft)</Text>
              <TextInput
                style={styles.textInput} value={roomHeightStr} onChangeText={setRoomHeightStr}
                keyboardType="decimal-pad" placeholderTextColor={C.textMuted}
              />
            </View>
          </View>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleApplyRoomSize}>
            <Text style={styles.primaryBtnText}>Apply</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Live Map Canvas */}
      <OfficeMapCanvas
        roomW={roomW} roomH={roomH}
        anchor1={anchor1} anchor2={anchor2}
        fusionState={fusionState}
        d1Ft={d1Ft} d2Ft={d2Ft}
        b1Name={bleStats.b1?.name} b2Name={bleStats.b2?.name}
        headingDeg={headingRef?.current ?? 0}
        placementMode={placementMode}
        onBeaconDragEnd={handleBeaconDragEnd}
      />

      {/* Controls */}
      <View style={styles.btnRow}>
        {placementMode ? (
          <>
            <TouchableOpacity style={[styles.secondaryBtn, { marginRight: 10 }]} onPress={() => setPlacementMode(false)}>
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.primaryBtn, { flex: 1 }]} onPress={handleSaveBeaconPositions}>
              <Text style={styles.primaryBtnText}>✓ Save Beacon Positions</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity style={[styles.placeBtn, { flex: 1, marginRight: 10 }]} onPress={() => setPlacementMode(true)}>
              <Text style={styles.primaryBtnText}>📍 Place Beacons</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[isRunning ? styles.stopBtn : styles.primaryBtn, { flex: 1 }]}
              onPress={handleStartStop}
            >
              <Text style={styles.primaryBtnText}>{isRunning ? "⏹ Stop" : "▶ Start"}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
      {!placementMode && (
        <TouchableOpacity style={[styles.secondaryBtn, { marginBottom: 14 }]} onPress={handleResetPosition}>
          <Text style={styles.secondaryBtnText}>📍 Reset Position to Center</Text>
        </TouchableOpacity>
      )}

      {!placementMode && (
        <>
          {/* Live metrics — all in feet */}
          <View style={styles.metricsGrid}>
            <MetricPill
              label="Position"
              value={`(${fusionState.x.toFixed(1)}, ${fusionState.y.toFixed(1)}) ft`}
              color={C.accentGreen}
            />
            <MetricPill
              label="Confidence"
              value={quality.label}
              color={quality.color}
            />
            <MetricPill
              label="Uncertainty"
              value={`± ${uncertaintyRadius.toFixed(1)} ft`}
              color={quality.color}
            />
            <MetricPill
              label="Walked"
              value={`${totalDistanceFt.toFixed(1)} ft`}
              color={C.accent}
            />
            <MetricPill
              label="Net Displacement"
              value={`${(fusionState.netDisplacementFt ?? 0).toFixed(1)} ft`}
              color={C.accent}
            />
            <MetricPill
              label="B1 Distance"
              value={Number.isFinite(d1Ft) ? `~${d1Ft.toFixed(1)} ft` : "—"}
              color={C.beacon1}
            />
            <MetricPill
              label="B2 Distance"
              value={Number.isFinite(d2Ft) ? `~${d2Ft.toFixed(1)} ft` : "—"}
              color={C.beacon2}
            />
          </View>

          <Text style={styles.hintText}>
            The dashed rings around each beacon show the raw BLE-measured distance — a
            "you're roughly on this circle" indicator, not a precise fix. The green dot
            is the fused best estimate; its halo grows honestly when confidence drops,
            and the dot itself fades when the fix is only approximate.
          </Text>

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
                <Text style={[styles.beaconChipLabel, { color: C.beacon1 }]}>
                  B1 @ ({anchor1.x.toFixed(0)}, {anchor1.y.toFixed(0)}) ft
                </Text>
                <Text style={styles.beaconChipValue}>
                  {bleStats.b1?.name || "—"} • {bleStats.b1?.rawRssi != null ? `${bleStats.b1.rawRssi} dBm` : "no signal"}
                </Text>
              </View>
              <View style={[styles.beaconChip, { borderColor: C.beacon2 }]}>
                <Text style={[styles.beaconChipLabel, { color: C.beacon2 }]}>
                  B2 @ ({anchor2.x.toFixed(0)}, {anchor2.y.toFixed(0)}) ft
                </Text>
                <Text style={styles.beaconChipValue}>
                  {bleStats.b2?.name || "—"} • {bleStats.b2?.rawRssi != null ? `${bleStats.b2.rawRssi} dBm` : "no signal"}
                </Text>
              </View>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── On-map distance readout ──
  mapDistanceOverlay: {
    position: "absolute",
    top: 12,
    left: 12,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(13,17,23,0.82)",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  mapDistRow: { flexDirection: "row", alignItems: "baseline" },
  mapDistLabel: {
    color: "#8b949e",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginRight: 5,
  },
  mapDistValue: { color: "#58a6ff", fontSize: 14, fontWeight: "800" },
  mapDistValueAlt: { color: "#e6edf3", fontSize: 14, fontWeight: "800" },
  mapDistDivider: {
    width: 1,
    height: 14,
    backgroundColor: "#30363d",
    marginHorizontal: 10,
  },
  mapMotionDot: { width: 7, height: 7, borderRadius: 4, marginLeft: 12 },
  mapMotionMoving: { backgroundColor: "#3fb950" },
  mapMotionStill: { backgroundColor: "#484f58" },
  mapMotionText: { color: "#8b949e", fontSize: 10, fontWeight: "600", marginLeft: 5 },

  screenBg: { flex: 1, backgroundColor: C.bg },
  scrollContent: { padding: 16, paddingBottom: 40 },
  screenTitle: { fontSize: 20, fontWeight: "700", color: C.textPrimary, marginBottom: 4 },
  textMutedInline: { color: C.textMuted, fontSize: 13 },
  card: {
    backgroundColor: C.surface, borderRadius: 12, borderWidth: 1,
    borderColor: C.border, padding: 16, marginBottom: 14,
  },
  cardTitle: {
    fontSize: 13, fontWeight: "600", color: C.textSecondary,
    marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.8,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", marginBottom: 12 },
  inputGroup: { flex: 1 },
  inputLabel: { fontSize: 12, color: C.textSecondary, marginBottom: 6 },
  textInput: {
    backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, color: C.textPrimary, fontSize: 16,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  inputDivider: { color: C.textMuted, fontSize: 20, paddingHorizontal: 10, paddingBottom: 10 },
  hintText: { fontSize: 12, color: C.textMuted, lineHeight: 18, marginBottom: 14 },
  primaryBtn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  placeBtn: { backgroundColor: "#7c4dc4", borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  stopBtn: { backgroundColor: "#5a1e1e", borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  secondaryBtn: {
    backgroundColor: C.surfaceAlt, borderRadius: 10, paddingVertical: 14,
    paddingHorizontal: 16, alignItems: "center", borderWidth: 1, borderColor: C.border,
  },
  secondaryBtnText: { color: C.textSecondary, fontWeight: "600", fontSize: 14 },
  btnRow: { flexDirection: "row", marginBottom: 10 },
  mapCanvasWrapper: {
    alignSelf: "center", marginBottom: 14, borderRadius: 14, overflow: "hidden",
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
  },
  metricsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  metricPill: {
    backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 8, minWidth: "47%", flex: 1,
  },
  metricPillLabel: {
    fontSize: 10, color: C.textMuted, textTransform: "uppercase",
    letterSpacing: 0.5, marginBottom: 4,
  },
  metricPillValue: { fontSize: 14, fontWeight: "700" },
  runHeader: { flexDirection: "row", alignItems: "flex-start", marginBottom: 12 },
  runSubtitle: { fontSize: 12, color: C.textMuted, marginTop: 2 },
  reconfigBtn: {
    backgroundColor: C.surfaceAlt, borderRadius: 8, paddingHorizontal: 12,
    paddingVertical: 8, borderWidth: 1, borderColor: C.border,
  },
  reconfigBtnText: { fontSize: 12, color: C.textSecondary },
  statusBanner: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
    marginBottom: 14, gap: 10,
  },
  statusBannerOk: { backgroundColor: "#0d2818", borderColor: "#238636" },
  statusBannerWarn: { backgroundColor: "#2b2111", borderColor: C.accentOrange },
  statusBannerError: { backgroundColor: "#2b1618", borderColor: C.accentRed },
  statusBannerText: { flex: 1, fontSize: 12, color: C.textPrimary, lineHeight: 17 },
  statusBannerBtn: {
    backgroundColor: C.surfaceAlt, borderRadius: 6, paddingHorizontal: 10,
    paddingVertical: 6, borderWidth: 1, borderColor: C.border,
  },
  statusBannerBtnText: { fontSize: 11, color: C.textPrimary, fontWeight: "600" },
  confRow: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  confLabel: { width: 68, fontSize: 12, color: C.textSecondary },
  confBarBg: {
    flex: 1, height: 6, backgroundColor: C.surfaceAlt, borderRadius: 3,
    overflow: "hidden", marginRight: 10,
  },
  confBarFill: { height: 6, borderRadius: 3 },
  confValue: { width: 36, fontSize: 12, color: C.textSecondary, textAlign: "right" },
  beaconInfoRow: { gap: 10 },
  beaconChip: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 6 },
  beaconChipLabel: { fontSize: 12, fontWeight: "600", marginBottom: 4 },
  beaconChipValue: { fontSize: 12, color: C.textMuted },
});
