// ============================================================================
// GuidanceUi.js — "Where to?": search bar, home panel, route cards
//
// Laid out in the page (not over the map), like the redesign:
//   GuidanceTop     above the map: the search bar (idle), the route summary (preview),
//                   the blue next-turn banner (guiding)
//   GuidanceHome    below the map when idle: where you are, quick destinations, recent
//   GuidanceBottom  below the map for preview / guiding / arrived / adding a place
//   PlacesSheet     the full search with every saved place
// ============================================================================

import React, { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, TextInput, Modal, ScrollView, StyleSheet, Alert, useWindowDimensions } from "react-native";
import { Icon, THEME as C, categoryStyle } from "./Icons.js";

const fmtFt = (ft) => `${Math.round(ft)} ft`;
const FT_PER_M = 3.28084;
/** "1 min" style, from feet at about 1 m/s. */
function fmtWalk(ft) {
  const s = ft / FT_PER_M;
  return s < 45 ? "< 1 min" : `${Math.round(s / 60)} min`;
}
function fmtTime(s) {
  if (!Number.isFinite(s)) return "";
  return s < 45 ? "< 1 min" : `${Math.round(s / 60)} min`;
}
function arriveAt(etaS) {
  if (!Number.isFinite(etaS)) return "";
  try {
    return new Date(Date.now() + etaS * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}
/** Which part of the office a place is in, for the list ("Right side"). */
function sideOf(p, room) {
  if (!room || !(room.w > 0) || !(room.h > 0)) return "";
  const dx = (p.x - room.w / 2) / room.w, dy = (p.y - room.h / 2) / room.h;
  if (Math.abs(dx) < 0.18 && Math.abs(dy) < 0.18) return "Centre";
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "Right side" : "Left side") : dy > 0 ? "Top side" : "Bottom side";
}
const TURN_ICON = { left: "turnLeft", right: "turnRight", "u-turn": "uTurn" };

function PlaceIcon({ category, size = 40 }) {
  const st = categoryStyle(category);
  return (
    <View style={[styles.placeIcon, { width: size, height: size, borderRadius: size / 2, backgroundColor: st.bg }]}>
      <Icon name={st.icon} size={Math.round(size * 0.5)} color={st.color} />
    </View>
  );
}

/** Above the map: search bar (idle), route summary (preview), next-turn banner (guiding). */
export function GuidanceTop({ g, meta = "", floor = "Ground" }) {
  const { stage, info, dest, message } = g;

  if (stage === "idle") {
    const ready = g.enabled;
    return (
      <View style={styles.topWrap}>
        <TouchableOpacity
          style={styles.searchBar}
          activeOpacity={0.85}
          onPress={g.openSheet}
        >
          <Icon name="search" size={20} color={C.textSecondary} />
          <Text style={styles.searchText} numberOfLines={1}>Where to?</Text>
          <View style={styles.floorChip}>
            <Text style={styles.floorChipText}>{floor}</Text>
          </View>
        </TouchableOpacity>
        {!!message && <Text style={styles.note}>{message}</Text>}
      </View>
    );
  }

  if (stage === "preview" && info && dest) {
    return (
      <View style={styles.topWrap}>
        <View style={styles.previewBar}>
          <PlaceIcon category={dest.category} size={40} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.previewTitle} numberOfLines={1}>To {dest.name}</Text>
            <Text style={styles.previewSub}>{fmtFt(info.remainingFt)} · {fmtTime(info.etaS)}</Text>
          </View>
        </View>
      </View>
    );
  }

  if ((stage === "guiding" || stage === "arrived") && info) {
    const arrived = stage === "arrived";
    const near = !arrived && info.turn && info.turnInFt <= 4;
    const big = arrived ? "You have arrived" : near || !Number.isFinite(info.turnInFt) ? info.instruction : fmtFt(info.turnInFt);
    const sub = arrived ? dest?.name || "" : near ? "" : info.turn ? `then turn ${info.turn === "u-turn" ? "around" : info.turn}` : `to ${dest?.name || "your destination"}`;
    const iconName = arrived ? "check" : TURN_ICON[info.turn] || "up";
    const warn = !arrived && (info.offRoute || message);
    return (
      <View style={styles.topWrap}>
        <View style={[styles.banner, arrived && { backgroundColor: "#1f9d6b" }]}>
          <View style={styles.bannerMain}>
            <View style={styles.bannerIcon}>
              <Icon name={iconName} size={30} color="#fff" strokeWidth={2.2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerBig} numberOfLines={2}>{big}</Text>
              {!!sub && <Text style={styles.bannerSub} numberOfLines={1}>{sub}</Text>}
            </View>
          </View>
          {!arrived && (
            <View style={styles.bannerNext}>
              <Text style={styles.bannerNextText} numberOfLines={1}>
                {message || (info.offRoute ? "Off the route…" : `${dest?.name || "Destination"} · ${fmtFt(info.remainingFt)} to go`)}
              </Text>
            </View>
          )}
        </View>
        {!arrived && (
          <View style={styles.metaRow}>
            <View style={[styles.metaDot, { backgroundColor: warn ? C.orange : C.green }]} />
            <Text style={styles.metaStrong}>{warn ? "Off route" : "On route"}</Text>
            {!!meta && <Text style={styles.metaText}> · {meta}</Text>}
          </View>
        )}
      </View>
    );
  }
  return null;
}

/** Below the map when idle: where you are, quick destinations, recent places. */
export function GuidanceHome({ g, room, accuracyM, live, beaconCount, hint }) {
  if (g.stage !== "idle") return null;
  const ready = g.enabled;
  const near = g.nearestPlace;
  const title = ready && near ? `Near ${near.name}` : ready ? "Located" : "Not located yet";
  return (
    <View>
      <View style={styles.statusRow}>
        <View style={{ flex: 1 }}>
          <View style={styles.statusTitleRow}>
            <Text style={styles.statusTitle} numberOfLines={1}>{title}</Text>
            {ready && Number.isFinite(accuracyM) && (
              <View style={styles.accChip}><Text style={styles.accChipText}>± {accuracyM.toFixed(1)} m</Text></View>
            )}
          </View>
          <View style={styles.liveRow}>
            <View style={[styles.metaDot, { backgroundColor: live ? C.green : C.textMuted }]} />
            <Text style={styles.metaText}>
              {live ? "Live" : "Scan off"} · {beaconCount} beacon{beaconCount === 1 ? "" : "s"}{room ? ` · ${room.w} × ${room.h} ft` : ""}
            </Text>
          </View>
          {!!hint && !ready && <Text style={styles.hint}>{hint}</Text>}
        </View>
      </View>

      {g.totalPlaces === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyCardTitle}>No places saved yet</Text>
          <Text style={styles.emptyCardText}>Tap the map where a room is, name it, and it shows up here to navigate to.</Text>
          <TouchableOpacity style={[styles.btn, styles.btnPrimary, { marginTop: 12, marginRight: 0, flexDirection: "row" }]} onPress={g.startAdding} activeOpacity={0.85}>
            <Icon name="plus" size={18} color="#fff" />
            <Text style={[styles.btnText, { marginLeft: 8 }]}>Add a place</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.sectionHead}>
          <Text style={[styles.sectionTitle, { marginTop: 0, marginBottom: 0 }]}>Quick destinations</Text>
          <TouchableOpacity style={styles.addLink} onPress={g.startAdding} activeOpacity={0.8}>
            <Icon name="plus" size={14} color={C.accent} />
            <Text style={styles.addLinkText}>Add place</Text>
          </TouchableOpacity>
        </View>
      )}
      {ready && g.quick.length > 0 && (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: 8 }} keyboardShouldPersistTaps="handled">
            {g.quick.map((p) => (
              <TouchableOpacity key={p.id} style={styles.quick} activeOpacity={0.85} onPress={() => g.choose(p)}>
                <PlaceIcon category={p.category} size={34} />
                <Text style={styles.quickName} numberOfLines={1}>{p.name}</Text>
                {Number.isFinite(p.distFt) && <Text style={styles.quickDist}>{fmtFt(p.distFt)}</Text>}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </>
      )}

      {ready && g.recent.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Recent</Text>
          <View style={styles.recentBox}>
            {g.recent.map((p, i) => (
              <TouchableOpacity key={p.id} style={[styles.recentRow, i > 0 && styles.recentSep]} activeOpacity={0.7} onPress={() => g.choose(p)}>
                <View style={styles.recentIcon}><Icon name="clock" size={20} color={C.textSecondary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.recentName} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.recentSub}>{[sideOf(p, room), Number.isFinite(p.distFt) ? fmtFt(p.distFt) : ""].filter(Boolean).join(" · ")}</Text>
                </View>
                <Icon name="chevronRight" size={20} color={C.textMuted} />
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

/** Below the map: Start / Cancel, time left and End, Done, the add-place form. */
export function GuidanceBottom({ g }) {
  const { stage, info, dest, message } = g;
  const [name, setName] = useState("");

  if (stage === "preview") {
    return (
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
    );
  }
  if (stage === "guiding") {
    return (
      <View style={[styles.card, styles.cardRow]}>
        <View style={{ flex: 1 }}>
          <View style={styles.etaRow}>
            <Text style={styles.etaBig}>{info ? fmtTime(info.etaS) : ""}</Text>
            <Text style={styles.etaFt}>{info ? fmtFt(info.remainingFt) : ""}</Text>
          </View>
          <Text style={styles.cardSub} numberOfLines={1}>{dest?.name}{info ? ` · Arrive ${arriveAt(info.etaS)}` : ""}</Text>
        </View>
        <TouchableOpacity style={styles.endBtn} onPress={g.cancel} activeOpacity={0.85}>
          <Text style={styles.endBtnText}>End</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (stage === "arrived") {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>You are at {dest?.name}</Text>
        <TouchableOpacity style={[styles.btn, styles.btnPrimary, { marginTop: 10, marginRight: 0 }]} onPress={g.done}>
          <Text style={styles.btnText}>Done</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (stage === "adding") {
    const save = async () => { if (await g.saveNewPlace(name)) setName(""); };
    const canSave = !!g.pendingPlace && !!name.trim();
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Add a place</Text>
        <Text style={styles.cardSub}>{g.pendingPlace ? "Name it, then Save." : "Tap the map where the place is."}</Text>
        <TextInput
          style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Cabin 3"
          placeholderTextColor={C.textMuted} maxLength={24}
        />
        {!!message && <Text style={[styles.cardSub, { color: C.orange }]}>{message}</Text>}
        <View style={styles.row}>
          <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => { setName(""); g.cancelAdding(); }}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.btnPrimary, { flex: 1.6, opacity: canSave ? 1 : 0.5 }]} disabled={!canSave} onPress={save}>
            <Text style={styles.btnText}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  return null;
}

/** The search: a box that is ready to type in, and the saved places, nearest first. */
export function PlacesSheet({ g, room }) {
  const inputRef = useRef(null);
  const { height: winH } = useWindowDimensions();
  useEffect(() => {
    if (!g.sheetOpen) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [g.sheetOpen]);

  const confirmDelete = (p) => Alert.alert("Delete place", `Delete "${p.name}"?`, [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: () => g.deletePlace(p.id) },
  ]);
  const searching = g.query.trim().length > 0;

  return (
    <Modal visible={!!g.sheetOpen} transparent animationType="fade" onRequestClose={g.closeSheet}>
      {/* At the top of the screen, so the keyboard never covers the box or the first results */}
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
                    <View style={styles.sheetSearch}>
            <Icon name="search" size={20} color={C.accent} />
            <TextInput
              ref={inputRef}
              style={styles.sheetInput} value={g.query} onChangeText={g.setQuery}
              placeholder="Where to?" placeholderTextColor={C.textMuted}
              autoCorrect={false} returnKeyType="search"
              onSubmitEditing={() => g.places[0] && g.choose(g.places[0])}
            />
            <TouchableOpacity onPress={() => (searching ? g.setQuery("") : g.closeSheet())} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              {searching ? <Icon name="x" size={18} color={C.textSecondary} /> : <Text style={styles.clear}>Close</Text>}
            </TouchableOpacity>
          </View>

          <Text style={styles.sectionLabel}>
            {searching ? `${g.places.length} found` : g.totalPlaces ? "Places · nearest first" : "Places"}
          </Text>
          <ScrollView style={{ maxHeight: Math.max(120, winH * 0.32) }} keyboardShouldPersistTaps="handled">
            {g.places.map((p) => (
              <TouchableOpacity key={p.id} style={styles.place} activeOpacity={0.7} onPress={() => g.choose(p)} onLongPress={() => confirmDelete(p)}>
                <PlaceIcon category={p.category} size={38} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.placeName} numberOfLines={1}>{p.name}</Text>
                  {Number.isFinite(p.distFt) && (
                    <Text style={styles.placeDist}>{[sideOf(p, room), `${fmtFt(p.distFt)} · ${fmtWalk(p.distFt)} walk`].filter(Boolean).join(" · ")}</Text>
                  )}
                </View>
                <TouchableOpacity onPress={() => confirmDelete(p)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Icon name="x" size={16} color={C.textMuted} />
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
            {g.places.length === 0 && (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyTitle}>{g.totalPlaces === 0 ? "No places yet" : "No place matches"}</Text>
                <Text style={styles.empty}>
                  {g.totalPlaces === 0 ? "Add the places people go to (Cabin 3, Pantry, Exit) by tapping them on the map." : "Try another name, or add this place on the map."}
                </Text>
              </View>
            )}
          </ScrollView>
          {!!g.message && <Text style={[styles.cardSub, { color: C.orange, marginTop: 6 }]}>{g.message}</Text>}
          <TouchableOpacity style={styles.addBtn} onPress={g.startAdding} activeOpacity={0.85}>
            <Icon name="plus" size={16} color={C.accent} />
            <Text style={styles.addBtnText}>Add a place on the map</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={g.closeSheet} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  topWrap: { marginBottom: 12 },

  searchBar: {
    flexDirection: "row", alignItems: "center", backgroundColor: C.surface, borderRadius: 28,
    borderWidth: 1, borderColor: C.border, paddingLeft: 16, paddingRight: 8, height: 56,
  },
  searchBarOff: { opacity: 0.7 },
  searchText: { flex: 1, color: C.textSecondary, fontSize: 17, marginLeft: 12 },
  floorChip: { backgroundColor: C.surfaceAlt, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9 },
  floorChipText: { color: C.text, fontSize: 15, fontWeight: "700" },
  note: { alignSelf: "flex-start", marginTop: 8, color: C.orange, fontSize: 12 },

  previewBar: { flexDirection: "row", alignItems: "center", backgroundColor: C.surface, borderRadius: 20, borderWidth: 1, borderColor: C.border, padding: 12 },
  previewTitle: { color: C.text, fontSize: 17, fontWeight: "800" },
  previewSub: { color: C.textSecondary, fontSize: 13, marginTop: 2 },

  banner: { backgroundColor: C.accent, borderRadius: 22, overflow: "hidden" },
  bannerMain: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 16 },
  bannerIcon: { width: 60, height: 60, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginRight: 16 },
  bannerBig: { color: "#fff", fontSize: 28, fontWeight: "800" },
  bannerSub: { color: "#fff", fontSize: 17, marginTop: 1 },
  bannerNext: { backgroundColor: "rgba(0,0,0,0.18)", paddingHorizontal: 16, paddingVertical: 10 },
  bannerNextText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  metaRow: { flexDirection: "row", alignItems: "center", marginTop: 10, paddingHorizontal: 4 },
  metaDot: { width: 9, height: 9, borderRadius: 5, marginRight: 8 },
  metaStrong: { color: C.text, fontSize: 15, fontWeight: "700" },
  metaText: { color: C.textSecondary, fontSize: 14 },

  statusRow: { flexDirection: "row", alignItems: "center", marginTop: 16, marginBottom: 4 },
  statusTitleRow: { flexDirection: "row", alignItems: "center" },
  statusTitle: { color: C.text, fontSize: 28, fontWeight: "800", flexShrink: 1 },
  accChip: { backgroundColor: "rgba(52,211,154,0.14)", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4, marginLeft: 12 },
  accChipText: { color: C.green, fontSize: 14, fontWeight: "700" },
  liveRow: { flexDirection: "row", alignItems: "center", marginTop: 8 },
  hint: { color: C.textSecondary, fontSize: 13, marginTop: 6 },

  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 22, marginBottom: 12 },
  addLink: { flexDirection: "row", alignItems: "center", backgroundColor: C.accentSoft, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  addLinkText: { color: C.accent, fontSize: 14, fontWeight: "700", marginLeft: 6 },
  emptyCard: { backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border, borderStyle: "dashed", padding: 16, marginTop: 20 },
  emptyCardTitle: { color: C.text, fontSize: 17, fontWeight: "800" },
  emptyCardText: { color: C.textSecondary, fontSize: 14, marginTop: 4 },
  sectionTitle: { color: C.text, fontSize: 18, fontWeight: "700", marginTop: 22, marginBottom: 12 },
  quick: { flexDirection: "row", alignItems: "center", backgroundColor: C.surface, borderRadius: 30, borderWidth: 1, borderColor: C.border, paddingVertical: 8, paddingLeft: 8, paddingRight: 16, marginRight: 10 },
  quickName: { color: C.text, fontSize: 16, fontWeight: "700", marginLeft: 10, maxWidth: 130 },
  quickDist: { color: C.textSecondary, fontSize: 15, marginLeft: 8 },

  recentBox: { backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12 },
  recentRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  recentSep: { borderTopWidth: 1, borderTopColor: C.border },
  recentIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: C.surfaceAlt, alignItems: "center", justifyContent: "center", marginRight: 14 },
  recentName: { color: C.text, fontSize: 17, fontWeight: "700" },
  recentSub: { color: C.textSecondary, fontSize: 14, marginTop: 2 },

  placeIcon: { alignItems: "center", justifyContent: "center" },

  card: { backgroundColor: C.surface, borderRadius: 20, borderWidth: 1, borderColor: C.border, padding: 16, marginBottom: 12 },
  cardRow: { flexDirection: "row", alignItems: "center" },
  cardTitle: { color: C.text, fontSize: 18, fontWeight: "800" },
  cardSub: { color: C.textSecondary, fontSize: 14, marginTop: 2 },
  etaRow: { flexDirection: "row", alignItems: "baseline" },
  etaBig: { color: C.green, fontSize: 30, fontWeight: "800" },
  etaFt: { color: C.textSecondary, fontSize: 17, marginLeft: 10 },
  endBtn: { backgroundColor: "rgba(255,122,122,0.16)", borderRadius: 28, paddingHorizontal: 34, paddingVertical: 16, marginLeft: 12 },
  endBtnText: { color: C.red, fontSize: 18, fontWeight: "800" },
  row: { flexDirection: "row", marginTop: 12 },
  btn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: "center", justifyContent: "center", marginRight: 10 },
  btnPrimary: { backgroundColor: C.accent, marginRight: 0 },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: C.border },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  btnGhostText: { color: C.text, fontSize: 16, fontWeight: "700" },
  input: { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 12, color: C.text, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10, fontSize: 15 },

  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: { backgroundColor: C.surface, borderBottomLeftRadius: 24, borderBottomRightRadius: 24, padding: 16, paddingTop: 44 },
  grabber: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, marginBottom: 14 },
  sheetSearch: {
    flexDirection: "row", alignItems: "center", backgroundColor: C.bg, borderRadius: 28,
    borderWidth: 1, borderColor: C.accent, paddingHorizontal: 16, height: 54,
  },
  sheetInput: { flex: 1, color: C.text, fontSize: 17, paddingVertical: 0, marginLeft: 12 },
  clear: { color: C.textSecondary, fontSize: 14, fontWeight: "700", paddingLeft: 8 },
  sectionLabel: { color: C.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase", marginTop: 16, marginBottom: 4 },
  place: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border },
  placeName: { color: C.text, fontSize: 16, fontWeight: "700" },
  placeDist: { color: C.textSecondary, fontSize: 13, marginTop: 2 },
  emptyBox: { alignItems: "center", paddingVertical: 22, paddingHorizontal: 12 },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: "700" },
  empty: { color: C.textSecondary, textAlign: "center", fontSize: 13, marginTop: 4 },
  addBtn: { flexDirection: "row", justifyContent: "center", alignItems: "center", marginTop: 12, borderRadius: 14, borderWidth: 1, borderColor: C.border, borderStyle: "dashed", paddingVertical: 14 },
  addBtnText: { color: C.accent, fontSize: 15, fontWeight: "700", marginLeft: 8 },
});
