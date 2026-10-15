// ============================================================================
// Calibrate1mCard.js — measure a beacon's Measured Power at 1 m (Raw tab)
//
// Measured Power (MP) is the RSSI at 1 m: the formula
//   d = 10 ^ ((MP - RSSI) / (10 n))
// gives exactly 1 m when RSSI = MP. A wrong MP scales EVERY distance from that
// beacon (3 dB off = about 40% off at n = 2), so this is the most important
// number to measure on the real beacon and phone.
//
// How: hold the phone 1 m from the beacon and collect packets for
// COLLECT_S seconds. MP = trimmed mean of the raw RSSI (the same raw RSSI the
// distance uses, from the scanner's packets). The card also shows what the
// CURRENT setting reads at 1 m - so it doubles as a check - and Apply saves
// the new MP for that beacon (simpleRanging, as the Measured Power box does).
// ============================================================================

import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { v2Scanner } from "../../services/v2BeaconScannerService.js";
import { simpleRanging, rawDistanceM } from "../../services/SimpleRanging.js";

const C = {
  card: "#161b22", border: "#30363d", text: "#e6edf3", sub: "#8b949e",
  accent: "#58a6ff", b1: "#f78166", b2: "#3fb950", warn: "#d29922", ok: "#3fb950", bg: "#0d1117",
};
// Collect this long; the first SETTLE_S are skipped (the user is still
// putting the phone in place).
const COLLECT_S = 15;
const SETTLE_S = 1.5;
// Fewer packets than this, or a wider spread, gives a result marked unreliable.
const MIN_PACKETS = 20;
const MAX_GOOD_SD_DB = 5;
// Fraction trimmed off each end before averaging (drops reflections / dips).
const TRIM = 0.2;
// Plausible MP range (dBm).
const MP_MIN = -100, MP_MAX = -30;

function summarize(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const k = Math.floor(s.length * TRIM);
  const core = s.length - 2 * k >= 3 ? s.slice(k, s.length - k) : s;
  const mean = core.reduce((a, v) => a + v, 0) / core.length;
  const all = vals.reduce((a, v) => a + v, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - all) ** 2, 0) / vals.length);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { mean, median, sd, n: vals.length, min: s[0], max: s[s.length - 1] };
}

export default function Calibrate1mCard() {
  const [target, setTarget] = useState(1);
  // idle | collecting | done
  const [stage, setStage] = useState("idle");
  const [progress, setProgress] = useState({ n: 0, elapsedS: 0, live: null });
  const [result, setResult] = useState(null);
  const runRef = useRef(null); // { num, start, vals }

  useEffect(() => {
    const unsub = v2Scanner.subscribePackets((pkt) => {
      const run = runRef.current;
      if (!run || pkt?.beaconNum !== run.num || !Number.isFinite(pkt.rawRssi)) return;
      if (Date.now() - run.start < SETTLE_S * 1000) return;
      run.vals.push(pkt.rawRssi);
    });
    const id = setInterval(() => {
      const run = runRef.current;
      if (!run) return;
      const elapsedS = (Date.now() - run.start) / 1000;
      const live = summarize(run.vals);
      setProgress({ n: run.vals.length, elapsedS, live });
      if (elapsedS >= COLLECT_S) finish();
    }, 250);
    return () => { unsub(); clearInterval(id); runRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beaconId = (num) => (num === 1 ? v2Scanner.config.beacon1Id : v2Scanner.config.beacon2Id);

  const start = async () => {
    if (!beaconId(target)) {
      Alert.alert("Choose the Beacon First", `B${target} is not selected. Pick it in the Beacons card above.`);
      return;
    }
    if (!v2Scanner.scanning) {
      const res = await v2Scanner.startScan();
      if (!res?.success) {
        Alert.alert("Scan Could Not Start", res?.error || "Enable Bluetooth and Location.");
        return;
      }
    }
    setResult(null);
    setProgress({ n: 0, elapsedS: 0, live: null });
    runRef.current = { num: target, start: Date.now(), vals: [] };
    setStage("collecting");
  };

  const finish = () => {
    const run = runRef.current;
    runRef.current = null;
    if (!run) return;
    const sum = summarize(run.vals);
    if (!sum) {
      setStage("idle");
      Alert.alert("No Packets", `No packets from B${run.num} were received. Check it is on and close by.`);
      return;
    }
    const st = simpleRanging.settings;
    const curMp = run.num === 1 ? st.mp1 : st.mp2;
    const n = run.num === 1 ? st.n1 : st.n2;
    const mp = Math.round(sum.mean);
    setResult({
      num: run.num,
      ...sum,
      mp,
      curMp,
      // What the current setting reads with the phone at 1 m (the check).
      currentReadsM: rawDistanceM(sum.mean, curMp, n),
      reliable: sum.n >= MIN_PACKETS && sum.sd <= MAX_GOOD_SD_DB && mp >= MP_MIN && mp <= MP_MAX,
    });
    setStage("done");
  };

  const cancel = () => {
    runRef.current = null;
    setStage("idle");
  };

  const apply = () => {
    if (!result) return;
    simpleRanging.setSettings({ [result.num === 1 ? "mp1" : "mp2"]: result.mp });
    Alert.alert(
      "Measured Power Saved",
      `B${result.num} Measured Power is now ${result.mp} dBm. At 1 m it now reads 1.0 m. The Fusion Map uses it from the next packet.`
    );
    setResult({ ...result, applied: true, curMp: result.mp, currentReadsM: 1 });
  };

  const color = (num) => (num === 1 ? C.b1 : C.b2);
  const pct = Math.min(1, progress.elapsedS / COLLECT_S);
  const errPct = result ? Math.round((result.currentReadsM - 1) * 100) : 0;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>🎯 1 m Calibration (Measured Power)</Text>
      <Text style={styles.small}>
        Hold the phone 1 m from the beacon, at the same height, nothing in between, and keep still.
        It measures for {COLLECT_S} s, shows what the current setting reads at 1 m, and can save the correct value.
      </Text>

      {/* Which beacon */}
      <View style={styles.row}>
        {[1, 2].map((num) => (
          <Pressable
            key={num}
            disabled={stage === "collecting"}
            style={[styles.pick, { borderColor: color(num) }, target === num && { backgroundColor: color(num) }]}
            onPress={() => { setTarget(num); if (stage === "done") { setStage("idle"); setResult(null); } }}
          >
            <Text style={[styles.pickTxt, { color: target === num ? C.bg : color(num) }]}>
              B{num}{beaconId(num) ? "" : " (not chosen)"}
            </Text>
          </Pressable>
        ))}
      </View>

      {stage === "collecting" ? (
        <>
          <Text style={styles.label}>
            Measuring B{target}… {Math.max(0, COLLECT_S - progress.elapsedS).toFixed(0)} s left · {progress.n} packets
            {progress.live ? ` · avg ${progress.live.mean.toFixed(1)} dBm` : progress.elapsedS < SETTLE_S ? " · hold still" : ""}
          </Text>
          <View style={styles.track}><View style={[styles.bar, { width: `${Math.round(pct * 100)}%` }]} /></View>
          <View style={styles.row}>
            <Pressable style={[styles.btn, { flex: 1, marginRight: 8 }]} onPress={cancel}>
              <Text style={styles.btnTxt}>✕ Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.btnPrimary, { flex: 1 }, progress.n < 5 && { opacity: 0.4 }]}
              disabled={progress.n < 5}
              onPress={finish}
            >
              <Text style={styles.btnPrimaryTxt}>Finish now</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Pressable style={[styles.btnPrimary, { marginTop: 8 }]} onPress={start}>
          <Text style={styles.btnPrimaryTxt}>{stage === "done" ? `↻ Measure B${target} again` : `▶ Start 1 m measurement for B${target}`}</Text>
        </Pressable>
      )}

      {stage === "done" && result && (
        <View style={[styles.result, { borderColor: result.reliable ? C.ok : C.warn }]}>
          <Text style={styles.label}>B{result.num} at 1 m: {result.mean.toFixed(1)} dBm average</Text>
          <Text style={styles.small}>
            {result.n} packets · median {result.median.toFixed(1)} · spread ±{result.sd.toFixed(1)} dB · range {result.min} to {result.max}
          </Text>

          {/* The check: how far off the current setting is */}
          <Text style={[styles.label, { marginTop: 8 }]}>
            {result.applied ? "✓ Now reads 1.0 m at 1 m" : `Current setting (MP ${result.curMp} dBm) reads ${result.currentReadsM.toFixed(2)} m at 1 m`}
          </Text>
          {!result.applied && (
            <Text style={[styles.small, { color: Math.abs(errPct) <= 10 ? C.ok : C.warn }]}>
              {Math.abs(errPct) <= 10
                ? "✓ Good: within 10%. No change needed."
                : `${errPct > 0 ? "+" : ""}${errPct}% — every B${result.num} distance is off by about this much.`}
            </Text>
          )}

          {!result.reliable && (
            <Text style={[styles.small, { color: C.warn, marginTop: 4 }]}>
              ⚠ {result.n < MIN_PACKETS ? `Only ${result.n} packets` : `Signal varied a lot (±${result.sd.toFixed(1)} dB)`} — measure again, keeping the phone still and the path clear.
            </Text>
          )}

          {!result.applied && (
            <Pressable
              style={[styles.btnPrimary, { marginTop: 8 }, result.mp === result.curMp && { opacity: 0.4 }]}
              disabled={result.mp === result.curMp}
              onPress={apply}
            >
              <Text style={styles.btnPrimaryTxt}>
                {result.mp === result.curMp ? `MP already ${result.mp} dBm` : `✓ Save B${result.num} Measured Power = ${result.mp} dBm`}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12, marginBottom: 12 },
  title: { color: C.text, fontSize: 15, fontWeight: "800", marginBottom: 2 },
  label: { color: C.text, fontSize: 13, fontWeight: "700", marginTop: 6 },
  small: { color: C.sub, fontSize: 11, marginTop: 2 },
  row: { flexDirection: "row", marginTop: 8 },
  pick: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 8, alignItems: "center", marginRight: 8 },
  pickTxt: { fontSize: 13, fontWeight: "800" },
  track: { height: 6, borderRadius: 3, backgroundColor: "#21262d", marginTop: 8, overflow: "hidden" },
  bar: { height: 6, borderRadius: 3, backgroundColor: C.accent },
  btn: { borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingVertical: 9, alignItems: "center" },
  btnTxt: { color: C.text, fontSize: 13, fontWeight: "700" },
  btnPrimary: { backgroundColor: "#238636", borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  btnPrimaryTxt: { color: "#fff", fontSize: 13, fontWeight: "800" },
  result: { borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 10 },
});
