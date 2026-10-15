# PDR_ExpoGo: Project Context

Context for answering questions about this project. It describes the code as of engine tag **`motion-v16-cal1m`** (October 2026).

> The other files in this folder (`architecture.md`, `logic.md`, `design-system.md`, `product-requirement-document.md`) describe the older `range-v1` engine. Where they disagree with this file, this file is correct.

---

## 1. What the app is

An **indoor navigation app** for one office. It shows the user's live position on the office floor plan by combining two sources:

- **BLE beacons:** two Moko BLE beacons. RSSI gives an approximate distance to each.
- **PDR (Pedestrian Dead Reckoning):** the phone's motion sensors count steps, estimate step length and track walking direction.

| Item | Value |
|---|---|
| Floor plan | Office, **72 × 72 ft** (`assets/floorplans/office-72x72.png`, 424×362 px, stretched over the room) |
| Coordinates | Feet, origin bottom-left, **y up**. Heading 0° = map up (+Y), 90° = right (+X), clockwise-positive. A step moves `x += L·sin θ`, `y += L·cos θ`. |
| Beacons | B1 and B2, placed on the map by the user (anchor positions are stored) |
| Environment | Many walls, pillars, glass cabins and furniture. BLE signals are heavily affected by these obstacles (NLOS). |
| Platforms | Android (main test device) and iOS, one codebase |

---

## 2. Tech stack and constraints

- **Expo SDK 54**, React Native 0.81.5, React 19.1, `react-native-ble-plx` (scan only), `expo-sensors` (DeviceMotion, Accelerometer, Magnetometer, Pedometer), `react-native-svg`, AsyncStorage.
- **Delivery:** EAS Build gives the APK. Code changes ship by **OTA update**: `npx eas update --branch preview --message "..."`.
- **OTA updates cannot add native modules.** For example, `expo-file-system` is not in the build, so CSV export uses React Native `Share`.
- An OTA update is **applied on the next cold start** after it downloads. The Fusion Map shows `ENGINE_TAG` so the user can see which code is running. Bump the tag with every behaviour change.
- Units: BLE and step length are in **metres**; FusionEngine and the map are in **feet**. Conversion happens once, at the fusion boundary.

---

## 3. App tabs (bottom bar)

| Tab | File | Purpose |
|---|---|---|
| 🗺️ Fusion Map | `components/v2/FusionMapScreen.js` | The main screen. Floor plan, beacon placement, locating, navigation, trail, obstacle editor, test-walk recorder. |
| 🚶 PDR | `components/v2/PdrTrackerScreen.js` | PDR-only canvas, heading zero, step-length calibration walk |
| 📏 Raw | `components/v2/RawDistanceScreen.js` + `BeaconSetupCard.js` + `Calibrate1mCard.js` | **Choose B1 / B2**; **1 m calibration**: phone 1 m from the beacon, 15 s of raw RSSI (first 1.5 s skipped), 20% trimmed mean → Measured Power for that beacon; shows what the current MP reads at 1 m (the check) and saves the new MP (warns under 20 packets or spread over ±5 dB); (devices in range, Swap, scan only B1 & B2 or all), raw RSSI → formula distance, Measured Power and n per beacon set live, both Kalman filters toggleable. (The Signal Lab tab was removed; its calibrations fed an older engine the map did not use.) |
| ⚙️ Settings | `components/AppSettingsScreen.js` | **Mobility card:** Walking / Wheelchair; in wheelchair mode, rolling detection on/off, sensitivity, rolling speed, push length and a calibration. **PDR card:** Weinberg K, ZUPT, peak threshold, min bounce, min cadence. **Toggles:** Step Engine (NEW / CLASSIC), Map Matching (ON / OFF), Shake Filter (classic engine only). |

The app shells are `App.android.js` and `App.ios.js`, which are nearly identical. They own the sensor subscriptions, `addStep()` and the tab bar, and pass `pdrStepCallbackRef` and `headingRef` to the Fusion Map.

---

## 4. Data flow

```text
BLE packets ─▶ v2BeaconScannerService ─▶ SimpleRanging (RSSI Kalman → formula → distance Kalman)
                                              │ d1, d2 (m) + σ
                                              ▼
DeviceMotion (20 ms) ─▶ HeadingFilter ◀── CarryDetector (inside MotionEngine)
        │                    │ heading
        └──────────▶ MotionEngine ─▶ step {lengthM, headingDeg, carry, carryVersion}
                                              │
                                   App addStep() ─▶ pdrStepCallbackRef
                                              ▼
                               FusionMapScreen ─▶ FusionEngine
                                   • locating: RangeFixAccumulator + circle intersection
                                     (InitialPositionSolver, snapped to the walkable grid)
                                   • navigating: ParticleFilter (map matching), or EKF if disabled
                                   • every output snapped onto WalkableGrid (the green area)
```

---

## 5. BLE ranging: the "simple" chain (`services/SimpleRanging.js`)

The **Raw tab and Fusion Map both use this chain.** The older AdaptiveBeaconEngine no longer drives Fusion Map distances.

1. **Raw RSSI → 1-D Kalman filter on RSSI.** `R = 9 dB²`. `Q` = 1.0 / 0.3 / 0.08 for the Light / Medium / Strong presets. The filter resets after 5 s of silence or when a setting changes.
2. **Formula:** `d = 10^((MP − RSSI) / (10·n))`.
   - **MP** (measured power, the RSSI at 1 m) and **n** (path-loss exponent) are set **per beacon**: `mp1`, `mp2`, `n1`, `n2`.
   - Defaults are MP −59 and n 2.0. The allowed n range is 1–6.
3. **1-D Kalman filter on distance.** `R = (0.2·d)²`. `Q = q·dt`, with q = 0.6 / 0.15 / 0.04 m²/s.
4. **Fusion Map uncertainty:** `σ = d · σdB · ln10 / (10·n)`. σdB is 3 with the RSSI Kalman on and 4.5 without it.
5. **Lag (`lagMs`):** a filter that takes in a fraction k of each packet trails a changing value by `(1 − k)/k` packets. `getBeacon()` reports the sum over the active filters, using the average packet interval. Near a beacon it is about 1–2 s; 10 m away it is 3–4 s, because the distance filter's k shrinks with distance. The Fusion Map adds the age of the last packet.

Settings are stored under `@raw_distance_settings_v1`. A change of n or MP on any screen applies everywhere.

**User's field observations:**
- RSSI at 1 m is about −59 to −60 dBm.
- At 10 m it is about −73 to −74 dBm, which implies n ≈ 1.4–1.5 in line of sight.
- Through walls, distances read too long: one beacon at 12 m showed 30 m.
- The two beacons behave differently, which is why MP and n are set per beacon.

**Older engine, still in the code:**
- `AdaptiveBeaconEngine.js`: attenuation model `RSSI = A − 10n·log10(d) − α(d−1)`, ridge/Huber fit, NLOS gate.
- `RadioMap.js`: Gaussian-process residuals.
- `RangeAutoCalibrator.js`.
- `ObstacleMap.js`: wall-loss model. Wall 5 dB, glass 3, concrete 10, pillar 8, metal 10, total capped at 25 dB.

---

## 6. PDR: step detection, heading and step length (engine v3, "carry-aware")

### 6.1 How the phone is carried (`services/CarryDetector.js`)
Decided from the gravity direction in the phone's frame over 2 s, and from the tilt-rotation rate:

| Mode | Meaning | Rule |
|---|---|---|
| `texting` | In hand, screen roughly up | Steady, and \|g·screen normal\| ≥ 0.45 |
| `vertical` | Phone at the ear, chest pocket | Steady and upright |
| `swinging` | Swinging hand, trouser pocket | Tilt varies (resultant < 0.975), or tilt rotation > 60°/s |

A **transition** (the phone being repositioned) is flagged when the average tilt moves more than 35° from the settled tilt, or the last 0.4 s moves more than 45° — or, if larger, more than the phone's own swing reached (2 s to 0.6 s ago) plus 10°. Without that, a hand swinging hard (±50° and more) passed 45° on every swing: the heading was held ~90% of the time, turns were lost and the dot walked into walls (simulated route: 27–34 ft off, now 2–5 ft). `transitionFromT` records the last calm moment. When the phone settles, `version` increments.

`GravityTracker` takes gravity from OS sensor fusion: `accelerationIncludingGravity ∓ acceleration`, with the sign chosen by voting for the result nearest 1 g. If the linear-acceleration sensor reads zeros, it falls back to a low-pass filter.

### 6.2 Step detection (`services/MotionEngine.js`)
- **Signal:** the **vertical** dynamic acceleration, clipped to ±4 g (a knock would otherwise stay in the filter for seconds), then band-passed (high-pass τ 0.75 s, low-pass 3 Hz).
- **Activity check:** every 250 ms on a 2.5 s window. It looks for an autocorrelation peak at a lag of 0.3–1.25 s. Window samples beyond 5× the median absolute deviation are clipped first, so one jolt does not hide the rhythm.
- **Walking starts** when all of these hold:
  - correlation ≥ 0.5;
  - standard deviation ≥ 0.025 g;
  - vertical share ≥ 0.2;
  - mean rotation < 300°/s;
  - tilt rotation < 130°/s, checked over the whole window and over the last 0.5 s;
  - at least 3 evenly spaced peaks (±35%). A gap of two periods counts as one step that made no peak (in a trouser pocket the far leg's steps are often too weak).
- **Limb-swing exception:** the gyro's main rotation is anti-correlated at a one-step lag (≤ −0.3) and repeats at a two-step lag (≥ 0.3). When this signature is present, the vertical-share and tilt checks are skipped and the rotation limit rises to 700°/s. It also decides whether the step or the stride is the period.
- **Steps:** peaks of the filtered signal above 0.35 × the window's spread (the smaller of its std and its median absolute deviation, so a jolt cannot raise it), spaced at least 0.6 × the period apart, with bounce between 0.45× and 4× the median of recent bounces (above 4× is a knock, not a step).
- **Backfill:** candidate peaks are kept for 8 s. When walking is confirmed, the steps of the confirming window are released, and before them every earlier peak that continues the same rhythm (one or two periods back, as strong as the walking, never before the last counted step). A two-period gap releases its missing step half way. Each released step keeps its own time and stride heading.
- **Walking ends** after 3 failed evaluations, or after 2.5 periods (at least 1.5 s) with no step.
- **Output per step:** `{t, lengthM, headingDeg (mean over the stride), bounceG, cadenceHz (smoothed), carry, carryVersion, backfilled}`.
- **Classic engine:** setting `motionEngine: "classic"` switches to the old accelerometer peak/valley state machine plus `StepGate.js`.

### 6.3 Heading (`services/HeadingFilter.js`)
- **Orientation:** a full quaternion is integrated from the gyro, with its tilt pulled toward gravity (Mahony filter, gain 2/s). The heading is the azimuth of a **phone-fixed axis that is level in the current carry**: the phone's top when held flat, otherwise its most level axis. This avoids the slow "coning" drift a swinging arm causes.
- **Compass:** DeviceMotion `rotation.alpha`, or the magnetometer if that is missing. It is used **only in `texting` mode**, and only to remove slow drift:
  - time constant 3 s with a clean magnetic field, 40 s with a disturbed one;
  - the field counts as disturbed when its strength is more than 12% off its baseline;
  - no correction while turning faster than 40°/s;
  - the heading resyncs if it disagrees by more than 30° for 1.5–6 s.
- **Repositioning:** during a transition, the heading is held at its average from before the phone moved. After the phone settles, the new axis is averaged for 1.2 s and then takes over from the held value.
- **Wrist tilt during a turn:** if the hold ends with the phone back within 20° of its tilt before the hold (and it was not swinging), it was a wrist tilting during a turn, not a move: the hold is released with the turn the gyro measured meanwhile (integrated rate about gravity). Dropping it used to leave the arrow 90–180° off.
- **Map needle:** the Fusion Map's heading needle reads the heading itself 10× a second (`HeadingNeedle`), so it follows a turn made standing still instead of waiting for the next map redraw.
- **Zero:** the heading is relative to a calibrated zero, set with "Zero Heading" and stored in `@pdr_heading_zero_deg`.

### 6.5 Wheelchair mode (`services/WheelchairEngine.js`)
Settings → Mobility = Wheelchair. Both step detectors are switched off; the engine hands over **0.7 m moves** through the same `addStep()` path:
- **Rolling:** RMS of the high-passed (~2.7 Hz) gravity-free acceleration. Starts after 0.8 s at or above the start level (Sensitivity low / medium / high = 0.035 / 0.02 / 0.012 g). Stops after 1 s below 60% of it; the time while it was low is dropped. Moves at `wheelchairSpeedMps` (default 0.8), building up from 0 over the first 1.0 s of each roll (`START_RAMP_S`; calibration counts the same way).
- Not rolling while the phone is handled (tilt rotation > 45°/s); no distance while spinning (turn rate > 70°/s).
- **Push button** (Fusion Map, and in the Settings calibration): one push = `wheelchairPushM` (default 1.0 m), split into parts ≤ 1 m.
- **Calibration:** roll a measured distance → speed from the rolling time; or tap Push per push → push length.
- Map matching widens its distance doubt (`FusionEngine.setMobility`: scale σ 0.2, per-move noise 12%).
- The PDR tab shows the live vibration level; a recorded test walk logs it once a second as `note` rows.
- **Untuned on a real wheelchair.** On carpet the vibration is too small: use the Push button.

### 6.4 Step length (`services/StepLengthModel.js`)
- **In hand (`texting`):** Weinberg, `L = K · bounce^0.25` with K = 0.74, after removing the filter's attenuation. Multiplied by `personalScale` and limited to 0.4–1.2 m.
- **Pocket, swinging or ear:** a cadence model, `L = 0.425·f − 0.09` m with f limited to 1.0–2.6 Hz. It is multiplied by a `cadenceRatio` that is **learned automatically during in-hand walking** (from the 8th step on), then by `personalScale`.
- **Calibration walk** (PDR tab): walk at least 15 steps and 11 m. Then `personalScale = actual / Σ raw`, limited to 0.55–1.8. It is stored in `@pdr_step_length_model_v1`, including `cadenceRatio`. One walk in hand calibrates every carry mode.

---

## 7. Fusion and positioning (`services/FusionEngine.js`)

**Phases on the Fusion Map:** `idle` → `locating` → (`choosing` when two spots remain) → `navigating`. `picking` is the manual start (tap on the map).

- **Locating (initial position):**
  - The user stands still; RangeFixAccumulator collects ranges. Taking a step ends locating early.
  - `InitialPositionSolver` intersects the two distance circles, refining iteratively for obstacle loss.
  - Two beacons give **two mirror candidates**. Candidates more than 4 ft off the walkable grid are rejected, which often settles the mirror choice ("resolved-by-floor-plan").
  - If both remain, the app enters **`choosing`**: a "Where are you?" card with spots **A** and **B**. The user picks one (map tap or buttons) and presses Start Navigation; only that side of the beacon line is kept (`beginNavigation({ keepSide })`). **Walk to decide** keeps both. A tap elsewhere becomes a manual start. BLE corrections pause while choosing. If the user is already walking when locating ends, both are kept without asking.
  - Positions are snapped onto the walkable area.
  - **Settling (screen):** after a beacon fix the first corrections still move the position, often by many feet. The map shows a searching animation (no dot, halo or track) while locating and until the position stays within 3 ft for 3 s (at least 3 s after the fix), the first step, or 15 s. If two spots fit meanwhile, "Where are you?" is asked; the choice keeps the running filter (no restart). A start chosen on the map shows at once.
  - **Track:** a BLE correction while standing never adds track. Before the first step it moves the start point; after walking it moves one "standing here" tip after the last step (`FusionEngine._trailFollow`).
  - **When A/B is asked:** only when both intersection points are really on the walkable area (within 1 ft, `ON_PLAN_FT`), or neither is and they are equally near it. One on it and the other only within the 4 ft snap tolerance (a desk, a wall) resolves to the one (`resolved-by-floor-plan`). While navigating/settling the particle filter reports two spots only for two separate groups: the two sides' means at least `AMBIGUITY_SEP_SPREAD` (3) × either side's spread apart; one cloud the beacon line merely cuts is one spot, and its estimate is the whole cloud (the stronger half alone hopped across the line).
  - **A/B choice:** a compact bar at the bottom of the map itself (A, B, ▶ Start, "Not sure? Walk to decide"); below the map only Cancel. Tapping A or B on the map still works.
  - **Layout:** all phase cards (locating, choosing, picking, position found, heading prompt, warnings) are below the map, so the map never shifts.
- **Navigating: particle filter** (`services/ParticleFilter.js`, on by default as "Map Matching"):
  - 300 particles. Each has its own step-scale and heading-bias (starting σ 0.08 and 6°).
  - **Per step:** length noise 7%, heading noise 5°. After the phone is repositioned (`headingReset`), the heading bias gets +15° σ once.
  - Particles that cross walls, pillars, no-walk areas, the room edge or non-green grid cells are killed. If fewer than 5% survive, all positions are held instead.
  - **BLE update:** log-domain likelihood.
    - **Lag-compensated:** each range is scored at where the particle was `lagMs` ago — its position minus its own moves since (its own scale and heading bias applied to the logged moves, which carry the step's real time). Scored at the current position, the smoothed ranges pulled the dot back while walking and taught the particles a too-short step scale; in simulation this halved the average error (11.0 → 6.4 ft).
    - Applied at most every 500 ms.
    - Tempered: weight 0.6 while walking, 0.25 while still.
    - NLOS asymmetry: the "too long" side is allowed 1.8× more spread.
    - Outlier floor 0.05.
    - A wall range factor `10^(L/(10n))` is applied.
  - Systematic resampling with 0.25 ft roughening. The estimate is taken from the majority side of the beacon baseline, and ambiguity is reported.
- **EKF (fallback when Map Matching is off):** PDR predicts. BLE corrects along the B1–B2 baseline, `t = (L² + d1² − d2²) / (2L)`.
- **Snapping:** every reported position is moved onto the walkable area: EKF output, particle-filter estimate, start fix and manual taps.

### Walkable area (`services/WalkableGrid.js` + `services/floorplanWalkable.js`)
- Built from the **green pixels** of the floor-plan image by `scripts/build_walkable_grid.py`.
- A pixel counts as green when G ≥ 180, G − R ≥ 15 and G − B ≥ 15. A cell is green when at least half its pixels are.
- **Gray is cabins and furniture, so it is not walkable.**
- The grid is 144×144 cells (0.5 ft each), stored as base64 bits. 7,259 of 20,736 cells (35%) are walkable.
- If the floor-plan image changes, re-run `python scripts/build_walkable_grid.py [preview.png]`.

### Obstacles (`services/ObstacleMap.js`)
- In the Fusion Map editor the user can draw walls, glass, concrete, pillars and metal, plus `nowalk` areas.
- They feed the BLE loss model and the particle filter's movement blocking.

### Test recorder (`services/TestRecorder.js`)
- Fusion Map buttons: "📝 Record Test Walk" and "📤 Share CSV".
- Row kinds: start, step, ble, truth, note. A map tap while recording adds a **truth** mark.
- CSV columns: `t_ms, kind, x_ft, y_ft, len_ft, heading_deg, d1_ft, d2_ft, text`. For step rows, `text` holds the carry mode.

---

## 8. Key files

| File | Role |
|---|---|
| `App.android.js` / `App.ios.js` | Sensors, `addStep()`, tabs, MotionEngine wiring (`platform: "android"` / `"ios"`) |
| `services/MotionEngine.js` | Step detection v3 |
| `services/CarryDetector.js` | Carry mode, transitions, GravityTracker, gyro axis mapping |
| `services/HeadingFilter.js` | Gyro and compass heading, carry-aware |
| `services/StepLengthModel.js` | Weinberg + cadence model, calibration |
| `services/StepGate.js` | Shake gate for the classic engine only |
| `services/WheelchairEngine.js` | Wheelchair rolling detection, Push button, calibration |
| `services/SimpleRanging.js` | RSSI → distance chain with the two Kalman filters |
| `services/v2BeaconScannerService.js` | BLE scan hub, beacon slots, anchors |
| `services/FusionEngine.js` | Locating, EKF, particle-filter integration, snapping |
| `services/ParticleFilter.js` | Map matching |
| `services/InitialPositionSolver.js` | Circle intersection, mirror resolution |
| `services/WalkableGrid.js`, `services/floorplanWalkable.js` | Green walkable area |
| `services/ObstacleMap.js` | User-drawn obstacles and loss model |
| `services/TestRecorder.js` | Test walk CSV |
| `services/appSettingsStorage.js` | Settings (`@app_config_settings_v2`): `motionEngine "v2"`, `particleFilter true`, `stepShakeFilter true`, `weinbergK 0.74`, and others |
| `services/AdaptiveBeaconEngine.js`, `RadioMap.js`, `RangeAutoCalibrator.js` | Older adaptive ranging, not used for Fusion Map distances |

---

## 9. Verified results (simulation only, not yet tested on a device)

Results come from a physics-based gait simulator plus the real floor-plan grid:

| Case | Before | After (v3) |
|---|---|---|
| Phone in hand, direction error | 1.5° | 1.6° |
| Trouser pocket, direction error | 137° | 2–3° |
| Swinging hand, steps counted | 13/64 | 64/64 |
| Phone at ear, direction error | 13–20° | 2–3° |
| Wrist shake while standing, false steps | 31 | 0 |
| Sideways shake / standing, false steps | 0 | 0 |
| 98 ft walk with 3 turns on the floor plan, end error | up to 22.8 ft (EKF) | 1.9–3.9 ft in every carry mode |
| Trail points on gray or outside the map | some | 0 |

---

## 10. Known limits and open ideas

**Limits:**
- If the app starts with the phone already in a pocket, the initial direction is unknown. Start navigation with the phone in hand.
- A turn made while the phone is being pocketed is lost; map matching usually recovers it.
- Shaking the phone straight up and down at walking rhythm still looks like walking. BLE can catch this, because the beacons' signals do not change.
- Without a linear-acceleration sensor, swinging-hand counting is about 58–63 of 64 steps.
- With only two beacons, every BLE fix has a mirror ambiguity (asked as "Where are you?" when the floor plan cannot settle it).
- **Too-short distance is the largest remaining error.** Steps (or wheelchair speed) 15–25% too short leave the dot behind; it turns corners early and can follow a parallel aisle that two beacons cannot tell apart (simulation: 8–15 ft average error, against 2–3 ft when calibrated). Too long is much milder, because walls stop a dot that runs ahead. A wider step-scale prior was tested and was worse overall, so the fix is the calibration walk / wheelchair calibration.
- Restarting with the phone in a pocket takes about 3–3.6 s before the dot moves (16 of 19 steps then counted).
- Through walls, distances read long. n differs per beacon and per location.

**Not built yet** (designed or discussed only; the user wants confirmation before code changes):
- **Auto path-loss (n) engine:** n adapts using the PDR-known true distance, and the initial position takes n into account.
- **Grid-search locating:** score every walkable cell instead of intersecting circles.
- **Pocket walking-direction offset learning.**

---

## 11. Working conventions

- **Do not change code without the user's confirmation** when they ask for a design or an explanation.
- Bump `ENGINE_TAG` in `FusionMapScreen.js` with every behaviour change.
- Release steps:
  1. Commit, including untracked new files.
  2. Run `npx eas update --branch preview --message "..."`.
  3. Cold-start the app twice.
  4. Check the tag on the Fusion Map.
- When a fix needs field data, ask the user to record a test walk with truth taps and share the CSV.
