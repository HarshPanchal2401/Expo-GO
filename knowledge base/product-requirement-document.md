# Product Requirements Document — Indoor Nav

| | |
|---|---|
| **Product** | Indoor Nav (Expo app "PDR Test", `com.harsh553.pdrtest`) |
| **Status** | Working prototype. It tracks on a real office floor plan and is being tuned for accuracy |
| **Platforms** | Android (main), iOS |
| **Last updated** | 2026-09-29 (engine tag `locate-v5`) |

---

## 1. Problem

GPS doesn't work indoors, so a phone can't show where a person is inside an office. Dedicated indoor positioning systems need many beacons, surveys or special hardware. This product aims for a **usable live position from only two cheap BLE beacons and the phone's own sensors**.

## 2. Goal and non-goals

**Goal:** show a person's live position on the office floor plan while they walk, starting within seconds of opening the map, with no tape-measure survey.

**Non-goals, for now:**
- Several floors or buildings, and turn-by-turn routing to a destination.
- Server backend, user accounts, or sharing positions between devices.
- Metre-level accuracy guarantees. Two beacons physically limit what can be achieved.

## 3. Users

| User | Need |
|---|---|
| **Operator / developer** (main user today) | Place beacons, calibrate, test tracking, see why something is wrong |
| **Walker** (future end user) | Open the map, see "you are here", walk, and see the path |

## 4. Scope

### 4.1 Setup
| ID | Requirement | Status |
|---|---|---|
| S-1 | Discover nearby BLE devices; decode iBeacon UUID, major, minor and 1 m measured power | ✅ Done |
| S-2 | Assign two beacons as B1 and B2 (auto, manual, swap, pick the two strongest). The choice is remembered | ✅ Done |
| S-3 | Place both beacons on the floor plan by dragging, with grid snapping. Positions are stored in feet | ✅ Done |
| S-4 | Set the floor-plan size (default 72 × 72 ft) | ✅ Done |
| S-5 | Calibrate ranging with **two stands and no measuring**: 1 m from B1, then 1 m from B2 | ✅ Done |
| S-6 | Show each beacon's calibration status (calibrated / advertised / default) | ✅ Done |
| S-7 | Set the heading zero once ("I'm facing map-up"). It is remembered | ✅ Done |
| S-8 | Personal step-length calibration by walking a known distance | ✅ Done |

### 4.2 Locating
| ID | Requirement | Status |
|---|---|---|
| L-1 | Find the starting position from both beacons while the user stands still | ✅ Done |
| L-2 | **Always finish**: normally about 3 s, and never more than 15 s | ✅ Done (to be confirmed in the field) |
| L-3 | Don't reduce accuracy to go faster: at least 3 s of evidence, drift detection, honest uncertainty | ✅ Done |
| L-4 | Show why locating is waiting (packets per beacon, time since last packet, which build is running) | ✅ Done |
| L-5 | When two positions are possible, show both and ask the user to walk across the beacon line | ✅ Done |
| L-6 | Warn when ranges are geometrically impossible (a calibration fault) | ✅ Done |
| L-7 | Start navigation automatically once the position is found (if the heading is zeroed) | ✅ Done |

### 4.3 Navigation
| ID | Requirement | Status |
|---|---|---|
| N-1 | Move the dot on every step (dead reckoning) and correct drift with BLE (EKF) | ✅ Done |
| N-2 | Stable heading indoors: gyro-driven, rejects magnetic interference, never "sticks" | ✅ Done |
| N-3 | Show an uncertainty halo and a quality label | ✅ Done |
| N-4 | Draw the walked trail; report distance walked (steps) and net displacement | ✅ Done |
| N-5 | Keep the dot on the floor plan (room clamp) | ✅ Done |
| N-6 | Zoom and pan the map smoothly | ✅ Done |

### 4.4 Routes
| ID | Requirement | Status |
|---|---|---|
| R-1 | Save the walked path | ✅ Done |
| R-2 | A saved route stays on the map; each route can be shown or hidden, in its own colour | ✅ Done |
| R-3 | Delete a route | ✅ Done |

### 4.5 Diagnostics and delivery
| ID | Requirement | Status |
|---|---|---|
| D-1 | Signal Lab: live raw and filtered RSSI graph, per-beacon statistics, packet log | ✅ Done |
| D-2 | Runtime tuning in Settings (path loss, step detector thresholds) | ⚠️ Partial: several settings do nothing (see architecture.md §8) |
| D-3 | Over-the-air updates, and a way to see which update is running | ✅ Done |

## 5. Quality targets

| Metric | Target | Current evidence |
|---|---|---|
| Time to first fix (standing, both beacons audible) | median ≤ 4 s, always ≤ 15 s | Simulation: median 3.1 s. Hard limit 15 s. **Field test pending** |
| Initial range error | ≤ 2.5 ft median per range | Simulation: 2.2 ft. Office measurement: 2.1 ft at 3 s |
| Position error while walking | to be defined after a field test | **Not yet measured**: needs a walk along a known route |
| Heading error during a turn or interference | ≤ 20° worst case | Simulation: 18° worst (the old filter was 30°+ for 10 s) |
| Heading stuck | never more than 20° off for more than 2 s | Simulation: 0 s (the old filter was 10 s) |
| UI responsiveness | heading and map refresh at 10 Hz or more with no jank | Heading is throttled to 10 Hz |

> Every figure above comes from simulation or bench measurement. Before calling anything done, confirm it with a walk along a known route.

## 6. Constraints and assumptions

- **Two beacons.** They pin down the position along the beacon line well. The perpendicular axis relies on PDR and the floor plan. Beacons on opposite walls work much better than beacons close together.
- **RSSI physics.** Body blocking, walls and multipath cause several dB of slow fading, which averaging can't remove. The 1 m power and path-loss exponent differ per beacon and per room, so calibration matters most.
- **Advertising rate** sets the locating speed. 100–200 ms intervals are recommended; 1 s intervals make locating slower and less accurate.
- **The phone is held in the hand** during tracking. Step detection and heading assume this.
- **Update delivery:** an OTA update is applied only on the next cold start.
- **The floor-plan image is gitignored.** It must exist locally to publish an update.

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Uncalibrated or wrongly configured beacon Tx | All distances wrong by a constant factor | Use advertised Tx, show calibration status, two-stand calibration |
| A beacon heard only rarely | Slow or failed locating | 10 s freshness window, 15 s deadline, per-beacon diagnostics |
| Magnetic interference | Heading drift, curved paths | Gyro-driven filter with a field-strength check |
| Walking parallel to the beacon line | The mirror position is never resolved | UI tells the user to cross the line; no forced guess |
| Two app-shell files drift apart | Android and iOS behave differently | Planned: move shared logic into one module |

## 8. Open items / next steps

1. **Field test:** walk known routes and record fix time, position error and heading error. This replaces the simulated numbers in §5.
2. **Tune the shadow envelope from real data.** It currently makes a beacon read up to about 13% short while standing still.
3. **Clean up Settings:** hide or connect the inactive settings.
4. **Shared theme and one set of beacon colours** (see design-system.md §7).
5. **Merge the Android and iOS shells** into one shared sensor/step module.
6. **Remove dead code:** `RttRangingService.js`, `OtaUpdateCard.js`, `index.js`, and the unused parts of `BleScannerService.js`.
