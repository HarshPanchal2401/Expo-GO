# Logic & Algorithms

The maths and decision rules behind positioning, and the constants each one uses as of engine tag `range-v1`. Values are quoted from the source. If you change one, update it here too.

> Replaces `02_core_logic_algorithms_and_math.md`, which describes an earlier engine.

**Units:** BLE and step length are computed in **metres**. The Fusion Map and `FusionEngine` use **feet** (1 m = 3.2808 ft). They are converted once, at the fusion boundary.

**Heading convention:** degrees, clockwise-positive, measured from the calibrated zero. 0° = map up (+Y), 90° = right (+X). A step moves `x += L·sin θ`, `y += L·cos θ`.

---

## 1. Step detection (`App.android.js` / `App.ios.js`)

Accelerometer sampled every **30 ms**.

1. `|a|` in g (converted from m/s² if above 4).
2. Low-pass filter: `f += 0.61·(|a| − f)`, a cutoff of about 5 Hz.
3. Gravity is tracked slowly (`g = 0.98·g + 0.02·f`), and `dyn = f − g`.
4. Variance over 16 samples (about 480 ms) acts as a stationary gate (ZUPT).
5. State machine:

| State | Enter / leave |
|---|---|
| IDLE → ARMED_PEAK | variance ≥ `zuptVariance` (0.0008) **and** `dyn > peakThreshold` (0.04 g) |
| ARMED_PEAK | Tracks the peak. Moves to ARMED_VALLEY when `dyn < 0.02` and more than 30 ms after the peak. Resets after 500 ms. |
| ARMED_VALLEY | Tracks the valley. A rebound confirms the step. Resets after 600 ms. |
| Step accepted | `bounce = peak − valley ≥ bounceDiffMin` (0.06 g), the time since the last step is at least `minCadenceMs` (240 ms), and the peak-to-valley time is 30–700 ms |

**Pedometer fallback:** if the OS pedometer counts a step that the detector missed (none in the last 250 ms), `addStep(0.70 m)` is used.

## 2. Step length (`StepLengthModel.js`)

Weinberg model with the low-pass loss removed:

```
cadence   = 1000 / stepIntervalMs            (Hz)
bounce'   = bounce / LPFgain(cadence)        (undo the 5 Hz filter's attenuation)
rawLength = K · bounce'^0.25                 (K = 0.74)
length    = clamp(rawLength · personalScale · K_cal/K_now, 0.40 m, 1.20 m)
```

**Personal calibration:** walk a known distance (at least 15 steps and 11 m). Then `personalScale = actual / Σ rawLength`, limited to 0.55–1.8. It is stored in `@pdr_step_length_model_v1`, and it stays valid if K is changed later.

## 3. Heading (`HeadingFilter.js`)

A complementary filter. The **gyroscope turns the heading**; the **compass only removes slow drift**.

**Gyro yaw rate, which works at any phone tilt:**
```
down  = low-pass(accelerationIncludingGravity), normalised       (factor 0.08 per sample)
ω     = rotationRate mapped to device axes
        Android: (α, β, γ) = (x, y, z)     iOS: (α, β, γ) = (z, y, x)
dθ/dt = ω · down                                                   (clockwise-positive)
θ    += ½(rate_prev + rate_now)·dt        (trapezoid, for gaps up to 1.0 s)
```
Gaps up to 1 s are integrated. Android delivers sensor data through the JS thread, so a busy moment easily delays a sample past 0.25 s. The old filter threw those gaps away, which made the heading "stick".

**Compass correction**, from DeviceMotion `rotation.alpha`, or the magnetometer if that isn't available:
```
err = wrap(θ_abs − θ)
k   = dt / τ,   τ = 3 s        when the field is clean
                τ = 40 s       when the field is disturbed
                soft weight 1/(1+(err/35°)²) when there's no field data
θ  += k · err
```
- **Disturbance test:** `| |B| − baseline | / baseline > 0.12`. The baseline is learned only from clean readings (EMA 0.01).
- **Turning:** no compass correction while `|dθ/dt| > 40°/s`, because orientation sensors lag during turns.
- **Resync:** if `|err| > 30°` for 1.5 s while the field is clean (6 s when unknown), snap to the compass.
- **Per-step heading:** the **circular mean** of θ over the stride, which cancels the phone's left-right sway.

## 4. BLE ranging (`AdaptiveBeaconEngine.js`)

For each packet from Beacon *i*:

1. **Asymmetric outlier gate** against the rolling median of 10 samples. Drops are limited to 7 dB and rises to 12 dB. Obstruction only ever weakens the signal, so a sudden rise is more likely to be true.
2. **Noise estimate:** the variance of successive differences ÷ 2. This removes any real trend, so walking isn't mistaken for noise.
3. **Adaptive Kalman filter** with a constant-velocity model (state = level dBm, rate dBm/s):
   - `R = clamp(noiseVar, 3, 25)`.
   - `q = 12·(1 + min(1, var/10))`, cut to ×0.12 when stationary.
   - The rate is capped at ±14 dB/s and pulled toward 0 (×0.65 per step) when stationary.
   - **Moving** = a step in the last 1.2 s **or a turn** (heading change ≥ 35° within 1.5 s) in the last 1.5 s. It is reported from app start, because the step detector always runs. A sustained one-sided innovation (filter visibly lagging) overrides "still" after 2.5 s.
4. **Shadow envelope:** still computed (peak-hold of the filtered level) for diagnostics, but **no longer applied** (`SHADOW_ENVELOPE_RANGING: false`). Its correction depended on the motion state, so the same spot ranged differently standing and walking.
5. **Body shadow** (`BODY_SHADOW_LOSS_DB = 4`): the Fusion Map sends each beacon's fraction `f = clamp((−cos δ + 0.2)/1.2, 0, 1)`, where δ = heading − bearing to the beacon (0 facing, 1 behind), at 4 Hz. `level += 4 dB · f`. It is ignored after 3 s without an update. 4 dB was the value that beat no correction for a real body loss of 3, 7 and 11 dB.
6. **Standing average:** while still, `rangingRssi` = the exponential average since the user stopped, with τ growing from 0.5 s up to 10 s. It restarts immediately on a step or turn.
7. **Path loss:** `d = 10^((Tx1m − rangingRssi)/(10·n))`. When dual-slope calibrated, a steeper `n_far` applies beyond the 6 m breakpoint.
   - **Where Tx1m comes from:** the calibrated value → the beacon's own advertised measured power (valid only between −100 and −30 dBm) → the Settings default (−59).
   - **Where n comes from:** the calibrated value → the default **2.9**, which suits a furnished office.
8. **Near-field:** within +9 to +16 dB of Tx1m, the distance ramps down to 0 (the receiver is saturated).
9. **Clamps:** never more than the room diagonal. There is **no** m/s rate limit (`DISTANCE_SLEW_CLAMP: false`): range noise is multiplicative, so a linear limit biased every approach by +15–30%. The Kalman rate cap already rules out impossible jumps.
10. **Confidence** = `stability × recency × sufficiency`, where stability = 1 − noiseVar/20 dB². Ordinary indoor noise already puts this around 0–0.2, so **nothing hard-gates on it**. It only weights BLE in the EKF.

### 4.1 Calibration fit (`PathLossCalibrator.fitModel`)
All reference points (spot, two-stand, 1 m, manual) are stored with the calibration level `levelDb` (no body correction, no standing average) and, when known, their body-shadow fraction `shape`. The fit is a **regularised** least squares on `y = levelDb + 4·shape = Tx − 10·n·log10(d)`:
- **Priors:** Tx ~ N(advertised or −59, 8 dB) and n ~ N(2.9, 0.4).
- **Point noise:** 2 dB.
- **What one point gives:** with a single point, Tx is already well fixed. Points spread over the room fit n as well.
- **Limits:** n is limited to 1.6–4.5.

### 4.2 Spot calibration (Fusion Map → "📐 Calibrate Distance Here")
Tap where you stand, then stand still. The first 1.5 s are skipped, then 6 s are averaged (trimmed mean, at least 8 packets per beacon). The true distances come from the map (converted to slant distance when beacon height is set). Each beacon gets one point and is refitted. Taking a step during the measurement cancels it. 3–5 spots spread over the room gave the best simulated results.

### 4.3 Two-stand calibration (`BeaconRangingCalibration.js`)
Stand 1 m from Beacon 1, then 1 m from Beacon 2, **side-on** (the beacon at your shoulder). Facing one beacon puts the other behind you, which made the fitted n too steep (3.16 vs a true 2.6 in simulation). Each stand gives both beacons a reading, one at 1 m and one at the known baseline *B*:
```
n    = (RSSI_near − RSSI_far) / (10·log10(B / 1 m))     clamped to 1.8–4.5
Tx1m = RSSI_near                                        (exact fit when n isn't clamped)
```
- Each stand discards its first **4 s** so the filters settle.
- Each stand needs 12–40 packets per beacon, uses a 20% trimmed mean, and warns if the spread (σ) is above 6 dB.

**Live check** (`checkRangeGeometry`): `|d1 − d2| ≤ B ≤ d1 + d2`, and each range must be at most the room diagonal. A violation proves a calibration fault, not noise.

## 5. Initial position

### 5.1 Circle intersection (`InitialPositionSolver.js`)
```
along = (L² + r1² − r2²) / 2L          perp = √(r1² − along²)
candidates = base ± perp · n̂           (mirror images across the beacon line)
```
- If the circles don't meet, both ranges are scaled until they touch. An adjustment over 8 ft points to bad calibration.
- A baseline under 3 ft can't give a direction, so the result is a proximity fix at the midpoint.
- **Choosing a candidate:** a candidate is ruled out if it lies outside the floor plan (with a 4 ft margin). If both are inside and more than 4 ft apart, the result is **ambiguous** and both are kept.
- **Uncertainty:** `σ = 4 ft × GDOP`, with `GDOP = √2 / |sin θ|` (capped at 12). θ is the angle between the two beacons as seen from the user.

### 5.2 Timed accumulation (`RangeFixAccumulator`)
One sample per **new** packet, and only while both beacons were heard within the last **10 s**. A 0 m range is raised to 0.5 ft.

| Rule | Value |
|---|---|
| Normal commit | at least 6 samples **and** at least 1.5 s **and** not drifting **and** honest SEM ≤ 1.0 ft for both ranges |
| Honest SEM | `s / √n_eff`, with `n_eff = n(1−ρ)/(1+ρ)`, where ρ is the lag-1 autocorrelation (range 0–0.95) |
| Drift test | the halves of the window differ by more than max(2.5 ft, 2·SEM) |
| Timeouts | 4 s when steady, or 8 s while drifting (then only the newest half is used), with at least 3 samples |
| Hard deadline | **8 s**, with at least 2 samples. Checked every second, even when no samples arrive |
| Starting uncertainty | from max(SEM, drift across the window), so a rough start is corrected quickly by BLE once navigating |
| Walking starts | commit immediately if at least 4 samples |
| Estimate | 20% trimmed mean of each range, then §5.1 |

Measured in the office: 3 s of packets gives about 2.1 ft of range error, and 8 s gives about 1.1 ft. Accuracy is limited by **time** (slow shadowing), not packet count. In simulation, 1.5 s costs about 0.2 ft of median range error compared with 3 s. Going below about 1 s costs much more.

## 6. Fusion EKF (`FusionEngine.js`)

State `[x, y]` in feet, with covariance `P` (2×2).

**Predict (each step):**
```
L = clamp(len, 1.48, 3.44 ft)
x += L sin θ ;  y += L cos θ
P += (0.06·L)² · I
```

**Correct (each BLE update).** Two ranges only observe the position **along** the beacon line:
```
t  = (L_b² + d1² − d2²) / 2L_b,   clamped to [0, L_b]
H  = [ux, uy]  (unit vector from B1 to B2)
R  = lerp(400 ft², 4 ft², conf²-weight)
     × min(25, (15/L_b)²)     if the baseline is under 15 ft
     × 6                      if standing (no step for 1.4 s)
     × 8                      if the implied speed is over 9.84 ft/s (jump guard)
K  = P Hᵀ / (H P Hᵀ + R) ;   x += K·(t − H·x) ;   P = (I − K H) P
```
- The perpendicular axis is left to PDR. A perpendicular fix exists but is **off**: tests showed it makes accuracy worse whenever there's range bias.
- **Passive tick (1 Hz):** `P += 0.0108 ft²/s · dt`, ×0.15 when standing. The uncertainty is capped at 26.25 ft.
- **Room clamp:** the position is kept inside the room. The distance it had to be pushed back is recorded as "out-of-bounds debt".
- **Mirror ambiguity:** both hypotheses get the same predict and correct. Each is scored by `−½Σ(dᵢ − |p − Bᵢ|)² / 5²` (decay 0.97) minus 0.6 × its debt. One is dropped when:
  - its debt goes over 25 ft, or
  - the log-odds reach 10.

  There's deliberately no forced decision on a timer. After 25 s the UI asks you to walk across the beacon line.
- **Trail:** a point is recorded only after 1 ft of movement, up to 300 points (about 300 ft).
- **Reported values:** `totalDistanceFt` is step odometry, not the length of the fused track. `netDisplacementFt` is the straight-line distance from the start.

## 7. Fusion Map flow

1. **Find My Position** → `beginLocating()`, and the per-beacon diagnostics start.
2. Samples go into §5.2. Once there are 4 or more, a provisional dot is shown but not used for tracking.
3. Fix committed:
   - `beginNavigation()` **always** runs right away, and a "✓ Position found" banner shows for 5 s.
   - If the heading has never been zeroed, the Zero Heading prompt stays visible while navigating. It no longer blocks navigation.
4. **Navigating:** steps call `predict`, BLE calls `correct`, and the trail is drawn.
5. **Manual start** ("👆 Set My Start on the Map", or a tap on the map while locating):
   - Tap where you are, then **Start Here**. `setManualPosition(x, y)` cancels locating, clamps the point into the room and seeds ±3 ft of uncertainty, so BLE still fine-tunes it.
   - BLE auto-placement is suspended while you choose.
   - While two candidates are shown, tapping near one settles it (`chooseHypothesisNear`).
6. **Save Path** stores the trail in feet (`source: "fusionMap"`), and the route stays drawn on the map.

## 8. Loop closure (PDR tab)
"Close loop" assumes you ended where you started. It spreads the end-point error back along the path in proportion to each point's position along it.
