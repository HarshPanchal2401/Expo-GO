# Design System

How the Indoor Nav app looks today: colours, type, spacing, components and icons. It also lists the places where screens disagree, so new UI can follow one standard.

> **Scope:** this describes the code as it is, not a target design. There is no shared theme file. Each screen declares its own colours in its `StyleSheet`, and `FusionMapScreen` and `PdrTrackerScreen` also have a `const C` palette. When you add UI, copy the Fusion Map values below. They are the most complete set.

---

## 1. Theme

| Area | Theme | Basis |
|---|---|---|
| App shell (header and tab bar), Fusion Map, PDR, Signal Lab | **Dark** | GitHub-dark (Primer) colours |
| Settings, ErrorBoundary, OtaUpdateCard | **Light** | GitHub-light Primer plus Tailwind slate text |
| `RssiSignalGraph` | Both, via the `darkMode` prop (default `true`) | Signal Lab always passes `true` |

The app does not follow the system light/dark setting (no `useColorScheme`).

---

## 2. Colour tokens

### 2.1 Core palette (Fusion Map `C`, `components/v2/FusionMapScreen.js`)

| Token | Hex | Used for |
|---|---|---|
| `bg` | `#0d1117` | Screen background, inset boxes |
| `surface` | `#161b22` | Cards, header, tab bar |
| `surfaceAlt` | `#1c2128` | Secondary buttons, bar tracks |
| `border` | `#30363d` | Card borders, dividers, room outline |
| `accent` | `#58a6ff` | Primary action, links |
| `accentGreen` | `#3fb950` | Success, good position quality |
| `accentOrange` | `#d29922` | Warnings, approximate quality |
| `accentRed` | `#f85149` | Errors, poor quality |
| `beacon1` | `#58a6ff` | Beacon 1 on the map |
| `beacon2` | `#bc8cff` | Beacon 2 on the map |
| `userDot` / `halo` / `trail` | `#3fb950` | Live position and path |
| `gridMinor` | `#2a3038` | 2 ft grid lines |
| `gridMajor` | `#3d4451` | 10 ft grid lines |
| `textPrimary` | `#e6edf3` | Main text |
| `textSecondary` | `#8b949e` | Labels, secondary text |
| `textMuted` | `#484f58` | Faint captions, grid labels |

**Saved-route colours** (`SAVED_ROUTE_COLORS`), assigned by the route's age: `#f0883e`, `#db61a2`, `#39c5cf`, `#e3b341`, `#a371f7`, `#ff7b72`.

### 2.2 Semantic colours used across screens

| Meaning | Colour | Notes |
|---|---|---|
| Filled "go" / OK button | `#238636` | Save Path, Start, scan idle |
| Active / selected (tabs, badges) | `#1f6feb` | Active tab fill, V2 badge |
| Stop / destructive | `#da3633` (PDR, Signal Lab) · `#5a1e1e` (Fusion) | Differs between screens, see §7 |
| Place Beacons | `#7c4dc4` | Fusion only |
| Pause | `#9e6a03` | PDR |
| Calibration highlight | `#f0883e` | Signal Lab calibration cards |
| Faint hint text | `#6e7681` | Signal Lab |

### 2.3 Status banner colours (Fusion Map)

All banners share one base style: radius 10, 1px border, padding 12 / 10.

| Banner | Background | Border | When shown |
|---|---|---|---|
| Waiting | `rgba(88,166,255,.12)` | `#58a6ff` | Finding your position |
| Warn | `rgba(210,153,34,.13)` | `#d29922` | Calibration fault, heading not set |
| Ready | `rgba(63,185,80,.13)` | `#3fb950` | Position found |
| Ambiguous | `rgba(188,140,255,.13)` | `#bc8cff` | Two candidate positions |

Scan-status banners: OK `#0d2818` / `#238636`, Warn `#2b2111` / orange, Error `#2b1618` / red.

### 2.4 Calibration status colours (Beacon Info chips)

| Source of the 1 m reference | Colour |
|---|---|
| Calibrated | `accentGreen` |
| Beacon's own advertised value | `accentOrange` |
| Default value | `accentRed` |

---

## 3. Typography

- **Font:** the system font throughout. The only exception is monospace (`"monospace"`, or `Menlo` on iOS) for numeric readouts, logs and error text.
- **Scale in use:**

| Role | Size / weight | Notes |
|---|---|---|
| Brand ("Indoor Nav") | 17 / 800 | letterSpacing 0.5 |
| Screen title | 20 / 700 (Fusion) · 20 / 800 (PDR, Signal Lab) | |
| Settings title | 24 / 900 | letterSpacing −0.5 |
| Card title (Fusion) | 13 / 600, UPPERCASE | letterSpacing 0.8, `textSecondary` |
| Body / hints | 12–13 | line height 17–18 |
| Labels | 10–11 / 700 | letterSpacing 0.5–0.8 |
| Metric value (MetricPill) | 14 / 700 | |
| Big metric (PDR) | 20 / 800 | |
| Big metric (Signal Lab) | 24–28 / 900, monospace | |
| Caption / map label | 9–10 | |
| Tab label | 11 / 700 | |

---

## 4. Spacing and shape

- **Screen padding:** 16 (Fusion, PDR) or 14 (Signal Lab, Settings). Bottom padding is 40–60, so content clears the gesture area.
- **Radius scale:** 3 (bars) · 6 (tabs, small chips) · 8 (chips, zoom buttons) · 10 (buttons, banners, pills) · 12 (Fusion cards) · 14 (Signal Lab and Settings cards).
- **Borders:** 1px by default. A highlighted card uses 1.5px, and a left accent bar is 3px.
- **Shadows:** none on dark screens. The light Settings cards have a soft shadow.

**Cards:**

| Screen | Background | Radius | Padding | Gap below | Border |
|---|---|---|---|---|---|
| Fusion Map | `#161b22` | 12 | 16 | 14 | 1px `#30363d` |
| PDR | `#161b22` | 10 | 14 | 12 | 1px `#30363d` |
| Signal Lab | `#161b22` | 14 | 14 | 14 | 1px `#30363d` |
| Settings | `#ffffff` | 14 | 14 | 14 | 1px `#e2e8f0` |

---

## 5. Components

### 5.1 App shell
- **Header:** "Indoor Nav" with a `V2` badge (`#1f6feb`, radius 6) and an OTA "🔄" update button (`#21262d` background, `#30363d` border, `#58a6ff` text at 12 / 600).
- **Tab bar:** 🗺️ Fusion Map · 🚶 PDR · 📡 Signal Lab · ⚙️ Settings. The bar is `#161b22`. The active tab has a `#1f6feb` fill and white text, and inactive tabs have `#8b949e` text. Tabs have radius 6.

### 5.2 Buttons (Fusion Map)
All have radius 10, paddingVertical 14, and white text at 14 / 700.

| Button | Fill | Purpose |
|---|---|---|
| `primaryBtn` | `#58a6ff` | Find My Position, Start Navigation |
| `placeBtn` | `#7c4dc4` | Place Beacons |
| `saveRouteBtn` | `#238636` | Save Path |
| `stopBtn` | `#5a1e1e` | Stop, Cancel |
| `secondaryBtn` | `#1c2128` with a `#30363d` border and `#8b949e` text | Re-locate, Cancel placement |
| `headingFixBtn` | `#d29922`, radius 8, dark text at 13 / 800 | Zero Heading prompt |

### 5.3 Data display
- **MetricPill:** a surface-coloured tile (radius 10, min width 47% so two fit per row) with an uppercase 10pt label and a 14 / 700 value in a colour passed by the caller.
- **Confidence bar:** 6px high, radius 3, `#1c2128` track. The fill is BLE = `beacon1`, PDR = green, fusion weight = `beacon2`.
- **Beacon chip:** a border in the beacon's colour, radius 8, padding 10. It shows name, RSSI and a calibration-status line (see §2.4).
- **Locating banner:** a Waiting banner with a thin progress bar, a line for the running engine/update version, and one diagnostic line per beacon. A problem line turns orange.
- **Saved Paths list:** each row has a round colour swatch (filled = shown on the map, outline = hidden). The row toggles the route; the red ✕ deletes it.

### 5.4 Fusion map canvas (SVG)
| Element | Style |
|---|---|
| Floor plan | PNG, stretched to the room size, opacity 0.92 |
| Grid | Minor every 2 ft (0.4 wide), major every 10 ft (0.9 wide), 8px labels |
| Room outline | `border`, 1.5 wide |
| Beacon marker | Radius 15 at 0.95 opacity, a 2.2× glow at 0.18, white "B1"/"B2". White stroke when draggable |
| Proximity ring | Dashed 6,5 in the beacon colour, opacity 0.55 |
| Uncertainty halo | Radial gradient in the quality colour, 0.30 → 0 opacity |
| User dot | Radius 9, green, an outer ring at 25%, a white core, a white heading needle |
| Alternate position | Dashed muted circle with "?" and a dashed link to the main dot |
| Live trail | `#3fb950`, width 3, opacity 0.85 |
| Saved route | Dashed polyline in its route colour, with a filled start dot and an end ring |
| Zoom buttons | 36×36, radius 8, `rgba(13,17,23,.85)` |

Line widths are divided by the zoom level, so strokes stay the same thickness on screen when you zoom.

### 5.5 Other
- **PDR canvas:** `#0d1117` background with a `#21262d` grid. The path is a gradient from `#58a6ff` to `#3fb950`, and the previous path is grey. The origin is `#bc8cff` and the current position is green.
- **RssiSignalGraph:** 220 high. In dark mode Beacon 1 is `#38bdf8` and Beacon 2 is `#c084fc`. The filtered line is 2.2 wide; the raw line is 1.2 wide, dashed, at 40% alpha. It has a "⏱ Ns Window" badge.
- **ErrorBoundary (light):** a white card, ⚠️ at 40px, a title in `#cf222e` at 18 / 800, a monospace error box, and a "🔄 Reload View" button.
- **OtaUpdateCard (light):** it exists but **no screen imports it**. The header button is used instead.

---

## 6. Icons

The app has no icon library. Emoji are used as icons.

| Where | Emoji |
|---|---|
| Tabs | 🗺️ 🚶 📡 ⚙️ |
| Fusion Map | 🏢 title · 📍 place beacons · 🎯 zero heading · 🧭 heading prompt · 💾 save · ◎ locate · ▶ start · ⏹ stop · ↻ re-locate · ✓ ⚠ ✕ status |
| PDR | 📏 👣 🎯 💾 🔄 (close loop) 🗑 🏁 (origin) 📍 (current) |
| Signal Lab | ▶ ⏹ ⏸ 🗑 📐 🎯 🧭 📍 ⚡ 📈 📋 ⚖️ 🟢/🟡 (stability) ✅ |
| Settings | ⚙️ 💾 🔄 ⚠️ ✅ 🎯 📶 🚶 📐 |

---

## 7. Known inconsistencies (fix before adding more UI)

| Issue | Where | Suggested standard |
|---|---|---|
| Beacon colours differ | Map: B1 `#58a6ff`, B2 `#bc8cff`. Signal Lab/graph: B1 `#38bdf8`, B2 `#c084fc` | Pick one pair app-wide, so a beacon looks the same on every screen |
| `textMuted` means different things | `#484f58` in Fusion, `#8b949e` in PDR | Use `textSecondary` `#8b949e` and `textMuted` `#484f58` everywhere |
| Primary text | `#e6edf3` vs `#f0f6fc` (Signal Lab) | `#e6edf3` |
| Stop red | `#5a1e1e` (Fusion) vs `#da3633` | Use one, `#da3633` |
| Primary blue | `#58a6ff` (Fusion) vs `#1f6feb` elsewhere | `#58a6ff` for text/accents, `#1f6feb` for filled buttons |
| Card radius and padding | 12/16, 10/14, 14/14 | Radius 12, padding 16 |
| Card title style | Three different styles | Fusion style: 13 / 600 uppercase `textSecondary` |
| Light Settings screen inside a dark app | Settings, ErrorBoundary, OtaUpdateCard | Move them to the dark palette |
| Two different V2 badges | Header blue vs Signal Lab purple | One badge style |

**Recommended next step:** create `theme.js` that exports the §2.1 palette, the type scale and the radius scale, and import it into every screen. After that, a colour changes in one place.
