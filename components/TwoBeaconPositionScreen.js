// ============================================================================
// TwoBeaconPositionScreen — Main 2-Beacon Indoor Positioning Module
//
// This screen is completely isolated from existing PDR and BLE scanner tabs.
// It orchestrates 4 stages: Select → Place → Calibrate → Position Test
// ============================================================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  Alert,
  Switch,
  ActivityIndicator,
  Modal,
} from "react-native";

import { useTwoBeaconPositioning } from "../hooks/useTwoBeaconPositioning.js";
import {
  loadBeaconConfig,
  saveBeaconConfig,
  resetBeaconConfig,
  DEFAULT_CONFIG,
} from "../services/beaconConfigStorage.js";
import TestAreaMap      from "./TestAreaMap.js";
import CalibrationPanel from "./CalibrationPanel.js";
import BeaconDebugPanel from "./BeaconDebugPanel.js";

// Stages shown as step indicators
const STAGES = [
  { id: "select",    label: "1. Select\nBeacons" },
  { id: "place",     label: "2. Place\nBeacons"  },
  { id: "calibrate", label: "3. Calibrate"        },
  { id: "position",  label: "4. Position\nTest"   },
];

class TwoBeaconErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.warn("[TwoBeaconErrorBoundary error caught]:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ padding: 16, backgroundColor: "#fff0f0", borderRadius: 12, borderWidth: 1, borderColor: "#ffc9c9", margin: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: "bold", color: "#cf222e", marginBottom: 6 }}>
            ⚠️ Positioning Screen Recovered
          </Text>
          <Text style={{ fontSize: 13, color: "#57606a", marginBottom: 12, lineHeight: 18 }}>
            A render error was safely prevented from closing your app. Tap below to resume testing cleanly.
          </Text>
          <Pressable
            style={{ backgroundColor: "#1f6feb", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: "center" }}
            onPress={() => {
              this.setState({ hasError: false, error: null });
              this.props.onReset?.();
            }}
          >
            <Text style={{ color: "#ffffff", fontWeight: "700", fontSize: 13 }}>↺ Resume Positioning</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function TwoBeaconPositionScreen({ pdrStepCallbackRef, heading = 0 }) {
  // ─── Config state (persisted) ─────────────────────────────────────────────
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [configLoaded, setConfigLoaded] = useState(false);

  // ─── Current UI stage ─────────────────────────────────────────────────────
  const [activeStage, setActiveStage] = useState("select");

  // ─── Drag state to lock scroll during beacon placement ────────────────────
  const [isDraggingMap, setIsDraggingMap] = useState(false);

  // ─── Debug overlays (BLE, PDR, Fused markers) ───────────────────────────
  const [showOverlays, setShowOverlays] = useState(true);

  // ─── Area Size Modal state ────────────────────────────────────────────────
  const [showAreaModal, setShowAreaModal] = useState(false);
  const [areaModalMode, setAreaModalMode] = useState("startTest"); // "startTest" | "editOnly"

  const roomW = (typeof config.roomWidthFt === "number" && isFinite(config.roomWidthFt) && config.roomWidthFt > 0) ? config.roomWidthFt : 18;
  const roomH = (typeof config.roomHeightFt === "number" && isFinite(config.roomHeightFt) && config.roomHeightFt > 0) ? config.roomHeightFt : 15;

  // ─── Hook ─────────────────────────────────────────────────────────────────
  const {
    isScanning,
    bluetoothStatus,
    devices,
    moduleState,
    positionState,
    trail,
    debugInfo,
    positioningMode,
    groundTruth,
    actions,
  } = useTwoBeaconPositioning({ config, pdrStepCallbackRef, heading });

  // ─── Load config on mount ─────────────────────────────────────────────────
  useEffect(() => {
    loadBeaconConfig().then(cfg => {
      setConfig(cfg);
      setConfigLoaded(true);
      // If beacons were already selected, jump to place stage
      if (cfg.beacon1Id && cfg.beacon2Id) setActiveStage("place");
    });
  }, []);

  // ─── Auto-start scan when screen opens (continues across all stages) ────────
  useEffect(() => {
    if (!configLoaded) return;
    // Start scanning silently in the background — keeps RSSI flowing on all stages
    actions.startScan();
  }, [configLoaded]);


  // ─── Config update helper ─────────────────────────────────────────────────
  // When persist=false (during active pan gesture), update state only without async storage blocking
  const updateConfig = useCallback(async (updates, persist = true) => {
    setConfig(prev => {
      const next = { ...prev, ...updates };
      if (persist) {
        saveBeaconConfig(updates);
      }
      return next;
    });
  }, []);

  // ─── Area Size Modal Handlers ─────────────────────────────────────────────
  function handleOpenAreaModal(mode = "startTest") {
    setAreaModalMode(mode);
    setShowAreaModal(true);
  }

  function handleSaveAreaDimensions({ width, height, askEveryTime, autoStart }) {
    const newW = Math.max(4, Math.min(150, width));
    const newH = Math.max(4, Math.min(150, height));

    // Clamp beacon placements if they were placed outside the new room
    const clampedB1X = Math.min(newW, config.beacon1X ?? 0);
    const clampedB1Y = Math.min(newH, config.beacon1Y ?? newH);
    const clampedB2X = Math.min(newW, config.beacon2X ?? newW);
    const clampedB2Y = Math.min(newH, config.beacon2Y ?? newH);

    updateConfig({
      roomWidthFt: newW,
      roomHeightFt: newH,
      askAreaBeforeTest: askEveryTime,
      beacon1X: clampedB1X,
      beacon1Y: clampedB1Y,
      beacon2X: clampedB2X,
      beacon2Y: clampedB2Y,
    }, true);

    setShowAreaModal(false);

    if (autoStart) {
      setTimeout(() => {
        actions.startPositioning?.();
      }, 150);
    }
  }

  function handlePressStartTest() {
    if (config.askAreaBeforeTest !== false) {
      handleOpenAreaModal("startTest");
    } else {
      actions.startPositioning?.();
    }
  }

  // ─── Device list helpers ──────────────────────────────────────────────────
  const sortedDevices = Object.values(devices).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));

  function assignBeacon(beaconNum, device) {
    if (beaconNum === 1) {
      if (config.beacon2Id === device.id) {
        Alert.alert("Already Selected", "This device is already assigned as Beacon 2.");
        return;
      }
      updateConfig({ beacon1Id: device.id, beacon1Name: device.name });
    } else {
      if (config.beacon1Id === device.id) {
        Alert.alert("Already Selected", "This device is already assigned as Beacon 1.");
        return;
      }
      updateConfig({ beacon2Id: device.id, beacon2Name: device.name });
    }
  }

  const canAdvanceToPlace     = !!(config.beacon1Id && config.beacon2Id);
  const canAdvanceToCalibrate = canAdvanceToPlace;
  const canStartTest          = canAdvanceToCalibrate;

  // ─── Reset handler ────────────────────────────────────────────────────────
  async function handleReset() {
    Alert.alert("Reset Configuration", "Clear all beacon settings and start over?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reset",
        style: "destructive",
        onPress: async () => {
          actions.stopPositioning?.();
          const fresh = await resetBeaconConfig();
          setConfig(fresh);
          setActiveStage("select");
          actions.resetPipelines?.();
          actions.resetPosition?.();
        },
      },
    ]);
  }

  if (!configLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#1f6feb" />
        <Text style={styles.loadingText}>Loading configuration…</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} scrollEnabled={!isDraggingMap}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>2-Beacon Position Test</Text>
          <Text style={styles.sub}>BLE ranging + PDR + Adaptive Kalman • {roomW} × {roomH} ft room</Text>
        </View>
        <Pressable style={styles.resetBtn} onPress={handleReset}>
          <Text style={styles.resetBtnText}>Reset</Text>
        </Pressable>
      </View>

      {/* ── Stage Indicator ── */}
      <StageIndicator stages={STAGES} active={activeStage} onPress={setActiveStage} />

      {/* ══════════════════════════════════════════════════
          STAGE 1 — SELECT BEACONS
      ══════════════════════════════════════════════════ */}
      {activeStage === "select" && (
        <SelectBeaconsStage
          config={config}
          isScanning={isScanning}
          bluetoothStatus={bluetoothStatus}
          sortedDevices={sortedDevices}
          onStartScan={actions.startScan}
          onStopScan={actions.stopScan}
          onAssignBeacon={assignBeacon}
          onClearBeacon={(n) => updateConfig(n === 1
            ? { beacon1Id: null, beacon1Name: "" }
            : { beacon2Id: null, beacon2Name: "" })}
          onClearAll={() => updateConfig({ beacon1Id: null, beacon1Name: "", beacon2Id: null, beacon2Name: "" })}
          canAdvance={canAdvanceToPlace}
          onAdvance={() => setActiveStage("place")}
        />
      )}

      {/* ══════════════════════════════════════════════════
          STAGE 2 — PLACE BEACONS
      ══════════════════════════════════════════════════ */}
      {activeStage === "place" && (
        <PlaceBeaconsStage
          config={config}
          onBeacon1Move={(x, y) => updateConfig({ beacon1X: x, beacon1Y: y }, false)}
          onBeacon1Commit={(x, y) => updateConfig({ beacon1X: x, beacon1Y: y }, true)}
          onBeacon2Move={(x, y) => updateConfig({ beacon2X: x, beacon2Y: y }, false)}
          onBeacon2Commit={(x, y) => updateConfig({ beacon2X: x, beacon2Y: y }, true)}
          onApplyPreset={(p) => updateConfig(p, true)}
          onDragStateChange={setIsDraggingMap}
          onResetLayout={() => updateConfig({ beacon1X: 0, beacon1Y: roomH, beacon2X: roomW, beacon2Y: roomH }, true)}
          onOpenAreaModal={() => handleOpenAreaModal("editOnly")}
          heightCorrectionOn={config.heightCorrectionOn}
          onToggleHeight={(v) => updateConfig({ heightCorrectionOn: v }, true)}
          onUpdateHeight={(key, v) => updateConfig({ [key]: parseFloat(v) || 0 }, true)}
          onAdvance={() => setActiveStage("calibrate")}
        />
      )}

      {/* ══════════════════════════════════════════════════
          STAGE 3 — CALIBRATE
      ══════════════════════════════════════════════════ */}
      {activeStage === "calibrate" && (
        <CalibrateStage
          config={config}
          actions={actions}
          isScanning={isScanning}
          onSaveB1TxPower={(v) => updateConfig({ beacon1TxPower: v }, true)}
          onSaveB2TxPower={(v) => updateConfig({ beacon2TxPower: v }, true)}
          onSavePathLossN={(v) => updateConfig({ pathLossN: v }, true)}
          onAdvance={() => setActiveStage("position")}
        />
      )}


      {/* ══════════════════════════════════════════════════
          STAGE 4 — POSITION TEST
      ══════════════════════════════════════════════════ */}
      {activeStage === "position" && (
        <TwoBeaconErrorBoundary onReset={() => actions.resetPosition?.()}>
          <PositionTestStage
            config={config}
            moduleState={moduleState}
            positionState={positionState}
            trail={trail}
            heading={heading}
            debugInfo={debugInfo}
            showOverlays={showOverlays}
            onToggleOverlays={() => setShowOverlays(v => !v)}
            actions={actions}
            onGoToPlace={() => setActiveStage("place")}
            onOpenAreaModal={() => handleOpenAreaModal("editOnly")}
            onPressStart={handlePressStartTest}
          />
        </TwoBeaconErrorBoundary>
      )}

      {/* ── Pre-Test / Edit Area Size Modal ── */}
      <AreaSizeModal
        visible={showAreaModal}
        mode={areaModalMode}
        currentWidth={roomW}
        currentHeight={roomH}
        askBeforeTest={config.askAreaBeforeTest !== false}
        onSave={handleSaveAreaDimensions}
        onClose={() => setShowAreaModal(false)}
      />
    </ScrollView>
  );
}

// ============================================================================
// Stage Indicator
// ============================================================================
function StageIndicator({ stages, active, onPress }) {
  const activeIdx = stages.findIndex(s => s.id === active);
  return (
    <View style={styles.stageRow}>
      {stages.map((stage, idx) => {
        const isActive  = stage.id === active;
        const isDone    = idx < activeIdx;
        return (
          <Pressable key={stage.id} style={styles.stageItem} onPress={() => onPress(stage.id)}>
            <View style={[
              styles.stageCircle,
              isActive && styles.stageCircleActive,
              isDone   && styles.stageCircleDone,
            ]}>
              <Text style={[styles.stageNum, (isActive || isDone) && { color: "#fff" }]}>
                {isDone ? "✓" : String(idx + 1)}
              </Text>
            </View>
            <Text style={[
              styles.stageLabel,
              isActive && { color: "#1f6feb", fontWeight: "700" },
              isDone   && { color: "#1a7f37" },
            ]}>{stage.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ============================================================================
// Stage 1 — Select Beacons
// ============================================================================
function SelectBeaconsStage({
  config, isScanning, bluetoothStatus, sortedDevices,
  onStartScan, onStopScan, onAssignBeacon, onClearBeacon, onClearAll,
  canAdvance, onAdvance,
}) {
  return (
    <>
      {/* Selected beacons summary */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Selected Beacons</Text>
        <SelectedBeaconRow
          num={1}
          id={config.beacon1Id}
          name={config.beacon1Name}
          onClear={() => onClearBeacon(1)}
          color="#0369a1"
        />
        <SelectedBeaconRow
          num={2}
          id={config.beacon2Id}
          name={config.beacon2Name}
          onClear={() => onClearBeacon(2)}
          color="#6d28d9"
        />
        {(config.beacon1Id || config.beacon2Id) && (
          <Pressable style={styles.clearAllBtn} onPress={onClearAll}>
            <Text style={styles.clearAllText}>Clear All Selections</Text>
          </Pressable>
        )}
      </View>

      {/* Scan controls */}
      <View style={styles.card}>
        <View style={styles.scanHeader}>
          <View>
            <Text style={styles.cardTitle}>BLE Scanner</Text>
            <Text style={styles.btStatus}>BT: {bluetoothStatus} • {sortedDevices.length} devices</Text>
          </View>
          <Pressable
            style={[styles.scanBtn, isScanning && styles.scanBtnStop]}
            onPress={isScanning ? onStopScan : onStartScan}
          >
            {isScanning
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.scanBtnText}>Scan</Text>}
            <Text style={[styles.scanBtnText, { marginLeft: 4 }]}>
              {isScanning ? " Scanning…" : " Devices"}
            </Text>
          </Pressable>
        </View>

        {sortedDevices.length === 0 ? (
          <Text style={styles.emptyText}>
            {isScanning ? "🔍 Scanning for devices…" : "No devices found. Tap Refresh to scan."}
          </Text>
        ) : (
          sortedDevices.map(device => (
            <DeviceCard
              key={device.id}
              device={device}
              isBeacon1={config.beacon1Id === device.id}
              isBeacon2={config.beacon2Id === device.id}
              onSetBeacon1={() => onAssignBeacon(1, device)}
              onSetBeacon2={() => onAssignBeacon(2, device)}
            />
          ))
        )}
      </View>

      {canAdvance && (
        <Pressable style={styles.advanceBtn} onPress={onAdvance}>
          <Text style={styles.advanceBtnText}>Next: Place Beacons →</Text>
        </Pressable>
      )}
    </>
  );
}

function SelectedBeaconRow({ num, id, name, onClear, color }) {
  return (
    <View style={[styles.selRow, { borderColor: color + "44" }]}>
      <View style={[styles.selBadge, { backgroundColor: color + "18" }]}>
        <Text style={[styles.selBadgeText, { color }]}>B{num}</Text>
      </View>
      <View style={{ flex: 1 }}>
        {id ? (
          <>
            <Text style={styles.selName}>{name || "Unknown"}</Text>
            <Text style={styles.selId} numberOfLines={1}>{id}</Text>
          </>
        ) : (
          <Text style={styles.selEmpty}>Not selected</Text>
        )}
      </View>
      {id && (
        <Pressable onPress={onClear} style={styles.selClearBtn}>
          <Text style={styles.selClearText}>Change</Text>
        </Pressable>
      )}
    </View>
  );
}

function DeviceCard({ device, isBeacon1, isBeacon2, onSetBeacon1, onSetBeacon2 }) {
  const rssi     = device.rssi ?? 0;
  const ageSec   = device.ageMsAgo ? (device.ageMsAgo / 1000).toFixed(1) : "?";
  const qual     = rssi > -60 ? "#1a7f37" : rssi > -75 ? "#0969da" : rssi > -85 ? "#d29922" : "#cf222e";
  const selected = isBeacon1 || isBeacon2;

  return (
    <View style={[styles.deviceCard, selected && styles.deviceCardSelected]}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={styles.deviceName}>{device.name}</Text>
          {device.beaconInfo?.isBeacon && <Tag label={device.beaconInfo.beaconType || "iBeacon"} color="#1a7f37" />}
          {isBeacon1 && <Tag label="B1" color="#0369a1" />}
          {isBeacon2 && <Tag label="B2" color="#6d28d9" />}
        </View>
        <Text style={styles.deviceId} numberOfLines={1}>MAC: {device.id}</Text>
        {device.beaconInfo?.uuid && (
          <Text style={{ fontSize: 11, color: "#0969da", fontWeight: "600", marginTop: 1 }} numberOfLines={1}>
            UUID: {device.beaconInfo.uuid}
          </Text>
        )}
        {device.beaconInfo?.major !== null && device.beaconInfo?.major !== undefined && (
          <Text style={{ fontSize: 11, color: "#57606a", marginTop: 1 }}>
            Major: {device.beaconInfo.major} | Minor: {device.beaconInfo.minor} | Calibrated: {device.beaconInfo.calibratedTxPower} dBm
          </Text>
        )}
        <View style={{ flexDirection: "row", gap: 10, marginTop: 2 }}>
          <Text style={[styles.deviceRssi, { color: qual }]}>{rssi} dBm</Text>
          <Text style={styles.deviceAge}>{ageSec}s ago</Text>
        </View>
      </View>
      {!isBeacon1 && (
        <Pressable style={[styles.assignBtn, { borderColor: "#0369a1" }]} onPress={onSetBeacon1}>
          <Text style={[styles.assignBtnText, { color: "#0369a1" }]}>Set B1</Text>
        </Pressable>
      )}
      {!isBeacon2 && (
        <Pressable style={[styles.assignBtn, { borderColor: "#6d28d9" }]} onPress={onSetBeacon2}>
          <Text style={[styles.assignBtnText, { color: "#6d28d9" }]}>Set B2</Text>
        </Pressable>
      )}
    </View>
  );
}

function Tag({ label, color }) {
  return (
    <View style={[styles.tag, { backgroundColor: color + "18", borderColor: color + "66" }]}>
      <Text style={[styles.tagText, { color }]}>{label}</Text>
    </View>
  );
}

// ============================================================================
// ============================================================================
// Stage 2 — Place Beacons
// ============================================================================
function PlaceBeaconsStage({
  config,
  onBeacon1Move,
  onBeacon1Commit,
  onBeacon2Move,
  onBeacon2Commit,
  onApplyPreset,
  onDragStateChange,
  onResetLayout,
  onOpenAreaModal,
  heightCorrectionOn,
  onToggleHeight,
  onUpdateHeight,
  onAdvance,
}) {
  const roomW = (typeof config.roomWidthFt === "number" && isFinite(config.roomWidthFt) && config.roomWidthFt > 0) ? config.roomWidthFt : 18;
  const roomH = (typeof config.roomHeightFt === "number" && isFinite(config.roomHeightFt) && config.roomHeightFt > 0) ? config.roomHeightFt : 15;

  return (
    <>
      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Beacon Placement</Text>
          <Pressable style={styles.resetLayoutBtn} onPress={onResetLayout}>
            <Text style={styles.resetLayoutText}>Reset</Text>
          </Pressable>
        </View>
        <Text style={styles.cardSub}>
          Drag B1 and B2 directly on the map, use Room Presets, or nudge with +/- steppers below.
        </Text>

        {/* Room Area Size Card */}
        <View style={styles.areaConfigCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.areaConfigTitle}>
              📐 Room Dimensions: {roomW} × {roomH} ft
            </Text>
            <Text style={styles.areaConfigSub}>
              {((roomW * 0.3048)).toFixed(1)} × {((roomH * 0.3048)).toFixed(1)} m • {(roomW * roomH).toFixed(0)} sq ft
            </Text>
          </View>
          <Pressable style={styles.changeAreaBtn} onPress={onOpenAreaModal}>
            <Text style={styles.changeAreaBtnText}>Change Size</Text>
          </Pressable>
        </View>

        {/* Room Presets */}
        <Text style={[styles.cardTitle, { fontSize: 12, marginTop: 4, marginBottom: 6 }]}>
          Room Layout Presets
        </Text>
        <View style={styles.presetRow}>
          <PresetChip
            label="Top Wall (Standard)"
            sub={`B1: (0, ${roomH})  •  B2: (${roomW}, ${roomH})`}
            active={config.beacon1X === 0 && config.beacon1Y === roomH && config.beacon2X === roomW && config.beacon2Y === roomH}
            onPress={() => onApplyPreset?.({ beacon1X: 0, beacon1Y: roomH, beacon2X: roomW, beacon2Y: roomH })}
          />
          <PresetChip
            label="Diagonal Corners"
            sub={`B1: (0, 0)  •  B2: (${roomW}, ${roomH})`}
            active={config.beacon1X === 0 && config.beacon1Y === 0 && config.beacon2X === roomW && config.beacon2Y === roomH}
            onPress={() => onApplyPreset?.({ beacon1X: 0, beacon1Y: 0, beacon2X: roomW, beacon2Y: roomH })}
          />
          <PresetChip
            label="Side Wall Centers"
            sub={`B1: (0, ${(roomH / 2).toFixed(1)})  •  B2: (${roomW}, ${(roomH / 2).toFixed(1)})`}
            active={config.beacon1X === 0 && Math.abs(config.beacon1Y - roomH / 2) < 0.2 && config.beacon2X === roomW && Math.abs(config.beacon2Y - roomH / 2) < 0.2}
            onPress={() => onApplyPreset?.({ beacon1X: 0, beacon1Y: Number((roomH / 2).toFixed(2)), beacon2X: roomW, beacon2Y: Number((roomH / 2).toFixed(2)) })}
          />
          <PresetChip
            label="Front Wall"
            sub={`B1: (0, 0)  •  B2: (${roomW}, 0)`}
            active={config.beacon1X === 0 && config.beacon1Y === 0 && config.beacon2X === roomW && config.beacon2Y === 0}
            onPress={() => onApplyPreset?.({ beacon1X: 0, beacon1Y: 0, beacon2X: roomW, beacon2Y: 0 })}
          />
        </View>
      </View>

      <TestAreaMap
        beacon1={{ x: config.beacon1X, y: config.beacon1Y }}
        beacon2={{ x: config.beacon2X, y: config.beacon2Y }}
        userPosition={{ fusedX: roomW / 2, fusedY: roomH / 2 }}
        roomWidthFt={roomW}
        roomHeightFt={roomH}
        isSetupMode={true}
        showDebugOverlays={false}
        onBeacon1Move={onBeacon1Move}
        onBeacon1Commit={onBeacon1Commit}
        onBeacon2Move={onBeacon2Move}
        onBeacon2Commit={onBeacon2Commit}
        onDragStateChange={onDragStateChange}
      />

      {/* Coordinate Steppers for Sub-Inch Fine Tuning */}
      <View style={styles.coordCard}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <Text style={[styles.cardTitle, { color: "#0369a1", marginBottom: 0 }]}>Beacon 1 (B1)</Text>
          <Text style={styles.coordHeaderSub}>
            X: {config.beacon1X.toFixed(2)} ft  •  Y: {config.beacon1Y.toFixed(2)} ft
          </Text>
        </View>
        <CoordStepper
          axis="X"
          value={config.beacon1X}
          max={roomW}
          color="#0369a1"
          onChange={(v) => onBeacon1Commit(v, config.beacon1Y)}
        />
        <CoordStepper
          axis="Y"
          value={config.beacon1Y}
          max={roomH}
          color="#0369a1"
          onChange={(v) => onBeacon1Commit(config.beacon1X, v)}
        />

        <View style={{ height: 1, backgroundColor: "#e2e8f0", marginVertical: 10 }} />

        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <Text style={[styles.cardTitle, { color: "#6d28d9", marginBottom: 0 }]}>Beacon 2 (B2)</Text>
          <Text style={styles.coordHeaderSub}>
            X: {config.beacon2X.toFixed(2)} ft  •  Y: {config.beacon2Y.toFixed(2)} ft
          </Text>
        </View>
        <CoordStepper
          axis="X"
          value={config.beacon2X}
          max={roomW}
          color="#6d28d9"
          onChange={(v) => onBeacon2Commit(v, config.beacon2Y)}
        />
        <CoordStepper
          axis="Y"
          value={config.beacon2Y}
          max={roomH}
          color="#6d28d9"
          onChange={(v) => onBeacon2Commit(config.beacon2X, v)}
        />
      </View>

      {/* Height correction */}
      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>Height Correction</Text>
          <Switch
            value={heightCorrectionOn}
            onValueChange={onToggleHeight}
            trackColor={{ false: "#d0d7de", true: "#54aeff" }}
            thumbColor="#fff"
          />
        </View>
        {heightCorrectionOn && (
          <>
            <Text style={styles.cardSub}>For ceiling or wall-mounted beacons.</Text>
            <HeightInput label="Beacon 1 Height (ft)" value={config.beacon1HeightFt}
              onChange={v => onUpdateHeight("beacon1HeightFt", v)} />
            <HeightInput label="Beacon 2 Height (ft)" value={config.beacon2HeightFt}
              onChange={v => onUpdateHeight("beacon2HeightFt", v)} />
            <HeightInput label="Phone Height (ft)"   value={config.phoneHeightFt}
              onChange={v => onUpdateHeight("phoneHeightFt", v)} />
          </>
        )}
      </View>

      <Pressable style={styles.advanceBtn} onPress={onAdvance}>
        <Text style={styles.advanceBtnText}>Next: Calibrate →</Text>
      </Pressable>
    </>
  );
}

function PresetChip({ label, sub, active, onPress }) {
  return (
    <Pressable
      style={[styles.presetChip, active && styles.presetChipActive]}
      onPress={onPress}
    >
      <Text style={[styles.presetChipText, active && styles.presetChipTextActive]}>{label}</Text>
      <Text style={[styles.presetChipSub, active && styles.presetChipSubActive]}>{sub}</Text>
    </Pressable>
  );
}

function CoordStepper({ axis, value, max, color, onChange }) {
  const numVal = Number(value.toFixed(2));
  return (
    <View style={styles.stepperRow}>
      <Text style={[styles.stepperAxis, { color }]}>{axis}:</Text>
      <Pressable
        style={styles.stepperBtn}
        onPress={() => onChange(Math.max(0, Number((numVal - 0.5).toFixed(2))))}
      >
        <Text style={styles.stepperBtnText}>−</Text>
      </Pressable>
      <TextInput
        style={styles.stepperInput}
        value={String(numVal)}
        keyboardType="numeric"
        returnKeyType="done"
        onSubmitEditing={(e) => {
          const parsed = parseFloat(e.nativeEvent.text);
          if (isFinite(parsed)) onChange(Math.max(0, Math.min(max, parsed)));
        }}
      />
      <Text style={styles.stepperUnit}>ft</Text>
      <Pressable
        style={styles.stepperBtn}
        onPress={() => onChange(Math.min(max, Number((numVal + 0.5).toFixed(2))))}
      >
        <Text style={styles.stepperBtnText}>+</Text>
      </Pressable>
    </View>
  );
}

function HeightInput({ label, value, onChange }) {
  const [text, setText] = useState(String(value));
  return (
    <View style={styles.heightRow}>
      <Text style={styles.heightLabel}>{label}</Text>
      <TextInput
        style={styles.heightInput}
        value={text}
        onChangeText={setText}
        keyboardType="numeric"
        returnKeyType="done"
        onBlur={() => onChange(text)}
        onSubmitEditing={() => onChange(text)}
      />
    </View>
  );
}

// ============================================================================
// Stage 3 — Calibrate
// ============================================================================
function CalibrateStage({
  config, actions, isScanning,
  onSaveB1TxPower, onSaveB2TxPower, onSavePathLossN, onAdvance,
}) {
  const pipeline1 = actions.getCalibrationPipeline?.(1);
  const pipeline2 = actions.getCalibrationPipeline?.(2);

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>RSSI Calibration</Text>
        <Text style={styles.cardSub}>
          Stand ~1 ft (30 cm) from each beacon and collect samples.
          This sets the TX Power reference for distance estimation.
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
          <View style={[styles.scanDot, { backgroundColor: isScanning ? "#1a7f37" : "#cf222e" }]} />
          <Text style={{ fontSize: 11, color: isScanning ? "#1a7f37" : "#cf222e", fontWeight: "700" }}>
            {isScanning ? "BLE Scan Active" : "BLE Scan Stopped"}
          </Text>
        </View>
      </View>

      <CalibrationPanel
        beaconNum={1}
        beaconName={config.beacon1Name}
        pipeline={pipeline1}
        txPower={config.beacon1TxPower}
        pathLossN={config.pathLossN}
        onSaveTxPower={onSaveB1TxPower}
        onSavePathLossN={onSavePathLossN}
      />

      <CalibrationPanel
        beaconNum={2}
        beaconName={config.beacon2Name}
        pipeline={pipeline2}
        txPower={config.beacon2TxPower}
        pathLossN={config.pathLossN}
        onSaveTxPower={onSaveB2TxPower}
      />

      <Pressable style={styles.advanceBtn} onPress={onAdvance}>
        <Text style={styles.advanceBtnText}>Next: Start Position Test →</Text>
      </Pressable>
    </>
  );
}

// ============================================================================
// Stage 4 — Position Test
// ============================================================================
function PositionTestStage({
  config, moduleState, positionState, trail, heading, debugInfo,
  showOverlays, onToggleOverlays, actions, onGoToPlace,
  onOpenAreaModal, onPressStart,
}) {
  const roomW = (typeof config.roomWidthFt === "number" && isFinite(config.roomWidthFt) && config.roomWidthFt > 0) ? config.roomWidthFt : 18;
  const roomH = (typeof config.roomHeightFt === "number" && isFinite(config.roomHeightFt) && config.roomHeightFt > 0) ? config.roomHeightFt : 15;

  const isPositioning = moduleState === "POSITIONING";
  const isPaused      = moduleState === "PAUSED";
  const isStopped     = !isPositioning && !isPaused;

  const rawActiveX = positionState?.activeX ?? positionState?.fusedX ?? (roomW / 2);
  const rawActiveY = positionState?.activeY ?? positionState?.fusedY ?? (roomH / 2);
  const safeActiveX = (typeof rawActiveX === "number" && isFinite(rawActiveX)) ? rawActiveX : (roomW / 2);
  const safeActiveY = (typeof rawActiveY === "number" && isFinite(rawActiveY)) ? rawActiveY : (roomH / 2);
  const safeConf = (typeof positionState?.confidence === "number" && isFinite(positionState.confidence)) ? positionState.confidence : 0;
  const safeBleX = (typeof positionState?.bleX === "number" && isFinite(positionState.bleX)) ? positionState.bleX : (roomW / 2);
  const safeBleY = (typeof positionState?.bleY === "number" && isFinite(positionState.bleY)) ? positionState.bleY : (roomH / 2);
  const safePdrX = (typeof positionState?.pdrX === "number" && isFinite(positionState.pdrX)) ? positionState.pdrX : (roomW / 2);
  const safePdrY = (typeof positionState?.pdrY === "number" && isFinite(positionState.pdrY)) ? positionState.pdrY : (roomH / 2);
  const safeFusedX = (typeof positionState?.fusedX === "number" && isFinite(positionState.fusedX)) ? positionState.fusedX : (roomW / 2);
  const safeFusedY = (typeof positionState?.fusedY === "number" && isFinite(positionState.fusedY)) ? positionState.fusedY : (roomH / 2);

  const b1Available = debugInfo?.b1Available;
  const b2Available = debugInfo?.b2Available;
  const mode = debugInfo?.positioningMode || "fused";
  const gt = debugInfo?.groundTruth;
  const gtError = debugInfo?.gtErrorFt;
  const accScore = debugInfo?.accuracyScore;

  return (
    <>
      {/* Status banner */}
      <View style={[styles.statusBanner, {
        backgroundColor:
          isPositioning ? "#dafbe1" :
          isPaused      ? "#fff8c5" : "#f6f8fa",
        borderColor:
          isPositioning ? "#2da44e" :
          isPaused      ? "#d29922" : "#d0d7de",
      }]}>
        <View style={[styles.statusDot, {
          backgroundColor:
            isPositioning ? "#1a7f37" :
            isPaused      ? "#d29922" : "#8c959f",
        }]} />
        <Text style={styles.statusText}>
          {isPositioning ? "● POSITIONING ACTIVE"  :
           isPaused      ? "⏸ PAUSED"              :
                           "⏹ STOPPED"}
        </Text>
        <View style={{ flexDirection: "row", gap: 8, marginLeft: "auto" }}>
          <BeaconSignalBadge label="B1" available={b1Available} />
          <BeaconSignalBadge label="B2" available={b2Available} />
        </View>
      </View>

      {/* Test Area Status & Reconfiguration Row */}
      <View style={styles.areaRow}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={styles.areaRowLabel}>📐 Test Area:</Text>
          <Text style={styles.areaRowValue}>
            {roomW} × {roomH} ft ({((roomW * 0.3048)).toFixed(1)} × {((roomH * 0.3048)).toFixed(1)} m)
          </Text>
        </View>
        <Pressable style={styles.areaChangeBtn} onPress={onOpenAreaModal}>
          <Text style={styles.areaChangeBtnText}>Change Area</Text>
        </Pressable>
      </View>

      {/* Positioning Mode Switcher (4 Modes) */}
      <View style={styles.modeContainer}>
        <Pressable
          style={[styles.modeTab, (mode === "kalman" || mode === "fused") && styles.modeTabActive]}
          onPress={() => actions.setPositioningMode?.("kalman")}
        >
          <Text style={[styles.modeTabText, (mode === "kalman" || mode === "fused") && styles.modeTabTextActive]}>
            🛰️ Kalman
          </Text>
        </Pressable>
        <Pressable
          style={[styles.modeTab, mode === "ble" && styles.modeTabActive]}
          onPress={() => actions.setPositioningMode?.("ble")}
        >
          <Text style={[styles.modeTabText, mode === "ble" && styles.modeTabTextActive]}>
            📶 BLE Only
          </Text>
        </Pressable>
        <Pressable
          style={[styles.modeTab, mode === "pdr" && styles.modeTabActive]}
          onPress={() => actions.setPositioningMode?.("pdr")}
        >
          <Text style={[styles.modeTabText, mode === "pdr" && styles.modeTabTextActive]}>
            🚶 PDR Only
          </Text>
        </Pressable>
        <Pressable
          style={[styles.modeTab, mode === "complementary" && styles.modeTabActive]}
          onPress={() => actions.setPositioningMode?.("complementary")}
        >
          <Text style={[styles.modeTabText, mode === "complementary" && styles.modeTabTextActive]}>
            ⚖️ BLE+PDR
          </Text>
        </Pressable>
      </View>

      {/* Interactive Ground Truth Accuracy Card */}
      {gt && (
        <View style={styles.gtCard}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={styles.gtDot} />
              <Text style={styles.gtTitle}>Ground Truth Benchmark ({mode.toUpperCase()})</Text>
            </View>
            <Pressable onPress={() => actions.setGroundTruth?.(null)} style={styles.gtClearBtn}>
              <Text style={styles.gtClearText}>Clear Target</Text>
            </Pressable>
          </View>

          <View style={styles.gtStatsRow}>
            <View style={styles.gtStatItem}>
              <Text style={styles.gtStatLabel}>Target Point</Text>
              <Text style={styles.gtStatVal}>
                ({(typeof gt.x === "number" && isFinite(gt.x)) ? gt.x.toFixed(1) : "—"}, {(typeof gt.y === "number" && isFinite(gt.y)) ? gt.y.toFixed(1) : "—"}) ft
              </Text>
            </View>
            <View style={styles.gtStatItem}>
              <Text style={styles.gtStatLabel}>Current Error</Text>
              <Text style={[styles.gtStatVal, { color: (typeof gtError === "number" && isFinite(gtError)) ? (gtError < 2.0 ? "#16a34a" : gtError < 4.0 ? "#d97706" : "#dc2626") : "#57606a" }]}>
                {(typeof gtError === "number" && isFinite(gtError)) ? `${gtError.toFixed(2)} ft` : "--"}
              </Text>
              {(typeof gtError === "number" && isFinite(gtError)) && <Text style={styles.gtStatSub}>({(gtError / 3.28084).toFixed(2)} m)</Text>}
            </View>
            <View style={styles.gtStatItem}>
              <Text style={styles.gtStatLabel}>MAE / RMSE</Text>
              <Text style={[styles.gtStatVal, { fontSize: 12, color: "#1e293b" }]}>
                {(typeof debugInfo?.benchmarkStats?.mae === "number" && isFinite(debugInfo.benchmarkStats.mae) && typeof debugInfo?.benchmarkStats?.rmse === "number" && isFinite(debugInfo.benchmarkStats.rmse))
                  ? `${debugInfo.benchmarkStats.mae.toFixed(2)} / ${debugInfo.benchmarkStats.rmse.toFixed(2)} ft`
                  : "--"}
              </Text>
              {debugInfo?.benchmarkStats?.count > 0 && (
                <Text style={styles.gtStatSub}>({debugInfo.benchmarkStats.count} pts)</Text>
              )}
            </View>
          </View>
        </View>
      )}

      {/* Live position metrics */}
      <View style={styles.metricsRow}>
        <MetricTile label="X Position" value={`${safeActiveX.toFixed(2)} ft`} highlight sub={`${(safeActiveX / 3.28084).toFixed(2)} m`} />
        <MetricTile label="Y Position" value={`${safeActiveY.toFixed(2)} ft`} highlight sub={`${(safeActiveY / 3.28084).toFixed(2)} m`} />
        <MetricTile label="Confidence" value={`${(safeConf * 100).toFixed(0)}%`}
          color={safeConf > 0.6 ? "#1a7f37" : safeConf > 0.3 ? "#d29922" : "#cf222e"}
          sub={debugInfo?.isStationary ? "Stationary" : "Active Motion"}
        />
      </View>

      {/* Live PDR Metrics Row */}
      <View style={styles.metricsRow}>
        <MetricTile
          label="PDR Steps"
          value={String(positionState?.stepCount ?? 0)}
          color="#15803d"
          sub="Detected Steps"
        />
        <MetricTile
          label="Step Length"
          value={(() => {
            const slM = (typeof positionState?.stepLength === "number" && isFinite(positionState.stepLength)) ? positionState.stepLength : 0.70;
            return `${(slM * 3.28084).toFixed(2)} ft`;
          })()}
          color="#047857"
          sub={(() => {
            const slM = (typeof positionState?.stepLength === "number" && isFinite(positionState.stepLength)) ? positionState.stepLength : 0.70;
            return `${slM.toFixed(2)} m (Weinberg)`;
          })()}
        />
        <MetricTile
          label="Heading"
          value={(() => {
            const hVal = (positionState?.heading ?? heading);
            const safeH = (typeof hVal === "number" && isFinite(hVal)) ? hVal : 0;
            return `${safeH.toFixed(0)}°`;
          })()}
          color="#0369a1"
          sub={positionState?.cardinal || "North (N)"}
        />
      </View>

      {/* Beacon Distances Row */}
      <View style={styles.metricsRow}>
        <MetricTile
          label={`Dist to B1 (${config.beacon1Name || "B1"})`}
          value={(typeof debugInfo?.b1?.distanceFt === "number" && isFinite(debugInfo.b1.distanceFt)) ? `${debugInfo.b1.distanceFt.toFixed(1)} ft` : "Searching…"}
          color="#0369a1"
          sub={debugInfo?.b1?.filteredRssi != null ? `${debugInfo.b1.filteredRssi} dBm` : undefined}
        />
        <MetricTile
          label={`Dist to B2 (${config.beacon2Name || "B2"})`}
          value={(typeof debugInfo?.b2?.distanceFt === "number" && isFinite(debugInfo.b2.distanceFt)) ? `${debugInfo.b2.distanceFt.toFixed(1)} ft` : "Searching…"}
          color="#6d28d9"
          sub={debugInfo?.b2?.filteredRssi != null ? `${debugInfo.b2.filteredRssi} dBm` : undefined}
        />
      </View>

      {/* Map */}
      <TestAreaMap
        beacon1={{ x: config.beacon1X, y: config.beacon1Y }}
        beacon2={{ x: config.beacon2X, y: config.beacon2Y }}
        beacon1Dist={debugInfo?.b1?.distanceFt}
        beacon2Dist={debugInfo?.b2?.distanceFt}
        userPosition={{ fusedX: safeFusedX, fusedY: safeFusedY, activeX: safeActiveX, activeY: safeActiveY }}
        blePosition={showOverlays ? { bleX: safeBleX, bleY: safeBleY } : null}
        pdrPosition={showOverlays ? { pdrX: safePdrX, pdrY: safePdrY } : null}
        trail={trail}
        heading={heading}
        groundTruth={gt}
        roomWidthFt={roomW}
        roomHeightFt={roomH}
        isSetupMode={false}
        showDebugOverlays={showOverlays}
        onBeacon1Move={() => {}}
        onBeacon1Commit={() => {}}
        onBeacon2Move={() => {}}
        onBeacon2Commit={() => {}}
        onMapTap={(x, y) => actions.setGroundTruth?.({ x, y })}
      />

      {/* Control buttons */}
      <View style={styles.controlRow}>
        {isStopped && (
          <ActionBtn
            label="▶ Start Position Test"
            onPress={onPressStart}
            style={styles.btnGreen}
          />
        )}
        {isPositioning && (
          <ActionBtn label="⏸ Pause" onPress={actions.pausePositioning} style={styles.btnYellow} />
        )}
        {isPaused && (
          <ActionBtn label="▶ Resume" onPress={actions.resumePositioning} style={styles.btnGreen} />
        )}
        {(isPositioning || isPaused) && (
          <ActionBtn label="⏹ Stop" onPress={actions.stopPositioning} style={styles.btnRed} />
        )}
      </View>

      {/* Step Testing and Calibration Quick Tools */}
      <View style={styles.controlRow}>
        <ActionBtn
          label="👣 Add Step (+2.3 ft)"
          onPress={() => actions.addManualStep?.(2.3, heading)}
          style={[styles.btnOutline, { borderColor: "#1f6feb", backgroundColor: "#f0f8ff" }]}
        />
        <ActionBtn
          label="↺ Reset Position"
          onPress={() => { actions.resetPosition?.(); actions.resetPipelines?.(); }}
          style={styles.btnOutline}
        />
        <ActionBtn label="✕ Clear Trail" onPress={actions.clearTrail} style={styles.btnOutline} />
      </View>

      {/* Export & Placement Controls */}
      <View style={styles.controlRow}>
        <ActionBtn
          label={`📥 Export Trajectory (${debugInfo?.trajectoryCount || 0} pts)`}
          onPress={() => {
            Alert.alert(
              "Export Trajectory Data",
              "Choose format to export recorded telemetry points:",
              [
                { text: "Cancel", style: "cancel" },
                { text: "CSV (.csv)", onPress: actions.exportTrajectoryCsv },
                { text: "JSON (.json)", onPress: actions.exportTrajectoryJson },
              ]
            );
          }}
          style={[styles.btnOutline, { borderColor: "#059669", backgroundColor: "#ecfdf5" }]}
        />
        <ActionBtn label="✎ Edit Beacons" onPress={onGoToPlace} style={styles.btnOutline} />
      </View>

      {/* Debug panel */}
      <BeaconDebugPanel
        debugInfo={debugInfo}
        beacon1Name={config.beacon1Name}
        beacon2Name={config.beacon2Name}
        showOverlays={showOverlays}
        onToggleOverlays={onToggleOverlays}
      />
    </>
  );
}

function BeaconSignalBadge({ label, available }) {
  return (
    <View style={[styles.sigBadge, { backgroundColor: available ? "#dafbe1" : "#ffebe9" }]}>
      <Text style={[styles.sigBadgeText, { color: available ? "#1a7f37" : "#cf222e" }]}>
        {label}: {available ? "✓" : "✗"}
      </Text>
    </View>
  );
}

function MetricTile({ label, value, highlight, color, sub }) {
  return (
    <View style={[styles.metricTile, highlight && styles.metricTileHighlight]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, color ? { color } : highlight ? { color: "#1d4ed8" } : {}]}>{value}</Text>
      {sub ? <Text style={{ fontSize: 10, color: "#57606a", marginTop: 2, fontWeight: "600" }}>{sub}</Text> : null}
    </View>
  );
}

function ActionBtn({ label, onPress, style }) {
  const isOutline = style === undefined || style?.backgroundColor === "#fff";
  return (
    <Pressable style={[styles.actionBtnBase, style]} onPress={onPress}>
      <Text style={[styles.actionBtnText, style?.backgroundColor === "#fff" && { color: "#24292f" }]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ============================================================================
// Styles
// ============================================================================
const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 40 },
  loadingContainer: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },
  loadingText: { marginTop: 12, color: "#57606a", fontSize: 14 },

  // Header
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 },
  title:  { fontSize: 22, fontWeight: "800", color: "#24292f" },
  sub:    { fontSize: 11, color: "#57606a", marginTop: 2 },
  resetBtn:     { borderWidth: 1, borderColor: "#ffc9c9", backgroundColor: "#fff0f0",
                  paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, marginTop: 2 },
  resetBtnText: { fontSize: 12, fontWeight: "700", color: "#cf222e" },

  // Notice
  noticeBanner: { backgroundColor: "#fff8c5", borderRadius: 8, padding: 10,
                  borderWidth: 1, borderColor: "#d4a72c", marginBottom: 10 },
  noticeText: { fontSize: 11, color: "#7d4e17", fontWeight: "600" },

  // Stage indicator
  stageRow:    { flexDirection: "row", justifyContent: "space-between",
                 backgroundColor: "#f6f8fa", borderRadius: 12, padding: 10, marginBottom: 14 },
  stageItem:   { flex: 1, alignItems: "center", gap: 4 },
  stageCircle: { width: 28, height: 28, borderRadius: 14,
                 backgroundColor: "#e1e4e8", justifyContent: "center", alignItems: "center" },
  stageCircleActive: { backgroundColor: "#1f6feb" },
  stageCircleDone:   { backgroundColor: "#1a7f37" },
  stageNum:  { fontSize: 12, fontWeight: "800", color: "#57606a" },
  stageLabel:{ fontSize: 10, color: "#8c959f", textAlign: "center", fontWeight: "600" },

  // Cards
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 14,
          borderWidth: 1, borderColor: "#d0d7de", marginBottom: 10 },
  cardTitle:    { fontWeight: "700", fontSize: 13, color: "#24292f", marginBottom: 4 },
  cardTitleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  cardSub:      { fontSize: 11, color: "#57606a", lineHeight: 16, marginBottom: 8 },

  // Presets
  presetRow: { flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 4, marginBottom: 4 },
  presetChip: { flex: 1, minWidth: "46%", paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8,
                borderWidth: 1, borderColor: "#cbd5e1", backgroundColor: "#f8fafc" },
  presetChipActive: { borderColor: "#2563eb", backgroundColor: "#eff6ff" },
  presetChipText: { fontSize: 11, fontWeight: "700", color: "#334155" },
  presetChipTextActive: { color: "#1d4ed8" },
  presetChipSub: { fontSize: 9.5, color: "#64748b", marginTop: 1 },
  presetChipSubActive: { color: "#2563eb" },

  // Steppers
  stepperRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  stepperAxis: { width: 20, fontSize: 13, fontWeight: "800" },
  stepperBtn: { width: 34, height: 34, borderRadius: 8, backgroundColor: "#f1f5f9", borderWidth: 1,
                borderColor: "#cbd5e1", justifyContent: "center", alignItems: "center" },
  stepperBtnText: { fontSize: 18, fontWeight: "800", color: "#1e293b", lineHeight: 20 },
  stepperInput: { width: 72, height: 34, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8,
                  backgroundColor: "#fff", textAlign: "center", fontSize: 13, fontWeight: "700", color: "#1e293b" },
  stepperUnit: { fontSize: 11, color: "#64748b", fontWeight: "600", width: 14 },
  coordHeaderSub: { fontSize: 11, color: "#64748b", fontFamily: "monospace" },

  // Selected beacons
  selRow:     { flexDirection: "row", alignItems: "center", gap: 8,
                borderWidth: 1, borderRadius: 8, padding: 8, marginBottom: 6 },
  selBadge:   { width: 30, height: 30, borderRadius: 6, justifyContent: "center", alignItems: "center" },
  selBadgeText:{ fontWeight: "800", fontSize: 13 },
  selName:    { fontWeight: "700", fontSize: 12, color: "#24292f" },
  selId:      { fontSize: 10, color: "#8c959f", fontFamily: "monospace" },
  selEmpty:   { fontSize: 12, color: "#8c959f", fontStyle: "italic" },
  selClearBtn:  { paddingHorizontal: 8, paddingVertical: 4,
                  borderRadius: 6, borderWidth: 1, borderColor: "#d0d7de" },
  selClearText: { fontSize: 11, fontWeight: "700", color: "#57606a" },
  clearAllBtn:  { alignSelf: "center", marginTop: 4, paddingHorizontal: 10, paddingVertical: 4,
                  borderRadius: 6, borderWidth: 1, borderColor: "#ffc9c9" },
  clearAllText: { fontSize: 11, fontWeight: "700", color: "#cf222e" },

  // Scanner
  scanHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 },
  btStatus:   { fontSize: 11, color: "#8c959f", marginTop: 2 },
  scanBtn:    { flexDirection: "row", alignItems: "center", backgroundColor: "#1f6feb",
                paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  scanBtnStop:{ backgroundColor: "#cf222e" },
  scanBtnText:{ color: "#fff", fontWeight: "700", fontSize: 12 },
  emptyText:  { fontSize: 12, color: "#8c959f", fontStyle: "italic", textAlign: "center", paddingVertical: 16 },

  // Device card
  deviceCard:      { flexDirection: "row", alignItems: "center", gap: 8,
                     padding: 10, borderRadius: 8, borderWidth: 1,
                     borderColor: "#e1e4e8", marginBottom: 6, backgroundColor: "#fafbfc" },
  deviceCardSelected:{ borderColor: "#54aeff", backgroundColor: "#eef5ff" },
  deviceName:  { fontWeight: "700", fontSize: 12, color: "#24292f" },
  deviceId:    { fontSize: 10, color: "#8c959f", fontFamily: "monospace", marginTop: 1 },
  deviceRssi:  { fontSize: 11, fontWeight: "700" },
  deviceAge:   { fontSize: 10, color: "#8c959f" },
  assignBtn:   { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6,
                 borderWidth: 1, backgroundColor: "#fff" },
  assignBtnText:{ fontSize: 11, fontWeight: "700" },
  tag:         { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  tagText:     { fontSize: 9, fontWeight: "800" },

  // Advance button
  advanceBtn:     { backgroundColor: "#1f6feb", borderRadius: 10,
                    paddingVertical: 14, alignItems: "center", marginBottom: 12 },
  advanceBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },

  // Place stage
  resetLayoutBtn:  { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
                     borderWidth: 1, borderColor: "#d0d7de" },
  resetLayoutText: { fontSize: 11, fontWeight: "700", color: "#57606a" },
  coordCard:  { backgroundColor: "#fff", borderRadius: 10, padding: 12,
                borderWidth: 1, borderColor: "#d0d7de", marginBottom: 10 },
  heightRow:  { flexDirection: "row", justifyContent: "space-between",
                alignItems: "center", marginTop: 8 },
  heightLabel:{ fontSize: 12, color: "#57606a", fontWeight: "600" },
  heightInput:{ borderWidth: 1, borderColor: "#d0d7de", borderRadius: 8,
                paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, fontWeight: "700",
                backgroundColor: "#f6f8fa", width: 80, textAlign: "right", color: "#24292f" },

  // Mode switcher
  modeContainer: { flexDirection: "row", backgroundColor: "#f1f5f9", borderRadius: 10, padding: 3, marginBottom: 10 },
  modeTab: { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 8 },
  modeTabActive: { backgroundColor: "#fff", shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 3, elevation: 1 },
  modeTabText: { fontSize: 11, fontWeight: "600", color: "#64748b" },
  modeTabTextActive: { color: "#1d4ed8", fontWeight: "800" },

  // Ground truth accuracy card
  gtCard: { backgroundColor: "#fff1f2", borderRadius: 10, padding: 10, borderWidth: 1, borderColor: "#fecdd3", marginBottom: 10 },
  gtDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#e11d48" },
  gtTitle: { fontSize: 12, fontWeight: "800", color: "#be123c" },
  gtClearBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: "#fff", borderWidth: 1, borderColor: "#fda4af" },
  gtClearText: { fontSize: 10, fontWeight: "700", color: "#e11d48" },
  gtStatsRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  gtStatItem: { flex: 1, alignItems: "center" },
  gtStatLabel: { fontSize: 10, color: "#9f1239", fontWeight: "600" },
  gtStatVal: { fontSize: 14, fontWeight: "800", color: "#881337", marginTop: 2 },
  gtStatSub: { fontSize: 9.5, color: "#be123c", fontWeight: "600" },

  // Position test stage
  statusBanner: { flexDirection: "row", alignItems: "center", gap: 8,
                  borderRadius: 10, padding: 10, borderWidth: 1, marginBottom: 10 },
  statusDot:    { width: 10, height: 10, borderRadius: 5 },
  statusText:   { fontSize: 12, fontWeight: "700", color: "#24292f" },
  sigBadge:     { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5 },
  sigBadgeText: { fontSize: 10, fontWeight: "700" },

  metricsRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  metricTile: { flex: 1, backgroundColor: "#fff", borderRadius: 10,
                padding: 10, borderWidth: 1, borderColor: "#d0d7de", alignItems: "center" },
  metricTileHighlight: { borderColor: "#54aeff", backgroundColor: "#f0f8ff" },
  metricLabel: { fontSize: 10, color: "#57606a", fontWeight: "600" },
  metricValue: { fontSize: 16, fontWeight: "800", color: "#24292f", marginTop: 2 },

  controlRow:    { flexDirection: "row", gap: 8, marginBottom: 8 },
  actionBtnBase: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center",
                   justifyContent: "center" },
  actionBtnText: { fontWeight: "700", fontSize: 12, color: "#fff" },
  btnGreen:   { backgroundColor: "#1a7f37" },
  btnYellow:  { backgroundColor: "#d29922" },
  btnRed:     { backgroundColor: "#cf222e" },
  btnOutline: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#d0d7de" },

  // Scan status dot
  scanDot: { width: 8, height: 8, borderRadius: 4 },

  // Area config & status badges
  areaConfigCard: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#f0f6fc", padding: 10, borderRadius: 8, borderWidth: 1, borderColor: "#c8e1ff", marginBottom: 10 },
  areaConfigTitle: { fontSize: 13, fontWeight: "700", color: "#0969da" },
  areaConfigSub: { fontSize: 11, color: "#57606a", marginTop: 2 },
  changeAreaBtn: { backgroundColor: "#0969da", paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6 },
  changeAreaBtnText: { color: "#ffffff", fontWeight: "700", fontSize: 12 },

  areaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#eff6ff", borderWidth: 1, borderColor: "#bfdbfe", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  areaRowLabel: { fontSize: 12, fontWeight: "700", color: "#1d4ed8" },
  areaRowValue: { fontSize: 12, fontWeight: "600", color: "#1e40af" },
  areaChangeBtn: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 5, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#93c5fd" },
  areaChangeBtnText: { fontSize: 11, fontWeight: "700", color: "#1d4ed8" },
});

// ============================================================================
// Area Size Modal Component (Prompt before testing or on-demand editing)
// ============================================================================
function AreaSizeModal({
  visible,
  mode = "startTest",
  currentWidth = 18,
  currentHeight = 15,
  askBeforeTest = true,
  onSave,
  onClose,
}) {
  const [width, setWidth] = useState(String(currentWidth));
  const [height, setHeight] = useState(String(currentHeight));
  const [askEveryTime, setAskEveryTime] = useState(askBeforeTest);

  useEffect(() => {
    if (visible) {
      setWidth(String(currentWidth));
      setHeight(String(currentHeight));
      setAskEveryTime(askBeforeTest);
    }
  }, [visible, currentWidth, currentHeight, askBeforeTest]);

  const numW = parseFloat(width) || currentWidth;
  const numH = parseFloat(height) || currentHeight;
  const widthM = (numW * 0.3048).toFixed(2);
  const heightM = (numH * 0.3048).toFixed(2);

  const presets = [
    { label: "18 × 15 ft (Standard)", w: 18, h: 15 },
    { label: "20 × 20 ft (Square)",   w: 20, h: 20 },
    { label: "30 × 20 ft (Large)",    w: 30, h: 20 },
    { label: "15 × 10 ft (Small)",    w: 15, h: 10 },
    { label: "10 × 10 ft (Compact)",  w: 10, h: 10 },
  ];

  function applyPreset(p) {
    setWidth(String(p.w));
    setHeight(String(p.h));
  }

  function handleConfirm() {
    const parsedW = parseFloat(width);
    const parsedH = parseFloat(height);
    if (!parsedW || isNaN(parsedW) || parsedW < 4 || parsedW > 150) {
      Alert.alert("Invalid Width", "Please enter a valid room width between 4 and 150 feet.");
      return;
    }
    if (!parsedH || isNaN(parsedH) || parsedH < 4 || parsedH > 150) {
      Alert.alert("Invalid Height", "Please enter a valid room height between 4 and 150 feet.");
      return;
    }
    onSave({
      width: Number(parsedW.toFixed(1)),
      height: Number(parsedH.toFixed(1)),
      askEveryTime,
      autoStart: mode === "startTest",
    });
  }

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={modalStyles.backdrop}>
        <View style={modalStyles.dialog}>
          {/* Dialog Header */}
          <View style={modalStyles.headerRow}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={modalStyles.title}>
                {mode === "startTest" ? "🚀 Start Position Test" : "📐 Configure Room Area"}
              </Text>
              <Text style={modalStyles.subtitle}>
                {mode === "startTest"
                  ? "Confirm your test room dimensions before starting:"
                  : "Set test room width & height for mapping and scaling:"}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={modalStyles.closeIcon}>✕</Text>
            </Pressable>
          </View>

          {/* Quick Presets */}
          <Text style={modalStyles.sectionTitle}>Quick Area Presets</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={modalStyles.presetsRow}>
            {presets.map(p => {
              const isActive = Math.abs(numW - p.w) < 0.1 && Math.abs(numH - p.h) < 0.1;
              return (
                <Pressable
                  key={p.label}
                  style={[modalStyles.presetChip, isActive && modalStyles.presetChipActive]}
                  onPress={() => applyPreset(p)}
                >
                  <Text style={[modalStyles.presetChipText, isActive && modalStyles.presetChipTextActive]}>
                    {p.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* Width & Height Steppers / Inputs */}
          <View style={modalStyles.inputsGrid}>
            <View style={modalStyles.inputBlock}>
              <Text style={modalStyles.inputLabel}>Room Width (X)</Text>
              <View style={modalStyles.stepperRow}>
                <Pressable
                  style={modalStyles.stepBtn}
                  onPress={() => setWidth(String(Math.max(4, Number((numW - 1).toFixed(1)))))}
                >
                  <Text style={modalStyles.stepBtnText}>−</Text>
                </Pressable>
                <TextInput
                  style={modalStyles.textInput}
                  value={width}
                  onChangeText={setWidth}
                  keyboardType="numeric"
                  returnKeyType="done"
                />
                <Text style={modalStyles.unitText}>ft</Text>
                <Pressable
                  style={modalStyles.stepBtn}
                  onPress={() => setWidth(String(Math.min(150, Number((numW + 1).toFixed(1)))))}
                >
                  <Text style={modalStyles.stepBtnText}>+</Text>
                </Pressable>
              </View>
            </View>

            <View style={modalStyles.inputBlock}>
              <Text style={modalStyles.inputLabel}>Room Height (Y)</Text>
              <View style={modalStyles.stepperRow}>
                <Pressable
                  style={modalStyles.stepBtn}
                  onPress={() => setHeight(String(Math.max(4, Number((numH - 1).toFixed(1)))))}
                >
                  <Text style={modalStyles.stepBtnText}>−</Text>
                </Pressable>
                <TextInput
                  style={modalStyles.textInput}
                  value={height}
                  onChangeText={setHeight}
                  keyboardType="numeric"
                  returnKeyType="done"
                />
                <Text style={modalStyles.unitText}>ft</Text>
                <Pressable
                  style={modalStyles.stepBtn}
                  onPress={() => setHeight(String(Math.min(150, Number((numH + 1).toFixed(1)))))}
                >
                  <Text style={modalStyles.stepBtnText}>+</Text>
                </Pressable>
              </View>
            </View>
          </View>

          {/* Metric conversion pill */}
          <View style={modalStyles.metricBanner}>
            <Text style={modalStyles.metricText}>
              📐 Metric: <Text style={{ fontWeight: "700" }}>{widthM} m × {heightM} m</Text> ({(numW * numH).toFixed(0)} sq ft / {(numW * numH * 0.0929).toFixed(1)} m²)
            </Text>
          </View>

          {/* Ask every time switch */}
          <View style={modalStyles.switchRow}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={modalStyles.switchTitle}>Ask size before starting test</Text>
              <Text style={modalStyles.switchSub}>Prompt to confirm dimensions each time you start</Text>
            </View>
            <Switch
              value={askEveryTime}
              onValueChange={setAskEveryTime}
              trackColor={{ false: "#d0d7de", true: "#54aeff" }}
              thumbColor="#ffffff"
            />
          </View>

          {/* Action buttons */}
          <View style={modalStyles.actionsRow}>
            <Pressable style={modalStyles.cancelBtn} onPress={onClose}>
              <Text style={modalStyles.cancelBtnText}>Cancel</Text>
            </Pressable>
            <Pressable style={modalStyles.confirmBtn} onPress={handleConfirm}>
              <Text style={modalStyles.confirmBtnText}>
                {mode === "startTest" ? "▶ Confirm & Start Test" : "✓ Save Dimensions"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
    justifyContent: "center",
    alignItems: "center",
    padding: 18,
  },
  dialog: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    width: "100%",
    maxWidth: 420,
    padding: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 14,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    color: "#0f172a",
  },
  subtitle: {
    fontSize: 12,
    color: "#64748b",
    marginTop: 3,
    lineHeight: 16,
  },
  closeIcon: {
    fontSize: 18,
    color: "#94a3b8",
    padding: 4,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#475569",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  presetsRow: {
    gap: 8,
    paddingBottom: 14,
  },
  presetChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  presetChipActive: {
    backgroundColor: "#eff6ff",
    borderColor: "#3b82f6",
  },
  presetChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#334155",
  },
  presetChipTextActive: {
    color: "#1d4ed8",
    fontWeight: "700",
  },
  inputsGrid: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 12,
  },
  inputBlock: {
    flex: 1,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#334155",
    marginBottom: 6,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    paddingHorizontal: 4,
    height: 42,
  },
  stepBtn: {
    width: 32,
    height: 32,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#e2e8f0",
    borderRadius: 6,
  },
  stepBtnText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1e293b",
    lineHeight: 20,
  },
  textInput: {
    flex: 1,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "700",
    color: "#0f172a",
    paddingVertical: 0,
  },
  unitText: {
    fontSize: 12,
    color: "#64748b",
    fontWeight: "600",
    marginRight: 4,
  },
  metricBanner: {
    backgroundColor: "#f0fdf4",
    borderWidth: 1,
    borderColor: "#bbf7d0",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 14,
  },
  metricText: {
    fontSize: 12,
    color: "#15803d",
    textAlign: "center",
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
    marginBottom: 16,
  },
  switchTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#1e293b",
  },
  switchSub: {
    fontSize: 11,
    color: "#64748b",
    marginTop: 1,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
  },
  cancelBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#475569",
  },
  confirmBtn: {
    flex: 2,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: "#1f6feb",
    alignItems: "center",
    justifyContent: "center",
  },
  confirmBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#ffffff",
  },
});
