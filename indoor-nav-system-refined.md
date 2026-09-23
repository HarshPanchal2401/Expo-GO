# Indoor Navigation System — Refined Design (BLE + PDR Fusion)

*Refined from the original AI/ML positioning engine draft. Core architecture kept; scope re-sequenced for a single-developer build, async timing fixed, and vague sections made concrete.*

---

## 1. What changed and why

| Area | Original | Refined | Reason |
|---|---|---|---|
| BLE/PDR timing | Synchronous loop, both processed every tick | Asynchronous EKF — PDR predicts on every step, BLE corrects on every packet | BLE and PDR fire at very different, irregular rates. Forcing lock-step throttles PDR's main advantage. |
| Particle filter | Runs continuously alongside EKF | Runs only for initial fix / re-localization after dropout | Redundant compute once EKF is tracking well; multimodal ambiguity only matters at cold-start or after signal loss. |
| ML layer | Four ML sub-systems specified upfront | Deferred to Phase 3, optional, only where classical baseline error is proven inadequate | Each ML component needs its own labeled dataset. Not worth it before the classical pipeline is validated. |
| Geometry confidence (GDOP) | Included in early BLE confidence | Deferred until beacon density supports it (3+ well-spread beacons per zone) | Meaningless with 1-2 beacons in range — always reads "poor." |
| Heading | Magnetometer + gyro fusion only | Same, plus corridor-constrained heading correction using the map | Indoor magnetic drift is a hard, low-ROI problem to solve purely in sensors. Map constraint is a cheap, high-impact fix. |
| Floor change | "Require sufficient evidence" (undefined) | Explicit debounce: N consecutive corroborating readings, or motion-signature confirmation | Undefined thresholds mean one stray beacon reading can flip a floor. |
| Confidence weights | Fixed w1..w4, values unspecified | Start equal, tune empirically against ground-truth error correlation | Guessed weights aren't meaningfully better than no weights. |
| Dropout behavior | Uncertainty "should grow" | Explicit: uncertainty radius rendered in UI, grows visibly during BLE dropout | A precise-looking dot that's silently wrong is worse than an honest, growing circle. |

---

## 2. System Architecture (refined)

```
                         SMARTPHONE
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
         BLE MODULE                    PDR MODULE
     (event: packet received)      (event: step detected)
              │                             │
     RSSI preprocessing               IMU preprocessing
     + outlier rejection              (accel/gyro/mag)
              │                             │
     Distance estimation              Step detection
     (calibrated path-loss)           + step confidence
              │                             │
     Distance confidence              Step length estimate
              │                             │
     Weighted multilateration         Heading estimate
     (when 3+ beacons visible)        (+ corridor-constrained
              │                        correction from map)
     BLE position + confidence               │
              │                       PDR position update
              │                       + growing uncertainty
              │                             │
              └───────────┬─────────────────┘
                           ▼
                  ASYNC EXTENDED KALMAN FILTER
              PDR = prediction (every step)
              BLE = correction (every packet,
                weighted by BLE confidence as
                measurement noise R)
                           │
              ┌────────────┴────────────┐
              │  Particle filter used    │
              │  ONLY for: cold start,   │
              │  or re-localization      │
              │  after long BLE dropout  │
              └────────────┬────────────┘
                           ▼
                     MAP MATCHING
              (reject/project positions
               outside walkable area)
                           │
                     FLOOR LOGIC
              (debounced — N consecutive
               corroborating signals)
                           │
                  (X, Y, FLOOR) + CONFIDENCE
                           │
                    NAVIGATION ENGINE
                       (A* routing)
                           │
                      LIVE MAP UI
              (uncertainty radius shown,
               grows during dropout)
```

---

## 3. Core principle (unchanged, kept from original)

Never blindly trust any single sensor. Every measurement carries:

```
Measurement + Quality + Uncertainty + Confidence
```

---

## 4. BLE pipeline (refined)

Pipeline stays as originally specified:

```
Raw RSSI → outlier rejection → median filter → adaptive Kalman filter
→ RSSI stability score → packet-rate analysis → BLE signal confidence
```

**Distance model** (per beacon, calibrated on-site, not assumed):
```
d = 10 ^ ((TxPower − RSSI) / (10 × n))
```
`n` (path-loss exponent) and `TxPower@1m` are fit per beacon from a short calibration walk (readings at 1m/3m/5m/10m), via linear regression on log(distance) vs (TxPower − RSSI).

**BLE distance confidence** — weighted sum, weights start equal and get tuned against real error:
```
C_BLE,distance = w1·C_RSSI + w2·C_packet + w3·C_model + w4·C_temporal
```

**Multilateration** — only run when 3+ beacons are visible; with fewer, fall back to single-beacon proximity zone (don't force a false (x,y) fix from 1-2 beacons).

**Geometry confidence (GDOP)** — add once beacon density supports it (Phase 2+). Not meaningful at low beacon counts.

---

## 5. PDR pipeline (refined)

Unchanged core stages, with two concrete additions:

**Step detection** — peak/valley detection with refractory period; output step + step confidence (based on peak prominence, cadence consistency, walking-state classification).

**Step length** — start with Model A (personal calibration constant) or Model B (Weinberg: `L = K(A_max − A_min)^(1/4)`). Defer ML step-length model to Phase 3.

**Heading** — fused rotation vector (not raw gyro), **plus corridor-constrained correction**: when the map is available, and PDR heading disagrees with the nearest walkable corridor direction by less than a threshold (e.g. 25-30°), snap toward the corridor direction with partial weight. This is the single highest-ROI heading fix and should be implemented before deeper magnetometer engineering.

**Zero-motion detection** — freeze position updates when stationary (low, flat accelerometer variance sustained) to stop drift while standing still.

---

## 6. Fusion engine (refined — this is the main structural change)

**Use an asynchronous Extended Kalman Filter**, not a synchronous loop:

- **Prediction step** fires on every PDR step event (fast, frequent — every 0.5-1s while walking)
- **Correction step** fires on every BLE packet/position fix (irregular — depends on beacon density and advertising interval)
- Each correction's strength is governed by BLE's confidence score feeding directly into the EKF's measurement noise term `R` — high confidence = low R = strong pull toward BLE; low confidence = high R = EKF barely moves off the PDR prediction

**Particle filter** — implement only as a fallback tool:
- Triggered at cold start (no prior position) or after a long BLE dropout (position genuinely ambiguous)
- Generates candidate positions, weights them by BLE distance likelihood, discards particles that violate beacon distances or fall outside walkable area
- Hands off the converged estimate to the EKF once confidence stabilizes — does not run continuously alongside it

**Position-jump prevention** — before accepting any BLE correction, check:
```
implied speed = distance(new_estimate, previous_estimate) / time_elapsed
```
Reject or down-weight the correction if implied speed exceeds a plausible human walking/running bound (~2.5-3 m/s) unless BLE confidence is very high.

---

## 7. Map matching & floor logic (refined)

**Map matching** — unchanged: reject/project fused positions that fall inside walls or outside walkable regions; feed a map-consistency score back into final confidence.

**Floor detection — now explicit debounce logic:**
```
Do NOT change floor on a single indication.
Commit a floor change only when:
  - N consecutive BLE readings (e.g. 3+) indicate a different floor, OR
  - Sustained barometric change exceeding threshold for X seconds, OR
  - Motion signature confirms vertical transit (elevator/stairs pattern)
Whichever evidence source is available and strongest for your deployment.
```

**Coordinate system** — one unified (x,y) reference per floor plan; floor is a separate discrete state. Simpler for the routing graph than fully independent per-floor coordinate systems.

---

## 8. Final position output (unchanged structure, kept)

```json
{
  "position": { "x": 14.25, "y": 8.91 },
  "floor": 2,
  "ble_confidence": 0.79,
  "pdr_confidence": 0.81,
  "fusion_weight_ble": 0.62,
  "fusion_weight_pdr": 0.38,
  "final_confidence": 0.91,
  "uncertainty_radius_m": 0.8
}
```

**UI consequence (new, explicit):** the map marker renders `uncertainty_radius_m` as a visible halo around the position dot. During BLE dropout, this radius grows continuously (fed by PDR's accumulating uncertainty) rather than the dot silently staying pin-sharp while actually drifting.

---

## 9. Navigation & routing (unchanged from original)

Floor plan → graph (nodes = positions/POIs, edges = walkable connections) → A* routing → human-readable turn-by-turn instructions, updated live against the fused position.

---

## 10. Revised phased build roadmap

This replaces the original Section 34 with explicit gating — each stage must be validated against ground truth before moving to the next. Do not build later stages before earlier ones are working.

```
Phase 0 — Validation infrastructure
  Ground-truth test area, known beacon coordinates, known reference points
  (Do this FIRST — you need it to judge every later stage.)

Phase 1 — Classical baseline (MVP)
  1. BLE: RSSI → calibrated distance → per-beacon confidence
  2. PDR: step detection → step length (Weinberg or personal calibration) → confidence
  3. PDR: heading via fused rotation vector (no magnetometer deep-dive yet)
  4. Async EKF: PDR predicts, BLE corrects, confidence → R
  5. Position-jump rejection (speed bound check)
  6. Measure: position MAE/RMSE against ground truth. This is your baseline number.

Phase 2 — Map-aware refinement
  7. Map matching (reject positions outside walkable area)
  8. Corridor-constrained heading correction
  9. Floor debounce logic
  10. Particle filter for cold-start / dropout re-localization only
  11. Re-measure against ground truth — quantify the improvement from Phase 1

Phase 3 — Optional ML layer (only if Phase 2 error is still unacceptable)
  12. Compare classical vs ML per component (step length, RSSI→distance, confidence)
      — only adopt ML where it measurably beats the classical baseline
  13. Add beacon geometry (GDOP) confidence once beacon density supports it

Phase 4 — Navigation UX
  14. Graph + A* routing
  15. Turn-by-turn instruction generation
  16. Live map UI with uncertainty-radius rendering
```

---

## 11. Practical default values (starting point — tune against your ground truth)

| Parameter | Default | Notes |
|---|---|---|
| RSSI outlier threshold | 10 dBm from rolling median | Tighten in quiet environments, loosen in crowded ones |
| RSSI filter window | 5-10 samples | Trade responsiveness vs stability |
| Path-loss exponent `n` | Calibrate per beacon, per environment type | Never assume 2.0 |
| Multilateration minimum | 3 beacons visible | Fewer → proximity zone only, not (x,y) fix |
| Max plausible speed | 2.5-3 m/s | Reject/down-weight BLE corrections implying more |
| Floor-change debounce | 3+ consecutive corroborating readings | Or sustained barometric threshold |
| Corridor heading snap threshold | 25-30° disagreement | Partial-weight snap, not a hard override |
| Confidence sub-weights (w1-w4) | Start equal (0.25 each) | Tune via correlation with ground-truth error |

---

## 12. Software module layout (unchanged from original — this part was already good)

```
/navigation
├── /ble        (scanner, rssi_filter, calibration, distance_engine, multilateration, ble_confidence)
├── /pdr         (sensor_manager, step_detector, step_length, heading, pdr_engine)
├── /fusion      (confidence_engine, async_ekf, particle_filter [fallback only], state_estimator)
├── /map         (floor_plan, walkable_area, map_matching, floor_manager)
├── /navigation  (graph, route_engine, astar, turn_detection, rerouting)
├── /evaluation  (ground_truth, mae, rmse, p50, p95, experiments)
└── /ui          (floor_map, user_marker [with uncertainty halo], route, navigation_instruction)
```
