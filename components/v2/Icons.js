// ============================================================================
// Icons.js — small line icons (react-native-svg), and the colour palette shared
// by the redesigned screens.
// ============================================================================

import React from "react";
import Svg, { Path, Circle, Rect } from "react-native-svg";

export const THEME = {
  bg: "#0a0c11",
  surface: "#13161d",
  surfaceAlt: "#1b1f29",
  border: "#232834",
  accent: "#4d8dff",
  accentSoft: "rgba(77,141,255,0.14)",
  green: "#34d39a",
  orange: "#f5b84b",
  red: "#ff7a7a",
  text: "#f2f4f8",
  textSecondary: "#9aa3b2",
  textMuted: "#667085",
};

// Each icon: a list of [element, props].
const ICONS = {
  map: [["path", "M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"], ["path", "M9 3v15"], ["path", "M15 6v15"]],
  route: [["circle", { cx: 6, cy: 19, r: 3 }], ["circle", { cx: 18, cy: 5, r: 3 }], ["path", "M9 19h8.5a3.5 3.5 0 000-7h-11a3.5 3.5 0 010-7H15"]],
  radio: [["circle", { cx: 12, cy: 12, r: 2 }], ["path", "M16.24 7.76a6 6 0 010 8.49"], ["path", "M7.76 16.24a6 6 0 010-8.49"], ["path", "M19.07 4.93a10 10 0 010 14.14"], ["path", "M4.93 19.07a10 10 0 010-14.14"]],
  sliders: [["path", "M21 4h-7"], ["path", "M10 4H3"], ["path", "M21 12h-9"], ["path", "M8 12H3"], ["path", "M21 20h-5"], ["path", "M12 20H3"], ["path", "M14 2v4"], ["path", "M8 10v4"], ["path", "M16 18v4"]],
  search: [["circle", { cx: 11, cy: 11, r: 8 }], ["path", "M21 21l-4.3-4.3"]],
  chevronDown: [["path", "M6 9l6 6 6-6"]],
  chevronRight: [["path", "M9 6l6 6-6 6"]],
  locate: [["path", "M3 11l19-9-9 19-2-8-8-2z"]],
  clock: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", "M12 6v6l4 2"]],
  drop: [["path", "M12 22a7 7 0 007-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 007 7z"]],
  coffee: [["path", "M10 2v2"], ["path", "M14 2v2"], ["path", "M6 2v2"], ["path", "M18 8h1a3 3 0 010 6h-1"], ["path", "M3 8h15v7a5 5 0 01-5 5H8a5 5 0 01-5-5z"]],
  users: [["path", "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"], ["circle", { cx: 9, cy: 7, r: 4 }], ["path", "M22 21v-2a4 4 0 00-3-3.87"], ["path", "M16 3.13a4 4 0 010 7.75"]],
  briefcase: [["rect", { x: 2, y: 7, width: 20, height: 14, rx: 2 }], ["path", "M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"]],
  desk: [["rect", { x: 2, y: 3, width: 20, height: 14, rx: 2 }], ["path", "M8 21h8"], ["path", "M12 17v4"]],
  door: [["path", "M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"], ["path", "M10 17l5-5-5-5"], ["path", "M15 12H3"]],
  pin: [["path", "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0116 0z"], ["circle", { cx: 12, cy: 10, r: 3 }]],
  up: [["path", "M12 19V5"], ["path", "M5 12l7-7 7 7"]],
  turnLeft: [["path", "M9 14L4 9l5-5"], ["path", "M20 20v-7a4 4 0 00-4-4H4"]],
  turnRight: [["path", "M15 14l5-5-5-5"], ["path", "M4 20v-7a4 4 0 014-4h12"]],
  uTurn: [["path", "M9 14L4 9l5-5"], ["path", "M4 9h10.5a5.5 5.5 0 010 11H11"]],
  check: [["path", "M20 6L9 17l-5-5"]],
  x: [["path", "M18 6L6 18"], ["path", "M6 6l12 12"]],
  plus: [["path", "M12 5v14"], ["path", "M5 12h14"]],
};

export function Icon({ name, size = 22, color = THEME.text, strokeWidth = 1.9 }) {
  const parts = ICONS[name] || ICONS.pin;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {parts.map(([kind, v], i) =>
        kind === "path" ? <Path key={i} d={v} /> : kind === "circle" ? <Circle key={i} {...v} /> : <Rect key={i} {...v} />
      )}
    </Svg>
  );
}

/** Icon name and tint for a place category. */
export function categoryStyle(category) {
  switch (category) {
    case "restroom": return { icon: "drop", color: "#5aa9ff", bg: "rgba(90,169,255,0.14)" };
    case "food": return { icon: "coffee", color: "#f5b84b", bg: "rgba(245,184,75,0.14)" };
    case "meeting": return { icon: "users", color: "#a78bfa", bg: "rgba(167,139,250,0.14)" };
    case "entrance": return { icon: "door", color: "#34d39a", bg: "rgba(52,211,154,0.14)" };
    case "desk": return { icon: "desk", color: "#9aa3b2", bg: "rgba(154,163,178,0.14)" };
    case "cabin": return { icon: "briefcase", color: "#7dd3fc", bg: "rgba(125,211,252,0.14)" };
    default: return { icon: "pin", color: "#f0883e", bg: "rgba(240,136,62,0.14)" };
  }
}
