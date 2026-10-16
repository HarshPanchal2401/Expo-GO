// ============================================================================
// CellularPositioningScreen.js — EXPERIMENT: can cell towers help positioning?
//
// Isolated: it uses only services/cellular/*. It does not touch FusionEngine,
// PdrEngine, BLE or the floor plan, and shows nothing on the Fusion Map.
//
// It reads the cell Android reports, asks OpenCelliD (through your proxy) where
// that TOWER is, and plots the tower. It never calls the tower "your location".
// Monitoring stops when this tab is left.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, ActivityIndicator, Linking, Alert } from "react-native";
import { cellularEngine, openCelliD, requestCellularPermission } from "../../services/cellular/index.js";
import { maskId } from "../../services/cellular/CellularTypes.js";
import { formatLatLon, formatMeters, geoUri } from "../../services/cellular/CellularLocationUtils.js";
import CellularTowerMap from "./CellularTowerMap.js";

const C = {
  bg: "#0d1117", card: "#161b22", border: "#30363d", text: "#e6edf3", sub: "#8b949e",
  accent: "#58a6ff", ok: "#3fb950", warn: "#d29922", bad: "#f85149", btn: "#238636",
};

const STATUS_TEXT = {
  "tower-found": ["Tower found", C.ok],
  "tower-not-found": ["Tower not in OpenCelliD", C.warn],
  "no-serving-cell": ["No serving cell", C.warn],
  "serving-not-lookupable": ["Cell id unusable", C.warn],
  "lookup-error": ["Lookup failed", C.bad],
  "permission-denied": ["No permission", C.bad],
  unavailable: ["Unavailable", C.bad],
};

const SIM_STATES = { 0: "unknown", 1: "no SIM", 2: "PIN needed", 3: "PUK needed", 4: "network locked", 5: "ready", 6: "not ready", 7: "permanently disabled", 8: "card error", 9: "restricted" };

const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString() : "—");

function Row({ label, value, color }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, color && { color }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

export default function CellularPositioningScreen() {
  const [status, setStatus] = useState(cellularEngine.getStatus());
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [neighbours, setNeighbours] = useState(false);
  const [showIds, setShowIds] = useState(false);
  const [history, setHistory] = useState([]);
  const [proxyUrl, setProxyUrl] = useState("");
  const [proxyToken, setProxyToken] = useState("");
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxySaved, setProxySaved] = useState(false);
  const [usage, setUsage] = useState(openCelliD.getUsage());

  const refreshHistory = useCallback(() => cellularEngine.getHistory().then(setHistory), []);

  useEffect(() => {
    const unsub = cellularEngine.subscribe((s) => { setStatus(s); setUsage(openCelliD.getUsage()); });
    openCelliD.getProxy().then((p) => { setProxyUrl(p.url); setProxyToken(p.token); setProxySaved(Boolean(p.url)); setProxyOpen(!p.url); });
    refreshHistory();
    cellularEngine.getCellInfo(); // availability / permission, no lookup
    return () => {
      unsub();
      cellularEngine.stopMonitoring(); // no timer or subscription outlives this screen
    };
  }, [refreshHistory]);

  // The history lists a new test whenever the last result changes.
  useEffect(() => { refreshHistory(); }, [status.lastResult, refreshHistory]);

  const grant = async () => {
    const ok = await requestCellularPermission();
    if (!ok) Alert.alert("Permission needed", "Without location permission Android hides the cell identifiers.");
    cellularEngine.getCellInfo();
  };

  const find = async () => {
    setBusy(true);
    try { await cellularEngine.findLocation({ label: label.trim(), includeNeighbours: neighbours }); } finally { setBusy(false); }
  };

  const toggleMonitoring = () => (status.monitoring ? cellularEngine.stopMonitoring() : cellularEngine.startMonitoring({ label: label.trim() || "monitor" }));

  const saveProxy = async () => {
    const r = await openCelliD.setProxy(proxyUrl, proxyToken);
    if (!r.ok) { Alert.alert("Proxy address", r.error); return; }
    setProxySaved(Boolean(proxyUrl.trim()));
    setProxyOpen(false);
  };

  const info = status.info;
  const result = status.lastResult;
  const serving = info?.serving || null;
  const lookup = result?.lookup || null;
  const towers = useMemo(
    () => (result?.towers || []).map((t, i) => ({
      lat: t.tower.lat, lon: t.tower.lon, rangeM: t.tower.rangeM, serving: t.serving,
      label: t.serving ? "serving" : `nb ${i}`,
    })),
    [result]
  );
  const id = (v) => (showIds ? (v ?? "—") : maskId(v));

  const permission = status.permissionGranted;
  const nativeMissing = status.available === false;
  const [resText, resColor] = result ? STATUS_TEXT[result.status] || [result.status, C.sub] : ["No test yet", C.sub];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>📶 Cellular Test <Text style={styles.exp}>experimental</Text></Text>
      <Text style={styles.small}>
        Reads the cell tower your phone is connected to and asks OpenCelliD where that tower is. A tower is not your position, and this test does not change the Fusion Map.
      </Text>

      {/* A. Status */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Status</Text>
        <Row label="Cellular module" value={nativeMissing ? "not in this build" : status.available ? "available" : "checking…"} color={nativeMissing ? C.bad : status.available ? C.ok : C.sub} />
        <Row label="Location permission" value={permission === null ? "unknown" : permission ? "granted" : "not granted"} color={permission ? C.ok : permission === false ? C.bad : C.sub} />
        <Row label="Cellular service" value={status.serviceAvailable === null ? "—" : status.serviceAvailable ? `ready · ${info?.sim?.operatorName || info?.sim?.operator || ""}` : `not ready (SIM: ${SIM_STATES[info?.sim?.simState] ?? "unknown"})`} color={status.serviceAvailable ? C.ok : C.sub} />
        <Row label="Radio type" value={status.radio || "—"} />
        <Row label="Serving cell" value={status.servingAvailable === null ? "—" : status.servingAvailable ? "reported" : "not reported"} color={status.servingAvailable ? C.ok : C.sub} />
        <Row label="Last successful lookup" value={fmtTime(status.lastLookupAt)} />
        {nativeMissing && (
          <Text style={[styles.small, { color: C.warn, marginTop: 6 }]}>
            {info?.message} This tab needs a new Android build (not Expo Go, and not an APK built before this module).
          </Text>
        )}
        {info?.locationServicesOn === false && (
          <Text style={[styles.small, { color: C.warn, marginTop: 6 }]}>Location services are off in Android settings; Android may return no cells.</Text>
        )}
        {permission === false && (
          <Pressable style={styles.btnSecondary} onPress={grant}><Text style={styles.btnSecondaryTxt}>Grant location permission</Text></Pressable>
        )}
      </View>

      {/* B. Cell information */}
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Cell information</Text>
          <Pressable onPress={() => setShowIds((v) => !v)}><Text style={styles.link}>{showIds ? "Hide ids" : "Show ids"}</Text></Pressable>
        </View>
        {serving ? (
          <>
            <Row label="Role" value="Serving cell" />
            <Row label="Radio" value={serving.radio} />
            <Row label="MCC / MNC" value={`${serving.mcc ?? "—"} / ${serving.mnc ?? "—"}`} />
            <Row label="LAC / TAC" value={id(serving.areaCode)} />
            <Row label="Cell ID" value={id(serving.cellId)} />
            <Row label="Signal" value={serving.signalDbm !== null ? `${serving.signalDbm} dBm` : "unavailable"} />
            <Row label="Observed" value={`${fmtTime(serving.observedAt)}${serving.ageMs !== null ? ` (${Math.round(serving.ageMs / 1000)} s old)` : ""}`} />
            {!serving.lookupable && <Text style={[styles.small, { color: C.warn }]}>Not looked up: {serving.problems.join("; ")}.</Text>}
            <Text style={[styles.small, { marginTop: 6 }]}>
              Also reported: {info.neighbours.length} neighbour cell{info.neighbours.length === 1 ? "" : "s"}
              {info.neighbours.length ? ` (${info.neighbours.filter((n) => n.lookupable).length} with usable ids)` : ""}.
            </Text>
          </>
        ) : (
          <Text style={styles.small}>{info ? (info.ok ? "Android reports no serving cell right now." : info.message) : "Run a test or start monitoring."}</Text>
        )}
      </View>

      {/* C. Controls */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Test</Text>
        <Text style={styles.small}>Where are you testing? (Outdoors, Entrance, Office north…)</Text>
        <TextInput style={styles.input} value={label} onChangeText={setLabel} placeholder="Test position label" placeholderTextColor={C.sub} maxLength={40} />
        <Pressable style={styles.checkRow} onPress={() => setNeighbours((v) => !v)}>
          <Text style={styles.check}>{neighbours ? "☑" : "☐"}</Text>
          <Text style={styles.small}>Also look up neighbour cells (uses more of OpenCelliD's 1,000 lookups a day)</Text>
        </Pressable>
        <Pressable style={[styles.btn, (busy || nativeMissing) && { opacity: 0.5 }]} disabled={busy || nativeMissing} onPress={find}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnTxt}>Find Location (one test)</Text>}
        </Pressable>
        <View style={{ flexDirection: "row", marginTop: 8 }}>
          <Pressable style={[styles.btnSecondary, { flex: 1, marginRight: 8 }, (status.monitoring || nativeMissing) && { opacity: 0.4 }]} disabled={status.monitoring || nativeMissing} onPress={toggleMonitoring}>
            <Text style={styles.btnSecondaryTxt}>Start Monitoring</Text>
          </Pressable>
          <Pressable style={[styles.btnSecondary, { flex: 1 }, !status.monitoring && { opacity: 0.4 }]} disabled={!status.monitoring} onPress={toggleMonitoring}>
            <Text style={styles.btnSecondaryTxt}>Stop Monitoring</Text>
          </Pressable>
        </View>
        <Text style={styles.small}>
          {status.monitoring ? "Monitoring: cells are read every 10 s; OpenCelliD is asked only when the serving cell changes. Stops when you leave this tab." : `State: ${status.state}`}
        </Text>
        {status.error && !nativeMissing && <Text style={[styles.small, { color: C.bad }]}>{status.error}</Text>}
      </View>

      {/* Result */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Result</Text>
        <Text style={[styles.result, { color: resColor }]}>{resText}</Text>
        {lookup && (
          <>
            <Row label="Lookup" value={lookup.status === "error" ? `error: ${lookup.error?.message}` : lookup.status} color={lookup.status === "error" ? C.bad : undefined} />
            <Row label="Cache" value={lookup.cache === "hit" ? "hit (no request sent)" : lookup.cache === "miss" ? "miss (asked OpenCelliD)" : "—"} />
            <Row label="API latency" value={lookup.cache === "hit" ? "—" : `${lookup.latencyMs} ms`} />
          </>
        )}
        {towers[0] && (
          <>
            <Row label="Tower location" value={formatLatLon(towers[0])} />
            <Row label="Coverage range" value={towers[0].rangeM ? `${formatMeters(towers[0].rangeM)} (estimate)` : "not given"} />
            {result.towers[0].tower.samples !== null && <Row label="Samples" value={String(result.towers[0].tower.samples)} />}
            <Pressable style={styles.btnSecondary} onPress={() => Linking.openURL(geoUri(towers[0], "Cell tower (not your location)"))}>
              <Text style={styles.btnSecondaryTxt}>Open tower in Maps</Text>
            </Pressable>
          </>
        )}
        <Text style={[styles.label, { marginTop: 8 }]}>Phone position: none</Text>
        <Text style={styles.small}>
          {result?.note || "OpenCelliD gives where a tower is, not where the phone is. One tower cannot fix a position."}
        </Text>
        {towers.length > 0 ? <CellularTowerMap towers={towers} phone={result?.phoneEstimate || null} /> : null}
      </View>

      {/* Proxy */}
      <View style={styles.card}>
        <Pressable style={styles.cardHead} onPress={() => setProxyOpen((v) => !v)}>
          <Text style={styles.cardTitle}>Proxy {proxySaved ? "✓" : "(not set)"}</Text>
          <Text style={styles.link}>{proxyOpen ? "Hide" : "Edit"}</Text>
        </Pressable>
        <Text style={styles.small}>The OpenCelliD key is kept in the proxy, never in the app (see cellular-proxy/README.md).</Text>
        {proxyOpen && (
          <>
            <TextInput style={styles.input} value={proxyUrl} onChangeText={setProxyUrl} placeholder="https://cellular-test.<you>.workers.dev" placeholderTextColor={C.sub} autoCapitalize="none" autoCorrect={false} />
            <TextInput style={styles.input} value={proxyToken} onChangeText={setProxyToken} placeholder="Proxy token (if you set one)" placeholderTextColor={C.sub} autoCapitalize="none" autoCorrect={false} secureTextEntry />
            <Pressable style={styles.btn} onPress={saveProxy}><Text style={styles.btnTxt}>Save proxy</Text></Pressable>
          </>
        )}
        <Text style={[styles.small, { marginTop: 6 }]}>
          Requests this run: {usage.networkLookups} / {usage.limit} · cached cells: {usage.cached}
          {usage.pausedUntil ? " · paused (limit reached)" : ""}
        </Text>
      </View>

      {/* History */}
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Test history ({history.length})</Text>
          {history.length > 0 && (
            <Pressable onPress={() => cellularEngine.clearHistory().then(refreshHistory)}><Text style={[styles.link, { color: C.bad }]}>Clear</Text></Pressable>
          )}
        </View>
        {history.length === 0 && <Text style={styles.small}>No tests yet. Results here are real observations from this phone only.</Text>}
        {history.slice(0, 25).map((h, i) => {
          const [t, col] = STATUS_TEXT[h.status] || [h.status, C.sub];
          return (
            <View key={`${h.at}-${i}`} style={styles.hist}>
              <Text style={styles.histTop}>{fmtTime(h.at)} · {h.label || "no label"}</Text>
              <Text style={[styles.histStatus, { color: col }]}>{t}</Text>
              <Text style={styles.small}>
                {h.radio || "—"} {h.mccMnc || ""} · cell {h.cell || "—"} · {h.signalDbm !== null ? `${h.signalDbm} dBm` : "no signal value"}
                {h.lookup ? ` · ${h.cache === "hit" ? "cache" : `${h.latencyMs} ms`}` : ""}
                {h.error ? ` · ${h.error}` : ""}
              </Text>
              {h.tower && <Text style={styles.small}>tower {formatLatLon(h.tower)}{h.tower.rangeM ? ` · range ${formatMeters(h.tower.rangeM)}` : ""}</Text>}
            </View>
          );
        })}
        <Text style={[styles.small, { marginTop: 8 }]}>Tower data: OpenCelliD (CC BY-SA 4.0), opencellid.org. Ground-truth positions are noted separately; no error is calculated because no phone position is estimated.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { padding: 12, paddingBottom: 40 },
  title: { color: C.text, fontSize: 18, fontWeight: "800" },
  exp: { color: C.warn, fontSize: 12, fontWeight: "700" },
  small: { color: C.sub, fontSize: 11, marginTop: 4 },
  card: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12, marginTop: 12 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { color: C.text, fontSize: 14, fontWeight: "800", marginBottom: 4 },
  link: { color: C.accent, fontSize: 12, fontWeight: "700" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  rowLabel: { color: C.sub, fontSize: 12, flex: 1 },
  rowValue: { color: C.text, fontSize: 12, fontWeight: "700", flex: 1.4, textAlign: "right" },
  label: { color: C.text, fontSize: 13, fontWeight: "700" },
  result: { fontSize: 16, fontWeight: "800", marginBottom: 4 },
  input: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 8, color: C.text, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, marginTop: 8 },
  checkRow: { flexDirection: "row", alignItems: "center", marginTop: 8, marginBottom: 8, paddingRight: 24 },
  check: { color: C.accent, fontSize: 18, marginRight: 8 },
  btn: { backgroundColor: C.btn, borderRadius: 8, paddingVertical: 11, alignItems: "center", marginTop: 4 },
  btnTxt: { color: "#fff", fontSize: 14, fontWeight: "800" },
  btnSecondary: { borderWidth: 1, borderColor: C.accent, borderRadius: 8, paddingVertical: 9, alignItems: "center", marginTop: 8 },
  btnSecondaryTxt: { color: C.accent, fontSize: 13, fontWeight: "800" },
  hist: { borderTopWidth: 1, borderTopColor: C.border, paddingVertical: 6, marginTop: 6 },
  histTop: { color: C.text, fontSize: 12, fontWeight: "700" },
  histStatus: { fontSize: 12, fontWeight: "800" },
});
