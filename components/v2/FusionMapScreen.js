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
  G,
} from "react-native-svg";
import { fusionEngine } from "../../services/FusionEngine.js";
import { v2Scanner } from "../../services/v2BeaconScannerService.js";
import { checkRangeGeometry } from "../../services/BeaconRangingCalibration.js";
import { metresToFeet, feetToMetres } from "../../services/PdrEngine.js";
import { savePath, getSavedPaths, deleteSavedPath } from "../../PathStorage.js";
import { RangeAutoCalibrator } from "../../services/RangeAutoCalibrator.js";
import { RadioMap } from "../../services/RadioMap.js";
import { simpleRanging, SMOOTH_PRESETS, DIST_SMOOTH_PRESETS } from "../../services/SimpleRanging.js";
import { obstacleMap, OBSTACLE_TYPES, DEFAULT_PILLAR_RADIUS_FT } from "../../services/ObstacleMap.js";

const FLOORPLAN_IMAGE = require("../../assets/floorplans/office-72x72.png");

// Bump with every change to the locating/ranging behaviour. Shown on screen
// because an OTA update is only APPLIED on the next cold start after it
// downloads, so "I published the fix and it still fails" is very often the
// old bundle still running - this makes that visible instead of a guess.
const ENGINE_TAG = "simple-range-v2";

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

const DEFAULT_ROOM_W_FT = 72;
const DEFAULT_ROOM_H_FT = 72;
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
 * Raw tab and Signal Lab - Kalman-smoothed RSSI, then
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
  inv = 1,
  dragScale,
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
          // Uses the EFFECTIVE on-screen scale, not the base one: while zoomed
          // in, a given finger travel covers fewer feet, and dividing by the
          // unzoomed scale would move the beacon much too far.
          const sc = dragScale || transform.scale;
          const dxFt = gesture.dx / sc;
          const dyFt = -gesture.dy / sc; // screen down = world Y down
          setDragOffsetPx({ dx: 0, dy: 0 });
          onDragEnd(id, worldPos.x + dxFt, worldPos.y + dyFt);
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draggable, transform.scale, dragScale, worldPos.x, worldPos.y]
  );

  const basePx = worldToScreen(worldPos.x, worldPos.y, transform, roomH);
  const cx = basePx.cx + dragOffsetPx.dx;
  const cy = basePx.cy + dragOffsetPx.dy;
  const subLabel = deviceName || `(${worldPos.x.toFixed(0)}, ${worldPos.y.toFixed(0)}) ft`;

  return (
    <>
      <Circle cx={cx} cy={cy} r={BEACON_RADIUS_PX * 2.2 * inv} fill={color} fillOpacity={0.18} />
      <Circle
        cx={cx}
        cy={cy}
        r={BEACON_RADIUS_PX * inv}
        fill={color}
        fillOpacity={0.95}
        stroke={draggable ? "#fff" : "none"}
        strokeWidth={draggable ? 2 * inv : 0}
        {...panResponder.panHandlers}
      />
      <SvgText x={cx} y={cy + 4.5 * inv} textAnchor="middle" fontSize={11 * inv} fill="#fff" fontWeight="bold">
        {label}
      </SvgText>
      <SvgText x={cx} y={cy + (BEACON_RADIUS_PX + 13) * inv} textAnchor="middle" fontSize={9 * inv} fill={color}>
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
  view = { zoom: 1, cx: null, cy: null },
  onViewChange,
  onAnimateView,
  onGestureActive,
  navPhase = "idle",
  savedRoutesOnMap = [],
  // Tap-to-choose: when on, a tap (not a drag) on the plan reports the tapped
  // floor-plan point in feet through onMapTap.
  pickMode = false,
  onMapTap,
  pendingPoint = null,
  obstacles = [],
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

  // ── Viewport model ───────────────────────────────────────────────────────
  // The view is described by WHICH WORLD POINT SITS AT THE CENTRE plus a zoom
  // factor, rather than by a pixel pan offset. That distinction matters: with a
  // pixel offset, the point that stays still while zooming is whichever point
  // was centred in the UNPANNED view, so zooming after panning visibly drifts
  // the map away under your finger. Anchoring on the centred world point makes
  // zoom stable wherever you have scrolled to, and makes "centre on me" and
  // "reset" trivial instead of inverse-transform arithmetic.
  const baseTransform = useMemo(
    () => computeTransform(roomW, roomH, CANVAS_SIZE, canvasHeight),
    [roomW, roomH, canvasHeight]
  );

  const zoom = view.zoom ?? 1;
  const centreX = Number.isFinite(view.cx) ? view.cx : roomW / 2;
  const centreY = Number.isFinite(view.cy) ? view.cy : roomH / 2;

  // Everything is drawn ONCE at the fit-to-canvas scale, and zoom/pan are
  // applied as a single SVG group transform on top.
  //
  // The earlier version folded zoom into the coordinates of every element, so
  // each pinch frame re-derived roughly seventy grid lines plus every marker in
  // JavaScript before React could re-render them — which is why the gesture
  // stuttered instead of tracking the fingers. With a group transform the grid
  // is computed once and the only thing changing per frame is one transform
  // string, which the SVG layer applies natively.
  const transform = baseTransform;

  // Group transform: place the centred world point at the canvas centre, at the
  // requested magnification. Derived from the point's BASE screen position, so
  // it stays correct however the room is shaped.
  const viewTransform = useMemo(() => {
    const basePt = worldToScreen(centreX, centreY, baseTransform, roomH);
    const targetX = MAP_PADDING + CANVAS_SIZE / 2;
    const targetY = MAP_PADDING + canvasHeight / 2;
    return {
      tx: targetX - zoom * basePt.cx,
      ty: targetY - zoom * basePt.cy,
      z: zoom,
    };
  }, [baseTransform, centreX, centreY, roomH, canvasHeight, zoom]);

  // Effective on-screen scale, for converting gesture pixels into feet.
  const effectiveScale = baseTransform.scale * zoom;

  // Markers and strokes are counter-scaled so they keep a constant on-screen
  // size: a user dot that grew with zoom would swamp the map at 8x, and hairline
  // grid strokes would turn into thick bars.
  const inv = 1 / zoom;

  // ── Gestures: drag to pan, pinch to zoom ────────────────────────────────
  // Live values are mirrored into refs so the responder can be created ONCE.
  // Rebuilding it whenever the view changes (which is every frame of a drag)
  // tears down the gesture that is currently in progress, which is what made
  // dragging stutter and sometimes stop dead mid-swipe.
  const viewRef = useRef(view);
  viewRef.current = view;
  const scaleRef = useRef(effectiveScale);
  scaleRef.current = effectiveScale;
  const placementRef = useRef(placementMode);
  placementRef.current = placementMode;
  const gestureRef = useRef({ startView: null, startDist: 0, pinching: false, sawPinch: false });
  const pickRef = useRef(pickMode);
  pickRef.current = pickMode;
  const onMapTapRef = useRef(onMapTap);
  onMapTapRef.current = onMapTap;
  const wrapperRef = useRef(null);
  const tapGeomRef = useRef(null); // { viewTransform, transform, roomW, roomH }
  // Must come AFTER the useRef above. Assigning it earlier crashed the whole
  // Fusion Map ("Cannot set property 'current' of undefined"): Metro compiles
  // const to var, so the ref was still undefined at that point.
  tapGeomRef.current = { viewTransform, transform: baseTransform, roomW, roomH };

  // Screen tap -> floor-plan feet. Inverts exactly what rendering does: the
  // wrapper's position on the page (and its 1 px border), then the zoom/pan
  // group transform, then worldToScreen.
  const reportTap = (pageX, pageY) => {
    const node = wrapperRef.current;
    if (!node || typeof node.measure !== "function") return;
    node.measure((_fx, _fy, _w, _h, px, py) => {
      const g = tapGeomRef.current;
      if (!g || !Number.isFinite(px) || !Number.isFinite(py)) return;
      const lx = pageX - px - 1;
      const ly = pageY - py - 1;
      const bx = (lx - g.viewTransform.tx) / g.viewTransform.z;
      const by = (ly - g.viewTransform.ty) / g.viewTransform.z;
      const wx = (bx - MAP_PADDING - g.transform.offsetX) / g.transform.scale;
      const wy = g.roomH - (by - MAP_PADDING - g.transform.offsetY) / g.transform.scale;
      const margin = 3; // allow a slightly-off tap at the wall
      if (wx < -margin || wx > g.roomW + margin || wy < -margin || wy > g.roomH + margin) return;
      onMapTapRef.current?.(clamp(wx, 0, g.roomW), clamp(wy, 0, g.roomH));
    });
  };

  const touchDistance = (touches) =>
    Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);

  const mapPanResponder = useMemo(
    () =>
      PanResponder.create({
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
          // the scroll view instead of panning the map — which is the other
          // half of why the gesture felt unreliable.
          onGestureActive?.(true);
          gestureRef.current.startView = { ...viewRef.current };
          const t = evt.nativeEvent.touches || [];
          gestureRef.current.pinching = t.length === 2;
          gestureRef.current.sawPinch = t.length === 2;
          gestureRef.current.startDist = t.length === 2 ? touchDistance(t) : 0;
        },
        onPanResponderMove: (evt, g) => {
          const start = gestureRef.current.startView;
          if (!start) return;
          const t = evt.nativeEvent.touches || [];

          if (t.length === 2) {
            // A pinch can begin part-way through a drag, so capture its
            // reference separation the first time two fingers are seen.
            if (!gestureRef.current.pinching) {
              gestureRef.current.pinching = true;
              gestureRef.current.sawPinch = true;
              gestureRef.current.startDist = touchDistance(t);
              gestureRef.current.startView = { ...viewRef.current };
              return;
            }
            const d = touchDistance(t);
            if (gestureRef.current.startDist > 10 && d > 10) {
              const next = clamp(
                (gestureRef.current.startView.zoom ?? 1) * (d / gestureRef.current.startDist),
                MIN_ZOOM,
                MAX_ZOOM
              );
              onViewChange?.({ ...viewRef.current, zoom: next });
            }
            return;
          }

          if (gestureRef.current.pinching) return; // ignore the leftover finger
          // Drag: moving the finger right should move the MAP right, which
          // means the centred world point moves left — hence the negated dx.
          const sc = scaleRef.current || 1;
          const startCx = Number.isFinite(start.cx) ? start.cx : roomW / 2;
          const startCy = Number.isFinite(start.cy) ? start.cy : roomH / 2;
          onViewChange?.({
            zoom: start.zoom ?? 1,
            cx: clamp(startCx - g.dx / sc, 0, roomW),
            cy: clamp(startCy + g.dy / sc, 0, roomH),
          });
        },
        onPanResponderRelease: (_evt, g) => {
          const wasPinch = gestureRef.current.sawPinch;
          gestureRef.current.pinching = false;
          gestureRef.current.sawPinch = false;
          onGestureActive?.(false);
          // A finger that barely moved is a tap, anything more was a pan.
          if (pickRef.current && !wasPinch && Math.abs(g.dx) < 8 && Math.abs(g.dy) < 8) {
            reportTap(g.x0, g.y0);
          }
        },
        onPanResponderTerminate: () => {
          gestureRef.current.pinching = false;
          onGestureActive?.(false);
        },
        // Hold the gesture against the enclosing ScrollView, which would
        // otherwise steal a vertical drag half-way through a pan.
        onPanResponderTerminationRequest: () => false,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roomW, roomH, onViewChange, onGestureActive]
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

  // ── Static grid ──────────────────────────────────────────────────────────
  // Split into minor lines, major lines and labels, and the line elements carry
  // NO stroke props of their own. Stroke colour and width are set on the
  // enclosing group instead, so keeping hairlines hairline while zoomed costs a
  // single changed prop rather than rebuilding every line. This memo therefore
  // depends only on the room and the base transform — it does not re-run while
  // pinching, which is what made the gesture smooth.
  const gridMinor = useMemo(() => {
    const out = [];
    for (let gx = 0; gx <= roomW + 0.001; gx += GRID_MINOR_FT) {
      if (Math.round(gx) % GRID_MAJOR_FT === 0) continue;
      const { cx } = toScreen(gx, 0);
      out.push(<Line key={`vg${gx}`} x1={cx} y1={roomPx.y} x2={cx} y2={roomPx.y + roomPx.h} />);
    }
    for (let gy = 0; gy <= roomH + 0.001; gy += GRID_MINOR_FT) {
      if (Math.round(gy) % GRID_MAJOR_FT === 0) continue;
      const { cy } = toScreen(0, gy);
      out.push(<Line key={`hg${gy}`} x1={roomPx.x} y1={cy} x2={roomPx.x + roomPx.w} y2={cy} />);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomW, roomH, transform.scale, transform.offsetX, transform.offsetY]);

  const gridMajor = useMemo(() => {
    const out = [];
    for (let gx = 0; gx <= roomW + 0.001; gx += GRID_MAJOR_FT) {
      const { cx } = toScreen(gx, 0);
      out.push(<Line key={`vG${gx}`} x1={cx} y1={roomPx.y} x2={cx} y2={roomPx.y + roomPx.h} />);
    }
    for (let gy = 0; gy <= roomH + 0.001; gy += GRID_MAJOR_FT) {
      const { cy } = toScreen(0, gy);
      out.push(<Line key={`hG${gy}`} x1={roomPx.x} y1={cy} x2={roomPx.x + roomPx.w} y2={cy} />);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomW, roomH, transform.scale, transform.offsetX, transform.offsetY]);

  // Labels are counter-scaled so they stay readable rather than growing with
  // zoom. There are only a handful, so recomputing them per zoom step is cheap.
  const gridLabels = useMemo(() => {
    const out = [];
    for (let gx = GRID_MAJOR_FT; gx <= roomW + 0.001; gx += GRID_MAJOR_FT) {
      const { cx } = toScreen(gx, 0);
      out.push(
        <SvgText
          key={`vgl${gx}`} x={cx} y={roomPx.y - 4 * inv}
          textAnchor="middle" fontSize={8 * inv} fill={C.textMuted}
        >{gx}</SvgText>
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomW, transform.scale, transform.offsetX, transform.offsetY, inv]);

  return (
    <View ref={wrapperRef} collapsable={false} style={styles.mapCanvasWrapper} {...mapPanResponder.panHandlers}>
      <Svg width={MAP_SIZE} height={canvasHeight + MAP_PADDING * 2}>
        <Defs>
          <RadialGradient id="haloGrad" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={quality.color} stopOpacity="0.30" />
            <Stop offset="70%" stopColor={quality.color} stopOpacity="0.10" />
            <Stop offset="100%" stopColor={quality.color} stopOpacity="0.00" />
          </RadialGradient>
        </Defs>

        {/* Everything below is drawn at the fit-to-canvas scale; this single
            group transform supplies zoom and pan. Keeping it as one transform
            is what makes pinching smooth — the alternative, folding zoom into
            every element's coordinates, rebuilt the whole grid in JS on every
            frame of the gesture. */}
        <G transform={`translate(${viewTransform.tx} ${viewTransform.ty}) scale(${viewTransform.z})`}>

        {/* ── Real floor plan background ── */}
        <SvgImage
          x={roomPx.x}
          y={roomPx.y}
          width={roomPx.w}
          height={roomPx.h}
          href={FLOORPLAN_IMAGE}
          preserveAspectRatio="none"
          opacity={0.92}
        />

        {/* ── Grid overlay (2 ft minor / 10 ft major, matches floor plan's own grid) ── */}
        <G stroke={C.gridMinor} strokeWidth={0.4 * inv}>{gridMinor}</G>
        <G stroke={C.gridMajor} strokeWidth={0.9 * inv}>{gridMajor}</G>
        {gridLabels}

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
            strokeDasharray={`${6 * inv},${5 * inv}`} strokeOpacity={0.55}
          />
        )}
        {ring2Px !== null && (
          <Circle
            cx={b2px.cx} cy={b2px.cy} r={ring2Px}
            fill="none" stroke={C.beacon2} strokeWidth={1.5}
            strokeDasharray={`${6 * inv},${5 * inv}`} strokeOpacity={0.55}
          />
        )}

        {/* ── Obstacles (walls, glass, pillars, cabinets) ──────────────────── */}
        {obstacles.map((o) => {
          const t = OBSTACLE_TYPES.find((k) => k.key === o.type);
          const color = t?.color || C.textSecondary;
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
            Drawn beneath the live trail, dashed, with a start dot and an end
            ring, so a recorded route is clearly a record and not the walk in
            progress. */}
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

        {/* ── PDR path: the route actually walked ──────────────────────────
            Only drawn while navigating. Before that there is no journey to
            show, and rendering a stub of a trail during the locating phase
            would suggest movement the user has not made. */}
        {navPhase === "navigating" && trail.length > 1 && (
          <Polyline
            points={trailPoints}
            fill="none" stroke={C.trail} strokeWidth={3 * inv}
            strokeOpacity={0.85} strokeLinecap="round" strokeLinejoin="round"
          />
        )}

        {/* ── The other possible position ──────────────────────────────────
            Two range circles meet at two points and ranges alone cannot say
            which one you are standing on. Drawing the second candidate is more
            honest than picking one at random and rendering it like a certainty
            — and it shows the user immediately which way to walk to settle it. */}
        {positionAmbiguous && alternatePosition && (() => {
          const altPx = toScreen(alternatePosition.x, alternatePosition.y);
          return (
            <>
              <Line
                x1={userPx.cx} y1={userPx.cy} x2={altPx.cx} y2={altPx.cy}
                stroke={C.textMuted} strokeWidth={1.5 * inv}
                strokeDasharray={`${5 * inv},${5 * inv}`} strokeOpacity={0.5}
              />
              <Circle
                cx={altPx.cx} cy={altPx.cy} r={USER_DOT_RADIUS * inv}
                fill="none" stroke={C.textMuted} strokeWidth={2.5 * inv}
                strokeDasharray={`${4 * inv},${3 * inv}`} strokeOpacity={0.85}
              />
              <SvgText
                x={altPx.cx} y={altPx.cy + 4 * inv} fontSize={11 * inv} fontWeight="700"
                fill={C.textMuted} textAnchor="middle"
              >?</SvgText>
            </>
          );
        })()}

        {/* ── Uncertainty halo — grows honestly when the fix is unreliable ── */}
        {haloPx > 3 && (
          <Circle cx={userPx.cx} cy={userPx.cy} r={Math.min(haloPx, CANVAS_SIZE)} fill="url(#haloGrad)" />
        )}

        {/* ── Beacon markers (draggable in placement mode) ── */}
        <BeaconMarker
          id={1} label="B1" color={C.beacon1} worldPos={anchor1}
          transform={transform} roomH={roomH} draggable={placementMode}
          inv={inv} dragScale={effectiveScale}
          deviceName={b1Name} onDragEnd={onBeaconDragEnd}
        />
        <BeaconMarker
          id={2} label="B2" color={C.beacon2} worldPos={anchor2}
          transform={transform} roomH={roomH} draggable={placementMode}
          inv={inv} dragScale={effectiveScale}
          deviceName={b2Name} onDragEnd={onBeaconDragEnd}
        />

        {/* ── Fused user position — opacity reflects confidence, never overstates certainty ── */}
        {!placementMode && (
          <>
            <Circle cx={userPx.cx} cy={userPx.cy} r={(USER_DOT_RADIUS + 4) * inv} fill={C.userDot} fillOpacity={quality.dotOpacity * 0.25} />
            <Circle cx={userPx.cx} cy={userPx.cy} r={USER_DOT_RADIUS * inv} fill={C.userDot} fillOpacity={quality.dotOpacity} />
            <Circle cx={userPx.cx} cy={userPx.cy} r={(USER_DOT_RADIUS - 3) * inv} fill="#fff" fillOpacity={quality.dotOpacity * 0.65} />
            {/* Heading indicator — short needle pointing the way the user is facing */}
            {Number.isFinite(headingDeg) && (() => {
              const rad = (headingDeg * Math.PI) / 180;
              const needleLenPx = (USER_DOT_RADIUS + 10) * inv;
              // World heading (0°=+Y/up, 90°=+X/right) -> screen delta (Y flipped)
              const tipX = userPx.cx + Math.sin(rad) * needleLenPx;
              const tipY = userPx.cy - Math.cos(rad) * needleLenPx;
              return (
                <Line
                  x1={userPx.cx} y1={userPx.cy} x2={tipX} y2={tipY}
                  stroke="#fff" strokeWidth={2.5 * inv} strokeOpacity={quality.dotOpacity} strokeLinecap="round"
                />
              );
            })()}
          </>
        )}
        {/* ── Start point the user tapped (not yet confirmed) ── */}
        {pendingPoint && (() => {
          const p = toScreen(pendingPoint.x, pendingPoint.y);
          const r = 11 * inv;
          return (
            <G>
              <Circle cx={p.cx} cy={p.cy} r={r * 1.9} fill={C.accent} fillOpacity={0.15} />
              <Circle cx={p.cx} cy={p.cy} r={r} fill="none" stroke={C.accent} strokeWidth={2.5 * inv} />
              <Line x1={p.cx - r * 1.6} y1={p.cy} x2={p.cx + r * 1.6} y2={p.cy} stroke={C.accent} strokeWidth={1.5 * inv} />
              <Line x1={p.cx} y1={p.cy - r * 1.6} x2={p.cx} y2={p.cy + r * 1.6} stroke={C.accent} strokeWidth={1.5 * inv} />
              <SvgText x={p.cx} y={p.cy - r * 2.2} textAnchor="middle" fontSize={10 * inv} fill={C.accent} fontWeight="bold">
                START
              </SvgText>
            </G>
          );
        })()}
        </G>
      </Svg>

      {/* ── Zoom controls ────────────────────────────────────────────────
          A 72 ft room on a phone screen puts roughly four feet in a
          fingertip, which is finer than the position is accurate — zooming is
          what makes the 2 ft grid usable for reading off a real location. */}
      <View style={styles.zoomCluster}>
        <TouchableOpacity
          style={styles.zoomBtn}
          onPress={() => onAnimateView?.({ zoom: clamp(zoom * 1.6, MIN_ZOOM, MAX_ZOOM) })}
        >
          <Text style={styles.zoomBtnText}>+</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.zoomBtn}
          onPress={() => onAnimateView?.({ zoom: clamp(zoom / 1.6, MIN_ZOOM, MAX_ZOOM) })}
        >
          <Text style={styles.zoomBtnText}>−</Text>
        </TouchableOpacity>
        {/* Centre on the user: with this viewport model that is simply
            "make the user's world position the centred one". */}
        <TouchableOpacity
          style={styles.zoomBtn}
          onPress={() => onAnimateView?.({ zoom: Math.max(zoom, 2.5), cx: x, cy: y }, 320)}
        >
          <Text style={styles.zoomBtnIcon}>◎</Text>
        </TouchableOpacity>
        {(zoom !== 1 || Number.isFinite(view.cx)) && (
          <TouchableOpacity
            style={styles.zoomBtn}
            onPress={() => onAnimateView?.({ zoom: 1, cx: null, cy: null }, 260)}
          >
            <Text style={styles.zoomBtnIcon}>⤢</Text>
          </TouchableOpacity>
        )}
      </View>
      {zoom !== 1 && (
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
  // Viewport: which world point is centred, and at what magnification.
  // null centre = "fit the whole floor plan", the default.
  // Room size comes first: the view animation below lists roomW/roomH as
  // dependencies, and reading them before this declaration gave it
  // [undefined, undefined], so it never saw a changed room size.
  const [roomWidthStr, setRoomWidthStr] = useState(String(DEFAULT_ROOM_W_FT));
  const [roomHeightStr, setRoomHeightStr] = useState(String(DEFAULT_ROOM_H_FT));
  const roomW = parseFloatSafe(roomWidthStr, DEFAULT_ROOM_W_FT);
  const roomH = parseFloatSafe(roomHeightStr, DEFAULT_ROOM_H_FT);

  const [view, setView] = useState({ zoom: 1, cx: null, cy: null });
  // Page scrolling is suspended while the map is being dragged or pinched.
  const [mapGestureActive, setMapGestureActive] = useState(false);

  // ── Animated viewport moves ──────────────────────────────────────────────
  // Button zoom and "centre on me" are tweened rather than applied instantly.
  // A jump straight from 1x to 1.6x gives no sense of where the view went, and
  // reads as the control misbehaving; easing over a fifth of a second lets the
  // eye follow the map. Pinch is deliberately NOT tweened — it must track the
  // fingers exactly, and interpolation there would feel like lag.
  const viewAnimRef = useRef(null);
  const liveViewRef = useRef(view);
  liveViewRef.current = view;

  const animateView = useCallback((target, durationMs = 220) => {
    if (viewAnimRef.current) cancelAnimationFrame(viewAnimRef.current);
    const from = liveViewRef.current;
    const fromZoom = from.zoom ?? 1;
    const fromCx = Number.isFinite(from.cx) ? from.cx : roomW / 2;
    const fromCy = Number.isFinite(from.cy) ? from.cy : roomH / 2;
    const toZoom = clamp(target.zoom ?? fromZoom, MIN_ZOOM, MAX_ZOOM);
    const toCx = Number.isFinite(target.cx) ? target.cx : fromCx;
    const toCy = Number.isFinite(target.cy) ? target.cy : fromCy;

    const t0 = Date.now();
    const step = () => {
      const t = Math.min(1, (Date.now() - t0) / durationMs);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setView({
        zoom: fromZoom + (toZoom - fromZoom) * e,
        cx: fromCx + (toCx - fromCx) * e,
        cy: fromCy + (toCy - fromCy) * e,
      });
      if (t < 1) viewAnimRef.current = requestAnimationFrame(step);
      else if (target.cx === null && target.cy === null && toZoom === 1) {
        // Landing exactly on the default restores "fit the whole plan", so the
        // reset button genuinely resets rather than leaving a centre pinned.
        setView({ zoom: 1, cx: null, cy: null });
      }
    };
    viewAnimRef.current = requestAnimationFrame(step);
  }, [roomW, roomH]);

  useEffect(() => () => {
    if (viewAnimRef.current) cancelAnimationFrame(viewAnimRef.current);
  }, []);
  const [savedRoutes, setSavedRoutes] = useState([]);
  const [showRoutes, setShowRoutes] = useState(false);
  // Saved routes currently drawn on the map. A just-saved route is added
  // automatically so the walk stays visible after Stop clears the live trail.
  const [shownRouteIds, setShownRouteIds] = useState(() => new Set());
  const [locProgress, setLocProgress] = useState(null);
  // Read from inside sensor callbacks, which would otherwise capture a stale
  // value from the render they were created in.
  const headingCalibratedRef = useRef(headingCalibrated);
  headingCalibratedRef.current = headingCalibrated;
  const isRunning = navPhase !== "idle";
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
  // scanner's packets) even if the Raw / Signal Lab tabs were never opened.
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
      fusionEngine.correct(d1Ft, d2Ft, c1, c2, s1, s2);
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

  // ── Obstacles: load once; push geometry to the calibration and locating ───
  useEffect(() => {
    obstacleMap.load().then(() => setObstacleVer((v) => v + 1));
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
      pdrStepCallbackRef.current = ({ stepLengthMeters, heading }) => {
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
          if (!fix || !completeLocating(fix)) return;
        } else if (navPhase !== "navigating") {
          return;
        }
        const stepLengthFt = metresToFeet(stepLengthMeters);
        fusionEngine.predict(stepLengthFt, heading);
        setFusionState({ ...fusionEngine.getState() });
      };
      return () => {
        pdrStepCallbackRef.current = null;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdrStepCallbackRef, navPhase, placementMode]);

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
  const completeLocating = (fix) => {
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
    fusionEngine.beginNavigation();
    setFusionState({ ...fusionEngine.getState() });
    setNavPhase("navigating");
    setLocatedAt(Date.now());
    return true;
  };

  /** Commits the fix and starts drawing the walked path from it. */
  const handleStartNavigation = () => {
    fusionEngine.beginNavigation();
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

  const handleMapTap = (xFt, yFt) => {
    if (obstacleEdit) {
      const t = OBSTACLE_TYPES.find((k) => k.key === obstacleEdit.type);
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
    autoCalRef.current.stop("stopped");
    setAutoCalStatus(autoCalRef.current.getStatus());
    setPendingStart(null);
    fusionEngine.cancelLocating();
    setNavPhase("idle");
    setLocProgress(null);
  };

  /** Throws away the current fix and locates again from scratch. */
  const handleReLocate = () => {
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
        lines.push({ key: k, bad: true, text: `B${k}: not selected — pick it in Signal Lab` });
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
      {/* ── Locating progress ─────────────────────────────────────────────
          Standing still for a few seconds is what buys the accurate fix, so the
          reason for the wait is stated plainly and the progress is visible —
          otherwise it just looks like the app is slow to respond. */}
      {obstacleEdit && (
        <View style={[styles.statusBanner, styles.fixBannerWaiting]}>
          <Text style={styles.statusBannerText}>
            {obstacleEdit.erase
              ? "🧽 Tap an obstacle to remove it."
              : OBSTACLE_TYPES.find((t) => t.key === obstacleEdit.type)?.point
                ? "Tap the centre of each pillar / cabinet."
                : obstacleEdit.first
                  ? "Now tap where this wall ENDS."
                  : "Tap where a wall STARTS, then where it ends. Draw every wall, glass cabin side and partition between desks and the beacons."}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 6 }}>
            {OBSTACLE_TYPES.map((t) => {
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
        <View style={[styles.statusBanner, styles.fixBannerWaiting]}>
          <Text style={styles.statusBannerText}>
            ◎ Finding your position — stand still ({Math.round((locateStartRef.current.t ? (locateClock || Date.now()) - locateStartRef.current.t : 0) / 1000)} s).{" "}
            {locProgress?.samples
              ? `${locProgress.samples} readings collected`
              : "waiting for both beacons"}
          </Text>
          <Text style={[styles.locateDiag, { color: C.textPrimary }]}>
            Taking too long? Tap where you are on the map to start there.
          </Text>
          <Text style={styles.locateDiag}>{describeRunningBundle()}</Text>
          {locateDiagnostics.map((line) => (
            <Text key={line.key} style={[styles.locateDiag, line.bad && { color: C.accentOrange }]}>
              {line.text}
            </Text>
          ))}
          <View style={styles.locateTrack}>
            <View
              style={[
                styles.locateBar,
                { width: `${Math.round((locProgress?.progress ?? 0) * 100)}%` },
              ]}
            />
          </View>
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
        <View style={[styles.statusBanner, styles.fixBannerWarn]}>
          <Text style={styles.statusBannerText}>
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
        if (st.positionAmbiguous) {
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
                {" "}This is a calibration fault, not noise — run Ranging Calibration in Signal Lab
                (two 20-second stands, no measuring needed).
              </Text>
            </View>
          );
        }
        if (initialFix?.adjusted && (initialFix.adjustmentFt ?? 0) >= 8) {
          return (
            <View style={[styles.statusBanner, styles.fixBannerWarn]}>
              <Text style={styles.statusBannerText}>
                ⚠ Beacon distances disagree with their measured spacing by ~{initialFix.adjustmentFt.toFixed(0)} ft.
                That is a calibration problem, not noise — run Ranging Calibration in Signal Lab,
                which measures both beacons against their spacing on this floor plan.
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

      <OfficeMapCanvas
        roomW={roomW} roomH={roomH}
        anchor1={anchor1} anchor2={anchor2}
        fusionState={fusionState}
        d1Ft={d1Ft} d2Ft={d2Ft}
        b1Name={bleStats.b1?.name} b2Name={bleStats.b2?.name}
        headingDeg={headingRef?.current ?? 0}
        placementMode={placementMode}
        onBeaconDragEnd={handleBeaconDragEnd}
        view={view}
        onViewChange={setView}
        onAnimateView={animateView}
        onGestureActive={setMapGestureActive}
        navPhase={navPhase}
        obstacles={obstacleMap.items}
        pickMode={
          Boolean(obstacleEdit) ||
          spotCal?.stage === "pick" ||
          navPhase === "picking" ||
          navPhase === "locating" ||
          (navPhase === "navigating" && fusionState.positionAmbiguous)
        }
        onMapTap={handleMapTap}
        pendingPoint={
          obstacleEdit?.first
            ? obstacleEdit.first
            : spotCal?.point && spotCal.stage !== "done"
            ? spotCal.point
            : navPhase === "picking" ? pendingStart : null
        }
        savedRoutesOnMap={savedRoutes
          .filter((r) => shownRouteIds.has(r.id) && isFusionMapRoute(r))
          .map((r) => ({ id: r.id, points: r.points, color: routeColor(r.id) }))}
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
            🧱 Draw Walls / Pillars / Cabins ({obstacleMap.items.length} drawn)
          </Text>
        </TouchableOpacity>
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
