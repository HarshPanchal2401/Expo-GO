import React, { useEffect, useRef, useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  PermissionsAndroid,
  Platform,
  StatusBar,
  ActivityIndicator,
} from "react-native";
import { Pedometer, DeviceMotion, Accelerometer, Magnetometer } from "expo-sensors";
import { getSavedPaths, savePath, deleteSavedPath, clearAllSavedPaths } from "./PathStorage.js";
import AppSettingsScreen from "./components/AppSettingsScreen.js";
import BeaconSignalLabScreen from "./components/v2/BeaconSignalLabScreen.js";
import FusionMapScreen from "./components/v2/FusionMapScreen.js";
import PdrTrackerScreen from "./components/v2/PdrTrackerScreen.js";
import ErrorBoundary from "./components/ErrorBoundary.js";
import { getAppSettings, subscribeAppSettings } from "./services/appSettingsStorage.js";

let ExpoUpdates = null;
try {
  ExpoUpdates = require("expo-updates");
} catch (e) {}

const norm = (d) => {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
};

const signed = (d) => {
  let x = norm(d);
  if (x > 180) x -= 360;
  return x;
};

const alphaDeg = (a) => (Math.abs(a) <= Math.PI * 2.2 ? (a * 180) / Math.PI : a);

// Weinberg dynamic step length estimation constant (calibrated for g units)
const WEINBERG_K = 0.74;

export default function AppAndroid() {
  const [running, setRunning] = useState(true);
  const [available, setAvailable] = useState("checking...");
  const [steps, setSteps] = useState(0);
  const [totalDistance, setTotalDistance] = useState(0);
  const [currentStepLength, setCurrentStepLength] = useState(0.70);
  const [lastBounce, setLastBounce] = useState(0);
  const [liveBounce, setLiveBounce] = useState(0);
  const [heading, setHeading] = useState(0);
  const [headingZero, setHeadingZero] = useState(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [path, setPath] = useState([{ x: 0, y: 0 }]);
  const [status, setStatus] = useState("Tracking active (V2 Engine)");
  const [rawHeading, setRawHeading] = useState(0);

  const [magneticField, setMagneticField] = useState({ x: 0, y: 0, z: 0, total: 0 });

  // Saved Paths state
  const [savedPaths, setSavedPaths] = useState([]);
  const [selectedPreviousPath, setSelectedPreviousPath] = useState(null);

  // Active Tab: 'pdr' | 'fusionMap' | 'signalLab' | 'settings'
  const [activeTab, setActiveTab] = useState("pdr");

  // OTA update state
  const [otaChecking, setOtaChecking] = useState(false);
  const [otaStatus, setOtaStatus] = useState("");

  // Dynamic In-App Settings
  const [appSettings, setAppSettings] = useState(getAppSettings());
  const appSettingsRef = useRef(getAppSettings());

  // PDR step callback ref — Fusion Map attaches its prediction hook here
  const pdrStepCallbackRef = useRef(null);

  const runningRef = useRef(true);
  const headingRef = useRef(0);
  const headingZeroRef = useRef(null);
  const smoothedHeadingRef = useRef(0);
  const positionRef = useRef({ x: 0, y: 0 });
  const totalDistanceRef = useRef(0);
  const lastStepTimeRef = useRef(0);
  const gravityRef = useRef(1.0);
  const hasMotionRotationRef = useRef(false);

  // Robust Peak-Valley Step Detector State Machine
  const stepStateRef = useRef({
    state: "IDLE", // "IDLE" | "ARMED_PEAK" | "ARMED_VALLEY"
    peakVal: 0,
    peakTime: 0,
    valleyVal: 0,
    valleyTime: 0,
    filteredMag: 1.0,
    varianceBuffer: [],
    lastConfirmedStepTime: 0,
    lastLiveBounceUpdate: 0,
  });

  // Load saved paths and subscribe to in-app settings on mount
  useEffect(() => {
    loadSavedPathsHistory();

    const unsub = subscribeAppSettings((newSettings) => {
      appSettingsRef.current = newSettings;
      setAppSettings(newSettings);
    });
    return () => unsub();
  }, []);

  const handleOtaCheck = async () => {
    if (!ExpoUpdates?.checkForUpdateAsync) {
      Alert.alert(
        "OTA Updates",
        "OTA updates are active on EAS preview/production builds. In local dev mode, changes reload via Metro."
      );
      return;
    }
    try {
      setOtaChecking(true);
      setOtaStatus("Checking...");
      const check = await ExpoUpdates.checkForUpdateAsync();
      if (check.isAvailable) {
        setOtaStatus("Downloading...");
        await ExpoUpdates.fetchUpdateAsync();
        setOtaStatus("Ready!");
        Alert.alert("Update Ready 🎉", "New version downloaded. Reload now?", [
          { text: "Later", style: "cancel" },
          { text: "Reload Now", onPress: () => ExpoUpdates.reloadAsync() },
        ]);
      } else {
        setOtaStatus("Up to date");
        setTimeout(() => setOtaStatus(""), 3000);
      }
    } catch (e) {
      setOtaStatus("Failed");
      setTimeout(() => setOtaStatus(""), 3000);
    } finally {
      setOtaChecking(false);
    }
  };

  const loadSavedPathsHistory = async () => {
    const list = await getSavedPaths();
    setSavedPaths(list);
  };

  // Add a step with dynamic sensor-detected length
  const addStep = (dynamicLen = null, bounceAmp = 0) => {
    const len =
      dynamicLen && isFinite(dynamicLen) && dynamicLen >= 0.45 && dynamicLen <= 1.15
        ? dynamicLen
        : 0.70;

    setCurrentStepLength(len);
    if (bounceAmp > 0) {
      setLastBounce(bounceAmp);
    }

    const curHeading = headingRef.current || 0;
    const rad = (curHeading * Math.PI) / 180;
    const old = positionRef.current;

    // Standard Navigation coordinates:
    // Heading 0° = +Y (Forward/North)
    // Heading +90° = +X (Right/East)
    // Heading -90° = -X (Left/West)
    // Heading 180° = -Y (Backward/South)
    const next = {
      x: Number((old.x + len * Math.sin(rad)).toFixed(2)),
      y: Number((old.y + len * Math.cos(rad)).toFixed(2)),
    };

    totalDistanceRef.current = Number((totalDistanceRef.current + len).toFixed(2));
    setTotalDistance(totalDistanceRef.current);

    positionRef.current = next;
    setPosition(next);
    setPath((p) => [...p, next]);
    setSteps((s) => s + 1);

    // Feed step into Fusion Engine / map if it is listening
    if (pdrStepCallbackRef.current) {
      pdrStepCallbackRef.current({ stepLengthMeters: len, heading: curHeading });
    }
  };

  // --------------------------------------------------------------------------
  // Hardware Sensors (Dynamic Step Detection + Heading)
  // --------------------------------------------------------------------------
  useEffect(() => {
    let motionSub, pedSub, accelSub, magSub;
    let isMounted = true;

    // ── 1. Magnetometer (Compass Azimuth + Diagnostics) ──
    try {
      Magnetometer.setUpdateInterval(50);
      magSub = Magnetometer.addListener((data) => {
        if (!data) return;
        const { x, y, z } = data;
        const totalField = Math.sqrt(x * x + y * y + z * z);
        setMagneticField({
          x: Number(x.toFixed(1)),
          y: Number(y.toFixed(1)),
          z: Number(z.toFixed(1)),
          total: Number(totalField.toFixed(1)),
        });

        // If DeviceMotion rotation is not active on this device, use Magnetometer compass
        if (!hasMotionRotationRef.current) {
          let magDeg = Math.atan2(-x, y) * (180 / Math.PI);
          magDeg = norm(magDeg);
          setRawHeading(magDeg);

          if (headingZeroRef.current === null) {
            headingZeroRef.current = magDeg;
          }
          const rel = signed(headingZeroRef.current - magDeg);
          headingRef.current = rel;
          setHeading(rel);
        }
      });
    } catch (me) {
      console.warn("Magnetometer subscription error:", me);
    }

    // ── 2. DeviceMotion / Rotation (Gyroscope Fusion) ──
    try {
      DeviceMotion.setUpdateInterval(50);
      motionSub = DeviceMotion.addListener((data) => {
        if (!data?.rotation?.alpha) return;
        hasMotionRotationRef.current = true;
        const raw = norm(alphaDeg(data.rotation.alpha));
        setRawHeading(raw);

        if (headingZeroRef.current === null) {
          headingZeroRef.current = raw;
        }
        const rel = signed(headingZeroRef.current - raw);
        let diff = rel - smoothedHeadingRef.current;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;

        smoothedHeadingRef.current = norm(smoothedHeadingRef.current + 0.25 * diff);
        const formatted = signed(smoothedHeadingRef.current);
        headingRef.current = formatted;
        setHeading(formatted);
      });
    } catch (dme) {
      console.warn("DeviceMotion subscription error:", dme);
    }

    // ── 3. High-Precision Accelerometer Step Detector with Weinberg Stride Model ──
    try {
      Accelerometer.setUpdateInterval(30);
      accelSub = Accelerometer.addListener((data) => {
        if (!runningRef.current && !pdrStepCallbackRef.current) return;
        if (!data) return;
        const { x, y, z } = data;
        let rawMag = Math.sqrt(x * x + y * y + z * z); // in g

        // Auto-detect and normalize if device reports m/s^2 (~9.8) instead of g (~1.0)
        if (rawMag > 4.0) {
          rawMag = rawMag / 9.80665;
        }

        const ss = stepStateRef.current;
        const now = Date.now();

        // Low-pass filter raw magnitude to strip high-frequency motor/sensor jitter
        ss.filteredMag = 0.70 * ss.filteredMag + 0.30 * rawMag;

        // Slow dynamic gravity tracker
        gravityRef.current = 0.98 * gravityRef.current + 0.02 * ss.filteredMag;
        const dynamicAccel = ss.filteredMag - gravityRef.current; // signed dynamic acceleration (g)

        // Throttle live bounce UI telemetry (~100ms)
        if (!ss.lastLiveBounceUpdate || now - ss.lastLiveBounceUpdate > 100) {
          ss.lastLiveBounceUpdate = now;
          setLiveBounce(Math.abs(dynamicAccel));
        }

        // Energy / Variance buffer (16 samples ≈ 480ms)
        ss.varianceBuffer.push(dynamicAccel);
        if (ss.varianceBuffer.length > 16) {
          ss.varianceBuffer.shift();
        }

        const bufLen = ss.varianceBuffer.length;
        const mean = ss.varianceBuffer.reduce((acc, v) => acc + v, 0) / bufLen;
        const variance = ss.varianceBuffer.reduce((acc, v) => acc + (v - mean) ** 2, 0) / bufLen;

        const currentSettings = appSettingsRef.current || {};
        const zuptThresh = currentSettings.zuptVariance ?? 0.0008;
        const peakThresh = currentSettings.peakThreshold ?? 0.04;
        const bounceMin = currentSettings.bounceDiffMin ?? 0.06;
        const minCadence = currentSettings.minCadenceMs ?? 240;
        const kVal = currentSettings.weinbergK ?? WEINBERG_K;

        // State Machine: ZUPT gate ONLY prevents starting when standing completely still
        if (ss.state === "IDLE") {
          if (variance >= zuptThresh && dynamicAccel > peakThresh) {
            ss.state = "ARMED_PEAK";
            ss.peakVal = dynamicAccel;
            ss.peakTime = now;
          }
        } else if (ss.state === "ARMED_PEAK") {
          if (dynamicAccel > ss.peakVal) {
            ss.peakVal = dynamicAccel;
            ss.peakTime = now;
          } else if (dynamicAccel < 0.02 && now - ss.peakTime > 30) {
            // Crossed zero line downward toward valley
            ss.state = "ARMED_VALLEY";
            ss.valleyVal = dynamicAccel;
            ss.valleyTime = now;
          } else if (now - ss.peakTime > 500) {
            ss.state = "IDLE";
          }
        } else if (ss.state === "ARMED_VALLEY") {
          if (dynamicAccel < ss.valleyVal) {
            ss.valleyVal = dynamicAccel;
            ss.valleyTime = now;
          } else if (
            (dynamicAccel > ss.valleyVal + 0.03 || dynamicAccel > 0.01) &&
            now - ss.valleyTime > 30
          ) {
            // Rebounded from valley! Validate full step cycle
            const bounceDiff = ss.peakVal - ss.valleyVal;
            const peakToValleyDuration = ss.valleyTime - ss.peakTime;
            const isFirstStep = !ss.lastConfirmedStepTime;
            const isDebounced = isFirstStep || (now - ss.lastConfirmedStepTime >= minCadence);

            if (
              bounceDiff >= bounceMin &&
              isDebounced &&
              peakToValleyDuration >= 30 &&
              peakToValleyDuration <= 700
            ) {
              // CONFIRMED VALID ACCELEROMETER STEP!
              ss.lastConfirmedStepTime = now;
              lastStepTimeRef.current = now;

              // Weinberg Dynamic Step Length Model
              const estimated = kVal * Math.pow(bounceDiff, 0.25);
              const dynamicStepLen = Number(Math.min(1.10, Math.max(0.48, estimated)).toFixed(2));

              addStep(dynamicStepLen, bounceDiff);
              setStatus(`Step: ${dynamicStepLen.toFixed(2)}m (bounce ${bounceDiff.toFixed(2)}g)`);
            }

            ss.state = "IDLE";
          } else if (now - ss.valleyTime > 600) {
            ss.state = "IDLE";
          }
        }
      });
    } catch (ae) {
      console.warn("Accelerometer subscription error:", ae);
    }

    // ── 4. Non-Blocking Background Permissions & Hardware Pedometer Fallback ──
    (async () => {
      try {
        if (Platform.OS === "android" && Platform.Version >= 29) {
          try {
            await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);
          } catch (pe) {
            console.warn("Activity recognition error:", pe);
          }
        }

        const [pAvail, mAvail, magAvail] = await Promise.all([
          Pedometer.isAvailableAsync().catch(() => false),
          DeviceMotion.isAvailableAsync().catch(() => false),
          Magnetometer.isAvailableAsync().catch(() => false),
        ]);

        if (!isMounted) return;
        setAvailable(
          `Motion ${mAvail ? "✓" : "✗"} • Mag ${magAvail ? "✓" : "✗"} • Ped ${pAvail ? "✓" : "✗"}`
        );

        if (pAvail) {
          let lastPedometerTotal = null;
          pedSub = Pedometer.watchStepCount((result) => {
            if (!runningRef.current && !pdrStepCallbackRef.current) return;
            if (!result || typeof result.steps !== "number") return;

            if (lastPedometerTotal === null) {
              lastPedometerTotal = result.steps;
              return;
            }

            const diffSteps = result.steps - lastPedometerTotal;
            if (diffSteps > 0) {
              lastPedometerTotal = result.steps;
              const now = Date.now();
              const ss = stepStateRef.current;
              // Redundant fusion: If accelerometer hasn't detected a step in the last 250ms, register native step
              if (!ss.lastConfirmedStepTime || now - ss.lastConfirmedStepTime > 250) {
                ss.lastConfirmedStepTime = now;
                lastStepTimeRef.current = now;
                addStep(0.70, 0.20);
                setStatus("Step detected via Sensor Hub (0.70m)");
              }
            }
          });
        }
      } catch (e) {
        console.warn("Pedometer background setup warning:", e);
      }
    })();

    return () => {
      isMounted = false;
      motionSub?.remove?.();
      pedSub?.remove?.();
      accelSub?.remove?.();
      magSub?.remove?.();
    };
  }, []);

  // --------------------------------------------------------------------------
  // User Actions
  // --------------------------------------------------------------------------
  const setZero = () => {
    headingZeroRef.current = rawHeading;
    setHeadingZero(rawHeading);
    smoothedHeadingRef.current = 0;
    headingRef.current = 0;
    setHeading(0);
    setStatus("Heading zero calibrated (Forward = 0°)");
  };

  const start = () => {
    if (headingZeroRef.current === null) {
      headingZeroRef.current = rawHeading;
      setHeadingZero(rawHeading);
      smoothedHeadingRef.current = 0;
      headingRef.current = 0;
      setHeading(0);
    }
    runningRef.current = true;
    setRunning(true);
    setStatus("Tracking active (Dynamic Step Length active)...");
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    setStatus("Tracking paused");
  };

  const reset = () => {
    setSteps(0);
    setTotalDistance(0);
    totalDistanceRef.current = 0;
    positionRef.current = { x: 0, y: 0 };
    setPosition({ x: 0, y: 0 });
    setPath([{ x: 0, y: 0 }]);
    setStatus("Reset to (0,0) — Tracking active");
  };

  const closeLoop = () => {
    if (path.length <= 2) {
      Alert.alert("Loop Closure Error", "Walk a closed loop path before applying loop closure.");
      return;
    }
    const lastPt = path[path.length - 1];
    const totalSteps = path.length - 1;
    const dx = lastPt.x / totalSteps;
    const dy = lastPt.y / totalSteps;

    const correctedPath = path.map((pt, i) => ({
      x: Number((pt.x - dx * i).toFixed(2)),
      y: Number((pt.y - dy * i).toFixed(2)),
    }));

    const finalPos = correctedPath[correctedPath.length - 1];
    positionRef.current = finalPos;
    setPosition(finalPos);
    setPath(correctedPath);
    setStatus("Loop Closure Applied! Drift eliminated.");
    Alert.alert(
      "Loop Closure Complete",
      `Corrected drift of X: ${lastPt.x.toFixed(2)}m, Y: ${lastPt.y.toFixed(2)}m back to origin.`
    );
  };

  const handleSavePath = async () => {
    if (path.length <= 1 && steps === 0) {
      Alert.alert("Cannot Save Path", "Walk a path first before saving.");
      return;
    }
    const dist = totalDistance;
    try {
      const updated = await savePath({
        steps,
        distance: dist,
        points: path,
      });
      setSavedPaths(updated);
      setStatus(`Path saved! (${steps} steps, ${dist.toFixed(2)}m)`);
      Alert.alert("Path Saved", `Successfully saved route with ${steps} steps and ${path.length} waypoints.`);
    } catch (e) {
      Alert.alert("Save Error", "Failed to save path to storage.");
    }
  };

  const handleTogglePreviousPath = (item) => {
    if (selectedPreviousPath?.id === item.id) {
      setSelectedPreviousPath(null);
      setStatus("Removed previous path overlay");
    } else {
      setSelectedPreviousPath(item);
      setStatus(`Overlaying saved path: "${item.name}"`);
    }
  };

  const handleDeletePath = async (id) => {
    Alert.alert("Delete Saved Path", "Are you sure you want to delete this saved path?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const updated = await deleteSavedPath(id);
          setSavedPaths(updated);
          if (selectedPreviousPath?.id === id) setSelectedPreviousPath(null);
          setStatus("Saved path deleted.");
        },
      },
    ]);
  };

  const handleClearAllPaths = async () => {
    Alert.alert("Clear All Saved Paths", "Are you sure you want to delete all saved path history?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear All",
        style: "destructive",
        onPress: async () => {
          const updated = await clearAllSavedPaths();
          setSavedPaths(updated);
          setSelectedPreviousPath(null);
          setStatus("All saved paths cleared.");
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#0d1117" />

      {/* ── Top Header Bar ── */}
      <View style={styles.topHeader}>
        <View style={styles.brandGroup}>
          <Text style={styles.brandTitle}>Indoor Nav</Text>
          <View style={styles.v2Badge}>
            <Text style={styles.v2BadgeText}>V2</Text>
          </View>
        </View>

        {/* OTA Update Quick Button */}
        <Pressable
          style={styles.headerOtaBtn}
          onPress={handleOtaCheck}
          disabled={otaChecking}
        >
          {otaChecking ? (
            <ActivityIndicator size="small" color="#58a6ff" />
          ) : (
            <Text style={styles.headerOtaBtnText}>
              {otaStatus ? otaStatus : "🔄 Check Updates"}
            </Text>
          )}
        </Pressable>
      </View>

      {/* ── Primary Navigation Tab Bar ── */}
      <View style={styles.tabBar}>
        <Pressable
          style={[styles.tabBtn, activeTab === "fusionMap" && styles.tabBtnActive]}
          onPress={() => setActiveTab("fusionMap")}
        >
          <Text style={[styles.tabBtnText, activeTab === "fusionMap" && styles.tabBtnTextActive]}>
            🗺️ Fusion Map
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabBtn, activeTab === "pdr" && styles.tabBtnActive]}
          onPress={() => setActiveTab("pdr")}
        >
          <Text style={[styles.tabBtnText, activeTab === "pdr" && styles.tabBtnTextActive]}>
            🚶 PDR
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabBtn, activeTab === "signalLab" && styles.tabBtnActive]}
          onPress={() => setActiveTab("signalLab")}
        >
          <Text style={[styles.tabBtnText, activeTab === "signalLab" && styles.tabBtnTextActive]}>
            📡 Signal Lab
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabBtn, activeTab === "settings" && styles.tabBtnActive]}
          onPress={() => setActiveTab("settings")}
        >
          <Text style={[styles.tabBtnText, activeTab === "settings" && styles.tabBtnTextActive]}>
            ⚙️ Settings
          </Text>
        </Pressable>
      </View>

      {/* ── Active Tab View ── */}
      <ErrorBoundary fallbackMessage="This view encountered an unexpected error. Tap below to reload.">
        {activeTab === "fusionMap" ? (
          <FusionMapScreen
            pdrStepCallbackRef={pdrStepCallbackRef}
            headingRef={headingRef}
          />
        ) : activeTab === "pdr" ? (
          <PdrTrackerScreen
            steps={steps}
            heading={heading}
            position={position}
            totalDistance={totalDistance}
            currentStepLength={currentStepLength}
            lastBounce={lastBounce}
            liveBounce={liveBounce}
            available={available}
            status={status}
            path={path}
            magneticField={magneticField}
            running={running}
            start={start}
            stop={stop}
            reset={reset}
            setZero={setZero}
            closeLoop={closeLoop}
            handleSavePath={handleSavePath}
            addStep={addStep}
            savedPaths={savedPaths}
            selectedPreviousPath={selectedPreviousPath}
            handleTogglePreviousPath={handleTogglePreviousPath}
            handleDeletePath={handleDeletePath}
            handleClearAllPaths={handleClearAllPaths}
            appSettings={appSettings}
          />
        ) : activeTab === "signalLab" ? (
          <BeaconSignalLabScreen />
        ) : (
          <AppSettingsScreen />
        )}
      </ErrorBoundary>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0d1117",
  },
  topHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#161b22",
    borderBottomWidth: 1,
    borderBottomColor: "#30363d",
  },
  brandGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  brandTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: "#e6edf3",
    letterSpacing: 0.5,
  },
  v2Badge: {
    backgroundColor: "#1f6feb",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  v2BadgeText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "800",
  },
  headerOtaBtn: {
    backgroundColor: "#21262d",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#30363d",
  },
  headerOtaBtnText: {
    color: "#58a6ff",
    fontSize: 12,
    fontWeight: "600",
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: "#161b22",
    borderBottomWidth: 1,
    borderBottomColor: "#30363d",
    paddingHorizontal: 6,
    paddingVertical: 6,
    gap: 4,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderRadius: 6,
    backgroundColor: "transparent",
  },
  tabBtnActive: {
    backgroundColor: "#1f6feb",
  },
  tabBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#8b949e",
  },
  tabBtnTextActive: {
    color: "#ffffff",
  },
});
