# 02. Core Logic, Scientific Algorithms & Mathematical Models

This document details the mathematical models, physics principles, signal processing pipelines, and state machines powering the indoor navigation and pedestrian positioning engine.

---

## 1. Mathematical Notation & Coordinate Reference Frames

### 1.1 Navigation Reference Frame
The application defines an indoor right-handed Cartesian navigation frame:
* **Origin $(0,0)$**: User starting position or room corner anchor.
* **$+Y$ Axis**: Forward direction / Initial Heading $0^\circ$ (North).
* **$+X$ Axis**: Right direction / Heading $+90^\circ$ (East).
* **$-X$ Axis**: Left direction / Heading $-90^\circ$ or $270^\circ$ (West).
* **$-Y$ Axis**: Backward direction / Heading $180^\circ$ (South).

---

## 2. Pedestrian Dead Reckoning (PDR) Algorithms

### 2.1 Dynamic Gravity Subtraction & Low-Pass Filtering
Raw 3-axis accelerometer output contains both gravitational acceleration ($g \approx 9.81\text{ m/s}^2$ or $1.0\text{ g}$) and dynamic human motion acceleration.

1. **Total Acceleration Magnitude**:
   $$\|a(t)\| = \sqrt{a_x(t)^2 + a_y(t)^2 + a_z(t)^2}$$

2. **First-Order Low-Pass Filter**:
   $$a_{\text{filtered}}(t) = \alpha_{\text{acc}} \cdot a_{\text{filtered}}(t - 1) + (1 - \alpha_{\text{acc}}) \cdot \|a(t)\|, \quad \alpha_{\text{acc}} = 0.70$$

3. **Dynamic Gravity Tracking Baseline**:
   $$g_{\text{est}}(t) = \alpha_g \cdot g_{\text{est}}(t - 1) + (1 - \alpha_g) \cdot a_{\text{filtered}}(t), \quad \alpha_g = 0.98$$

4. **Isolated Dynamic Body Acceleration**:
   $$a_{\text{dynamic}}(t) = a_{\text{filtered}}(t) - g_{\text{est}}(t)$$

---

### 2.2 Zero-Velocity Update (ZUPT) Energy Gating
To eliminate phantom steps when the user is stationary or handling the device, the system calculates acceleration variance over a rolling $N = 16$ sample window ($\approx 320\text{ ms}$ at $50\text{ Hz}$):

$$\bar{a} = \frac{1}{N} \sum_{i=1}^{N} a_{\text{dynamic}}[i]$$
$$\sigma_a^2 = \frac{1}{N} \sum_{i=1}^{N} (a_{\text{dynamic}}[i] - \bar{a})^2$$

* **Stationary Gate**: If $\sigma_a^2 < 0.005\text{ g}^2$, the user is confirmed stationary. The step state machine is locked in `IDLE`, preventing drift.

---

### 2.3 3-State Peak-Valley Step Finite State Machine (FSM)

```text
    ┌──────────────┐
    │     IDLE     │ ◄────────────────────────────────────────┐
    └──────┬───────┘                                          │
           │ Trigger: a_dynamic > +0.12g                      │
           ▼                                                  │
    ┌──────────────┐                                          │ Validation Failure
    │  ARMED_PEAK  │ (Tracks highest peak: a_max)             │ OR Timeout (> 450ms)
    └──────┬───────┘                                          │
           │ Trigger: a_dynamic crosses downward < +0.02g     │
           ▼                                                  │
    ┌──────────────┐                                          │
    │ ARMED_VALLEY │ (Tracks lowest valley: a_min)            │
    └──────┬───────┘                                          │
           │ Trigger: a_dynamic rebounds upward > -0.09g      │
           ▼                                                  │
    ┌──────────────┐                                          │
    │  VALIDATION  │ ─────────────────────────────────────────┘
    └──────┬───────┘
           │ Checks:
           │  1. Bounce Amplitude: (a_max - a_min) >= 0.18g
           │  2. Step Cadence: 250ms <= dt <= 1600ms (0.6 - 4.0 steps/s)
           │  3. Peak-to-Valley Duration: 40ms <= dt_pv <= 400ms
           ▼
    ┌──────────────────────────┐
    │     STEP CONFIRMED!      │ ──► Compute Weinberg Stride -> Inject Kalman Prediction
    └──────────────────────────┘
```

---

### 2.4 Adaptive Weinberg Dynamic Step Length Model
Human stride length varies continuously with walking velocity and bounce amplitude. The system applies the **Weinberg Inverted-Pendulum Formulation**:

$$SL = K_{\text{weinberg}} \cdot \sqrt[4]{a_{\max} - a_{\min}}$$

Where:
* $a_{\max} - a_{\min}$: Peak-to-valley bounce amplitude in $g$ units.
* $K_{\text{weinberg}} = 0.74$: Calibrated empirical scaling coefficient.
* **Biomechanical Clamping**:
  $$SL_{\text{clamped}} = \max\left(0.45\text{ m}, \; \min\left(1.15\text{ m}, \; SL\right)\right)$$

---

### 2.5 Continuous Circular Shortest-Arc Heading Engine
To prevent catastrophic boundary discontinuities when heading crosses the $0^\circ \leftrightarrow 360^\circ$ or $\pm 180^\circ$ thresholds:

1. **Angular Wrapping**:
   $$\Delta\theta = ((\theta_{\text{sensor}} - \theta_{\text{current}} + 180^\circ) \bmod 360^\circ) - 180^\circ$$

2. **Shortest-Arc Circular Low-Pass Filter**:
   $$\theta_{\text{current}}(t) = \theta_{\text{current}}(t - 1) + \alpha_{\theta} \cdot \Delta\theta, \quad \alpha_{\theta} = 0.25$$

3. **Coordinate Projection**:
   $$\Delta x = SL \cdot \sin(\theta), \quad \Delta y = SL \cdot \cos(\theta)$$
   $$x(t) = x(t - 1) + \Delta x, \quad y(t) = y(t - 1) + \Delta y$$

---

## 3. BLE Signal Processing & Distance Estimation

### 3.1 Automated iBeacon & Eddystone Payload Decoding
The application parses the base64-encoded Bluetooth Low Energy Advertising Data (AD Type `0xFF` Manufacturer Specific Data):

```text
Byte Offset:   0      1      2      3      4 .................... 19    20    21    22    23    24
Content:     [0x4C] [0x00] [0x02] [0x15] [   16-Byte Proximity UUID   ] [   Major   ] [   Minor   ] [TxPower]
Field:       Apple Company iBeacon Length                               Big-Endian    Big-Endian    Signed
             ID (0x004C)   Header (21 bytes)                                                        int8
```

1. **Company ID Verification**: Matches Apple `0x004C` (`bytes[0] === 0x4C && bytes[1] === 0x00`).
2. **iBeacon Header**: Matches Type `0x02` and Data Length `0x15` (21 bytes).
3. **16-Byte UUID Extraction**: Converts bytes $4$ through $19$ to standard RFC 4122 format:
   $$\text{UUID} = \text{Hex}(4..7) - \text{Hex}(8..9) - \text{Hex}(10..11) - \text{Hex}(12..13) - \text{Hex}(14..19)$$
4. **Major & Minor Extraction (Big-Endian)**:
   $$\text{Major} = (\text{bytes}[20] \ll 8) \;|\; \text{bytes}[21]$$
   $$\text{Minor} = (\text{bytes}[22] \ll 8) \;|\; \text{bytes}[23]$$
5. **Calibrated Tx Power (Two's Complement Signed int8)**:
   $$\text{TxPower} = \begin{cases} \text{bytes}[24] & \text{if } \text{bytes}[24] < 128 \\ \text{bytes}[24] - 256 & \text{if } \text{bytes}[24] \ge 128 \end{cases}$$

---

### 3.2 Multi-Stage Signal Filtering Pipeline

```text
[Raw BLE Packet (RSSI)]
       │
       ▼
1. Outlier Gating: Discard if RSSI < -105 dBm or RSSI > -5 dBm
       │
       ▼
2. Rolling Median Filter (Window = 5): Suppress channel-hopping spikes (ch 37/38/39)
       │
       ▼
3. Adaptive One-Euro Filter: Eliminate stationary jitter, track motion with 0-lag
       │
       ▼
4. Asymmetric dBm EMA: Damp human body shadowing drops
       │
       ▼
5. Log-Distance Path Loss Model + 0cm Touch Curve Correction
       │
       ▼
6. Kinematic Slew-Rate Limiter (Max 1.6 m/s walking speed ceiling)
       │
       ▼
[Smooth Physical Distance (m / ft)]
```

---

### 3.3 Adaptive One-Euro Low-Pass Filter
The One-Euro filter dynamically adapts its cutoff frequency based on the rate of change of the RSSI signal derivative $\dot{x}$:

1. **Signal Derivative**:
   $$\dot{x} = \frac{x(t) - x(t - \Delta t)}{\Delta t}$$

2. **Filtered Derivative**:
   $$\dot{x}_{\text{filtered}} = \alpha_d \cdot \dot{x} + (1 - \alpha_d) \cdot \dot{x}_{\text{filtered}}(t - 1), \quad \alpha_d = \frac{1}{1 + \frac{1}{2\pi \cdot f_{c,d} \cdot \Delta t}}$$

3. **Dynamic Cutoff Frequency**:
   $$f_c = f_{c,\min} + \beta \cdot |\dot{x}_{\text{filtered}}|$$

4. **Adaptive Smoothing Factor**:
   $$\hat{\alpha} = \frac{1}{1 + \frac{1}{2\pi \cdot f_c \cdot \Delta t}}$$
   $$x_{\text{filtered}}(t) = \hat{\alpha} \cdot x(t) + (1 - \hat{\alpha}) \cdot x_{\text{filtered}}(t - 1)$$

* **Stationary ($|\dot{x}| \approx 0$)**: $f_c = 0.35\text{ Hz}$ (smooths numeric fluctuations).
* **Rapid Movement ($|\dot{x}| \gg 0$)**: $f_c \rightarrow 2.0-5.0\text{ Hz}$ (immediate tracking response).

---

### 3.4 Log-Distance Path Loss Model & Near-Field Touch Curve

#### Standard Log-Distance Path Loss:
$$RSSI = TxPower_{1\text{m}} - 10 \cdot n \cdot \log_{10}(d)$$
$$d_{\text{raw}} = 10^{\frac{TxPower_{1\text{m}} - RSSI}{10 \cdot n}}$$

Where:
* $TxPower_{1\text{m}} = -59\text{ dBm}$ (measured reference at $1\text{ meter}$).
* $n = 2.2$ (indoor environmental path loss exponent).

#### Near-Field Touch Curve (Eliminating the 18–21 cm Floor):
Due to antenna saturation and receiver non-linearity, raw RSSI caps around $-43\text{ dBm}$, which falsely calculates to $0.18 - 0.21\text{ m}$ even when touching the beacon. The system applies a smooth polynomial touch curve:

$$d = \begin{cases} 
0.00\text{ m} & \text{if } RSSI \ge -43\text{ dBm} \\
d_{\text{raw}} \cdot \left(\frac{-43 - RSSI}{-43 - (-50)}\right) & \text{if } -50\text{ dBm} < RSSI < -43\text{ dBm} \\
d_{\text{raw}} & \text{if } RSSI \le -50\text{ dBm}
\end{cases}$$

---

### 3.5 3D Slant-to-2D Horizontal Height Correction
Beacons mounted on ceilings ($h_{\text{beacon}} \approx 9.0\text{ ft}$) measure 3D line-of-sight slant hypotenuse distance ($d_{3D}$) relative to a hand-held phone ($h_{\text{phone}} \approx 3.5\text{ ft}$):

$$\Delta h = |h_{\text{beacon}} - h_{\text{phone}}| = 9.0 - 3.5 = 5.5\text{ ft}$$
$$d_{2D} = \sqrt{\max\left(0, \; d_{3D}^2 - \Delta h^2\right)}$$

---

## 4. Analytical Two-Beacon Trilateration Solver

### 4.1 Circle-Circle Intersection Formulation
Given two beacons $B_1(x_1, y_1)$ with distance $r_1$, and $B_2(x_2, y_2)$ with distance $r_2$:

1. **Baseline Distance**:
   $$D = \sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}$$

2. **Distance to Orthogonal Chord Intersection**:
   $$a = \frac{r_1^2 - r_2^2 + D^2}{2D}$$

3. **Dynamic Baseline Clamping (Preventing Imaginary Roots under Noise)**:
   $$a_{\text{clamped}} = \max(-0.2D, \; \min(1.2D, \; a))$$

4. **Orthogonal Offset ($h$)**:
   $$h = \sqrt{\max(0, \; r_1^2 - a_{\text{clamped}}^2)}$$

5. **Chord Center Point**:
   $$P_0 = B_1 + \frac{a_{\text{clamped}}}{D} (B_2 - B_1)$$

6. **Candidate Coordinate Solutions**:
   $$P_{1,2} = \left( x_0 \pm \frac{h}{D}(y_2 - y_1), \; y_0 \mp \frac{h}{D}(x_2 - x_1) \right)$$

---

### 4.2 Geometric Disambiguation Engine
1. **Room Containment Test**: If only one candidate falls within $[0 \le x \le W_{\text{room}}, \; 0 \le y \le H_{\text{room}}]$, that candidate is immediately selected.
2. **Kinematic Continuity Fallback**: If both points fall inside (or both outside), the solver selects the point closest to the previous validated position:
   $$\hat{P} = \arg\min_{P \in \{P_1, P_2\}} \|P - P_{\text{previous}}\|$$

---

## 5. Sensor Fusion: Adaptive 2D Kalman Filter

### 5.1 System State & Covariance
* **State Vector**: $\mathbf{x} = [x, \; y]^T$
* **Covariance Matrix**: $\mathbf{P} = \begin{bmatrix} P_{xx} & 0 \\ 0 & P_{yy} \end{bmatrix}$

### 5.2 Time Update (Continuous Prediction via PDR)
When a step is registered with stride length $SL$ and heading $\theta$:
$$\Delta x = SL \cdot \sin(\theta), \quad \Delta y = SL \cdot \cos(\theta)$$
$$\mathbf{x}_{k|k-1} = \mathbf{x}_{k-1} + [\Delta x, \; \Delta y]^T$$
$$\mathbf{P}_{k|k-1} = \mathbf{P}_{k-1} + \mathbf{Q}$$
Where process noise $\mathbf{Q} = \text{diag}(q_{\text{step}}, q_{\text{step}})$, scaled dynamically by user walking velocity.

### 5.3 Measurement Validation: Innovation Residual Outlier Gating
Before applying a BLE measurement $\mathbf{z}_{\text{BLE}} = [x_{\text{BLE}}, \; y_{\text{BLE}}]^T$, the filter evaluates the **Innovation Residual**:

$$\nu = \|\mathbf{z}_{\text{BLE}} - \mathbf{x}_{k|k-1}\| = \sqrt{(x_{\text{BLE}} - x_{\text{pred}})^2 + (y_{\text{BLE}} - y_{\text{pred}})^2}$$

* **Rejection Threshold**: If $\nu > 12.0\text{ ft}$ ($\approx 3.65\text{ m}$), the measurement is rejected as multi-path bounce.
* **Adaptive Measurement Update**:
  $$\mathbf{K} = \mathbf{P}_{k|k-1} (\mathbf{P}_{k|k-1} + \mathbf{R})^{-1}$$
  $$\mathbf{x}_k = \mathbf{x}_{k|k-1} + \mathbf{K} (\mathbf{z}_{\text{BLE}} - \mathbf{x}_{k|k-1})$$
  $$\mathbf{P}_k = (\mathbf{I} - \mathbf{K}) \mathbf{P}_{k|k-1}$$

Where measurement noise $\mathbf{R}$ scales inversely with the beacon confidence score:
$$\mathbf{R} = \mathbf{R}_{\text{base}} \cdot \left(1.0 + \frac{1.0 - \text{Confidence}}{\text{Confidence} + 0.01}\right)$$

---

## 6. Experimental BLE RTT / ToF Nanosecond Ranging & Dual-Domain Fusion

### 6.1 Physical Time-of-Flight (ToF) Mathematical Formulation
The application implements physical electromagnetic round-trip propagation ranging:

$$d_{\text{RTT}} = \frac{c \cdot T_{\text{corrected}}}{2}$$

Where:
* $c = 299,792,458\text{ m/s} \approx 0.299792458\text{ m/ns}$ (speed of light in air).
* $T_{\text{corrected}} = \max\left(0, \; T_{\text{raw}} - T_{\text{offset}}\right)$ (in nanoseconds).
* $T_{\text{offset}}$: Calibrated transceiver hardware turnaround delay ($\approx 50,000\text{ ns}$ or $50\ \mu\text{s}$).

**Spatial Sensitivity**:
$$1\text{ ns of round-trip time} \iff \frac{0.299792458\text{ m/ns} \times 1\text{ ns}}{2} \approx 0.1499\text{ m} \approx 15.0\text{ cm of one-way physical distance}$$

---

### 6.2 Line-of-Sight (LOS) First-Path Arrival Estimator
In indoor radio environments, multipath reflections from walls and objects travel strictly longer paths than the direct line-of-sight (LOS) path:

$$T_{\text{multipath}} = T_{\text{LOS}} + \Delta\tau, \quad \Delta\tau \ge 0$$

Computing a simple arithmetic mean $\bar{T} = \frac{1}{N}\sum T_i$ introduces a persistent positive bias of $+0.6\text{ to } +1.5\text{ ns}$ ($+9\text{ to } +23\text{ cm}$ error).
To eliminate multipath inflation:
1. **Median Absolute Deviation (MAD) / Hampel Filter**:
   $$\text{MAD} = \text{median}(|T_i - \tilde{T}|)$$
   Rejects CPU scheduling spikes and interrupt outliers exceeding $2.8 \times 1.4826 \times \text{MAD}$.
2. **Lower-Quartile / Leading-Edge Estimator**:
   The direct line-of-sight path is extracted as the 20th percentile of clean sorted arrival samples:
   $$T_{\text{LOS}} = \mathcal{Q}_{0.20}(\{T_{\text{clean}}\})$$
   This favors the earliest electromagnetic wave arrival while filtering out thermal Gaussian clock jitter ($\sigma \approx 0.40\text{ ns}$).

---

### 6.3 Sub-Nanosecond Auto-Calibration
To eliminate unknown hardware transceiver latencies without manual tuning, the user places the beacon at a known reference distance $d_{\text{GT}}$ (e.g. $1.0\text{ m}$):

$$T_{\text{ideal,GT}} = \frac{2 \cdot d_{\text{GT}}}{c}$$
$$T_{\text{offset}} = T_{\text{LOS}} - T_{\text{ideal,GT}}$$

When calibration is triggered, the system instantly sets $T_{\text{offset}}$, seeds filter buffers with $T_{\text{LOS}}$, and snaps $d_{\text{RTT}} = d_{\text{GT}}$, ensuring **$0.00\text{ m}$ initial calibration error**.

---

### 6.4 Dual-Domain Hybrid Fusion (RTT + RSSI)
While pure RTT ToF provides strict spatial linearity at distance, filtered RSSI provides smooth non-fluctuating signal gradients in the near-field ($< 1.0\text{ m}$). The system fuses both domains using an adaptive complementary filter:

$$d_{\text{fused}} = w_{\text{RTT}} \cdot d_{\text{RTT}} + (1 - w_{\text{RTT}}) \cdot d_{\text{RSSI}}$$

Where dynamic weight $w_{\text{RTT}}$ adapts based on physical distance regime:
$$w_{\text{RTT}} = \begin{cases} 
0.50 & \text{if } d < 0.8\text{ m (Near-Field: equal blend to suppress clock jitter)} \\
0.70 & \text{if } 0.8\text{ m} \le d \le 2.5\text{ m (Transition zone)} \\
0.85 & \text{if } d > 2.5\text{ m (Far-Field: ToF linearity dominates flattened RSSI)}
\end{cases}$$

---

## 7. Version 2 Multi-Stage RSSI Smoothing & Kinematic Distance Pipeline

Version 2 (Beacon Signal Lab) implements an empirical 6-stage mathematical conditioning and distance calculation pipeline designed to eliminate the severe $\pm 10\text{–}15\text{ dBm}$ jumping of raw BLE signals and provide rock-solid navigation distances.

```text
[Raw BLE Packet (Ch 37/38/39)]
            │
            ▼
[Stage 1: Hampel / MAD Outlier Gating]
    Clamps anomalous packet dropouts & spikes (|RSSI - median| > 2.8 * 1.4826 * MAD)
            │
            ▼
[Stage 2: 7-Tap Multi-Channel Moving Median Filter]
    Guarantees at least 2 packets across channels 37, 38, 39 to eliminate hopping spikes
            │
            ▼
[Stage 3: Asymmetric Fading Recovery Filter (EMA)]
    Damps multipath nulls & human body shadowing (α_drop = 0.18, α_rise = 0.40)
            │
            ▼
[Stage 4: Velocity-Adaptive One-Euro Filter]
    Dynamic cutoff: fc = 0.25 Hz at rest (zero numeric jitter) -> 3.5 Hz during movement
            │
            ▼
[Stage 5: Calibrated Log-Distance with Touch Polynomial]
    d_raw = 10 ^ ((Tx_1m - RSSI_smooth) / (10 * n)) + near-field zero touch curve
            │
            ▼
[Stage 6: Kinematic Slew-Rate Limiter (1.8 m/s Walking Ceiling)]
    |Δd| <= v_max * Δt, preventing physically impossible spatial teleportation
            │
            ▼
[Accurate, Jitter-Free Navigation Distance (m / ft / in)]
```

### 7.1 Multi-Channel RF Hopping Suppression
BLE beacons advertise across 3 frequencies (2402, 2426, 2480 MHz). Frequency-selective indoor multipath causes different channels to receive drastically different power levels at the exact same spot. A 7-tap sliding median captures $\ge 2$ samples per channel, eliminating inter-channel hopping jitter without adding latency.

### 7.2 Asymmetric Multipath Recovery (EMA)
Multipath interference indoors is destructive (causing negative fading nulls) far more frequently than constructive. Therefore, when signal drops, it is damped with $\alpha_{\text{drop}} = 0.18$. When signal rises (user walking towards beacon), it tracks with $\alpha_{\text{rise}} = 0.40$.

### 7.3 Near-Field Antenna Saturation Polynomial
Receivers saturate around $-43\text{ dBm}$, which naive log formulas calculate as $\approx 0.20\text{ m}$ even when in physical contact with the beacon. Version 2 applies a smooth polynomial interpolation:
$$d = \begin{cases}
0.00\text{ m} & \text{if } RSSI_{\text{smooth}} \ge -43\text{ dBm} \\
d_{\text{raw}} \cdot \left(\frac{-43 - RSSI_{\text{smooth}}}{-43 - (-50)}\right) & \text{if } -50\text{ dBm} < RSSI_{\text{smooth}} < -43\text{ dBm} \\
d_{\text{raw}} & \text{if } RSSI_{\text{smooth}} \le -50\text{ dBm}
\end{cases}$$

### 7.4 Kinematic Slew-Rate Limiter
Human indoor walking speed has a physical ceiling $v_{\max} = 1.8\text{ m/s}$. The slew limiter prevents sudden multipath dropouts from creating navigation jumps:
$$|\Delta d| \le v_{\max} \cdot \Delta t$$

---

## 8. Adaptive, Per-Beacon Signal Processing & Localization Engine

Different physical BLE beacon units behave inconsistently due to hardware crystal tolerances, antenna design, battery degradation, and varying multipath environments. Fixed-parameter filters cannot optimize both stable and erratic beacons simultaneously.

The **Adaptive Beacon Engine** (`AdaptiveBeaconEngine.js`) solves this by instantiating an autonomous statistical profiling and adaptive Kalman pipeline per unique beacon ID.

```text
[Raw Beacon Packet (MAC)]
           │
           ▼
[Outlier Rejection Gate] ──> Deviates > 10 dBm from rolling median? ──> CLAMP / REJECT
           │ (Cleaned Sample)
           ▼
[BeaconProfile (Window N = 15)]
    Compute Live Mean (μ), Variance (σ²), and Continuous Stability Score S ∈ [0, 1]
           │
           ▼
[AdaptiveKalmanFilter (Per Beacon)]
    Scale Measurement Noise: R = max(1.0, σ²)
    Scale Process Noise: Q = Q_floor + (Q_ceil - Q_floor) * min(1.0, σ² / 30.0)
    Kalman Gain K = P / (P + R) dynamically adapts:
      - Low σ²: R is tiny, K is large -> Agile, responsive, zero-lag.
      - High σ²: R is large, K is small -> Aggressively smooths heavy noise.
           │
           ▼
[PathLossCalibrator (OLS Linear Regression)]
    Empirical Reference Points (d_i, RSSI_i) fitted via Ordinary Least Squares:
    RSSI = -n · (10 · log10(d)) + TxPower_1m
    Yields calibrated per-beacon (n, TxPower_1m) and R² goodness-of-fit.
           │
           ▼
[Kinematic Walking Slew Limiter (1.8 m/s Ceiling)]
           │
           ▼
[BeaconManager & Confidence-Squared Weighted Positioning]
    Live Confidence: C_i = S_i · f_recency · f_sufficiency
    Anchor Weight:   w_i = C_i² (Confidence Squared)
    Positions calculated via Weighted Least Squares (WLS) Multilateration.
```

### 8.1 Statistical Beacon Profile
For each beacon $i$, samples are tracked in a sliding window of size $N = 15$:
$$\mu = \frac{1}{N}\sum_{k=1}^N \text{RSSI}_k, \quad \sigma^2 = \frac{1}{N}\sum_{k=1}^N (\text{RSSI}_k - \mu)^2$$

Continuous stability score $S \in [0.0, 1.0]$:
$$S = \max\left(0.0, 1.0 - \frac{\sigma}{12.0}\right)$$

### 8.2 Dynamic Adaptive Kalman Scaling
Unlike static filters with constant $Q$ and $R$, the adaptive filter tunes its uncertainty matrices in real time based on that beacon's live variance:
$$R = \max(1.0, \sigma^2)$$
$$Q = Q_{\text{floor}} + (Q_{\text{ceiling}} - Q_{\text{floor}}) \cdot \min\left(1.0, \frac{\sigma^2}{30.0}\right)$$
Where $Q_{\text{floor}} = 0.01$ and $Q_{\text{ceiling}} = 0.05$.

- **Stable Beacon ($\sigma^2 \approx 1\text{–}2$):** $R \approx 1.0$, $Q = 0.01$. The filter trusts the measurements, yielding high Kalman gain $K \approx 0.6\text{–}0.8$ with instantaneous tracking responsiveness.
- **Erratic Beacon ($\sigma^2 \ge 25$):** $R \ge 25$, $Q = 0.05$. The filter heavily distrusts raw samples ($K \approx 0.1\text{–}0.2$), aggressively suppressing noise fluctuations.

### 8.3 Path Loss Calibration via OLS Linear Regression
The empirical Log-Distance formula is expressed in standard linear regression format $Y = a \cdot X + b$:
$$X = 10 \cdot \log_{10}(d), \quad Y = \text{RSSI}$$
$$\text{Slope } a = -n \implies n = -a, \quad \text{Intercept } b = \text{TxPower}_{1\text{m}}$$

Given $M$ reference walk measurements $(d_j, \text{RSSI}_j)$:
$$a = \frac{\sum (X_j - \bar{X})(Y_j - \bar{Y})}{\sum (X_j - \bar{X})^2}, \quad b = \bar{Y} - a\bar{X}$$

Goodness of fit is validated via the Coefficient of Determination:
$$R^2 = 1 - \frac{\sum (Y_j - \hat{Y}_j)^2}{\sum (Y_j - \bar{Y})^2}$$

### 8.4 Confidence-Squared ($w = C^2$) Weighted Positioning
Each beacon is assigned a composite real-time confidence $C \in [0, 1]$ combining stability, packet recency, and sample count:
$$C = S \cdot \max\left(0, 1 - \frac{\Delta t_{\text{age}}}{4000\text{ ms}}\right) \cdot \min\left(1.0, \frac{N}{5}\right)$$

In 2D multilateration, beacon weights are assigned as confidence squared:
$$w_i = C_i^2$$

**Why Confidence Squared:**
Linear weighting ($w_i = C_i$) allows a noisy anchor ($C_2 = 0.40$) to influence the position by almost half as much as a pristine anchor ($C_1 = 0.90$). With confidence squared:
$$w_1 = 0.90^2 = 0.81, \quad w_2 = 0.40^2 = 0.16 \implies \frac{w_1}{w_2} \approx 5.06$$
The pristine anchor exerts over $5\times$ greater authority, isolating navigation from multipath degradation.

