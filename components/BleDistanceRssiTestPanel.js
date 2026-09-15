// ============================================================================
// BleDistanceRssiTestPanel — Distance vs RSSI Testing & Graph Suite
//
// Allows recording live BLE test runs, capturing distance and RSSI samples,
// and rendering interactive Distance vs RSSI scatter/curve graphs and
// Time-Series comparison plots with Zoom In / Zoom Out and Auto-Fit features.
// ============================================================================

import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Dimensions,
  Alert,
} from "react-native";
import Svg, {
  Polyline,
  Circle,
  Line,
  Rect,
  Text as SvgText,
  G,
  Path,
  Defs,
  ClipPath,
} from "react-native-svg";
import { convertMeters, formatDistance } from "../services/BleScannerService.js";
import {
  calculateMAE,
  calculateRMSE,
  SPEED_OF_LIGHT_M_NS,
  DEFAULT_RTT_HARDWARE_OFFSET_NS,
} from "../services/RttRangingService.js";

let AsyncStorage = null;
try {
  const mod = require("@react-native-async-storage/async-storage");
  AsyncStorage = mod.default || mod;
} catch (e) {}

const TEST_HISTORY_STORAGE_KEY = "@ble_distance_test_history_v1";

export default function BleDistanceRssiTestPanel({
  devices = {},
  focusedDeviceId = null,
  distanceUnit = "m",
  txPower1m = -59,
  environmentalN = 2.2,
  groundTruthM = 1.0,
  rttOffsetNs = DEFAULT_RTT_HARDWARE_OFFSET_NS,
}) {
  // Available devices list
  const deviceList = Object.values(devices);
  const [selectedTargetId, setSelectedTargetId] = useState(
    focusedDeviceId || (deviceList[0]?.id || null)
  );

  // When focusedDeviceId changes from parent, sync target
  useEffect(() => {
    if (focusedDeviceId) {
      setSelectedTargetId(focusedDeviceId);
    } else if (!selectedTargetId && deviceList.length > 0) {
      setSelectedTargetId(deviceList[0].id);
    }
  }, [focusedDeviceId, deviceList.length]);

  // Testing session state
  const [isTesting, setIsTesting] = useState(false);
  const [testStartTime, setTestStartTime] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [currentSamples, setCurrentSamples] = useState([]);

  // Completed test runs
  const [testHistory, setTestHistory] = useState([]);
  const [selectedTestRun, setSelectedTestRun] = useState(null);

  // Active graph tab: "scatter" (Dist vs RSSI) | "timeseries" (Time vs Dist & RSSI) | "stats"
  const [activeGraphTab, setActiveGraphTab] = useState("scatter");

  // Zoom & Auto-Fit Controls
  const [zoomLevel, setZoomLevel] = useState(1.0); // 1.0x, 1.5x, 2.0x, 3.0x
  const [autoFitData, setAutoFitData] = useState(true);
  const [selectedPointInfo, setSelectedPointInfo] = useState(null);
  const [plotContainerWidth, setPlotContainerWidth] = useState(0);

  const timerRef = useRef(null);
  const targetDevice = devices[selectedTargetId] || null;

  // Load saved test history on mount
  useEffect(() => {
    (async () => {
      if (AsyncStorage && AsyncStorage.getItem) {
        try {
          const raw = await AsyncStorage.getItem(TEST_HISTORY_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setTestHistory(parsed);
              setSelectedTestRun(parsed[0]);
            }
          }
        } catch (e) {
          console.warn("[BleDistanceRssiTestPanel] Error loading test history:", e);
        }
      }
    })();
  }, []);

  // Save test history helper
  const persistTestHistory = async (newHistory) => {
    setTestHistory(newHistory);
    if (AsyncStorage && AsyncStorage.setItem) {
      try {
        await AsyncStorage.setItem(TEST_HISTORY_STORAGE_KEY, JSON.stringify(newHistory));
      } catch (e) {
        console.warn("[BleDistanceRssiTestPanel] Error saving test history:", e);
      }
    }
  };

  // --------------------------------------------------------------------------
  // Live Sampling Loop during active test
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!isTesting) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    const startMs = Date.now();
    setTestStartTime(startMs);
    setCurrentSamples([]);

    timerRef.current = setInterval(() => {
      const now = Date.now();
      const elapsed = Number(((now - startMs) / 1000).toFixed(1));
      setElapsedSeconds(elapsed);

      const dev = devices[selectedTargetId];
      if (dev && dev.rawRssi !== null && dev.rawRssi !== undefined) {
        const rawMeters = dev.distance !== null && dev.distance !== undefined ? dev.distance : null;
        if (rawMeters !== null) {
          const rttData = dev.rtt || null;
          const sample = {
            t: elapsed,
            rawRssi: dev.rawRssi,
            filteredRssi: dev.filteredRssi !== null ? dev.filteredRssi : dev.rawRssi,
            distM: rawMeters,
            distUnit: convertMeters(rawMeters, distanceUnit),
            rttRawNs: rttData ? rttData.rawTimeNs : null,
            rttCorrNs: rttData ? rttData.correctedTimeNs : null,
            rttDistM: rttData ? rttData.rttDistanceM : null,
            gtDistM: rttData ? rttData.groundTruthM : groundTruthM,
          };

          setCurrentSamples((prev) => [...prev, sample]);
        }
      }
    }, 100); // 100ms sample tick (10 Hz)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isTesting, selectedTargetId]);

  // Start Test handler
  const handleStartTest = () => {
    if (!selectedTargetId) {
      Alert.alert("Select Target", "Please scan and select a BLE device before starting a test run.");
      return;
    }
    setCurrentSamples([]);
    setElapsedSeconds(0);
    setSelectedPointInfo(null);
    setIsTesting(true);
  };

  // End Test handler
  const handleEndTest = () => {
    setIsTesting(false);
    if (timerRef.current) clearInterval(timerRef.current);

    if (currentSamples.length < 3) {
      Alert.alert("Test Too Short", "Collected fewer than 3 samples. Please walk around and record for at least a few seconds.");
      return;
    }

    // Compute comprehensive test analytics
    const rssiValues = currentSamples.map((s) => s.filteredRssi).filter((v) => typeof v === "number" && isFinite(v));
    const distValues = currentSamples.map((s) => s.distM).filter((v) => typeof v === "number" && isFinite(v));

    const minRssi = rssiValues.length > 0 ? Math.min(...rssiValues) : -100;
    const maxRssi = rssiValues.length > 0 ? Math.max(...rssiValues) : -40;
    const avgRssi = rssiValues.length > 0 ? Number((rssiValues.reduce((a, b) => a + b, 0) / rssiValues.length).toFixed(1)) : -70;

    const minMeters = distValues.length > 0 ? Math.min(...distValues) : 0;
    const maxMeters = distValues.length > 0 ? Math.max(...distValues) : 5;
    const avgMeters = distValues.length > 0 ? Number((distValues.reduce((a, b) => a + b, 0) / distValues.length).toFixed(2)) : 1;

    // RSSI standard deviation (signal stability)
    const rssiVariance =
      rssiValues.length > 0 ? rssiValues.reduce((acc, v) => acc + (v - avgRssi) ** 2, 0) / rssiValues.length : 0;
    const rssiStdDev = Number(Math.sqrt(rssiVariance).toFixed(2));

    // RTT Analytics & Metrics
    const rttDistValues = currentSamples.map((s) => s.rttDistM).filter((v) => typeof v === "number" && isFinite(v));
    const rttRawValues = currentSamples.map((s) => s.rttRawNs).filter((v) => typeof v === "number" && isFinite(v));
    const rttCorrValues = currentSamples.map((s) => s.rttCorrNs).filter((v) => typeof v === "number" && isFinite(v));

    const minRttM = rttDistValues.length > 0 ? Math.min(...rttDistValues) : null;
    const maxRttM = rttDistValues.length > 0 ? Math.max(...rttDistValues) : null;
    const avgRttM = rttDistValues.length > 0 ? Number((rttDistValues.reduce((a, b) => a + b, 0) / rttDistValues.length).toFixed(3)) : null;

    const avgRawNs = rttRawValues.length > 0 ? Number((rttRawValues.reduce((a, b) => a + b, 0) / rttRawValues.length).toFixed(1)) : null;
    const avgCorrNs = rttCorrValues.length > 0 ? Number((rttCorrValues.reduce((a, b) => a + b, 0) / rttCorrValues.length).toFixed(1)) : null;
    const rawVariance = rttRawValues.length > 0 ? rttRawValues.reduce((acc, v) => acc + (v - avgRawNs) ** 2, 0) / rttRawValues.length : 0;
    const rawJitterNs = Number(Math.sqrt(rawVariance).toFixed(2));

    // Ground Truth benchmarks (MAE & RMSE)
    const runGtDist = currentSamples[0]?.gtDistM || groundTruthM || 1.0;
    const rttMae = rttDistValues.length > 0 ? calculateMAE(rttDistValues, runGtDist) : null;
    const rttRmse = rttDistValues.length > 0 ? calculateRMSE(rttDistValues, runGtDist) : null;
    const rssiMae = distValues.length > 0 ? calculateMAE(distValues, runGtDist) : null;
    const rssiRmse = distValues.length > 0 ? calculateRMSE(distValues, runGtDist) : null;

    // Discrepancy between RTT and RSSI
    const diffList = currentSamples
      .filter((s) => typeof s.rttDistM === "number" && typeof s.distM === "number")
      .map((s) => Math.abs(s.rttDistM - s.distM));
    const avgDiffM = diffList.length > 0 ? Number((diffList.reduce((a, b) => a + b, 0) / diffList.length).toFixed(3)) : null;

    const devMeta = devices[selectedTargetId] || {};
    const newRun = {
      id: `test_${Date.now()}`,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      date: new Date().toLocaleDateString(),
      targetName: devMeta.name || "Unknown Beacon",
      targetId: selectedTargetId,
      durationSec: elapsedSeconds,
      sampleCount: currentSamples.length,
      txPower: txPower1m,
      pathLossN: environmentalN,
      unit: distanceUnit,
      groundTruthM: runGtDist,
      rttOffsetNs: rttOffsetNs,
      stats: {
        minRssi,
        maxRssi,
        avgRssi,
        rssiStdDev,
        minMeters,
        maxMeters,
        avgMeters,
        minRttM,
        maxRttM,
        avgRttM,
        avgRawNs,
        avgCorrNs,
        rawJitterNs,
        rttMae,
        rttRmse,
        rssiMae,
        rssiRmse,
        avgDiffM,
      },
      samples: [...currentSamples],
    };

    const updated = [newRun, ...testHistory.slice(0, 9)];
    persistTestHistory(updated);
    setSelectedTestRun(newRun);
    setSelectedPointInfo(null);
  };

  const handleClearHistory = () => {
    Alert.alert("Clear Test History", "Delete all saved test runs?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear All",
        style: "destructive",
        onPress: () => {
          persistTestHistory([]);
          setSelectedTestRun(null);
          setSelectedPointInfo(null);
        },
      },
    ]);
  };

  const activeRun = selectedTestRun || (testHistory.length > 0 ? testHistory[0] : null);

  return (
    <View style={styles.containerCard}>
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={{ flex: 1, paddingRight: 6 }}>
          <Text style={styles.title}>📊 BLE Distance vs RSSI Test Suite</Text>
          <Text style={styles.subtitle}>
            Run live path-loss tests, inspect RF curves with zoom controls, and verify 0cm near-field accuracy.
          </Text>
        </View>
        {isTesting && (
          <View style={styles.liveTestBadge}>
            <View style={styles.recordingDot} />
            <Text style={styles.liveTestText}>RECORDING</Text>
          </View>
        )}
      </View>

      {/* Target Device Selector Bar */}
      <View style={styles.targetBar}>
        <Text style={styles.targetLabel}>🎯 Target:</Text>
        {deviceList.length === 0 ? (
          <Text style={styles.targetNoneText}>No BLE beacons scanned. Start BLE scan above.</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
            <View style={styles.targetPillsRow}>
              {deviceList.map((d) => {
                const isSelected = d.id === selectedTargetId;
                return (
                  <Pressable
                    key={d.id}
                    onPress={() => !isTesting && setSelectedTargetId(d.id)}
                    style={[styles.targetPill, isSelected && styles.targetPillActive]}
                  >
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      style={[styles.targetPillText, isSelected && styles.targetPillTextActive]}
                    >
                      {d.name || d.id.slice(-6)} {isSelected ? "✓" : ""}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        )}
      </View>

      {/* Live Recording Stats Dashboard */}
      {isTesting ? (
        <View style={styles.liveDashboard}>
          <View style={styles.liveMetricItem}>
            <Text style={styles.liveMetricLabel}>DURATION</Text>
            <Text style={styles.liveMetricVal}>{elapsedSeconds.toFixed(1)}s</Text>
          </View>
          <View style={styles.liveMetricItem}>
            <Text style={styles.liveMetricLabel}>SAMPLES</Text>
            <Text style={styles.liveMetricVal}>{currentSamples.length}</Text>
          </View>
          <View style={styles.liveMetricItem}>
            <Text style={styles.liveMetricLabel}>RSSI DIST</Text>
            <Text style={[styles.liveMetricVal, { color: "#1a7f37" }]}>
              {formatDistance(targetDevice?.distance, distanceUnit).value} {distanceUnit}
            </Text>
          </View>
          <View style={styles.liveMetricItem}>
            <Text style={styles.liveMetricLabel}>RTT DIST</Text>
            <Text style={[styles.liveMetricVal, { color: "#0284c7" }]}>
              {formatDistance(targetDevice?.rtt?.rttDistanceM, distanceUnit).value} {distanceUnit}
            </Text>
          </View>
          <View style={styles.liveMetricItem}>
            <Text style={styles.liveMetricLabel}>SIGNAL</Text>
            <Text style={[styles.liveMetricVal, { color: "#1f6feb" }]}>
              {targetDevice?.filteredRssi ?? targetDevice?.rawRssi ?? "--"} dBm
            </Text>
          </View>
        </View>
      ) : null}

      {/* Action Buttons: Start Test / End Test */}
      <View style={styles.actionBtnRow}>
        {!isTesting ? (
          <Pressable
            onPress={handleStartTest}
            style={[styles.testBtn, styles.btnStartTest]}
          >
            <Text style={styles.btnStartTestText}>▶️ Start Test Run</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handleEndTest}
            style={[styles.testBtn, styles.btnEndTest]}
          >
            <Text style={styles.btnEndTestText}>⏹️ End Test & Generate Graph</Text>
          </Pressable>
        )}

        {testHistory.length > 0 && !isTesting && (
          <Pressable onPress={handleClearHistory} style={styles.btnClearHistory}>
            <Text style={styles.btnClearHistoryText}>Clear</Text>
          </Pressable>
        )}
      </View>

      {/* ──────────────────────────────────────────────────────────────────── */}
      {/* TEST RESULTS & GRAPH ANALYSIS SECTION                                */}
      {/* ──────────────────────────────────────────────────────────────────── */}
      {activeRun ? (
        <View style={styles.resultsContainer}>
          {/* Saved Runs Pill Selector */}
          {testHistory.length > 1 && (
            <View style={styles.historySelectorRow}>
              <Text style={styles.historySelectorLabel}>Saved Runs:</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {testHistory.map((run, idx) => {
                  const isCur = run.id === activeRun.id;
                  return (
                    <Pressable
                      key={run.id}
                      onPress={() => {
                        setSelectedTestRun(run);
                        setSelectedPointInfo(null);
                      }}
                      style={[styles.runPill, isCur && styles.runPillActive]}
                    >
                      <Text style={[styles.runPillText, isCur && styles.runPillTextActive]}>
                        Run #{testHistory.length - idx} ({run.durationSec}s)
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          )}

          {/* Graph Sub-Tabs: Scatter | Multi Series | RTT Timing | Statistics */}
          <View style={styles.graphTabBar}>
            <Pressable
              onPress={() => setActiveGraphTab("scatter")}
              style={[styles.graphTabBtn, activeGraphTab === "scatter" && styles.graphTabBtnActive]}
            >
              <Text style={[styles.graphTabText, activeGraphTab === "scatter" && styles.graphTabTextActive]}>
                📍 Dist vs RSSI
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveGraphTab("timeseries")}
              style={[styles.graphTabBtn, activeGraphTab === "timeseries" && styles.graphTabBtnActive]}
            >
              <Text style={[styles.graphTabText, activeGraphTab === "timeseries" && styles.graphTabTextActive]}>
                📈 Multi Series
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveGraphTab("rtt_time")}
              style={[styles.graphTabBtn, activeGraphTab === "rtt_time" && styles.graphTabBtnActive]}
            >
              <Text style={[styles.graphTabText, activeGraphTab === "rtt_time" && styles.graphTabTextActive]}>
                ⏱️ RTT ToF
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveGraphTab("stats")}
              style={[styles.graphTabBtn, activeGraphTab === "stats" && styles.graphTabBtnActive]}
            >
              <Text style={[styles.graphTabText, activeGraphTab === "stats" && styles.graphTabTextActive]}>
                📋 Evaluation
              </Text>
            </Pressable>
          </View>

          {/* Interactive Zoom Toolbar for Graphs */}
          {(activeGraphTab === "scatter" || activeGraphTab === "timeseries" || activeGraphTab === "rtt_time") && (
            <View style={styles.zoomToolbar}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={styles.zoomLabel}>Zoom:</Text>
                <Pressable
                  onPress={() => setZoomLevel((z) => Math.max(0.75, Number((z - 0.25).toFixed(2))))}
                  style={styles.zoomBtn}
                >
                  <Text style={styles.zoomBtnText}>-</Text>
                </Pressable>
                <Text style={styles.zoomValueText}>{zoomLevel}x</Text>
                <Pressable
                  onPress={() => setZoomLevel((z) => Math.min(3.0, Number((z + 0.25).toFixed(2))))}
                  style={styles.zoomBtn}
                >
                  <Text style={styles.zoomBtnText}>+</Text>
                </Pressable>
              </View>

              <View style={{ flexDirection: "row", gap: 6 }}>
                <Pressable
                  onPress={() => {
                    setAutoFitData(true);
                    setZoomLevel(1.0);
                  }}
                  style={[styles.autoFitBtn, autoFitData && styles.autoFitBtnActive]}
                >
                  <Text style={[styles.autoFitBtnText, autoFitData && styles.autoFitBtnTextActive]}>
                    🎯 Auto-Fit
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setAutoFitData(false);
                    setZoomLevel(1.0);
                  }}
                  style={[styles.autoFitBtn, !autoFitData && styles.autoFitBtnActive]}
                >
                  <Text style={[styles.autoFitBtnText, !autoFitData && styles.autoFitBtnTextActive]}>
                    🌐 Full
                  </Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Interactive Point Inspector Tooltip */}
          {selectedPointInfo && (
            <View style={styles.tooltipBox}>
              <Text style={styles.tooltipTitle}>📌 Sample #{selectedPointInfo.idx + 1}</Text>
              <Text style={styles.tooltipBody}>
                RSSI: <Text style={{ fontWeight: "800", color: "#1f6feb" }}>{selectedPointInfo.rssi} dBm</Text> • RSSI Dist:{" "}
                <Text style={{ fontWeight: "800", color: "#1a7f37" }}>
                  {selectedPointInfo.dist.toFixed(2)} {distanceUnit}
                </Text>{" "}
                {selectedPointInfo.rttDist !== undefined && selectedPointInfo.rttDist !== null && (
                  <>
                    • RTT Dist:{" "}
                    <Text style={{ fontWeight: "800", color: "#0284c7" }}>
                      {selectedPointInfo.rttDist.toFixed(2)} {distanceUnit}
                    </Text>{" "}
                  </>
                )}
                • Time: {selectedPointInfo.t.toFixed(1)}s
              </Text>
            </View>
          )}

          {/* ──────────────────────────────────────────────────────────────── */}
          {/* TAB 1: DISTANCE VS RSSI PLOT (Theoretical Model vs Measured)    */}
          {/* ──────────────────────────────────────────────────────────────── */}
          {activeGraphTab === "scatter" && (
            <View
              style={styles.graphBox}
              onLayout={(e) => {
                const w = Math.round(e.nativeEvent.layout.width);
                if (w > 60 && Math.abs(w - plotContainerWidth) > 3) setPlotContainerWidth(w);
              }}
            >
              <View style={styles.graphLegendRow}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: "#1f6feb" }]} />
                  <Text style={styles.legendLabel}>Measured ({activeRun.sampleCount} pts)</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDash, { borderColor: "#cf222e" }]} />
                  <Text style={styles.legendLabel}>Theoretical (n={activeRun.pathLossN})</Text>
                </View>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={zoomLevel > 1.05}
                contentContainerStyle={{ alignItems: "center" }}
              >
                <DistanceVsRssiScatterGraph
                  samples={activeRun.samples}
                  txPower={activeRun.txPower}
                  pathLossN={activeRun.pathLossN}
                  unit={distanceUnit}
                  zoomLevel={zoomLevel}
                  autoFit={autoFitData}
                  containerWidth={plotContainerWidth}
                  onSelectPoint={(pt) => setSelectedPointInfo(pt)}
                />
              </ScrollView>

              <Text style={styles.graphFootnote}>
                • Tap any blue dot to inspect exact RSSI & Distance.
                {"\n"}• Closer to right = Stronger RSSI. Lower Y = Closer to beacon.
              </Text>
            </View>
          )}

          {/* ──────────────────────────────────────────────────────────────── */}
          {/* TAB 2: MULTI TIME SERIES RUN (RTT Dist, RSSI Dist, GT & RSSI)   */}
          {/* ──────────────────────────────────────────────────────────────── */}
          {activeGraphTab === "timeseries" && (
            <View
              style={styles.graphBox}
              onLayout={(e) => {
                const w = Math.round(e.nativeEvent.layout.width);
                if (w > 60 && Math.abs(w - plotContainerWidth) > 3) setPlotContainerWidth(w);
              }}
            >
              <View style={styles.graphLegendRow}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: "#1a7f37" }]} />
                  <Text style={styles.legendLabel}>RSSI Dist ({distanceUnit})</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: "#0284c7" }]} />
                  <Text style={styles.legendLabel}>RTT Dist ({distanceUnit})</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDash, { borderColor: "#d97706" }]} />
                  <Text style={styles.legendLabel}>Ground Truth</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: "#8250df" }]} />
                  <Text style={styles.legendLabel}>RSSI (dBm)</Text>
                </View>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={zoomLevel > 1.05}
                contentContainerStyle={{ alignItems: "center" }}
              >
                <TimeSeriesDualGraph
                  samples={activeRun.samples}
                  durationSec={activeRun.durationSec}
                  unit={distanceUnit}
                  zoomLevel={zoomLevel}
                  autoFit={autoFitData}
                  containerWidth={plotContainerWidth}
                />
              </ScrollView>

              <Text style={styles.graphFootnote}>
                • Green = RSSI Distance. Cyan = RTT Distance (ToF). Amber = Ground Truth. Purple = Filtered RSSI.
              </Text>
            </View>
          )}

          {/* ──────────────────────────────────────────────────────────────── */}
          {/* TAB 3: RTT TIME-OF-FLIGHT GRAPH                                  */}
          {/* ──────────────────────────────────────────────────────────────── */}
          {activeGraphTab === "rtt_time" && (
            <View
              style={styles.graphBox}
              onLayout={(e) => {
                const w = Math.round(e.nativeEvent.layout.width);
                if (w > 60 && Math.abs(w - plotContainerWidth) > 3) setPlotContainerWidth(w);
              }}
            >
              <View style={styles.graphLegendRow}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: "#0284c7" }]} />
                  <Text style={styles.legendLabel}>T_corrected (ns)</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDash, { borderColor: "#d97706" }]} />
                  <Text style={styles.legendLabel}>Ideal ToF @ Ground Truth</Text>
                </View>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={zoomLevel > 1.05}
                contentContainerStyle={{ alignItems: "center" }}
              >
                <RttTimingGraph
                  samples={activeRun.samples}
                  durationSec={activeRun.durationSec}
                  unit={distanceUnit}
                  zoomLevel={zoomLevel}
                  autoFit={autoFitData}
                  containerWidth={plotContainerWidth}
                />
              </ScrollView>

              <Text style={styles.graphFootnote}>
                • Cyan = Corrected Round-Trip Time (ns). Amber = Ideal physical ToF (2 × d_GT / c).
              </Text>
            </View>
          )}

          {/* ──────────────────────────────────────────────────────────────── */}
          {/* TAB 4: COMPREHENSIVE STATS & EVALUATION TABLE                    */}
          {/* ──────────────────────────────────────────────────────────────── */}
          {activeGraphTab === "stats" && (
            <View style={styles.statsCard}>
              <Text style={styles.statsCardTitle}>Run Evaluation: {activeRun.targetName}</Text>
              <Text style={styles.statsCardSub}>
                Comparative benchmark between Experimental RTT-Style ToF and Log-Distance RSSI ranging.
              </Text>

              {/* Benchmark Summary Table */}
              <View style={styles.evalTable}>
                <View style={styles.evalTableRowHeader}>
                  <Text style={[styles.evalTableCell, styles.evalHeaderCell, { flex: 1.4 }]}>Metric</Text>
                  <Text style={[styles.evalTableCell, styles.evalHeaderCell, { color: "#0284c7" }]}>RTT (ToF)</Text>
                  <Text style={[styles.evalTableCell, styles.evalHeaderCell, { color: "#1a7f37" }]}>RSSI (Path Loss)</Text>
                </View>

                {/* Ground Truth Row */}
                <View style={styles.evalTableRow}>
                  <Text style={[styles.evalTableCell, styles.evalLabelCell, { flex: 1.4 }]}>Ground Truth</Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell, { color: "#d97706" }]}>
                    {activeRun.groundTruthM ? convertMeters(activeRun.groundTruthM, distanceUnit) : "--"} {distanceUnit}
                  </Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell, { color: "#d97706" }]}>
                    {activeRun.groundTruthM ? convertMeters(activeRun.groundTruthM, distanceUnit) : "--"} {distanceUnit}
                  </Text>
                </View>

                {/* MAE Row */}
                <View style={[styles.evalTableRow, { backgroundColor: "#f0fdf4" }]}>
                  <Text style={[styles.evalTableCell, styles.evalLabelCell, { flex: 1.4 }]}>MAE vs GT (Error)</Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell, { fontWeight: "800", color: "#0284c7" }]}>
                    {activeRun.stats.rttMae !== null && activeRun.stats.rttMae !== undefined
                      ? `${convertMeters(activeRun.stats.rttMae, distanceUnit)} ${distanceUnit}`
                      : "--"}
                  </Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell, { fontWeight: "800", color: "#1a7f37" }]}>
                    {activeRun.stats.rssiMae !== null && activeRun.stats.rssiMae !== undefined
                      ? `${convertMeters(activeRun.stats.rssiMae, distanceUnit)} ${distanceUnit}`
                      : "--"}
                  </Text>
                </View>

                {/* RMSE Row */}
                <View style={[styles.evalTableRow, { backgroundColor: "#f8fafc" }]}>
                  <Text style={[styles.evalTableCell, styles.evalLabelCell, { flex: 1.4 }]}>RMSE vs GT (Std Error)</Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell, { fontWeight: "800", color: "#0284c7" }]}>
                    {activeRun.stats.rttRmse !== null && activeRun.stats.rttRmse !== undefined
                      ? `${convertMeters(activeRun.stats.rttRmse, distanceUnit)} ${distanceUnit}`
                      : "--"}
                  </Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell, { fontWeight: "800", color: "#1a7f37" }]}>
                    {activeRun.stats.rssiRmse !== null && activeRun.stats.rssiRmse !== undefined
                      ? `${convertMeters(activeRun.stats.rssiRmse, distanceUnit)} ${distanceUnit}`
                      : "--"}
                  </Text>
                </View>

                {/* Avg Distance Row */}
                <View style={styles.evalTableRow}>
                  <Text style={[styles.evalTableCell, styles.evalLabelCell, { flex: 1.4 }]}>Avg Distance</Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell]}>
                    {activeRun.stats.avgRttM !== null && activeRun.stats.avgRttM !== undefined
                      ? `${convertMeters(activeRun.stats.avgRttM, distanceUnit)} ${distanceUnit}`
                      : "--"}
                  </Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell]}>
                    {convertMeters(activeRun.stats.avgMeters, distanceUnit)} {distanceUnit}
                  </Text>
                </View>

                {/* Min / Max Row */}
                <View style={styles.evalTableRow}>
                  <Text style={[styles.evalTableCell, styles.evalLabelCell, { flex: 1.4 }]}>Min / Max Dist</Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell]}>
                    {activeRun.stats.minRttM !== null && activeRun.stats.maxRttM !== null
                      ? `${convertMeters(activeRun.stats.minRttM, distanceUnit)} - ${convertMeters(activeRun.stats.maxRttM, distanceUnit)}`
                      : "--"}
                  </Text>
                  <Text style={[styles.evalTableCell, styles.evalValCell]}>
                    {convertMeters(activeRun.stats.minMeters, distanceUnit)} - {convertMeters(activeRun.stats.maxMeters, distanceUnit)}
                  </Text>
                </View>
              </View>

              {/* Discrepancy & Timing Info Grid */}
              <View style={[styles.statsGrid, { marginTop: 12 }]}>
                <View style={styles.statCell}>
                  <Text style={styles.statCellLabel}>Duration</Text>
                  <Text style={styles.statCellVal}>{activeRun.durationSec}s</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statCellLabel}>Samples</Text>
                  <Text style={styles.statCellVal}>{activeRun.sampleCount}</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statCellLabel}>Mean |RTT - RSSI|</Text>
                  <Text style={[styles.statCellVal, { color: "#d97706" }]}>
                    {activeRun.stats.avgDiffM !== null && activeRun.stats.avgDiffM !== undefined
                      ? `${convertMeters(activeRun.stats.avgDiffM, distanceUnit)} ${distanceUnit}`
                      : "--"}
                  </Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statCellLabel}>Avg T_corrected</Text>
                  <Text style={[styles.statCellVal, { color: "#0284c7" }]}>
                    {activeRun.stats.avgCorrNs !== null ? `${activeRun.stats.avgCorrNs} ns` : "--"}
                  </Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statCellLabel}>Timing Jitter (σ)</Text>
                  <Text style={styles.statCellVal}>
                    {activeRun.stats.rawJitterNs !== null ? `±${activeRun.stats.rawJitterNs} ns` : "--"}
                  </Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statCellLabel}>RSSI Jitter (σ)</Text>
                  <Text style={styles.statCellVal}>±{activeRun.stats.rssiStdDev} dBm</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statCellLabel}>HW Offset (T_offset)</Text>
                  <Text style={styles.statCellVal}>
                    {activeRun.rttOffsetNs ? `${activeRun.rttOffsetNs} ns` : "--"}
                  </Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statCellLabel}>Path Loss (n)</Text>
                  <Text style={styles.statCellVal}>{activeRun.pathLossN}</Text>
                </View>
              </View>
            </View>
          )}
        </View>
      ) : (
        <View style={styles.noResultsBox}>
          <Text style={styles.noResultsText}>
            No test runs recorded yet. Tap "▶️ Start Test Run", walk closer or farther from your beacon, and tap "End Test" to view the graph.
          </Text>
        </View>
      )}
    </View>
  );
}

// ============================================================================
// SVG GRAPH 1: DISTANCE VS RSSI SCATTER & THEORETICAL CURVE (Auto-Adjusted)
// ============================================================================
function DistanceVsRssiScatterGraph({
  samples = [],
  txPower = -59,
  pathLossN = 2.2,
  unit = "m",
  zoomLevel = 1.0,
  autoFit = true,
  containerWidth = 0,
  onSelectPoint,
}) {
  const screenWidth = Dimensions.get("window").width;
  const baseWidth = containerWidth > 150 ? containerWidth - 8 : Math.max(280, screenWidth - 68);
  const svgWidth = Math.round(baseWidth * zoomLevel);
  const svgHeight = 280;

  const padLeft = 62;
  const padRight = 20;
  const padTop = 24;
  const padBottom = 46;

  const plotW = Math.max(120, svgWidth - padLeft - padRight);
  const plotH = Math.max(120, svgHeight - padTop - padBottom);

  const convertedSamples = samples.map((s, idx) => ({
    idx,
    t: s.t,
    rssi: s.filteredRssi,
    dist: convertMeters(s.distM, unit),
  }));

  // Auto-fit bounds vs full bounds — guaranteed never to cut off height-wise or width-wise
  let rssiMin = -95;
  let rssiMax = -35;
  let distMin = 0;
  let distMax = unit === "in" ? 120 : unit === "ft" ? 10 : 3.0;

  if (convertedSamples.length > 0) {
    const minSampleRssi = Math.min(...convertedSamples.map((s) => s.rssi));
    const maxSampleRssi = Math.max(...convertedSamples.map((s) => s.rssi));
    const minSampleDist = Math.min(...convertedSamples.map((s) => s.dist));
    const maxSampleDist = Math.max(...convertedSamples.map((s) => s.dist));

    if (autoFit) {
      rssiMin = Math.max(-105, Math.floor(minSampleRssi - 4));
      rssiMax = Math.min(-20, Math.ceil(maxSampleRssi + 4));
      distMin = Math.max(0, Number((minSampleDist * 0.85).toFixed(2)));
      distMax = Math.max(unit === "in" ? 12 : unit === "ft" ? 1.2 : 0.4, Number((maxSampleDist * 1.15).toFixed(2)));
    } else {
      distMax = Math.max(distMax, Number((maxSampleDist * 1.12).toFixed(2)));
      rssiMin = Math.min(rssiMin, Math.floor(minSampleRssi - 3));
      rssiMax = Math.max(rssiMax, Math.ceil(maxSampleRssi + 3));
    }
  }

  const mapX = (rssi) => {
    const clamped = Math.max(rssiMin, Math.min(rssiMax, rssi));
    return padLeft + ((clamped - rssiMin) / Math.max(1, rssiMax - rssiMin)) * plotW;
  };

  const mapY = (dist) => {
    const clamped = Math.max(distMin, Math.min(distMax, dist));
    return padTop + plotH - ((clamped - distMin) / Math.max(0.05, distMax - distMin)) * plotH;
  };

  // Generate Theoretical Curve
  const theoreticalPoints = [];
  const stepRssi = (rssiMax - rssiMin) / 40;
  for (let r = rssiMin; r <= rssiMax; r += Math.max(0.5, stepRssi)) {
    const ratio = (txPower - r) / (10 * Math.max(1.0, pathLossN));
    const m = Math.pow(10, ratio);
    const converted = convertMeters(m, unit);
    if (converted <= distMax * 1.05) {
      theoreticalPoints.push({ x: mapX(r), y: mapY(converted) });
    }
  }
  const theoreticalPolyline = theoreticalPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // 5 Evenly-spaced Grid Ticks
  const yTicks = [
    distMin,
    distMin + (distMax - distMin) * 0.25,
    distMin + (distMax - distMin) * 0.5,
    distMin + (distMax - distMin) * 0.75,
    distMax,
  ];
  const xTicks = [
    rssiMin,
    Math.round(rssiMin + (rssiMax - rssiMin) * 0.25),
    Math.round(rssiMin + (rssiMax - rssiMin) * 0.5),
    Math.round(rssiMin + (rssiMax - rssiMin) * 0.75),
    rssiMax,
  ];

  return (
    <Svg width={svgWidth} height={svgHeight}>
      <Defs>
        <ClipPath id="scatterPlotClip">
          <Rect x={padLeft} y={padTop} width={plotW} height={plotH} />
        </ClipPath>
      </Defs>

      {/* Background Frame */}
      <Rect x={padLeft} y={padTop} width={plotW} height={plotH} fill="#f8fafc" rx={6} stroke="#cbd5e1" strokeWidth={1} />

      {/* Horizontal Y-Grid lines */}
      {yTicks.map((val, idx) => {
        const y = mapY(val);
        return (
          <G key={`y-grid-${idx}`}>
            <Line x1={padLeft} y1={y} x2={padLeft + plotW} y2={y} stroke="#e2e8f0" strokeWidth={1} strokeDasharray="3,3" />
            <SvgText x={padLeft - 8} y={y + 4} fontSize={10} fontWeight="700" fill="#64748b" textAnchor="end">
              {val.toFixed(unit === "in" ? 0 : 1)}
            </SvgText>
          </G>
        );
      })}

      {/* Vertical X-Grid lines */}
      {xTicks.map((val, idx) => {
        const x = mapX(val);
        return (
          <G key={`x-grid-${idx}`}>
            <Line x1={x} y1={padTop} x2={x} y2={padTop + plotH} stroke="#e2e8f0" strokeWidth={1} strokeDasharray="3,3" />
            <SvgText x={x} y={padTop + plotH + 16} fontSize={10} fontWeight="600" fill="#64748b" textAnchor="middle">
              {val}
            </SvgText>
          </G>
        );
      })}

      {/* Clipped Data Area: Curve and Sample Points */}
      <G clipPath="url(#scatterPlotClip)">
        {theoreticalPoints.length > 1 && (
          <Polyline points={theoreticalPolyline} fill="none" stroke="#ef4444" strokeWidth={2.4} strokeDasharray="5,4" />
        )}

        {convertedSamples.map((s) => {
          const cx = mapX(s.rssi);
          const cy = mapY(s.dist);
          return (
            <Circle
              key={`pt-${s.idx}`}
              cx={cx}
              cy={cy}
              r={5}
              fill="#2563eb"
              fillOpacity={0.8}
              stroke="#ffffff"
              strokeWidth={1.5}
              onPress={() => onSelectPoint && onSelectPoint(s)}
            />
          );
        })}
      </G>

      {/* Axis Labels */}
      <SvgText x={padLeft + plotW / 2} y={svgHeight - 8} fontSize={11} fontWeight="700" fill="#1e293b" textAnchor="middle">
        RSSI (dBm) → Closer to Right
      </SvgText>
      <SvgText
        x={14}
        y={padTop + plotH / 2}
        fontSize={11}
        fontWeight="700"
        fill="#1e293b"
        transform={`rotate(-90, 14, ${padTop + plotH / 2})`}
        textAnchor="middle"
      >
        Dist ({unit})
      </SvgText>
    </Svg>
  );
}

// ============================================================================
// SVG GRAPH 2: TIME SERIES DUAL-AXIS GRAPH (Auto-Adjusted)
// ============================================================================
function TimeSeriesDualGraph({
  samples = [],
  durationSec = 10,
  unit = "m",
  zoomLevel = 1.0,
  autoFit = true,
  containerWidth = 0,
}) {
  const screenWidth = Dimensions.get("window").width;
  const baseWidth = containerWidth > 150 ? containerWidth - 8 : Math.max(280, screenWidth - 68);
  const svgWidth = Math.round(baseWidth * zoomLevel);
  const svgHeight = 280;

  const padLeft = 58;
  const padRight = 50;
  const padTop = 24;
  const padBottom = 46;

  const plotW = Math.max(120, svgWidth - padLeft - padRight);
  const plotH = Math.max(120, svgHeight - padTop - padBottom);

  if (samples.length < 2) return null;

  const maxTime = Math.max(1, durationSec);

  const convertedSamples = samples.map((s) => ({
    t: s.t,
    dist: typeof s.distM === "number" && isFinite(s.distM) ? convertMeters(s.distM, unit) : null,
    rttDist: typeof s.rttDistM === "number" && isFinite(s.rttDistM) ? convertMeters(s.rttDistM, unit) : null,
    gtDist: typeof s.gtDistM === "number" && isFinite(s.gtDistM) ? convertMeters(s.gtDistM, unit) : null,
    rssi: s.filteredRssi,
  }));

  let maxDist = unit === "in" ? 100 : unit === "ft" ? 10 : 3.0;
  let minDist = 0;
  let minRssi = -95;
  let maxRssi = -35;

  if (convertedSamples.length > 0) {
    const validDists = convertedSamples.flatMap((s) => [s.dist, s.rttDist, s.gtDist].filter((v) => typeof v === "number" && isFinite(v)));
    const sMaxDist = validDists.length > 0 ? Math.max(...validDists) : 3.0;
    const sMinDist = validDists.length > 0 ? Math.min(...validDists) : 0;
    const sMinRssi = Math.min(...convertedSamples.map((s) => s.rssi));
    const sMaxRssi = Math.max(...convertedSamples.map((s) => s.rssi));

    if (autoFit) {
      maxDist = Math.max(unit === "in" ? 12 : unit === "ft" ? 1.2 : 0.4, Number((sMaxDist * 1.15).toFixed(2)));
      minDist = Math.max(0, Number((sMinDist * 0.85).toFixed(2)));
      minRssi = Math.max(-105, Math.floor(sMinRssi - 3));
      maxRssi = Math.min(-20, Math.ceil(sMaxRssi + 3));
    } else {
      maxDist = Math.max(maxDist, Number((sMaxDist * 1.12).toFixed(2)));
      minRssi = Math.min(minRssi, Math.floor(sMinRssi - 2));
      maxRssi = Math.max(maxRssi, Math.ceil(sMaxRssi + 2));
    }
  }

  const mapX = (t) => padLeft + (Math.max(0, Math.min(maxTime, t)) / maxTime) * plotW;
  const mapYDist = (d) =>
    padTop + plotH - ((Math.max(minDist, Math.min(maxDist, d)) - minDist) / Math.max(0.05, maxDist - minDist)) * plotH;
  const mapYRssi = (r) =>
    padTop + plotH - ((Math.max(minRssi, Math.min(maxRssi, r)) - minRssi) / Math.max(1, maxRssi - minRssi)) * plotH;

  const distPolyline = convertedSamples
    .filter((s) => s.dist !== null)
    .map((s) => `${mapX(s.t).toFixed(1)},${mapYDist(s.dist).toFixed(1)}`)
    .join(" ");

  const rttPolyline = convertedSamples
    .filter((s) => s.rttDist !== null)
    .map((s) => `${mapX(s.t).toFixed(1)},${mapYDist(s.rttDist).toFixed(1)}`)
    .join(" ");

  const gtPolyline = convertedSamples
    .filter((s) => s.gtDist !== null)
    .map((s) => `${mapX(s.t).toFixed(1)},${mapYDist(s.gtDist).toFixed(1)}`)
    .join(" ");

  const rssiPolyline = convertedSamples.map((s) => `${mapX(s.t).toFixed(1)},${mapYRssi(s.rssi).toFixed(1)}`).join(" ");

  return (
    <Svg width={svgWidth} height={svgHeight}>
      <Defs>
        <ClipPath id="timeSeriesClip">
          <Rect x={padLeft} y={padTop} width={plotW} height={plotH} />
        </ClipPath>
      </Defs>

      {/* Background Frame */}
      <Rect x={padLeft} y={padTop} width={plotW} height={plotH} fill="#f8fafc" rx={6} stroke="#cbd5e1" strokeWidth={1} />

      {/* Grid Lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
        const y = padTop + plotH * (1 - ratio);
        const distVal = (minDist + ratio * (maxDist - minDist)).toFixed(unit === "in" ? 0 : 1);
        const rssiVal = Math.round(minRssi + ratio * (maxRssi - minRssi));
        return (
          <G key={`dual-grid-${idx}`}>
            <Line x1={padLeft} y1={y} x2={padLeft + plotW} y2={y} stroke="#e2e8f0" strokeWidth={1} strokeDasharray="3,3" />
            <SvgText x={padLeft - 8} y={y + 4} fontSize={10} fontWeight="700" fill="#16a34a" textAnchor="end">
              {distVal}
            </SvgText>
            <SvgText x={padLeft + plotW + 8} y={y + 4} fontSize={10} fontWeight="700" fill="#9333ea" textAnchor="start">
              {rssiVal}
            </SvgText>
          </G>
        );
      })}

      {/* Clipped Multi Curves */}
      <G clipPath="url(#timeSeriesClip)">
        {/* Ground Truth Line (Amber Dashed) */}
        {gtPolyline.length > 0 && (
          <Polyline points={gtPolyline} fill="none" stroke="#d97706" strokeWidth={2} strokeDasharray="5,4" />
        )}

        {/* RSSI Distance Line (Green) */}
        {distPolyline.length > 0 && (
          <Polyline points={distPolyline} fill="none" stroke="#16a34a" strokeWidth={2.6} />
        )}

        {/* RTT Distance Line (Cyan) */}
        {rttPolyline.length > 0 && (
          <Polyline points={rttPolyline} fill="none" stroke="#0284c7" strokeWidth={2.6} />
        )}

        {/* RSSI Line (Purple) */}
        <Polyline points={rssiPolyline} fill="none" stroke="#9333ea" strokeWidth={2} strokeDasharray="4,2" />
      </G>

      {/* Time axis ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
        const x = padLeft + ratio * plotW;
        const timeVal = (ratio * maxTime).toFixed(0);
        return (
          <SvgText key={`time-tick-${idx}`} x={x} y={padTop + plotH + 16} fontSize={10} fontWeight="600" fill="#64748b" textAnchor="middle">
            {timeVal}s
          </SvgText>
        );
      })}

      {/* Left Axis Label: Distance */}
      <SvgText
        x={14}
        y={padTop + plotH / 2}
        fontSize={10.5}
        fontWeight="700"
        fill="#16a34a"
        transform={`rotate(-90, 14, ${padTop + plotH / 2})`}
        textAnchor="middle"
      >
        Dist ({unit})
      </SvgText>

      {/* Right Axis Label: RSSI */}
      <SvgText
        x={svgWidth - 6}
        y={padTop + plotH / 2}
        fontSize={10.5}
        fontWeight="700"
        fill="#9333ea"
        transform={`rotate(90, ${svgWidth - 6}, ${padTop + plotH / 2})`}
        textAnchor="middle"
      >
        RSSI (dBm)
      </SvgText>

      {/* Bottom Axis Label */}
      <SvgText x={padLeft + plotW / 2} y={svgHeight - 8} fontSize={11} fontWeight="700" fill="#1e293b" textAnchor="middle">
        Elapsed Test Time (Seconds)
      </SvgText>
    </Svg>
  );
}

// ============================================================================
// SVG GRAPH 3: RTT TIME-OF-FLIGHT GRAPH (Corrected Time in ns & Equivalent Dist)
// ============================================================================
function RttTimingGraph({
  samples = [],
  durationSec = 10,
  unit = "m",
  zoomLevel = 1.0,
  autoFit = true,
  containerWidth = 0,
}) {
  const screenWidth = Dimensions.get("window").width;
  const baseWidth = containerWidth > 150 ? containerWidth - 8 : Math.max(280, screenWidth - 68);
  const svgWidth = Math.round(baseWidth * zoomLevel);
  const svgHeight = 280;

  const padLeft = 60;
  const padRight = 55;
  const padTop = 24;
  const padBottom = 46;

  const plotW = Math.max(120, svgWidth - padLeft - padRight);
  const plotH = Math.max(120, svgHeight - padTop - padBottom);

  if (samples.length < 2) return null;

  const maxTime = Math.max(1, durationSec);

  const timingSamples = samples.map((s) => {
    const corrNs = typeof s.rttCorrNs === "number" && isFinite(s.rttCorrNs) ? s.rttCorrNs : 0;
    const rawNs = typeof s.rttRawNs === "number" && isFinite(s.rttRawNs) ? s.rttRawNs : 0;
    const gtDistM = typeof s.gtDistM === "number" && isFinite(s.gtDistM) ? s.gtDistM : 1.0;
    const idealNs = (2.0 * gtDistM) / SPEED_OF_LIGHT_M_NS;
    return {
      t: s.t,
      corrNs,
      rawNs,
      idealNs,
      equivDist: convertMeters((SPEED_OF_LIGHT_M_NS * corrNs) / 2.0, unit),
    };
  });

  const allNs = timingSamples.map((s) => s.corrNs);
  const minSampleNs = Math.min(...allNs, ...timingSamples.map((s) => s.idealNs));
  const maxSampleNs = Math.max(...allNs, ...timingSamples.map((s) => s.idealNs));

  let minNs = 0;
  let maxNs = 35; // ~5.2 meters default

  if (autoFit) {
    minNs = Math.max(0, Number((minSampleNs * 0.8).toFixed(1)));
    maxNs = Math.max(10, Number((maxSampleNs * 1.2).toFixed(1)));
  } else {
    maxNs = Math.max(maxNs, Number((maxSampleNs * 1.15).toFixed(1)));
  }

  const mapX = (t) => padLeft + (Math.max(0, Math.min(maxTime, t)) / maxTime) * plotW;
  const mapYNs = (ns) =>
    padTop + plotH - ((Math.max(minNs, Math.min(maxNs, ns)) - minNs) / Math.max(1, maxNs - minNs)) * plotH;

  const corrPolyline = timingSamples.map((s) => `${mapX(s.t).toFixed(1)},${mapYNs(s.corrNs).toFixed(1)}`).join(" ");
  const idealPolyline = timingSamples.map((s) => `${mapX(s.t).toFixed(1)},${mapYNs(s.idealNs).toFixed(1)}`).join(" ");

  return (
    <Svg width={svgWidth} height={svgHeight}>
      <Defs>
        <ClipPath id="rttTimingClip">
          <Rect x={padLeft} y={padTop} width={plotW} height={plotH} />
        </ClipPath>
      </Defs>

      {/* Frame */}
      <Rect x={padLeft} y={padTop} width={plotW} height={plotH} fill="#f0f9ff" rx={6} stroke="#bae6fd" strokeWidth={1} />

      {/* Grid Lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
        const y = padTop + plotH * (1 - ratio);
        const valNs = (minNs + ratio * (maxNs - minNs)).toFixed(1);
        const eqDist = convertMeters((SPEED_OF_LIGHT_M_NS * Number(valNs)) / 2.0, unit).toFixed(unit === "in" ? 0 : 1);
        return (
          <G key={`rtt-grid-${idx}`}>
            <Line x1={padLeft} y1={y} x2={padLeft + plotW} y2={y} stroke="#e0f2fe" strokeWidth={1} strokeDasharray="3,3" />
            <SvgText x={padLeft - 6} y={y + 4} fontSize={9.5} fontWeight="700" fill="#0284c7" textAnchor="end">
              {valNs}ns
            </SvgText>
            <SvgText x={padLeft + plotW + 6} y={y + 4} fontSize={9.5} fontWeight="700" fill="#64748b" textAnchor="start">
              {eqDist} {unit}
            </SvgText>
          </G>
        );
      })}

      {/* Curves */}
      <G clipPath="url(#rttTimingClip)">
        {/* Ideal ToF Line (Ground Truth) */}
        <Polyline points={idealPolyline} fill="none" stroke="#d97706" strokeWidth={2} strokeDasharray="5,4" />

        {/* Measured Corrected Time Line */}
        <Polyline points={corrPolyline} fill="none" stroke="#0284c7" strokeWidth={2.8} />

        {/* Sample Points */}
        {timingSamples.map((s, idx) => (
          <Circle
            key={`rtt-dot-${idx}`}
            cx={mapX(s.t)}
            cy={mapYNs(s.corrNs)}
            r={3}
            fill="#0284c7"
            stroke="#ffffff"
            strokeWidth={1}
          />
        ))}
      </G>

      {/* Time ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
        const x = padLeft + ratio * plotW;
        const timeVal = (ratio * maxTime).toFixed(0);
        return (
          <SvgText key={`rtt-tick-${idx}`} x={x} y={padTop + plotH + 16} fontSize={10} fontWeight="600" fill="#64748b" textAnchor="middle">
            {timeVal}s
          </SvgText>
        );
      })}

      {/* Labels */}
      <SvgText
        x={14}
        y={padTop + plotH / 2}
        fontSize={10.5}
        fontWeight="700"
        fill="#0284c7"
        transform={`rotate(-90, 14, ${padTop + plotH / 2})`}
        textAnchor="middle"
      >
        T_corrected (ns)
      </SvgText>

      <SvgText
        x={svgWidth - 6}
        y={padTop + plotH / 2}
        fontSize={10}
        fontWeight="700"
        fill="#64748b"
        transform={`rotate(90, ${svgWidth - 6}, ${padTop + plotH / 2})`}
        textAnchor="middle"
      >
        Equiv Dist ({unit})
      </SvgText>

      <SvgText x={padLeft + plotW / 2} y={svgHeight - 8} fontSize={11} fontWeight="700" fill="#1e293b" textAnchor="middle">
        Elapsed Test Time (Seconds)
      </SvgText>
    </Svg>
  );
}

// ============================================================================
// STYLES
// ============================================================================
const styles = StyleSheet.create({
  containerCard: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 14,
    marginTop: 14,
    borderWidth: 1,
    borderColor: "#d0d7de",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: "800",
    color: "#24292f",
  },
  subtitle: {
    fontSize: 12,
    color: "#57606a",
    marginTop: 3,
    lineHeight: 16,
  },
  liveTestBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ffebe9",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ff8182",
    gap: 5,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#cf222e",
  },
  liveTestText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#cf222e",
  },

  // Target Beacon selector bar
  targetBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f6f8fa",
    padding: 8,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#eaeef2",
    gap: 8,
  },
  targetLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#24292f",
  },
  targetNoneText: {
    fontSize: 12,
    color: "#8c959f",
    fontStyle: "italic",
  },
  targetPillsRow: {
    flexDirection: "row",
    gap: 6,
  },
  targetPill: {
    backgroundColor: "#ffffff",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#d0d7de",
    maxWidth: 150,
  },
  targetPillActive: {
    backgroundColor: "#1f6feb",
    borderColor: "#1f6feb",
  },
  targetPillText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#57606a",
  },
  targetPillTextActive: {
    color: "#ffffff",
    fontWeight: "700",
  },

  // Live Dashboard
  liveDashboard: {
    flexDirection: "row",
    backgroundColor: "#f0f8ff",
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#b6e3ff",
    justifyContent: "space-between",
  },
  liveMetricItem: {
    alignItems: "center",
    flex: 1,
  },
  liveMetricLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: "#57606a",
    marginBottom: 2,
  },
  liveMetricVal: {
    fontSize: 15,
    fontWeight: "800",
    color: "#24292f",
  },

  // Action Buttons
  actionBtnRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  testBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  btnStartTest: {
    backgroundColor: "#1f6feb",
  },
  btnStartTestText: {
    color: "#ffffff",
    fontWeight: "800",
    fontSize: 14,
  },
  btnEndTest: {
    backgroundColor: "#cf222e",
  },
  btnEndTestText: {
    color: "#ffffff",
    fontWeight: "800",
    fontSize: 14,
  },
  btnClearHistory: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#d0d7de",
    backgroundColor: "#ffffff",
    justifyContent: "center",
  },
  btnClearHistoryText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#57606a",
  },

  // Results Container
  resultsContainer: {
    marginTop: 6,
  },
  historySelectorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  historySelectorLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#57606a",
  },
  runPill: {
    backgroundColor: "#f6f8fa",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#d0d7de",
    marginRight: 6,
  },
  runPillActive: {
    backgroundColor: "#0969da",
    borderColor: "#0969da",
  },
  runPillText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#57606a",
  },
  runPillTextActive: {
    color: "#ffffff",
    fontWeight: "700",
  },

  // Graph Tab Switcher
  graphTabBar: {
    flexDirection: "row",
    backgroundColor: "#eaeef2",
    borderRadius: 8,
    padding: 3,
    marginBottom: 8,
    gap: 4,
  },
  graphTabBtn: {
    flex: 1,
    paddingVertical: 7,
    alignItems: "center",
    borderRadius: 6,
  },
  graphTabBtnActive: {
    backgroundColor: "#ffffff",
    elevation: 1,
  },
  graphTabText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#57606a",
  },
  graphTabTextActive: {
    color: "#1f6feb",
  },

  // Zoom Toolbar
  zoomToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#f6f8fa",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    flexWrap: "wrap",
    gap: 6,
  },
  zoomLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#475569",
  },
  zoomBtn: {
    width: 26,
    height: 26,
    borderRadius: 4,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    alignItems: "center",
    justifyContent: "center",
  },
  zoomBtnText: {
    fontSize: 16,
    fontWeight: "800",
    color: "#1e293b",
  },
  zoomValueText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#0f172a",
    minWidth: 32,
    textAlign: "center",
  },
  autoFitBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  autoFitBtnActive: {
    backgroundColor: "#1f6feb",
    borderColor: "#1f6feb",
  },
  autoFitBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#475569",
  },
  autoFitBtnTextActive: {
    color: "#ffffff",
  },

  // Tooltip
  tooltipBox: {
    backgroundColor: "#eff6ff",
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#bfdbfe",
  },
  tooltipTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: "#1e40af",
  },
  tooltipBody: {
    fontSize: 12,
    color: "#1e293b",
    marginTop: 2,
  },

  graphBox: {
    backgroundColor: "#ffffff",
    alignItems: "center",
    paddingVertical: 6,
  },
  graphLegendRow: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 8,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendDash: {
    width: 14,
    borderBottomWidth: 2,
  },
  legendLabel: {
    fontSize: 10.5,
    color: "#475569",
    fontWeight: "600",
  },
  graphFootnote: {
    fontSize: 10,
    color: "#64748b",
    marginTop: 6,
    textAlign: "left",
    alignSelf: "stretch",
    lineHeight: 14,
  },

  // Stats Card
  statsCard: {
    backgroundColor: "#f8fafc",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  statsCardTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1e293b",
    marginBottom: 4,
  },
  statsCardSub: {
    fontSize: 11,
    color: "#64748b",
    marginBottom: 10,
    lineHeight: 15,
  },
  evalTable: {
    backgroundColor: "#ffffff",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    overflow: "hidden",
  },
  evalTableRowHeader: {
    flexDirection: "row",
    backgroundColor: "#f1f5f9",
    borderBottomWidth: 1,
    borderColor: "#cbd5e1",
    paddingVertical: 7,
    paddingHorizontal: 8,
  },
  evalTableRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: "#f1f5f9",
    paddingVertical: 7,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  evalTableCell: {
    flex: 1,
    fontSize: 11,
  },
  evalHeaderCell: {
    fontWeight: "800",
    color: "#334155",
  },
  evalLabelCell: {
    fontWeight: "600",
    color: "#475569",
  },
  evalValCell: {
    fontWeight: "700",
    color: "#0f172a",
    textAlign: "right",
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  statCell: {
    flexGrow: 1,
    minWidth: 130,
    backgroundColor: "#ffffff",
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  statCellLabel: {
    fontSize: 10,
    color: "#64748b",
    fontWeight: "600",
  },
  statCellVal: {
    fontSize: 14,
    fontWeight: "800",
    color: "#0f172a",
    marginTop: 3,
  },

  noResultsBox: {
    padding: 16,
    alignItems: "center",
    backgroundColor: "#f8fafc",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderStyle: "dashed",
  },
  noResultsText: {
    fontSize: 12,
    color: "#64748b",
    textAlign: "center",
    lineHeight: 18,
  },
});
