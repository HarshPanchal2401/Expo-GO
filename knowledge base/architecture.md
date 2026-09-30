# Architecture

How the Indoor Nav app is put together: its layers, the files in each layer, how data flows from the sensors to the map, and where data is stored.

> Replaces `01_architecture_file_connections_and_wireframes.md`, which describes an earlier version. The files it lists (`TwoBeaconPositionScreen.js`, `hooks/`, `twoBeaconServices.js` and others) no longer exist.

---

## 1. Tech stack

| Layer | Technology |
|---|---|
| App framework | React Native 0.81, React 19.1, Expo SDK 54 |
| Bluetooth | `react-native-ble-plx` (scan only, no connections) |
| Motion sensors | `expo-sensors`: Accelerometer, DeviceMotion (gyro + gravity + orientation), Magnetometer, Pedometer |
| Graphics | `react-native-svg` (floor-plan map, PDR canvas, RSSI graph) |
| Storage | `@react-native-async-storage/async-storage` |
| Delivery | EAS Build (`development` / `preview` APK / `production`) and EAS Update (over-the-air) |

The runtime version follows the app version (`1.0.0`). An OTA update is downloaded at launch and **applied on the next cold start**, so the Fusion Map shows an engine tag and update ID to confirm which code is running.

---

## 2. Layers

```text
┌──────────────────────────────── UI (components/) ────────────────────────────────┐
│  FusionMapScreen   PdrTrackerScreen   BeaconSignalLabScreen   AppSettingsScreen    │
│        │                  │                   │  RssiSignalGraph      │            │
└────────┼──────────────────┼───────────────────┼───────────────────────┼────────────┘
         │ step callback,   │ props              │ subscribe             │ save
         │ headingRef       │                    │                       │
┌────────▼──────────────────▼───────────┐  ┌────▼───────────────────────▼────────────┐
│  App shell (App.android.js / .ios.js) │  │  v2BeaconScannerService (BLE hub)        │
│  • sensor subscriptions               │  │  • scan, beacon slots, stats, graph      │
│  • step detector state machine        │──▶  • notifyStep() → motion state          │
│  • HeadingFilter, StepLengthModel     │  │  • calibration and anchor storage        │
└────────┬──────────────────────────────┘  └────┬─────────────────────────────────────┘
         │                                      │ ingestReading()
┌────────▼──────────────────────────────────────▼──────────────── Engines (services/) ┐
│ FusionEngine (EKF) ◀── InitialPositionSolver   AdaptiveBeaconEngine (RSSI → metres) │
│      │                                          BeaconRangingCalibration             │
│      └── PdrEngine (odometry, confidence)       HeadingFilter   StepLengthModel      │
└─────────────────────────────────────────────────────────────────────────────────────┘
         │
┌────────▼──────────── Persistence ─────────────┐
│ AsyncStorage (see §6) · PathStorage.js         │
└────────────────────────────────────────────────┘
```

**Rules the code follows:**
- **Engines have no UI.** `services/*` never import from `components/`.
- **Units change at one boundary.** Sensors and BLE work in **metres**; the Fusion Map and `FusionEngine` work in **feet**. The conversion (`metresToFeet` / `feetToMetres` in `PdrEngine.js`) happens exactly once, where values are handed to the fusion engine.
- **Singletons:** `fusionEngine`, `pdrEngine`, `headingFilter`, `stepLengthModel`, `adaptiveEngine` and `v2Scanner` are each one shared instance per module.

---

## 3. Files

### 3.1 Entry and shell
| File | Role |
|---|---|
| `App.js` | Chooses `App.ios.js` or `App.android.js` by `Platform.OS`. The entry is `node_modules/expo/AppEntry.js`, which loads `App.js`. |
| `App.android.js` / `App.ios.js` | The app shell. They own the sensor subscriptions, step detection, heading filter wiring, heading-zero storage, OTA check, and the tab bar (🗺️ Fusion Map · 🚶 PDR · 📡 Signal Lab · ⚙️ Settings; the default tab is PDR). The two files are nearly identical. Android also asks for the ACTIVITY_RECOGNITION permission and pads for the status bar. |
| `index.js` | Legacy, not used as the entry. |

### 3.2 Screens (`components/`)
| File | Role |
|---|---|
| `v2/FusionMapScreen.js` | The main navigation screen. Floor-plan SVG map with zoom and pan, beacon placement, the locate → navigate flow, live fused position, trail, saved routes, metrics and beacon info. |
| `v2/PdrTrackerScreen.js` | Step-only tracking: path canvas, step-length calibration card, loop closure, saved PDR paths, magnetometer diagnostics. |
| `v2/BeaconSignalLabScreen.js` | BLE workbench: scan control, choosing Beacon 1 and 2, live RSSI graph, per-beacon analytics, two-stand ranging calibration, 1 m calibration, multi-distance regression, match pair, packet log. |
| `v2/RssiSignalGraph.js` | SVG chart of raw and filtered RSSI over a 15/20/30 s window. |
| `AppSettingsScreen.js` | Runtime tuning (path loss, step detector thresholds). Changes apply on Save. |
| `ErrorBoundary.js` | Wraps every tab and offers "Reload View". |
| `OtaUpdateCard.js` | Not used. The header button does the OTA check instead. |

### 3.3 Engines and services (`services/`)
| File | Role |
|---|---|
| `FusionEngine.js` | 2-D Extended Kalman Filter in feet. PDR predicts, BLE corrects. Also handles the locating phase, the two-candidate (mirror) ambiguity, room clamping and the trail. |
| `InitialPositionSolver.js` | Intersects the two range circles, uses the floor plan to choose between candidates, estimates uncertainty (GDOP), and runs the `RangeFixAccumulator` for the timed initial fix. |
| `PdrEngine.js` | Odometry (steps, distance walked), PDR confidence and uncertainty, unit helpers. |
| `HeadingFilter.js` | Gyro + compass heading filter with magnetic-disturbance detection and a per-stride mean heading. |
| `StepLengthModel.js` | Weinberg step length with the low-pass gain corrected, plus personal calibration. |
| `v2BeaconScannerService.js` | The BLE hub: scanning, beacon slots, the per-packet pipeline into `AdaptiveBeaconEngine`, stats and graph buffers, calibration APIs, and floor-plan size and anchor storage. |
| `AdaptiveBeaconEngine.js` | RSSI → distance: outlier gate, adaptive constant-velocity Kalman, shadow envelope, path-loss inversion (single or dual slope), plausibility clamps, confidence. |
| `BeaconRangingCalibration.js` | Two-stand calibration solver and a live triangle-inequality check of the two ranges. |
| `BleScannerService.js` | Only four helpers are used: BLE manager, permissions, Bluetooth on/off, iBeacon/Eddystone payload decoding. |
| `appSettingsStorage.js` | Settings cache plus subscribers. |
| `RttRangingService.js` | A simulated round-trip-time ranging experiment. **Nothing imports it.** |
| `PathStorage.js` (root) | Saved paths, with an in-memory fallback. |

`backup/`, `scratch/` and `dist/` are not part of the app. `web-simulator/` is empty.

---

## 4. Runtime data flow

### 4.1 One step
```text
Accelerometer (30 ms) ─▶ step state machine (App.*.js)
                             │ step confirmed (bounce, interval)
                             ▼
             StepLengthModel.estimate() ─▶ length (m)
             headingFilter.takeStepHeading() ─▶ heading (°)
                             │
                 addStep(): PDR-tab position, path, counters
                             ├─▶ v2Scanner.notifyStep()   (BLE engine learns "walking")
                             └─▶ pdrStepCallbackRef.current(...) (only while the Fusion Map is open)
                                        │ metresToFeet
                                        ▼
                              fusionEngine.predict(lenFt, heading)
```

### 4.2 One BLE packet
```text
ble-plx scan (low latency, duplicates allowed)
   └▶ v2Scanner: decode iBeacon, drop non-target devices, pick the slot (B1/B2)
        └▶ adaptiveEngine.ingestReading(id, rssi, tx1m, now)
             outlier gate → Kalman (level+rate) → shadow envelope → path loss → clamps
        └▶ stats.bN updated (distanceM, confidence, txSource, totalPackets, lastSeen …)
        └▶ subscribeStats listeners (throttled to 80 ms)
              └▶ FusionMapScreen
                   ├─ locating:   fusionEngine.feedLocatingSample(d1Ft, d2Ft)
                   └─ navigating: fusionEngine.correct(d1Ft, d2Ft, c1, c2)
```

### 4.3 Heading
```text
DeviceMotion (50 ms): rotationRate + accelerationIncludingGravity ─▶ headingFilter.updateMotion()
DeviceMotion rotation.alpha / Magnetometer (fallback) ─▶ headingFilter.updateAbsolute()
Magnetometer |B| ─▶ headingFilter.updateMagneticField()
headingFilter.heading ─▶ headingRef (live; the UI refreshes at most every 100 ms)
```

### 4.4 Fusion Map session (states)
```text
idle ──Find My Position──▶ locating ──fix committed──▶ navigating ──Stop──▶ idle
                             │   ▲                          ▲
                             │   └── Re-locate ─────────────┤
                             └──fix, heading not zeroed──▶ located ──Zero Heading / Start──┘
```
- **locating** collects ranges while you stand still. It ends early if you start walking, and always ends by an 8 s deadline that a 1 Hz timer checks. Once a fix is committed it always moves straight to **navigating**; the old `located` waiting state is no longer entered.
- **navigating** turns on PDR prediction, BLE correction and the trail.

---

## 5. Interfaces between modules

| Producer → consumer | Interface |
|---|---|
| App shell → FusionMapScreen | `pdrStepCallbackRef` (set by the screen), `headingRef`, `onZeroHeading`, `headingCalibrated` |
| App shell → v2Scanner | `notifyStep()` on every step |
| v2Scanner → screens | `subscribeStats`, `subscribeStatus`, `subscribeDiscovered`, `subscribePackets`; `getGraphHistory()`, `getPacketLog()` |
| FusionMapScreen → FusionEngine | `setRoomSize`, `setBleAnchors`, `beginLocating`, `feedLocatingSample`, `checkLocatingTimeout`, `finishLocatingNow`, `beginNavigation`, `predict`, `correct`, `tick`, `getState` |
| Signal Lab → v2Scanner | `selectBeacon`, `swapBeacons`, `applyGeometricCalibration`, `set1MeterTxPower`, `matchBeaconPair`, `logCalibrationPoint`, `fitPathLossModel` |
| Settings → v2Scanner / step detector | `subscribeAppSettings` (txPower and pathLossN go to the engine defaults; the step thresholds go to the detector) |

---

## 6. Persistence (AsyncStorage keys)

| Key | Contents | Owner |
|---|---|---|
| `@pdr_saved_paths` | Saved paths `{id, name, timestamp, steps, distance, points, source?, units?}` | `PathStorage.js` |
| `@pdr_heading_zero_deg` | Raw sensor heading that means "map up" | App shell |
| `@pdr_step_length_model_v1` | Personal step-length scale and calibration metadata | `StepLengthModel.js` |
| `@app_config_settings_v2` | All app settings | `appSettingsStorage.js` |
| `@v2_beacon_config_v3` | Beacon slots (IDs, names), Tx values, path-loss n, unit, target-only mode, beacon heights | `v2BeaconScannerService.js` |
| `@v2_fusion_place_size_ft` | Floor-plan size `{widthFt, heightFt}` | `v2BeaconScannerService.js` |
| `@v2_fusion_anchors_ft` | Beacon positions on the map `{b1:{x,y}, b2:{x,y}}` in feet | `v2BeaconScannerService.js` |
| `@v2_beacon_calib_<MAC>` | Per-beacon path-loss calibration (points, n, Tx, optional far-segment slope) | `AdaptiveBeaconEngine.js` |

The floor-plan image `assets/floorplans/office-72x72.png` is **gitignored**. It must exist on the machine that runs `eas update`, or the bundle fails.

---

## 7. Build and release

| Step | Command / setting |
|---|---|
| Dev client | `eas build --profile development` (channel `development`) |
| Test APK | `eas build --profile preview` (channel `preview`, APK) |
| Store build | `eas build --profile production` (channel `production`, version auto-incremented) |
| OTA update | `npx eas update --branch preview --message "..."` |
| Local bundle check | `CI=1 npx expo export --platform all --output-dir <tmp>` |

---

## 8. Known architectural debt

- **Two nearly identical app shells.** `App.android.js` and `App.ios.js` copy the sensor and step logic. Moving that into a shared hook or service would stop them drifting apart.
- **Inactive settings.** Many settings do nothing (`deadZone`, the One-Euro values, `medianWindow`, `valleyThreshold`, `maxCadenceMs`, room size, `rtt*`), but the Settings screen still shows most of them.
- **Dead code:** `RttRangingService.js`, `OtaUpdateCard.js`, `index.js`, and most of `BleScannerService.js`.
- **No shared theme** (see `design-system.md`).
