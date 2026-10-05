// ============================================================================
// RawDistanceScreen.js — raw RSSI -> distance, nothing in between
//
//   Distance (m) = 10 ^ ((Measured Power - RSSI) / (10 x n))
//
// Raw RSSI goes through ONE optional step - a simple 1-D Kalman filter that
// smooths packet-to-packet fluctuation (switchable, with three strengths) -
// and then straight into the formula. Nothing else: no outlier gate, no
// averaging, no body / wall / radio-map correction, no calibration model. Measured Power (RSSI at 1 m) is set per
// beacon and n is shared; both can be changed while scanning and apply to the
// very next packet. Settings here are stored separately and do NOT change the
// main ranging engine used by the Fusion Map. Signal Lab shows the same numbers
// (see services/SimpleRanging.js).
//
// The beacons themselves are the B1 / B2 chosen in Signal Lab.
// ============================================================================

import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert } from "react-native";
import { v2Scanner } from "../../services/v2BeaconScannerService.js";
// The calculation itself lives in SimpleRanging.js, shared with Signal Lab.
import {
  simpleRanging, SIMPLE_DEFAULTS as DEFAULTS, SMOOTH_PRESETS, DIST_SMOOTH_PRESETS, rawDistanceM, kalmanStep,
} from "../../services/SimpleRanging.js";

export { rawDistanceM, kalmanStep };
const N_PRESETS = [2.0, 2.5, 3.0, 3.5, 4.0];

const C = {
  bg: "#0d1117", card: "#161b22", border: "#30363d",
  text: "#e6edf3", sub: "#8b949e", accent: "#58a6ff",
  b1: "#f78166", b2: "#3fb950", warn: "#d29922",
};

const fmtDist = (d) => (!Number.isFinite(d) ? "--" : d >= 100 ? d.toFixed(0) : d >= 10 ? d.toFixed(1) : d.toFixed(2));

function RawDistanceScreen() {
  const [settings, setSettings] = useState(DEFAULTS);
  const settingsRef = useRef(DEFAULTS);
  settingsRef.current = settings;
  const [nText, setNText] = useState({ 1: String(DEFAULTS.n1), 2: String(DEFAULTS.n2) });
  const [mpText, setMpText] = useState({ 1: String(DEFAULTS.mp1), 2: String(DEFAULTS.mp2) });
  const [scanning, setScanning] = useState(v2Scanner.scanning);
  // Per-beacon snapshot from the shared calculation.
  const [snap, setSnap] = useState({ 1: simpleRanging.getBeacon(1), 2: simpleRanging.getBeacon(2) });
  const [, setClock] = useState(0);

  useEffect(() => {
    let shownSettings = null;
    const unsub = simpleRanging.subscribe((sr) => {
      setSnap({ 1: sr.getBeacon(1), 2: sr.getBeacon(2) });
      // Text boxes follow the settings only when they change (load, or the
      // other screen) - not on every packet, which would fight the typing.
      const st = sr.settings;
      if (st !== shownSettings) {
        shownSettings = st;
        setSettings(st);
        setNText({ 1: String(st.n1), 2: String(st.n2) });
        setMpText({ 1: String(st.mp1), 2: String(st.mp2) });
      }
    });
    const unsubSt = v2Scanner.subscribeStatus((s) => setScanning(Boolean(s)));
    // Ages ("0.4 s ago") only.
    const id = setInterval(() => setClock(Date.now()), 500);
    return () => { unsub(); unsubSt(); clearInterval(id); };
  }, []);

  const save = (s) => simpleRanging.setSettings(s);

  const toggleScan = async () => {
    if (scanning) { v2Scanner.stopScan(); return; }
    const res = await v2Scanner.startScan();
    if (!res?.success) Alert.alert("Scan Could Not Start", res?.error || "Enable Bluetooth and Location.");
  };

  const nKey = (num) => (num === 1 ? "n1" : "n2");
  const setN = (num, v) => save({ [nKey(num)]: v });
  const commitNText = (num) => {
    const v = parseFloat(nText[num]);
    if (Number.isFinite(v) && v > 0) setN(num, v);
    else setNText((t) => ({ ...t, [num]: String(settingsRef.current[nKey(num)]) }));
  };
  const commitMp = (num) => {
    const v = parseFloat(mpText[num]);
    const key = num === 1 ? "mp1" : "mp2";
    if (Number.isFinite(v) && v < 0 && v > -120) save({ [key]: v });
    else setMpText((m) => ({ ...m, [num]: String(settingsRef.current[key]) }));
  };
  const useAdvertised = (num) => {
    const id = num === 1 ? v2Scanner.config.beacon1Id : v2Scanner.config.beacon2Id;
    const adv = id ? v2Scanner.discoveredDevices.get(id)?.advertisedTxPower : null;
    if (!Number.isFinite(adv)) {
      Alert.alert("Not Available", `Beacon ${num} is not advertising its measured power (or has not been seen yet).`);
      return;
    }
    save({ [num === 1 ? "mp1" : "mp2"]: adv });
  };

  const beacon = (num) => {
    const id = num === 1 ? v2Scanner.config.beacon1Id : v2Scanner.config.beacon2Id;
    const name = num === 1 ? v2Scanner.config.beacon1Name : v2Scanner.config.beacon2Name;
    const sb = snap[num];
    const mp = sb.mp;
    const n = sb.n;
    const p = sb.count ? { rssi: sb.rssi, kf: sb.kf, t: sb.t, count: sb.count } : null;
    // The RSSI the distance is calculated from: Kalman-smoothed or raw.
    const used = sb.used;
    const d = sb.distanceM;
    const dRaw = sb.rawDistanceM;
    const dFormula = sb.formulaDistanceM;
    const ageS = p ? (Date.now() - p.t) / 1000 : null;
    return { num, id, name, mp, n, p, used, d, dRaw, dFormula, ageS };
  };
  const beacons = [beacon(1), beacon(2)];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Text style={styles.title}>📏 Raw Distance</Text>
      <Text style={styles.formula}>Distance (m) = 10 ^ ((Measured Power − RSSI) / (10 × n))</Text>
      <Text style={styles.sub}>
        {settings.kalman
          ? `RSSI Kalman (${(SMOOTH_PRESETS[settings.smooth] || SMOOTH_PRESETS.medium).label}) → formula` +
            (settings.distKalman ? ` → distance Kalman (${(DIST_SMOOTH_PRESETS[settings.distSmooth] || DIST_SMOOTH_PRESETS.medium).label})` : "") +
            ". No other processing."
          : settings.distKalman
            ? `Raw RSSI → formula → distance Kalman (${(DIST_SMOOTH_PRESETS[settings.distSmooth] || DIST_SMOOTH_PRESETS.medium).label}).`
            : "Raw RSSI of each packet only — no filtering, no averaging, no corrections."}
      </Text>

      {/* ── Distances, above the two beacons ── */}
      <View style={styles.row}>
        {beacons.map((b) => (
          <View key={b.num} style={[styles.distCard, { borderColor: b.num === 1 ? C.b1 : C.b2 }]}>
            <Text style={[styles.distLabel, { color: b.num === 1 ? C.b1 : C.b2 }]}>B{b.num} distance</Text>
            <Text style={styles.distValue}>{fmtDist(b.d)}<Text style={styles.distUnit}> m</Text></Text>
            <Text style={styles.distFt}>{Number.isFinite(b.d) ? `${(b.d * 3.28084).toFixed(1)} ft` : " "}</Text>
            {settings.distKalman && Number.isFinite(b.dFormula) && (
              <Text style={styles.distFt}>before distance filter: {fmtDist(b.dFormula)} m</Text>
            )}
            {(settings.kalman || settings.distKalman) && Number.isFinite(b.dRaw) && (
              <Text style={styles.distFt}>raw packet: {fmtDist(b.dRaw)} m</Text>
            )}
          </View>
        ))}
      </View>

      {/* ── The two beacons ── */}
      <View style={styles.row}>
        {beacons.map((b) => {
          const color = b.num === 1 ? C.b1 : C.b2;
          const stale = b.ageS !== null && b.ageS > 3;
          return (
            <View key={b.num} style={[styles.card, { flex: 1, marginRight: b.num === 1 ? 8 : 0 }]}>
              <Text style={[styles.beaconTitle, { color }]}>Beacon {b.num}</Text>
              <Text style={styles.small} numberOfLines={1}>{b.id ? (b.name || b.id) : "Not selected (choose in Signal Lab)"}</Text>
              <Text style={styles.rssi}>
                {b.p ? (settings.kalman ? b.used.toFixed(1) : `${b.p.rssi}`) : "--"}
                <Text style={styles.rssiUnit}> dBm{settings.kalman ? " (Kalman)" : ""}</Text>
              </Text>
              {settings.kalman && b.p && <Text style={styles.small}>raw packet: {b.p.rssi} dBm</Text>}
              <Text style={[styles.small, stale && { color: C.warn }]}>
                {b.p ? `${b.p.count} packets · ${b.ageS.toFixed(1)} s ago${stale ? " (no signal)" : ""}` : "waiting for packets"}
              </Text>
              <Text style={[styles.label, { marginTop: 10 }]}>Measured Power (RSSI @ 1 m)</Text>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <TextInput
                  style={styles.input}
                  value={mpText[b.num]}
                  onChangeText={(t) => setMpText((m) => ({ ...m, [b.num]: t }))}
                  onEndEditing={() => commitMp(b.num)}
                  onSubmitEditing={() => commitMp(b.num)}
                  keyboardType="numbers-and-punctuation"
                />
                <Text style={styles.small}> dBm</Text>
              </View>
              <Pressable onPress={() => useAdvertised(b.num)}>
                <Text style={[styles.small, { color: C.accent, marginTop: 4 }]}>Use beacon's own value</Text>
              </Pressable>
              {b.p && (
                <Text style={[styles.small, { marginTop: 8 }]}>
                  10^(({b.mp} − ({settings.kalman ? b.used.toFixed(1) : b.p.rssi})) / (10 × {b.n})) = {fmtDist(b.dFormula)} m
                  {settings.distKalman ? ` → distance Kalman → ${fmtDist(b.d)} m` : ""}
                </Text>
              )}
            </View>
          );
        })}
      </View>

      {/* ── Kalman filter ── */}
      <View style={styles.card}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={[styles.label, { flex: 1 }]}>Kalman filter on RSSI (before the formula)</Text>
          <Pressable
            style={[styles.pill, settings.kalman && styles.pillOn, { marginRight: 0, marginBottom: 0 }]}
            onPress={() => save({ kalman: !settingsRef.current.kalman })}
          >
            <Text style={[styles.pillTxt, settings.kalman && { color: C.bg }]}>{settings.kalman ? "ON" : "OFF"}</Text>
          </Pressable>
        </View>
        {settings.kalman && (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}>
              {Object.entries(SMOOTH_PRESETS).map(([key, pr]) => (
                <Pressable
                  key={key}
                  style={[styles.pill, settings.smooth === key && styles.pillOn]}
                  onPress={() => save({ smooth: key })}
                >
                  <Text style={[styles.pillTxt, settings.smooth === key && { color: C.bg }]}>{pr.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.small}>
              Light = follows walking fastest · Medium = balanced · Strong = steadiest when standing (≈2 s to settle)
            </Text>
          </>
        )}
      </View>

      {/* ── Kalman filter on the distance ── */}
      <View style={styles.card}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={[styles.label, { flex: 1 }]}>Kalman filter on DISTANCE (after the formula)</Text>
          <Pressable
            style={[styles.pill, settings.distKalman && styles.pillOn, { marginRight: 0, marginBottom: 0 }]}
            onPress={() => save({ distKalman: !settingsRef.current.distKalman })}
          >
            <Text style={[styles.pillTxt, settings.distKalman && { color: C.bg }]}>{settings.distKalman ? "ON" : "OFF"}</Text>
          </Pressable>
        </View>
        {settings.distKalman && (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}>
              {Object.entries(DIST_SMOOTH_PRESETS).map(([key, pr]) => (
                <Pressable
                  key={key}
                  style={[styles.pill, settings.distSmooth === key && styles.pillOn]}
                  onPress={() => save({ distSmooth: key })}
                >
                  <Text style={[styles.pillTxt, settings.distSmooth === key && { color: C.bg }]}>{pr.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.small}>
              Smooths the distance itself; far readings (noisier) are smoothed more. Applies to Raw, Signal Lab and the Fusion Map.
            </Text>
          </>
        )}
      </View>

      {/* ── n per beacon, live ── */}
      <View style={styles.card}>
        <Text style={styles.label}>Path-loss exponent n — separate for each beacon (applies instantly)</Text>
        {[1, 2].map((num) => {
          const cur = settings[nKey(num)];
          const color = num === 1 ? C.b1 : C.b2;
          return (
            <View key={num} style={{ marginTop: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={[styles.beaconTitle, { color, width: 34 }]}>B{num}</Text>
                <Pressable style={styles.stepBtn} onPress={() => setN(num, cur - 0.1)}><Text style={styles.stepTxt}>−0.1</Text></Pressable>
                <TextInput
                  style={[styles.input, { width: 70, textAlign: "center", marginHorizontal: 8 }]}
                  value={nText[num]}
                  onChangeText={(t) => setNText((x) => ({ ...x, [num]: t }))}
                  onEndEditing={() => commitNText(num)}
                  onSubmitEditing={() => commitNText(num)}
                  keyboardType="decimal-pad"
                />
                <Pressable style={styles.stepBtn} onPress={() => setN(num, cur + 0.1)}><Text style={styles.stepTxt}>+0.1</Text></Pressable>
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 6, marginLeft: 34 }}>
                {N_PRESETS.map((v) => (
                  <Pressable
                    key={v}
                    style={[styles.pill, Math.abs(cur - v) < 0.001 && styles.pillOn]}
                    onPress={() => setN(num, v)}
                  >
                    <Text style={[styles.pillTxt, Math.abs(cur - v) < 0.001 && { color: C.bg }]}>{v.toFixed(1)}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          );
        })}
        <Text style={[styles.small, { marginTop: 6 }]}>2.0 = open space · 2.5–3 = office · 3.5–4+ = through walls</Text>
      </View>

      <Pressable style={[styles.scanBtn, scanning && { backgroundColor: "#da3633" }]} onPress={toggleScan}>
        <Text style={styles.scanTxt}>{scanning ? "■ Stop Scan" : "▶ Start Scan"}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  title: { color: C.text, fontSize: 20, fontWeight: "800" },
  formula: { color: C.accent, fontSize: 13, fontWeight: "700", marginTop: 6 },
  sub: { color: C.sub, fontSize: 12, marginTop: 4, marginBottom: 12 },
  row: { flexDirection: "row", marginBottom: 12 },
  distCard: {
    flex: 1, backgroundColor: C.card, borderWidth: 2, borderRadius: 12,
    paddingVertical: 14, alignItems: "center", marginHorizontal: 4,
  },
  distLabel: { fontSize: 12, fontWeight: "700" },
  distValue: { color: C.text, fontSize: 36, fontWeight: "800", marginTop: 2 },
  distUnit: { fontSize: 16, color: C.sub, fontWeight: "600" },
  distFt: { color: C.sub, fontSize: 12 },
  card: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 12, padding: 12, marginBottom: 12 },
  beaconTitle: { fontSize: 15, fontWeight: "800" },
  rssi: { color: C.text, fontSize: 26, fontWeight: "800", marginTop: 6 },
  rssiUnit: { fontSize: 13, color: C.sub, fontWeight: "600" },
  label: { color: C.text, fontSize: 12, fontWeight: "700" },
  small: { color: C.sub, fontSize: 11 },
  input: {
    backgroundColor: C.bg, color: C.text, borderColor: C.border, borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 6, fontSize: 15, minWidth: 60, marginTop: 4,
  },
  stepBtn: { backgroundColor: C.border, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  stepTxt: { color: C.text, fontWeight: "700" },
  pill: { borderColor: C.accent, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5, marginRight: 6, marginBottom: 6 },
  pillOn: { backgroundColor: C.accent },
  pillTxt: { color: C.accent, fontWeight: "700", fontSize: 12 },
  scanBtn: { backgroundColor: "#238636", borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  scanTxt: { color: "#fff", fontWeight: "800", fontSize: 15 },
});

export default React.memo(RawDistanceScreen);
