// ============================================================================
// useTwoBeaconPositioning — Central Hook
// Manages BLE scanning, RSSI pipeline, position calculation loop, and
// PDR step integration. Completely isolated from existing app state.
// ============================================================================

import { useRef, useState, useEffect, useCallback } from "react";
import { Share, Alert } from "react-native";
import {
  getBleManager,
  requestBluetoothPermissions,
  ensureBluetoothEnabled,
  parseBeaconPayload,
} from "../services/BleScannerService.js";
import {
  RssiFilterPipeline,
  rssiToDistance,
  applyHeightCorrection,
  computeWeight,
  solveTwoBeaconPosition,
  AdaptiveKalman2D,
  computeBleConfidence,
  createTrajectoryPoint,
  exportTrajectoryAsCsv,
  exportTrajectoryAsJson,
  computeBenchmarkStats,
  normalizeHeading,
  getCardinalDirection,
  isSaneMovement,
  clampToRoom,
  ROOM_WIDTH_FT,
  ROOM_HEIGHT_FT,
} from "../services/twoBeaconServices.js";

// Calculation loop interval (ms → ~10 Hz)
const CALC_INTERVAL_MS = 100;
// UI render loop interval (ms → 20 FPS)
const UI_INTERVAL_MS   = 50;
// Max trail points on map
const MAX_TRAIL_POINTS = 60;
// Max trajectory records for export
const MAX_TRAJECTORY_POINTS = 600;

export function useTwoBeaconPositioning({
  config,              // beaconConfig from storage
  pdrStepCallbackRef,  // parent fills this ref; hook attaches to it
  heading = 0,         // compass/gyro heading from parent
}) {
  // ─── Scan state ────────────────────────────────────────────────────────────
  const [isScanning,       setIsScanning]       = useState(false);
  const [devices,          setDevices]          = useState({});     // id → device meta
  const [bluetoothStatus,  setBluetoothStatus]  = useState("Unknown");

  // ─── Module state machine ──────────────────────────────────────────────────
  // IDLE | SCANNING | BEACONS_SELECTED | PLACEMENT_CONFIGURED |
  // CALIBRATED | POSITIONING | PAUSED | STOPPED
  const [moduleState, setModuleState] = useState("IDLE");

  // ─── Positioning mode & Ground truth validation ────────────────────────────
  // Modes: "kalman" | "ble" | "pdr" | "complementary"
  const [positioningMode, setPositioningMode] = useState("kalman");
  const [groundTruth,     setGroundTruth]     = useState(null);    // { x, y } in feet

  // ─── Position output (for UI renders) ─────────────────────────────────────
  const [positionState, setPositionState] = useState({
    bleX: 9, bleY: 7.5,
    pdrX: 9, pdrY: 7.5,
    fusedX: 9, fusedY: 7.5,
    activeX: 9, activeY: 7.5,
    confidence: 0,
    bleAccepted: true,
    bleResidual: 0,
    stepCount: 0,
    stepLength: 0.70,
    heading: 0,
    cardinal: "North (N)",
    timestamp: Date.now(),
  });
  const [trail,      setTrail]      = useState([]);
  const [debugInfo,  setDebugInfo]  = useState({});
  const [stats,      setStats]      = useState({ count: 0, mae: 0, rmse: 0, max: 0 });

  // ─── Internal refs (fast, no re-render) ───────────────────────────────────
  const isScanningRef               = useRef(false);
  const modulStateRef               = useRef("IDLE");
  const managerRef                  = useRef(null);
  const calcIntervalRef             = useRef(null);
  const uiIntervalRef               = useRef(null);
  const positioningModeRef          = useRef("kalman");
  const groundTruthRef              = useRef(null);
  const headingRef                  = useRef(heading);
  const isAwaitingInitialBleLockRef = useRef(true);
  const initialBleLockedRef         = useRef(false);

  // PDR Step Metrics
  const stepCountRef                = useRef(0);
  const stepLengthRef               = useRef(0.70); // in meters

  // Trajectory & Benchmark Storage
  const trajectoryRef               = useRef([]);
  const errorSamplesRef             = useRef([]);
  const lastTrajectoryRecordTime    = useRef(0);

  useEffect(() => { positioningModeRef.current = positioningMode; }, [positioningMode]);
  useEffect(() => { groundTruthRef.current = groundTruth; }, [groundTruth]);
  useEffect(() => { headingRef.current = heading; }, [heading]);

  // Per-beacon RSSI pipelines
  const pipeline1Ref = useRef(new RssiFilterPipeline());
  const pipeline2Ref = useRef(new RssiFilterPipeline());

  // Kalman filter
  const kalmanRef = useRef(new AdaptiveKalman2D());

  // PDR state ref (updated from parent callback)
  const pdrPosRef = useRef({ x: 9, y: 7.5 });

  // Position history for motion consistency
  const prevFusedRef    = useRef({ x: 9, y: 7.5 });
  const displayPosRef   = useRef({ x: 9, y: 7.5 });
  const lastStepTimeRef = useRef(0);
  const prevBle1Ref     = useRef(null);
  const prevDist1Ref    = useRef(null);
  const prevDist2Ref    = useRef(null);
  const lastCalcTime    = useRef(Date.now());

  // Device meta ref (for raw device display)
  const deviceMetaRef = useRef({});

  // Latest position ref (used by UI loop to avoid stale state)
  const positionRef   = useRef({
    bleX: 9, bleY: 7.5,
    pdrX: 9, pdrY: 7.5,
    fusedX: 9, fusedY: 7.5,
    activeX: 9, activeY: 7.5,
    confidence: 0,
    bleAccepted: true,
    bleResidual: 0,
    stepCount: 0,
    stepLength: 0.70,
    heading: 0,
    cardinal: "North (N)",
  });
  const trailRef      = useRef([]);
  const debugRef      = useRef({});
  const statsRef      = useRef({ count: 0, mae: 0, rmse: 0, max: 0 });

  // ─── Config refs (always up-to-date without recreating effects) ───────────
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
    if (config?.roomWidthFt && config?.roomHeightFt) {
      kalmanRef.current?.setRoomDimensions?.(config.roomWidthFt, config.roomHeightFt);
    }
  }, [config]);

  // ─── BLE Manager init ──────────────────────────────────────────────────────
  useEffect(() => {
    const mgr = getBleManager();
    managerRef.current = mgr;

    if (!mgr) {
      setBluetoothStatus("Native BLE required");
      return;
    }

    let sub;
    try {
      sub = mgr.onStateChange(state => {
        setBluetoothStatus(state);
        if (state === "PoweredOff" && isScanningRef.current) stopScan();
      }, true);
    } catch (e) { /* ignore */ }

    return () => { sub?.remove?.(); };
  }, []);

  // ─── Register PDR step callback ───────────────────────────────────────────
  useEffect(() => {
    if (!pdrStepCallbackRef) return;
    // Parent calls pdrStepCallbackRef.current({ stepLengthMeters, heading })
    pdrStepCallbackRef.current = ({ stepLengthMeters, heading: stepHeading }) => {
      try {
        if (modulStateRef.current !== "POSITIONING") return;
        const now = Date.now();
        lastStepTimeRef.current = now;

        // Update PDR step counters
        stepCountRef.current++;
        const lenMeters = (stepLengthMeters && isFinite(stepLengthMeters) && stepLengthMeters >= 0.35 && stepLengthMeters <= 1.25)
          ? stepLengthMeters
          : 0.70;
        stepLengthRef.current = lenMeters;

        const stepFt = lenMeters * 3.28084;
        const curHeading = (stepHeading !== undefined && isFinite(stepHeading)) ? stepHeading : headingRef.current;
        const rad = (curHeading * Math.PI) / 180;

        // Map coordinates: 0° = North (+Y), 90° = East (+X)
        const dx = stepFt * Math.sin(rad);
        const dy = stepFt * Math.cos(rad);

        // Update PDR continuous position
        const roomW = (typeof configRef.current?.roomWidthFt === "number" && isFinite(configRef.current.roomWidthFt) && configRef.current.roomWidthFt > 0) ? configRef.current.roomWidthFt : ROOM_WIDTH_FT;
        const roomH = (typeof configRef.current?.roomHeightFt === "number" && isFinite(configRef.current.roomHeightFt) && configRef.current.roomHeightFt > 0) ? configRef.current.roomHeightFt : ROOM_HEIGHT_FT;
        const old = pdrPosRef.current;
        pdrPosRef.current = clampToRoom(old.x + dx, old.y + dy, roomW, roomH);

        // Kalman prediction step (PDR = continuous prediction)
        kalmanRef.current.predict(dx, dy, 0.40);
      } catch (err) {
        console.warn("[pdrStepCallback error]:", err);
      }
    };

    return () => { if (pdrStepCallbackRef) pdrStepCallbackRef.current = null; };
  }, []);

  // ─── SCAN FUNCTIONS ────────────────────────────────────────────────────────
  const startScan = useCallback(async () => {
    if (isScanningRef.current) return;

    // Permissions
    const granted = await requestBluetoothPermissions();
    if (!granted) return;


    const mgr = managerRef.current;
    if (!mgr) {
      setBluetoothStatus("BLE Manager Unavailable");
      return;
    }

    await ensureBluetoothEnabled();

    isScanningRef.current = true;
    setIsScanning(true);

    try {
      mgr.startDeviceScan(null, { allowDuplicates: true, scanMode: 2 }, (error, device) => {
        if (error || !device) return;
        const now   = Date.now();
        const rssi  = device.rssi ?? null;
        const id    = device.id;
        const rawName = device.name || device.localName || "";
        const beaconInfo = parseBeaconPayload(device.manufacturerData, device.serviceData, rawName);
        const displayName = beaconInfo.displayName || rawName || `BLE Device (${id.slice(-5)})`;

        // Store real device metadata
        deviceMetaRef.current[id] = {
          id,
          name: displayName,
          rssi,
          lastSeen: now,
          beaconInfo,
          isBeacon: beaconInfo.isBeacon,
        };

        // Route to selected beacon pipelines (case-insensitive ID matching)
        const cfg = configRef.current;
        if (cfg.beacon1Id && id.toLowerCase() === cfg.beacon1Id.toLowerCase() && rssi !== null) {
          pipeline1Ref.current.addPacket(rssi, now);
        }
        if (cfg.beacon2Id && id.toLowerCase() === cfg.beacon2Id.toLowerCase() && rssi !== null) {
          pipeline2Ref.current.addPacket(rssi, now);
        }
      });
    } catch (e) {
      console.warn("[useTwoBeaconPositioning] scan error:", e);
    }
  }, []);

  const stopScan = useCallback(() => {
    if (!isScanningRef.current) return;
    isScanningRef.current = false;
    setIsScanning(false);

    const mgr = managerRef.current;
    try { mgr?.stopDeviceScan?.(); } catch (e) { /* ignore */ }
  }, []);


  // ─── UI UPDATE LOOP ────────────────────────────────────────────────────────
  useEffect(() => {
    const uiInterval = setInterval(() => {
      try {
        // Always update device list (for stage 1 scanner)
        const meta = deviceMetaRef.current;
        if (Object.keys(meta).length > 0) {
          const now = Date.now();
          const updated = {};
          Object.values(meta).forEach(d => {
            updated[d.id] = { ...d, ageMsAgo: now - (d.lastSeen || now) };
          });
          setDevices(updated);
        }

        // Position state (when active or paused)
        const ms = modulStateRef.current;
        if (ms === "POSITIONING" || ms === "PAUSED") {
          setPositionState({ ...positionRef.current, timestamp: Date.now() });
          setTrail([...trailRef.current]);
          setDebugInfo({ ...debugRef.current });
          setStats({ ...statsRef.current });
        }
      } catch (err) {
        console.warn("[uiInterval error]:", err);
      }
    }, UI_INTERVAL_MS);

    return () => clearInterval(uiInterval);
  }, []);

  // ─── CALCULATION LOOP ──────────────────────────────────────────────────────
  function _startCalcLoop() {
    if (calcIntervalRef.current) return;
    calcIntervalRef.current = setInterval(() => {
      _runPositionCalculation();
    }, CALC_INTERVAL_MS);
  }

  function _stopCalcLoop() {
    if (calcIntervalRef.current) {
      clearInterval(calcIntervalRef.current);
      calcIntervalRef.current = null;
    }
  }

  function _runPositionCalculation() {
    try {
      const cfg = configRef.current;
      const roomW = (typeof cfg?.roomWidthFt === "number" && isFinite(cfg.roomWidthFt) && cfg.roomWidthFt > 0) ? cfg.roomWidthFt : ROOM_WIDTH_FT;
      const roomH = (typeof cfg?.roomHeightFt === "number" && isFinite(cfg.roomHeightFt) && cfg.roomHeightFt > 0) ? cfg.roomHeightFt : ROOM_HEIGHT_FT;
      kalmanRef.current.setRoomDimensions(roomW, roomH);

      const now = Date.now();
    const dtSeconds = Math.max(0.05, Math.min(1.0, (now - lastCalcTime.current) / 1000));
    lastCalcTime.current = now;

    // Get pipeline states
    const s1 = pipeline1Ref.current.getState();
    const s2 = pipeline2Ref.current.getState();

    // Distances with adaptive smoothing (feet)
    let d1 = rssiToDistance(s1.filteredRssi, cfg.beacon1TxPower, cfg.pathLossN, prevDist1Ref.current);
    let d2 = rssiToDistance(s2.filteredRssi, cfg.beacon2TxPower, cfg.pathLossN, prevDist2Ref.current);

    // Dual Motion Detection:
    // User is moving if PDR step occurred within 2.0s OR if BLE distances shift by > 0.30 ft
    const pdrMoving = (now - lastStepTimeRef.current) < 2000;
    const bleMoving = (
      (prevDist1Ref.current !== null && d1 !== null && Math.abs(d1 - prevDist1Ref.current) > 0.30) ||
      (prevDist2Ref.current !== null && d2 !== null && Math.abs(d2 - prevDist2Ref.current) > 0.30)
    );
    const isStationary = !pdrMoving && !bleMoving;

    // Height correction
    let hv1 = 1, hv2 = 1;
    if (cfg.heightCorrectionOn) {
      const hc1 = applyHeightCorrection(d1, cfg.beacon1HeightFt, cfg.phoneHeightFt);
      const hc2 = applyHeightCorrection(d2, cfg.beacon2HeightFt, cfg.phoneHeightFt);
      d1 = hc1.correctedDist; hv1 = hc1.heightValidity;
      d2 = hc2.correctedDist; hv2 = hc2.heightValidity;
    }

    const prevFused = prevFusedRef.current;

    // Raw BLE estimate
    const rawBle = solveTwoBeaconPosition(
      { x: cfg.beacon1X, y: cfg.beacon1Y },
      { x: cfg.beacon2X, y: cfg.beacon2Y },
      d1, d2, 0.5, 0.5,
      prevFused.x, prevFused.y,
      roomW, roomH,
    );

    // Compute weights
    const age1 = s1.lastSeen ? now - s1.lastSeen : 9999;
    const age2 = s2.lastSeen ? now - s2.lastSeen : 9999;

    const w1 = computeWeight({
      rssiBuffer:         pipeline1Ref.current.buffer,
      filteredRssi:       s1.filteredRssi,
      lastSeenMs:         age1,
      distanceFt:         d1,
      prevDistanceFt:     prevDist1Ref.current,
      prevPosition:       prevFused,
      blePosition:        rawBle,
      heightValidity:     hv1,
      heightCorrectionOn: cfg.heightCorrectionOn,
    });

    const w2 = computeWeight({
      rssiBuffer:         pipeline2Ref.current.buffer,
      filteredRssi:       s2.filteredRssi,
      lastSeenMs:         age2,
      distanceFt:         d2,
      prevDistanceFt:     prevDist2Ref.current,
      prevPosition:       prevFused,
      blePosition:        rawBle,
      heightValidity:     hv2,
      heightCorrectionOn: cfg.heightCorrectionOn,
    });

    // Solve final BLE position with proper weights
    const bleSol = solveTwoBeaconPosition(
      { x: cfg.beacon1X, y: cfg.beacon1Y },
      { x: cfg.beacon2X, y: cfg.beacon2Y },
      d1, d2, w1, w2,
      prevFused.x, prevFused.y,
      roomW, roomH,
    );

    // Dynamic BLE Confidence Model
    const bleConfidence = computeBleConfidence({
      s1,
      s2,
      d1,
      d2,
      b1Pos: { x: cfg.beacon1X, y: cfg.beacon1Y },
      b2Pos: { x: cfg.beacon2X, y: cfg.beacon2Y },
      blePos: bleSol,
      now,
      roomW,
      roomH,
    });

    // ─── INITIAL POSITION AUTO-LOCK FROM FIRST RELIABLE BLE ──────────────────
    // PDR must NOT assume (0,0) or default to center. It auto-locks to the first reliable BLE position.
    if (isAwaitingInitialBleLockRef.current && (d1 !== null || d2 !== null)) {
      pdrPosRef.current     = { x: bleSol.x, y: bleSol.y };
      kalmanRef.current.reset(bleSol.x, bleSol.y);
      prevFusedRef.current  = { x: bleSol.x, y: bleSol.y };
      displayPosRef.current = { x: bleSol.x, y: bleSol.y };
      isAwaitingInitialBleLockRef.current = false;
      initialBleLockedRef.current = true;
    }

    // ─── KALMAN FILTER PREDICTION / TIME UPDATE ──────────────────────────────
    // Slowly maintains uncertainty floor over elapsed time without freezing
    kalmanRef.current.timeUpdate(dtSeconds);

    // ─── KALMAN FILTER MEASUREMENT UPDATE WITH OUTLIER REJECTION ─────────────
    let kalmanUpdateResult = { accepted: true, residual: 0, kGain: 0.5 };
    if (d1 !== null || d2 !== null) {
      kalmanUpdateResult = kalmanRef.current.update(bleSol.x, bleSol.y, bleConfidence, isStationary);
    } else {
      // BLE temporarily unavailable -> DO NOT FREEZE! PDR continues predicting continuous movement.
      kalmanUpdateResult = { accepted: false, residual: kalmanRef.current.lastResidual, kGain: 0 };
    }

    const rawFused = kalmanRef.current.getPosition();
    const pdr      = pdrPosRef.current;

    // Display-level EMA smoother to eliminate high-frequency micro-jitter
    const prevDisplay = displayPosRef.current || rawFused;
    const alpha = isStationary ? 0.20 : 0.40;
    const smoothX = Number((alpha * rawFused.x + (1 - alpha) * prevDisplay.x).toFixed(2));
    const smoothY = Number((alpha * rawFused.y + (1 - alpha) * prevDisplay.y).toFixed(2));
    displayPosRef.current = { x: smoothX, y: smoothY };

    // ─── SELECT ACTIVE OUTPUT BY POSITIONING MODE ────────────────────────────
    // 4 Test Modes: "kalman" | "ble" | "pdr" | "complementary"
    const mode = positioningModeRef.current;
    let actX = smoothX;
    let actY = smoothY;

    if (mode === "ble") {
      actX = bleSol.x;
      actY = bleSol.y;
    } else if (mode === "pdr") {
      actX = pdr.x;
      actY = pdr.y;
    } else if (mode === "complementary") {
      // Complementary blending without covariance matrix
      const wBle = Math.max(0.15, Math.min(0.85, bleConfidence));
      actX = Number((wBle * bleSol.x + (1 - wBle) * pdr.x).toFixed(2));
      actY = Number((wBle * bleSol.y + (1 - wBle) * pdr.y).toFixed(2));
    } else {
      // Default: "kalman"
      actX = smoothX;
      actY = smoothY;
    }

    // ─── TRAIL UPDATE ────────────────────────────────────────────────────────
    const trail = trailRef.current;
    if (trail.length === 0 || Math.hypot(actX - trail[trail.length - 1].x, actY - trail[trail.length - 1].y) > 0.20) {
      trail.push({ x: actX, y: actY });
      if (trail.length > MAX_TRAIL_POINTS) trail.shift();
    }

    // ─── GROUND TRUTH MULTI-SOURCE BENCHMARKING ──────────────────────────────
    const gt = groundTruthRef.current;
    let gtErrorFt = null;
    let bleErrorFt = null;
    let pdrErrorFt = null;
    let fusedErrorFt = null;
    let accuracyScore = null;

    if (gt) {
      gtErrorFt = Number(Math.hypot(actX - gt.x, actY - gt.y).toFixed(2));
      bleErrorFt = Number(Math.hypot(bleSol.x - gt.x, bleSol.y - gt.y).toFixed(2));
      pdrErrorFt = Number(Math.hypot(pdr.x - gt.x, pdr.y - gt.y).toFixed(2));
      fusedErrorFt = Number(Math.hypot(smoothX - gt.x, smoothY - gt.y).toFixed(2));
      accuracyScore = Math.max(0, Math.min(100, Math.round((1 - gtErrorFt / 12) * 100)));

      // Accumulate error samples for running statistics
      errorSamplesRef.current.push(gtErrorFt);
      if (errorSamplesRef.current.length > 300) errorSamplesRef.current.shift();
      statsRef.current = computeBenchmarkStats(errorSamplesRef.current);
    }

    // ─── TRAJECTORY LOGGING (FOR R&D CSV/JSON EXPORT) ─────────────────────────
    if (now - lastTrajectoryRecordTime.current >= 450 || !isStationary) {
      lastTrajectoryRecordTime.current = now;
      const pt = createTrajectoryPoint({
        timestamp: now,
        bleX: bleSol.x,
        bleY: bleSol.y,
        pdrX: pdr.x,
        pdrY: pdr.y,
        fusedX: smoothX,
        fusedY: smoothY,
        activeX: actX,
        activeY: actY,
        heading: headingRef.current,
        stepLength: stepLengthRef.current,
        stepNumber: stepCountRef.current,
        beacon1RSSI: s1.filteredRssi,
        beacon2RSSI: s2.filteredRssi,
        beacon1Distance: d1,
        beacon2Distance: d2,
        bleConfidence,
        kalmanConfidence: bleSol.confidence,
        bleResidual: kalmanUpdateResult.residual,
        bleAccepted: kalmanUpdateResult.accepted,
        mode,
      });
      trajectoryRef.current.push(pt);
      if (trajectoryRef.current.length > MAX_TRAJECTORY_POINTS) {
        trajectoryRef.current.shift();
      }
    }

    // Store refs
    prevFusedRef.current = rawFused;
    prevBle1Ref.current  = { x: bleSol.x, y: bleSol.y };
    prevDist1Ref.current = d1;
    prevDist2Ref.current = d2;

    const curHeading = headingRef.current;
    const cardinal = getCardinalDirection(curHeading);

    // Update position ref (UI loop reads this)
    positionRef.current = {
      bleX:         bleSol.x,
      bleY:         bleSol.y,
      pdrX:         pdr.x,
      pdrY:         pdr.y,
      fusedX:       smoothX,
      fusedY:       smoothY,
      activeX:      actX,
      activeY:      actY,
      confidence:   bleConfidence,
      bleAccepted:  kalmanUpdateResult.accepted,
      bleResidual:  kalmanUpdateResult.residual,
      stepCount:    stepCountRef.current,
      stepLength:   stepLengthRef.current,
      heading:      curHeading,
      cardinal,
    };

    // Debug ref
    debugRef.current = {
      b1: { rawRssi: s1.rawRssi, filteredRssi: s1.filteredRssi, distanceFt: d1, weight: w1 },
      b2: { rawRssi: s2.rawRssi, filteredRssi: s2.filteredRssi, distanceFt: d2, weight: w2 },
      bleX: bleSol.x, bleY: bleSol.y,
      pdrX: pdr.x,    pdrY: pdr.y,
      fusedX: smoothX, fusedY: smoothY,
      activeX: actX,   activeY: actY,
      confidence: bleConfidence,
      bleAccepted: kalmanUpdateResult.accepted,
      bleResidual: kalmanUpdateResult.residual,
      kalmanGain: kalmanUpdateResult.kGain,
      stepCount: stepCountRef.current,
      stepLength: stepLengthRef.current,
      heading: curHeading,
      cardinal,
      isStationary,
      positioningMode: mode,
      groundTruth: gt,
      gtErrorFt,
      bleErrorFt,
      pdrErrorFt,
      fusedErrorFt,
      accuracyScore,
      benchmarkStats: statsRef.current,
      trajectoryCount: trajectoryRef.current.length,
      b1Available: s1.filteredRssi !== null && age1 < 3000,
      b2Available: s2.filteredRssi !== null && age2 < 3000,
    };
  } catch (err) {
    console.warn("[_runPositionCalculation error]:", err);
  }
}

  // ─── STATE MACHINE HELPER ──────────────────────────────────────────────────
  function _setModuleState(newState) {
    modulStateRef.current = newState;
    setModuleState(newState);
  }

  // ─── ACTIONS ───────────────────────────────────────────────────────────────
  const actions = {
    startScan,
    stopScan,

    startPositioning: () => {
      try {
        if (modulStateRef.current === "POSITIONING") return;
        // If we already have a previous BLE fix, use it. Otherwise, mark awaiting lock.
        const prevBle = prevBle1Ref.current;
        const roomW = typeof configRef.current?.roomWidthFt === "number" && isFinite(configRef.current.roomWidthFt) && configRef.current.roomWidthFt > 0 ? configRef.current.roomWidthFt : ROOM_WIDTH_FT;
        const roomH = typeof configRef.current?.roomHeightFt === "number" && isFinite(configRef.current.roomHeightFt) && configRef.current.roomHeightFt > 0 ? configRef.current.roomHeightFt : ROOM_HEIGHT_FT;
        const b1X = typeof configRef.current?.beacon1X === "number" && isFinite(configRef.current.beacon1X) ? configRef.current.beacon1X : 0;
        const b2X = typeof configRef.current?.beacon2X === "number" && isFinite(configRef.current.beacon2X) ? configRef.current.beacon2X : roomW;
        const b1Y = typeof configRef.current?.beacon1Y === "number" && isFinite(configRef.current.beacon1Y) ? configRef.current.beacon1Y : roomH;
        const b2Y = typeof configRef.current?.beacon2Y === "number" && isFinite(configRef.current.beacon2Y) ? configRef.current.beacon2Y : roomH;

        let initX = prevBle?.x;
        let initY = prevBle?.y;
        if (typeof initX !== "number" || !isFinite(initX)) {
          initX = (b1X + b2X) / 2;
        }
        if (typeof initY !== "number" || !isFinite(initY)) {
          initY = (b1Y + b2Y) / 2;
        }
        initX = Math.max(0, Math.min(roomW, initX));
        initY = Math.max(0, Math.min(roomH, initY));

        kalmanRef.current.setRoomDimensions(roomW, roomH);
        kalmanRef.current.reset(initX, initY);
        pdrPosRef.current     = { x: initX, y: initY };
        prevFusedRef.current  = { x: initX, y: initY };
        displayPosRef.current = { x: initX, y: initY };
        trailRef.current      = [{ x: initX, y: initY }];
        lastCalcTime.current  = Date.now();
        lastStepTimeRef.current = Date.now();
        isAwaitingInitialBleLockRef.current = !prevBle;

        // Reset benchmark & trajectory
        trajectoryRef.current = [];
        errorSamplesRef.current = [];
        statsRef.current = { count: 0, mae: 0, rmse: 0, max: 0 };
        setStats(statsRef.current);

        positionRef.current = {
          bleX: initX, bleY: initY,
          pdrX: initX, pdrY: initY,
          fusedX: initX, fusedY: initY,
          activeX: initX, activeY: initY,
          confidence: 0.5,
          bleAccepted: true,
          bleResidual: 0,
          stepCount: stepCountRef.current,
          stepLength: stepLengthRef.current,
          heading: headingRef.current,
          cardinal: getCardinalDirection(headingRef.current),
        };
        setPositionState({ ...positionRef.current, timestamp: Date.now() });
        setTrail([{ x: initX, y: initY }]);

        if (!isScanningRef.current) startScan();
        _startCalcLoop();
        _setModuleState("POSITIONING");
      } catch (err) {
        console.warn("[startPositioning error]:", err);
      }
    },

    pausePositioning: () => {
      _stopCalcLoop();
      _setModuleState("PAUSED");
    },

    resumePositioning: () => {
      _startCalcLoop();
      _setModuleState("POSITIONING");
    },

    stopPositioning: () => {
      _stopCalcLoop();
      stopScan();
      _setModuleState("STOPPED");
    },

    resetPosition: (customX = null, customY = null) => {
      try {
        // Re-anchor to latest reliable BLE position if available
        const prevBle = prevBle1Ref.current;
        const roomW = typeof configRef.current?.roomWidthFt === "number" && isFinite(configRef.current.roomWidthFt) && configRef.current.roomWidthFt > 0 ? configRef.current.roomWidthFt : ROOM_WIDTH_FT;
        const roomH = typeof configRef.current?.roomHeightFt === "number" && isFinite(configRef.current.roomHeightFt) && configRef.current.roomHeightFt > 0 ? configRef.current.roomHeightFt : ROOM_HEIGHT_FT;
        const b1X = typeof configRef.current?.beacon1X === "number" && isFinite(configRef.current.beacon1X) ? configRef.current.beacon1X : 0;
        const b2X = typeof configRef.current?.beacon2X === "number" && isFinite(configRef.current.beacon2X) ? configRef.current.beacon2X : roomW;
        const b1Y = typeof configRef.current?.beacon1Y === "number" && isFinite(configRef.current.beacon1Y) ? configRef.current.beacon1Y : roomH;
        const b2Y = typeof configRef.current?.beacon2Y === "number" && isFinite(configRef.current.beacon2Y) ? configRef.current.beacon2Y : roomH;

        let rx = (typeof customX === "number" && isFinite(customX)) ? customX : (prevBle?.x ?? ((b1X + b2X) / 2));
        let ry = (typeof customY === "number" && isFinite(customY)) ? customY : (prevBle?.y ?? ((b1Y + b2Y) / 2));
        if (typeof rx !== "number" || !isFinite(rx)) rx = roomW / 2;
        if (typeof ry !== "number" || !isFinite(ry)) ry = roomH / 2;
        rx = Math.max(0, Math.min(roomW, rx));
        ry = Math.max(0, Math.min(roomH, ry));

        kalmanRef.current.setRoomDimensions(roomW, roomH);
        kalmanRef.current.reset(rx, ry);
        pdrPosRef.current     = { x: rx, y: ry };
        prevFusedRef.current  = { x: rx, y: ry };
        displayPosRef.current = { x: rx, y: ry };
        trailRef.current      = [{ x: rx, y: ry }];
        errorSamplesRef.current = [];
        statsRef.current = { count: 0, mae: 0, rmse: 0, max: 0 };
        setStats(statsRef.current);

        positionRef.current   = {
          bleX: rx, bleY: ry,
          pdrX: rx, pdrY: ry,
          fusedX: rx, fusedY: ry,
          activeX: rx, activeY: ry,
          confidence: 0,
          bleAccepted: true,
          bleResidual: 0,
          stepCount: stepCountRef.current,
          stepLength: stepLengthRef.current,
          heading: headingRef.current,
          cardinal: getCardinalDirection(headingRef.current),
        };
        setPositionState({ ...positionRef.current, timestamp: Date.now() });
        setTrail([{ x: rx, y: ry }]);
      } catch (err) {
        console.warn("[resetPosition error]:", err);
      }
    },

    resetStepCounter: () => {
      stepCountRef.current = 0;
    },

    setPositioningMode: (m) => {
      setPositioningMode(m);
    },

    setGroundTruth: (pt) => {
      try {
        errorSamplesRef.current = [];
        statsRef.current = { count: 0, mae: 0, rmse: 0, max: 0 };
        setStats(statsRef.current);
        setGroundTruth(pt);
      } catch (err) {
        console.warn("[setGroundTruth error]:", err);
      }
    },

    addManualStep: (stepFt = 2.3, headingDeg = 0) => {
      try {
        lastStepTimeRef.current = Date.now();
        stepCountRef.current++;
        const safeFt = (typeof stepFt === "number" && isFinite(stepFt)) ? stepFt : 2.3;
        const safeDeg = (typeof headingDeg === "number" && isFinite(headingDeg)) ? headingDeg : (headingRef.current || 0);
        const rad = (safeDeg * Math.PI) / 180;
        const dx = safeFt * Math.sin(rad);
        const dy = safeFt * Math.cos(rad);
        const old = pdrPosRef.current || { x: 9, y: 7.5 };
        pdrPosRef.current = clampToRoom(old.x + dx, old.y + dy);
        kalmanRef.current.predict(dx, dy, 0.40);
        const fused = kalmanRef.current.getPosition();
        displayPosRef.current = { x: fused.x, y: fused.y };

        const mode = positioningModeRef.current;
        let actX = fused.x;
        let actY = fused.y;
        if (mode === "pdr") {
          actX = pdrPosRef.current.x;
          actY = pdrPosRef.current.y;
        } else if (mode === "ble") {
          actX = positionRef.current?.bleX ?? fused.x;
          actY = positionRef.current?.bleY ?? fused.y;
        } else if (mode === "complementary") {
          const wBle = Math.max(0.15, Math.min(0.85, positionRef.current?.confidence ?? 0.5));
          const bx = positionRef.current?.bleX ?? fused.x;
          const by = positionRef.current?.bleY ?? fused.y;
          actX = Number((wBle * bx + (1 - wBle) * pdrPosRef.current.x).toFixed(2));
          actY = Number((wBle * by + (1 - wBle) * pdrPosRef.current.y).toFixed(2));
        }

        trailRef.current.push({ x: actX, y: actY });
        if (trailRef.current.length > MAX_TRAIL_POINTS) trailRef.current.shift();

        positionRef.current = {
          ...positionRef.current,
          pdrX: pdrPosRef.current.x,
          pdrY: pdrPosRef.current.y,
          fusedX: fused.x,
          fusedY: fused.y,
          activeX: actX,
          activeY: actY,
          stepCount: stepCountRef.current,
        };
        setPositionState({ ...positionRef.current, timestamp: Date.now() });
        setTrail([...trailRef.current]);
      } catch (err) {
        console.warn("[addManualStep error]:", err);
      }
    },

    exportTrajectoryCsv: async () => {
      const pts = trajectoryRef.current;
      if (!pts || pts.length === 0) {
        Alert.alert("No Trajectory Data", "Walk or run positioning first to record trajectory points.");
        return;
      }
      const csv = exportTrajectoryAsCsv(pts);
      try {
        await Share.share({
          message: csv,
          title: "Indoor_Positioning_Trajectory.csv",
        });
      } catch (err) {
        Alert.alert("Export Failed", String(err?.message || err));
      }
    },

    exportTrajectoryJson: async () => {
      const pts = trajectoryRef.current;
      if (!pts || pts.length === 0) {
        Alert.alert("No Trajectory Data", "Walk or run positioning first to record trajectory points.");
        return;
      }
      const json = exportTrajectoryAsJson(pts);
      try {
        await Share.share({
          message: json,
          title: "Indoor_Positioning_Trajectory.json",
        });
      } catch (err) {
        Alert.alert("Export Failed", String(err?.message || err));
      }
    },

    clearTrail: () => {
      trailRef.current = [];
      setTrail([]);
    },

    clearTrajectoryHistory: () => {
      trajectoryRef.current = [];
      errorSamplesRef.current = [];
      statsRef.current = { count: 0, mae: 0, rmse: 0, max: 0 };
      setStats(statsRef.current);
    },

    resetPipelines: () => {
      pipeline1Ref.current.reset();
      pipeline2Ref.current.reset();
    },

    getCalibrationPipeline: (beaconNum) => {
      return beaconNum === 1 ? pipeline1Ref.current : pipeline2Ref.current;
    },

    advanceToBeaconsSelected: () => _setModuleState("BEACONS_SELECTED"),
    advanceToPlacement:       () => _setModuleState("PLACEMENT_CONFIGURED"),
    advanceToCalibrated:      () => _setModuleState("CALIBRATED"),
  };

  // ─── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopScan();
      _stopCalcLoop();
      if (uiIntervalRef.current) clearInterval(uiIntervalRef.current);
    };
  }, []);

  return {
    // State
    isScanning,
    bluetoothStatus,
    devices,          // all scanned devices for display
    moduleState,
    positionState,
    trail,
    debugInfo,
    positioningMode,
    groundTruth,
    actions,
  };
}

