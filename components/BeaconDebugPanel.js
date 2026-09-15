// ============================================================================
// BeaconDebugPanel — Live R&D Diagnostics & Sensor Fusion Telemetry
// ============================================================================

import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  Switch,
} from "react-native";

export default function BeaconDebugPanel({
  debugInfo,        // from useTwoBeaconPositioning
  beacon1Name,
  beacon2Name,
  showOverlays,
  onToggleOverlays,
}) {
  const [groundTruth, setGroundTruth] = useState({ x: null, y: null });
  const [gtXInput,    setGtXInput]    = useState("");
  const [gtYInput,    setGtYInput]    = useState("");
  const [expanded,    setExpanded]    = useState(true);
  const [unit,        setUnit]        = useState("ft"); // "ft" | "m" | "in"

  const {
    b1 = {}, b2 = {},
    bleX = 0, bleY = 0,
    pdrX = 0, pdrY = 0,
    fusedX = 0, fusedY = 0,
    confidence = 0,
    bleAccepted = true,
    bleResidual = 0,
    kalmanGain = 0.5,
    stepCount = 0,
    stepLength = 0.70,
    heading = 0,
    cardinal = "North (N)",
    isStationary = false,
    positioningMode = "kalman",
    b1Available = false, b2Available = false,
    gtErrorFt = null,
    bleErrorFt = null,
    pdrErrorFt = null,
    fusedErrorFt = null,
    benchmarkStats = null,
    trajectoryCount = 0,
  } = debugInfo || {};

  function applyGroundTruth() {
    const x = parseFloat(gtXInput);
    const y = parseFloat(gtYInput);
    if (isFinite(x) && isFinite(y)) {
      setGroundTruth({ x, y });
    }
  }

  const confPct = ((Number(confidence) || 0) * 100).toFixed(0);
  const confColor = confidence > 0.65 ? "#1a7f37" : confidence > 0.35 ? "#d29922" : "#cf222e";

  function formatCoord(feetVal) {
    if (feetVal === null || feetVal === undefined || isNaN(feetVal)) return "—";
    const num = Number(feetVal);
    if (!isFinite(num)) return "—";
    if (unit === "m") return `${(num * 0.3048).toFixed(2)}m`;
    if (unit === "in") return `${(num * 12).toFixed(1)}in`;
    return `${num.toFixed(2)}ft`;
  }

  return (
    <View style={styles.card}>
      {/* Header with Unit Selector */}
      <View style={styles.headerRow}>
        <Pressable onPress={() => setExpanded(e => !e)} style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
          <Text style={styles.title}>🔬 R&D Fusion Diagnostics</Text>
          <Text style={styles.chevron}>{expanded ? "▲" : "▼"}</Text>
        </Pressable>

        {/* Distance Unit Segmented Buttons */}
        <View style={styles.unitSelector}>
          {[
            { id: "ft", label: "ft" },
            { id: "m",  label: "m" },
            { id: "in", label: "in" },
          ].map((u) => (
            <Pressable
              key={u.id}
              onPress={() => setUnit(u.id)}
              style={[styles.unitBtn, unit === u.id && styles.unitBtnActive]}
            >
              <Text style={[styles.unitBtnText, unit === u.id && styles.unitBtnTextActive]}>
                {u.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {expanded && (
        <>
          {/* ════════════════════════════════════════════════════
              SECTION 1 — BLE SUBSYSTEM & BEACONS
          ════════════════════════════════════════════════════ */}
          <Text style={styles.subSectionTitle}>📶 BLE SUBSYSTEM & MEASUREMENTS</Text>

          {/* Beacon 1 */}
          <BeaconRow
            label={`B1 — ${beacon1Name || "Beacon 1"}`}
            available={b1Available}
            rawRssi={b1.rawRssi}
            filteredRssi={b1.filteredRssi}
            distanceFt={b1.distanceFt}
            weight={b1.weight}
            color="#0369a1"
            unit={unit}
          />

          {/* Beacon 2 */}
          <BeaconRow
            label={`B2 — ${beacon2Name || "Beacon 2"}`}
            available={b2Available}
            rawRssi={b2.rawRssi}
            filteredRssi={b2.filteredRssi}
            distanceFt={b2.distanceFt}
            weight={b2.weight}
            color="#6d28d9"
            unit={unit}
          />

          {/* BLE Diagnostics Block */}
          <View style={styles.diagGrid}>
            <DiagItem
              label="BLE Position"
              value={`(${formatCoord(bleX)}, ${formatCoord(bleY)})`}
              color="#0369a1"
            />
            <DiagItem
              label="BLE Innovation Residual"
              value={`${formatCoord(bleResidual)}`}
              color={bleResidual > 6.0 ? "#cf222e" : "#1e293b"}
            />
            <DiagItem
              label="BLE Measurement Status"
              value={bleAccepted ? "ACCEPTED ✓" : "REJECTED (Outlier) ✗"}
              color={bleAccepted ? "#1a7f37" : "#cf222e"}
            />
            <DiagItem
              label="Confidence Score"
              value={`${confPct}%`}
              color={confColor}
            />
          </View>

          {/* Confidence bar */}
          <View style={styles.confRow}>
            <Text style={styles.confLabel}>BLE Confidence</Text>
            <View style={styles.confTrack}>
              <View style={[styles.confFill, { width: `${confPct}%`, backgroundColor: confColor }]} />
            </View>
            <Text style={[styles.confPct, { color: confColor }]}>{confPct}%</Text>
          </View>

          {/* ════════════════════════════════════════════════════
              SECTION 2 — PEDESTRIAN DEAD RECKONING (PDR)
          ════════════════════════════════════════════════════ */}
          <Text style={[styles.subSectionTitle, { marginTop: 10 }]}>🚶 PEDESTRIAN DEAD RECKONING (PDR)</Text>

          <View style={styles.diagGrid}>
            <DiagItem
              label="Detected Steps"
              value={`${stepCount}`}
              color="#15803d"
            />
            <DiagItem
              label="Weinberg Step Length"
              value={(() => {
                const slM = typeof stepLength === "number" && isFinite(stepLength) ? stepLength : 0.70;
                return `${(slM * 3.28084).toFixed(2)} ft (${slM.toFixed(2)}m)`;
              })()}
              color="#047857"
            />
            <DiagItem
              label="Walking Heading"
              value={(() => {
                const hDeg = typeof heading === "number" && isFinite(heading) ? heading : 0;
                return `${hDeg.toFixed(1)}° • ${cardinal || "North (N)"}`;
              })()}
              color="#0369a1"
            />
            <DiagItem
              label="PDR Dead-Reckoned Pos"
              value={`(${formatCoord(pdrX)}, ${formatCoord(pdrY)})`}
              color="#15803d"
            />
          </View>

          {/* ════════════════════════════════════════════════════
              SECTION 3 — SENSOR FUSION ENGINE (KALMAN FILTER)
          ════════════════════════════════════════════════════ */}
          <Text style={[styles.subSectionTitle, { marginTop: 10 }]}>🛰️ SENSOR FUSION & ADAPTIVE KALMAN</Text>

          <View style={styles.posTable}>
            <View style={styles.posRow}>
              <Text style={styles.posLabel}>BLE Absolute Ranging</Text>
              <Text style={styles.posValue}>X: {formatCoord(bleX)}  Y: {formatCoord(bleY)}</Text>
            </View>
            <View style={styles.posRow}>
              <Text style={styles.posLabel}>PDR Dead Reckoning</Text>
              <Text style={styles.posValue}>X: {formatCoord(pdrX)}  Y: {formatCoord(pdrY)}</Text>
            </View>
            <View style={[styles.posRow, { borderBottomWidth: 0, backgroundColor: "#eff6ff" }]}>
              <Text style={[styles.posLabel, { fontWeight: "800", color: "#1d4ed8" }]}>Kalman Fused Position</Text>
              <Text style={[styles.posValue, { fontWeight: "800", color: "#1d4ed8" }]}>
                X: {formatCoord(fusedX)}  Y: {formatCoord(fusedY)}
              </Text>
            </View>
          </View>

          <View style={styles.diagGrid}>
            <DiagItem
              label="Active Positioning Mode"
              value={positioningMode.toUpperCase()}
              color="#1d4ed8"
            />
            <DiagItem
              label="Kalman Weight (Gain K)"
              value={typeof kalmanGain === "number" && isFinite(kalmanGain) ? kalmanGain.toFixed(2) : "0.50"}
              color="#0369a1"
            />
            <DiagItem
              label="Kinematic State"
              value={isStationary ? "Stationary Lock 🔒" : "Active Walking 🚶"}
              color={isStationary ? "#64748b" : "#1a7f37"}
            />
            <DiagItem
              label="Recorded Trajectory"
              value={`${trajectoryCount} points`}
              color="#6d28d9"
            />
          </View>

          {/* ════════════════════════════════════════════════════
              SECTION 4 — GROUND TRUTH BENCHMARK ANALYSIS
          ════════════════════════════════════════════════════ */}
          <Text style={[styles.subSectionTitle, { marginTop: 10 }]}>🎯 GROUND TRUTH & BENCHMARK ANALYSIS</Text>

          <View style={styles.gtRow}>
            <Text style={styles.gtLabel}>Set Ground Truth Target ({unit})</Text>
            <View style={styles.gtInputs}>
              <TextInput
                style={styles.gtInput}
                placeholder="X"
                value={gtXInput}
                onChangeText={setGtXInput}
                keyboardType="numeric"
                returnKeyType="done"
                onSubmitEditing={applyGroundTruth}
              />
              <TextInput
                style={styles.gtInput}
                placeholder="Y"
                value={gtYInput}
                onChangeText={setGtYInput}
                keyboardType="numeric"
                returnKeyType="done"
                onSubmitEditing={applyGroundTruth}
              />
              <Pressable style={styles.gtBtn} onPress={applyGroundTruth}>
                <Text style={styles.gtBtnText}>Set</Text>
              </Pressable>
            </View>
          </View>

          {(gtErrorFt !== null || fusedErrorFt !== null) && (
            <View style={styles.benchmarkCard}>
              <Text style={styles.benchmarkHeader}>Comparative Real-Time Error</Text>
              <View style={styles.errorComparisonRow}>
                <ErrorBadge
                  label="Fused Error"
                  errorFt={fusedErrorFt ?? gtErrorFt}
                  highlight
                />
                <ErrorBadge
                  label="BLE-Only"
                  errorFt={bleErrorFt}
                />
                <ErrorBadge
                  label="PDR-Only"
                  errorFt={pdrErrorFt}
                />
              </View>

              {/* Running Statistics */}
              {benchmarkStats && benchmarkStats.count > 0 && (
                <View style={styles.statsTable}>
                  <View style={styles.statCell}>
                    <Text style={styles.statCellLabel}>Samples (N)</Text>
                    <Text style={styles.statCellVal}>{benchmarkStats.count}</Text>
                  </View>
                  <View style={styles.statCell}>
                    <Text style={styles.statCellLabel}>MAE</Text>
                    <Text style={styles.statCellVal}>{formatCoord(benchmarkStats.mae)}</Text>
                  </View>
                  <View style={styles.statCell}>
                    <Text style={styles.statCellLabel}>RMSE</Text>
                    <Text style={styles.statCellVal}>{formatCoord(benchmarkStats.rmse)}</Text>
                  </View>
                  <View style={styles.statCell}>
                    <Text style={styles.statCellLabel}>Max Err</Text>
                    <Text style={[styles.statCellVal, { color: "#cf222e" }]}>{formatCoord(benchmarkStats.max)}</Text>
                  </View>
                </View>
              )}
            </View>
          )}

          {/* Debug overlays toggle */}
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Show Raw BLE & PDR markers on map</Text>
            <Switch
              value={showOverlays}
              onValueChange={onToggleOverlays}
              trackColor={{ false: "#d0d7de", true: "#54aeff" }}
              thumbColor="#fff"
            />
          </View>
        </>
      )}
    </View>
  );
}

function BeaconRow({ label, available, rawRssi, filteredRssi, distanceFt, weight, color, unit = "ft" }) {
  const dot = available ? "#1a7f37" : "#cf222e";
  const validDist = typeof distanceFt === "number" && isFinite(distanceFt);

  let distLabel = "—";
  if (validDist) {
    if (unit === "m") distLabel = `${(distanceFt * 0.3048).toFixed(2)}m`;
    else if (unit === "in") distLabel = `${(distanceFt * 12).toFixed(1)}in`;
    else distLabel = `${distanceFt.toFixed(1)}ft`;
  }

  return (
    <View style={styles.beaconRow}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text style={[styles.beaconLabel, { color }]}>{label}</Text>
        {!available && <Text style={styles.noSignal}>No Signal</Text>}
      </View>
      <View style={styles.beaconCells}>
        <MiniCell label="Raw RSSI"   value={rawRssi      != null ? `${rawRssi} dBm`      : "—"} />
        <MiniCell label="Filtered"   value={filteredRssi != null ? `${filteredRssi} dBm` : "—"} />
        <MiniCell label={`Dist (${unit})`} value={distLabel} />
        <MiniCell label="Weight"     value={typeof weight === "number" && isFinite(weight) ? weight.toFixed(2) : "—"} />
      </View>
      {validDist && (
        <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 4, gap: 6 }}>
          <Text style={{ fontSize: 9, color: "#57606a" }}>
            {unit !== "ft" ? `${distanceFt.toFixed(1)}ft  ` : ""}
            {unit !== "m" ? `• ${(distanceFt * 0.3048).toFixed(2)}m  ` : ""}
            {unit !== "in" ? `• ${(distanceFt * 12).toFixed(1)}in` : ""}
          </Text>
        </View>
      )}
    </View>
  );
}

function DiagItem({ label, value, color = "#24292f" }) {
  return (
    <View style={styles.diagItem}>
      <Text style={styles.diagItemLabel}>{label}</Text>
      <Text style={[styles.diagItemVal, { color }]}>{value}</Text>
    </View>
  );
}

function ErrorBadge({ label, errorFt, highlight = false }) {
  const valid = typeof errorFt === "number" && isFinite(errorFt);
  const isGood = valid && errorFt < 2.0;
  const isMed  = valid && errorFt >= 2.0 && errorFt < 4.0;
  const col    = isGood ? "#16a34a" : isMed ? "#d97706" : "#dc2626";

  return (
    <View style={[styles.errorBadge, highlight && styles.errorBadgeHighlight]}>
      <Text style={styles.errorBadgeLabel}>{label}</Text>
      <Text style={[styles.errorBadgeVal, { color: col }]}>
        {valid ? `${errorFt.toFixed(2)} ft` : "—"}
      </Text>
      {valid && (
        <Text style={styles.errorBadgeSub}>({(errorFt * 0.3048).toFixed(2)}m)</Text>
      )}
    </View>
  );
}

function MiniCell({ label, value }) {
  return (
    <View style={styles.miniCell}>
      <Text style={styles.miniLabel}>{label}</Text>
      <Text style={styles.miniValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d0d7de",
    padding: 12,
    marginBottom: 12,
  },
  headerRow:    { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  title:        { fontWeight: "800", fontSize: 13, color: "#24292f" },
  chevron:      { color: "#8c959f", fontSize: 13 },

  subSectionTitle: {
    fontSize: 10.5,
    fontWeight: "800",
    color: "#64748b",
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 4,
  },

  beaconRow:    { backgroundColor: "#f6f8fa", borderRadius: 8, padding: 10, marginBottom: 8 },
  beaconLabel:  { fontWeight: "700", fontSize: 12 },
  dot:          { width: 8, height: 8, borderRadius: 4 },
  noSignal:     { fontSize: 10, color: "#cf222e", fontWeight: "600",
                  backgroundColor: "#ffebe9", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  beaconCells:  { flexDirection: "row", gap: 6 },
  miniCell:     { flex: 1, alignItems: "center" },
  miniLabel:    { fontSize: 9,  color: "#8c959f", fontWeight: "600" },
  miniValue:    { fontSize: 11, color: "#24292f", fontWeight: "700", marginTop: 2 },

  diagGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    backgroundColor: "#f8fafc",
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    marginBottom: 8,
  },
  diagItem: {
    width: "48%",
    paddingVertical: 3,
  },
  diagItemLabel: {
    fontSize: 9,
    color: "#64748b",
    fontWeight: "600",
  },
  diagItemVal: {
    fontSize: 11,
    fontWeight: "800",
    marginTop: 1,
  },

  posTable:     { borderWidth: 1, borderColor: "#e1e4e8", borderRadius: 8, overflow: "hidden", marginBottom: 8 },
  posRow:       { flexDirection: "row", justifyContent: "space-between", alignItems: "center",
                  paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#e1e4e8" },
  posLabel:     { fontSize: 11, color: "#57606a", fontWeight: "600" },
  posValue:     { fontSize: 11, color: "#24292f", fontWeight: "700", fontFamily: "monospace" },

  confRow:      { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  confLabel:    { fontSize: 11, color: "#57606a", fontWeight: "600", width: 95 },
  confTrack:    { flex: 1, height: 8, backgroundColor: "#e1e4e8", borderRadius: 4, overflow: "hidden" },
  confFill:     { height: "100%", borderRadius: 4 },
  confPct:      { fontSize: 11, fontWeight: "800", width: 36, textAlign: "right" },

  gtRow:        { marginBottom: 8 },
  gtLabel:      { fontSize: 11, color: "#57606a", fontWeight: "600", marginBottom: 5 },
  gtInputs:     { flexDirection: "row", gap: 6, alignItems: "center" },
  gtInput:      { borderWidth: 1, borderColor: "#d0d7de", borderRadius: 8,
                  paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, fontWeight: "700",
                  backgroundColor: "#f6f8fa", flex: 1, color: "#24292f" },
  gtBtn:        { backgroundColor: "#1f6feb", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  gtBtnText:    { color: "#fff", fontWeight: "700", fontSize: 12 },

  benchmarkCard: {
    backgroundColor: "#fdf2f8",
    borderWidth: 1,
    borderColor: "#fbcfe8",
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
  },
  benchmarkHeader: {
    fontSize: 10.5,
    fontWeight: "800",
    color: "#9d174d",
    marginBottom: 6,
  },
  errorComparisonRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 6,
  },
  errorBadge: {
    flex: 1,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 6,
    padding: 6,
    alignItems: "center",
  },
  errorBadgeHighlight: {
    borderColor: "#2563eb",
    backgroundColor: "#eff6ff",
  },
  errorBadgeLabel: {
    fontSize: 9,
    color: "#64748b",
    fontWeight: "600",
  },
  errorBadgeVal: {
    fontSize: 12,
    fontWeight: "800",
    marginTop: 2,
  },
  errorBadgeSub: {
    fontSize: 8.5,
    color: "#94a3b8",
  },

  statsTable: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#fbcfe8",
    paddingTop: 6,
    marginTop: 4,
    justifyContent: "space-between",
  },
  statCell: {
    alignItems: "center",
    flex: 1,
  },
  statCellLabel: {
    fontSize: 8.5,
    color: "#9d174d",
    fontWeight: "600",
  },
  statCellVal: {
    fontSize: 11,
    fontWeight: "800",
    color: "#831843",
    marginTop: 1,
  },

  toggleRow:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                  marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: "#e1e4e8" },
  toggleLabel:  { fontSize: 12, color: "#57606a", fontWeight: "600" },

  unitSelector: {
    flexDirection: "row",
    gap: 3,
    backgroundColor: "#f6f8fa",
    padding: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#d0d7de",
  },
  unitBtn: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  unitBtnActive: {
    backgroundColor: "#1f6feb",
  },
  unitBtnText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#57606a",
  },
  unitBtnTextActive: {
    color: "#ffffff",
  },
});
