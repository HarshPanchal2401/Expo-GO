// ============================================================================
// GuidanceUi.js — the "Where to?" button, instruction banner, cards and place list
//
// GuidanceTop / GuidanceBottom are laid over the map (absolute, taps pass through
// the empty parts); PlacesSheet is the search + list of saved places.
// ============================================================================

import React, { useState } from "react";
import { View, Text, TouchableOpacity, TextInput, Modal, ScrollView, StyleSheet, Alert } from "react-native";

const C = {
  surface: "#161b22",
  border: "#30363d",
  accent: "#58a6ff",
  blue: "#1f6feb",
  green: "#3fb950",
  orange: "#d29922",
  red: "#f85149",
  text: "#e6edf3",
  textSecondary: "#8b949e",
};

const ARROW = { left: "⬅", right: "➡", "u-turn": "↩" };
const fmtFt = (ft) => `${Math.round(ft)} ft`;
function fmtTime(s) {
  if (!Number.isFinite(s)) return "";
  if (s < 45) return "< 1 min";
  return `${Math.round(s / 60)} min`;
}

/** Top of the map: the instruction while guiding, the route summary in the preview. */
export function GuidanceTop({ g }) {
  const { stage, info, dest, message } = g;
  if (stage === "preview" && info && dest) {
    return (
      <View style={styles.top} pointerEvents="box-none">
        <View style={styles.banner}>
          <Text style={styles.bannerSmall}>To {dest.name}</Text>
          <Text style={styles.bannerMain}>{fmtFt(info.remainingFt)} · {fmtTime(info.etaS)}</Text>
        </View>
      </View>
    );
  }
  if ((stage === "guiding" || stage === "arrived") && info) {
    const arrived = stage === "arrived";
    return (
      <View style={styles.top} pointerEvents="box-none">
        <View style={[styles.banner, arrived && { backgroundColor: "#1a4d2e", borderColor: C.green }]}>
          <View style={styles.bannerRow}>
            <Text style={styles.bannerIcon}>{arrived ? "✔" : ARROW[info.turn] || "⬆"}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerMain}>{info.instruction}</Text>
              {!arrived && <Text style={styles.bannerSmall}>to {dest?.name}</Text>}
            </View>
          </View>
          {!!message && <Text style={[styles.bannerNote, info.offRoute && { color: C.orange }]}>{message}</Text>}
          {!message && info.offRoute && !arrived && <Text style={[styles.bannerNote, { color: C.orange }]}>Off the route…</Text>}
        </View>
      </View>
    );
  }
  return null;
}

/** Bottom of the map: Where to?, Start / Cancel, distance left and End, Done, the add-place form. */
export function GuidanceBottom({ g }) {
  const { stage, info, dest, message } = g;
  const [name, setName] = useState("");

  if (!g.enabled && stage === "idle") {
    return (
      <View style={styles.bottom} pointerEvents="none">
        <View style={[styles.whereBtn, styles.whereOff]}>
          <Text style={styles.whereText}>📍 Where to?</Text>
          <Text style={styles.whereHint}>Locate yourself first, then it works</Text>
        </View>
      </View>
    );
  }
  if (stage === "idle") {
    return (
      <View style={styles.bottom} pointerEvents="box-none">
        {!!message && <Text style={styles.note}>{message}</Text>}
        <TouchableOpacity style={styles.whereBtn} onPress={g.openSheet} activeOpacity={0.85}>
          <Text style={styles.whereText}>📍 Where to?</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (stage === "preview") {
    return (
      <View style={styles.bottom} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{dest?.name}</Text>
          <Text style={styles.cardSub}>{info ? `${fmtFt(info.remainingFt)} · about ${fmtTime(info.etaS)}` : ""}</Text>
          <View style={styles.row}>
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={g.cancel}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnPrimary, { flex: 1.6 }]} onPress={g.startGuidance}>
              <Text style={styles.btnText}>Start</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }
  if (stage === "guiding") {
    return (
      <View style={styles.bottom} pointerEvents="box-none">
        <View style={[styles.card, styles.cardRow]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{info ? fmtFt(info.remainingFt) : ""} left</Text>
            <Text style={styles.cardSub}>{info ? `about ${fmtTime(info.etaS)}` : ""}</Text>
          </View>
          <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={g.cancel}>
            <Text style={styles.btnText}>End</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (stage === "arrived") {
    return (
      <View style={styles.bottom} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.cardTitle}>You are at {dest?.name}</Text>
          <TouchableOpacity style={[styles.btn, styles.btnPrimary, { marginTop: 8 }]} onPress={g.done}>
            <Text style={styles.btnText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (stage === "adding") {
    const save = async () => { if (await g.saveNewPlace(name)) setName(""); };
    return (
      <View style={styles.bottom} pointerEvents="box-none">
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Add a place</Text>
          <Text style={styles.cardSub}>{g.pendingPlace ? "Name it, then Save." : "Tap the map where the place is."}</Text>
          <TextInput
            style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Cabin 3"
            placeholderTextColor={C.textSecondary} maxLength={24}
          />
          {!!message && <Text style={[styles.cardSub, { color: C.orange }]}>{message}</Text>}
          <View style={styles.row}>
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => { setName(""); g.cancelAdding(); }}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnPrimary, { flex: 1.6, opacity: g.pendingPlace && name.trim() ? 1 : 0.5 }]} onPress={save}>
              <Text style={styles.btnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }
  return null;
}

/** Search box and the saved places, nearest first. Long-press a place to delete it. */
export function PlacesSheet({ g }) {
  return (
    <Modal visible={!!g.sheetOpen} transparent animationType="slide" onRequestClose={g.closeSheet}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <Text style={styles.cardTitle}>Where to?</Text>
            <TouchableOpacity onPress={g.closeSheet}><Text style={styles.close}>✕</Text></TouchableOpacity>
          </View>
          <TextInput
            style={styles.input} value={g.query} onChangeText={g.setQuery} placeholder="Search a place"
            placeholderTextColor={C.textSecondary} autoCorrect={false}
          />
          <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
            {g.places.map((p) => (
              <TouchableOpacity
                key={p.id} style={styles.place} onPress={() => g.choose(p)}
                onLongPress={() => Alert.alert("Delete place", `Delete "${p.name}"?`, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Delete", style: "destructive", onPress: () => g.deletePlace(p.id) },
                ])}
              >
                <Text style={styles.placeName}>📍 {p.name}</Text>
                {Number.isFinite(p.distFt) && <Text style={styles.placeDist}>{fmtFt(p.distFt)}</Text>}
              </TouchableOpacity>
            ))}
            {g.places.length === 0 && (
              <Text style={styles.empty}>
                {g.totalPlaces === 0 ? "No places yet. Add one by tapping the map." : "No place matches."}
              </Text>
            )}
          </ScrollView>
          {!!g.message && <Text style={[styles.cardSub, { color: C.orange, marginTop: 6 }]}>{g.message}</Text>}
          <TouchableOpacity style={[styles.btn, styles.btnGhost, { marginTop: 10 }]} onPress={g.startAdding}>
            <Text style={styles.btnGhostText}>＋ Add a place on the map</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  top: { position: "absolute", top: 8, left: 8, right: 8 },
  bottom: { position: "absolute", bottom: 8, left: 8, right: 8, alignItems: "stretch" },
  banner: { backgroundColor: C.blue, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14, borderWidth: 1, borderColor: "#388bfd" },
  bannerRow: { flexDirection: "row", alignItems: "center" },
  bannerIcon: { fontSize: 30, color: "#fff", marginRight: 12 },
  bannerMain: { color: "#fff", fontSize: 17, fontWeight: "800" },
  bannerSmall: { color: "#dbe9ff", fontSize: 12, marginTop: 1 },
  bannerNote: { color: "#fff", fontSize: 12, marginTop: 4, fontWeight: "600" },
  note: { alignSelf: "center", backgroundColor: C.surface, color: C.orange, fontSize: 12, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, marginBottom: 6, overflow: "hidden" },
  whereBtn: { alignSelf: "center", backgroundColor: C.blue, borderRadius: 24, paddingVertical: 11, paddingHorizontal: 22, elevation: 4 },
  whereOff: { backgroundColor: "#30363d", alignItems: "center", opacity: 0.9 },
  whereHint: { color: "#c9d1d9", fontSize: 10, marginTop: 1 },
  whereText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  card: { backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 12 },
  cardRow: { flexDirection: "row", alignItems: "center" },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: "800" },
  cardSub: { color: C.textSecondary, fontSize: 12, marginTop: 2 },
  row: { flexDirection: "row", marginTop: 10, gap: 8 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center", justifyContent: "center" },
  btnPrimary: { backgroundColor: C.blue },
  btnDanger: { backgroundColor: C.red, paddingHorizontal: 18, flex: 0 },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: C.border },
  btnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  btnGhostText: { color: C.text, fontSize: 14, fontWeight: "700" },
  input: { backgroundColor: "#0d1117", borderWidth: 1, borderColor: C.border, borderRadius: 8, color: C.text, paddingHorizontal: 10, paddingVertical: 8, marginTop: 8, fontSize: 14 },
  sheetBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { backgroundColor: C.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 24 },
  sheetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  close: { color: C.textSecondary, fontSize: 20, paddingHorizontal: 6 },
  place: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  placeName: { color: C.text, fontSize: 15, fontWeight: "600" },
  placeDist: { color: C.textSecondary, fontSize: 13 },
  empty: { color: C.textSecondary, textAlign: "center", paddingVertical: 20, fontSize: 13 },
});
