// ============================================================================
// useGuidance.js — state of "Where to?" for the Fusion Map screen
//
// stage: "idle" → (sheet) pick a place → "preview" (route drawn, Start / Cancel)
//        → "guiding" (instruction banner) → "arrived".
//        "adding" is picking a new place by tapping the map.
// Reads the dot's position only (the Router and NavigationSession never move it).
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findRoute } from "../../services/Router.js";
import { NavigationSession } from "../../services/NavigationSession.js";
import { loadPlaces, savePlace, removePlace, searchPlaces, snapToGreen } from "../../services/Places.js";
import { splitRoute, fitView } from "../../services/RouteGeometry.js";
import { testRecorder } from "../../services/TestRecorder.js";
import { getAppSettings } from "../../services/appSettingsStorage.js";

const WALK_MPS = 1.0;

function speedMps() {
  const st = getAppSettings();
  return st?.mobilityMode === "wheelchair" ? st?.wheelchairSpeedMps || 0.8 : WALK_MPS;
}

export function useGuidance({ enabled, position, headingRef, roomW, roomH }) {
  const [stage, setStage] = useState("idle");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [places, setPlaces] = useState([]);
  const [query, setQuery] = useState("");
  const [dest, setDest] = useState(null);
  const [route, setRoute] = useState(null);
  const [info, setInfo] = useState(null);
  const [pendingPlace, setPendingPlace] = useState(null);
  const [message, setMessage] = useState("");
  const [viewRequest, setViewRequest] = useState(null);

  const sessionRef = useRef(new NavigationSession());
  const viewN = useRef(0);
  const posRef = useRef(position);
  posRef.current = position;

  useEffect(() => { loadPlaces().then((l) => setPlaces([...l])); }, []);

  const requestView = useCallback((pts) => {
    if (!pts || pts.length < 1) return;
    setViewRequest({ n: ++viewN.current, ...fitView(pts, roomW, roomH) });
  }, [roomW, roomH]);

  const plan = useCallback((target) => {
    const from = posRef.current;
    const wheelchair = getAppSettings()?.mobilityMode === "wheelchair";
    return findRoute(from, target, { wheelchair });
  }, []);

  const reset = useCallback(() => {
    setStage("idle");
    setSheetOpen(false);
    setDest(null);
    setRoute(null);
    setInfo(null);
    setPendingPlace(null);
    setMessage("");
    setQuery("");
  }, []);

  // ── Choosing a place ──
  const openSheet = useCallback(() => {
    setMessage("");
    setSheetOpen(true);
  }, []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const choose = useCallback((place) => {
    const r = plan(place);
    setSheetOpen(false);
    if (!r) {
      setMessage(`No walkable route to ${place.name}.`);
      return;
    }
    setDest(place);
    setRoute(r);
    sessionRef.current.start(r, speedMps());
    setInfo(sessionRef.current.update({ ...posRef.current, heading: headingRef?.current }, Date.now()));
    setStage("preview");
    setMessage("");
    requestView([posRef.current, ...r.points]);
    testRecorder.add("route", { x: posRef.current.x, y: posRef.current.y, len: r.totalFt, text: place.name });
  }, [plan, headingRef, requestView]);

  const startGuidance = useCallback(() => {
    if (!route) return;
    setStage("guiding");
    sessionRef.current.start(route, speedMps());
    requestView([posRef.current, ...route.points]);
  }, [route, requestView]);

  const cancel = useCallback(() => reset(), [reset]);

  // ── Adding a place by tapping the map ──
  const startAdding = useCallback(() => {
    setSheetOpen(false);
    setPendingPlace(null);
    setStage("adding");
  }, []);

  const onMapTap = useCallback((x, y) => {
    if (stage !== "adding") return false;
    const p = snapToGreen({ x, y });
    setPendingPlace(p || { x, y });
    return true;
  }, [stage]);

  const saveNewPlace = useCallback(async (name) => {
    if (!pendingPlace) {
      setMessage("Tap the map where the place is.");
      return false;
    }
    const res = await savePlace(name, pendingPlace.x, pendingPlace.y);
    setPlaces([...res.list]);
    if (!res.ok) {
      setMessage(res.reason || "Could not save.");
      return false;
    }
    setPendingPlace(null);
    setMessage("");
    setStage("idle");
    setSheetOpen(true);
    return true;
  }, [pendingPlace]);

  const cancelAdding = useCallback(() => {
    setPendingPlace(null);
    setMessage("");
    setStage("idle");
    setSheetOpen(true);
  }, []);

  const deletePlace = useCallback(async (id) => {
    setPlaces([...(await removePlace(id))]);
  }, []);

  // ── Following the walk (position only) ──
  const px = position?.x, py = position?.y;
  useEffect(() => {
    if (stage !== "guiding" || !enabled || !Number.isFinite(px) || !Number.isFinite(py)) return;
    const s = sessionRef.current;
    const i = s.update({ x: px, y: py, heading: headingRef?.current }, Date.now());
    if (!i) return;
    if (i.state === "arrived") {
      setStage("arrived");
      setInfo(i);
      testRecorder.add("arrive", { x: px, y: py, text: dest?.name || "" });
      return;
    }
    if (i.reroute && dest) {
      const r = plan(dest);
      if (r) {
        s.start(r, speedMps());
        setRoute(r);
        setMessage("Route updated");
        testRecorder.add("reroute", { x: px, y: py, len: r.totalFt, text: dest.name });
        setInfo(s.update({ x: px, y: py, heading: headingRef?.current }, Date.now()));
        return;
      }
      setMessage("Cannot find a way from here");
    } else if (!i.offRoute) {
      setMessage((m) => (m === "Route updated" || m === "Cannot find a way from here" ? m : ""));
    }
    setInfo(i);
  }, [stage, enabled, px, py, dest, plan, headingRef]);

  // The "Route updated" note fades after a few seconds.
  useEffect(() => {
    if (message !== "Route updated") return undefined;
    const t = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(t);
  }, [message]);

  // If navigation stays off (Stop, reset) the plan goes with it; a short flicker of the
  // position (ambiguous for a moment) only pauses it.
  useEffect(() => {
    if (enabled || stage === "idle") return undefined;
    const t = setTimeout(reset, 10000);
    return () => clearTimeout(t);
  }, [enabled, stage, reset]);

  const navRoute = useMemo(() => {
    if (!route || !dest || (stage !== "preview" && stage !== "guiding")) return null;
    const { behind, ahead } = splitRoute(route, stage === "guiding" ? info?.progressFt || 0 : 0);
    return { behind, ahead, dest: { x: route.end.x, y: route.end.y, name: dest.name } };
  }, [route, dest, stage, info?.progressFt]);

  const results = useMemo(
    () => searchPlaces(places, query, Number.isFinite(px) ? { x: px, y: py } : null),
    [places, query, px, py]
  );

  return {
    enabled,
    stage,
    picking: stage === "adding",
    sheetOpen: sheetOpen && enabled && stage !== "adding",
    places: results,
    totalPlaces: places.length,
    query,
    setQuery,
    dest,
    route,
    info,
    message,
    navRoute,
    viewRequest,
    pendingPlace,
    openSheet,
    closeSheet,
    choose,
    startGuidance,
    cancel,
    startAdding,
    onMapTap,
    saveNewPlace,
    cancelAdding,
    deletePlace,
    done: reset,
  };
}
