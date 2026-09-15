import React, { useEffect, useRef, useState } from "react";
import {
  SafeAreaView,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Alert,
  Dimensions
} from "react-native";
import Svg, { Polyline, Circle, Line, Polygon, Text as SvgText, Rect } from "react-native-svg";
import { Pedometer, DeviceMotion, Accelerometer, Magnetometer } from "expo-sensors";
import { getSavedPaths, savePath, deleteSavedPath, clearAllSavedPaths } from "./PathStorage.js";
import BleScannerSection from "./components/BleScannerSection.js";
import TwoBeaconPositionScreen from "./components/TwoBeaconPositionScreen.js";
import OtaUpdateCard from "./components/OtaUpdateCard.js";
import AppSettingsScreen from "./components/AppSettingsScreen.js";
import { getAppSettings, subscribeAppSettings } from "./services/appSettingsStorage.js";

const norm = d => {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
};

const signed = d => {
  let x = norm(d);
  if (x > 180) x -= 360;
  return x;
};

const alphaDeg = a => (Math.abs(a) <= Math.PI * 2.2 ? (a * 180) / Math.PI : a);

// Weinberg dynamic step length estimation constant (calibrated for g units)
const WEINBERG_K = 0.74;

export default function AppIOS() {
  const [running, setRunning] = useState(false);
  const [available, setAvailable] = useState("checking...");
  const [steps, setSteps] = useState(0);
  const [totalDistance, setTotalDistance] = useState(0);
  const [currentStepLength, setCurrentStepLength] = useState(0.70);
  const [lastBounce, setLastBounce] = useState(0);
  const [heading, setHeading] = useState(0);
  const [headingZero, setHeadingZero] = useState(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [path, setPath] = useState([{ x: 0, y: 0 }]);
  const [status, setStatus] = useState("Ready (iOS)");
  const [rawHeading, setRawHeading] = useState(0);

  const [magneticField, setMagneticField] = useState({ x: 0, y: 0, z: 0, total: 0 });

  // Saved Paths state
  const [savedPaths, setSavedPaths] = useState([]);
  const [selectedPreviousPath, setSelectedPreviousPath] = useState(null);

  // Mode switch: 'pdr' | 'ble' | 'settings'
  const [activeTab, setActiveTab] = useState("pdr");

  // Dynamic In-App Settings
  const [appSettings, setAppSettings] = useState(getAppSettings());
  const appSettingsRef = useRef(getAppSettings());

  const runningRef = useRef(false);
  const headingRef = useRef(0);
  const headingZeroRef = useRef(null);
  const smoothedHeadingRef = useRef(0);
  const positionRef = useRef({ x: 0, y: 0 });
  const totalDistanceRef = useRef(0);
  const stepAccelBufferRef = useRef([]);
  const lastStepTimeRef = useRef(0);
  const gravityRef = useRef(1.0);
  const hasMotionRotationRef = useRef(false);
  const pdrStepCallbackRef = useRef(null);

  // Robust Peak-Valley Step Detector State Machine
  const stepStateRef = useRef({
    state: "IDLE",            // "IDLE" | "ARMED_PEAK" | "ARMED_VALLEY"
    peakVal: 0,
    peakTime: 0,
    valleyVal: 0,
    valleyTime: 0,
    filteredMag: 1.0,
    varianceBuffer: [],
    lastConfirmedStepTime: 0,
  });

  // Load saved paths and subscribe to in-app settings on mount
  useEffect(() => {
    loadSavedPathsHistory();
    const unsub = subscribeAppSettings(newSettings => {
      appSettingsRef.current = newSettings;
      setAppSettings(newSettings);
    });
    return () => unsub();
  }, []);

  const loadSavedPathsHistory = async () => {
    const list = await getSavedPaths();
    setSavedPaths(list);
  };

  // Add a step with dynamic sensor-detected length
  const addStep = (dynamicLen = null, bounceAmp = 0) => {
    const len = dynamicLen && isFinite(dynamicLen) && dynamicLen >= 0.45 && dynamicLen <= 1.15
      ? dynamicLen
      : 0.70;

    setCurrentStepLength(len);
    if (bounceAmp > 0) {
      setLastBounce(bounceAmp);
    }

    const curHeading = headingRef.current || 0;
    const rad = (curHeading * Math.PI) / 180;
    const old = positionRef.current;

    const next = {
      x: Number((old.x + len * Math.sin(rad)).toFixed(2)),
      y: Number((old.y + len * Math.cos(rad)).toFixed(2))
    };

    totalDistanceRef.current = Number((totalDistanceRef.current + len).toFixed(2));
    setTotalDistance(totalDistanceRef.current);

    positionRef.current = next;
    setPosition(next);
    setPath(p => [...p, next]);
    setSteps(s => {
      const nextCount = s + 1;
      console.log(`[iOS Dynamic PDR Step #${nextCount}] Dynamic SL: ${len.toFixed(2)}m (Bounce: ${bounceAmp.toFixed(2)}g) | Heading: ${curHeading.toFixed(1)}° | Pos: (${next.x}, ${next.y})`);
      return nextCount;
    });

    // Feed step into 2-beacon module if it is listening
    if (pdrStepCallbackRef.current) {
      pdrStepCallbackRef.current({ stepLengthMeters: len, heading: curHeading });
    }
  };

  // --------------------------------------------------------------------------
  // Hardware Sensors
  // --------------------------------------------------------------------------
  useEffect(() => {
    let motionSub, pedSub, accelSub, magSub;
    let isMounted = true;

    (async () => {
      try {
        const [pAvail, mAvail, magAvail] = await Promise.all([
          Pedometer.isAvailableAsync().catch(() => false),
          DeviceMotion.isAvailableAsync().catch(() => false),
          Magnetometer.isAvailableAsync().catch(() => false)
        ]);

        if (!isMounted) return;
        setAvailable(`Sensors: Motion ${mAvail ? "✓" : "✗"} • Mag ${magAvail ? "✓" : "✗"} • Pedometer ${pAvail ? "✓" : "✗"}`);

        if (mAvail) await DeviceMotion.requestPermissionsAsync().catch(() => {});
        if (magAvail) await Magnetometer.requestPermissionsAsync().catch(() => {});
        if (pAvail) await Pedometer.requestPermissionsAsync().catch(() => {});

        // 1. Magnetometer
        Magnetometer.setUpdateInterval(50);
        magSub = Magnetometer.addListener(data => {
          if (!data) return;
          const { x, y, z } = data;
          const totalField = Math.sqrt(x * x + y * y + z * z);
          setMagneticField({
            x: Number(x.toFixed(1)),
            y: Number(y.toFixed(1)),
            z: Number(z.toFixed(1)),
            total: Number(totalField.toFixed(1))
          });

          if (!hasMotionRotationRef.current) {
            let magDeg = Math.atan2(-x, y) * (180 / Math.PI);
            magDeg = norm(magDeg);
            setRawHeading(magDeg);

            if (headingZeroRef.current !== null) {
              const rel = signed(magDeg - headingZeroRef.current);
              headingRef.current = rel;
              setHeading(rel);
            }
          }
        });

        // 2. DeviceMotion
        DeviceMotion.setUpdateInterval(50);
        motionSub = DeviceMotion.addListener(data => {
          if (!data?.rotation?.alpha) return;
          hasMotionRotationRef.current = true;
          const raw = norm(alphaDeg(data.rotation.alpha));
          setRawHeading(raw);

          if (headingZeroRef.current !== null) {
            const rel = signed(raw - headingZeroRef.current);
            let diff = rel - smoothedHeadingRef.current;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;

            smoothedHeadingRef.current = norm(smoothedHeadingRef.current + 0.25 * diff);
            const formatted = signed(smoothedHeadingRef.current);
            headingRef.current = formatted;
            setHeading(formatted);
          }
        });

        // 3. High-Precision Accelerometer Step Detector with Energy Gate & Peak-Valley State Machine
        Accelerometer.setUpdateInterval(30);
        accelSub = Accelerometer.addListener(data => {
          if (!runningRef.current && !pdrStepCallbackRef.current) return;
          const { x, y, z } = data;
          const rawMag = Math.sqrt(x * x + y * y + z * z);

          const ss = stepStateRef.current;
          const now = Date.now();

          // Low-pass filter raw magnitude to strip high-frequency noise
          ss.filteredMag = 0.70 * ss.filteredMag + 0.30 * rawMag;

          // Slow dynamic gravity tracker
          gravityRef.current = 0.98 * gravityRef.current + 0.02 * ss.filteredMag;
          const dynamicAccel = ss.filteredMag - gravityRef.current; // signed dynamic acceleration (g)

          // Energy / Variance buffer (16 samples ≈ 480ms)
          ss.varianceBuffer.push(dynamicAccel);
          if (ss.varianceBuffer.length > 16) {
            ss.varianceBuffer.shift();
          }

          const bufLen = ss.varianceBuffer.length;
          const mean = ss.varianceBuffer.reduce((acc, v) => acc + v, 0) / bufLen;
          const variance = ss.varianceBuffer.reduce((acc, v) => acc + (v - mean) ** 2, 0) / bufLen;

          const currentSettings = appSettingsRef.current || {};
          const zuptThresh = currentSettings.zuptVariance ?? 0.005;
          const peakThresh = currentSettings.peakThreshold ?? 0.12;
          const valleyThresh = currentSettings.valleyThreshold ?? -0.09;
          const bounceMin = currentSettings.bounceDiffMin ?? 0.18;
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
            } else if (dynamicAccel < 0.03 && (now - ss.peakTime) > 30) {
              // Crossed zero line downward toward valley
              ss.state = "ARMED_VALLEY";
              ss.valleyVal = dynamicAccel;
              ss.valleyTime = now;
            } else if ((now - ss.peakTime) > 650) {
              ss.state = "IDLE";
            }
          } else if (ss.state === "ARMED_VALLEY") {
            if (dynamicAccel < ss.valleyVal) {
              ss.valleyVal = dynamicAccel;
              ss.valleyTime = now;
            } else if (dynamicAccel > valleyThresh && (now - ss.valleyTime) > 30) {
              // Rebounded from valley! Validate full step cycle
              const bounceDiff = ss.peakVal - ss.valleyVal;
              const stepCadence = now - ss.lastConfirmedStepTime;
              const peakToValleyDuration = ss.valleyTime - ss.peakTime;

              if (
                bounceDiff >= bounceMin &&
                stepCadence >= 250 &&
                stepCadence <= 1600 &&
                peakToValleyDuration >= 40 &&
                peakToValleyDuration <= 700
              ) {
                // CONFIRMED VALID ACCELEROMETER STEP!
                ss.lastConfirmedStepTime = now;
                lastStepTimeRef.current = now;

                // Weinberg Dynamic Step Length Model
                const estimated = kVal * Math.pow(bounceDiff, 0.25);
                const dynamicStepLen = Number(Math.min(1.05, Math.max(0.45, estimated)).toFixed(2));

                addStep(dynamicStepLen, bounceDiff);
              }

              ss.state = "IDLE";
            } else if ((now - ss.valleyTime) > 600) {
              ss.state = "IDLE";
            }
          }
        });

        // 4. Native Hardware Pedometer Fusion (Sensor Hub backup)
        let lastPedometerTotal = null;
        pedSub = Pedometer.watchStepCount(result => {
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
            if (now - ss.lastConfirmedStepTime > 280) {
              ss.lastConfirmedStepTime = now;
              lastStepTimeRef.current = now;
              addStep(0.70, 0.25);
            }
          }
        });

      } catch (e) {
        if (isMounted) setStatus("Sensor Error: " + (e?.message || String(e)));
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
    setStatus("Recording PDR path (Dynamic Step Length active)...");
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    setStatus("Tracking stopped");
  };

  const reset = () => {
    runningRef.current = false;
    setRunning(false);
    setSteps(0);
    setTotalDistance(0);
    totalDistanceRef.current = 0;
    positionRef.current = { x: 0, y: 0 };
    setPosition({ x: 0, y: 0 });
    setPath([{ x: 0, y: 0 }]);
    setStatus("Reset to (0,0)");
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
      y: Number((pt.y - dy * i).toFixed(2))
    }));

    const finalPos = correctedPath[correctedPath.length - 1];
    positionRef.current = finalPos;
    setPosition(finalPos);
    setPath(correctedPath);
    setStatus("Loop Closure Applied! Drift eliminated.");
    Alert.alert("Loop Closure Complete", `Corrected drift of X: ${lastPt.x.toFixed(2)}m, Y: ${lastPt.y.toFixed(2)}m back to origin.`);
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
        points: path
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
        }
      }
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
        }
      }
    ]);
  };

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.container}>
        <Text style={s.title}>Indoor PDR Navigation</Text>
        <Text style={s.sub}>Dynamic Weinberg Step Estimation • Compass & Gyro Heading • 2D Map</Text>

        {/* Section Switcher Tabs */}
        <View style={s.tabContainer}>
          <Pressable
            onPress={() => setActiveTab("pdr")}
            style={[s.tabBtn, activeTab === "pdr" && s.tabBtnActive]}
          >
            <Text style={[s.tabBtnText, activeTab === "pdr" && s.tabBtnTextActive]}>
              🚶 PDR
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab("ble")}
            style={[s.tabBtn, activeTab === "ble" && s.tabBtnActive]}
          >
            <Text style={[s.tabBtnText, activeTab === "ble" && s.tabBtnTextActive]}>
              📶 BLE
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab("beacon")}
            style={[s.tabBtn, activeTab === "beacon" && s.tabBtnActive]}
          >
            <Text style={[s.tabBtnText, activeTab === "beacon" && s.tabBtnTextActive]}>
              🛰️ 2-Beacon
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab("settings")}
            style={[s.tabBtn, activeTab === "settings" && s.tabBtnActive]}
          >
            <Text style={[s.tabBtnText, activeTab === "settings" && s.tabBtnTextActive]}>
              ⚙️ Settings
            </Text>
          </Pressable>
        </View>

        {activeTab === "settings" ? (
          <AppSettingsScreen />
        ) : activeTab === "beacon" ? (
          <TwoBeaconPositionScreen pdrStepCallbackRef={pdrStepCallbackRef} heading={heading} />
        ) : activeTab === "ble" ? (
          <BleScannerSection />
        ) : (
          <>
            <View style={s.card}>
              <Text style={s.label}>Hardware Sensors Status</Text>
              <Text style={{ fontSize: 13, color: "#24292f" }}>{available}</Text>
              <Text style={s.status}>{status}</Text>
            </View>

            <View style={s.row}>
              <Metric label="Steps" value={String(steps)} highlight />
              <Metric label="Heading" value={`${heading >= 0 ? "+" : ""}${heading.toFixed(1)}°`} highlight />
            </View>

            <View style={s.row}>
              <Metric label="X Position" value={`${position.x.toFixed(2)} m`} />
              <Metric label="Y Position" value={`${position.y.toFixed(2)} m`} />
            </View>

            <View style={s.row}>
              <Metric label="Total Distance" value={`${totalDistance.toFixed(2)} m`} />
              <Metric label="Dynamic Step Length" value={`${currentStepLength.toFixed(2)} m`} highlight />
            </View>

            {/* Dynamic Step Length Sensor Info & Test Step Button */}
            <View style={s.card}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={s.label}>Dynamic Sensor Step Estimation</Text>
                <View style={s.autoBadge}>
                  <Text style={s.autoBadgeText}>⚡ Auto Weinberg (K={(appSettings?.weinbergK ?? 0.74).toFixed(2)})</Text>
                </View>
              </View>
              <Text style={{ fontSize: 12, color: "#57606a", marginTop: 2 }}>
                Step length is auto-calculated per step based on vertical foot-strike bounce amplitude.
                {lastBounce > 0 ? ` (Last Bounce Swing: ${lastBounce.toFixed(2)}g)` : ""}
              </Text>
              {/* Test Manual Step Button */}
              <Pressable
                onPress={() => addStep(0.70, 0.50)}
                style={s.manualStepBtn}
              >
                <Text style={s.manualStepBtnText}>👣 Add Test Step (0.70m)</Text>
              </Pressable>
            </View>

            {/* 2D Path Map with Live Orientation Arrow */}
            <PathPlot points={path} heading={heading} previousPath={selectedPreviousPath} />

            {/* Main Action Buttons */}
            <View style={s.row}>
              <Btn text="Set Heading Zero" onPress={setZero} />
              <Btn text={running ? "Stop Tracking" : "Start Tracking"} onPress={running ? stop : start} strong />
            </View>

            <View style={s.row}>
              <Btn text="Save Path" onPress={handleSavePath} bg="#1a7f37" color="white" />
              <Btn text="Close Loop" onPress={closeLoop} />
              <Btn text="Reset Path" onPress={reset} />
            </View>

            {/* Magnetic Field Diagnostics */}
            <View style={s.card}>
              <Text style={s.label}>Magnetometer Flux (μT)</Text>
              <View style={s.row}>
                <Metric label="Total B-Field" value={`${magneticField.total} μT`} />
              </View>
              <View style={{ marginTop: 6 }}>
                <Metric label="Vector (X, Y, Z)" value={`X: ${magneticField.x} | Y: ${magneticField.y} | Z: ${magneticField.z}`} fullWidth />
              </View>
            </View>

            {/* Live Waypoints List */}
            <View style={s.card}>
              <Text style={s.label}>Live Waypoints History ({path.length} pts)</Text>
              <ScrollView style={{ maxHeight: 120 }}>
                {path.map((pt, idx) => (
                  <Text key={idx} style={{ fontFamily: "monospace", fontSize: 12, color: idx === path.length - 1 ? "#1f6feb" : "#57606a", paddingVertical: 1 }}>
                    #{idx}: X={pt.x.toFixed(2)}m, Y={pt.y.toFixed(2)}m {idx === 0 ? "(START)" : idx === path.length - 1 ? "(NOW)" : ""}
                  </Text>
                ))}
              </ScrollView>
            </View>

            {/* Saved Paths History Card */}
            <View style={s.card}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <Text style={s.label}>Saved Paths History ({savedPaths.length})</Text>
                {savedPaths.length > 0 && (
                  <Pressable onPress={handleClearAllPaths} style={s.clearBtn}>
                    <Text style={s.clearBtnText}>Clear All</Text>
                  </Pressable>
                )}
              </View>
              {savedPaths.length === 0 ? (
                <Text style={{ color: "#57606a", fontSize: 13, fontStyle: "italic" }}>
                  No saved paths yet. Walk a route and tap "Save Path" to store it here.
                </Text>
              ) : (
                <ScrollView style={{ maxHeight: 200 }}>
                  {savedPaths.map((item) => {
                    const isSelected = selectedPreviousPath?.id === item.id;
                    return (
                      <View key={item.id} style={[s.savedItem, isSelected && s.savedItemSelected]}>
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text style={s.savedTitle}>{item.name}</Text>
                          <Text style={s.savedMeta}>{item.timestamp}</Text>
                          <Text style={s.savedMetaSub}>{item.steps} steps • {item.distance.toFixed(2)}m • {item.points?.length || 0} pts</Text>
                        </View>
                        <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                          <Pressable
                            onPress={() => handleTogglePreviousPath(item)}
                            style={[s.actionBtn, isSelected ? s.actionBtnActive : s.actionBtnOutline]}
                          >
                            <Text style={[s.actionBtnText, isSelected && { color: "white" }]}>
                              {isSelected ? "Hide" : "Show Map"}
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => handleDeletePath(item.id)}
                            style={[s.actionBtn, s.actionBtnDanger]}
                          >
                            <Text style={[s.actionBtnText, { color: "#cf222e" }]}>Delete</Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>
              )}
            </View>

            <View style={s.card}>
              <Text style={s.label}>iOS Guide</Text>
              <Text style={s.help}>
                1. Face the direction you want to walk and tap "Set Heading Zero".{"\n"}
                2. Tap "Start Tracking" and begin walking.{"\n"}
                3. The sensors auto-estimate your step length dynamically on every step taken.
              </Text>
            </View>
          </>
        )}

        {/* Global App-Level OTA Updates */}
        <OtaUpdateCard />
      </ScrollView>
    </SafeAreaView>
  );
}

function Metric({ label, value, fullWidth, highlight }) {
  return (
    <View style={[s.metric, fullWidth && { flex: undefined, width: "100%" }, highlight && s.metricHighlight]}>
      <Text style={s.metricLabel}>{label}</Text>
      <Text style={[s.metricValue, highlight && { color: "#0969da" }]}>{value}</Text>
    </View>
  );
}

function Btn({ text, onPress, strong, bg, color }) {
  return (
    <Pressable onPress={onPress} style={[s.btn, strong && s.btnStrong, bg ? { backgroundColor: bg, borderColor: bg } : null]}>
      <Text style={[s.btnText, strong && { color: "white" }, color ? { color } : null]}>{text}</Text>
    </Pressable>
  );
}

function PathPlot({ points, heading, previousPath }) {
  const screenWidth = Dimensions.get("window").width;
  const width = Math.max(280, Math.min(screenWidth - 32, 520));
  const height = 340;
  const pad = 40;

  const validPts = (points && points.length > 0) ? points : [{ x: 0, y: 0 }];
  let allPts = [...validPts];
  if (previousPath?.points?.length > 0) {
    allPts = [...allPts, ...previousPath.points];
  }

  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  allPts.forEach(p => {
    if (typeof p?.x === "number") {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    if (typeof p?.y === "number") {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  });

  const spanX = Math.max(4.0, maxX - minX);
  const spanY = Math.max(4.0, maxY - minY);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const map = p => ({
    x: Number((width / 2 + (p.x - cx) * scale).toFixed(1)),
    y: Number((height / 2 - (p.y - cy) * scale).toFixed(1))
  });

  const m = validPts.map(map);
  const poly = m.map(p => `${p.x},${p.y}`).join(" ");
  const start = map({ x: 0, y: 0 });
  const end = m[m.length - 1] || start;

  const safeHeading = typeof heading === "number" && !isNaN(heading) ? heading : 0;
  const rad = (safeHeading * Math.PI) / 180;
  const arrowLen = 18;
  const tip = {
    x: Number((end.x + arrowLen * Math.sin(rad)).toFixed(1)),
    y: Number((end.y - arrowLen * Math.cos(rad)).toFixed(1))
  };
  const left = {
    x: Number((end.x + 10 * Math.sin(rad - 2.4)).toFixed(1)),
    y: Number((end.y - 10 * Math.cos(rad - 2.4)).toFixed(1))
  };
  const right = {
    x: Number((end.x + 10 * Math.sin(rad + 2.4)).toFixed(1)),
    y: Number((end.y - 10 * Math.cos(rad + 2.4)).toFixed(1))
  };
  const arrowPoly = `${tip.x},${tip.y} ${left.x},${left.y} ${end.x},${end.y} ${right.x},${right.y}`;

  const lastPt = validPts[validPts.length - 1] || { x: 0, y: 0 };

  return (
    <View style={s.plot}>
      <Text style={s.label}>Live PDR Walk Route Map</Text>

      <View style={s.legendRow}>
        <View style={s.legendItem}>
          <View style={[s.legendColor, { backgroundColor: "#1f6feb" }]} />
          <Text style={s.legendText}>Route ({validPts.length} pts)</Text>
        </View>
        <View style={s.legendItem}>
          <View style={[s.legendColor, { backgroundColor: "#cf222e" }]} />
          <Text style={s.legendText}>Facing ({safeHeading.toFixed(0)}°)</Text>
        </View>
        {previousPath && (
          <View style={s.legendItem}>
            <View style={[s.legendColor, { backgroundColor: "#d97706" }]} />
            <Text style={s.legendText}>Previous ({previousPath.name})</Text>
          </View>
        )}
      </View>

      <Svg width={width} height={height}>
        <Rect x="0" y="0" width={width} height={height} fill="#fafbfc" rx="10" />

        <Line x1="0" y1={start.y} x2={width} y2={start.y} stroke="#d0d7de" strokeWidth="1" strokeDasharray="4,4" />
        <Line x1={start.x} y1="0" x2={start.x} y2={height} stroke="#d0d7de" strokeWidth="1" strokeDasharray="4,4" />

        {previousPath?.points?.length > 0 && (
          <Polyline
            points={previousPath.points.map(map).map(p => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#d97706"
            strokeWidth="3"
            strokeDasharray="6,4"
            opacity={0.8}
          />
        )}

        {m.length > 1 && (
          <Polyline points={poly} fill="none" stroke="#1f6feb" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
        )}

        {m.map((pt, i) => (
          <Circle key={i} cx={pt.x} cy={pt.y} r={i === 0 ? 5 : i === m.length - 1 ? 5.5 : 3.5} fill={i === 0 ? "#1a7f37" : "#1f6feb"} />
        ))}

        <Circle cx={start.x} cy={start.y} r="6" fill="#1a7f37" stroke="#ffffff" strokeWidth="1.5" />
        <SvgText x={start.x + 8} y={start.y - 6} fontSize="11" fontWeight="bold" fill="#1a7f37">START (0,0)</SvgText>

        <Polygon points={arrowPoly} fill="#cf222e" stroke="#ffffff" strokeWidth="1" />
        <Circle cx={end.x} cy={end.y} r="5" fill="#cf222e" stroke="#ffffff" strokeWidth="1" />
        <SvgText x={end.x + 8} y={end.y + 14} fontSize="11" fontWeight="bold" fill="#cf222e">
          NOW ({lastPt.x.toFixed(1)}, {lastPt.y.toFixed(1)})
        </SvgText>
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f6f8fa" },
  container: { padding: 16, paddingBottom: 40 },
  title: { fontSize: 26, fontWeight: "800", color: "#24292f" },
  sub: { color: "#57606a", marginBottom: 12, fontSize: 13 },
  card: { backgroundColor: "white", borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#d0d7de" },
  plot: { backgroundColor: "white", borderRadius: 14, paddingTop: 14, marginBottom: 12, borderWidth: 1, borderColor: "#d0d7de", alignItems: "center" },
  label: { fontWeight: "700", color: "#57606a", marginBottom: 6, fontSize: 13 },
  status: { marginTop: 4, color: "#0969da", fontWeight: "600", fontSize: 13 },
  row: { flexDirection: "row", gap: 10, marginBottom: 10 },
  metric: { flex: 1, backgroundColor: "white", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#d0d7de" },
  metricHighlight: { borderColor: "#54aeff", backgroundColor: "#f0f8ff" },
  metricLabel: { fontSize: 11, color: "#57606a", fontWeight: "600" },
  metricValue: { fontSize: 20, fontWeight: "800", color: "#24292f", marginTop: 2 },
  help: { color: "#57606a", lineHeight: 19, fontSize: 12 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: "#8c959f", backgroundColor: "white" },
  btnStrong: { backgroundColor: "#1f6feb", borderColor: "#1f6feb" },
  btnText: { fontWeight: "700", fontSize: 13 },

  autoBadge: { backgroundColor: "#dafbe1", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: "#2da44e" },
  autoBadgeText: { fontSize: 11, fontWeight: "700", color: "#1a7f37" },
  manualStepBtn: { marginTop: 10, backgroundColor: "#eef5ff", paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: "#54aeff", alignItems: "center" },
  manualStepBtnText: { fontSize: 13, fontWeight: "700", color: "#0969da" },

  // Tab switcher styles
  tabContainer: {
    flexDirection: "row",
    backgroundColor: "#e1e4e8",
    borderRadius: 12,
    padding: 3,
    marginBottom: 14,
    gap: 3,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 2,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  tabBtnActive: {
    backgroundColor: "#ffffff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  tabBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#57606a",
    textAlign: "center",
  },
  tabBtnTextActive: {
    color: "#1f6feb",
    fontWeight: "800",
  },

  // Legend styles
  legendRow: { flexDirection: "row", gap: 12, marginBottom: 8, marginTop: 2 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendColor: { width: 12, height: 4, borderRadius: 2 },
  legendText: { fontSize: 11, color: "#57606a", fontWeight: "600" },

  // Saved Paths list styles
  clearBtn: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: "#fff0f0", borderWidth: 1, borderColor: "#ffc9c9" },
  clearBtnText: { fontSize: 11, color: "#cf222e", fontWeight: "700" },
  savedItem: { flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: "#e1e4e8", marginBottom: 8, backgroundColor: "#fafafa" },
  savedItemSelected: { borderColor: "#d97706", backgroundColor: "#fffbeb" },
  savedTitle: { fontWeight: "700", fontSize: 13, color: "#24292f" },
  savedMeta: { fontSize: 11, color: "#57606a", marginTop: 1 },
  savedMetaSub: { fontSize: 11, color: "#0969da", fontWeight: "600", marginTop: 1 },
  actionBtn: { paddingVertical: 5, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, alignItems: "center", flexShrink: 0 },
  actionBtnOutline: { borderColor: "#1f6feb", backgroundColor: "white" },
  actionBtnActive: { backgroundColor: "#d97706", borderColor: "#d97706" },
  actionBtnDanger: { borderColor: "#ffc9c9", backgroundColor: "#fff0f0" },
  actionBtnText: { fontSize: 11, fontWeight: "700", color: "#1f6feb" }
});
