// ============================================================================
// MobilityModeSwitch.js — Walking / Wheelchair switch (PDR tab and Fusion Map)
//
// Saves the choice straight away (same setting the Settings screen used to
// hold: mobilityMode), so every screen and the sensors pick it up through
// subscribeAppSettings. Switching restarts the movement engines clean, so it is
// disabled while tracking / navigating.
// ============================================================================

import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { getAppSettings, saveAppSettings, subscribeAppSettings } from "../../services/appSettingsStorage.js";

const C = { card: "#161b22", border: "#30363d", text: "#e6edf3", sub: "#8b949e", accent: "#58a6ff", bg: "#0d1117" };
const MODES = [
  { key: "walking", label: "🚶 Walking" },
  { key: "wheelchair", label: "♿ Wheelchair" },
];

const read = () => (getAppSettings()?.mobilityMode === "wheelchair" ? "wheelchair" : "walking");

export default function MobilityModeSwitch({ disabled = false, hint = "" }) {
  const [mode, setMode] = useState(read);
  useEffect(() => {
    setMode(read());
    return subscribeAppSettings((s) => setMode(s?.mobilityMode === "wheelchair" ? "wheelchair" : "walking"));
  }, []);

  const choose = (key) => {
    if (disabled || key === mode) return;
    setMode(key);
    saveAppSettings({ mobilityMode: key });
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {MODES.map((m) => {
          const on = mode === m.key;
          return (
            <Pressable key={m.key} disabled={disabled} onPress={() => choose(m.key)} style={[styles.btn, on && styles.btnOn, disabled && !on && { opacity: 0.45 }]}>
              <Text style={[styles.txt, on && styles.txtOn]}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {!!hint && disabled && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10 },
  row: { flexDirection: "row", backgroundColor: C.card, borderRadius: 10, borderWidth: 1, borderColor: C.border, padding: 3 },
  btn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
  btnOn: { backgroundColor: C.accent },
  txt: { color: C.sub, fontSize: 13, fontWeight: "700" },
  txtOn: { color: C.bg },
  hint: { color: C.sub, fontSize: 11, marginTop: 4 },
});
