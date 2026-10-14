// ============================================================================
// BeaconSetupCard.js — which two beacons are B1 and B2 (Raw tab)
//
// The parts of the old Signal Lab screen that navigation needs, nothing else:
//   - scan scope: only B1 & B2 (the default, least phone load) or every
//     device in range (needed to pick a different beacon);
//   - the current B1 / B2, with Swap when they are the wrong way round;
//   - the devices in range, strongest first, with Set B1 / Set B2.
// All of it goes straight to the scanner service (v2BeaconScannerService),
// which stores the choice - exactly what Signal Lab called.
// ============================================================================

import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { v2Scanner } from "../../services/v2BeaconScannerService.js";
import { simpleRanging } from "../../services/SimpleRanging.js";

const C = {
  card: "#161b22", border: "#30363d", text: "#e6edf3", sub: "#8b949e",
  accent: "#58a6ff", b1: "#f78166", b2: "#3fb950", warn: "#d29922", bg: "#0d1117",
};
// Devices shown at most (strongest first); the list redraws twice a second.
const MAX_SHOWN = 20;
const REFRESH_MS = 500;

/** A device that broadcasts a real, human-readable name. */
const hasValidName = (dev) => {
  if (!dev) return false;
  if (dev.hasRealName !== undefined) return Boolean(dev.hasRealName);
  const n = typeof dev.name === "string" ? dev.name.trim() : "";
  if (!n || n.startsWith("Device (") || n === dev.id) return false;
  const l = n.toLowerCase();
  return !l.startsWith("unnamed") && l !== "unknown";
};

const rssiColor = (r) => (r >= -65 ? "#3fb950" : r >= -80 ? "#d29922" : "#f85149");

export default function BeaconSetupCard() {
  const [stats, setStats] = useState(() => v2Scanner.getStats());
  const [devices, setDevices] = useState(() => v2Scanner.getDiscoveredDevices());
  const [filter, setFilter] = useState("all"); // all | beacons | named

  useEffect(() => {
    const unsubStats = v2Scanner.subscribeStats((s) => setStats(s));
    // The device list changes with every packet: redraw it at most every
    // REFRESH_MS, so this card adds almost no load while scanning.
    let latest = null, timer = null;
    const unsubDev = v2Scanner.subscribeDiscovered((list) => {
      latest = list;
      if (!timer) timer = setTimeout(() => { timer = null; setDevices(latest); }, REFRESH_MS);
    });
    return () => { unsubStats(); unsubDev(); if (timer) clearTimeout(timer); };
  }, []);

  const b1Id = stats?.beacon1Id || null;
  const b2Id = stats?.beacon2Id || null;
  const targetOnly = stats?.targetBeaconsOnly !== false;
  const list = (Array.isArray(devices) ? devices : [])
    .filter((d) => d && (filter === "beacons" ? d.isBeacon : filter === "named" ? hasValidName(d) : true));

  const swap = () => {
    const res = v2Scanner.swapBeacons();
    if (!res?.success) Alert.alert("Cannot Swap", res?.error || "Select both B1 and B2 first.");
  };

  const slot = (num) => {
    const id = num === 1 ? b1Id : b2Id;
    const s = num === 1 ? stats?.b1 : stats?.b2;
    const name = num === 1 ? v2Scanner.config.beacon1Name : v2Scanner.config.beacon2Name;
    const color = num === 1 ? C.b1 : C.b2;
    return (
      <View key={num} style={[styles.slot, { borderColor: color, marginRight: num === 1 ? 8 : 0 }]}>
        <Text style={[styles.slotTitle, { color }]}>B{num}</Text>
        <Text style={styles.slotName} numberOfLines={1}>{id ? (name || s?.name || "Beacon") : "Not chosen"}</Text>
        <Text style={styles.small} numberOfLines={1}>{id || "—"}</Text>
        <Text style={styles.small}>{Number.isFinite(s?.rawRssi) ? `${s.rawRssi} dBm` : "no signal"}</Text>
      </View>
    );
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>📡 Beacons (B1 / B2)</Text>
      <Text style={styles.small}>Choose your two beacons here. The Fusion Map uses B1 and B2.</Text>

      {/* Scan scope */}
      <View style={styles.scopeRow}>
        <View style={{ flex: 1, paddingRight: 8 }}>
          <Text style={styles.label}>{targetOnly ? "🔒 Scanning only B1 & B2" : "🌐 Scanning all devices"}</Text>
          <Text style={styles.small}>
            {targetOnly
              ? "Least phone load. To pick a different beacon, switch to Scan all."
              : "Shows every Bluetooth device in range (more phone load)."}
          </Text>
        </View>
        <Pressable
          style={[styles.pill, !targetOnly && styles.pillOn]}
          onPress={() => v2Scanner.setTargetBeaconsOnly(!targetOnly)}
        >
          <Text style={[styles.pillTxt, !targetOnly && { color: C.bg }]}>{targetOnly ? "Scan all" : "Only B1 & B2"}</Text>
        </Pressable>
      </View>

      {/* Current slots */}
      <View style={{ flexDirection: "row", marginTop: 10 }}>{[1, 2].map(slot)}</View>
      {b1Id && b1Id === b2Id && (
        <Text style={[styles.small, { color: C.warn, marginTop: 6 }]}>
          ⚠ B1 and B2 are the same beacon. Set a different device for one of them.
        </Text>
      )}
      <Pressable
        style={[styles.swapBtn, (!b1Id || !b2Id) && { opacity: 0.4 }]}
        disabled={!b1Id || !b2Id}
        onPress={swap}
      >
        <Text style={styles.swapTxt}>⇄ Swap B1 / B2</Text>
      </Pressable>
      <Text style={styles.small}>
        B1 must be the beacon placed at B1 on the map. If they are the wrong way round, tap Swap.
      </Text>

      {/* Devices in range */}
      <View style={styles.listHead}>
        <Text style={[styles.label, { flex: 1 }]}>Devices in range ({list.length})</Text>
        {list.length >= 2 && (
          <Pressable style={styles.pill} onPress={() => v2Scanner.autoSelectTopTwo()}>
            <Text style={styles.pillTxt}>⚡ Auto-pick top 2</Text>
          </Pressable>
        )}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {[["all", "All"], ["beacons", "iBeacons"], ["named", "With name"]].map(([key, label]) => (
          <Pressable key={key} style={[styles.pill, filter === key && styles.pillOn]} onPress={() => setFilter(key)}>
            <Text style={[styles.pillTxt, filter === key && { color: C.bg }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {list.length === 0 ? (
        <Text style={[styles.small, { marginTop: 6 }]}>
          {v2Scanner.scanning
            ? targetOnly ? "Only B1 & B2 are scanned. Switch to Scan all to see other devices." : "Searching for nearby Bluetooth devices…"
            : "No devices yet. Tap ▶ Start Scan at the bottom."}
        </Text>
      ) : (
        list.slice(0, MAX_SHOWN).map((dev) => {
          const isB1 = dev.id === b1Id;
          const isB2 = dev.id === b2Id;
          const st = simpleRanging.settings;
          const mp = isB1 ? st.mp1 : isB2 ? st.mp2 : Number.isFinite(dev.advertisedTxPower) ? dev.advertisedTxPower : -59;
          const n = isB1 ? st.n1 : isB2 ? st.n2 : null;
          const est = Number.isFinite(dev.rawRssi) ? simpleRanging.estimateM(dev.rawRssi, mp, n) : null;
          return (
            <View key={dev.id} style={[styles.dev, isB1 && { borderColor: C.b1 }, isB2 && { borderColor: C.b2 }]}>
              <View style={{ flex: 1, paddingRight: 6 }}>
                <Text style={styles.devName} numberOfLines={1}>{dev.isBeacon ? "🔵 " : ""}{dev.name || "Device"}</Text>
                <Text style={styles.small} numberOfLines={1}>{dev.id}</Text>
                <Text style={[styles.small, { color: rssiColor(dev.rawRssi) }]}>
                  {Number.isFinite(dev.rawRssi) ? `${dev.rawRssi} dBm` : "--"}
                  {Number.isFinite(est) ? ` · ~${est.toFixed(1)} m` : ""}
                </Text>
              </View>
              {isB1 ? (
                <Text style={[styles.active, { color: C.b1 }]}>✓ B1</Text>
              ) : (
                <Pressable style={[styles.setBtn, { borderColor: C.b1 }]} onPress={() => v2Scanner.selectBeacon(1, dev.id, dev.name)}>
                  <Text style={[styles.setTxt, { color: C.b1 }]}>Set B1</Text>
                </Pressable>
              )}
              {isB2 ? (
                <Text style={[styles.active, { color: C.b2 }]}>✓ B2</Text>
              ) : (
                <Pressable style={[styles.setBtn, { borderColor: C.b2 }]} onPress={() => v2Scanner.selectBeacon(2, dev.id, dev.name)}>
                  <Text style={[styles.setTxt, { color: C.b2 }]}>Set B2</Text>
                </Pressable>
              )}
            </View>
          );
        })
      )}
      {list.length > MAX_SHOWN && (
        <Text style={[styles.small, { marginTop: 4 }]}>Showing the {MAX_SHOWN} strongest of {list.length}.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12, marginBottom: 12 },
  title: { color: C.text, fontSize: 15, fontWeight: "800", marginBottom: 2 },
  label: { color: C.text, fontSize: 13, fontWeight: "700" },
  small: { color: C.sub, fontSize: 11 },
  scopeRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  pill: {
    borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5,
    marginRight: 6, marginBottom: 6,
  },
  pillOn: { backgroundColor: C.accent, borderColor: C.accent },
  pillTxt: { color: C.text, fontSize: 12, fontWeight: "700" },
  slot: { flex: 1, borderWidth: 1, borderRadius: 10, padding: 8 },
  slotTitle: { fontSize: 14, fontWeight: "800" },
  slotName: { color: C.text, fontSize: 12, fontWeight: "700", marginTop: 2 },
  swapBtn: {
    marginTop: 8, marginBottom: 4, borderWidth: 1, borderColor: C.accent, borderRadius: 8,
    paddingVertical: 8, alignItems: "center",
  },
  swapTxt: { color: C.accent, fontSize: 13, fontWeight: "800" },
  listHead: { flexDirection: "row", alignItems: "center", marginTop: 12, marginBottom: 6 },
  dev: {
    flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: C.border,
    borderRadius: 8, padding: 8, marginTop: 6,
  },
  devName: { color: C.text, fontSize: 13, fontWeight: "700" },
  setBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, marginLeft: 6 },
  setTxt: { fontSize: 12, fontWeight: "800" },
  active: { fontSize: 12, fontWeight: "800", marginLeft: 8, minWidth: 40, textAlign: "center" },
});
