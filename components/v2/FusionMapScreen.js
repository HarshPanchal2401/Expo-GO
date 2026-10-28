// ============================================================================
// FusionMapScreen.js — Live PDR + BLE Fusion Navigation on the Real Office Map
//
// Renders the actual office floor plan (assets/floorplans/office-70x70.png, 70 x 70 ft)
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
  useLayoutEffect,
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
  Share,
  Animated,
  Easing,
  Image,
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
import MobilityModeSwitch from "./MobilityModeSwitch.js";
import { ensureFloorplanMigrated, FLOORPLAN_W_FT, FLOORPLAN_H_FT } from "../../services/FloorplanMigration.js";
import { loadStartSpots, saveStartSpot, removeStartSpot, MAX_NAME } from "../../services/StartSpots.js";
import { checkRangeGeometry } from "../../services/BeaconRangingCalibration.js";
import { metresToFeet, feetToMetres } from "../../services/PdrEngine.js";
import { savePath, getSavedPaths, deleteSavedPath } from "../../PathStorage.js";
import { RangeAutoCalibrator } from "../../services/RangeAutoCalibrator.js";
import { RadioMap } from "../../services/RadioMap.js";
import { simpleRanging, SMOOTH_PRESETS, DIST_SMOOTH_PRESETS } from "../../services/SimpleRanging.js";
import { obstacleMap, OBSTACLE_TYPES, AREA_TYPES, DEFAULT_PILLAR_RADIUS_FT, ObstacleMap } from "../../services/ObstacleMap.js";
import { testRecorder } from "../../services/TestRecorder.js";
import { floorplanGrid } from "../../services/WalkableGrid.js";
import { wheelchairEngine } from "../../services/WheelchairEngine.js";
import { getAppSettings, subscribeAppSettings } from "../../services/appSettingsStorage.js";

// Everything the obstacle editor can draw: RF obstacles + no-walk areas.
const EDIT_TYPES = [...OBSTACLE_TYPES, ...AREA_TYPES];

const FLOORPLAN_IMAGE = require("../../assets/floorplans/office-70x70.png");

// Bump with every change to the locating/ranging behaviour. Shown on screen
// because an OTA update is only APPLIED on the next cold start after it
// downloads, so "I published the fix and it still fails" is very often the
// old bundle still running - this makes that visible instead of a guess.
const ENGINE_TAG = "motion-v20-align";

// How the phone is carried (services/CarryDetector.js). Pocket / ear /
// swinging: heading from the gyro alone, step length from the step rate.
const CARRY_TEXT = {
  texting: "in hand, screen up (compass + gyro)",
  vertical: "upright: ear / chest pocket (gyro heading)",
  swinging: "swinging hand / trouser pocket (gyro heading)",
  wheelchair: "wheelchair mode (rolling / Push button, gyro heading)",
};

let ExpoUpdates = null;
try {
  ExpoUpdates = require("expo-updates");
} catch (e) {}

const describeRunningBundle = () => {
  const created = ExpoUpdates?.createdAt ? new Date(ExpoUpdates.createdAt) : null;
  const when = created && !Number.isNaN(created.getTime())
    ? created.toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;
  const id = typeof ExpoUpdates?.updateId === "string" ? ExpoUpdates.updateId.slice(0, 8) : null;
  if (ExpoUpdates?.isEmbeddedLaunch || !id) return `Engine ${ENGINE_TAG} · built-in bundle`;
  return `Engine ${ENGINE_TAG} · update ${id}${when ? ` (${when})` : ""}`;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const SCREEN_W = Dimensions.get("window").width;
const MAP_PADDING = 20; // canvas margin (px)
const MAP_SIZE = SCREEN_W - 32; // canvas width (px) — height follows room aspect ratio
const CANVAS_SIZE = MAP_SIZE - MAP_PADDING * 2; // drawable area (px, square axis unit)

// The office drawing's real size (FloorplanMigration.js moves saves from earlier drawings onto it).
const DEFAULT_ROOM_W_FT = FLOORPLAN_W_FT;
// "Where are you?": a tap this close to spot A or B picks it (ft).
const CHOICE_TAP_FT = 10;
const DEFAULT_ROOM_H_FT = FLOORPLAN_H_FT;
const GRID_MINOR_FT = 2;   // matches the floor plan's own printed grid
const GRID_MAJOR_FT = 10;  // heavier labeled lines every 10 ft
const BEACON_RADIUS_PX = 15;
const USER_DOT_RADIUS = 9;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

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

// Colours for saved routes drawn on the map, assigned by age.
const SAVED_ROUTE_COLORS = ["#f0883e", "#db61a2", "#39c5cf", "#e3b341", "#a371f7", "#ff7b72"];

/**
 * Only routes recorded on THIS map are in floor-plan feet. The PDR tracker tab
 * saves into the same store in metres from its own origin, so drawing those
 * here would put them in the wrong place at the wrong scale. Routes saved
 * before the source tag existed are recognised by the name this screen gives.
 */
const isFusionMapRoute = (r) =>
  r?.source === "fusionMap" || (typeof r?.name === "string" && r.name.startsWith("Route "));

// A beacon whose last packet is older than this is not used for locating.
//
// Was 2.5 s, which assumed every beacon is heard several times a second. A
// weak or distant beacon - through walls, low transmit power, a 1 s advertising
// interval with packet loss - routinely goes 3-10 s between packets the phone
// actually receives, so BOTH beacons were almost never "fresh" at the same
// moment and locating collected nothing, indefinitely. While locating the user
// is standing still, so a range from a few seconds ago is still where they are.
const LOCATE_STALE_MS = 10000;

// Which 1 m reference a beacon's distance is computed from. Shown on the map
// because every distance scales with it, and "is this beacon calibrated?" is
// otherwise invisible from here.
// Spot calibration: settle after tapping, then average this long.
const SPOT_SETTLE_MS = 1500;
// Fastest screen redraw driven by BLE packets (see scheduleUiRefresh).
const UI_REFRESH_MS = 200;
const SPOT_WINDOW_MS = 6000;
// After a beacon fix the first corrections still move the position, often by
// many feet, a few times over. Until it holds still the map keeps showing the
// searching animation instead of a jumping dot: shown once the position has
// stayed within SETTLE_STEADY_FT for SETTLE_WINDOW_MS (and at least
// SETTLE_MIN_MS after the fix), at the first step, or after SETTLE_MAX_MS.
// Once the start is found, steps carry the track and beacons only correct it very slowly (1 = full influence).
const NAV_BLE_WEIGHT = 0.15;
const SETTLE_MIN_MS = 3000;
const SETTLE_WINDOW_MS = 3000;
const SETTLE_STEADY_FT = 3;
const SETTLE_MAX_MS = 15000;

/**
 * Fraction of the user's body loss that applies to a beacon: 0 when facing it,
 * 1 when it is directly behind. Heading and bearing share the app convention
 * (0 = map +Y, clockwise). Must match the shape the ranging engine was tuned on.
 */
function bodyShadowFraction(user, beacon, headingDeg) {
  const bearing = (Math.atan2(beacon.x - user.x, beacon.y - user.y) * 180) / Math.PI;
  const delta = ((headingDeg - bearing) * Math.PI) / 180;
  return Math.max(0, Math.min(1, (-Math.cos(delta) + 0.2) / 1.2));
}

const describeTxSource = (b) => {
  if (!b?.id) return "";
  const tx = Number.isFinite(b.txPower1m) ? `${b.txPower1m} dBm` : "?";
  const pts = b.calibrationPointsCount ? ` · ${b.calibrationPointsCount} pts` : "";
  const body = b.bodyLossDb > 0.2 ? ` · body +${b.bodyLossDb.toFixed(1)} dB` : "";
  const auto = b.autoPointsCount ? ` · ${b.autoPointsCount} auto` : "";
  const walls = Math.abs(b.locationCorrectionDb) >= 0.5
    ? ` · walls ${b.locationCorrectionDb > 0 ? "+" : ""}${b.locationCorrectionDb.toFixed(1)} dB` : "";
  const sig = Number.isFinite(b.rangeSigmaM) ? ` · ±${b.rangeSigmaM.toFixed(1)} m` : "";
  // RSSI@1m falls with distance (see DEFAULT_EXCESS_LOSS_DB_PER_M): show the
  // drop per metre and the value in effect at the current range.
  const slope = b.excessLossDbPerM > 0.05 ? ` −${b.excessLossDbPerM.toFixed(1)} dB/m` : "";
  const now = slope && Number.isFinite(b.txAtDistance) && Number.isFinite(b.distanceM)
    ? ` (now ${b.txAtDistance} @ ${b.distanceM.toFixed(1)} m)` : "";
  if (b.txSource === "calibrated") return `✓ Calibrated · 1 m = ${tx}${slope}${now} · n ${b.currentN}${pts}${auto}${body}${walls}${sig}`;
  if (b.txSource === "advertised") return `Not calibrated · using beacon's own 1 m = ${tx}`;
  return `Not calibrated · default 1 m = ${tx} — run Ranging Calibration`;
};
/** Expected obstacle loss (dB) between p and beacon `anchor`, with that beacon's fitted losses. */
function obstacleLossDb(beaconNum, p, anchor, sigmaFt = 0) {
  if (!anchor || !p || !obstacleMap.items.length) return 0;
  const losses = v2Scanner.getWallLosses(beaconNum) || undefined;
  return obstacleMap.expectedLoss(p, anchor, sigmaFt || 0, losses).lossDb;
}

/** "1 wall, 1 pillar" for the path from p to a beacon. */
function describeObstaclePath(p, anchor) {
  if (!anchor || !p || !obstacleMap.items.length) return "";
  const counts = obstacleMap.crossingCounts(p, anchor);
  const parts = OBSTACLE_TYPES.map((t, i) => (counts[i] ? `${counts[i]} ${t.label.toLowerCase()}` : null)).filter(Boolean);
  return parts.length ? parts.join(", ") : "clear line of sight";
}

/**
 * Beacon distance for the Fusion Map: the SIMPLE calculation, the same as the
 * Raw tab - Kalman-smoothed RSSI, then
 *   d = 10 ^ ((Measured Power - RSSI) / (10 n)).
 * Everything after it (locating, the position solve, PDR + BLE fusion) is
 * unchanged. Also returns a 1-sigma range uncertainty for the fusion filter:
 * a level error of sigmaDb dB moves the distance by d * sigmaDb * ln10 / (10 n),
 * so far beacons are trusted less. sigmaDb is the slow shadowing the Kalman
 * filter cannot remove (raw packets: more).
 */
function simpleRange(num) {
  const b = simpleRanging.getBeacon(num);
  if (!Number.isFinite(b.distanceM)) return { m: null, sigmaM: null, b };
  const sigmaDb = simpleRanging.settings.kalman ? 3 : 4.5;
  return { m: b.distanceM, sigmaM: (b.distanceM * sigmaDb * Math.LN10) / (10 * b.n), b };
}

function describeSimple(num) {
  const b = simpleRanging.getBeacon(num);
  const st = simpleRanging.settings;
  const filt = (st.kalman ? `RSSI Kalman ${(SMOOTH_PRESETS[st.smooth] || SMOOTH_PRESETS.medium).label}` : "raw RSSI") +
    (st.distKalman ? ` · dist Kalman ${(DIST_SMOOTH_PRESETS[st.distSmooth] || DIST_SMOOTH_PRESETS.medium).label}` : "");
  const rssi = Number.isFinite(b.used) ? `${b.used.toFixed(1)} dBm` : "no signal";
  return `Simple · MP ${b.mp} dBm · n ${b.n} · ${filt} · RSSI ${rssi}`;
}

const AUTO_CAL_PAUSE_TEXT = {
  "no-anchor": "tap 👆 Set My Start (or calibrate a spot), then walk",
  drift: "walked far enough that the track is uncertain - set the start or calibrate a spot again",
  "left-room": "track left the room - zero the heading, then set the start again",
  "heading-not-zeroed": "zero the heading first, then set the start",
  stopped: "navigation stopped",
  relocating: "locating again",
  disabled: "off",
};
const describeAutoCal = (st, headingOk) => {
  if (!st.enabled) return "🔄 Auto-calibration: OFF (tap to turn on)";
  const pts = `${st.points?.[1] || 0}+${st.points?.[2] || 0} points`;
  if (st.active) {
    return `🔄 Auto-calibrating while you walk · ${pts} · track ±${st.posSigmaM} m` +
      (headingOk ? "" : " · zero the heading!");
  }
  return `🔄 Auto-calibration waiting: ${AUTO_CAL_PAUSE_TEXT[st.pausedReason] || st.pausedReason || "idle"}` +
    (st.points?.[1] || st.points?.[2] ? ` · last walk ${pts}` : "");
};
const txSourceColor = (b) =>
  b?.txSource === "calibrated" ? C.accentGreen : b?.txSource === "advertised" ? C.accentOrange : C.accentRed;

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
 * rooms (today's 70×70 ft office) and non-square ones.
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

// ─── Map markers (native views) ──────────────────────────────────────────────
// The beacons, the user dot and its heading needle are native views over the
// map, not Svg elements. They follow a pinch / drag through the same native
// values that move the map (screen point = TX + Z * drawn point), so while
// zooming they keep their size, stay sharp and need no redraw. Inside the Svg
// they were redrawn with the whole map (a new full-size bitmap on Android) on
// every heading tick, and grew with the map during a pinch, then jumped back.

/** Native-driven screen position of a drawn (unzoomed) map point. */
function useMapPoint(nav, px, py) {
  const bx = Math.round(px * 10) / 10;
  const by = Math.round(py * 10) / 10;
  return useMemo(
    () => [
      { translateX: Animated.add(nav.TX, Animated.multiply(nav.Z, bx)) },
      { translateY: Animated.add(nav.TY, Animated.multiply(nav.Z, by)) },
    ],
    [nav, bx, by]
  );
}

const BEACON_HALO_PX = BEACON_RADIUS_PX * 2.2;
const BEACON_BOX_W = 160;
const BEACON_BOX_H = 2 * BEACON_HALO_PX + 30;

// ─── Draggable Beacon Marker ─────────────────────────────────────────────────

function BeaconMarker({
  id,
  label,
  color,
  worldPos,
  transform,
  roomH,
  nav,
  draggable,
  deviceName,
  onDragEnd,
  getScale,
}) {
  const [dragOffsetPx, setDragOffsetPx] = useState({ dx: 0, dy: 0 });
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => draggable,
        onMoveShouldSetPanResponder: () => draggable,
        onPanResponderMove: (_evt, gesture) => {
          setDragOffsetPx({ dx: gesture.dx, dy: gesture.dy });
        },
        onPanResponderRelease: (_evt, gesture) => {
          // Uses the EFFECTIVE on-screen scale, not the base one: while zoomed
          // in, a given finger travel covers fewer feet, and dividing by the
          // unzoomed scale would move the beacon much too far.
          const sc = getScale();
          const dxFt = gesture.dx / sc;
          const dyFt = -gesture.dy / sc; // screen down = world Y down
          setDragOffsetPx({ dx: 0, dy: 0 });
          onDragEndRef.current(id, worldPos.x + dxFt, worldPos.y + dyFt);
        },
      }),
    [draggable, getScale, id, worldPos.x, worldPos.y]
  );

  const basePx = worldToScreen(worldPos.x, worldPos.y, transform, roomH);
  const point = useMapPoint(nav, basePx.cx, basePx.cy);
  const subLabel = deviceName || `(${worldPos.x.toFixed(0)}, ${worldPos.y.toFixed(0)}) ft`;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.beaconBox,
        { left: -BEACON_BOX_W / 2 + dragOffsetPx.dx, top: -BEACON_BOX_H / 2 + dragOffsetPx.dy, transform: point },
      ]}
    >
      <View
        pointerEvents="none"
        style={[styles.mapCircle, {
          width: 2 * BEACON_HALO_PX, height: 2 * BEACON_HALO_PX, borderRadius: BEACON_HALO_PX,
          left: BEACON_BOX_W / 2 - BEACON_HALO_PX, top: BEACON_BOX_H / 2 - BEACON_HALO_PX,
          backgroundColor: color, opacity: 0.18,
        }]}
      />
      <View
        pointerEvents={draggable ? "auto" : "none"}
        style={[styles.mapCircle, styles.beaconCore, {
          width: 2 * BEACON_RADIUS_PX, height: 2 * BEACON_RADIUS_PX, borderRadius: BEACON_RADIUS_PX,
          left: BEACON_BOX_W / 2 - BEACON_RADIUS_PX, top: BEACON_BOX_H / 2 - BEACON_RADIUS_PX,
          backgroundColor: color, borderWidth: draggable ? 2 : 0,
        }]}
        {...panResponder.panHandlers}
      >
        <Text style={styles.beaconLabel}>{label}</Text>
      </View>
      <Text
        pointerEvents="none"
        numberOfLines={1}
        style={[styles.beaconSubLabel, { top: BEACON_BOX_H / 2 + BEACON_RADIUS_PX + 3, color }]}
      >
        {subLabel}
      </Text>
    </Animated.View>
  );
}

// ─── Heading needle ──────────────────────────────────────────────────────────
// Rotated natively from headingRef 20x a second: no React render, no redraw.
function HeadingNeedle({ headingRef, fallbackDeg, x, y, len, width, opacity }) {
  const startDeg = () => {
    const h = headingRef?.current;
    return Number.isFinite(h) ? h : Number.isFinite(fallbackDeg) ? fallbackDeg : 0;
  };
  const [rot] = useState(() => new Animated.Value(startDeg()));
  useEffect(() => {
    // Native once, then setValue() turns the needle without a React render.
    let last = startDeg();
    Animated.timing(rot, { toValue: last, duration: 0, useNativeDriver: true }).start();
    if (!headingRef) return undefined;
    const id = setInterval(() => {
      const h = headingRef.current;
      if (!Number.isFinite(h) || Math.abs(((((h - last) % 360) + 540) % 360) - 180) < 0.5) return;
      last = h;
      rot.setValue(h);
    }, 50);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingRef, rot]);
  useEffect(() => {
    if (!headingRef && Number.isFinite(fallbackDeg)) rot.setValue(fallbackDeg);
  }, [headingRef, fallbackDeg, rot]);
  // World heading (0°=+Y/up, 90°=+X/right) is clockwise on screen, as is rotate.
  const spin = useMemo(
    () => rot.interpolate({ inputRange: [-360, 360], outputRange: ["-360deg", "360deg"] }),
    [rot]
  );
  const boxStyle = useMemo(
    () => ({
      position: "absolute", left: x - len, top: y - len, width: 2 * len, height: 2 * len,
      opacity, transform: [{ rotate: spin }],
    }),
    [x, y, len, opacity, spin]
  );
  return (
    <Animated.View pointerEvents="none" style={boxStyle}>
      <View
        style={{
          position: "absolute", left: len - width / 2, top: 0, width, height: len,
          borderRadius: width / 2, backgroundColor: "#fff",
        }}
      />
    </Animated.View>
  );
}

// ─── User dot ────────────────────────────────────────────────────────────────
// Opacity reflects confidence, never overstates certainty.
const NEEDLE_LEN_PX = USER_DOT_RADIUS + 10;
const DOT_BOX = 2 * NEEDLE_LEN_PX;

function UserDotMarker({ nav, px, py, opacity, headingRef, fallbackDeg }) {
  const point = useMapPoint(nav, px, py);
  const circle = (r, color, alpha) => (
    <View
      style={[styles.mapCircle, {
        width: 2 * r, height: 2 * r, borderRadius: r,
        left: DOT_BOX / 2 - r, top: DOT_BOX / 2 - r,
        backgroundColor: color, opacity: alpha,
      }]}
    />
  );
  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: "absolute", left: -DOT_BOX / 2, top: -DOT_BOX / 2, width: DOT_BOX, height: DOT_BOX, transform: point }}
    >
      {circle(USER_DOT_RADIUS + 4, C.userDot, opacity * 0.25)}
      {circle(USER_DOT_RADIUS, C.userDot, opacity)}
      {circle(USER_DOT_RADIUS - 3, "#fff", opacity * 0.65)}
      {/* Heading indicator — short needle pointing the way the user is facing */}
      <HeadingNeedle
        headingRef={headingRef} fallbackDeg={fallbackDeg}
        x={DOT_BOX / 2} y={DOT_BOX / 2} len={NEEDLE_LEN_PX} width={2.5} opacity={opacity}
      />
    </Animated.View>
  );
}

// ─── Searching animation ─────────────────────────────────────────────────────
// Shown over the map while the position is being found (and settled), in
// place of a dot that would otherwise jump from guess to guess. Touches pass
// through, so "tap where you are" still works.
function SearchingOverlay({ label }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const ring = (delay) => {
    const v = pulse.interpolate({ inputRange: [0, 1], outputRange: delay ? [0.5, 1.5] : [0, 1] });
    const p = v.interpolate({ inputRange: [0, 1, 1.5], outputRange: [0, 1, 1], extrapolate: "clamp" });
    return {
      transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) }],
      opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
    };
  };
  return (
    <View style={styles.searchOverlay} pointerEvents="none">
      <View style={styles.searchPulseBox}>
        <Animated.View style={[styles.searchRing, ring(false)]} />
        <Animated.View style={[styles.searchRing, ring(true)]} />
        <View style={styles.searchCore} />
      </View>
      <View style={styles.searchChip}>
        <Text style={styles.searchChipText}>{label}</Text>
      </View>
    </View>
  );
}

// ─── Live Office Map SVG ─────────────────────────────────────────────────────

const DEFAULT_VIEW = { zoom: 1, cx: null, cy: null };

/**
 * The view (centred world point + zoom) as a transform of the drawn map: that
 * point placed at the canvas centre, at the requested magnification. Derived
 * from the point's BASE screen position, so it is right for any room shape.
 * A drawn (unzoomed) point p appears at (tx + z * p.cx, ty + z * p.cy).
 */
function computeViewTransform(view, baseTransform, roomW, roomH, canvasHeight) {
  const zoom = view.zoom ?? 1;
  const cx = Number.isFinite(view.cx) ? view.cx : roomW / 2;
  const cy = Number.isFinite(view.cy) ? view.cy : roomH / 2;
  const basePt = worldToScreen(cx, cy, baseTransform, roomH);
  return {
    tx: MAP_PADDING + CANVAS_SIZE / 2 - zoom * basePt.cx,
    ty: MAP_PADDING + canvasHeight / 2 - zoom * basePt.cy,
    z: zoom,
  };
}

// ─── Map line layer ──────────────────────────────────────────────────────────
// Grid, obstacles, routes, the walked path, range rings and halo: the thin
// lines, drawn as an Svg at one fixed view `vt` (stroke widths are divided by
// its zoom so they stay thin on screen). The floor-plan image, the dot and the
// beacons are native views instead (see OfficeMapCanvas).
const MapLineLayer = React.memo(function MapLineLayer({
  width, height, roomW, roomH, transform, vt,
  obstacles, obstacleVer, savedRoutesOnMap, lastTrail, live,
}) {
  const inv = 1 / vt.z;
  const toScreen = (wx, wy) => worldToScreen(wx, wy, transform, roomH);

  // Everything that does not change while walking, built once per view.
  const still = useMemo(() => {
    const roomPx = {
      x: MAP_PADDING + transform.offsetX,
      y: MAP_PADDING + transform.offsetY,
      w: roomW * transform.scale,
      h: roomH * transform.scale,
    };
    const minor = [];
    const major = [];
    for (let gx = 0; gx <= roomW + 0.001; gx += GRID_MINOR_FT) {
      const { cx } = toScreen(gx, 0);
      (Math.round(gx) % GRID_MAJOR_FT === 0 ? major : minor).push(
        <Line key={`v${gx}`} x1={cx} y1={roomPx.y} x2={cx} y2={roomPx.y + roomPx.h} />
      );
    }
    for (let gy = 0; gy <= roomH + 0.001; gy += GRID_MINOR_FT) {
      const { cy } = toScreen(0, gy);
      (Math.round(gy) % GRID_MAJOR_FT === 0 ? major : minor).push(
        <Line key={`h${gy}`} x1={roomPx.x} y1={cy} x2={roomPx.x + roomPx.w} y2={cy} />
      );
    }
    const labels = [];
    for (let gx = GRID_MAJOR_FT; gx <= roomW + 0.001; gx += GRID_MAJOR_FT) {
      const { cx } = toScreen(gx, 0);
      labels.push(
        <SvgText
          key={`vgl${gx}`} x={cx} y={roomPx.y - 4 * inv}
          textAnchor="middle" fontSize={8 * inv} fill={C.textMuted}
        >{gx}</SvgText>
      );
    }
    return (
      <>
        {/* ── Grid overlay (2 ft minor / 10 ft major, matches floor plan's own grid) ── */}
        <G stroke={C.gridMinor} strokeWidth={0.4 * inv}>{minor}</G>
        <G stroke={C.gridMajor} strokeWidth={0.9 * inv}>{major}</G>
        {labels}

        {/* ── Room boundary ── */}
        <Rect
          x={roomPx.x} y={roomPx.y} width={roomPx.w} height={roomPx.h}
          fill="none" stroke={C.border} strokeWidth={1.5} rx={2}
        />

        {/* ── Obstacles (walls, glass, pillars, cabinets) ── */}
        {obstacles.map((o) => {
          const t = EDIT_TYPES.find((k) => k.key === o.type);
          const color = t?.color || C.textSecondary;
          if (t?.area) {
            const a = toScreen(Math.min(o.x1, o.x2), Math.max(o.y1, o.y2));
            const b = toScreen(Math.max(o.x1, o.x2), Math.min(o.y1, o.y2));
            return (
              <Rect
                key={`ob-${o.id}`}
                x={Math.min(a.cx, b.cx)} y={Math.min(a.cy, b.cy)}
                width={Math.abs(b.cx - a.cx)} height={Math.abs(b.cy - a.cy)}
                fill={color} fillOpacity={0.14} stroke={color} strokeOpacity={0.7}
                strokeWidth={1.5 * inv} strokeDasharray={`${4 * inv},${3 * inv}`}
              />
            );
          }
          if (o.x1 !== undefined) {
            const a = toScreen(o.x1, o.y1);
            const b = toScreen(o.x2, o.y2);
            return (
              <Line
                key={`ob-${o.id}`}
                x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy}
                stroke={color} strokeWidth={(o.type === "glass" ? 3 : 4.5) * inv}
                strokeOpacity={0.9} strokeLinecap="round"
                strokeDasharray={o.type === "glass" ? `${5 * inv},${3 * inv}` : undefined}
              />
            );
          }
          const c = toScreen(o.x, o.y);
          return (
            <Circle
              key={`ob-${o.id}`}
              cx={c.cx} cy={c.cy} r={(o.r || DEFAULT_PILLAR_RADIUS_FT) * transform.scale}
              fill={color} fillOpacity={0.55} stroke={color} strokeWidth={1.5 * inv}
            />
          );
        })}

        {/* ── Saved routes ─────────────────────────────────────────────────
            Dashed, with a start dot and an end ring, so a recorded route is
            clearly a record and not the walk in progress. */}
        {savedRoutesOnMap.map((r) => {
          if (!r.points || r.points.length < 2) return null;
          const pts = r.points.map((pt) => toScreen(pt.x, pt.y));
          const first = pts[0];
          const last = pts[pts.length - 1];
          return (
            <G key={`saved-${r.id}`}>
              <Polyline
                points={pts.map((p) => `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(" ")}
                fill="none" stroke={r.color} strokeWidth={2.5 * inv}
                strokeDasharray={`${6 * inv},${4 * inv}`}
                strokeOpacity={0.9} strokeLinecap="round" strokeLinejoin="round"
              />
              <Circle cx={first.cx} cy={first.cy} r={4 * inv} fill={r.color} />
              <Circle cx={last.cx} cy={last.cy} r={5 * inv} fill="none" stroke={r.color} strokeWidth={2 * inv} />
            </G>
          );
        })}

        {/* The last walk, kept after Stop until the next navigation begins. */}
        {lastTrail && lastTrail.length > 1 && (
          <Polyline
            points={lastTrail.map((pt) => { const { cx, cy } = toScreen(pt.x, pt.y); return `${cx.toFixed(1)},${cy.toFixed(1)}`; }).join(" ")}
            fill="none" stroke={C.trail} strokeWidth={3 * inv}
            strokeOpacity={0.6} strokeLinecap="round" strokeLinejoin="round"
          />
        )}
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomW, roomH, transform, vt, obstacles, obstacleVer, savedRoutesOnMap, lastTrail]);

  const { userPx, alt, pending } = live;

  return (
    <Svg width={width} height={height} pointerEvents="none">
      <Defs>
        <RadialGradient id="haloGrad" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor={live.haloColor} stopOpacity="0.30" />
          <Stop offset="70%" stopColor={live.haloColor} stopOpacity="0.10" />
          <Stop offset="100%" stopColor={live.haloColor} stopOpacity="0.00" />
        </RadialGradient>
      </Defs>
      <G transform={`translate(${vt.tx} ${vt.ty}) scale(${vt.z})`}>
        {still}

        {/* ── "You're roughly here" proximity rings (NOT a precise fix) ── */}
        {live.rings.map((r) => (
          <Circle
            key={r.key} cx={r.cx} cy={r.cy} r={r.r}
            fill="none" stroke={r.color} strokeWidth={1.5}
            strokeDasharray={`${6 * inv},${5 * inv}`} strokeOpacity={0.55}
          />
        ))}

        {/* ── PDR path: the route actually walked ──────────────────────────
            Only drawn while navigating. Before that there is no journey to
            show, and rendering a stub of a trail during the locating phase
            would suggest movement the user has not made. */}
        {live.trailPoints && (
          <Polyline
            points={live.trailPoints}
            fill="none" stroke={C.trail} strokeWidth={3 * inv}
            strokeOpacity={0.85} strokeLinecap="round" strokeLinejoin="round"
          />
        )}

        {/* ── The other possible position ──────────────────────────────────
            Two range circles meet at two points and ranges alone cannot say
            which one you are standing on. Drawing the second candidate is more
            honest than picking one at random and rendering it like a certainty
            — and it shows the user immediately which way to walk to settle it. */}
        {alt && (() => {
          // Asking "where are you?": both spots labelled, the chosen one ringed.
          if (live.choosing) {
            const spot = (p, label) => {
              const on = live.startChoice === label;
              const r = (USER_DOT_RADIUS + 7) * inv;
              return (
                <G key={`choice-${label}`}>
                  <Circle
                    cx={p.cx} cy={p.cy} r={r}
                    fill={on ? C.accent : "#fff"} fillOpacity={on ? 0.25 : 0.6}
                    stroke={on ? C.accent : C.textMuted} strokeWidth={(on ? 3 : 2) * inv}
                    strokeDasharray={on ? undefined : `${4 * inv},${3 * inv}`}
                  />
                  <SvgText
                    x={p.cx} y={p.cy - r - 5 * inv} fontSize={15 * inv} fontWeight="900"
                    fill={on ? C.accent : C.textPrimary} textAnchor="middle"
                  >{label}</SvgText>
                </G>
              );
            };
            return (
              <>
                <Line
                  x1={userPx.cx} y1={userPx.cy} x2={alt.cx} y2={alt.cy}
                  stroke={C.textMuted} strokeWidth={1.5 * inv}
                  strokeDasharray={`${5 * inv},${5 * inv}`} strokeOpacity={0.5}
                />
                {spot(userPx, "A")}
                {spot(alt, "B")}
              </>
            );
          }
          return (
            <>
              <Line
                x1={userPx.cx} y1={userPx.cy} x2={alt.cx} y2={alt.cy}
                stroke={C.textMuted} strokeWidth={1.5 * inv}
                strokeDasharray={`${5 * inv},${5 * inv}`} strokeOpacity={0.5}
              />
              <Circle
                cx={alt.cx} cy={alt.cy} r={USER_DOT_RADIUS * inv}
                fill="none" stroke={C.textMuted} strokeWidth={2.5 * inv}
                strokeDasharray={`${4 * inv},${3 * inv}`} strokeOpacity={0.85}
              />
              <SvgText
                x={alt.cx} y={alt.cy + 4 * inv} fontSize={11 * inv} fontWeight="700"
                fill={C.textMuted} textAnchor="middle"
              >?</SvgText>
            </>
          );
        })()}

        {/* ── Uncertainty halo — grows honestly when the fix is unreliable ── */}
        {live.halo && (
          <Circle cx={live.halo.cx} cy={live.halo.cy} r={live.halo.r} fill="url(#haloGrad)" />
        )}

        {/* ── Start point the user tapped (not yet confirmed) ── */}
        {pending && (() => {
          const r = 11 * inv;
          return (
            <G>
              <Circle cx={pending.cx} cy={pending.cy} r={r * 1.9} fill={C.accent} fillOpacity={0.15} />
              <Circle cx={pending.cx} cy={pending.cy} r={r} fill="none" stroke={C.accent} strokeWidth={2.5 * inv} />
              <Line x1={pending.cx - r * 1.6} y1={pending.cy} x2={pending.cx + r * 1.6} y2={pending.cy} stroke={C.accent} strokeWidth={1.5 * inv} />
              <Line x1={pending.cx} y1={pending.cy - r * 1.6} x2={pending.cx} y2={pending.cy + r * 1.6} stroke={C.accent} strokeWidth={1.5 * inv} />
              <SvgText x={pending.cx} y={pending.cy - r * 2.2} textAnchor="middle" fontSize={10 * inv} fill={C.accent} fontWeight="bold">
                START
              </SvgText>
            </G>
          );
        })()}
      </G>
    </Svg>
  );
});

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
  headingRef = null,
  placementMode,
  onBeaconDragEnd,
  onGestureActive,
  navPhase = "idle",
  // The walk that just ended (frozen at Stop): stays drawn until the next navigation starts.
  lastTrail = null,
  savedRoutesOnMap = [],
  // Tap-to-choose: when on, a tap (not a drag) on the plan reports the tapped
  // floor-plan point in feet through onMapTap.
  pickMode = false,
  onMapTap,
  pendingPoint = null,
  obstacles = [],
  // Bumped whenever obstacles change (the list is edited in place).
  obstacleVer = 0,
  // "choosing": which of the two start spots the user picked ("A" | "B" | null).
  startChoice = null,
  // Position not known yet (locating / settling): no dot, halo or track -
  // the searching animation instead.
  searching = false,
  searchLabel = "",
  // Small panel at the bottom of the map (the A/B choice), so it is in view
  // without scrolling.
  bottomPanel = null,
}) {
  const {
    x, y, uncertaintyRadius, trail,
    totalDistanceFt = 0,
    netDisplacementFt = 0,
    isWalking = false,
    positionAmbiguous = false,
    alternatePosition = null,
  } = fusionState;
  const canvasHeight = Math.min(CANVAS_SIZE * (roomH / roomW), CANVAS_SIZE * 1.6);
  const W = MAP_SIZE;
  const H = canvasHeight + MAP_PADDING * 2;

  // ── Viewport model ───────────────────────────────────────────────────────
  // The view is described by WHICH WORLD POINT SITS AT THE CENTRE plus a zoom
  // factor, rather than by a pixel pan offset. With a pixel offset, the point
  // that stays still while zooming is whichever point was centred in the
  // UNPANNED view, so zooming after panning drifts the map away under your
  // finger. Anchoring on the centred world point keeps zoom stable wherever you
  // have scrolled to, and makes "centre on me" and "reset" trivial.
  const baseTransform = useMemo(
    () => computeTransform(roomW, roomH, CANVAS_SIZE, canvasHeight),
    [roomW, roomH, canvasHeight]
  );
  const transform = baseTransform;

  // ── Zoom / pan without redrawing ─────────────────────────────────────────
  // The view shown is three native values: Z (zoom) and TX/TY, a drawn point p
  // appearing at TX + Z * p. Pinch, drag and the zoom buttons change only
  // these (setValue / native-driver animations): no React render and no Svg
  // redraw per frame - each frame used to redraw the whole map, which is what
  // made zooming lag.
  //   • floor-plan image: a native image scaled by Z - sharp at any zoom;
  //   • dot, needle, beacons: native views placed at TX + Z * p - same size
  //     at any zoom;
  //   • thin lines (Svg): drawn at one view and scaled to the view shown. After
  //     a zoom they are drawn again at the new view in a SECOND, hidden copy,
  //     which is swapped in once drawn - so the redraw is never seen, and both
  //     copies always sit exactly where the map is.
  const liveRef = useRef(DEFAULT_VIEW); // the view shown (or being animated to)
  const geomRef = useRef(null);
  geomRef.current = { base: baseTransform, roomW, roomH, canvasHeight };
  const [nav] = useState(() => ({
    Z: new Animated.Value(1),
    TX: new Animated.Value(0),
    TY: new Animated.Value(0),
    O: [new Animated.Value(1), new Animated.Value(0)],
  }));
  const vtOf = useCallback((v) => {
    const g = geomRef.current;
    return computeViewTransform(v, g.base, g.roomW, g.roomH, g.canvasHeight);
  }, []);
  const showLive = useCallback((v) => {
    liveRef.current = v;
    const vt = vtOf(v);
    nav.Z.setValue(vt.z);
    nav.TX.setValue(vt.tx);
    nav.TY.setValue(vt.ty);
  }, [nav, vtOf]);
  // Placed again whenever the room / canvas geometry changes (and at mount).
  useLayoutEffect(() => {
    showLive(liveRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseTransform, canvasHeight]);
  useEffect(() => {
    // Native once; from then on setValue() moves the map without going through React.
    const vt = vtOf(liveRef.current);
    const now = (v, toValue) => Animated.timing(v, { toValue, duration: 0, useNativeDriver: true });
    Animated.parallel([
      now(nav.Z, vt.z), now(nav.TX, vt.tx), now(nav.TY, vt.ty), now(nav.O[0], 1), now(nav.O[1], 0),
    ]).start();
  }, [nav, vtOf]);

  // The two copies of the line layer: the view each is drawn at, and whether it
  // is drawn at all (the hidden copy is emptied once it is not needed).
  const [bufs, setBufs] = useState(() => [
    { view: DEFAULT_VIEW, show: true, token: 0 },
    { view: DEFAULT_VIEW, show: false, token: 0 },
  ]);
  const frontRef = useRef(0);
  const swapRef = useRef(null); // { back, token } while a new drawing is prepared
  const tokenRef = useRef(0);
  const hideTimerRef = useRef(null);

  // Redraw the lines at the view now shown, in the hidden copy.
  const commitView = useCallback((v) => {
    liveRef.current = v;
    const back = 1 - frontRef.current;
    const token = ++tokenRef.current;
    swapRef.current = { back, token };
    setBufs((b) => {
      const n = b.slice();
      n[back] = { view: v, show: true, token };
      return n;
    });
  }, []);
  // Once the hidden copy has been drawn (a few frames), swap the two in one step.
  useLayoutEffect(() => {
    const p = swapRef.current;
    if (!p || bufs[p.back].token !== p.token) return undefined;
    let raf = null;
    let frames = 0;
    const tick = () => {
      if (++frames < 3) {
        raf = requestAnimationFrame(tick);
        return;
      }
      if (swapRef.current !== p) return;
      swapRef.current = null;
      const old = frontRef.current;
      // Both in the same native batch, so they change in the same frame.
      nav.O[p.back].setValue(1);
      nav.O[old].setValue(0);
      frontRef.current = p.back;
      // Empty the old copy a little later (it is invisible already).
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        setBufs((b) => {
          if (frontRef.current === old || swapRef.current?.back === old || !b[old].show) return b;
          const n = b.slice();
          n[old] = { ...n[old], show: false };
          return n;
        });
      }, 300);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bufs, nav]);

  const bufVts = useMemo(
    () => bufs.map((b) => computeViewTransform(b.view, baseTransform, roomW, roomH, canvasHeight)),
    [bufs, baseTransform, roomW, roomH, canvasHeight]
  );
  // A copy drawn at view d shows view (Z, TX, TY) when scaled by k = Z / d.z and
  // moved so that a drawn point lands on TX + Z * p (RN scales about the centre).
  const bufStyles = useMemo(
    () => bufVts.map((d, i) => {
      const k = Animated.multiply(nav.Z, 1 / d.z);
      return {
        position: "absolute", left: 0, top: 0, width: W, height: H, opacity: nav.O[i],
        transform: [
          { translateX: Animated.add(nav.TX, Animated.add(Animated.multiply(k, W / 2 - d.tx), -W / 2)) },
          { translateY: Animated.add(nav.TY, Animated.add(Animated.multiply(k, H / 2 - d.ty), -H / 2)) },
          { scale: k },
        ],
      };
    }),
    [bufVts, nav, W, H]
  );
  const imageLayerStyle = useMemo(
    () => ({
      position: "absolute", left: 0, top: 0, width: W, height: H,
      transform: [
        { translateX: Animated.add(nav.TX, Animated.add(Animated.multiply(nav.Z, W / 2), -W / 2)) },
        { translateY: Animated.add(nav.TY, Animated.add(Animated.multiply(nav.Z, H / 2), -H / 2)) },
        { scale: nav.Z },
      ],
    }),
    [nav, W, H]
  );

  // Button zoom and "centre on me" are tweened (natively) rather than applied
  // instantly: a jump straight from 1x to 1.6x gives no sense of where the view
  // went. Pinch is NOT tweened - it must track the fingers exactly.
  const viewAnimRef = useRef(null); // { anim, target }
  const animateView = useCallback((target, durationMs = 220) => {
    const prev = viewAnimRef.current;
    viewAnimRef.current = null;
    prev?.anim.stop();
    // From the view shown (or being animated to), so quick taps add up.
    const from = liveRef.current;
    const to = {
      zoom: clamp(target.zoom ?? from.zoom ?? 1, MIN_ZOOM, MAX_ZOOM),
      cx: target.cx === undefined ? from.cx : target.cx,
      cy: target.cy === undefined ? from.cy : target.cy,
    };
    liveRef.current = to;
    const vt = vtOf(to);
    const opts = (toValue) => ({ toValue, duration: durationMs, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    const a = {
      target: to,
      anim: Animated.parallel([
        Animated.timing(nav.Z, opts(vt.z)),
        Animated.timing(nav.TX, opts(vt.tx)),
        Animated.timing(nav.TY, opts(vt.ty)),
      ]),
    };
    viewAnimRef.current = a;
    a.anim.start(({ finished }) => {
      if (viewAnimRef.current !== a) return;
      viewAnimRef.current = null;
      if (finished) commitView(to);
    });
  }, [nav, vtOf, commitView]);
  const stopViewAnim = useCallback(() => {
    const a = viewAnimRef.current;
    if (!a) return;
    viewAnimRef.current = null;
    a.anim.stop();
    showLive(a.target);
  }, [showLive]);
  useEffect(() => () => {
    const a = viewAnimRef.current;
    viewAnimRef.current = null;
    a?.anim.stop();
    clearTimeout(hideTimerRef.current);
  }, []);

  // Effective on-screen scale (px per ft) of the view shown, for drags.
  const getScale = useCallback(
    () => geomRef.current.base.scale * (liveRef.current.zoom ?? 1),
    []
  );

  // ── Gestures: drag to pan, pinch to zoom ────────────────────────────────
  // Live values are mirrored into refs so the responder can be created ONCE.
  // Rebuilding it while a gesture is in progress tears that gesture down.
  const placementRef = useRef(placementMode);
  placementRef.current = placementMode;
  const gestureRef = useRef({ startView: null, startDist: 0, pinching: false, sawPinch: false, moved: false });
  const pickRef = useRef(pickMode);
  pickRef.current = pickMode;
  const onMapTapRef = useRef(onMapTap);
  onMapTapRef.current = onMapTap;
  const onGestureActiveRef = useRef(onGestureActive);
  onGestureActiveRef.current = onGestureActive;
  const wrapperRef = useRef(null);

  // Screen tap -> floor-plan feet. Inverts exactly what rendering does: the
  // wrapper's position on the page (and its 1 px border), then the view
  // shown, then worldToScreen.
  const reportTap = (pageX, pageY) => {
    const node = wrapperRef.current;
    if (!node || typeof node.measure !== "function") return;
    node.measure((_fx, _fy, _w, _h, px, py) => {
      const g = geomRef.current;
      if (!g || !Number.isFinite(px) || !Number.isFinite(py)) return;
      const vt = vtOf(liveRef.current);
      const lx = pageX - px - 1;
      const ly = pageY - py - 1;
      const bx = (lx - vt.tx) / vt.z;
      const by = (ly - vt.ty) / vt.z;
      const wx = (bx - MAP_PADDING - g.base.offsetX) / g.base.scale;
      const wy = g.roomH - (by - MAP_PADDING - g.base.offsetY) / g.base.scale;
      const margin = 3; // allow a slightly-off tap at the wall
      if (wx < -margin || wx > g.roomW + margin || wy < -margin || wy > g.roomH + margin) return;
      onMapTapRef.current?.(clamp(wx, 0, g.roomW), clamp(wy, 0, g.roomH));
    });
  };
  const reportTapRef = useRef(reportTap);
  reportTapRef.current = reportTap;

  const touchDistance = (touches) =>
    Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);

  const mapPanResponder = useMemo(() => {
    const endGesture = () => {
      const gs = gestureRef.current;
      gs.pinching = false;
      gs.sawPinch = false;
      onGestureActiveRef.current?.(false);
      if (gs.moved) commitView(liveRef.current);
      gs.moved = false;
    };
    return PanResponder.create({
      // Crucially FALSE. Claiming the touch on press meant every tap was
      // swallowed before it reached the zoom buttons sitting on top of the
      // map, so those buttons simply did nothing. The map only takes over
      // once the finger actually moves, which leaves taps to the buttons.
      //
      // The exception is pick mode, where a TAP is the input: the map claims
      // the touch on press so it can tell a tap from a drag on release. The
      // zoom buttons still work, because they are deeper in the tree and the
      // deepest view is asked first.
      onStartShouldSetPanResponder: () => pickRef.current,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (evt, g) => {
        if (placementRef.current) return false; // markers own the drag there
        if (evt.nativeEvent.touches?.length === 2) return true;
        return Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4;
      },
      onPanResponderGrant: (evt) => {
        // Freeze the page scroll for the duration. The map lives inside a
        // ScrollView, and without this a mostly-vertical drag is claimed by
        // the scroll view instead of panning the map.
        onGestureActiveRef.current?.(true);
        const gs = gestureRef.current;
        // A zoom animation still running is finished at once (and drawn after).
        gs.moved = Boolean(viewAnimRef.current);
        stopViewAnim();
        gs.startView = { ...liveRef.current };
        const t = evt.nativeEvent.touches || [];
        gs.pinching = t.length === 2;
        gs.sawPinch = t.length === 2;
        gs.startDist = t.length === 2 ? touchDistance(t) : 0;
      },
      onPanResponderMove: (evt, g) => {
        const gs = gestureRef.current;
        const start = gs.startView;
        if (!start) return;
        const t = evt.nativeEvent.touches || [];

        if (t.length === 2) {
          // A pinch can begin part-way through a drag, so capture its
          // reference separation the first time two fingers are seen.
          if (!gs.pinching) {
            gs.pinching = true;
            gs.sawPinch = true;
            gs.startDist = touchDistance(t);
            gs.startView = { ...liveRef.current };
            return;
          }
          const d = touchDistance(t);
          if (gs.startDist > 10 && d > 10) {
            const next = clamp((gs.startView.zoom ?? 1) * (d / gs.startDist), MIN_ZOOM, MAX_ZOOM);
            gs.moved = true;
            showLive({ ...liveRef.current, zoom: next });
          }
          return;
        }

        if (gs.pinching) return; // ignore the leftover finger
        // Drag: moving the finger right should move the MAP right, which
        // means the centred world point moves left — hence the negated dx.
        const geo = geomRef.current;
        const sc = geo.base.scale * (start.zoom ?? 1) || 1;
        const startCx = Number.isFinite(start.cx) ? start.cx : geo.roomW / 2;
        const startCy = Number.isFinite(start.cy) ? start.cy : geo.roomH / 2;
        gs.moved = true;
        showLive({
          zoom: start.zoom ?? 1,
          cx: clamp(startCx - g.dx / sc, 0, geo.roomW),
          cy: clamp(startCy + g.dy / sc, 0, geo.roomH),
        });
      },
      onPanResponderRelease: (_evt, g) => {
        const wasPinch = gestureRef.current.sawPinch;
        endGesture();
        // A finger that barely moved is a tap, anything more was a pan.
        if (pickRef.current && !wasPinch && Math.abs(g.dx) < 8 && Math.abs(g.dy) < 8) {
          reportTapRef.current(g.x0, g.y0);
        }
      },
      onPanResponderTerminate: endGesture,
      // Hold the gesture against the enclosing ScrollView, which would
      // otherwise steal a vertical drag half-way through a pan.
      onPanResponderTerminationRequest: () => false,
    });
  }, [showLive, commitView, stopViewAnim]);

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
  const b1px = toScreen(anchor1.x, anchor1.y);
  const b2px = toScreen(anchor2.x, anchor2.y);
  // Ranges to the nearest half foot (~2 px): the rings then stay put instead of
  // redrawing the layer on every tiny wobble of the smoothed distance.
  const ringFt = (d) => (Number.isFinite(d) && d > 0 ? Math.round(d * 2) / 2 : null);
  const rings = [];
  if (ringFt(d1Ft) !== null) rings.push({ key: "r1", cx: b1px.cx, cy: b1px.cy, r: ringFt(d1Ft) * transform.scale, color: C.beacon1 });
  if (ringFt(d2Ft) !== null) rings.push({ key: "r2", cx: b2px.cx, cy: b2px.cy, r: ringFt(d2Ft) * transform.scale, color: C.beacon2 });

  const live = {
    rings,
    trailPoints: navPhase === "navigating" && !searching && trail.length > 1
      ? trail.map((pt) => {
        const { cx, cy } = toScreen(pt.x, pt.y);
        return `${cx.toFixed(1)},${cy.toFixed(1)}`;
      }).join(" ")
      : null,
    userPx,
    alt: positionAmbiguous && alternatePosition && !searching ? toScreen(alternatePosition.x, alternatePosition.y) : null,
    choosing: navPhase === "choosing",
    startChoice,
    haloColor: quality.color,
    halo: !searching && haloPx > 3 ? { cx: userPx.cx, cy: userPx.cy, r: Math.min(haloPx, CANVAS_SIZE) } : null,
    pending: pendingPoint ? toScreen(pendingPoint.x, pendingPoint.y) : null,
  };
  const shownLastTrail = navPhase !== "navigating" ? lastTrail : null;

  const showDot = !placementMode && !searching;
  const zoom = liveRef.current.zoom ?? 1;

  return (
    <View
      ref={wrapperRef} collapsable={false}
      style={[styles.mapCanvasWrapper, { width: W + 2, height: H + 2 }]}
      {...mapPanResponder.panHandlers}
    >
      {/* ── Real floor plan background ── drawn at twice the size and halved,
          so the image is loaded at full resolution and stays sharp zoomed in. */}
      <Animated.View pointerEvents="none" style={imageLayerStyle}>
        <Image
          source={FLOORPLAN_IMAGE}
          resizeMode="stretch"
          fadeDuration={0}
          style={{
            position: "absolute",
            left: roomPx.x - roomPx.w / 2, top: roomPx.y - roomPx.h / 2,
            width: roomPx.w * 2, height: roomPx.h * 2,
            opacity: 0.92, transform: [{ scale: 0.5 }],
          }}
        />
      </Animated.View>

      {[0, 1].map((i) => (
        <Animated.View key={`lines${i}`} pointerEvents="none" style={bufStyles[i]}>
          {bufs[i].show && (
            <MapLineLayer
              width={W} height={H}
              roomW={roomW} roomH={roomH}
              transform={baseTransform} vt={bufVts[i]}
              obstacles={obstacles} obstacleVer={obstacleVer}
              savedRoutesOnMap={savedRoutesOnMap}
              lastTrail={shownLastTrail}
              live={live}
            />
          )}
        </Animated.View>
      ))}

      {/* ── Beacon markers (draggable in placement mode) ── */}
      <BeaconMarker
        id={1} label="B1" color={C.beacon1} worldPos={anchor1}
        transform={transform} roomH={roomH} nav={nav} draggable={placementMode}
        getScale={getScale} deviceName={b1Name} onDragEnd={onBeaconDragEnd}
      />
      <BeaconMarker
        id={2} label="B2" color={C.beacon2} worldPos={anchor2}
        transform={transform} roomH={roomH} nav={nav} draggable={placementMode}
        getScale={getScale} deviceName={b2Name} onDragEnd={onBeaconDragEnd}
      />

      {/* ── Fused user position ── */}
      {showDot && (
        <UserDotMarker
          nav={nav} px={userPx.cx} py={userPx.cy} opacity={quality.dotOpacity}
          headingRef={headingRef} fallbackDeg={headingDeg}
        />
      )}

      {searching && <SearchingOverlay label={searchLabel} />}
      {bottomPanel}

      {/* ── Zoom controls ────────────────────────────────────────────────
          A 70 ft room on a phone screen puts roughly four feet in a
          fingertip, which is finer than the position is accurate — zooming is
          what makes the 2 ft grid usable for reading off a real location. */}
      <View style={styles.zoomCluster}>
        <TouchableOpacity
          style={styles.zoomBtn}
          onPress={() => animateView({ zoom: (liveRef.current.zoom ?? 1) * 1.6 })}
        >
          <Text style={styles.zoomBtnText}>+</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.zoomBtn}
          onPress={() => animateView({ zoom: (liveRef.current.zoom ?? 1) / 1.6 })}
        >
          <Text style={styles.zoomBtnText}>−</Text>
        </TouchableOpacity>
        {/* Centre on the user: with this viewport model that is simply
            "make the user's world position the centred one". */}
        <TouchableOpacity
          style={styles.zoomBtn}
          onPress={() => animateView({ zoom: Math.max(liveRef.current.zoom ?? 1, 2.5), cx: x, cy: y }, 320)}
        >
          <Text style={styles.zoomBtnIcon}>◎</Text>
        </TouchableOpacity>
        {(zoom !== 1 || Number.isFinite(liveRef.current.cx)) && (
          <TouchableOpacity
            style={styles.zoomBtn}
            onPress={() => animateView(DEFAULT_VIEW, 260)}
          >
            <Text style={styles.zoomBtnIcon}>⤢</Text>
          </TouchableOpacity>
        )}
      </View>
      {zoom !== 1 && !bottomPanel && (
        <View style={styles.zoomBadge} pointerEvents="none">
          <Text style={styles.zoomBadgeText}>{zoom.toFixed(1)}×</Text>
        </View>
      )}

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

function FusionMapScreen({
  pdrStepCallbackRef,
  pdrPreviewRef = null,
  headingRef,
  onZeroHeading,
  headingCalibrated = false,
}) {
  // Tracking is a sequence, not a switch. You cannot dead-reckon from an unknown
  // starting point, so the screen first LOCATES (standing still, accumulating
  // beacon ranges for an accurate fix), then NAVIGATES (PDR draws the path from
  // that fix). Running them together was what let a poor initial fix quietly
  // corrupt an otherwise good walk.
  //   idle       - not tracking
  //   locating   - collecting ranges, no PDR applied yet
  //   located    - fix established, waiting for the user to start walking
  //   navigating - PDR active, trail drawing
  const [navPhase, setNavPhase] = useState("idle");
  const [roomWidthStr, setRoomWidthStr] = useState(String(DEFAULT_ROOM_W_FT));
  const [roomHeightStr, setRoomHeightStr] = useState(String(DEFAULT_ROOM_H_FT));
  const roomW = parseFloatSafe(roomWidthStr, DEFAULT_ROOM_W_FT);
  const roomH = parseFloatSafe(roomHeightStr, DEFAULT_ROOM_H_FT);

  // Page scrolling is suspended while the map is being dragged or pinched.
  const [mapGestureActive, setMapGestureActive] = useState(false);
  const [savedRoutes, setSavedRoutes] = useState([]);
  const [showRoutes, setShowRoutes] = useState(false);
  // Saved routes currently drawn on the map. A just-saved route is added
  // automatically so the walk stays visible after Stop clears the live trail.
  const [shownRouteIds, setShownRouteIds] = useState(() => new Set());
  // The last walk, frozen when navigation stops, drawn until the next navigation starts.
  const [lastTrail, setLastTrail] = useState(null);
  const [locProgress, setLocProgress] = useState(null);
  // Read from inside sensor callbacks, which would otherwise capture a stale
  // value from the render they were created in.
  const headingCalibratedRef = useRef(headingCalibrated);
  headingCalibratedRef.current = headingCalibrated;
  const isRunning = navPhase !== "idle";
  // A new navigation starts a new walk: the previous one is no longer drawn.
  useEffect(() => { if (navPhase === "navigating") setLastTrail(null); }, [navPhase]);
  const [placementMode, setPlacementMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);


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
  // Current phase for timer callbacks, which would otherwise see a stale one.
  const navPhaseRef = useRef("idle");
  navPhaseRef.current = navPhase;
  // Packet counts when locating began, for the per-beacon diagnostics.
  const locateStartRef = useRef({ t: 0, p1: 0, p2: 0 });
  // Re-renders the locating diagnostics once a second.
  const [locateClock, setLocateClock] = useState(0);
  // When the last fix was committed, for the brief "position found" banner.
  const [locatedAt, setLocatedAt] = useState(0);
  // Start point tapped on the map in "picking", awaiting Start Here.
  const [pendingStart, setPendingStart] = useState(null);
  // Named start spots (Entrance, Desk 4 ...) saved on the phone.
  const [startSpots, setStartSpots] = useState([]);
  const [spotName, setSpotName] = useState("");
  useEffect(() => { loadStartSpots().then((l) => setStartSpots([...l])); }, []);
  const pickSpot = (spot) => {
    const w = floorplanGrid.nearest({ x: spot.x, y: spot.y });
    setPendingStart(w ? { x: w.x, y: w.y } : { x: spot.x, y: spot.y });
  };
  const handleSaveSpot = async () => {
    if (!pendingStart || !spotName.trim()) return;
    const res = await saveStartSpot(spotName, pendingStart.x, pendingStart.y);
    setStartSpots([...res.list]);
    if (!res.ok) { Alert.alert("Spot not saved", res.reason); return; }
    setSpotName("");
  };
  const handleDeleteSpot = async (id) => setStartSpots([...(await removeStartSpot(id))]);
  // "choosing": the beacons fit two spots; which one the user says they are at.
  const [startChoice, setStartChoice] = useState(null);
  const startChoiceRef = useRef(null);
  const pickStartChoice = (side) => {
    startChoiceRef.current = side;
    setStartChoice(side);
  };
  // Settling after a beacon fix (see SETTLE_*): the dot is not shown yet.
  const [settling, setSettling] = useState(false);
  const settlingRef = useRef(false);
  // Preview: where the dot is SHOWN ahead of the position while walking is being
  // confirmed (1-2 s). Feet. Never counted: confirmed steps replace it.
  const [previewOffset, setPreviewOffset] = useState(null);
  const previewRef = useRef({ dx: 0, dy: 0, timer: null });
  const clearPreview = useCallback(() => {
    const pv = previewRef.current;
    if (pv.timer) clearTimeout(pv.timer);
    previewRef.current = { dx: 0, dy: 0, timer: null };
    setPreviewOffset(null);
  }, []);
  settlingRef.current = settling;
  const settleRef = useRef({ start: 0, hist: [] });
  // "choosing" entered while settling: the filter already runs on both spots,
  // so a choice keeps one of them instead of starting navigation over.
  const choiceDuringNavRef = useRef(false);
  const revealPosition = () => {
    settlingRef.current = false;
    setSettling(false);
    setLocatedAt(Date.now());
    // Start settled: from here steps carry the track, beacons only nudge it.
    fusionEngine.setBleWeight(NAV_BLE_WEIGHT);
    setFusionState({ ...fusionEngine.getState() });
  };
  // Spot calibration: { stage: "pick" | "measuring" | "done", point, startedAt, result }
  const [spotCal, setSpotCal] = useState(null);
  const [spotClock, setSpotClock] = useState(0);
  // Auto-calibration: learns each beacon's distance model from the walked
  // (PDR-only) track after a known position - see RangeAutoCalibrator.
  // Radio map per beacon: walls, pillars and cabins, learned from calibration
  // points measured at known places (see RadioMap.js).
  const radioMapsRef = useRef(null);
  if (!radioMapsRef.current) radioMapsRef.current = { 1: new RadioMap(), 2: new RadioMap(), ver: {} };
  const [radioMapInfo, setRadioMapInfo] = useState({ 1: 0, 2: 0 });
  // Obstacles drawn on the plan (see ObstacleMap.js). obstacleVer re-renders.
  const [obstacleVer, setObstacleVer] = useState(0);
  // Drawing mode: { type, first: {x,y}|null, erase: bool } or null.
  const [obstacleEdit, setObstacleEdit] = useState(null);
  const anchorsRef = useRef({ a1: null, a2: null });
  const autoCalRef = useRef(null);
  if (!autoCalRef.current) {
    autoCalRef.current = new RangeAutoCalibrator({
      getLevelWindow: (num, fromT, toT) => v2Scanner.getLevelWindow(num, fromT, toT),
      addPoint: (num, dM, level, shape, sigmaDb, at) =>
        v2Scanner.addAutoCalibrationPoint(
          num, dM, level, shape, sigmaDb, at,
          radioMapsRef.current[num].query(at?.x, at?.y).meanDb
        ),
      getModel: (num) => v2Scanner.getRangingModel(num),
      save: () => v2Scanner.saveCalibrations(),
    });
  }
  const [autoCalStatus, setAutoCalStatus] = useState(() => autoCalRef.current.getStatus());
  // Packet count at the last BLE correction, so each packet corrects once.
  const lastCorrectPacketsRef = useRef(-1);
  // Packet counter at the last locating sample, so each packet is used once.
  const lastLocatePacketsRef = useRef(-1);
  // Result of the cold-start solve, surfaced so the map can explain an
  // unresolved or low-quality fix instead of silently showing a guess.
  const [initialFix, setInitialFix] = useState(null);

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
      // Saved positions from earlier drawings are moved onto the current one first.
      await ensureFloorplanMigrated();
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

  // ── Screen refresh, decoupled from the packet rate ─────────────────────────
  // Every BLE packet still updates the engine, but the screen is redrawn at
  // most UI_REFRESH_MS apart (with a trailing redraw so the last value always
  // shows). Redrawing this large screen on every packet saturated the JS
  // thread, which is what froze the UI and made the distances look stuck.
  const latestStatsRef = useRef(null);
  const uiRefreshRef = useRef({ last: 0, timer: null });
  const flushUi = useCallback(() => {
    uiRefreshRef.current.last = Date.now();
    uiRefreshRef.current.timer = null;
    const st = latestStatsRef.current;
    if (st) setBleStats({ b1: st.b1, b2: st.b2 });
    setFusionState({ ...fusionEngine.getState() });
  }, []);
  const scheduleUiRefresh = useCallback(() => {
    const r = uiRefreshRef.current;
    if (r.timer) return;
    const wait = UI_REFRESH_MS - (Date.now() - r.last);
    if (wait <= 0) flushUi();
    else r.timer = setTimeout(flushUi, wait);
  }, [flushUi]);
  useEffect(() => () => clearTimeout(uiRefreshRef.current.timer), []);

  // ── Simple distance calculation: make sure it is running (it listens to the
  // scanner's packets) even if the Raw tab was never opened.
  // Settings changed on those tabs (n, Measured Power, Kalman) redraw here.
  useEffect(() => simpleRanging.subscribe(() => scheduleUiRefresh()), [scheduleUiRefresh]);

  // ── BLE stats subscription: convert metres -> feet at this single boundary ──
  useEffect(() => {
    statsUnsubRef.current = v2Scanner.subscribeStats((stats) => {
      latestStatsRef.current = stats;
      scheduleUiRefresh();

      if (!isRunning || placementMode) return;
      // Choosing on the map: the user is deciding the start, so BLE must not.
      // Without this the "first reading places the user" path below would
      // overwrite the choice with a single-packet guess.
      if (navPhase === "picking") return;
      // Choosing between the two start spots: hold them still. A correction
      // now could quietly drop one of them while the user is deciding.
      if (navPhase === "choosing") return;

      // Distances from the simple calculation (see simpleRange); confidence,
      // packet counts and freshness still come from the scanner.
      const r1 = simpleRange(1);
      const r2 = simpleRange(2);
      const d1Ft = Number.isFinite(r1.m) ? metresToFeet(r1.m) : null;
      const d2Ft = Number.isFinite(r2.m) ? metresToFeet(r2.m) : null;
      const c1 = stats.b1?.confidenceScore ?? 0;
      const c2 = stats.b2?.confidenceScore ?? 0;
      if (!Number.isFinite(d1Ft) || !Number.isFinite(d2Ft)) return;

      // LOCATING: accumulate ranges instead of steering the filter. A fix from
      // one packet carries that packet's full range error into every position
      // that follows; a few seconds of packets cuts it from ~5.7 ft to ~2.1 ft.
      if (navPhase === "locating") {
        // One sample per NEW packet. Stats are re-emitted for every scanned
        // device, not just the two beacons, so without this the same pair of
        // ranges was averaged in many times over - which fakes precision and
        // would let the convergence test commit on far less evidence than it
        // thinks it has.
        const packets = (stats.b1?.totalPackets ?? 0) + (stats.b2?.totalPackets ?? 0);
        if (packets === lastLocatePacketsRef.current) return;
        lastLocatePacketsRef.current = packets;
        // A beacon that has gone quiet is reporting where the user WAS.
        const now = Date.now();
        const stale = (b) => !Number.isFinite(b?.lastSeen) || now - b.lastSeen > LOCATE_STALE_MS;
        if (stale(stats.b1) || stale(stats.b2)) return;
        const r = fusionEngine.feedLocatingSample(d1Ft, d2Ft, c1, c2);
        setLocProgress(r);
        if (r.done && r.fix?.position) completeLocating(r.fix);
        scheduleUiRefresh();
        return;
      }

      if (!coldStartDoneRef.current) {
        // First good reading since Start/Reset: establish WHERE THE USER IS by
        // intersecting the two range circles, and keep both intersection
        // candidates when the floor plan cannot rule one out.
        //
        // This replaces a call to computeWeightedPosition(), which was wrong
        // here twice over: it was handed anchors in FEET while its radii are in
        // METRES, and it returns a point on the beacon-to-beacon LINE because
        // it discards the perpendicular component. Together those pinned every
        // cold start to roughly the midpoint of the two beacons — which looks
        // correct only while the beacons sit side by side on one desk.
        const init = fusionEngine.initializeFromBeacons({
          d1: d1Ft, d2: d2Ft, conf1: c1, conf2: c2,
        });
        if (init.position) {
          coldStartDoneRef.current = true;
          setInitialFix(init);
          scheduleUiRefresh();
          return; // this packet was consumed by the cold-start placement
        }
        // Not confident enough yet — keep waiting rather than committing to a
        // noisy fix that every later position would inherit.
        setInitialFix(init);
        return;
      }

      // One correction per NEW packet. Stats are re-emitted on every scanned
      // device's packet (and on UI events), so the same pair of ranges used to
      // be applied many times over. Each repeat shrank the uncertainty as if it
      // were fresh evidence, so BLE was trusted far more than it deserved and
      // the dot jumped with every wobble of the ranges.
      const packets = (stats.b1?.totalPackets ?? 0) + (stats.b2?.totalPackets ?? 0);
      if (packets === lastCorrectPacketsRef.current) return;
      lastCorrectPacketsRef.current = packets;
      // Range uncertainty (grows with distance; shrinks where the radio map
      // has data) so far, doubtful ranges pull the position less.
      const s1 = Number.isFinite(r1.sigmaM) ? metresToFeet(r1.sigmaM) : null;
      const s2 = Number.isFinite(r2.sigmaM) ? metresToFeet(r2.sigmaM) : null;
      // Each smoothed range describes where the user was a moment ago (its
      // filter lag plus the age of its last packet); map matching compares it
      // with the position then, so walking is not pulled back.
      const nowMs = Date.now();
      const lagOf = (r) => (r.b.lagMs || 0) + (Number.isFinite(r.b.t) ? Math.max(0, nowMs - r.b.t) : 0);
      fusionEngine.correct(d1Ft, d2Ft, c1, c2, s1, s2, { lag1Ms: lagOf(r1), lag2Ms: lagOf(r2) });
      if (testRecorder.active) {
        const stAfter = fusionEngine.getState();
        testRecorder.add("ble", { d1: d1Ft, d2: d2Ft, x: stAfter.x, y: stAfter.y, text: stAfter.bleHeld ? `held: ${stAfter.bleHeld}` : "" });
      }
      scheduleUiRefresh();
    });
    return () => statsUnsubRef.current?.();
  }, [isRunning, navPhase, placementMode, anchor1, anchor2]);

  // ── Body shadow → ranging engine ───────────────────────────────────────────
  // Needs a known position and a heading aligned to the map. 4 Hz is plenty:
  // the fraction only changes as fast as the user turns or walks round.
  useEffect(() => {
    if (!headingCalibrated) return undefined;
    const id = setInterval(() => {
      let user = null;
      if (spotCal?.point && spotCal.stage !== "done") user = spotCal.point;
      else if (navPhase === "navigating" || navPhase === "located") {
        const st = fusionEngine.getState();
        user = { x: st.x, y: st.y };
      }
      const h = headingRef?.current;
      if (!user || !Number.isFinite(h)) return;
      v2Scanner.setBodyShadow({
        b1: bodyShadowFraction(user, anchor1, h),
        b2: bodyShadowFraction(user, anchor2, h),
      });
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingCalibrated, navPhase, spotCal?.stage, spotCal?.point, anchor1, anchor2]);

  anchorsRef.current = { a1: anchor1, a2: anchor2 };

  // ── Map matching (particle filter): what blocks walking, and how walls
  // lengthen the measured range at a place. On/off from Settings.
  useEffect(() => {
    // The floor plan's green area: the only place the user can be shown.
    floorplanGrid.setRoom(roomW, roomH);
    fusionEngine.setWalkableGrid(floorplanGrid);
    fusionEngine.setWalkableMap(obstacleMap.walkableMap({ w: roomW, h: roomH }));
    // Expected measured / straight-line range at (x, y): walls between there
    // and the beacon weaken the signal, which the simple formula reads as
    // extra distance. Cached on a 1 ft grid (particles ask a lot).
    const cache = new Map();
    fusionEngine.setParticleRangeFactor((x, y, num) => {
      const n = simpleRanging.pathLossN(num) || 2.5;
      const key = `${num}:${n}:${Math.round(x)}:${Math.round(y)}`;
      let f = cache.get(key);
      if (f === undefined) {
        const a = num === 1 ? anchor1 : anchor2;
        const L = obstacleMap.items.length
          ? ObstacleMap.lossFromCounts(obstacleMap.crossingCounts({ x: Math.round(x), y: Math.round(y) }, a))
          : 0;
        f = Math.pow(10, L / (10 * n));
        if (cache.size > 40000) cache.clear();
        cache.set(key, f);
      }
      return f;
    });
  }, [obstacleVer, roomW, roomH, anchor1, anchor2]);
  useEffect(() => {
    const apply = (st) => {
      fusionEngine.setParticleFilterEnabled(st?.particleFilter !== false);
      fusionEngine.setMobility(st?.mobilityMode);
      setMobilityMode(st?.mobilityMode === "wheelchair" ? "wheelchair" : "walking");
    };
    apply(getAppSettings());
    return subscribeAppSettings(apply);
  }, []);
  // Walking or wheelchair (Settings): wheelchair mode shows the Push button.
  const [mobilityMode, setMobilityMode] = useState(
    () => (getAppSettings()?.mobilityMode === "wheelchair" ? "wheelchair" : "walking")
  );
  // How the phone is carried, from the last step (MotionEngine / CarryDetector).
  const [carryMode, setCarryMode] = useState(null);
  const [recState, setRecState] = useState(() => ({
    active: testRecorder.active, rows: testRecorder.rows.length, truths: testRecorder.truthCount,
  }));
  useEffect(() => testRecorder.subscribe((r) => setRecState({ active: r.active, rows: r.rows.length, truths: r.truthCount })), []);

  // ── Obstacles: load once; push geometry to the calibration and locating ───
  useEffect(() => {
    ensureFloorplanMigrated()
      .then(() => obstacleMap.load())
      .then(() => setObstacleVer((v) => v + 1));
  }, []);
  const beaconIdKey = `${bleStats.b1?.id || ""}|${bleStats.b2?.id || ""}`;
  useEffect(() => {
    v2Scanner.setObstacleGeometry(obstacleMap, anchor1, anchor2);
    // Locating: the factor each range is shortened by at a candidate place,
    // for what the obstacles AND the radio map say is lost between there and
    // the beacon (see FusionEngine._solveWithObstacles).
    fusionEngine.setRangeCorrector((x, y) => {
      const out = {};
      for (const [num, key, a] of [[1, "f1", anchor1], [2, "f2", anchor2]]) {
        const L = obstacleLossDb(num, { x, y }, a, 3) - radioMapsRef.current[num].query(x, y).meanDb;
        // Same n as the distances themselves (simple calculation).
        const n = simpleRanging.pathLossN(num) || 2.9;
        out[key] = Math.pow(10, -L / (10 * n));
      }
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obstacleVer, anchor1, anchor2, beaconIdKey]);

  // ── Radio map → ranging engine (4 Hz) ──────────────────────────────────────
  // Rebuilds a beacon's map whenever its model was refitted, and feeds the
  // correction at the user's current position. Without a known position (idle,
  // locating) nothing is applied and ranging uses the plain distance model.
  useEffect(() => {
    const id = setInterval(() => {
      const maps = radioMapsRef.current;
      let changed = false;
      for (const num of [1, 2]) {
        const ver = v2Scanner.getCalibrationVersion(num);
        if (maps.ver[num] !== ver) {
          maps.ver[num] = ver;
          maps[num].build(v2Scanner.getRadioMapPoints(num));
          changed = true;
        }
      }
      if (changed) setRadioMapInfo({ 1: maps[1].pts.length, 2: maps[2].pts.length });
      const phase = navPhaseRef.current;
      if (phase !== "navigating" && phase !== "located") return;
      const st = fusionEngine.getState();
      const corr = {};
      const { a1, a2 } = anchorsRef.current;
      for (const [num, key, a] of [[1, "b1", a1], [2, "b2", a2]]) {
        const q = maps[num].query(st.x, st.y);
        // Obstacles between here and the beacon (added back), then whatever
        // the radio map has measured on top of them (residual = measured -
        // model, so minus it). Averaged over the position uncertainty so the
        // correction changes smoothly as the estimate crosses a wall.
        const wallDb = obstacleLossDb(num, st, a, st.uncertaintyRadius);
        corr[key] = { db: wallDb - q.meanDb, sdDb: Math.sqrt(q.sdDb ** 2 + 2.25), wallDb };
      }
      v2Scanner.setLocationCorrection(corr);
    }, 250);
    return () => clearInterval(id);
  }, []);

  // ── Auto-calibration: geometry, and a 4 Hz tick that records points ───────
  useEffect(() => {
    autoCalRef.current.setGeometry(anchor1, anchor2, roomW, roomH);
  }, [anchor1, anchor2, roomW, roomH]);
  useEffect(() => {
    const ac = autoCalRef.current;
    const id = setInterval(() => {
      const wasActive = ac.active;
      const added = ac.tick(Date.now());
      if (added.length || wasActive !== ac.active) setAutoCalStatus(ac.getStatus());
    }, 250);
    return () => clearInterval(id);
  }, []);

  // ── Spot calibration: wait while the user stands still, then record ────────
  useEffect(() => {
    if (spotCal?.stage !== "measuring") return undefined;
    const id = setInterval(() => {
      const now = Date.now();
      setSpotClock(now);
      const startedAt = spotCal.startedAt;
      // Moving spoils it: the point was measured somewhere else.
      if (Number.isFinite(v2Scanner._lastStepAt) && v2Scanner._lastStepAt > startedAt + 500) {
        setSpotCal((c) => c && { ...c, stage: "done", result: { ok: false, moved: true } });
        return;
      }
      if (now - startedAt < SPOT_SETTLE_MS + SPOT_WINDOW_MS) return;
      // 1 m calibration: this beacon's own RSSI@1m, measured.
      if (spotCal.oneMeter) {
        const num = spotCal.oneMeter;
        const key = num === 1 ? "b1" : "b2";
        const avg = v2Scanner.getRecentRangingLevel(num, SPOT_WINDOW_MS);
        let r;
        if (!avg.ok) r = { ok: false, error: avg.error };
        else {
          const res = v2Scanner.set1MeterTxPower(num, avg.level, { measured: true });
          r = { ok: true, oneMeter: true, txPower1m: res.txPower1m, unsteady: avg.sigmaDb > 6 };
        }
        setSpotCal((c) => c && { ...c, stage: "done", result: { ok: r.ok, beacons: { [key]: r } } });
        return;
      }
      const toM = (a) => feetToMetres(Math.hypot(spotCal.point.x - a.x, spotCal.point.y - a.y));
      const result = v2Scanner.addSpotCalibration({ b1: toM(anchor1), b2: toM(anchor2) }, SPOT_WINDOW_MS, spotCal.point);
      // The user is standing exactly here: walking on from it auto-calibrates.
      if (result?.ok) {
        autoCalRef.current.setAnchor(spotCal.point.x, spotCal.point.y, "spot", now);
        setAutoCalStatus(autoCalRef.current.getStatus());
      }
      setSpotCal((c) => c && { ...c, stage: "done", result });
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotCal?.stage]);

  // ── PDR step hook: convert metres -> feet at this single boundary ──
  useEffect(() => {
    if (pdrStepCallbackRef) {
      pdrStepCallbackRef.current = ({ stepLengthMeters, heading, carry, headingReset, t }) => {
        // Steps are ignored until navigation starts. While locating, the user is
        // meant to be standing still, and feeding steps in would move the very
        // position being measured.
        if (placementMode) return;
        // Auto-calibration's own PDR-only track. Needs the heading aligned to
        // the map, or every step goes the wrong way.
        const ac = autoCalRef.current;
        if (ac.active) {
          if (headingCalibratedRef.current) ac.onStep(stepLengthMeters, heading, Date.now());
          else ac.stop("heading-not-zeroed");
          if (!ac.active) setAutoCalStatus(ac.getStatus());
        }
        // Walking during locating ends it: from here on the ranges describe a
        // moving position, so waiting longer would only blur the fix. Commit
        // what has been collected and let this step be the first one tracked.
        if (navPhase === "locating") {
          const fix = fusionEngine.finishLocatingNow();
          // Already moving: no time to ask; moving settles which spot it is.
          if (!fix || !completeLocating(fix, { skipChoice: true })) return;
        } else if (navPhase === "choosing") {
          // Started moving without pressing Start: go with the spot picked so
          // far, or let the movement decide between the two.
          beginFromChoice(startChoiceRef.current);
        } else if (navPhase !== "navigating") {
          return;
        }
        // Confirmed steps replace the preview.
        if (previewRef.current.dx || previewRef.current.dy) clearPreview();
        // Walking: the position is shown from the first step on.
        if (settlingRef.current) revealPosition();
        const stepLengthFt = metresToFeet(stepLengthMeters);
        // After the phone was moved (pocket, ear) the walking direction was
        // carried over, not measured: let the map matching re-check it.
        fusionEngine.predict(stepLengthFt, heading, { headingJumpSdDeg: headingReset ? 15 : 0, t });
        if (carry) setCarryMode(carry);
        const stAfter = fusionEngine.getState();
        testRecorder.add("step", { len: stepLengthFt, heading, x: stAfter.x, y: stAfter.y, text: carry || "" });
        setFusionState({ ...stAfter });
      };
      return () => {
        pdrStepCallbackRef.current = null;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdrStepCallbackRef, navPhase, placementMode]);

  // ── Preview: move the dot at the first steps, before walking is confirmed ──
  useEffect(() => {
    if (!pdrPreviewRef) return undefined;
    pdrPreviewRef.current = (ev) => {
      if (ev?.type === "cancel") { clearPreview(); return; }
      // Only while navigating with the dot shown.
      if (ev?.type !== "step" || navPhase !== "navigating" || placementMode || settlingRef.current) return;
      const st = fusionEngine.getState();
      const pv = previewRef.current;
      const from = { x: st.x + pv.dx, y: st.y + pv.dy };
      const len = metresToFeet(ev.lengthM || 0.7) * (ev.count || 1);
      const r = ((Number.isFinite(ev.headingDeg) ? ev.headingDeg : 0) * Math.PI) / 180;
      // On the green only: as far along the step as the floor allows.
      let to = null;
      for (const f of [1, 0.75, 0.5, 0.25]) {
        const p = { x: from.x + f * len * Math.sin(r), y: from.y + f * len * Math.cos(r) };
        if (floorplanGrid.segmentWalkable(from.x, from.y, p.x, p.y)) { to = p; break; }
      }
      if (!to) return;
      if (pv.timer) clearTimeout(pv.timer);
      // Safety: a preview never stays more than a few seconds without confirmed steps.
      const timer = setTimeout(clearPreview, 3000);
      previewRef.current = { dx: to.x - st.x, dy: to.y - st.y, timer };
      setPreviewOffset({ dx: to.x - st.x, dy: to.y - st.y });
    };
    return () => {
      if (pdrPreviewRef.current) pdrPreviewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdrPreviewRef, navPhase, placementMode]);
  // Leaving navigation (Stop, Re-locate) drops any preview.
  useEffect(() => { if (navPhase !== "navigating") clearPreview(); }, [navPhase, clearPreview]);
  useEffect(() => () => { if (previewRef.current.timer) clearTimeout(previewRef.current.timer); }, []);

  // ── Settling after a beacon fix (see SETTLE_*) ──
  useEffect(() => {
    if (navPhase !== "navigating" || !settling) return undefined;
    const id = setInterval(() => {
      const now = Date.now();
      const sr = settleRef.current;
      const st = fusionEngine.getState();
      // Two spots fit the beacons: ask the user, as at the start.
      if (st.positionAmbiguous && st.alternatePosition) {
        settlingRef.current = false;
        setSettling(false);
        choiceDuringNavRef.current = true;
        pickStartChoice(null);
        setFusionState({ ...st });
        setNavPhase("choosing");
        return;
      }
      sr.hist.push({ t: now, x: st.x, y: st.y });
      while (sr.hist.length && sr.hist[0].t < now - SETTLE_WINDOW_MS) sr.hist.shift();
      let spread = 0;
      for (const a of sr.hist) for (const b of sr.hist) spread = Math.max(spread, Math.hypot(a.x - b.x, a.y - b.y));
      const elapsed = now - sr.start;
      const covered = sr.hist.length > 0 && now - sr.hist[0].t >= SETTLE_WINDOW_MS - 400;
      if ((elapsed >= SETTLE_MIN_MS && covered && spread <= SETTLE_STEADY_FT) || elapsed >= SETTLE_MAX_MS) {
        revealPosition();
      }
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navPhase, settling]);

  // ── Tick interval (passive uncertainty growth + UI refresh) ──
  useEffect(() => {
    if (isRunning && !placementMode) {
      tickIntervalRef.current = setInterval(() => {
        fusionEngine.tick();
        // Time limits must fire even when no new sample arrives.
        if (navPhaseRef.current === "locating") {
          const r = fusionEngine.checkLocatingTimeout();
          if (r) {
            setLocProgress(r);
            if (r.done && r.fix?.position) completeLocating(r.fix);
          }
        }
        setFusionState({ ...fusionEngine.getState() });
        setLocateClock(Date.now());
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

  /** Begins the LOCATE phase: stand still while ranges are collected. */
  const handleStartLocating = () => {
    fusionEngine.setRoomSize(roomW, roomH);
    fusionEngine.setBleAnchors(anchor1, anchor2);
    coldStartDoneRef.current = false;
    setInitialFix(null);
    setLocProgress(null);
    fusionEngine.beginLocating();
    locateStartRef.current = {
      t: Date.now(),
      p1: bleStats.b1?.totalPackets ?? 0,
      p2: bleStats.b2?.totalPackets ?? 0,
    };
    setNavPhase("locating");
  };

  /**
   * Position fixed: stop locating and start navigating, always.
   *
   * It used to stop at "located" whenever the heading had never been zeroed,
   * waiting for a button press - which on screen looked exactly like locating
   * never finishing. Navigation now starts immediately; if the heading is not
   * aligned yet, the Zero Heading prompt stays visible while navigating, since
   * zeroing does not depend on the position and can be done at any time.
   * @returns true (navigation has started).
   */
  const completeLocating = (fix, { skipChoice = false, keepSide = null } = {}) => {
    // Two spots fit the beacons equally: ask the user which one, before
    // navigating, instead of starting on a guess.
    if (!skipChoice && fix?.status === "ambiguous" && fix.alternate && fusionEngine.getState().positionAmbiguous) {
      setInitialFix(fix);
      coldStartDoneRef.current = true;
      setLocProgress(null);
      pickStartChoice(null);
      setFusionState({ ...fusionEngine.getState() });
      setNavPhase("choosing");
      return true;
    }
    // A start chosen on the map starts an auto-calibration track. A BLE fix
    // does not: it comes from the very ranges being calibrated, so learning
    // from it would only confirm their errors.
    if (fix?.position && fix.status === "manual") {
      autoCalRef.current.setAnchor(fix.position.x, fix.position.y, "manual");
      setAutoCalStatus(autoCalRef.current.getStatus());
    }
    setInitialFix(fix);
    coldStartDoneRef.current = true;
    setLocProgress(null);
    fusionEngine.beginNavigation({ keepSide });
    const st0 = fusionEngine.getState();
    testRecorder.add("start", { x: st0.x, y: st0.y, text: fix?.status || "" });
    setFusionState({ ...st0 });
    setNavPhase("navigating");
    // A beacon fix is still being corrected for a while: hold the dot back
    // until it settles. A spot the user chose, or a start while already
    // walking, shows at once.
    // Next to a beacon the fix is already the best there is: the other beacon's
    // (far, unreliable) range must not move it during a settling phase.
    const settle = !skipChoice && fix?.status !== "manual" && !fix?.nearBeacon;
    choiceDuringNavRef.current = false;
    settleRef.current = { start: Date.now(), hist: [] };
    settlingRef.current = settle;
    setSettling(settle);
    // Beacons settle a beacon fix at full strength; a chosen start, or one made while walking, nudges only.
    fusionEngine.setBleWeight(settle ? 1 : NAV_BLE_WEIGHT);
    setLocatedAt(settle ? 0 : Date.now());
    return true;
  };

  /**
   * Leaves "choosing": side "A" / "B" keeps that spot; null keeps both and
   * lets the first steps (walls, beacons) decide.
   */
  const beginFromChoice = (side) => {
    const st = fusionEngine.getState();
    let p = null;
    if (side && st.positionAmbiguous && st.alternatePosition) {
      p = side === "A" ? { x: st.x, y: st.y } : { ...st.alternatePosition };
      fusionEngine.chooseHypothesisNear(p.x, p.y);
    }
    pickStartChoice(null);
    if (choiceDuringNavRef.current) {
      // Asked while settling: navigation is already running on both spots.
      // Keep the chosen one (done above) - or both, to walk and decide.
      choiceDuringNavRef.current = false;
      setNavPhase("navigating");
      revealPosition();
      return;
    }
    completeLocating(
      { ...initialFix, reason: side ? `user-chose-${side}` : "walk-to-decide" },
      { skipChoice: true, keepSide: p }
    );
  };

  /** Commits the fix and starts drawing the walked path from it. */
  const handleStartNavigation = () => {
    fusionEngine.beginNavigation();
    fusionEngine.setBleWeight(NAV_BLE_WEIGHT);
    setFusionState({ ...fusionEngine.getState() });
    setNavPhase("navigating");
  };

  const refreshRoutes = useCallback(async () => {
    try { setSavedRoutes(await getSavedPaths()); }
    catch (err) { console.warn("[FusionMap] could not load saved routes:", err); }
  }, []);

  useEffect(() => { refreshRoutes(); }, [refreshRoutes]);

  /**
   * Saves the walked route. Stores the WALKED distance (step odometry) rather
   * than the length of the drawn track, for the same reason the map displays
   * it that way: the track also contains BLE correction movement, so using it
   * would record a longer walk than actually happened.
   */
  const handleSaveRoute = async () => {
    const st = fusionEngine.getState();
    if (!st.trail || st.trail.length < 2) {
      Alert.alert("Nothing to Save", "Walk a route first — there is no path recorded yet.");
      return;
    }
    try {
      const updated = await savePath({
        name: `Route ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${st.totalDistanceFt.toFixed(0)} ft`,
        steps: st.stepCount,
        distance: Number(st.totalDistanceFt.toFixed(2)),
        points: st.trail.map((pt) => ({ x: pt.x, y: pt.y })),
        source: "fusionMap",
        units: "ft",
      });
      const newId = updated?.[0]?.id;
      if (newId) setShownRouteIds((prev) => new Set(prev).add(newId));
      await refreshRoutes();
      Alert.alert("Route Saved", `${st.stepCount} steps · ${st.totalDistanceFt.toFixed(1)} ft walked.`);
    } catch (err) {
      Alert.alert("Save Failed", String(err?.message || err));
    }
  };

  // Stable colour per route: its position among the map's routes counted from
  // the oldest, so saving a new route does not recolour the ones already shown.
  const routeColor = (id) => {
    const mapRoutes = savedRoutes.filter(isFusionMapRoute);
    const idx = Math.max(0, mapRoutes.length - 1 - mapRoutes.findIndex((r) => r.id === id));
    return SAVED_ROUTE_COLORS[idx % SAVED_ROUTE_COLORS.length];
  };

  // Same array between renders, so the map's background layer is not redrawn.
  const savedRoutesOnMap = useMemo(
    () => savedRoutes
      .filter((r) => shownRouteIds.has(r.id) && isFusionMapRoute(r))
      .map((r) => ({ id: r.id, points: r.points, color: routeColor(r.id) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savedRoutes, shownRouteIds]
  );

  const toggleRouteOnMap = (id) => {
    setShownRouteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleDeleteRoute = async (id) => {
    setShownRouteIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    try { await deleteSavedPath(id); await refreshRoutes(); }
    catch (err) { console.warn("[FusionMap] delete failed:", err); }
  };

  /** Manual start: the user taps where they are, then confirms. */
  const handleStartPicking = () => {
    fusionEngine.cancelLocating();
    setLocProgress(null);
    setPendingStart(null);
    setNavPhase("picking");
  };

  const handleStartSpotCal = () => setSpotCal({ stage: "pick", point: null });

  const obstaclesChanged = () => {
    obstacleMap.save();
    setObstacleVer((v) => v + 1);
  };

  const handleMapTap = (xRaw, yRaw) => {
    // Drawing obstacles uses the exact tap; everything else is about where a
    // PERSON is, which can only be on the walkway (the plan's green area).
    let xFt = xRaw, yFt = yRaw;
    if (!obstacleEdit) {
      const s = floorplanGrid.nearest({ x: xRaw, y: yRaw });
      if (s) { xFt = s.x; yFt = s.y; }
    }
    if (obstacleEdit) {
      const t = EDIT_TYPES.find((k) => k.key === obstacleEdit.type);
      if (obstacleEdit.erase) {
        if (obstacleMap.removeNear(xFt, yFt)) obstaclesChanged();
      } else if (t?.point) {
        obstacleMap.add({ type: t.key, x: xFt, y: yFt, r: DEFAULT_PILLAR_RADIUS_FT });
        obstaclesChanged();
      } else if (!obstacleEdit.first) {
        setObstacleEdit({ ...obstacleEdit, first: { x: xFt, y: yFt } });
      } else {
        const f = obstacleEdit.first;
        if (Math.hypot(f.x - xFt, f.y - yFt) >= 1) {
          obstacleMap.add({ type: t.key, x1: f.x, y1: f.y, x2: xFt, y2: yFt });
          obstaclesChanged();
        }
        setObstacleEdit({ ...obstacleEdit, first: null });
      }
      return;
    }
    if (spotCal?.stage === "pick") {
      setSpotCal({ stage: "measuring", point: { x: xFt, y: yFt }, startedAt: Date.now() });
      return;
    }
    if (navPhase === "locating") {
      // Tapping while beacons are still deciding means "I know where I am".
      fusionEngine.cancelLocating();
      setLocProgress(null);
      setNavPhase("picking");
      setPendingStart({ x: xFt, y: yFt });
      return;
    }
    if (navPhase === "picking") {
      setPendingStart({ x: xFt, y: yFt });
      return;
    }
    if (navPhase === "choosing") {
      // Near A or B: that spot. Anywhere else: "I am somewhere else" - start
      // there instead, as with Set My Start on the Map.
      const st = fusionState;
      const alt = st.alternatePosition;
      const dA = Math.hypot(st.x - xFt, st.y - yFt);
      const dB = alt ? Math.hypot(alt.x - xFt, alt.y - yFt) : Infinity;
      if (Math.min(dA, dB) <= CHOICE_TAP_FT) {
        pickStartChoice(dA <= dB ? "A" : "B");
      } else {
        pickStartChoice(null);
        fusionEngine.cancelLocating();
        setPendingStart({ x: xFt, y: yFt });
        setNavPhase("picking");
      }
      return;
    }
    // Recording a test: a tap while navigating marks where you REALLY are.
    if (testRecorder.active && navPhase === "navigating" && !fusionState.positionAmbiguous) {
      testRecorder.add("truth", { x: xFt, y: yFt });
      return;
    }
    if (navPhase === "navigating" && fusionState.positionAmbiguous) {
      if (fusionEngine.chooseHypothesisNear(xFt, yFt)) {
        setFusionState({ ...fusionEngine.getState() });
      }
    }
  };

  const handleStartHere = () => {
    if (!pendingStart) return;
    fusionEngine.setRoomSize(roomW, roomH);
    fusionEngine.setBleAnchors(anchor1, anchor2);
    const fix = fusionEngine.setManualPosition(pendingStart.x, pendingStart.y);
    setPendingStart(null);
    completeLocating(fix);
  };

  const handleStop = () => {
    fusionEngine.setBleWeight(1);
    if (navPhase === "navigating") {
      const t = fusionEngine.getState().trail;
      if (t && t.length > 1) setLastTrail(t.map((p) => ({ x: p.x, y: p.y })));
    }
    pickStartChoice(null);
    settlingRef.current = false;
    setSettling(false);
    choiceDuringNavRef.current = false;
    autoCalRef.current.stop("stopped");
    setAutoCalStatus(autoCalRef.current.getStatus());
    setPendingStart(null);
    fusionEngine.cancelLocating();
    setNavPhase("idle");
    setLocProgress(null);
  };

  /** Throws away the current fix and locates again from scratch. */
  const handleReLocate = () => {
    fusionEngine.setBleWeight(1);
    if (navPhase === "navigating") {
      const t = fusionEngine.getState().trail;
      if (t && t.length > 1) setLastTrail(t.map((p) => ({ x: p.x, y: p.y })));
    }
    pickStartChoice(null);
    settlingRef.current = false;
    setSettling(false);
    choiceDuringNavRef.current = false;
    autoCalRef.current.stop("relocating");
    setAutoCalStatus(autoCalRef.current.getStatus());
    coldStartDoneRef.current = false;
    setInitialFix(null);
    setLocProgress(null);
    fusionEngine.beginLocating();
    locateStartRef.current = {
      t: Date.now(),
      p1: bleStats.b1?.totalPackets ?? 0,
      p2: bleStats.b2?.totalPackets ?? 0,
    };
    setNavPhase("locating");
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
    // The heading prompt was the only thing holding navigation back.
    if (navPhase === "located") handleStartNavigation();
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
  const sr1 = simpleRange(1).m;
  const sr2 = simpleRange(2).m;
  const d1Ft = Number.isFinite(sr1) ? metresToFeet(sr1) : null;
  const d2Ft = Number.isFinite(sr2) ? metresToFeet(sr2) : null;

  // What locating is waiting on, per beacon: packets heard since it started
  // and how long since the last one. Without this a stalled locate looks the
  // same as a slow one, and the cause - one beacon barely reaching the phone -
  // was invisible.
  const locateDiagnostics = (() => {
    if (navPhase !== "locating") return [];
    const now = locateClock || Date.now();
    const start = locateStartRef.current;
    const lines = [];
    for (const [k, b, base] of [[1, bleStats.b1, start.p1], [2, bleStats.b2, start.p2]]) {
      if (!b?.id) {
        lines.push({ key: k, bad: true, text: `B${k}: not selected — pick it in the Raw tab` });
        continue;
      }
      const heard = Math.max(0, (b.totalPackets ?? 0) - base);
      const age = Number.isFinite(b.lastSeen) ? (now - b.lastSeen) / 1000 : null;
      const rate = start.t ? heard / Math.max(1, (now - start.t) / 1000) : 0;
      const sm = simpleRange(k).m;
      const dist = Number.isFinite(sm) ? `${metresToFeet(sm).toFixed(1)} ft` : "—";
      const quiet = age === null || age * 1000 > LOCATE_STALE_MS;
      lines.push({
        key: k,
        bad: quiet || (heard > 0 && rate < 0.5),
        text: quiet
          ? `B${k}: not heard ${age === null ? "yet" : `for ${age.toFixed(0)} s`} — check it is on and in range`
          : `B${k}: ${heard} packets (${rate.toFixed(1)}/s) · ${dist}${rate < 0.5 ? " · very few packets" : ""}`,
      });
    }
    return lines;
  })();
  const quality = getPositionQuality(uncertaintyRadius);

  // Live geometric self-check on the two ranges. The beacon separation and the
  // room diagonal are both known exactly from the floor plan, so a range pair
  // that violates the triangle inequality against them is PROOF of a ranging
  // calibration fault rather than evidence of one - unlike every other quality
  // signal here, it cannot be produced by noise. Worth surfacing on this screen
  // specifically, because a bad range pair is what makes the initial position
  // land in the wrong place, and the user has no other way to see why.
  const rangeGeometry = (() => {
    if (!Number.isFinite(d1Ft) || !Number.isFinite(d2Ft)) return null;
    const baselineFt = Math.hypot(anchor2.x - anchor1.x, anchor2.y - anchor1.y);
    if (!(baselineFt > 0)) return null;
    return checkRangeGeometry(d1Ft, d2Ft, baselineFt, Math.hypot(roomW, roomH), 4.0, "ft");
  })();

  return (
    <ScrollView
      style={styles.screenBg}
      contentContainerStyle={styles.scrollContent}
      scrollEnabled={!mapGestureActive}
    >
      {/* Walking / Wheelchair (only while idle: switching restarts the movement engines) */}
      {!placementMode && (
        <MobilityModeSwitch disabled={navPhase !== "idle"} hint="Stop navigation to switch mode." />
      )}

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
                Pick B1/B2 in the Raw tab.
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
      {/* ── Locating progress ─────────────────────────────────────────────
          Standing still for a few seconds is what buys the accurate fix, so the
          reason for the wait is stated plainly and the progress is visible —
          otherwise it just looks like the app is slow to respond. */}
      {obstacleEdit && (
        <View style={[styles.statusBanner, styles.fixBannerWaiting]}>
          <Text style={styles.statusBannerText}>
            {obstacleEdit.erase
              ? "🧽 Tap an obstacle to remove it."
              : EDIT_TYPES.find((t) => t.key === obstacleEdit.type)?.point
                ? "Tap the centre of each pillar / cabinet."
                : EDIT_TYPES.find((t) => t.key === obstacleEdit.type)?.area
                  ? obstacleEdit.first
                    ? "Now tap the OPPOSITE corner of the area."
                    : "No-walk area (cabin, desks, counter): tap one corner, then the opposite corner. The walked track will never enter it."
                : obstacleEdit.first
                  ? "Now tap where this wall ENDS."
                  : "Tap where a wall STARTS, then where it ends. Draw every wall, glass cabin side and partition between desks and the beacons."}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 6 }}>
            {EDIT_TYPES.map((t) => {
              const on = !obstacleEdit.erase && obstacleEdit.type === t.key;
              return (
                <TouchableOpacity
                  key={t.key}
                  onPress={() => setObstacleEdit({ type: t.key, first: null, erase: false })}
                  style={[styles.secondaryBtn, { paddingVertical: 6, paddingHorizontal: 8, marginRight: 6, marginBottom: 6, borderColor: on ? t.color : undefined, borderWidth: on ? 2 : undefined }]}
                >
                  <Text style={[styles.secondaryBtnText, { fontSize: 12, color: on ? t.color : C.textSecondary }]}>{t.icon} {t.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={{ flexDirection: "row" }}>
            <TouchableOpacity
              style={[styles.secondaryBtn, { flex: 1, marginRight: 6, paddingVertical: 8 }]}
              onPress={() => { if (obstacleMap.removeLast()) obstaclesChanged(); }}
            >
              <Text style={styles.secondaryBtnText}>↶ Undo</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryBtn, { flex: 1, marginRight: 6, paddingVertical: 8 }]}
              onPress={() => setObstacleEdit({ ...obstacleEdit, first: null, erase: !obstacleEdit.erase })}
            >
              <Text style={styles.secondaryBtnText}>{obstacleEdit.erase ? "✏ Draw" : "🧽 Erase"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.primaryBtn, { flex: 1, paddingVertical: 8 }]} onPress={() => setObstacleEdit(null)}>
              <Text style={styles.primaryBtnText}>Done ({obstacleMap.items.length})</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {spotCal && (
        <View
          style={[
            styles.statusBanner,
            spotCal.stage === "done" && !spotCal.result?.ok ? styles.fixBannerWarn
              : spotCal.stage === "done" ? styles.fixBannerReady
              : styles.fixBannerWaiting,
          ]}
        >
          {spotCal.stage === "pick" && (
            <>
              <Text style={styles.statusBannerText}>
                📐 Distance calibration: tap the exact spot where you are standing (zoom in with +
                for precision). Then hold the phone at chest height and stand still for 8 s.
                {!headingCalibrated ? " Tip: zero the heading first, so your body's effect can be accounted for." : ""}
              </Text>
              <Text style={[styles.locateDiag, { color: C.textPrimary }]}>
                Do this first, once per beacon: stand exactly 1 m in front of it (measure with a tape),
                facing it, phone at chest height, and tap:
              </Text>
              <View style={{ flexDirection: "row", marginTop: 6 }}>
                {[1, 2].map((num) => (
                  <TouchableOpacity
                    key={num}
                    style={[styles.secondaryBtn, { flex: 1, marginRight: num === 1 ? 8 : 0, paddingVertical: 8 }]}
                    onPress={() => setSpotCal({ stage: "measuring", oneMeter: num, point: null, startedAt: Date.now() })}
                  >
                    <Text style={styles.secondaryBtnText}>📏 I'm 1 m from B{num}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
          {spotCal.stage === "measuring" && (() => {
            const el = Math.max(0, (spotClock || Date.now()) - spotCal.startedAt);
            const left = Math.max(0, Math.ceil((SPOT_SETTLE_MS + SPOT_WINDOW_MS - el) / 1000));
            return (
              <>
                <Text style={styles.statusBannerText}>
                  📐 Measuring — stand still… {left} s
                </Text>
                <View style={styles.locateTrack}>
                  <View
                    style={[
                      styles.locateBar,
                      { width: `${Math.min(100, Math.round((el / (SPOT_SETTLE_MS + SPOT_WINDOW_MS)) * 100))}%` },
                    ]}
                  />
                </View>
              </>
            );
          })()}
          {spotCal.stage === "done" && (
            <>
              {spotCal.result?.moved ? (
                <Text style={styles.statusBannerText}>
                  ⚠ You moved during the measurement, so it was not used. Stand still and try again.
                </Text>
              ) : (
                [["b1", 1], ["b2", 2]].map(([k, n]) => {
                  const r = spotCal.result?.beacons?.[k];
                  if (spotCal.oneMeter && spotCal.oneMeter !== n) return null;
                  return (
                    <Text key={k} style={styles.statusBannerText}>
                      {r?.ok && r.oneMeter
                        ? `✓ B${n}: RSSI@1m measured = ${r.txPower1m} dBm (its own value)${r.unsteady ? " — signal was unsteady, consider repeating" : ""}`
                        : r?.ok
                        ? `✓ B${n}: ${r.distanceM.toFixed(1)} m away → 1 m = ${r.txPower1m} dBm, n ${r.n} (${r.points} point${r.points === 1 ? "" : "s"})${r.unsteady ? " — signal was unsteady, consider repeating" : ""}`
                        : `⚠ B${n}: ${r?.error || "not recorded"}`}
                    </Text>
                  );
                })
              )}
              <Text style={[styles.locateDiag, { color: C.textPrimary }]}>
                Repeat at 3–5 spots spread over the room (near and far from each beacon) for the best accuracy.
              </Text>
              <View style={{ flexDirection: "row", marginTop: 8 }}>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, marginRight: 8, paddingVertical: 10 }]} onPress={() => setSpotCal(null)}>
                  <Text style={styles.secondaryBtnText}>Done</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.primaryBtn, { flex: 1, paddingVertical: 10 }]} onPress={handleStartSpotCal}>
                  <Text style={styles.primaryBtnText}>📐 Another Spot</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
          {spotCal.stage !== "done" && (
            <TouchableOpacity style={{ marginTop: 6 }} onPress={() => setSpotCal(null)}>
              <Text style={[styles.locateDiag, { color: C.accent }]}>Cancel</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <OfficeMapCanvas
        roomW={roomW} roomH={roomH}
        anchor1={anchor1} anchor2={anchor2}
        fusionState={previewOffset ? { ...fusionState, x: fusionState.x + previewOffset.dx, y: fusionState.y + previewOffset.dy } : fusionState}
        d1Ft={d1Ft} d2Ft={d2Ft}
        b1Name={bleStats.b1?.name} b2Name={bleStats.b2?.name}
        headingDeg={headingRef?.current ?? 0}
        headingRef={headingRef}
        searching={navPhase === "locating" || (navPhase === "navigating" && settling)}
        searchLabel={navPhase === "locating" ? "Finding your position…" : "Fine-tuning your position…"}
        bottomPanel={navPhase === "choosing" ? (
          <View style={styles.choiceBar}>
            <Text style={styles.choiceTitle}>📍 Where are you? Tap A or B</Text>
            <View style={styles.choiceRow}>
              {["A", "B"].map((side) => (
                <TouchableOpacity
                  key={side}
                  style={[styles.choiceBtn, startChoice === side && styles.choiceBtnOn]}
                  onPress={() => pickStartChoice(side)}
                >
                  <Text style={[styles.choiceBtnText, startChoice === side && { color: "#fff" }]}>
                    {startChoice === side ? `✓ ${side}` : side}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[styles.choiceStart, !startChoice && { opacity: 0.4 }]}
                disabled={!startChoice}
                onPress={() => beginFromChoice(startChoice)}
              >
                <Text style={styles.choiceStartText}>▶ Start</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => beginFromChoice(null)}>
              <Text style={styles.choiceLink}>Not sure? Walk to decide</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        placementMode={placementMode}
        onBeaconDragEnd={handleBeaconDragEnd}
        onGestureActive={setMapGestureActive}
        navPhase={navPhase}
        lastTrail={lastTrail}
        obstacles={obstacleMap.items}
        obstacleVer={obstacleVer}
        pickMode={
          Boolean(obstacleEdit) ||
          (recState.active && navPhase === "navigating") ||
          spotCal?.stage === "pick" ||
          navPhase === "picking" ||
          navPhase === "choosing" ||
          navPhase === "locating" ||
          (navPhase === "navigating" && fusionState.positionAmbiguous)
        }
        onMapTap={handleMapTap}
        startChoice={startChoice}
        pendingPoint={
          obstacleEdit?.first
            ? obstacleEdit.first
            : spotCal?.point && spotCal.stage !== "done"
            ? spotCal.point
            : navPhase === "picking" ? pendingStart : null
        }
        savedRoutesOnMap={savedRoutesOnMap}
      />

      {/* ── Status cards ─────────────────────────────────────────────────
          Below the map, not above it: these appear, grow and disappear as
          locating goes on, and above the map every change pushed the map
          down (a tall dark card where the map had just been). */}
      {navPhase === "picking" && (
        <View style={[styles.statusBanner, styles.fixBannerWaiting]}>
          <Text style={styles.statusBannerText}>
            {pendingStart
              ? `📍 Start at (${pendingStart.x.toFixed(1)}, ${pendingStart.y.toFixed(1)}) ft. Tap again to move it, or press Start Here.`
              : "👆 Tap the spot on the map where you are standing. Zoom in with + for a precise spot."}
          </Text>
        </View>
      )}

      {navPhase === "locating" && (
        <View style={[styles.statusBanner, styles.fixBannerWaiting, styles.statusCard]}>
          <Text style={[styles.statusCardText, { fontWeight: "700" }]}>
            ◎ Finding your position — please stand still
          </Text>
          <Text style={styles.locateDiag}>
            {Math.round((locateStartRef.current.t ? (locateClock || Date.now()) - locateStartRef.current.t : 0) / 1000)} s ·{" "}
            {locProgress?.samples
              ? `${locProgress.samples} readings collected`
              : "waiting for both beacons"}
          </Text>
          <View style={styles.locateTrack}>
            <View
              style={[
                styles.locateBar,
                { width: `${Math.round((locProgress?.progress ?? 0) * 100)}%` },
              ]}
            />
          </View>
          {/* Only what needs attention: a beacon not heard, or barely. */}
          {locateDiagnostics.filter((line) => line.bad).map((line) => (
            <Text key={line.key} style={[styles.locateDiag, { color: C.accentOrange }]}>
              {line.text}
            </Text>
          ))}
          <Text style={styles.locateDiag}>
            Taking too long? Tap where you are on the map to start there.
          </Text>
        </View>
      )}

      {navPhase === "navigating" && settling && (
        <View style={[styles.statusBanner, styles.fixBannerWaiting, styles.statusCard]}>
          <Text style={[styles.statusCardText, { fontWeight: "700" }]}>
            ◎ Fine-tuning your position — a moment more
          </Text>
          <Text style={styles.locateDiag}>
            Your dot appears as soon as the position is steady, or when you start walking.
          </Text>
        </View>
      )}

      {/* ── Heading alignment ────────────────────────────────────────────
          A position fix says WHERE you are; it says nothing about which way you
          are facing. PDR needs both — every step is placed with
          x += len·sin(heading) — so until the app is told which real-world
          direction the floor plan's "up" points in, a walk north on the map can
          come out pointing anywhere. This is asked once and then remembered,
          since it is a property of the building, not of the session. */}
      {(navPhase === "located" || navPhase === "navigating") && !headingCalibrated && (
        <View style={[styles.statusBanner, styles.fixBannerWarn, styles.statusCard]}>
          <Text style={styles.statusCardText}>
            🧭 Set your forward direction before walking. Stand facing the way the map's
            ↑ (up / +Y) points, then tap Zero Heading. Without this the path will be drawn
            rotated away from the direction you actually walk.
          </Text>
          <TouchableOpacity style={styles.headingFixBtn} onPress={handleZeroHeading}>
            <Text style={styles.headingFixBtnText}>🎯 I'm facing map-up — Zero Heading</Text>
          </TouchableOpacity>
        </View>
      )}

      {navPhase === "navigating" && locatedAt > 0 && (locateClock || Date.now()) - locatedAt < 5000 && (
        <View style={[styles.statusBanner, styles.fixBannerReady]}>
          <Text style={styles.statusBannerText}>
            {initialFix?.status === "manual"
              ? "✓ Start set on the map — navigating. Start walking; beacons will fine-tune it."
              : `✓ Position found in ${initialFix?.sampleCount ? `${initialFix.sampleCount} readings` : "a few seconds"}${initialFix?.uncertaintyFt ? ` (± ${initialFix.uncertaintyFt.toFixed(1)} ft)` : ""} — navigating. Start walking.`}
          </Text>
        </View>
      )}

      {navPhase === "located" && headingCalibrated && !fusionState.positionAmbiguous && (
        <View style={[styles.statusBanner, styles.fixBannerReady]}>
          <Text style={styles.statusBannerText}>
            ✓ Position found: ({fusionState.x.toFixed(1)}, {fusionState.y.toFixed(1)}) ft
            {initialFix?.uncertaintyFt ? ` ± ${initialFix.uncertaintyFt.toFixed(1)} ft` : ""}
            {initialFix?.sampleCount ? ` from ${initialFix.sampleCount} readings` : ""}.
            {" "}Press Start Navigation and walk.
          </Text>
        </View>
      )}

      {/* ── Initial-fix / ambiguity banner ────────────────────────────────
          The starting position is the one estimate everything else inherits,
          so when it is uncertain the user is told plainly and given the single
          action that fixes it, instead of the app quietly picking one. */}
      {!placementMode && (() => {
        const st = fusionState;
        if (st.positionAmbiguous && navPhase !== "choosing") {
          return (
            <View style={[styles.statusBanner, styles.fixBannerAmbiguous]}>
              <Text style={styles.statusBannerText}>
                ◉ Two possible positions — you are at one of the two marks.
                {" "}Tap the mark where you are, or walk a few steps ACROSS the line between the beacons to settle it
                {st.ambiguityStale ? " (walking along that line cannot resolve it)." : "."}
              </Text>
            </View>
          );
        }
        if (!coldStartDoneRef.current && initialFix?.status === "low-confidence") {
          return (
            <View style={[styles.statusBanner, styles.fixBannerWaiting]}>
              <Text style={styles.statusBannerText}>
                ◌ Finding your position — waiting for a clean reading from both beacons.
              </Text>
            </View>
          );
        }
        if (initialFix?.status === "degenerate-geometry") {
          return (
            <View style={[styles.statusBanner, styles.fixBannerWarn]}>
              <Text style={styles.statusBannerText}>
                ⚠ Both beacons are in nearly the same place, so they cannot fix a position —
                only a rough distance. Move them apart (opposite walls is best) for real positioning.
              </Text>
            </View>
          );
        }
        if (rangeGeometry && !rangeGeometry.ok) {
          const issue = rangeGeometry.issues[0];
          return (
            <View style={[styles.statusBanner, styles.fixBannerWarn]}>
              <Text style={styles.statusBannerText}>
                ⚠ {issue.kind === "tx-mismatch"
                  ? "The two beacons disagree by more than the room allows (" +
                    d1Ft.toFixed(0) + " ft vs " + d2Ft.toFixed(0) + " ft, but they are only " +
                    rangeGeometry.baseline.toFixed(0) + " ft apart). Beacon " +
                    issue.suspectBeacon + " is reading far too long."
                  : issue.kind === "both-short"
                  ? "Both ranges together are shorter than the gap between the beacons, which " +
                    "cannot happen. Ranging is reading short."
                  : "Beacon " + issue.suspectBeacon + " reports further away than the room is big."}
                {" "}This is a calibration fault, not noise — check Measured Power and n in the Raw tab.
              </Text>
            </View>
          );
        }
        if (initialFix?.adjusted && (initialFix.adjustmentFt ?? 0) >= 8) {
          return (
            <View style={[styles.statusBanner, styles.fixBannerWarn]}>
              <Text style={styles.statusBannerText}>
                ⚠ Beacon distances disagree with their measured spacing by ~{initialFix.adjustmentFt.toFixed(0)} ft.
                That is a calibration problem, not noise — check Measured Power and n in the Raw tab.
              </Text>
            </View>
          );
        }
        if (initialFix?.geometryQuality === "poor" && coldStartDoneRef.current) {
          return (
            <View style={[styles.statusBanner, styles.fixBannerWarn]}>
              <Text style={styles.statusBannerText}>
                ⚠ Weak beacon geometry here (± {initialFix.uncertaintyFt?.toFixed(0)} ft). You are close to the
                line through both beacons, where range noise turns into large position error.
              </Text>
            </View>
          );
        }
        return null;
      })()}

      {/* Named start spots: one tap picks an exact, known start */}
      {!placementMode && navPhase === "picking" && (
        <View style={styles.spotBox}>
          <Text style={styles.hintText}>Saved start spots: tap one, then press Start Here. Or tap the map, name it and save it.</Text>
          <View style={styles.spotWrap}>
            {startSpots.length === 0 && <Text style={styles.hintText}>None saved yet.</Text>}
            {startSpots.map((sp) => (
              <TouchableOpacity
                key={sp.id}
                style={[styles.spotChip, pendingStart && Math.hypot(pendingStart.x - sp.x, pendingStart.y - sp.y) < 1.5 && styles.spotChipOn]}
                onPress={() => pickSpot(sp)}
                onLongPress={() => Alert.alert("Delete spot", `Delete "${sp.name}"?`, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Delete", style: "destructive", onPress: () => handleDeleteSpot(sp.id) },
                ])}
              >
                <Text style={styles.spotChipText}>📍 {sp.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {pendingStart && (
            <View style={{ flexDirection: "row", marginTop: 8 }}>
              <TextInput
                style={[styles.textInput, { flex: 1, fontSize: 14, paddingVertical: 8 }]}
                value={spotName}
                onChangeText={setSpotName}
                placeholder="Name this spot (e.g. Entrance)"
                placeholderTextColor={C.textMuted}
                maxLength={MAX_NAME}
              />
              <TouchableOpacity style={[styles.secondaryBtn, { marginLeft: 8, paddingVertical: 8 }, !spotName.trim() && { opacity: 0.45 }]} disabled={!spotName.trim()} onPress={handleSaveSpot}>
                <Text style={styles.secondaryBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          )}
          <Text style={styles.hintText}>Long-press a spot to delete it.</Text>
        </View>
      )}

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
            {navPhase === "idle" && (
              <>
                <TouchableOpacity style={[styles.placeBtn, { flex: 1, marginRight: 10 }]} onPress={() => setPlacementMode(true)}>
                  <Text style={styles.primaryBtnText}>📍 Place Beacons</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.primaryBtn, { flex: 1 }]} onPress={handleStartLocating}>
                  <Text style={styles.primaryBtnText}>◎ Find My Position</Text>
                </TouchableOpacity>
              </>
            )}
            {navPhase === "locating" && (
              <>
                <TouchableOpacity style={[styles.stopBtn, { flex: 1, marginRight: 10 }]} onPress={handleStop}>
                  <Text style={styles.primaryBtnText}>✕ Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1.3 }]} onPress={handleStartPicking}>
                  <Text style={styles.secondaryBtnText}>👆 Choose on Map</Text>
                </TouchableOpacity>
              </>
            )}
            {navPhase === "picking" && (
              <>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, marginRight: 10 }]} onPress={handleStop}>
                  <Text style={styles.secondaryBtnText}>✕ Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryBtn, { flex: 1.4 }, !pendingStart && { opacity: 0.45 }]}
                  disabled={!pendingStart}
                  onPress={handleStartHere}
                >
                  <Text style={styles.primaryBtnText}>▶ Start Here</Text>
                </TouchableOpacity>
              </>
            )}
            {/* A / B, Start and Walk to decide are on the map (choice bar). */}
            {navPhase === "choosing" && (
              <TouchableOpacity style={[styles.secondaryBtn, { flex: 1 }]} onPress={handleStop}>
                <Text style={styles.secondaryBtnText}>✕ Cancel</Text>
              </TouchableOpacity>
            )}
            {navPhase === "located" && (
              <>
                <TouchableOpacity style={[styles.secondaryBtn, { flex: 1, marginRight: 10 }]} onPress={handleReLocate}>
                  <Text style={styles.secondaryBtnText}>↻ Re-locate</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.primaryBtn, { flex: 1.4 }]} onPress={handleStartNavigation}>
                  <Text style={styles.primaryBtnText}>▶ Start Navigation</Text>
                </TouchableOpacity>
              </>
            )}
            {navPhase === "navigating" && (
              <>
                <TouchableOpacity style={[styles.saveRouteBtn, { flex: 1, marginRight: 10 }]} onPress={handleSaveRoute}>
                  <Text style={styles.primaryBtnText}>💾 Save Path</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.stopBtn, { flex: 1 }]} onPress={handleStop}>
                  <Text style={styles.primaryBtnText}>⏹ Stop</Text>
                </TouchableOpacity>
              </>
            )}
          </>
        )}
      </View>
      {/* Wheelchair mode: one tap = one push of the wheels (Settings sets its
          length). Rolling is also detected from the wheels' vibration. */}
      {!placementMode && mobilityMode === "wheelchair" &&
        (navPhase === "navigating" || navPhase === "choosing" || navPhase === "locating") && (
        <TouchableOpacity
          style={[styles.primaryBtn, { marginBottom: 12, paddingVertical: 20 }]}
          onPress={() => wheelchairEngine.push()}
        >
          <Text style={[styles.primaryBtnText, { fontSize: 17 }]}>
            ♿ Push ({wheelchairEngine.settings.pushM.toFixed(1)} m)
          </Text>
        </TouchableOpacity>
      )}
      {!placementMode && navPhase === "idle" && (
        <TouchableOpacity style={[styles.secondaryBtn, { marginBottom: 12 }]} onPress={handleStartPicking}>
          <Text style={styles.secondaryBtnText}>👆 Set My Start on the Map</Text>
        </TouchableOpacity>
      )}
      {!placementMode && navPhase === "idle" && !spotCal && (
        <TouchableOpacity style={[styles.secondaryBtn, { marginBottom: 12 }]} onPress={handleStartSpotCal}>
          <Text style={styles.secondaryBtnText}>📐 Calibrate Distance Here</Text>
        </TouchableOpacity>
      )}
      {!placementMode && !obstacleEdit && !spotCal && (navPhase === "idle" || navPhase === "navigating") && (
        <TouchableOpacity
          style={[styles.secondaryBtn, { marginBottom: 12 }]}
          onPress={() => setObstacleEdit({ type: "wall", first: null, erase: false })}
        >
          <Text style={styles.secondaryBtnText}>
            🧱 Draw Walls / Pillars / Cabins / No-walk ({obstacleMap.items.length} drawn)
          </Text>
        </TouchableOpacity>
      )}
      {!placementMode && !obstacleEdit && !spotCal && (
        <View style={{ flexDirection: "row", marginBottom: 12 }}>
          <TouchableOpacity
            style={[styles.secondaryBtn, { flex: 1, marginRight: recState.rows ? 8 : 0 }, recState.active && { borderColor: C.accentRed }]}
            onPress={() => {
              if (recState.active) testRecorder.stop();
              else testRecorder.start(`room ${roomW}x${roomH} ft; B1 (${anchor1.x},${anchor1.y}); B2 (${anchor2.x},${anchor2.y})`);
            }}
          >
            <Text style={[styles.secondaryBtnText, recState.active && { color: C.accentRed }]}>
              {recState.active
                ? `⏹ Stop Recording (${recState.truths} marks)`
                : "📝 Record Test Walk"}
            </Text>
          </TouchableOpacity>
          {recState.rows > 0 && !recState.active && (
            <TouchableOpacity
              style={[styles.secondaryBtn, { flex: 1 }]}
              onPress={() => Share.share({ title: "PDR test walk", message: testRecorder.toCSV() }).catch(() => {})}
            >
              <Text style={styles.secondaryBtnText}>📤 Share CSV ({recState.rows})</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {recState.active && (
        <Text style={[styles.locateDiag, { marginTop: -6, marginBottom: 10 }]}>
          Recording. While navigating, tap the map exactly where you are standing (e.g. at each corner / door) - those marks measure the real error.
        </Text>
      )}

      {/* "Reset to Center" is gone deliberately: the room centre was never a
          real position, only a placeholder to stop the dot sitting somewhere
          stale. Re-locate does the thing that was actually wanted — measure
          where the user is — so offering a made-up position alongside it would
          just be a worse button. */}

      {!placementMode && (
        <TouchableOpacity style={styles.routesToggle} onPress={() => setShowRoutes((v) => !v)}>
          <Text style={styles.routesToggleText}>
            {showRoutes ? "▾" : "▸"} Saved Paths ({savedRoutes.length})
          </Text>
        </TouchableOpacity>
      )}
      {!placementMode && showRoutes && (
        <View style={styles.routesBox}>
          {savedRoutes.length === 0 ? (
            <Text style={styles.routesEmpty}>
              No saved paths yet. Walk a route and tap Save Path; it stays drawn on the map.
            </Text>
          ) : (
            savedRoutes.map((r) => {
              const drawable = isFusionMapRoute(r);
              const shown = drawable && shownRouteIds.has(r.id);
              const color = routeColor(r.id);
              return (
              <View key={r.id} style={styles.routeRow}>
                <TouchableOpacity
                  style={{ flex: 1, flexDirection: "row", alignItems: "center" }}
                  disabled={!drawable}
                  onPress={() => toggleRouteOnMap(r.id)}
                >
                  <View
                    style={[
                      styles.routeSwatch,
                      shown
                        ? { backgroundColor: color, borderColor: color }
                        : { borderColor: drawable ? color : C.textMuted },
                    ]}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.routeName}>{r.name}</Text>
                    <Text style={styles.routeMeta}>
                      {drawable
                        ? `${r.timestamp} · ${r.steps} steps · ${Number(r.distance).toFixed(1)} ft · ${shown ? "on map, tap to hide" : "tap to show on map"}`
                        : `${r.timestamp} · ${r.steps} steps · PDR tracker path (metres), not drawn on floor plan`}
                    </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleDeleteRoute(r.id)} style={styles.routeDelete}>
                  <Text style={styles.routeDeleteText}>✕</Text>
                </TouchableOpacity>
              </View>
              );
            })
          )}
        </View>
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
            {fusionState.particleFilter && (
              <Text style={styles.locateDiag}>
                {`🧭 Map matching: step length ×${fusionState.particleFilter.stepScale} · heading correction ${fusionState.particleFilter.headingBiasDeg > 0 ? "+" : ""}${fusionState.particleFilter.headingBiasDeg}° · spread ±${fusionState.particleFilter.spreadFt} ft`}
              </Text>
            )}
            {carryMode && (
              <Text style={styles.locateDiag}>
                {`📱 Phone: ${CARRY_TEXT[carryMode] || carryMode}`}
              </Text>
            )}
            <Text style={styles.locateDiag}>{describeRunningBundle()}</Text>
            <TouchableOpacity
              onPress={() => {
                autoCalRef.current.setEnabled(!autoCalStatus.enabled);
                setAutoCalStatus(autoCalRef.current.getStatus());
              }}
            >
              <Text style={[styles.locateDiag, { color: autoCalStatus.active ? C.accentGreen : C.textSecondary }]}>
                {describeAutoCal(autoCalStatus, headingCalibrated)}
              </Text>
            </TouchableOpacity>
            <Text style={styles.locateDiag}>
              {obstacleMap.items.length
                ? (() => {
                    const names = OBSTACLE_TYPES.map((t) => t.label.split(" ")[0].toLowerCase());
                    const fmt = (num) => {
                      const w = v2Scanner.getWallLosses(num);
                      return w ? w.map((v, i) => `${names[i]} ${v}`).join(", ") : "—";
                    };
                    const here = navPhase === "navigating"
                      ? ` · now B1: ${describeObstaclePath(fusionState, anchor1)}${fusionState.nlos?.b1 ? " ⚠blocked?" : ""}` +
                        ` · B2: ${describeObstaclePath(fusionState, anchor2)}${fusionState.nlos?.b2 ? " ⚠blocked?" : ""}`
                      : "";
                    return `🧱 Obstacle loss (dB) B1: ${fmt(1)} | B2: ${fmt(2)}${here}\n`;
                  })()
                : "🧱 No obstacles drawn - draw walls, cabins and pillars so distances through them are corrected\n"}
              {`🗺 Radio map (walls/pillars): B1 ${radioMapInfo[1]} · B2 ${radioMapInfo[2]} surveyed points` +
                (radioMapInfo[1] + radioMapInfo[2] < 20 ? " — do 📐 spot calibrations around the office to build it" : "")}
            </Text>
            <View style={styles.beaconInfoRow}>
              <View style={[styles.beaconChip, { borderColor: C.beacon1 }]}>
                <Text style={[styles.beaconChipLabel, { color: C.beacon1 }]}>
                  B1 @ ({anchor1.x.toFixed(0)}, {anchor1.y.toFixed(0)}) ft
                </Text>
                <Text style={styles.beaconChipValue}>
                  {bleStats.b1?.name || "—"} • {bleStats.b1?.rawRssi != null ? `${bleStats.b1.rawRssi} dBm` : "no signal"}
                </Text>
                <Text style={[styles.beaconChipMeta, { color: C.accent }]}>
                  {describeSimple(1)}
                </Text>
              </View>
              <View style={[styles.beaconChip, { borderColor: C.beacon2 }]}>
                <Text style={[styles.beaconChipLabel, { color: C.beacon2 }]}>
                  B2 @ ({anchor2.x.toFixed(0)}, {anchor2.y.toFixed(0)}) ft
                </Text>
                <Text style={styles.beaconChipValue}>
                  {bleStats.b2?.name || "—"} • {bleStats.b2?.rawRssi != null ? `${bleStats.b2.rawRssi} dBm` : "no signal"}
                </Text>
                <Text style={[styles.beaconChipMeta, { color: C.accent }]}>
                  {describeSimple(2)}
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
  headingFixBtn: {
    marginTop: 10, backgroundColor: "#d29922", borderRadius: 8,
    paddingVertical: 10, alignItems: "center",
  },
  headingFixBtnText: { color: "#0d1117", fontSize: 13, fontWeight: "800" },
  saveRouteBtn: {
    backgroundColor: "#238636", borderRadius: 10, paddingVertical: 14, alignItems: "center",
  },
  routesToggle: { paddingVertical: 10, marginBottom: 4 },
  routesToggleText: { color: C.textSecondary, fontSize: 13, fontWeight: "700" },
  routesBox: {
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    borderRadius: 10, padding: 10, marginBottom: 12,
  },
  routesEmpty: { color: C.textMuted, fontSize: 12, textAlign: "center", paddingVertical: 8 },
  routeRow: {
    flexDirection: "row", alignItems: "center",
    borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: 8,
  },
  routeName: { color: C.textPrimary, fontSize: 13, fontWeight: "700" },
  routeSwatch: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, marginRight: 10 },
  routeMeta: { color: C.textMuted, fontSize: 10, marginTop: 2 },
  routeDelete: { paddingHorizontal: 10, paddingVertical: 4 },
  routeDeleteText: { color: C.accentRed, fontSize: 15, fontWeight: "700" },

  // ── Zoom controls ──
  zoomCluster: { position: "absolute", top: 12, right: 12, alignItems: "center" },
  zoomBtn: {
    width: 36, height: 36, borderRadius: 8, marginBottom: 6,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(13,17,23,0.85)",
    borderWidth: 1, borderColor: "#30363d",
  },
  zoomBtnText: { color: "#e6edf3", fontSize: 20, fontWeight: "700", lineHeight: 23 },
  zoomBtnIcon: { color: "#e6edf3", fontSize: 15, fontWeight: "700" },
  zoomBadge: {
    position: "absolute", bottom: 12, right: 12,
    backgroundColor: "rgba(13,17,23,0.85)",
    borderWidth: 1, borderColor: "#30363d",
    borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
  },
  zoomBadgeText: { color: "#8b949e", fontSize: 11, fontWeight: "700" },
  searchOverlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(13,17,23,0.35)",
  },
  searchPulseBox: { width: 130, height: 130, alignItems: "center", justifyContent: "center" },
  searchRing: {
    position: "absolute", width: 130, height: 130, borderRadius: 65,
    borderWidth: 3, borderColor: C.accent, backgroundColor: "rgba(31,111,235,0.10)",
  },
  searchCore: {
    width: 18, height: 18, borderRadius: 9, backgroundColor: C.accent,
    borderWidth: 3, borderColor: "#fff",
  },
  searchChip: {
    marginTop: 10, backgroundColor: "rgba(13,17,23,0.88)", borderRadius: 16,
    borderWidth: 1, borderColor: C.accent, paddingHorizontal: 14, paddingVertical: 6,
  },
  searchChipText: { color: "#e6edf3", fontSize: 13, fontWeight: "700" },
  choiceBar: {
    position: "absolute", left: 10, right: 10, bottom: 10,
    backgroundColor: "rgba(13,17,23,0.92)", borderRadius: 12,
    borderWidth: 1, borderColor: C.accent, paddingHorizontal: 10, paddingVertical: 8,
  },
  choiceTitle: { color: "#e6edf3", fontSize: 13, fontWeight: "800" },
  choiceRow: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  choiceBtn: {
    flex: 1, height: 36, marginRight: 6, borderRadius: 8, borderWidth: 1, borderColor: "#30363d",
    alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.06)",
  },
  choiceBtnOn: { backgroundColor: C.accent, borderColor: C.accent },
  choiceBtnText: { color: "#e6edf3", fontSize: 15, fontWeight: "800" },
  choiceStart: {
    flex: 1.3, height: 36, borderRadius: 8, backgroundColor: "#238636",
    alignItems: "center", justifyContent: "center",
  },
  choiceStartText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  choiceLink: { color: "#8b949e", fontSize: 12, marginTop: 6, textAlign: "center" },

  fixBannerReady: { backgroundColor: "rgba(63,185,80,0.13)", borderColor: "#3fb950" },
  locateTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: "#21262d",
    marginTop: 8,
    overflow: "hidden",
  },
  locateBar: { height: 5, borderRadius: 3, backgroundColor: "#58a6ff" },

  // ── Initial-fix / ambiguity banners ──
  fixBannerAmbiguous: { backgroundColor: "rgba(188,140,255,0.13)", borderColor: "#bc8cff" },
  fixBannerWaiting: { backgroundColor: "rgba(88,166,255,0.12)", borderColor: "#58a6ff" },
  fixBannerWarn: { backgroundColor: "rgba(210,153,34,0.13)", borderColor: "#d29922" },

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
  spotBox: { backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border, padding: 10, marginBottom: 10 },
  spotWrap: { flexDirection: "row", flexWrap: "wrap" },
  spotChip: { backgroundColor: C.surfaceAlt, borderRadius: 16, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8, marginBottom: 8 },
  spotChipOn: { borderColor: C.accent, backgroundColor: "#12263f" },
  spotChipText: { color: C.textPrimary, fontSize: 13, fontWeight: "600" },
  beaconBox: { position: "absolute", width: BEACON_BOX_W, height: BEACON_BOX_H },
  mapCircle: { position: "absolute" },
  beaconCore: { alignItems: "center", justifyContent: "center", borderColor: "#fff", opacity: 0.95 },
  beaconLabel: { color: "#fff", fontSize: 11, fontWeight: "bold" },
  beaconSubLabel: { position: "absolute", left: 0, width: BEACON_BOX_W, textAlign: "center", fontSize: 9 },
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
  locateDiag: { color: C.textSecondary, fontSize: 11, marginTop: 3 },
  statusBannerWarn: { backgroundColor: "#2b2111", borderColor: C.accentOrange },
  statusBannerError: { backgroundColor: "#2b1618", borderColor: C.accentRed },
  statusBannerText: { flex: 1, fontSize: 12, color: C.textPrimary, lineHeight: 17 },
  // A status card with several lines: stacked top to bottom. In the banner's
  // row layout each line became a narrow column side by side - a tall card,
  // mostly empty, under the map while locating.
  statusCard: { flexDirection: "column", alignItems: "stretch", justifyContent: "flex-start", gap: 0 },
  statusCardText: { fontSize: 12, color: C.textPrimary, lineHeight: 17 },
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
  beaconChipMeta: { fontSize: 10, marginTop: 3, fontWeight: "600" },
});

// Memoised: the app shell re-renders on its own state changes, and this
// screen should only re-render when its own props or state change.
export default React.memo(FusionMapScreen);
