// ============================================================================
// BEACON SIGNAL LAB SCREEN (VERSION 2)
// High-precision BLE Beacon scanner & real-time signal analysis laboratory.
// Features:
//   1. Sleek Cyber-Industrial Dark Theme matching Fusion Map
//   2. Real-time 1-Meter RSSI Calibration Studio & Calculator (Auto-samples,
//      calculates median/mean/stdDev, and applies accurate TxPower@1m)
//   3. Live Surrounding Beacons Radar with visual signal bars & quick actions
//   4. 6-Stage Filtered Distance Navigation Hub with unit switching
//   5. Confidence-Squared Weighted Position Estimation (w = C²)
//   6. Real-time SVG RSSI Spectrum Time-Series Graph (Dark Theme)
//   7. Multi-Point OLS Path-Loss Regression Studio
//   8. Live Packet Stream Log
// ============================================================================

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  Alert,
  Dimensions,
  Platform,
} from "react-native";
import { v2Scanner } from "../../services/v2BeaconScannerService.js";
import {
  RangingCalibrationSession,
  RANGING_CALIB_CONFIG,
  checkRangeGeometry,
} from "../../services/BeaconRangingCalibration.js";
import RssiSignalGraph from "./RssiSignalGraph.js";

const FT_PER_M = 3.28084;

const { width: SCREEN_WIDTH } = Dimensions.get("window");

export default function BeaconSignalLabScreen() {
  const [isScanning, setIsScanning] = useState(false);
  const [stats, setStats] = useState(v2Scanner.getStats());
  const [graphData, setGraphData] = useState({ b1: [], b2: [] });
  const [packetLog, setPacketLog] = useState([]);
  const [discoveredList, setDiscoveredList] = useState([]);
  const [beaconsOnlyFilter, setBeaconsOnlyFilter] = useState(false);
  const [nameOnlyFilter, setNameOnlyFilter] = useState(false);

  // Navigation Hub options
  const [distanceUnit, setDistanceUnit] = useState(stats.distanceUnit || "m");
  const [pathLossN, setPathLossN] = useState(stats.pathLossN || 2.2);

  // Graph display options
  const [graphMode, setGraphMode] = useState("both"); // "raw" | "both" | "filtered"
  const [windowSec, setWindowSec] = useState(20); // 15, 20, 30
  const [isGraphPaused, setIsGraphPaused] = useState(false);

  // Active section tab selector for quick navigation
  const [activeTab, setActiveTab] = useState("all"); // "all" | "calib1m" | "radar" | "nav" | "graph"

  // ---------------------------------------------------------------------------
  // 1-METER RSSI CALIBRATION STUDIO STATE
  // ---------------------------------------------------------------------------
  const [calib1mTarget, setCalib1mTarget] = useState(1); // 1 (B1) or 2 (B2)
  const [isSampling1m, setIsSampling1m] = useState(false);
  const [samples1m, setSamples1m] = useState([]);
  const [targetSampleCount, setTargetSampleCount] = useState(25);
  const [calib1mResult, setCalib1mResult] = useState(null);
  const [applied1mSuccess, setApplied1mSuccess] = useState(null);

  // Multi-point OLS Calibration Studio state
  const [calibTarget, setCalibTarget] = useState(1); // 1 or 2
  const [customCalibDist, setCustomCalibDist] = useState("1.0");

  // Position baseline (nominal 5.0m distance between B1 at (0,0) and B2 at (5,0))
  const [baselineDistM, setBaselineDistM] = useState(5.0);

  // ---------------------------------------------------------------------------
  // TWO-STAND GEOMETRIC RANGING CALIBRATION STATE
  // The session holds raw samples and is therefore kept in a ref, not state:
  // it is written to on every BLE packet, several times a second, and nothing
  // in the render output depends on the individual samples - only on the
  // progress counters, which are read on a timer.
  // ---------------------------------------------------------------------------
  const geoSessionRef = useRef(null);
  const [geoBaselineInput, setGeoBaselineInput] = useState("");
  const [geoBaselineFromPlan, setGeoBaselineFromPlan] = useState(null);
  const [geoActiveStand, setGeoActiveStand] = useState(null); // 1 | 2 | null
  const [geoProgress, setGeoProgress] = useState(null);
  const [geoStandsDone, setGeoStandsDone] = useState({ 1: false, 2: false });
  const [geoResult, setGeoResult] = useState(null);
  const [geoApplied, setGeoApplied] = useState(false);

  // Periodic UI refresh loop (100ms / 10 FPS)
  const tickerRef = useRef(null);

  useEffect(() => {
    const unsubStatus = v2Scanner.subscribeStatus((scanning) => {
      setIsScanning(scanning);
    });

    const unsubStats = v2Scanner.subscribeStats((newStats) => {
      setStats(newStats);
      if (newStats.distanceUnit) setDistanceUnit(newStats.distanceUnit);
      if (newStats.pathLossN) setPathLossN(newStats.pathLossN);
    });

    const unsubDiscovered = v2Scanner.subscribeDiscovered((list) => {
      setDiscoveredList(list);
    });

    tickerRef.current = setInterval(() => {
      if (!isGraphPaused) {
        setGraphData(v2Scanner.getGraphHistory());
        setPacketLog(v2Scanner.getPacketLog().slice(0, 20));
      }
    }, 100);

    return () => {
      unsubStatus();
      unsubStats();
      unsubDiscovered();
      if (tickerRef.current) clearInterval(tickerRef.current);
    };
  }, [isGraphPaused]);

  // ---------------------------------------------------------------------------
  // 1-METER RSSI SAMPLING PACKET LISTENER
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isSampling1m) return;

    const unsubPacket = v2Scanner.subscribePackets((pkt) => {
      if (pkt.beaconNum === calib1mTarget) {
        setSamples1m((prev) => {
          const next = [...prev, pkt.rawRssi];
          if (next.length >= targetSampleCount) {
            // Sampling target reached! Calculate statistics
            setIsSampling1m(false);
            process1mCalibration(next);
          }
          return next;
        });
      }
    });

    return () => {
      unsubPacket();
    };
  }, [isSampling1m, calib1mTarget, targetSampleCount]);

  // ---------------------------------------------------------------------------
  // TWO-STAND GEOMETRIC RANGING CALIBRATION
  //
  // Pre-fills the baseline from the floor plan the user already laid out on the
  // Fusion Map. That saved separation is the one length in the whole system
  // that is known exactly, and it is what makes calibrating both beacons
  // possible without measuring anything by hand.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const anchors = await v2Scanner.getBeaconAnchors();
        if (!alive || !anchors) return;
        const ft = Math.hypot(anchors.b2.x - anchors.b1.x, anchors.b2.y - anchors.b1.y);
        if (!Number.isFinite(ft) || ft <= 0) return;
        const metres = ft / FT_PER_M;
        setGeoBaselineFromPlan(metres);
        setGeoBaselineInput((prev) => (prev ? prev : metres.toFixed(2)));
      } catch (e) {
        console.warn("[BeaconLab] anchor load failed:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const finishGeoStand = useCallback(() => {
    const session = geoSessionRef.current;
    setGeoActiveStand(null);
    setGeoProgress(null);
    if (!session) return;
    const committed = session.commitStand();
    if (!committed.ok) {
      Alert.alert("Stand Not Recorded", committed.error);
      return;
    }
    setGeoStandsDone({ 1: Boolean(session.stands[1]), 2: Boolean(session.stands[2]) });
    if (session.isComplete()) {
      const solved = session.solve();
      if (!solved.ok) {
        Alert.alert("Could Not Solve", solved.error);
        return;
      }
      setGeoResult(solved);
      setGeoApplied(false);
    }
  }, []);

  useEffect(() => {
    if (!geoActiveStand) return;
    const session = geoSessionRef.current;
    if (!session) return;

    const unsubPacket = v2Scanner.subscribePackets((pkt) => {
      if (pkt.beaconNum !== 1 && pkt.beaconNum !== 2) return;
      // Fit against the level ranging consumes, not the raw or merely-filtered
      // one, so the calibrated model and the live model see the same input.
      const level = Number.isFinite(pkt.rangingRssi)
        ? pkt.rangingRssi
        : Number.isFinite(pkt.filteredRssi)
        ? pkt.filteredRssi
        : pkt.rawRssi;
      session.addSample(pkt.beaconNum, level);
    });

    // Progress is polled rather than pushed: packets arrive several times a
    // second from each beacon, and re-rendering the card on every one of them
    // would cost far more than it shows.
    const timer = setInterval(() => {
      const p = session.standProgress();
      setGeoProgress(p);
      if (p.done) {
        finishGeoStand();
      } else if (p.timedOut) {
        session.cancelStand();
        setGeoActiveStand(null);
        setGeoProgress(null);
        Alert.alert(
          "Not Enough Packets",
          "One of the beacons barely reached the phone during that stand (B1 " +
            p.counts[1] + ", B2 " + p.counts[2] + ").\n\n" +
            "Hold the phone at chest height, keep your body out of the straight " +
            "line to each beacon, and make sure both are powered and in range."
        );
      }
    }, 250);

    return () => {
      unsubPacket();
      clearInterval(timer);
    };
  }, [geoActiveStand, finishGeoStand]);

  const handleGeoStartStand = async (standAt) => {
    if (!stats.beacon1Id || !stats.beacon2Id) {
      Alert.alert(
        "Select Both Beacons",
        "Ranging calibration measures the two beacons against each other, so both " +
          "B1 and B2 must be selected in the devices list first."
      );
      return;
    }
    if (!isScanning) {
      const res = await v2Scanner.startScan();
      if (!res?.success) {
        Alert.alert("Scan Required", res?.error || "Enable Bluetooth and Location first.");
        return;
      }
    }
    const baselineM = parseFloat(geoBaselineInput);
    if (!Number.isFinite(baselineM) || baselineM < RANGING_CALIB_CONFIG.MIN_BASELINE_M) {
      Alert.alert(
        "Beacon Separation Needed",
        "Enter how far apart the two beacons are - at least " +
          RANGING_CALIB_CONFIG.MIN_BASELINE_M + " m. Any closer and the two reference " +
          "readings are too similar to tell the signal decay rate apart from " +
          "measurement noise."
      );
      return;
    }

    let session = geoSessionRef.current;
    if (!session) {
      session = new RangingCalibrationSession(baselineM);
      geoSessionRef.current = session;
    }
    session.setBaseline(baselineM);
    // The phone has just been carried to a different spot, so both beacons'
    // peak-hold shadow envelopes are stale: the one we walked away from still
    // holds its 1 m peak and would add up to 9 dB of phantom fade correction
    // to every sample of this stand.
    v2Scanner.resetShadowEnvelopes();
    const begun = session.beginStand(standAt);
    if (!begun.ok) {
      Alert.alert("Cannot Start", begun.error);
      return;
    }
    setGeoResult(null);
    setGeoApplied(false);
    setGeoProgress(session.standProgress());
    setGeoActiveStand(standAt);
  };

  const handleGeoCancelStand = () => {
    if (geoSessionRef.current) geoSessionRef.current.cancelStand();
    setGeoActiveStand(null);
    setGeoProgress(null);
  };

  const handleGeoReset = () => {
    geoSessionRef.current = null;
    setGeoActiveStand(null);
    setGeoProgress(null);
    setGeoStandsDone({ 1: false, 2: false });
    setGeoResult(null);
    setGeoApplied(false);
  };

  const handleGeoApply = () => {
    if (!geoResult) return;
    const res = v2Scanner.applyGeometricCalibration(geoResult);
    if (!res.success) {
      Alert.alert("Apply Failed", res.error);
      return;
    }
    setGeoApplied(true);
    const f1 = geoResult.beacons[1];
    const f2 = geoResult.beacons[2];
    Alert.alert(
      "Ranging Calibrated",
      "Beacon 1   Tx@1m " + f1.txPower1m + " dBm   n " + f1.n + "\n" +
        "Beacon 2   Tx@1m " + f2.txPower1m + " dBm   n " + f2.n + "\n\n" +
        "Both beacons now use their own measured model instead of one shared guess. " +
        "Distances should agree with each other, and with the floor plan, straight away."
    );
  };

  // Compute 1m statistics from collected samples
  const process1mCalibration = (samples) => {
    if (!samples || samples.length === 0) return;
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = samples.reduce((acc, v) => acc + v, 0);
    const mean = sum / samples.length;
    const median =
      sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    const variance = samples.reduce((acc, v) => acc + (v - mean) ** 2, 0) / samples.length;
    const stdDev = Math.sqrt(variance);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];

    // Outlier-resistant recommended TxPower@1m: use median rounded to 1 decimal
    const recommendedTx = Number(median.toFixed(1));

    setCalib1mResult({
      count: samples.length,
      mean: Number(mean.toFixed(1)),
      median: Number(median.toFixed(1)),
      stdDev: Number(stdDev.toFixed(1)),
      min,
      max,
      recommendedTx,
      timestamp: Date.now(),
    });
  };

  const handleStart1mSampling = async () => {
    if (!isScanning) {
      const res = await v2Scanner.startScan();
      if (!res?.success) {
        Alert.alert(
          "Scan Required",
          res?.error || "Please enable Bluetooth and Location to begin 1m RSSI sampling."
        );
        return;
      }
    }
    const targetId = calib1mTarget === 1 ? stats.beacon1Id : stats.beacon2Id;
    if (!targetId) {
      Alert.alert(
        "Beacon Not Selected",
        `Please select Beacon ${calib1mTarget} from the devices list below before starting 1-meter calibration.`
      );
      return;
    }
    setSamples1m([]);
    setCalib1mResult(null);
    setApplied1mSuccess(null);
    setIsSampling1m(true);
  };

  const handleStop1mSamplingEarly = () => {
    setIsSampling1m(false);
    if (samples1m.length >= 3) {
      process1mCalibration(samples1m);
    } else {
      Alert.alert("Too Few Samples", "Need at least 3 samples to calculate 1-meter RSSI.");
    }
  };

  const handleApply1mCalibration = () => {
    if (!calib1mResult) return;
    const res = v2Scanner.set1MeterTxPower(calib1mTarget, calib1mResult.recommendedTx);
    if (res.success) {
      setApplied1mSuccess({
        beaconNum: calib1mTarget,
        txPower: calib1mResult.recommendedTx,
      });
      Alert.alert(
        "1-Meter TxPower Applied! 🎯",
        `Beacon ${calib1mTarget} 1m reference RSSI set to ${calib1mResult.recommendedTx} dBm.\n\n` +
        `Calculated distance will now accurately read 1.00m at this distance.`
      );
    }
  };

  // Primary Scan Controls
  const handleToggleScan = async () => {
    if (isScanning) {
      v2Scanner.stopScan();
      if (isSampling1m) setIsSampling1m(false);
    } else {
      const res = await v2Scanner.startScan();
      if (!res?.success) {
        Alert.alert(
          "Scan Could Not Start",
          res?.error || "Please ensure Bluetooth and Location are enabled on your phone."
        );
      }
    }
  };

  const handleClear = () => {
    v2Scanner.clearBuffers();
    setGraphData({ b1: [], b2: [] });
    setPacketLog([]);
    setDiscoveredList([]);
    setSamples1m([]);
    setCalib1mResult(null);
    setApplied1mSuccess(null);
  };

  const handleSwapBeacons = () => {
    const res = v2Scanner.swapBeacons();
    if (!res?.success) {
      Alert.alert("Cannot Swap", res?.error || "Select both B1 and B2 first.");
      return;
    }
    // Graph history is per-slot, so clear the local copy to avoid briefly
    // drawing the old slot's trace under the new label.
    setGraphData({ b1: [], b2: [] });
  };

  const handleMatchBeacons = () => {
    Alert.alert(
      "Match Both Beacons",
      "Stand where BOTH beacons are the same distance away (e.g. exactly midway between them), hold still, then tap Match.\n\nThis cancels the hardware power difference between the two units so equal distances read equal.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Match Now",
          onPress: () => {
            const res = v2Scanner.matchBeaconPair();
            if (!res?.success) {
              Alert.alert("Cannot Match", res?.error || "Both beacons need a live signal.");
              return;
            }
            Alert.alert(
              "Beacons Matched",
              `Measured power difference: ${res.deltaDb} dB\n\n` +
                `B1 Tx@1m → ${res.b1TxPower} dBm\nB2 Tx@1m → ${res.b2TxPower} dBm\n\n` +
                `Both should now report the same distance from this spot.`
            );
          },
        },
      ]
    );
  };

  const handleTxChange = (beaconNum, val) => {
    const num = parseFloat(val);
    if (!isNaN(num) && num < 0 && num > -100) {
      v2Scanner.set1MeterTxPower(beaconNum, num);
    }
  };

  const handleUnitChange = (u) => {
    setDistanceUnit(u);
    v2Scanner.setDistanceUnit(u);
  };

  const handleNChange = (nVal) => {
    setPathLossN(nVal);
    v2Scanner.setPathLossN(nVal);
  };

  // Multi-point OLS Calibration handlers
  const handleAddCalibPoint = (distM) => {
    const num = parseFloat(distM);
    if (isNaN(num) || num <= 0) {
      Alert.alert("Invalid Distance", "Please enter a valid positive distance in meters.");
      return;
    }
    const res = v2Scanner.logCalibrationPoint(calibTarget, num);
    if (!res.success) {
      Alert.alert("Calibration Error", res.error);
    }
  };

  const handleFitModel = () => {
    const res = v2Scanner.fitPathLossModel(calibTarget);
    if (!res.success) {
      Alert.alert("OLS Regression Error", res.error);
    } else {
      Alert.alert(
        "Calibration Saved!",
        `Fitted n = ${res.n}\nCalibrated TxPower@1m = ${res.txPower1m} dBm\nR² Goodness = ${res.rSquared}\nPoints used: ${res.pointCount}`
      );
    }
  };

  const handleClearCalib = () => {
    v2Scanner.clearCalibration(calibTarget);
  };

  const formatDist = (meters, unit = "m") => {
    if (meters === null || meters === undefined || !Number.isFinite(meters)) return { value: "—", label: unit };
    if (unit === "ft") {
      return { value: (meters * 3.28084).toFixed(2), label: "ft" };
    }
    if (unit === "in") {
      return { value: (meters * 39.3701).toFixed(1), label: "in" };
    }
    return { value: meters.toFixed(2), label: "m" };
  };

  const b1 = stats?.b1 || {};
  const b2 = stats?.b2 || {};
  const targetBeaconsOnly = stats?.targetBeaconsOnly !== false;

  // Confidence-squared anchor weights: w_i = C_i^2
  const b1Conf = Number.isFinite(b1.confidenceScore) ? b1.confidenceScore : 0.5;
  const b2Conf = Number.isFinite(b2.confidenceScore) ? b2.confidenceScore : 0.5;
  const b1Weight = Number(Math.max(1e-4, b1Conf ** 2));
  const b2Weight = Number(Math.max(1e-4, b2Conf ** 2));
  const totalWeight = b1Weight + b2Weight;
  const b1WeightPct = totalWeight > 0 ? Math.max(1, Math.min(99, Math.round((b1Weight / totalWeight) * 100))) : 50;
  const b2WeightPct = totalWeight > 0 ? 100 - b1WeightPct : 50;

  // Live Confidence-Weighted Position Estimate (w_i = C_i^2)
  const weightedPos = useMemo(() => {
    if (!stats?.beacon1Id || !stats?.beacon2Id) return null;
    try {
      return v2Scanner.computeWeightedPosition([
        { beaconId: stats.beacon1Id, x: 0, y: 0 },
        { beaconId: stats.beacon2Id, x: baselineDistM, y: 0 },
      ]);
    } catch (e) {
      console.warn("[BeaconLab] computeWeightedPosition error:", e);
      return null;
    }
  }, [stats?.beacon1Id, stats?.beacon2Id, b1?.confidenceScore, b2?.confidenceScore, b1?.distanceM, b2?.distanceM, baselineDistM]);

  const rawCalibState = v2Scanner.getCalibrationState(calibTarget);
  const activeCalibState = rawCalibState || {
    referencePoints: [],
    fittedN: 2.2,
    fittedTxPower1m: -59,
    rSquared: null,
    isCalibrated: false,
  };

  // Helper to determine if a device broadcasts a valid human-readable name
  const hasValidName = (dev) => {
    if (!dev) return false;
    if (dev.hasRealName !== undefined) return Boolean(dev.hasRealName);
    if (!dev.name || typeof dev.name !== "string") return false;
    const n = dev.name.trim();
    if (n.length === 0) return false;
    if (n.startsWith("Device (")) return false;
    if (n.toLowerCase().startsWith("unnamed")) return false;
    if (n.toLowerCase() === "unknown") return false;
    if (n === dev.id) return false;
    return true;
  };

  // Filter list by user preference (all, beacons only, and/or name only)
  const displayList = Array.isArray(discoveredList)
    ? discoveredList.filter((d) => {
        if (!d) return false;
        if (beaconsOnlyFilter && !d.isBeacon) return false;
        if (nameOnlyFilter && !hasValidName(d)) return false;
        return true;
      })
    : [];

  // Helper for signal strength visual meter
  const renderSignalMeter = (rssi) => {
    const clamped = Math.max(-100, Math.min(-30, Number.isFinite(rssi) ? rssi : -100));
    // -100 dBm = 0%, -30 dBm = 100%
    const pct = Math.round(((clamped - -100) / 70) * 100);
    const color =
      rssi >= -65 ? "#3fb950" : rssi >= -80 ? "#d29922" : "#f85149";

    return (
      <View style={styles.signalMeterContainer}>
        <View style={styles.signalMeterTrack}>
          <View style={[styles.signalMeterFill, { width: `${pct}%`, backgroundColor: color }]} />
        </View>
        <Text style={[styles.signalMeterText, { color }]}>{pct}%</Text>
      </View>
    );
  };

  const activeTargetBeacon = calib1mTarget === 1 ? b1 : b2;

  // Live geometric self-check. The distance between the beacons is the only
  // length in the system known exactly, so the triangle inequality against it
  // is proof of a calibration fault rather than evidence of one - it cannot
  // false-alarm on noise the way a statistical test would.
  const geoHealth = useMemo(() => {
    const baselineM = parseFloat(geoBaselineInput);
    if (!Number.isFinite(baselineM) || baselineM <= 0) return null;
    if (!Number.isFinite(b1.distanceM) || !Number.isFinite(b2.distanceM)) return null;
    return checkRangeGeometry(b1.distanceM, b2.distanceM, baselineM);
  }, [b1.distanceM, b2.distanceM, geoBaselineInput]);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.container}>
      {/* ── 1. Screen Header ── */}
      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <View style={styles.badgeV2}>
            <Text style={styles.badgeV2Text}>VERSION 2 • SIGNAL LAB</Text>
          </View>
          <View style={[styles.statusPill, isScanning ? styles.statusPillActive : styles.statusPillIdle]}>
            <View style={[styles.statusDot, { backgroundColor: isScanning ? "#3fb950" : "#8b949e" }]} />
            <Text style={[styles.statusPillText, { color: isScanning ? "#3fb950" : "#8b949e" }]}>
              {isScanning ? "LIVE SCANNING" : "STANDBY"}
            </Text>
          </View>
        </View>
        <Text style={styles.headerTitle}>Beacon Signal Lab & Calibration</Text>
        <Text style={styles.headerSub}>
          Precision @1m RSSI Calculator • 6-Stage Filter Pipeline • Live Spectrum
        </Text>
      </View>

      {/* ── 2. Primary Scan Controls & Stat Banner ── */}
      <View style={styles.scanControlRow}>
        <Pressable
          style={[styles.mainScanBtn, isScanning ? styles.mainScanBtnActive : styles.mainScanBtnIdle]}
          onPress={handleToggleScan}
        >
          <Text style={styles.mainScanBtnText}>
            {isScanning ? "⏹ Stop BLE Scan" : "▶ Start BLE Scan"}
          </Text>
        </Pressable>

        <Pressable style={styles.clearBtn} onPress={handleClear}>
          <Text style={styles.clearBtnText}>🗑 Clear</Text>
        </Pressable>
      </View>

      {/* Quick Status Stats Strip */}
      <View style={styles.statStrip}>
        <View style={styles.statStripItem}>
          <Text style={styles.statStripLabel}>DEVICES</Text>
          <Text style={styles.statStripValue}>{discoveredList.length}</Text>
        </View>
        <View style={styles.statStripDivider} />
        <View style={styles.statStripItem}>
          <Text style={styles.statStripLabel}>PACKETS</Text>
          <Text style={styles.statStripValue}>{stats.totalPacketsReceived || 0}</Text>
        </View>
        <View style={styles.statStripDivider} />
        <View style={styles.statStripItem}>
          <Text style={styles.statStripLabel}>B1 DIST</Text>
          <Text style={[styles.statStripValue, { color: "#38bdf8" }]}>
            {formatDist(b1.distanceM, distanceUnit).value}
            <Text style={{ fontSize: 10 }}>{formatDist(b1.distanceM, distanceUnit).label}</Text>
          </Text>
        </View>
        <View style={styles.statStripDivider} />
        <View style={styles.statStripItem}>
          <Text style={styles.statStripLabel}>B2 DIST</Text>
          <Text style={[styles.statStripValue, { color: "#c084fc" }]}>
            {formatDist(b2.distanceM, distanceUnit).value}
            <Text style={{ fontSize: 10 }}>{formatDist(b2.distanceM, distanceUnit).label}</Text>
          </Text>
        </View>
      </View>

      {/* ── 3. FEATURED: TWO-STAND GEOMETRIC RANGING CALIBRATION ── */}
      <View style={styles.geoCard}>
        <View style={styles.geoHeader}>
          <View style={styles.geoIconBadge}>
            <Text style={{ fontSize: 20 }}>📐</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={styles.geoTitle}>Ranging Calibration</Text>
              <View style={styles.geoHeroTag}>
                <Text style={styles.geoHeroTagText}>FIXES WRONG DISTANCES</Text>
              </View>
            </View>
            <Text style={styles.geoSub}>
              Two 20-second stands. No tape measure needed.
            </Text>
          </View>
        </View>

        {/* Why */}
        <View style={styles.geoWhyBox}>
          <Text style={styles.geoWhyText}>
            If one beacon reads 8 m and the other 24 m from the same spot, that is not
            noise — the two radios transmit at different strengths and sit behind
            different obstacles, so each needs its own distance model. This measures
            both, using the gap between the beacons on your floor plan as the ruler.
          </Text>
        </View>

        {/* Live geometry health */}
        {geoHealth && !geoHealth.ok && (
          <View style={styles.geoAlertBox}>
            <Text style={styles.geoAlertTitle}>⚠ Ranging is geometrically impossible</Text>
            <Text style={styles.geoAlertText}>{geoHealth.issues[0].message}</Text>
          </View>
        )}
        {geoHealth && geoHealth.ok && (
          <View style={styles.geoOkBox}>
            <Text style={styles.geoOkText}>
              ✓ Ranges are consistent with the {geoHealth.baseline} m beacon gap
              (sum {geoHealth.sum} m, difference {geoHealth.diff} m)
            </Text>
          </View>
        )}

        {/* Baseline */}
        <View style={styles.geoBaselineRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.geoFieldLabel}>DISTANCE BETWEEN THE TWO BEACONS</Text>
            <Text style={styles.geoFieldHint}>
              {geoBaselineFromPlan !== null
                ? "From your Fusion Map layout — override if the beacons have moved."
                : "Place both beacons on the Fusion Map to fill this in automatically."}
            </Text>
          </View>
          <View style={styles.geoBaselineInputWrap}>
            <TextInput
              style={styles.geoBaselineInput}
              value={geoBaselineInput}
              onChangeText={setGeoBaselineInput}
              keyboardType="decimal-pad"
              placeholder="10.0"
              placeholderTextColor="#484f58"
              editable={!geoActiveStand}
            />
            <Text style={styles.geoBaselineUnit}>m</Text>
          </View>
        </View>

        {/* Stands */}
        {[1, 2].map((standAt) => {
          const done = geoStandsDone[standAt];
          const active = geoActiveStand === standAt;
          const accent = standAt === 1 ? "#38bdf8" : "#c084fc";
          return (
            <View
              key={standAt}
              style={[
                styles.geoStandRow,
                active && { borderColor: accent, backgroundColor: "rgba(56,189,248,0.06)" },
                done && !active && styles.geoStandRowDone,
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.geoStandTitle, { color: accent }]}>
                  {done ? "✓ " : ""}Stand {standAt} — at Beacon {standAt}
                </Text>
                <Text style={styles.geoStandHint}>
                  Stand about 1 m in front of Beacon {standAt}, phone at chest height,
                  facing it. Stay still.
                </Text>
                {active && geoProgress && (
                  <>
                    <View style={styles.geoProgressTrack}>
                      <View
                        style={[
                          styles.geoProgressFill,
                          { width: (geoProgress.progress * 100).toFixed(0) + "%", backgroundColor: accent },
                        ]}
                      />
                    </View>
                    <Text style={styles.geoProgressText}>
                      {geoProgress.settling
                        ? "Letting the signal settle after the walk over…"
                        : "B1 " + geoProgress.counts[1] + " · B2 " + geoProgress.counts[2] +
                          " packets of " + RANGING_CALIB_CONFIG.TARGET_SAMPLES_PER_BEACON}
                    </Text>
                  </>
                )}
              </View>
              {active ? (
                <Pressable style={styles.geoStandCancelBtn} onPress={handleGeoCancelStand}>
                  <Text style={styles.geoStandCancelText}>Cancel</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={[
                    styles.geoStandBtn,
                    { borderColor: accent },
                    geoActiveStand && styles.geoStandBtnDisabled,
                  ]}
                  disabled={Boolean(geoActiveStand)}
                  onPress={() => handleGeoStartStand(standAt)}
                >
                  <Text style={[styles.geoStandBtnText, { color: accent }]}>
                    {done ? "Redo" : "Start"}
                  </Text>
                </Pressable>
              )}
            </View>
          );
        })}

        {/* Result */}
        {geoResult && (
          <View style={styles.geoResultBox}>
            <Text style={styles.geoResultTitle}>MEASURED MODELS</Text>
            {[1, 2].map((num) => {
              const fit = geoResult.beacons[num];
              const accent = num === 1 ? "#38bdf8" : "#c084fc";
              return (
                <View key={num} style={styles.geoResultRow}>
                  <Text style={[styles.geoResultBeacon, { color: accent }]}>B{num}</Text>
                  <View style={styles.geoResultMetric}>
                    <Text style={styles.geoResultMetricLabel}>Tx @ 1 m</Text>
                    <Text style={styles.geoResultMetricVal}>{fit.txPower1m} dBm</Text>
                  </View>
                  <View style={styles.geoResultMetric}>
                    <Text style={styles.geoResultMetricLabel}>decay n</Text>
                    <Text style={styles.geoResultMetricVal}>{fit.n}</Text>
                  </View>
                  <View style={styles.geoResultMetric}>
                    <Text style={styles.geoResultMetricLabel}>was reading</Text>
                    <Text style={styles.geoResultMetricVal}>
                      {fit.uncalibratedFarM ? fit.uncalibratedFarM.toFixed(1) : "—"} m
                    </Text>
                  </View>
                </View>
              );
            })}
            <Text style={styles.geoResultFoot}>
              Both beacons are genuinely {geoResult.baselineM.toFixed(1)} m away during the
              other stand, so the "was reading" column is what the old shared model got
              wrong.
            </Text>

            {geoResult.warnings.map((w, i) => (
              <Text key={i} style={styles.geoWarnText}>
                ⚠ {w}
              </Text>
            ))}

            <View style={styles.geoResultActions}>
              <Pressable
                style={[styles.geoApplyBtn, geoApplied && styles.geoApplyBtnDone]}
                onPress={handleGeoApply}
              >
                <Text style={styles.geoApplyBtnText}>
                  {geoApplied ? "✓ Applied to Both Beacons" : "Apply Calibration"}
                </Text>
              </Pressable>
              <Pressable style={styles.geoResetBtn} onPress={handleGeoReset}>
                <Text style={styles.geoResetBtnText}>Reset</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* ── 3. FEATURED: 1-METER RSSI CALIBRATION STUDIO & CALCULATOR ── */}
      <View style={styles.calib1mCard}>
        <View style={styles.calib1mHeader}>
          <View style={styles.calib1mIconBadge}>
            <Text style={{ fontSize: 20 }}>🎯</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={styles.calib1mTitle}>1-Meter RSSI Calibration Studio</Text>
              <View style={styles.calib1mHeroTag}>
                <Text style={styles.calib1mHeroTagText}>CRUCIAL FOR ACCURACY</Text>
              </View>
            </View>
            <Text style={styles.calib1mSub}>
              Measures exact 1m broadcast signal (A) to eliminate distance scaling errors.
            </Text>
          </View>
        </View>

        {/* Step 1: Target Beacon Selector */}
        <Text style={styles.sectionStepHeader}>STEP 1: SELECT TARGET BEACON</Text>
        <View style={styles.calib1mTargetRow}>
          <Pressable
            style={[
              styles.calib1mTargetBtn,
              calib1mTarget === 1 && styles.calib1mTargetBtnActiveB1,
            ]}
            onPress={() => {
              setCalib1mTarget(1);
              setCalib1mResult(null);
              setApplied1mSuccess(null);
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={[styles.beaconDot, { backgroundColor: "#38bdf8" }]} />
              <Text style={[styles.calib1mTargetText, calib1mTarget === 1 && styles.calib1mTargetTextActive]}>
                Beacon 1 (B1)
              </Text>
            </View>
            <Text style={[styles.calib1mTargetSub, calib1mTarget === 1 && { color: "#bae6fd" }]}>
              {b1.name || "Select B1 below"} • Curr 1m: {Number.isFinite(b1.txPower) ? b1.txPower : -59} dBm
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.calib1mTargetBtn,
              calib1mTarget === 2 && styles.calib1mTargetBtnActiveB2,
            ]}
            onPress={() => {
              setCalib1mTarget(2);
              setCalib1mResult(null);
              setApplied1mSuccess(null);
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={[styles.beaconDot, { backgroundColor: "#c084fc" }]} />
              <Text style={[styles.calib1mTargetText, calib1mTarget === 2 && styles.calib1mTargetTextActive]}>
                Beacon 2 (B2)
              </Text>
            </View>
            <Text style={[styles.calib1mTargetSub, calib1mTarget === 2 && { color: "#e9d5ff" }]}>
              {b2.name || "Select B2 below"} • Curr 1m: {Number.isFinite(b2.txPower) ? b2.txPower : -59} dBm
            </Text>
          </Pressable>
        </View>

        {/* Step 2: Sampling Instructions & Sample Count Picker */}
        <View style={styles.calib1mInstructionBox}>
          <Text style={styles.calib1mInstructionTitle}>
            📏 How to measure:
          </Text>
          <Text style={styles.calib1mInstructionText}>
            Stand exactly <Text style={{ fontWeight: "800", color: "#f0f6fc" }}>1.0 meter (3.3 ft)</Text> from{" "}
            <Text style={{ fontWeight: "800", color: calib1mTarget === 1 ? "#38bdf8" : "#c084fc" }}>
              {activeTargetBeacon.name || `Beacon ${calib1mTarget}`}
            </Text>
            . Hold phone at chest height with clear direct line of sight.
          </Text>

          <View style={styles.sampleCountRow}>
            <Text style={styles.sampleCountLabel}>Sample Count:</Text>
            {[15, 25, 40].map((cnt) => (
              <Pressable
                key={`cnt-${cnt}`}
                style={[styles.sampleCountChip, targetSampleCount === cnt && styles.sampleCountChipActive]}
                onPress={() => setTargetSampleCount(cnt)}
                disabled={isSampling1m}
              >
                <Text style={[styles.sampleCountChipText, targetSampleCount === cnt && styles.sampleCountChipTextActive]}>
                  {cnt} pkts
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Step 3: Sampling Action & Progress */}
        <View style={styles.calib1mActionContainer}>
          {!isSampling1m ? (
            <Pressable
              style={styles.calib1mStartBtn}
              onPress={handleStart1mSampling}
            >
              <Text style={styles.calib1mStartBtnText}>
                🎯 Start 1-Meter Calibration Sample ({targetSampleCount} Packets)
              </Text>
            </Pressable>
          ) : (
            <View style={styles.calib1mSamplingActiveBox}>
              <View style={styles.calib1mSamplingHeader}>
                <View style={styles.calib1mPulsingDot} />
                <Text style={styles.calib1mSamplingTitle}>
                  Capturing Live 1m Signals ({samples1m.length} / {targetSampleCount})...
                </Text>
              </View>

              {/* Progress Bar */}
              <View style={styles.progressBarTrack}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      width: `${Math.min(100, Math.round((samples1m.length / targetSampleCount) * 100))}%`,
                    },
                  ]}
                />
              </View>

              <View style={styles.samplingStatsLiveRow}>
                <Text style={styles.samplingLiveRssi}>
                  Latest Packet:{" "}
                  <Text style={{ color: "#3fb950", fontWeight: "800" }}>
                    {samples1m.length > 0 ? `${samples1m[samples1m.length - 1]} dBm` : "--"}
                  </Text>
                </Text>
                <Pressable
                  style={styles.calib1mStopEarlyBtn}
                  onPress={handleStop1mSamplingEarly}
                >
                  <Text style={styles.calib1mStopEarlyBtnText}>Stop & Use ({samples1m.length})</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        {/* 1m Calculation Results Card */}
        {calib1mResult && (
          <View style={styles.calib1mResultCard}>
            <View style={styles.calib1mResultTopRow}>
              <View>
                <Text style={styles.calib1mResultHeader}>CALCULATED 1-METER REFERENCE RSSI</Text>
                <Text style={styles.calib1mResultValue}>
                  {calib1mResult.recommendedTx} <Text style={{ fontSize: 16 }}>dBm</Text>
                </Text>
              </View>
              <View style={styles.calib1mQualityBadge}>
                <Text style={styles.calib1mQualityText}>
                  {calib1mResult.stdDev <= 2.0 ? "🟢 Clean Line-of-Sight" : "🟡 Slight Multipath"}
                </Text>
                <Text style={styles.calib1mQualitySub}>σ = ±{calib1mResult.stdDev} dBm</Text>
              </View>
            </View>

            {/* Metric Details Breakdown */}
            <View style={styles.calib1mMetricsGrid}>
              <View style={styles.calib1mMetricItem}>
                <Text style={styles.calib1mMetricLabel}>MEDIAN RSSI</Text>
                <Text style={styles.calib1mMetricVal}>{calib1mResult.median} dBm</Text>
              </View>
              <View style={styles.calib1mMetricItem}>
                <Text style={styles.calib1mMetricLabel}>MEAN (AVG)</Text>
                <Text style={styles.calib1mMetricVal}>{calib1mResult.mean} dBm</Text>
              </View>
              <View style={styles.calib1mMetricItem}>
                <Text style={styles.calib1mMetricLabel}>RANGE (MIN/MAX)</Text>
                <Text style={styles.calib1mMetricVal}>{calib1mResult.min} / {calib1mResult.max} dBm</Text>
              </View>
              <View style={styles.calib1mMetricItem}>
                <Text style={styles.calib1mMetricLabel}>SAMPLES USED</Text>
                <Text style={styles.calib1mMetricVal}>{calib1mResult.count} packets</Text>
              </View>
            </View>

            {/* Apply Button */}
            <Pressable
              style={styles.calib1mApplyBtn}
              onPress={handleApply1mCalibration}
            >
              <Text style={styles.calib1mApplyBtnText}>
                ⚡ Apply {calib1mResult.recommendedTx} dBm as Beacon {calib1mTarget} TxPower@1m
              </Text>
            </Pressable>
          </View>
        )}

        {/* Live Distance Verification Box */}
        {applied1mSuccess && (
          <View style={styles.calib1mVerifiedBox}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: 16 }}>✅</Text>
              <Text style={styles.calib1mVerifiedTitle}>
                Calibrated Successfully! ({applied1mSuccess.txPower} dBm)
              </Text>
            </View>
            <Text style={styles.calib1mVerifiedDesc}>
              Current Calculated Distance:{" "}
              <Text style={{ fontWeight: "800", color: "#3fb950" }}>
                {formatDist(activeTargetBeacon.distanceM, distanceUnit).value}{formatDist(activeTargetBeacon.distanceM, distanceUnit).label}
              </Text>{" "}
              (Should read ~1.00m while standing at 1 meter).
            </Text>
          </View>
        )}
      </View>

      {/* ── 4. LIVE DISTANCE & NAVIGATION HUB ── */}
      <View style={styles.navHubCard}>
        <View style={styles.navHubHeader}>
          <View style={{ flex: 1 }}>
            <View style={styles.navTitleRow}>
              <Text style={{ fontSize: 18 }}>🧭</Text>
              <Text style={styles.navHubTitle}>Live Distance Navigation Hub</Text>
            </View>
            <Text style={styles.navHubSub}>
              6-Stage Filtered Distance • 0-Jitter • Kinematic Speed Cap
            </Text>
          </View>

          {/* Unit Selector Toggle */}
          <View style={styles.unitToggleGroup}>
            {[
              { id: "m", label: "m" },
              { id: "ft", label: "ft" },
              { id: "in", label: "in" },
            ].map((u) => (
              <Pressable
                key={u.id}
                style={[styles.unitToggleBtn, distanceUnit === u.id && styles.unitToggleBtnActive]}
                onPress={() => handleUnitChange(u.id)}
              >
                <Text style={[styles.unitToggleText, distanceUnit === u.id && styles.unitToggleTextActive]}>
                  {u.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Path-Loss Exponent Presets */}
        <View style={styles.envPresetRow}>
          <Text style={styles.envPresetLabel}>Path Loss (n={pathLossN}):</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.envPillsScroll}>
            {[
              { label: "Open Space", n: 2.0 },
              { label: "Standard", n: 2.2 },
              { label: "Office", n: 2.5 },
              { label: "Dense Walls", n: 3.0 },
            ].map((preset) => (
              <Pressable
                key={`n-${preset.n}`}
                style={[styles.envPill, pathLossN === preset.n && styles.envPillActive]}
                onPress={() => handleNChange(preset.n)}
              >
                <Text style={[styles.envPillText, pathLossN === preset.n && styles.envPillTextActive]}>
                  {preset.label} ({preset.n})
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        {/* Dual Distance Readout Cards */}
        <View style={styles.navDistCardsRow}>
          {/* Beacon 1 Distance Tile */}
          <View style={[styles.navDistTile, { borderColor: "#38bdf8" }]}>
            <View style={styles.navTileHeader}>
              <View style={[styles.navBeaconDot, { backgroundColor: "#38bdf8" }]} />
              <Text style={styles.navTileTitle} numberOfLines={1}>
                {b1.name || "Beacon 1"}
              </Text>
              <Text style={styles.navTileSubTag}>B1</Text>
            </View>

            <View style={styles.navTileBigDist}>
              <Text style={[styles.navBigDistNum, { color: "#38bdf8" }]}>
                {formatDist(b1.distanceM, distanceUnit).value}
              </Text>
              <Text style={[styles.navBigDistUnit, { color: "#38bdf8" }]}>
                {formatDist(b1.distanceM, distanceUnit).label}
              </Text>
            </View>

            {/* Stability & Jitter Readout */}
            <View style={styles.navStabilityRow}>
              <View
                style={[
                  styles.navStabilityBadge,
                  {
                    backgroundColor:
                      (b1.stabilityScore || 0) >= 80 ? "#134e4a" : (b1.stabilityScore || 0) >= 50 ? "#713f12" : "#7f1d1d",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.navStabilityText,
                    {
                      color:
                        (b1.stabilityScore || 0) >= 80 ? "#2dd4bf" : (b1.stabilityScore || 0) >= 50 ? "#fde047" : "#fca5a5",
                    },
                  ]}
                >
                  {(b1.stabilityScore || 0) >= 80 ? "🟢" : "🟡"} {Number.isFinite(b1.stabilityScore) ? b1.stabilityScore : 0}% Stable
                </Text>
              </View>
              <Text style={styles.navJitterText}>
                {Number.isFinite(b1.filteredRssi) ? `${b1.filteredRssi} dBm` : "--"}
              </Text>
            </View>
          </View>

          {/* Beacon 2 Distance Tile */}
          <View style={[styles.navDistTile, { borderColor: "#c084fc" }]}>
            <View style={styles.navTileHeader}>
              <View style={[styles.navBeaconDot, { backgroundColor: "#c084fc" }]} />
              <Text style={styles.navTileTitle} numberOfLines={1}>
                {b2.name || "Beacon 2"}
              </Text>
              <Text style={styles.navTileSubTag}>B2</Text>
            </View>

            <View style={styles.navTileBigDist}>
              <Text style={[styles.navBigDistNum, { color: "#c084fc" }]}>
                {formatDist(b2.distanceM, distanceUnit).value}
              </Text>
              <Text style={[styles.navBigDistUnit, { color: "#c084fc" }]}>
                {formatDist(b2.distanceM, distanceUnit).label}
              </Text>
            </View>

            {/* Stability & Jitter Readout */}
            <View style={styles.navStabilityRow}>
              <View
                style={[
                  styles.navStabilityBadge,
                  {
                    backgroundColor:
                      (b2.stabilityScore || 0) >= 80 ? "#134e4a" : (b2.stabilityScore || 0) >= 50 ? "#713f12" : "#7f1d1d",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.navStabilityText,
                    {
                      color:
                        (b2.stabilityScore || 0) >= 80 ? "#2dd4bf" : (b2.stabilityScore || 0) >= 50 ? "#fde047" : "#fca5a5",
                    },
                  ]}
                >
                  {(b2.stabilityScore || 0) >= 80 ? "🟢" : "🟡"} {Number.isFinite(b2.stabilityScore) ? b2.stabilityScore : 0}% Stable
                </Text>
              </View>
              <Text style={styles.navJitterText}>
                {Number.isFinite(b2.filteredRssi) ? `${b2.filteredRssi} dBm` : "--"}
              </Text>
            </View>
          </View>
        </View>

        {/* Proximity Comparison Bar */}
        {Number.isFinite(b1?.distanceM) && Number.isFinite(b2?.distanceM) && (
          <View style={styles.proximityBarCard}>
            <Text style={styles.proximityLabel}>Relative Proximity:</Text>
            <Text style={styles.proximityValue}>
              {Math.abs(b1.distanceM - b2.distanceM) < 0.2
                ? "⚖️ Equidistant between both beacons"
                : b1.distanceM < b2.distanceM
                ? `👉 Closer to ${b1.name} (by ${Math.abs(b1.distanceM - b2.distanceM).toFixed(2)}m)`
                : `👉 Closer to ${b2.name} (by ${Math.abs(b1.distanceM - b2.distanceM).toFixed(2)}m)`}
            </Text>
          </View>
        )}
      </View>

      {/* ── HIGH PERFORMANCE / SCAN SCOPE SWITCHER ── */}
      <View style={[styles.modeToggleCard, targetBeaconsOnly ? styles.modeToggleCardLocked : styles.modeToggleCardAll]}>
        <View style={styles.modeToggleTopRow}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
            <Text style={{ fontSize: 18 }}>{targetBeaconsOnly ? "⚡" : "🌐"}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.modeToggleTitle}>
                {targetBeaconsOnly ? "Main Beacons Only (Zero Phone Load)" : "All Ambient Devices (Discovery Mode)"}
              </Text>
              <Text style={styles.modeToggleSub}>
                {targetBeaconsOnly
                  ? "Scanner locked exclusively to B1 & B2. All random ambient devices dropped."
                  : "Scanning all Bluetooth signals in range. High CPU usage."}
              </Text>
            </View>
          </View>

          <Pressable
            style={[styles.modeToggleBtn, targetBeaconsOnly ? styles.modeToggleBtnActive : styles.modeToggleBtnIdle]}
            onPress={() => v2Scanner.setTargetBeaconsOnly(!targetBeaconsOnly)}
          >
            <Text style={[styles.modeToggleBtnText, targetBeaconsOnly ? styles.modeToggleBtnTextActive : styles.modeToggleBtnTextIdle]}>
              {targetBeaconsOnly ? "🔒 B1 & B2 ONLY" : "🌐 SCAN ALL"}
            </Text>
          </Pressable>
        </View>

        {targetBeaconsOnly && (
          <View style={styles.lockedBeaconsStrip}>
            <Text style={styles.lockedBeaconsLabel}>Active Targets:</Text>
            <Text style={[styles.lockedBeaconsBadge, { color: "#38bdf8" }]}>
              B1: {b1.name || (stats.beacon1Id ? stats.beacon1Id.slice(-5) : "Not chosen")}
            </Text>
            <Text style={{ color: "#30363d" }}>•</Text>
            <Text style={[styles.lockedBeaconsBadge, { color: "#c084fc" }]}>
              B2: {b2.name || (stats.beacon2Id ? stats.beacon2Id.slice(-5) : "Not chosen")}
            </Text>
          </View>
        )}
      </View>

      {/* ── SLOT ASSIGNMENT — which PHYSICAL beacon is B1 vs B2 ── */}
      {/* The MAC is the only unambiguous identifier (two beacons often share a
          model name), so it is always shown next to the slot label. */}
      <View style={styles.card}>
        <View style={styles.listHeaderRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>🔗 Beacon Slot Assignment</Text>
            <Text style={styles.cardSub}>Which physical beacon is B1 and which is B2</Text>
          </View>
          <Pressable
            style={[
              styles.swapBeaconsBtn,
              (!stats.beacon1Id || !stats.beacon2Id) && styles.swapBeaconsBtnDisabled,
            ]}
            onPress={handleSwapBeacons}
            disabled={!stats.beacon1Id || !stats.beacon2Id}
          >
            <Text style={styles.swapBeaconsBtnText}>⇄ Swap B1 / B2</Text>
          </Pressable>
        </View>

        <View style={styles.slotRow}>
          <View style={[styles.slotChip, { borderColor: "#38bdf8" }]}>
            <Text style={[styles.slotChipTitle, { color: "#38bdf8" }]}>B1</Text>
            <Text style={styles.slotChipName} numberOfLines={1}>
              {b1.name || "Not chosen"}
            </Text>
            <Text style={styles.slotChipMac}>{stats.beacon1Id || "—"}</Text>
            <Text style={styles.slotChipRssi}>
              {Number.isFinite(b1.rawRssi) ? `${b1.rawRssi} dBm` : "no signal"}
            </Text>
          </View>

          <View style={[styles.slotChip, { borderColor: "#c084fc" }]}>
            <Text style={[styles.slotChipTitle, { color: "#c084fc" }]}>B2</Text>
            <Text style={styles.slotChipName} numberOfLines={1}>
              {b2.name || "Not chosen"}
            </Text>
            <Text style={styles.slotChipMac}>{stats.beacon2Id || "—"}</Text>
            <Text style={styles.slotChipRssi}>
              {Number.isFinite(b2.rawRssi) ? `${b2.rawRssi} dBm` : "no signal"}
            </Text>
          </View>
        </View>

        {stats.beacon1Id && stats.beacon1Id === stats.beacon2Id && (
          <Text style={styles.slotConflictWarning}>
            ⚠ Both slots point at the same beacon. Pick a different device for one of them.
          </Text>
        )}

        {/* Cancels the hardware TxPower difference between the two units, so
            an equal physical distance reads as an equal number on both. */}
        <Pressable
          style={[
            styles.matchBeaconsBtn,
            (!stats.beacon1Id || !stats.beacon2Id) && styles.swapBeaconsBtnDisabled,
          ]}
          onPress={handleMatchBeacons}
          disabled={!stats.beacon1Id || !stats.beacon2Id}
        >
          <Text style={styles.matchBeaconsBtnText}>⚖ Match Both Beacons (equal distance)</Text>
        </Pressable>
        {Number.isFinite(b1.rawRssi) && Number.isFinite(b2.rawRssi) && (
          <Text style={styles.matchHintText}>
            Live gap: B1 is {Math.abs(b1.rawRssi - b2.rawRssi)} dB{" "}
            {b1.rawRssi > b2.rawRssi ? "stronger" : "weaker"} than B2. If you're standing
            equidistant, that gap is hardware difference — tap Match to cancel it.
          </Text>
        )}
      </View>

      {/* ── 5. SURROUNDING BEACONS RADAR & DEVICE LIST ── */}
      <View style={styles.card}>
        <View style={styles.listHeaderRow}>
          <View>
            <Text style={styles.cardTitle}>📡 Surrounding Beacons & Devices</Text>
            <Text style={styles.cardSub}>Sorted by signal strength (closest first)</Text>
          </View>

          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            {/* Quick Name Only Toggle Button */}
            <Pressable
              style={[
                styles.headerNameToggleBtn,
                nameOnlyFilter && styles.headerNameToggleBtnActive,
              ]}
              onPress={() => setNameOnlyFilter((v) => !v)}
            >
              <Text
                style={[
                  styles.headerNameToggleText,
                  nameOnlyFilter && styles.headerNameToggleTextActive,
                ]}
              >
                {nameOnlyFilter ? "🏷️ Name: ON" : "🏷️ Name: OFF"}
              </Text>
            </Pressable>

            {discoveredList.length >= 2 && (
              <Pressable
                style={styles.autoPickBtn}
                onPress={() => v2Scanner.autoSelectTopTwo()}
              >
                <Text style={styles.autoPickBtnText}>⚡ Auto-Pick Top 2</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Filter Chips & Name Only Toggle Row */}
        <View style={styles.filterChipRow}>
          <Pressable
            style={[styles.filterChip, !beaconsOnlyFilter && !nameOnlyFilter && styles.filterChipActive]}
            onPress={() => {
              setBeaconsOnlyFilter(false);
              setNameOnlyFilter(false);
            }}
          >
            <Text style={[styles.filterChipText, !beaconsOnlyFilter && !nameOnlyFilter && styles.filterChipTextActive]}>
              All ({discoveredList.length})
            </Text>
          </Pressable>

          <Pressable
            style={[styles.filterChip, beaconsOnlyFilter && styles.filterChipActive]}
            onPress={() => setBeaconsOnlyFilter((v) => !v)}
          >
            <Text style={[styles.filterChipText, beaconsOnlyFilter && styles.filterChipTextActive]}>
              {beaconsOnlyFilter ? "✓ " : ""}iBeacons ({discoveredList.filter((d) => d && d.isBeacon).length})
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.filterChip,
              styles.nameOnlyChip,
              nameOnlyFilter && styles.nameOnlyChipActive,
            ]}
            onPress={() => setNameOnlyFilter((v) => !v)}
          >
            <Text
              style={[
                styles.filterChipText,
                styles.nameOnlyChipText,
                nameOnlyFilter && styles.nameOnlyChipTextActive,
              ]}
            >
              {nameOnlyFilter ? "✓ 🏷️ Name Only" : "🏷️ Name Only"} ({discoveredList.filter((d) => hasValidName(d)).length})
            </Text>
          </Pressable>
        </View>

        {displayList.length === 0 ? (
          <View style={styles.emptyListBox}>
            <Text style={styles.emptyListText}>
              {isScanning
                ? "Searching for nearby Bluetooth signals..."
                : "No devices detected yet. Tap 'Start BLE Scan' above."}
            </Text>
          </View>
        ) : (
          <View style={styles.deviceList}>
            {displayList.map((dev) => {
              const isB1 = stats.beacon1Id === dev.id;
              const isB2 = stats.beacon2Id === dev.id;

              return (
                <View
                  key={dev.id}
                  style={[
                    styles.deviceCard,
                    isB1 && styles.deviceCardB1,
                    isB2 && styles.deviceCardB2,
                  ]}
                >
                  {/* Left: Device Info */}
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      {dev.isBeacon && (
                        <View style={styles.beaconTag}>
                          <Text style={styles.beaconTagText}>iBeacon</Text>
                        </View>
                      )}
                      <Text style={styles.deviceName} numberOfLines={1}>
                        {dev.name}
                      </Text>
                    </View>

                    <Text style={styles.deviceMac}>MAC: {dev.id}</Text>

                    {dev.major !== null && dev.minor !== null && (
                      <Text style={styles.deviceDetails}>
                        Major: <Text style={{ fontWeight: "700", color: "#e6edf3" }}>{dev.major}</Text> • Minor:{" "}
                        <Text style={{ fontWeight: "700", color: "#e6edf3" }}>{dev.minor}</Text>
                      </Text>
                    )}

                    {dev.uuid && (
                      <Text style={styles.deviceUuid} numberOfLines={1}>
                        UUID: {dev.uuid}
                      </Text>
                    )}

                    {/* Signal level bar */}
                    {renderSignalMeter(dev.rawRssi)}
                  </View>

                  {/* Middle: RSSI Badge & Distance */}
                  <View style={styles.rssiBadgeCol}>
                    <View
                      style={[
                        styles.rssiPill,
                        {
                          backgroundColor:
                            dev.rawRssi >= -65
                              ? "#14532d"
                              : dev.rawRssi >= -80
                              ? "#713f12"
                              : "#7f1d1d",
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.rssiPillText,
                          {
                            color:
                              dev.rawRssi >= -65
                                ? "#4ade80"
                                : dev.rawRssi >= -80
                                ? "#fde047"
                                : "#f87171",
                          },
                        ]}
                      >
                        {dev.rawRssi} dBm
                      </Text>
                    </View>
                    {Number.isFinite(dev.estimatedDistM) && (
                      <Text style={{ fontSize: 11, fontWeight: "700", color: "#8b949e", marginTop: 4 }}>
                        ~{formatDist(dev.estimatedDistM, distanceUnit).value}{formatDist(dev.estimatedDistM, distanceUnit).label}
                      </Text>
                    )}
                  </View>

                  {/* Right: Selection & Calibration Buttons */}
                  <View style={styles.selectBtnCol}>
                    {isB1 ? (
                      <View style={[styles.activeBadge, { backgroundColor: "#1d4ed8" }]}>
                        <Text style={styles.activeBadgeText}>✓ B1 ACTIVE</Text>
                      </View>
                    ) : (
                      <Pressable
                        style={[styles.pickBtn, styles.pickBtnB1]}
                        onPress={() => v2Scanner.selectBeacon(1, dev.id, dev.name)}
                      >
                        <Text style={styles.pickBtnB1Text}>Set B1</Text>
                      </Pressable>
                    )}

                    {isB2 ? (
                      <View style={[styles.activeBadge, { backgroundColor: "#6b21a8" }]}>
                        <Text style={styles.activeBadgeText}>✓ B2 ACTIVE</Text>
                      </View>
                    ) : (
                      <Pressable
                        style={[styles.pickBtn, styles.pickBtnB2]}
                        onPress={() => v2Scanner.selectBeacon(2, dev.id, dev.name)}
                      >
                        <Text style={styles.pickBtnB2Text}>Set B2</Text>
                      </Pressable>
                    )}

                    <Pressable
                      style={styles.quickCalib1mBtn}
                      onPress={() => {
                        if (isB1) {
                          setCalib1mTarget(1);
                        } else if (isB2) {
                          setCalib1mTarget(2);
                        } else {
                          // select as B1 for quick calibration
                          v2Scanner.selectBeacon(1, dev.id, dev.name);
                          setCalib1mTarget(1);
                        }
                        Alert.alert("Target Set for 1m Calibration", `Ready to calibrate ${dev.name} at 1.0m. Scroll up to the 1-Meter Calibration Studio.`);
                      }}
                    >
                      <Text style={styles.quickCalib1mBtnText}>🎯 1m Calib</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {/* ── 6. DUAL BEACON SIGNAL ANALYTICS CARDS ── */}
      <View style={styles.beaconCardsRow}>
        {/* BEACON 1 CARD */}
        <View style={[styles.beaconCard, { borderColor: "#38bdf8" }]}>
          <View style={[styles.beaconBadge, { backgroundColor: "#0c4a6e" }]}>
            <Text style={[styles.beaconBadgeText, { color: "#38bdf8" }]}>BEACON 1 (B1)</Text>
          </View>

          <Text style={styles.beaconCardName} numberOfLines={1}>
            {b1.name || "Select B1 Above"}
          </Text>
          <Text style={styles.beaconSub} numberOfLines={1}>
            {b1.mac ? `MAC: ${b1.mac}` : "Tap 'Set B1' above"}
          </Text>

          {/* Smoothed RSSI */}
          <View style={styles.metricBig}>
            <Text style={[styles.metricBigVal, { color: "#38bdf8" }]}>
              {Number.isFinite(b1.filteredRssi) ? `${b1.filteredRssi}` : "--"}
            </Text>
            <Text style={styles.metricBigUnit}>dBm (Smoothed)</Text>
            <Text style={styles.metricRawSub}>
              Raw: {Number.isFinite(b1.rawRssi) ? `${b1.rawRssi} dBm` : "--"}
            </Text>
          </View>

          <View style={styles.detailsGrid}>
            <View style={styles.detailItem}>
              <Text style={styles.detailLabel}>Confidence (C):</Text>
              <Text style={[styles.detailVal, { color: (b1.confidenceScore || 0) >= 0.7 ? "#3fb950" : "#d29922", fontWeight: "800" }]}>
                {Number.isFinite(b1.confidenceScore) ? `${Math.round(b1.confidenceScore * 100)}%` : "--"}
              </Text>
            </View>

            <View style={styles.detailItem}>
              <Text style={styles.detailLabel}>Variance (σ²):</Text>
              <Text style={styles.detailVal}>
                {Number.isFinite(b1.variance) ? `${b1.variance.toFixed(1)} dBm²` : "--"}
              </Text>
            </View>

            <View style={styles.detailItem}>
              <Text style={styles.detailLabel}>Path Loss (n):</Text>
              <Text style={[styles.detailVal, { color: b1.isCalibrated ? "#3fb950" : "#8b949e", fontWeight: "700" }]}>
                {Number.isFinite(b1.currentN) ? b1.currentN : "--"} {b1.isCalibrated ? "✓ OLS" : "(def)"}
              </Text>
            </View>

            <View style={styles.detailItem}>
              <Text style={styles.detailLabel}>Packet Rate:</Text>
              <Text style={[styles.detailVal, { color: (b1.packetRateHz || 0) > 5 ? "#3fb950" : "#e6edf3" }]}>
                {Number.isFinite(b1.packetRateHz) && b1.packetRateHz > 0 ? `${b1.packetRateHz} Hz` : "--"}
              </Text>
            </View>
          </View>

          {/* 1m TxPower input */}
          <View style={styles.txRow}>
            <Text style={styles.txLabel}>1m Tx:</Text>
            <TextInput
              style={styles.txInput}
              defaultValue={String(Number.isFinite(b1.txPower) ? b1.txPower : -59)}
              keyboardType="numbers-and-punctuation"
              onEndEditing={(e) => handleTxChange(1, e.nativeEvent.text)}
            />
            <Text style={styles.txUnit}>dBm</Text>
          </View>
        </View>

        {/* BEACON 2 CARD */}
        <View style={[styles.beaconCard, { borderColor: "#c084fc" }]}>
          <View style={[styles.beaconBadge, { backgroundColor: "#3b0764" }]}>
            <Text style={[styles.beaconBadgeText, { color: "#c084fc" }]}>BEACON 2 (B2)</Text>
          </View>

          <Text style={styles.beaconCardName} numberOfLines={1}>
            {b2.name || "Select B2 Above"}
          </Text>
          <Text style={styles.beaconSub} numberOfLines={1}>
            {b2.mac ? `MAC: ${b2.mac}` : "Tap 'Set B2' above"}
          </Text>

          {/* Smoothed RSSI */}
          <View style={styles.metricBig}>
            <Text style={[styles.metricBigVal, { color: "#c084fc" }]}>
              {Number.isFinite(b2.filteredRssi) ? `${b2.filteredRssi}` : "--"}
            </Text>
            <Text style={styles.metricBigUnit}>dBm (Smoothed)</Text>
            <Text style={styles.metricRawSub}>
              Raw: {Number.isFinite(b2.rawRssi) ? `${b2.rawRssi} dBm` : "--"}
            </Text>
          </View>

          <View style={styles.detailsGrid}>
            <View style={styles.detailItem}>
              <Text style={styles.detailLabel}>Confidence (C):</Text>
              <Text style={[styles.detailVal, { color: (b2.confidenceScore || 0) >= 0.7 ? "#3fb950" : "#d29922", fontWeight: "800" }]}>
                {Number.isFinite(b2.confidenceScore) ? `${Math.round(b2.confidenceScore * 100)}%` : "--"}
              </Text>
            </View>

            <View style={styles.detailItem}>
              <Text style={styles.detailLabel}>Variance (σ²):</Text>
              <Text style={styles.detailVal}>
                {Number.isFinite(b2.variance) ? `${b2.variance.toFixed(1)} dBm²` : "--"}
              </Text>
            </View>

            <View style={styles.detailItem}>
              <Text style={styles.detailLabel}>Path Loss (n):</Text>
              <Text style={[styles.detailVal, { color: b2.isCalibrated ? "#3fb950" : "#8b949e", fontWeight: "700" }]}>
                {Number.isFinite(b2.currentN) ? b2.currentN : "--"} {b2.isCalibrated ? "✓ OLS" : "(def)"}
              </Text>
            </View>

            <View style={styles.detailItem}>
              <Text style={styles.detailLabel}>Packet Rate:</Text>
              <Text style={[styles.detailVal, { color: (b2.packetRateHz || 0) > 5 ? "#3fb950" : "#e6edf3" }]}>
                {Number.isFinite(b2.packetRateHz) && b2.packetRateHz > 0 ? `${b2.packetRateHz} Hz` : "--"}
              </Text>
            </View>
          </View>

          {/* 1m TxPower input */}
          <View style={styles.txRow}>
            <Text style={styles.txLabel}>1m Tx:</Text>
            <TextInput
              style={styles.txInput}
              defaultValue={String(Number.isFinite(b2.txPower) ? b2.txPower : -59)}
              keyboardType="numbers-and-punctuation"
              onEndEditing={(e) => handleTxChange(2, e.nativeEvent.text)}
            />
            <Text style={styles.txUnit}>dBm</Text>
          </View>
        </View>
      </View>

      {/* ── 7. WEIGHTED 2-BEACON POSITION ESTIMATION (w = C²) ── */}
      <View style={styles.weightedPosCard}>
        <View style={styles.navTitleRow}>
          <Text style={{ fontSize: 18 }}>📍</Text>
          <Text style={styles.weightedPosTitle}>Weighted 2-Beacon Position (w = C²)</Text>
        </View>
        <Text style={styles.weightedPosSub}>
          Dynamic anchor weighting: higher confidence exerts exponentially greater pull
        </Text>

        {/* Proportional Weight Distribution Bar */}
        <View style={styles.weightDistCard}>
          <View style={styles.weightDistHeader}>
            <Text style={[styles.weightBadgeText, { color: "#38bdf8" }]}>
              {b1.name || "B1"}: {b1WeightPct}% (w = {Number.isFinite(b1Weight) ? b1Weight.toFixed(3) : "--"})
            </Text>
            <Text style={[styles.weightBadgeText, { color: "#c084fc" }]}>
              {b2.name || "B2"}: {b2WeightPct}% (w = {Number.isFinite(b2Weight) ? b2Weight.toFixed(3) : "--"})
            </Text>
          </View>
          <View style={styles.weightBarTrack}>
            <View style={[styles.weightBarFillB1, { flex: Math.max(1, Number.isFinite(b1WeightPct) ? b1WeightPct : 50) }]} />
            <View style={[styles.weightBarFillB2, { flex: Math.max(1, Number.isFinite(b2WeightPct) ? b2WeightPct : 50) }]} />
          </View>
        </View>

        {/* Coordinate Readout */}
        <View style={styles.posCoordRow}>
          <View style={styles.posCoordBox}>
            <Text style={styles.posCoordLabel}>Estimated Position (X, Y):</Text>
            <Text style={styles.posCoordVal}>
              {weightedPos && Number.isFinite(weightedPos.x) && Number.isFinite(weightedPos.y)
                ? `(${weightedPos.x.toFixed(2)}m, ${weightedPos.y.toFixed(2)}m)`
                : "Stand between beacons..."}
            </Text>
          </View>

          <View style={styles.posConfBox}>
            <Text style={styles.posCoordLabel}>Fix Confidence:</Text>
            <Text style={[styles.posConfVal, { color: (weightedPos?.confidence || 0) >= 0.7 ? "#3fb950" : "#d29922" }]}>
              {weightedPos && Number.isFinite(weightedPos.confidence)
                ? `${Math.round(weightedPos.confidence * 100)}%`
                : "--"}
            </Text>
          </View>
        </View>

        {/* Baseline Distance setting */}
        <View style={styles.baselineRow}>
          <Text style={styles.baselineLabel}>Baseline (Distance B1 ↔ B2):</Text>
          <TextInput
            style={styles.baselineInput}
            defaultValue={String(baselineDistM)}
            keyboardType="numeric"
            onEndEditing={(e) => {
              const num = parseFloat(e.nativeEvent.text);
              if (!isNaN(num) && num > 0.5) setBaselineDistM(num);
            }}
          />
          <Text style={styles.baselineUnit}>meters</Text>
        </View>
      </View>

      {/* ── 8. REAL-TIME RAW RSSI SIGNAL GRAPH ── */}
      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>📈 Live Raw & Smoothed RSSI Graph</Text>
          <Pressable
            style={[styles.pauseBtn, isGraphPaused && styles.pauseBtnActive]}
            onPress={() => setIsGraphPaused((v) => !v)}
          >
            <Text style={[styles.pauseBtnText, isGraphPaused && styles.pauseBtnTextActive]}>
              {isGraphPaused ? "▶ Resume" : "⏸ Pause"}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.cardSub}>
          Visualizing raw antenna spikes vs 6-stage smoothed signal
        </Text>

        {/* Graph display mode toggle */}
        <View style={styles.graphControlsRow}>
          <View style={styles.toggleGroup}>
            {[
              { id: "both", label: "Raw + Smooth" },
              { id: "filtered", label: "Smooth Only" },
              { id: "raw", label: "Raw Only" },
            ].map((m) => (
              <Pressable
                key={m.id}
                style={[styles.toggleBtn, graphMode === m.id && styles.toggleBtnActive]}
                onPress={() => setGraphMode(m.id)}
              >
                <Text style={[styles.toggleBtnText, graphMode === m.id && styles.toggleBtnTextActive]}>
                  {m.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Time window toggle */}
          <View style={styles.toggleGroup}>
            {[15, 20, 30].map((w) => (
              <Pressable
                key={`w-${w}`}
                style={[styles.toggleBtn, windowSec === w && styles.toggleBtnActive]}
                onPress={() => setWindowSec(w)}
              >
                <Text style={[styles.toggleBtnText, windowSec === w && styles.toggleBtnTextActive]}>
                  {w}s
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Embedded SVG Chart */}
        <RssiSignalGraph
          history={graphData}
          mode={graphMode}
          windowSec={windowSec}
          b1Name={b1.name}
          b2Name={b2.name}
          latestB1={graphMode === "raw" ? b1.rawRssi : b1.filteredRssi}
          latestB2={graphMode === "raw" ? b2.rawRssi : b2.filteredRssi}
          darkMode={true}
        />
      </View>

      {/* ── 9. MULTI-POINT OLS REGRESSION STUDIO (ADVANCED) ── */}
      <View style={styles.calibCard}>
        <View style={styles.calibHeaderRow}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: 18 }}>📐</Text>
              <Text style={styles.calibTitle}>Multi-Distance OLS Regression Studio</Text>
            </View>
            <Text style={styles.calibSub}>
              Fits environment path-loss exponent n & TxPower across multiple distances (1m, 2m, 3m, 5m)
            </Text>
          </View>
        </View>

        {/* Target Beacon Switcher */}
        <View style={styles.calibTargetRow}>
          <Pressable
            style={[styles.calibTargetBtn, calibTarget === 1 && styles.calibTargetBtnActiveB1]}
            onPress={() => setCalibTarget(1)}
          >
            <Text style={[styles.calibTargetBtnText, calibTarget === 1 && styles.calibTargetBtnTextActive]}>
              B1: {b1.name || "Beacon 1"} {b1.isCalibrated ? "✓" : ""}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.calibTargetBtn, calibTarget === 2 && styles.calibTargetBtnActiveB2]}
            onPress={() => setCalibTarget(2)}
          >
            <Text style={[styles.calibTargetBtnText, calibTarget === 2 && styles.calibTargetBtnTextActive]}>
              B2: {b2.name || "Beacon 2"} {b2.isCalibrated ? "✓" : ""}
            </Text>
          </Pressable>
        </View>

        {/* Current Calibration Status Pill */}
        <View style={styles.calibStatusBox}>
          {activeCalibState?.isCalibrated ? (
            <View style={styles.calibFittedBox}>
              <Text style={styles.calibFittedTitle}>✓ Calibrated Path-Loss Model Active</Text>
              <Text style={styles.calibFittedDetails}>
                Fitted n = <Text style={{ fontWeight: "800", color: "#3fb950" }}>{activeCalibState?.fittedN ?? 2.2}</Text> • Tx@1m ={" "}
                <Text style={{ fontWeight: "800", color: "#3fb950" }}>{activeCalibState?.fittedTxPower1m ?? -59} dBm</Text> • R² ={" "}
                <Text style={{ fontWeight: "800", color: (activeCalibState?.rSquared ?? 0) >= 0.85 ? "#3fb950" : "#d29922" }}>
                  {Number.isFinite(activeCalibState?.rSquared) ? activeCalibState.rSquared.toFixed(2) : "--"}
                </Text>
              </Text>
              {activeCalibState?.hasFarSegment ? (
                <Text style={[styles.calibFittedDetails, { marginTop: 2 }]}>
                  🧱 Far-field (&gt;{activeCalibState.breakpointDistanceM}m) n ={" "}
                  <Text style={{ fontWeight: "800", color: "#58a6ff" }}>{activeCalibState.fittedNFar}</Text>{" "}
                  — dual-slope model active for obstructed long-range readings
                </Text>
              ) : (
                <Text style={[styles.calibFittedDetails, { marginTop: 2, color: "#8b949e" }]}>
                  Single-slope model — add 2+ points beyond {activeCalibState?.breakpointDistanceM ?? 6}m (through real walls/glass) to enable a separate long-range slope
                </Text>
              )}
            </View>
          ) : (
            <Text style={styles.calibUnfittedText}>
              Using default model (n = 2.20, Tx = -59 dBm). Record points at known distances to fit.
            </Text>
          )}
        </View>

        {/* Reference Points List */}
        <View style={styles.calibPointsContainer}>
          <Text style={styles.calibPointsLabel}>
            Recorded Reference Points ({Array.isArray(activeCalibState?.referencePoints) ? activeCalibState.referencePoints.length : 0}):
          </Text>
          {(!activeCalibState || !Array.isArray(activeCalibState.referencePoints) || activeCalibState.referencePoints.length === 0) ? (
            <Text style={styles.calibEmptyPoints}>
              No reference points recorded yet. Stand at a distance and tap a button below.
            </Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.calibChipsScroll}>
              {activeCalibState.referencePoints.map((pt, idx) => (
                <View key={`pt-${idx}`} style={styles.calibChip}>
                  <Text style={styles.calibChipDist}>{pt.distanceM}m</Text>
                  <Text style={styles.calibChipRssi}>{pt.rssi} dBm</Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>

        {/* Quick Distance Logging Buttons */}
        <Text style={styles.calibActionLabel}>1. Log Current Filtered RSSI at Known Distance:</Text>
        <View style={styles.quickDistRow}>
          {[1.0, 2.0, 3.0, 5.0, 10.0].map((d) => (
            <Pressable
              key={`quick-${d}`}
              style={styles.quickDistBtn}
              onPress={() => handleAddCalibPoint(d)}
            >
              <Text style={styles.quickDistBtnText}>+ {d}m</Text>
            </Pressable>
          ))}
        </View>

        {/* Custom distance input row */}
        <View style={styles.customDistRow}>
          <Text style={styles.customDistLabel}>Custom (m):</Text>
          <TextInput
            style={styles.customDistInput}
            value={customCalibDist}
            onChangeText={setCustomCalibDist}
            keyboardType="numeric"
            placeholder="4.5"
            placeholderTextColor="#8b949e"
          />
          <Pressable
            style={styles.customDistBtn}
            onPress={() => handleAddCalibPoint(customCalibDist)}
          >
            <Text style={styles.customDistBtnText}>+ Add Point</Text>
          </Pressable>
        </View>

        {/* Solve & Fit Model Row */}
        <Text style={[styles.calibActionLabel, { marginTop: 8 }]}>2. Solve OLS Regression:</Text>
        <View style={styles.calibActionsRow}>
          <Pressable
            style={[
              styles.fitModelBtn,
              (!activeCalibState || !Array.isArray(activeCalibState.referencePoints) || activeCalibState.referencePoints.length < 2) && styles.fitModelBtnDisabled,
            ]}
            onPress={handleFitModel}
            disabled={!activeCalibState || !Array.isArray(activeCalibState.referencePoints) || activeCalibState.referencePoints.length < 2}
          >
            <Text style={styles.fitModelBtnText}>📐 Fit OLS Model (Min 2 Pts)</Text>
          </Pressable>

          <Pressable
            style={styles.clearCalibBtn}
            onPress={handleClearCalib}
          >
            <Text style={styles.clearCalibBtnText}>🗑 Reset</Text>
          </Pressable>
        </View>
      </View>

      {/* ── 10. LIVE PACKET STREAM LOG ── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>📋 Live Packet Stream Log</Text>
        <Text style={styles.cardSub}>Latest received packets with smoothed distance</Text>

        <View style={styles.logContainer}>
          {packetLog.length === 0 ? (
            <Text style={styles.logEmpty}>
              {isScanning ? "Listening for packets..." : "No packets recorded yet."}
            </Text>
          ) : (
            packetLog.map((item) => (
              <View key={item.id} style={styles.logRow}>
                <Text style={styles.logTime}>{item.time}</Text>

                <View
                  style={[
                    styles.logTag,
                    { backgroundColor: item.beaconNum === 1 ? "#0c4a6e" : "#3b0764" },
                  ]}
                >
                  <Text
                    style={[
                      styles.logTagText,
                      { color: item.beaconNum === 1 ? "#38bdf8" : "#c084fc" },
                    ]}
                  >
                    B{item.beaconNum}
                  </Text>
                </View>

                <Text style={styles.logRssi}>
                  Raw: {item.rawRssi} dBm • Smooth: {item.filteredRssi} dBm
                  {Number.isFinite(item.distanceM) ? ` • ${item.distanceM.toFixed(2)}m` : ""}
                </Text>
              </View>
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0d1117",
  },
  container: {
    padding: 14,
    paddingBottom: 50,
    backgroundColor: "#0d1117",
  },
  header: {
    marginBottom: 12,
  },
  headerTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  badgeV2: {
    backgroundColor: "#3b0764",
    borderWidth: 1,
    borderColor: "#8b5cf6",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeV2Text: {
    color: "#d8b4fe",
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
  },
  statusPillActive: {
    backgroundColor: "rgba(35, 134, 54, 0.15)",
    borderColor: "#238636",
  },
  statusPillIdle: {
    backgroundColor: "rgba(139, 148, 158, 0.1)",
    borderColor: "#30363d",
  },
  statusPillText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#f0f6fc",
  },
  headerSub: {
    fontSize: 12,
    color: "#8b949e",
    marginTop: 2,
  },
  scanControlRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 10,
  },
  mainScanBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    elevation: 3,
  },
  mainScanBtnIdle: {
    backgroundColor: "#238636",
    shadowColor: "#238636",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
  },
  mainScanBtnActive: {
    backgroundColor: "#da3633",
    shadowColor: "#da3633",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
  },
  mainScanBtnText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  clearBtn: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#161b22",
    borderWidth: 1,
    borderColor: "#30363d",
    alignItems: "center",
    justifyContent: "center",
  },
  clearBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#c9d1d9",
  },
  statStrip: {
    flexDirection: "row",
    backgroundColor: "#161b22",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: "#30363d",
    marginBottom: 12,
    alignItems: "center",
    justifyContent: "space-between",
  },
  statStripItem: {
    flex: 1,
    alignItems: "center",
  },
  statStripLabel: {
    fontSize: 9,
    fontWeight: "800",
    color: "#8b949e",
    letterSpacing: 0.5,
  },
  statStripValue: {
    fontSize: 14,
    fontWeight: "800",
    color: "#f0f6fc",
    marginTop: 2,
  },
  statStripDivider: {
    width: 1,
    height: 20,
    backgroundColor: "#30363d",
  },

  // ---------------------------------------------------------------------------
  // 1-METER CALIBRATION STUDIO STYLES
  // ---------------------------------------------------------------------------
  // ── Two-stand geometric ranging calibration ──
  geoCard: {
    backgroundColor: "#161b22",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1.5,
    borderColor: "#f0883e",
    shadowColor: "#f0883e",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  geoHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  geoIconBadge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(240, 136, 62, 0.15)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#f0883e",
  },
  geoTitle: { fontSize: 15, fontWeight: "900", color: "#f0f6fc" },
  geoHeroTag: {
    backgroundColor: "rgba(240, 136, 62, 0.2)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  geoHeroTagText: { fontSize: 8, fontWeight: "900", color: "#f0883e", letterSpacing: 0.5 },
  geoSub: { fontSize: 11, color: "#8b949e", marginTop: 2 },
  geoWhyBox: {
    backgroundColor: "#0d1117",
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderLeftWidth: 3,
    borderLeftColor: "#f0883e",
  },
  geoWhyText: { fontSize: 11, color: "#8b949e", lineHeight: 17 },
  geoAlertBox: {
    backgroundColor: "rgba(248, 81, 73, 0.1)",
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#f85149",
  },
  geoAlertTitle: { fontSize: 11, fontWeight: "900", color: "#f85149", marginBottom: 3 },
  geoAlertText: { fontSize: 11, color: "#ffa198", lineHeight: 16 },
  geoOkBox: {
    backgroundColor: "rgba(63, 185, 80, 0.08)",
    borderRadius: 8,
    padding: 8,
    marginBottom: 10,
  },
  geoOkText: { fontSize: 11, color: "#3fb950" },
  geoBaselineRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  geoFieldLabel: { fontSize: 9, fontWeight: "900", color: "#8b949e", letterSpacing: 0.6 },
  geoFieldHint: { fontSize: 10, color: "#6e7681", marginTop: 2, lineHeight: 14 },
  geoBaselineInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0d1117",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#30363d",
    paddingHorizontal: 8,
  },
  geoBaselineInput: {
    width: 56,
    paddingVertical: 8,
    fontSize: 16,
    fontWeight: "800",
    color: "#f0f6fc",
    textAlign: "right",
  },
  geoBaselineUnit: { fontSize: 12, color: "#8b949e", marginLeft: 4 },
  geoStandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#0d1117",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#30363d",
    padding: 10,
    marginBottom: 8,
  },
  geoStandRowDone: { borderColor: "#3fb950" },
  geoStandTitle: { fontSize: 12, fontWeight: "900" },
  geoStandHint: { fontSize: 10, color: "#6e7681", marginTop: 2, lineHeight: 14 },
  geoProgressTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: "#21262d",
    marginTop: 8,
    overflow: "hidden",
  },
  geoProgressFill: { height: 5, borderRadius: 3 },
  geoProgressText: { fontSize: 10, color: "#8b949e", marginTop: 4 },
  geoStandBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
  },
  geoStandBtnDisabled: { opacity: 0.35 },
  geoStandBtnText: { fontSize: 12, fontWeight: "900" },
  geoStandCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#f85149",
  },
  geoStandCancelText: { fontSize: 12, fontWeight: "900", color: "#f85149" },
  geoResultBox: {
    backgroundColor: "#0d1117",
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    borderWidth: 1,
    borderColor: "#3fb950",
  },
  geoResultTitle: {
    fontSize: 9,
    fontWeight: "900",
    color: "#3fb950",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  geoResultRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  geoResultBeacon: { fontSize: 13, fontWeight: "900", width: 24 },
  geoResultMetric: { flex: 1 },
  geoResultMetricLabel: { fontSize: 8, color: "#6e7681", letterSpacing: 0.4 },
  geoResultMetricVal: { fontSize: 12, fontWeight: "800", color: "#f0f6fc" },
  geoResultFoot: { fontSize: 10, color: "#6e7681", lineHeight: 15, marginBottom: 6 },
  geoWarnText: { fontSize: 10, color: "#d29922", lineHeight: 15, marginBottom: 6 },
  geoResultActions: { flexDirection: "row", gap: 8, marginTop: 4 },
  geoApplyBtn: {
    flex: 1,
    backgroundColor: "#238636",
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: "center",
  },
  geoApplyBtnDone: { backgroundColor: "#1f6f2c" },
  geoApplyBtnText: { fontSize: 13, fontWeight: "900", color: "#ffffff" },
  geoResetBtn: {
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  geoResetBtnText: { fontSize: 12, fontWeight: "800", color: "#8b949e" },

  calib1mCard: {
    backgroundColor: "#161b22",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1.5,
    borderColor: "#38bdf8",
    shadowColor: "#38bdf8",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 4,
  },
  calib1mHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  calib1mIconBadge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(56, 189, 248, 0.15)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#38bdf8",
  },
  calib1mTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: "#f0f6fc",
  },
  calib1mHeroTag: {
    backgroundColor: "rgba(56, 189, 248, 0.2)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  calib1mHeroTagText: {
    color: "#38bdf8",
    fontSize: 8.5,
    fontWeight: "900",
    letterSpacing: 0.5,
  },
  calib1mSub: {
    fontSize: 11,
    color: "#8b949e",
    marginTop: 2,
  },
  sectionStepHeader: {
    fontSize: 10,
    fontWeight: "900",
    color: "#8b949e",
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  calib1mTargetRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  calib1mTargetBtn: {
    flex: 1,
    backgroundColor: "#21262d",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#30363d",
  },
  calib1mTargetBtnActiveB1: {
    borderColor: "#38bdf8",
    backgroundColor: "rgba(56, 189, 248, 0.12)",
  },
  calib1mTargetBtnActiveB2: {
    borderColor: "#c084fc",
    backgroundColor: "rgba(192, 132, 252, 0.12)",
  },
  calib1mTargetText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#8b949e",
  },
  calib1mTargetTextActive: {
    color: "#f0f6fc",
  },
  calib1mTargetSub: {
    fontSize: 9.5,
    color: "#6e7681",
    marginTop: 3,
  },
  calib1mInstructionBox: {
    backgroundColor: "#0d1117",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#30363d",
    marginBottom: 10,
  },
  calib1mInstructionTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: "#38bdf8",
    marginBottom: 3,
  },
  calib1mInstructionText: {
    fontSize: 11,
    color: "#c9d1d9",
    lineHeight: 16,
  },
  sampleCountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#21262d",
  },
  sampleCountLabel: {
    fontSize: 10,
    color: "#8b949e",
    fontWeight: "700",
  },
  sampleCountChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "#161b22",
    borderWidth: 1,
    borderColor: "#30363d",
  },
  sampleCountChipActive: {
    backgroundColor: "#1f6feb",
    borderColor: "#58a6ff",
  },
  sampleCountChipText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#8b949e",
  },
  sampleCountChipTextActive: {
    color: "#ffffff",
  },
  calib1mActionContainer: {
    marginBottom: 10,
  },
  calib1mStartBtn: {
    backgroundColor: "#1f6feb",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#1f6feb",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  calib1mStartBtnText: {
    color: "#ffffff",
    fontSize: 12.5,
    fontWeight: "900",
    letterSpacing: 0.3,
  },
  calib1mSamplingActiveBox: {
    backgroundColor: "#0d1117",
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#38bdf8",
  },
  calib1mSamplingHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  calib1mPulsingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#38bdf8",
  },
  calib1mSamplingTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: "#38bdf8",
  },
  progressBarTrack: {
    height: 8,
    backgroundColor: "#21262d",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: "#38bdf8",
    borderRadius: 4,
  },
  samplingStatsLiveRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  samplingLiveRssi: {
    fontSize: 11,
    color: "#8b949e",
  },
  calib1mStopEarlyBtn: {
    backgroundColor: "#21262d",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  calib1mStopEarlyBtnText: {
    fontSize: 10,
    color: "#f0f6fc",
    fontWeight: "700",
  },
  calib1mResultCard: {
    backgroundColor: "#0d1117",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1.5,
    borderColor: "#238636",
    marginBottom: 10,
  },
  calib1mResultTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 10,
  },
  calib1mResultHeader: {
    fontSize: 10,
    fontWeight: "900",
    color: "#3fb950",
    letterSpacing: 0.5,
  },
  calib1mResultValue: {
    fontSize: 28,
    fontWeight: "900",
    color: "#f0f6fc",
    marginTop: 2,
    fontFamily: "monospace",
  },
  calib1mQualityBadge: {
    backgroundColor: "rgba(35, 134, 54, 0.15)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#238636",
    alignItems: "flex-end",
  },
  calib1mQualityText: {
    fontSize: 10.5,
    fontWeight: "800",
    color: "#3fb950",
  },
  calib1mQualitySub: {
    fontSize: 9.5,
    color: "#8b949e",
    marginTop: 1,
  },
  calib1mMetricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 12,
  },
  calib1mMetricItem: {
    flex: 1,
    minWidth: "45%",
    backgroundColor: "#161b22",
    padding: 7,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  calib1mMetricLabel: {
    fontSize: 8.5,
    fontWeight: "800",
    color: "#8b949e",
    letterSpacing: 0.5,
  },
  calib1mMetricVal: {
    fontSize: 12,
    fontWeight: "800",
    color: "#f0f6fc",
    marginTop: 2,
    fontFamily: "monospace",
  },
  calib1mApplyBtn: {
    backgroundColor: "#238636",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#238636",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 3,
  },
  calib1mApplyBtnText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
  },
  calib1mVerifiedBox: {
    backgroundColor: "rgba(35, 134, 54, 0.12)",
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#238636",
    marginTop: 4,
  },
  calib1mVerifiedTitle: {
    fontSize: 12,
    fontWeight: "800",
    color: "#3fb950",
  },
  calib1mVerifiedDesc: {
    fontSize: 11,
    color: "#c9d1d9",
    marginTop: 3,
  },

  // ---------------------------------------------------------------------------
  // NAVIGATION HUB STYLES
  // ---------------------------------------------------------------------------
  navHubCard: {
    backgroundColor: "#161b22",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1.5,
    borderColor: "#14b8a6",
    shadowColor: "#14b8a6",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 3,
  },
  navHubHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 8,
    gap: 8,
  },
  navTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  navHubTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: "#2dd4bf",
  },
  navHubSub: {
    fontSize: 10.5,
    color: "#8b949e",
    marginTop: 2,
  },
  unitToggleGroup: {
    flexDirection: "row",
    backgroundColor: "#0d1117",
    borderRadius: 6,
    padding: 2,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  unitToggleBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  unitToggleBtnActive: {
    backgroundColor: "#14b8a6",
  },
  unitToggleText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#8b949e",
  },
  unitToggleTextActive: {
    color: "#ffffff",
    fontWeight: "800",
  },
  envPresetRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 6,
    gap: 8,
  },
  envPresetLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#8b949e",
  },
  envPillsScroll: {
    flexDirection: "row",
    gap: 6,
  },
  envPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
  },
  envPillActive: {
    backgroundColor: "rgba(20, 184, 166, 0.2)",
    borderColor: "#14b8a6",
  },
  envPillText: {
    fontSize: 9.5,
    fontWeight: "600",
    color: "#8b949e",
  },
  envPillTextActive: {
    color: "#2dd4bf",
    fontWeight: "800",
  },
  navDistCardsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  navDistTile: {
    flex: 1,
    backgroundColor: "#0d1117",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1.5,
  },
  navTileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  navBeaconDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  navTileTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: "#f0f6fc",
    flex: 1,
  },
  navTileSubTag: {
    fontSize: 9,
    fontWeight: "800",
    color: "#8b949e",
    backgroundColor: "#21262d",
    paddingHorizontal: 4,
    borderRadius: 3,
  },
  navTileBigDist: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
    marginVertical: 4,
  },
  navBigDistNum: {
    fontSize: 28,
    fontWeight: "900",
    fontFamily: "monospace",
  },
  navBigDistUnit: {
    fontSize: 14,
    fontWeight: "800",
  },
  navStabilityRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
  },
  navStabilityBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  navStabilityText: {
    fontSize: 9.5,
    fontWeight: "800",
  },
  navJitterText: {
    fontSize: 9.5,
    color: "#8b949e",
    fontWeight: "600",
  },
  proximityBarCard: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#30363d",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  proximityLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#8b949e",
  },
  proximityValue: {
    fontSize: 10.5,
    fontWeight: "800",
    color: "#2dd4bf",
  },

  // ---------------------------------------------------------------------------
  // DEVICE RADAR & LIST STYLES
  // ---------------------------------------------------------------------------
  card: {
    backgroundColor: "#161b22",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  listHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#f0f6fc",
  },
  cardSub: {
    fontSize: 11,
    color: "#8b949e",
    marginTop: 2,
  },
  autoPickBtn: {
    backgroundColor: "rgba(31, 111, 235, 0.2)",
    borderWidth: 1,
    borderColor: "#1f6feb",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  autoPickBtnText: {
    color: "#58a6ff",
    fontSize: 11,
    fontWeight: "800",
  },
  headerNameToggleBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#30363d",
    backgroundColor: "#0d1117",
  },
  headerNameToggleBtnActive: {
    backgroundColor: "rgba(56, 189, 248, 0.18)",
    borderColor: "#38bdf8",
  },
  headerNameToggleText: {
    fontSize: 10.5,
    fontWeight: "800",
    color: "#8b949e",
  },
  headerNameToggleTextActive: {
    color: "#38bdf8",
  },
  filterChipRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
    flexWrap: "wrap",
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
  },
  filterChipActive: {
    backgroundColor: "#21262d",
    borderColor: "#58a6ff",
  },
  filterChipText: {
    fontSize: 11,
    color: "#8b949e",
    fontWeight: "600",
  },
  filterChipTextActive: {
    color: "#58a6ff",
    fontWeight: "700",
  },
  nameOnlyChip: {
    borderColor: "#30363d",
  },
  nameOnlyChipActive: {
    backgroundColor: "rgba(56, 189, 248, 0.18)",
    borderColor: "#38bdf8",
  },
  nameOnlyChipText: {
    color: "#8b949e",
  },
  nameOnlyChipTextActive: {
    color: "#38bdf8",
    fontWeight: "800",
  },
  emptyListBox: {
    paddingVertical: 20,
    alignItems: "center",
  },
  emptyListText: {
    color: "#8b949e",
    fontSize: 12,
    fontStyle: "italic",
    textAlign: "center",
  },
  deviceList: {
    gap: 8,
  },
  deviceCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
  },
  deviceCardB1: {
    borderColor: "#38bdf8",
    backgroundColor: "rgba(56, 189, 248, 0.05)",
  },
  deviceCardB2: {
    borderColor: "#c084fc",
    backgroundColor: "rgba(192, 132, 252, 0.05)",
  },
  beaconTag: {
    backgroundColor: "#134e4a",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  beaconTagText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#2dd4bf",
  },
  deviceName: {
    fontSize: 12.5,
    fontWeight: "700",
    color: "#f0f6fc",
    flex: 1,
  },
  deviceMac: {
    fontSize: 10,
    color: "#8b949e",
    fontFamily: "monospace",
    marginTop: 1,
  },
  deviceDetails: {
    fontSize: 9.5,
    color: "#8b949e",
    marginTop: 1,
  },
  deviceUuid: {
    fontSize: 9,
    color: "#6e7681",
    fontFamily: "monospace",
  },
  signalMeterContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  signalMeterTrack: {
    width: 60,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#21262d",
    overflow: "hidden",
  },
  signalMeterFill: {
    height: "100%",
    borderRadius: 2,
  },
  signalMeterText: {
    fontSize: 9,
    fontWeight: "700",
    fontFamily: "monospace",
  },
  rssiBadgeCol: {
    alignItems: "center",
    paddingHorizontal: 6,
  },
  rssiPill: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  rssiPillText: {
    fontSize: 11,
    fontWeight: "800",
    fontFamily: "monospace",
  },
  selectBtnCol: {
    flexDirection: "column",
    gap: 4,
    alignItems: "flex-end",
  },
  pickBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  pickBtnB1: {
    backgroundColor: "rgba(56, 189, 248, 0.15)",
    borderColor: "#38bdf8",
  },
  pickBtnB1Text: {
    fontSize: 9.5,
    fontWeight: "800",
    color: "#38bdf8",
  },
  pickBtnB2: {
    backgroundColor: "rgba(192, 132, 252, 0.15)",
    borderColor: "#c084fc",
  },
  pickBtnB2Text: {
    fontSize: 9.5,
    fontWeight: "800",
    color: "#c084fc",
  },
  quickCalib1mBtn: {
    backgroundColor: "#21262d",
    borderWidth: 1,
    borderColor: "#30363d",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  quickCalib1mBtnText: {
    fontSize: 8.5,
    fontWeight: "700",
    color: "#8b949e",
  },
  activeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    minWidth: 64,
    alignItems: "center",
  },
  activeBadgeText: {
    color: "#ffffff",
    fontSize: 9,
    fontWeight: "900",
  },

  // ---------------------------------------------------------------------------
  // BEACON DETAIL CARDS
  // ---------------------------------------------------------------------------
  beaconCardsRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14,
  },
  beaconCard: {
    flex: 1,
    backgroundColor: "#161b22",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1.5,
  },
  beaconBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginBottom: 4,
  },
  beaconBadgeText: {
    fontSize: 9,
    fontWeight: "800",
  },
  beaconCardName: {
    fontSize: 13,
    fontWeight: "700",
    color: "#f0f6fc",
  },
  beaconSub: {
    fontSize: 10,
    color: "#8b949e",
    marginBottom: 4,
  },
  metricBig: {
    alignItems: "center",
    marginVertical: 4,
  },
  metricBigVal: {
    fontSize: 24,
    fontWeight: "900",
    fontFamily: "monospace",
  },
  metricBigUnit: {
    fontSize: 9.5,
    color: "#8b949e",
    fontWeight: "600",
  },
  metricRawSub: {
    fontSize: 9,
    color: "#6e7681",
    marginTop: 1,
  },
  detailsGrid: {
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: "#21262d",
    paddingTop: 6,
  },
  detailItem: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  detailLabel: {
    fontSize: 10,
    color: "#8b949e",
  },
  detailVal: {
    fontSize: 10,
    color: "#f0f6fc",
    fontWeight: "600",
  },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "#21262d",
    gap: 4,
  },
  txLabel: {
    fontSize: 9,
    color: "#8b949e",
  },
  txInput: {
    flex: 1,
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 4,
    color: "#f0f6fc",
  },
  txUnit: {
    fontSize: 9,
    color: "#8b949e",
  },

  // ---------------------------------------------------------------------------
  // GRAPH & CONTROLS STYLES
  // ---------------------------------------------------------------------------
  cardTitleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  graphControlsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginVertical: 8,
    flexWrap: "wrap",
    gap: 6,
  },
  toggleGroup: {
    flexDirection: "row",
    backgroundColor: "#0d1117",
    borderRadius: 6,
    padding: 2,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  toggleBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  toggleBtnActive: {
    backgroundColor: "#21262d",
  },
  toggleBtnText: {
    fontSize: 10,
    color: "#8b949e",
    fontWeight: "600",
  },
  toggleBtnTextActive: {
    color: "#f0f6fc",
    fontWeight: "800",
  },
  pauseBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: "#21262d",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  pauseBtnActive: {
    backgroundColor: "rgba(210, 153, 34, 0.2)",
    borderColor: "#d29922",
  },
  pauseBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#8b949e",
  },
  pauseBtnTextActive: {
    color: "#d29922",
  },
  logContainer: {
    backgroundColor: "#0d1117",
    borderRadius: 8,
    padding: 8,
    maxHeight: 180,
    borderWidth: 1,
    borderColor: "#30363d",
    marginTop: 6,
  },
  logEmpty: {
    color: "#6e7681",
    fontSize: 11,
    textAlign: "center",
    paddingVertical: 8,
  },
  logRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: "#21262d",
  },
  logTime: {
    color: "#8b949e",
    fontSize: 10,
    fontFamily: "monospace",
  },
  logTag: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  logTagText: {
    fontSize: 9,
    fontWeight: "800",
  },
  logRssi: {
    color: "#e6edf3",
    fontSize: 10.5,
    fontFamily: "monospace",
  },

  // ---------------------------------------------------------------------------
  // WEIGHTED POSITION ESTIMATION STYLES
  // ---------------------------------------------------------------------------
  weightedPosCard: {
    backgroundColor: "#161b22",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1.5,
    borderColor: "#818cf8",
    shadowColor: "#818cf8",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 3,
  },
  weightedPosTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: "#a5b4fc",
  },
  weightedPosSub: {
    fontSize: 10.5,
    color: "#8b949e",
    marginTop: 2,
    marginBottom: 8,
  },
  weightDistCard: {
    backgroundColor: "#0d1117",
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: "#30363d",
    marginBottom: 8,
  },
  weightDistHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  weightBadgeText: {
    fontSize: 10.5,
    fontWeight: "800",
  },
  weightBarTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: "#21262d",
    flexDirection: "row",
    overflow: "hidden",
  },
  weightBarFillB1: {
    backgroundColor: "#38bdf8",
    height: "100%",
  },
  weightBarFillB2: {
    backgroundColor: "#c084fc",
    height: "100%",
  },
  posCoordRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 8,
  },
  posCoordBox: {
    flex: 1.4,
    backgroundColor: "rgba(129, 140, 248, 0.1)",
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: "rgba(129, 140, 248, 0.3)",
  },
  posCoordLabel: {
    fontSize: 10,
    color: "#a5b4fc",
    fontWeight: "700",
  },
  posCoordVal: {
    fontSize: 14,
    fontWeight: "900",
    color: "#f0f6fc",
    marginTop: 2,
    fontFamily: "monospace",
  },
  posConfBox: {
    flex: 1,
    backgroundColor: "#0d1117",
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: "#30363d",
    alignItems: "center",
  },
  posConfVal: {
    fontSize: 15,
    fontWeight: "900",
    marginTop: 2,
  },
  baselineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "#21262d",
  },
  baselineLabel: {
    fontSize: 10,
    color: "#8b949e",
    fontWeight: "600",
  },
  baselineInput: {
    width: 45,
    fontSize: 11,
    fontWeight: "800",
    textAlign: "center",
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 4,
    paddingVertical: 1,
    color: "#f0f6fc",
  },
  baselineUnit: {
    fontSize: 10,
    color: "#8b949e",
  },

  // ---------------------------------------------------------------------------
  // MULTI-POINT CALIBRATION STUDIO STYLES
  // ---------------------------------------------------------------------------
  calibCard: {
    backgroundColor: "#161b22",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1.5,
    borderColor: "#238636",
    shadowColor: "#238636",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 3,
  },
  calibHeaderRow: {
    marginBottom: 8,
  },
  calibTitle: {
    fontSize: 15,
    fontWeight: "900",
    color: "#3fb950",
  },
  calibSub: {
    fontSize: 10.5,
    color: "#8b949e",
    marginTop: 2,
  },
  calibTargetRow: {
    flexDirection: "row",
    gap: 8,
    marginVertical: 6,
  },
  calibTargetBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    alignItems: "center",
  },
  calibTargetBtnActiveB1: {
    backgroundColor: "rgba(56, 189, 248, 0.2)",
    borderColor: "#38bdf8",
  },
  calibTargetBtnActiveB2: {
    backgroundColor: "rgba(192, 132, 252, 0.2)",
    borderColor: "#c084fc",
  },
  calibTargetBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#8b949e",
  },
  calibTargetBtnTextActive: {
    color: "#f0f6fc",
    fontWeight: "800",
  },
  calibStatusBox: {
    marginVertical: 6,
  },
  calibFittedBox: {
    backgroundColor: "rgba(35, 134, 54, 0.15)",
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#238636",
  },
  calibFittedTitle: {
    fontSize: 11,
    fontWeight: "800",
    color: "#3fb950",
  },
  calibFittedDetails: {
    fontSize: 10,
    color: "#c9d1d9",
    marginTop: 2,
  },
  calibUnfittedText: {
    fontSize: 10.5,
    color: "#8b949e",
    fontStyle: "italic",
  },
  calibPointsContainer: {
    marginVertical: 6,
  },
  calibPointsLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#f0f6fc",
    marginBottom: 4,
  },
  calibEmptyPoints: {
    fontSize: 10,
    color: "#6e7681",
    fontStyle: "italic",
    paddingVertical: 4,
  },
  calibChipsScroll: {
    flexDirection: "row",
    gap: 6,
  },
  calibChip: {
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#238636",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    alignItems: "center",
  },
  calibChipDist: {
    fontSize: 10,
    fontWeight: "800",
    color: "#3fb950",
  },
  calibChipRssi: {
    fontSize: 9.5,
    color: "#8b949e",
    fontFamily: "monospace",
  },
  calibActionLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#f0f6fc",
    marginTop: 6,
    marginBottom: 4,
  },
  quickDistRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 6,
  },
  quickDistBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    alignItems: "center",
  },
  quickDistBtnText: {
    fontSize: 11,
    fontWeight: "800",
    color: "#3fb950",
  },
  customDistRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  customDistLabel: {
    fontSize: 10,
    color: "#8b949e",
    fontWeight: "600",
  },
  customDistInput: {
    width: 60,
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 4,
    paddingVertical: 2,
    color: "#f0f6fc",
  },
  customDistBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: "#21262d",
    borderWidth: 1,
    borderColor: "#30363d",
    alignItems: "center",
  },
  customDistBtnText: {
    fontSize: 10.5,
    fontWeight: "700",
    color: "#f0f6fc",
  },
  calibActionsRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  fitModelBtn: {
    flex: 1.5,
    backgroundColor: "#238636",
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: "center",
  },
  fitModelBtnDisabled: {
    backgroundColor: "#21262d",
  },
  fitModelBtnText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "800",
  },
  clearCalibBtn: {
    flex: 0.8,
    backgroundColor: "#0d1117",
    borderWidth: 1,
    borderColor: "#30363d",
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: "center",
  },
  clearCalibBtnText: {
    color: "#8b949e",
    fontSize: 11,
    fontWeight: "700",
  },
  beaconDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  modeToggleCard: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1.5,
  },
  modeToggleCardLocked: {
    backgroundColor: "rgba(35, 134, 54, 0.12)",
    borderColor: "#238636",
  },
  modeToggleCardAll: {
    backgroundColor: "rgba(210, 153, 34, 0.12)",
    borderColor: "#d29922",
  },
  modeToggleTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  modeToggleTitle: {
    fontSize: 12.5,
    fontWeight: "800",
    color: "#f0f6fc",
  },
  modeToggleSub: {
    fontSize: 10,
    color: "#8b949e",
    marginTop: 2,
  },
  modeToggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  modeToggleBtnActive: {
    backgroundColor: "#238636",
    borderColor: "#3fb950",
  },
  modeToggleBtnIdle: {
    backgroundColor: "#21262d",
    borderColor: "#30363d",
  },
  modeToggleBtnText: {
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.3,
  },
  modeToggleBtnTextActive: {
    color: "#ffffff",
  },
  modeToggleBtnTextIdle: {
    color: "#d29922",
  },
  lockedBeaconsStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(35, 134, 54, 0.25)",
  },
  lockedBeaconsLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#8b949e",
  },
  lockedBeaconsBadge: {
    fontSize: 10,
    fontWeight: "800",
  },
  swapBeaconsBtn: {
    backgroundColor: "#21262d",
    borderWidth: 1,
    borderColor: "#30363d",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  swapBeaconsBtnDisabled: {
    opacity: 0.4,
  },
  swapBeaconsBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#e6edf3",
  },
  slotRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 10,
  },
  slotChip: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    backgroundColor: "#0d1117",
  },
  slotChipTitle: {
    fontSize: 13,
    fontWeight: "800",
    marginBottom: 4,
  },
  slotChipName: {
    fontSize: 12,
    fontWeight: "600",
    color: "#e6edf3",
  },
  slotChipMac: {
    fontSize: 10,
    color: "#8b949e",
    marginTop: 2,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  slotChipRssi: {
    fontSize: 11,
    color: "#8b949e",
    marginTop: 4,
    fontWeight: "600",
  },
  slotConflictWarning: {
    marginTop: 10,
    fontSize: 11,
    color: "#f85149",
    fontWeight: "600",
    lineHeight: 16,
  },
  matchBeaconsBtn: {
    marginTop: 12,
    backgroundColor: "#1f6feb",
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: "center",
  },
  matchBeaconsBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#ffffff",
  },
  matchHintText: {
    marginTop: 8,
    fontSize: 11,
    color: "#8b949e",
    lineHeight: 16,
  },
});
