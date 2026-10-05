// ============================================================================
// AppSettingsScreen — In-App Runtime Configuration Panel (Premium UI)
//
// Live tuning of the PDR step detector and stride model - the only settings
// the app still reads. BLE distance settings (Measured Power, n, Kalman) live
// on the Raw tab (shared with Signal Lab and the Fusion Map); room size lives
// on the Fusion Map.
// ============================================================================

import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
} from "react-native";

import {
  loadAppSettings,
  saveAppSettings,
  resetAppSettings,
  DEFAULT_APP_SETTINGS,
} from "../services/appSettingsStorage.js";

let Updates = null;
try {
  Updates = require("expo-updates");
} catch (e) {}

export default function AppSettingsScreen() {
  const [settings, setSettings] = useState(DEFAULT_APP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  useEffect(() => {
    loadAppSettings().then((cfg) => {
      setSettings(cfg);
      setLoading(false);
    });
  }, []);

  const updateParam = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSavedSuccess(false);
    setHasUnsavedChanges(true);
  };

  const handleSave = async () => {
    try {
      await saveAppSettings(settings);
      setSavedSuccess(true);
      setHasUnsavedChanges(false);
      Alert.alert(
        "Settings Saved! 🎉",
        "All parameters have been saved to local storage and applied live to active filters.",
        [{ text: "OK" }]
      );
      setTimeout(() => setSavedSuccess(false), 3500);
    } catch (e) {
      Alert.alert("Save Error", "Failed to persist settings: " + (e.message || String(e)));
    }
  };

  const handleReset = () => {
    Alert.alert(
      "Reset Settings",
      "Are you sure you want to reset all parameters to factory defaults?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset to Defaults",
          style: "destructive",
          onPress: async () => {
            const fresh = await resetAppSettings();
            setSettings(fresh);
            setSavedSuccess(true);
            setHasUnsavedChanges(false);
            setTimeout(() => setSavedSuccess(false), 2500);
          },
        },
      ]
    );
  };

  const handleRestartApp = async () => {
    if (Updates && Updates.reloadAsync) {
      try {
        await Updates.reloadAsync();
      } catch (e) {
        Alert.alert("Reload", "Please restart the app to apply fresh cold-boot configs.");
      }
    } else {
      Alert.alert(
        "Restart App",
        "Settings are saved. To perform a cold restart, swipe the app away from recent apps and reopen it."
      );
    }
  };

  if (loading) {
    return (
      <View style={s.centerBox}>
        <ActivityIndicator size="large" color="#1f6feb" />
        <Text style={s.centerText}>Loading configurations...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      {/* Header Banner */}
      <View style={s.header}>
        <View style={s.headerBadge}>
          <Text style={s.headerBadgeText}>⚙️ CONFIG ENGINE</Text>
        </View>
        <Text style={s.headerTitle}>App Parameter Tuning</Text>
        <Text style={s.headerSub}>
          Tune the step detector and stride length. BLE distance settings (Measured Power, n, Kalman) are on the 📏 Raw tab; room size is on the Fusion Map.
        </Text>
      </View>

      {/* Action Toolbar */}
      <View style={s.actionRow}>
        <Pressable onPress={handleSave} style={[s.actionBtn, s.btnSave]}>
          <Text style={s.btnSaveText}>💾 Save & Apply</Text>
        </Pressable>
        <Pressable onPress={handleRestartApp} style={[s.actionBtn, s.btnRestart]}>
          <Text style={s.btnRestartText}>🔄 Restart App</Text>
        </Pressable>
      </View>

      {/* Unsaved Changes Banner */}
      {hasUnsavedChanges && (
        <View style={s.unsavedBanner}>
          <Text style={s.unsavedText}>⚠️ Unsaved changes — Tap "Save & Apply" above to persist.</Text>
        </View>
      )}

      {/* Saved Success Toast */}
      {savedSuccess && (
        <View style={s.successBanner}>
          <Text style={s.successText}>✅ Parameters saved and active immediately!</Text>
        </View>
      )}

      {/* ──────────────────────────────────────────────────────────────────── */}
      {/* SECTION 3: PDR STEP DETECTOR & WEINBERG STRIDE                       */}
      {/* ──────────────────────────────────────────────────────────────────── */}
      <View style={s.card}>
        <View style={s.cardHeader}>
          <View style={{ flex: 1 }}>
            <Text style={s.cardTitle}>🚶 PDR & Step Detection</Text>
            <Text style={s.cardDesc}>
              Dynamic Weinberg stride model and accelerometer sensitivity for handheld walking.
            </Text>
          </View>
        </View>

        <SettingNumberRow
          label="Weinberg Stride Gain (K)"
          hint="StepLen = K · (Bounce)^0.25 (typical: 0.65 - 0.85)"
          unit=""
          value={settings.weinbergK}
          step={0.02}
          min={0.4}
          max={1.4}
          decimals={2}
          onChange={(val) => updateParam("weinbergK", val)}
        />

        <SettingNumberRow
          label="ZUPT Stationary Gate"
          hint="Variance gate to detect standing still; lower = more sensitive"
          unit="g²"
          value={settings.zuptVariance}
          step={0.001}
          min={0.001}
          max={0.04}
          decimals={3}
          onChange={(val) => updateParam("zuptVariance", val)}
        />

        <SettingNumberRow
          label="Peak Threshold"
          hint="Foot-strike acceleration peak (lowered for handheld walking)"
          unit="g"
          value={settings.peakThreshold}
          step={0.01}
          min={0.04}
          max={0.4}
          decimals={2}
          onChange={(val) => updateParam("peakThreshold", val)}
        />

        <SettingNumberRow
          label="Min Bounce Swing"
          hint="Minimum (Peak - Valley) difference to confirm valid step"
          unit="g"
          value={settings.bounceDiffMin}
          step={0.02}
          min={0.06}
          max={0.5}
          decimals={2}
          onChange={(val) => updateParam("bounceDiffMin", val)}
        />

        <SettingNumberRow
          label="Min Cadence Window"
          hint="Fastest allowable step interval (prevents double-counts)"
          unit="ms"
          value={settings.minCadenceMs || 250}
          step={25}
          min={150}
          max={500}
          decimals={0}
          onChange={(val) => updateParam("minCadenceMs", val)}
        />

      </View>

      {/* Reset to Factory Defaults */}
      <View style={s.resetContainer}>
        <Pressable onPress={handleReset} style={s.resetBtn}>
          <Text style={s.resetBtnText}>⏪ Reset All Settings to Factory Defaults</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

// ============================================================================
// SettingNumberRow — Unsquashable, High-Contrast, Fully Editable Text Input
// ============================================================================
function SettingNumberRow({
  label,
  hint,
  unit,
  value,
  step = 1,
  min = -100,
  max = 100,
  decimals = 2,
  onChange,
}) {
  const [localText, setLocalText] = useState(
    value !== undefined && value !== null ? Number(value).toFixed(decimals) : ""
  );
  const [isFocused, setIsFocused] = useState(false);

  // Re-sync local string when numeric prop changes from external source
  useEffect(() => {
    if (!isFocused && value !== undefined && value !== null) {
      setLocalText(Number(value).toFixed(decimals));
    }
  }, [value, decimals, isFocused]);

  const commitValue = (val) => {
    const clamped = Math.max(min, Math.min(max, val));
    const rounded = Number(clamped.toFixed(decimals));
    setLocalText(rounded.toFixed(decimals));
    onChange(rounded);
  };

  const handleStep = (delta) => {
    const cur = parseFloat(localText) || value || 0;
    commitValue(cur + delta);
  };

  const handleTextChange = (text) => {
    setLocalText(text);
    const parsed = parseFloat(text);
    if (isFinite(parsed)) {
      const clamped = Math.max(min, Math.min(max, parsed));
      onChange(Number(clamped.toFixed(decimals)));
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    const parsed = parseFloat(localText);
    if (isFinite(parsed)) {
      commitValue(parsed);
    } else {
      setLocalText(Number(value || 0).toFixed(decimals));
    }
  };

  return (
    <View style={s.inputRow}>
      {/* Left Column: Label + Hint (wraps cleanly without compressing input) */}
      <View style={s.inputLabelCol}>
        <View style={s.labelWithUnitRow}>
          <Text style={s.inputLabel}>{label}</Text>
          {unit ? <Text style={s.unitBadge}>{unit}</Text> : null}
        </View>
        {hint ? <Text style={s.inputHint}>{hint}</Text> : null}
      </View>

      {/* Right Column: Stepper Buttons + Text Input (fixed width, NEVER squashes) */}
      <View style={s.stepperCol}>
        <Pressable
          onPress={() => handleStep(-step)}
          style={({ pressed }) => [s.stepperBtn, pressed && s.stepperBtnPressed]}
          hitSlop={4}
        >
          <Text style={s.stepperBtnText}>−</Text>
        </Pressable>

        <TextInput
          style={[s.stepperInput, isFocused && s.stepperInputFocused]}
          value={localText}
          onChangeText={handleTextChange}
          onFocus={() => setIsFocused(true)}
          onBlur={handleBlur}
          keyboardType={min < 0 ? "numbers-and-punctuation" : "decimal-pad"}
          selectTextOnFocus
          underlineColorAndroid="transparent"
          autoCorrect={false}
          autoCapitalize="none"
        />

        <Pressable
          onPress={() => handleStep(step)}
          style={({ pressed }) => [s.stepperBtn, pressed && s.stepperBtnPressed]}
          hitSlop={4}
        >
          <Text style={s.stepperBtnText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ============================================================================
// STYLES
// ============================================================================
const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f4f6f9",
  },
  content: {
    padding: 14,
    paddingBottom: 60,
  },
  centerBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
  },
  centerText: {
    marginTop: 12,
    color: "#57606a",
    fontSize: 14,
    fontWeight: "600",
  },
  header: {
    marginBottom: 12,
  },
  headerBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#ddf4ff",
    borderWidth: 1,
    borderColor: "#54aeff",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 6,
  },
  headerBadgeText: {
    fontSize: 10,
    fontWeight: "800",
    color: "#0969da",
    letterSpacing: 0.5,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "900",
    color: "#1e293b",
    letterSpacing: -0.5,
  },
  headerSub: {
    fontSize: 12.5,
    color: "#475569",
    marginTop: 4,
    lineHeight: 18,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 12,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  btnSave: {
    backgroundColor: "#1f6feb",
  },
  btnSaveText: {
    color: "#ffffff",
    fontWeight: "800",
    fontSize: 14,
  },
  btnRestart: {
    backgroundColor: "#2da44e",
  },
  btnRestartText: {
    color: "#ffffff",
    fontWeight: "800",
    fontSize: 14,
  },
  unsavedBanner: {
    backgroundColor: "#fff8c5",
    borderWidth: 1,
    borderColor: "#d4a72c",
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
    alignItems: "center",
  },
  unsavedText: {
    color: "#7d4e17",
    fontWeight: "700",
    fontSize: 12,
    textAlign: "center",
  },
  successBanner: {
    backgroundColor: "#dafbe1",
    borderWidth: 1,
    borderColor: "#4ac26b",
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
    alignItems: "center",
  },
  successText: {
    color: "#1a7f37",
    fontWeight: "800",
    fontSize: 12.5,
    textAlign: "center",
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#0f172a",
  },
  cardDesc: {
    fontSize: 11.5,
    color: "#64748b",
    marginTop: 2,
    marginBottom: 8,
    lineHeight: 16,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
    gap: 8,
  },
  inputRowStacked: {
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
  },
  inputLabelCol: {
    flex: 1,
    minWidth: 0,
    paddingRight: 6,
  },
  labelWithUnitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1e293b",
    lineHeight: 18,
  },
  unitBadge: {
    fontSize: 10,
    fontWeight: "800",
    color: "#0969da",
    backgroundColor: "#f0f8ff",
    borderWidth: 1,
    borderColor: "#b6e3ff",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  inputHint: {
    fontSize: 11,
    color: "#64748b",
    marginTop: 2,
    lineHeight: 15,
  },
  stepperCol: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  stepperBtn: {
    width: 36,
    height: 38,
    borderRadius: 8,
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    alignItems: "center",
    justifyContent: "center",
  },
  stepperBtnPressed: {
    backgroundColor: "#e2e8f0",
  },
  stepperBtnText: {
    fontSize: 19,
    fontWeight: "800",
    color: "#1e293b",
    lineHeight: 22,
  },
  stepperInput: {
    width: 76,
    height: 38,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#cbd5e1",
    backgroundColor: "#ffffff",
    textAlign: "center",
    fontSize: 14,
    fontWeight: "800",
    color: "#0f172a",
    paddingVertical: 0,
    paddingHorizontal: 6,
    includeFontPadding: false,
  },
  stepperInputFocused: {
    borderColor: "#1f6feb",
    backgroundColor: "#f0f8ff",
  },
  unitGroup: {
    flexDirection: "row",
    gap: 6,
  },
  unitBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
  },
  unitBtnActive: {
    backgroundColor: "#1f6feb",
    borderColor: "#1f6feb",
  },
  unitBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#475569",
  },
  unitBtnTextActive: {
    color: "#ffffff",
  },
  resetContainer: {
    alignItems: "center",
    marginTop: 8,
    marginBottom: 20,
  },
  resetBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: "#fff1f2",
    borderWidth: 1,
    borderColor: "#fecdd3",
  },
  resetBtnText: {
    fontSize: 12.5,
    fontWeight: "800",
    color: "#e11d48",
  },
});
