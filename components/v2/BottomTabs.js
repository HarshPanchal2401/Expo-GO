// ============================================================================
// BottomTabs.js — the app's bottom navigation: Map, Track, Signals, Settings
// ============================================================================

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Icon, THEME as C } from "./Icons.js";

// id = the activeTab value in App.android.js / App.ios.js
const TABS = [
  { id: "fusionMap", label: "Map", icon: "map" },
  { id: "pdr", label: "Track", icon: "route" },
  { id: "raw", label: "Signals", icon: "radio" },
  { id: "settings", label: "Settings", icon: "sliders" },
];

export default function BottomTabs({ active, onChange }) {
  return (
    <View style={styles.bar}>
      {TABS.map((t) => {
        const on = active === t.id;
        return (
          <Pressable key={t.id} style={styles.tab} onPress={() => onChange(t.id)} android_ripple={{ color: "rgba(255,255,255,0.06)" }}>
            <Icon name={t.icon} size={26} color={on ? C.accent : C.textSecondary} strokeWidth={on ? 2.1 : 1.8} />
            <Text style={[styles.label, on && styles.labelOn]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: C.bg,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 10,
    paddingBottom: 12,
  },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4 },
  label: { color: C.textSecondary, fontSize: 13, fontWeight: "600" },
  labelOn: { color: C.accent },
});
