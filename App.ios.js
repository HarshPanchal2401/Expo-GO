import React, { useEffect, useRef, useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
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
import { v2Scanner } from "./services/v2BeaconScannerService.js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { stepLengthModel, STEP_MODEL_CONFIG } from "./services/StepLengthModel.js";
import { headingFilter } from "./services/HeadingFilter.js";

// Which sensor heading corresponds to the floor plan's "up". A property of
// the building, so it is persisted rather than re-established each launch.
const HEADING_ZERO_KEY = "@pdr_heading_zero_deg";

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

export default function AppIOS() {
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
  const [status, setStatus] = useState("Tracking active (iOS V2)");
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
  // 0 by default = uncalibrated heading reads as raw sensor azimuth. This is
  // ONLY ever changed by the explicit setZero() action below — nothing else
  // (mount, Start) silently recalibrates it.
  const headingZeroRef = useRef(0);
  // Whether the user has ever told the app which way the floor plan's "up" is.
  // Until they have, heading 0 means "whatever direction the sensor calls zero",
  // which has no relationship to the map. Persisted, because it is a property of
  // the BUILDING and does not change between sessions.
  const [headingCalibrated, setHeadingCalibrated] = useState(false);
  const positionRef = useRef({ x: 0, y: 0 });
  const totalDistanceRef = useRef(0);
  const lastStepTimeRef = useRef(0);
  const gravityRef = useRef(1.0);
  const hasMotionRotationRef = useRef(false);
  // Latest raw sensor heading, read by setZero(). A ref because the matching
  // state is only refreshed a few times a second for display.
  const rawHeadingRef = useRef(0);
  // Heading sensors fire at 20 Hz each; re-rendering the whole app that often
  // starves the JS thread that also runs BLE ranging and step detection. The
  // refs carry the live value, state is refreshed at display rate only.
  const lastHeadingUiRef = useRef(0);
  const lastMagUiRef = useRef(0);

  // Robust Peak-Valley Step Detector State Machine
  const stepStateRef = useRef({
    state: "IDLE",
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

    // Restore the personal step-length calibration. Without this the user would
    // have to re-walk their calibration distance on every app start.
    stepLengthModel.load();

    // Restore which real-world direction counts as the map's forward.
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(HEADING_ZERO_KEY);
        const v = saved === null ? NaN : Number(saved);
        if (Number.isFinite(v)) {
          headingZeroRef.current = v;
          setHeadingZero(v);
          // The heading so far was relative to the default zero; re-take it.
          headingFilter.resync();
          setHeadingCalibrated(true);
        }
      } catch (err) {
        console.warn("Heading zero restore failed:", err);
      }
    })();

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

  const addStep = (dynamicLen = null, bounceAmp = 0) => {
    // Accept anything the step-length model is willing to emit. These bounds
    // used to be a separate hard-coded pair, which meant a legitimately short
    // stride from a calibrated model could fall outside them and be silently
    // replaced by a 0.70 m guess — quietly discarding the calibration for
    // exactly the users who needed it most. Sourcing the range from the model
    // keeps one definition of what counts as a plausible step.
    const len =
      dynamicLen &&
      isFinite(dynamicLen) &&
      dynamicLen >= STEP_MODEL_CONFIG.MIN_STEP_LENGTH_M &&
      dynamicLen <= STEP_MODEL_CONFIG.MAX_STEP_LENGTH_M
        ? dynamicLen
        : 0.70;

    setCurrentStepLength(len);
    if (bounceAmp > 0) {
      setLastBounce(bounceAmp);
    }

    // Mean heading over this stride rather than the instant the step fired,
    // which would catch the phone mid-sway. See services/HeadingFilter.js.
    const curHeading = headingFilter.takeStepHeading();
    const rad = (curHeading * Math.PI) / 180;
    const old = positionRef.current;

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

    // Tell the BLE ranging engine the user is genuinely walking. It uses this
    // to distinguish real movement from a signal fade, which it cannot do from
    // RSSI alone. Reported on every step regardless of which screen is open.
    v2Scanner.notifyStep(Date.now(), { lengthM: len, headingDeg: curHeading });

    if (pdrStepCallbackRef.current) {
      pdrStepCallbackRef.current({ stepLengthMeters: len, heading: curHeading });
    }
  };

  // Hardware Sensors (Dynamic Step Detection + Heading)
  useEffect(() => {
    let motionSub, pedSub, accelSub, magSub;

    const publishHeading = () => {
      const nowMs = Date.now();
      if (nowMs - lastHeadingUiRef.current < 100) return;
      lastHeadingUiRef.current = nowMs;
      setHeading(headingRef.current);
      setRawHeading(rawHeadingRef.current);
    };
    let isMounted = true;

    // ── 1. Magnetometer ──
    try {
      Magnetometer.setUpdateInterval(50);
      magSub = Magnetometer.addListener((data) => {
        if (!data) return;
        const { x, y, z } = data;
        const totalField = Math.sqrt(x * x + y * y + z * z);
        headingFilter.updateMagneticField(totalField);
        const nowMs = Date.now();
        if (nowMs - lastMagUiRef.current > 250) {
          lastMagUiRef.current = nowMs;
          setMagneticField({
            x: Number(x.toFixed(1)),
            y: Number(y.toFixed(1)),
            z: Number(z.toFixed(1)),
            total: Number(totalField.toFixed(1)),
          });
        }

        if (!hasMotionRotationRef.current) {
          let magDeg = Math.atan2(-x, y) * (180 / Math.PI);
          magDeg = norm(magDeg);
          rawHeadingRef.current = magDeg;

          // NOTE THE SIGN, it differs from the DeviceMotion branch below on
          // purpose. These two sensors report rotation in OPPOSITE directions:
          //   magDeg  = atan2(-x, y)  increases CLOCKWISE (a compass bearing)
          //   rotation.alpha (W3C)    increases COUNTER-clockwise
          // The app's heading convention is clockwise (0 = +Y forward,
          // 90 = +X right), matching the compass. So the magnetometer needs
          // (reading - zero) while alpha needs (zero - reading) to flip it.
          // Applying the same subtraction to both mirrored this branch: turning
          // right swung the map left, and because PDR places each step with
          // x += len*sin(heading), every sideways step landed on the wrong side.
          headingFilter.updateAbsolute(signed(magDeg - headingZeroRef.current));
          headingRef.current = headingFilter.heading;
          publishHeading();
        }
      });
    } catch (me) {
      console.warn("Magnetometer subscription error:", me);
    }

    // ── 2. DeviceMotion / Rotation ──
    try {
      DeviceMotion.setUpdateInterval(50);
      motionSub = DeviceMotion.addListener((data) => {
        if (!data) return;
        // Absolute (compass-anchored) orientation: only used to remove slow
        // gyro drift, never to steer the heading directly.
        if (Number.isFinite(data.rotation?.alpha)) {
          hasMotionRotationRef.current = true;
          const raw = norm(alphaDeg(data.rotation.alpha));
          rawHeadingRef.current = raw;
          // rotation.alpha increases counter-clockwise, so subtracting it from
          // the zero reference is what converts it into the app's clockwise
          // heading. See the sign note in the magnetometer branch above.
          headingFilter.updateAbsolute(signed(headingZeroRef.current - raw));
        }
        // Gyroscope turn rate drives the heading - immune to the magnetic
        // disturbance that made the compass-only heading wander indoors.
        headingFilter.updateMotion(data, "ios");
        headingRef.current = headingFilter.heading;
        publishHeading();
      });
    } catch (dme) {
      console.warn("DeviceMotion subscription error:", dme);
    }

    // ── 3. Accelerometer Step Detector with Weinberg Stride Model ──
    try {
      Accelerometer.setUpdateInterval(STEP_MODEL_CONFIG.SAMPLE_INTERVAL_MS);
      accelSub = Accelerometer.addListener((data) => {
        if (!runningRef.current && !pdrStepCallbackRef.current) return;
        if (!data) return;
        const { x, y, z } = data;
        let rawMag = Math.sqrt(x * x + y * y + z * z);

        if (rawMag > 4.0) {
          rawMag = rawMag / 9.80665;
        }

        const ss = stepStateRef.current;
        const now = Date.now();

        // Widened deliberately. The old coefficients (0.70/0.30) put this
        // filter's -3 dB cutoff at ~1.9 Hz, i.e. INSIDE the 1.2-2.6 Hz band a
        // human walks in, so it shrank the very peak-to-valley swing the step
        // length model measures — and shrank it more the faster the user
        // walked, making distance read short by 3% when strolling and 13% when
        // hurrying. STEP_MODEL_CONFIG.LPF_ALPHA moves the cutoff above the gait
        // band; whatever attenuation is left is divided back out analytically
        // inside stepLengthModel.estimate().
        ss.filteredMag += STEP_MODEL_CONFIG.LPF_ALPHA * (rawMag - ss.filteredMag);
        gravityRef.current = 0.98 * gravityRef.current + 0.02 * ss.filteredMag;
        const dynamicAccel = ss.filteredMag - gravityRef.current;

        if (!ss.lastLiveBounceUpdate || now - ss.lastLiveBounceUpdate > 100) {
          ss.lastLiveBounceUpdate = now;
          setLiveBounce(Math.abs(dynamicAccel));
        }

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
              const prevStepTime = ss.lastConfirmedStepTime;
              ss.lastConfirmedStepTime = now;
              lastStepTimeRef.current = now;

              // Step length now comes from StepLengthModel, which corrects the
              // filter's speed-dependent attenuation and applies the personal
              // scale learned from a measured calibration walk. The step
              // INTERVAL is what makes the correction possible: it gives the
              // gait frequency, and the attenuation is a known function of it.
              stepLengthModel.cfg.WEINBERG_K = kVal;
              const stepInterval = isFirstStep ? null : now - prevStepTime;
              const stepEst = stepLengthModel.estimate(bounceDiff, stepInterval);
              const dynamicStepLen = Number(stepEst.lengthM.toFixed(2));
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

    // ── 4. Non-Blocking Background Pedometer Setup ──
    (async () => {
      try {
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

  const setZero = () => {
    const rawNow = rawHeadingRef.current;
    headingZeroRef.current = rawNow;
    setHeadingZero(rawNow);
    setHeadingCalibrated(true);
    AsyncStorage.setItem(HEADING_ZERO_KEY, String(rawNow)).catch((err) =>
      console.warn("Heading zero save failed:", err)
    );
    headingFilter.reset(0);
    headingRef.current = 0;
    setHeading(0);
    setStatus("Heading zero calibrated (Forward = 0°)");
  };

  const start = () => {
    // Deliberately does NOT touch heading calibration — only the explicit
    // "Set Zero" button (setZero) changes what counts as forward/0°.
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

      {/* Top Header Bar */}
      <View style={styles.topHeader}>
        <View style={styles.brandGroup}>
          <Text style={styles.brandTitle}>Indoor Nav</Text>
          <View style={styles.v2Badge}>
            <Text style={styles.v2BadgeText}>V2</Text>
          </View>
        </View>

        <Pressable
          style={styles.headerOtaBtn}
          onPress={handleOtaCheck}
          disabled={otaChecking}
        >
          {otaChecking ? (
            <ActivityIndicator size="small" color="#58a6ff" />
          ) : (
            <Text style={styles.headerOtaBtnText}>
              {otaStatus ? otaStatus : "🔄 Updates"}
            </Text>
          )}
        </Pressable>
      </View>

      {/* Primary Navigation Tab Bar */}
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

      {/* Active Tab View */}
      <ErrorBoundary fallbackMessage="This view encountered an unexpected error. Tap below to reload.">
        {activeTab === "fusionMap" ? (
          <FusionMapScreen
            pdrStepCallbackRef={pdrStepCallbackRef}
            headingRef={headingRef}
            onZeroHeading={setZero}
            headingCalibrated={headingCalibrated}
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
