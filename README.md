# Indoor Navigation & PDR Testing App (Expo / React Native)

A production-grade cross-platform mobile application combining **Pedestrian Dead Reckoning (PDR)**, **Bluetooth Low Energy (BLE) Multi-Beacon Positioning**, and **Adaptive Kalman Sensor Fusion** for indoor mapping and tracking. Built with Expo, React Native, and EAS.

---

## 🌟 Table of Contents
1. [System Architecture & Core Modules](#-system-architecture--core-modules)
2. [Module 1: Pedestrian Dead Reckoning (PDR)](#-1-pedestrian-dead-reckoning-pdr)
3. [Module 2: Fast & Smooth BLE Scanner & Proximity Engine](#-2-fast--smooth-ble-scanner--proximity-engine)
4. [Module 3: 2-Beacon Indoor Positioning & Fusion](#-3-2-beacon-indoor-positioning--fusion)
5. [Module 4: In-App Configuration Engine](#-4-in-app-configuration-engine)
6. [Module 5: EAS Over-The-Air (OTA) Updates](#-5-eas-over-the-air-ota-updates)
7. [Hardware & Beacon Configuration (MOKO Smart H2)](#-hardware--beacon-configuration-moko-smart-h2)
8. [Mathematical & Algorithmic Formulations](#-mathematical--algorithmic-formulations)
9. [Project Directory Structure](#-project-directory-structure)
10. [Getting Started & Build Guide](#-getting-started--build-guide)

---

## 🏗️ System Architecture & Core Modules

The application operates across four specialized navigation tabs:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                             APP ROUTER (App.js)                             │
│                  ┌───────────────────────┴───────────────────────┐          │
│                  ▼                                               ▼          │
│          App.android.js                                      App.ios.js     │
└──────────────────┬───────────────────────────────────────────────┬──────────┘
                   │                                               │
  ┌────────────────┼──────────────────────────────┐                │
  ▼                ▼                              ▼                ▼
┌────────────┐  ┌──────────────────┐  ┌───────────────────────┐  ┌────────────┐
│   👣 PDR   │  │  📶 BLE Scanner  │  │  🛰️ 2-Beacon Module   │  │⚙️ Settings │
│ Step FSM   │  │ 1€ RSSI Filter   │  │ 4-Stage Calibration   │  │ Live Tuning│
│ Weinberg K │  │ iBeacon Decoder  │  │ Analytical 2-Circle   │  │ No-Rebuild │
│ Gyro Yaw   │  │ Distance Graphs  │  │ Adaptive Kalman Filter│  │ Local Cache│
│ SVG Canvas │  │ Live Search Bar  │  │ Trajectory Export CSV │  │ Fallbacks  │
└────────────┘  └──────────────────┘  └───────────────────────┘  └────────────┘
```

---

## 👣 1. Pedestrian Dead Reckoning (PDR)

The PDR engine converts raw smartphone motion sensors into a real-time 2D displacement vector $(x, y)$:

- **High-Frequency Accelerometer Processing (50 Hz)**:
  - Dynamic gravity baseline removal via continuous low-pass filtering.
  - Zero-Velocity Update (ZUPT) thresholding: suppresses false step triggers when standing stationary or handling the phone.
  - 3-State Peak-Valley Step Finite State Machine (`IDLE` $\rightarrow$ `ARMED_PEAK` $\rightarrow$ `ARMED_VALLEY` $\rightarrow$ `STEP_CONFIRMED`) with dynamic refractory cadence clamping ($250\text{ ms} - 1600\text{ ms}$).
- **Adaptive Weinberg Dynamic Step Length**:
  - Automatically estimates stride length based on vertical bounce acceleration:
    $$\text{StepLength} = K \cdot \sqrt[4]{a_{\max} - a_{\min}}$$
  - Default Weinberg coefficient $K = 0.74$, dynamically clamped to realistic biomechanical bounds ($0.45\text{ m} - 1.15\text{ m}$).
- **Continuous Circular Heading Engine**:
  - Fusion of DeviceMotion gyroscope yaw rotation with magnetometer azimuth fallback.
  - Shortest-arc circular angle wrapping to prevent $0^\circ \leftrightarrow 360^\circ$ and $\pm 180^\circ$ discontinuity boundary spikes.
  - One-tap forward zero calibration (**Set Heading Zero**).
- **Interactive SVG Route Canvas**:
  - Auto-scaling coordinate grid with real-time user cursor and directional heading cone.
  - Start point marker, live $(x, y)$ coordinate telemetry, and previous route overlays.
  - One-tap **Loop Closure** drift compensation and coordinate re-centering back to $(0, 0)$.
- **Route Storage & Persistence**:
  - Saved path history stored locally via `PathStorage.js` (with memory fallback).
  - Stores complete step arrays, distance totals, timestamps, and waypoint coordinates.

---

## 📶 2. Fast & Smooth BLE Scanner & Proximity Engine

A diagnostic suite for scanning, decoding, and estimating physical distance to nearby BLE beacons:

- **Ultra-Low Latency Native Scanning**:
  - Powered by `react-native-ble-plx` in hardware `LowLatency` scan mode (50ms refresh cycle).
- **Automated iBeacon & Eddystone Decoding**:
  - Parses raw Bluetooth AD Type `0xFF` Manufacturer Data payloads without requiring third-party scanners.
  - Automatically extracts Apple Company Identifier (`0x004C`), 16-byte Proximity UUID, Major, Minor, and Measured TxPower at 1m.
  - Resolves anonymous beacons into distinct named tags (e.g. `iBeacon (M:1 m:1)`).
- **Multi-Stage Signal Filtering Pipeline**:
  1. **Outlier Gating**: Discards corrupted RSSI samples outside the $[-105, -5]\text{ dBm}$ physical range.
  2. **Rolling Median Filter (5-Sample Window)**: Strips high-frequency channel-hopping noise across Bluetooth advertising channels 37, 38, and 39.
  3. **Adaptive One-Euro Low-Pass Filter**: Automatically suppresses numeric jitter when stationary ($0.35\text{ Hz}$ cutoff), while transitioning to 0-lag tracking during rapid movement.
  4. **Asymmetric dBm EMA**: Smooths artificial signal drops caused by human body shadowing more heavily than rapid signal gains.
  5. **Kinematic Slew-Rate Limiter**: Restricts maximum distance displacement per 50ms cycle to human walking velocity ($\approx 1.6\text{ m/s}$).
  6. **Near-Field 0 cm Touch Curve Correction**: Smoothly blends distance down to $0.00\text{ m}$ when RSSI approaches saturation ($-43\text{ dBm}$), eliminating the traditional 18–21 cm floor.
- **Dedicated Target Testing Dashboard ("Focus Target")**:
  - Isolates a single selected beacon and hides all surrounding background devices.
  - Live distance telemetry formatted in **Meters (`m`)**, **Feet (`ft`)**, or **Inches (`in`)**.
  - Live SVG sparklines, real-time RSSI signal quality meters, and trend indicators (*Approaching*, *Stationary*, *Moving Away*).
- **Live Search & Strongest-First Sorting**:
  - Live search bar supporting queries by Device Name, MAC address, or full UUID.
  - Closest beacons with the strongest RSSI automatically prioritize to position #1.

---

## 🛰️ 3. 2-Beacon Indoor Positioning & Fusion

A dedicated 4-stage positioning engine fusing BLE trilateral intersection with continuous PDR dead reckoning:

### The 4-Stage Workflow:
1. **Stage 1 — Select Beacons**:
   - Auto-discovers nearby BLE beacons, identifies iBeacon payloads, and allows 1-tap assignment for **Beacon 1 (B1)** and **Beacon 2 (B2)**.
2. **Stage 2 — Place Beacons**:
   - Interactive SVG room map (default $18\text{ ft} \times 15\text{ ft}$, customizable up to $150\text{ ft}$).
   - Smooth `PanResponder` drag-and-drop beacon placement with live coordinates.
   - Quick placement presets: *Opposite Corners*, *Front Wall*, *Center Baseline*, or *Custom*.
   - **3D Height Slant-Range Correction**: Converts 3D direct-line distance to true 2D floor distance using phone height ($3.5\text{ ft}$) and beacon ceiling height ($9.0\text{ ft}$):
     $$d_{2D} = \sqrt{\max\left(0, d_{3D}^2 - (h_{\text{beacon}} - h_{\text{phone}})^2\right)}$$
3. **Stage 3 — Calibrate**:
   - Live 3-second RSSI sampling at exactly 1 meter distance for B1 and B2.
   - Automatic median calculation of calibrated $TxPower$ (defaults to $-59\text{ dBm}$).
   - Live adjustment of environmental path loss exponent ($n$, range $1.6 - 3.5$).
4. **Stage 4 — Position Test & Sensor Fusion**:
   - **Analytical 2-Circle Intersection Solver**: Solves circle intersections $C_1(x_1, y_1, r_1)$ and $C_2(x_2, y_2, r_2)$ using baseline clamping and movement-continuity perpendicular selection.
   - **Adaptive 2D Kalman Filter**:
     - **Prediction Step (Continuous)**: Uses PDR step vectors $(dx, dy)$ and dynamic stride length as high-rate continuous prediction.
     - **Innovation Residual Outlier Gating**: Calculates residual between raw BLE measurement and predicted position:
       $$\text{Residual} = \sqrt{(x_{\text{BLE}} - x_{\text{pred}})^2 + (y_{\text{BLE}} - y_{\text{pred}})^2}$$
       If $\text{Residual} > 12.0\text{ ft}$, the measurement is rejected as multi-path bounce.
     - **Measurement Update Step**: Fuses valid BLE positions with dynamic confidence scaling ($0.0 - 1.0$) based on signal geometry and GDOP.
   - **Dataset Export**: Download or share the complete benchmark trajectory as formatted **CSV** or **JSON** logs.

---

## ⚙️ 4. In-App Configuration Engine

Centralized runtime configuration accessible through the **⚙️ Settings** tab. Modify all core tuning parameters live without rebuilding or redeploying code:

- **BLE Parameters**: 1m TxPower ($-59\text{ dBm}$), Path Loss Exponent $n$ ($2.2$), Dead-Zone ($0.03\text{ m}$), Median Window size ($5$), One-Euro Min Cutoff ($0.35\text{ Hz}$), Beta ($0.06$).
- **Near-Field Touch Curve**: Saturation RSSI ($-43\text{ dBm}$), Near-field curve enable toggle.
- **PDR Parameters**: Weinberg coefficient $K$ ($0.74$), ZUPT stationary variance ($0.005\text{ g}^2$), Heel-strike peak threshold ($0.12\text{ g}$), Swing-phase valley threshold ($-0.09\text{ g}$), Cadence limits ($250\text{ ms} - 1600\text{ ms}$).
- **Room Dimensions**: Default Room Width ($18\text{ ft}$) and Room Height ($15\text{ ft}$).
- **Experimental RTT / Distance Panel**: Hardware turnaround offset ($50,000\text{ ns}$), Averaging window, Hampel outlier filter.

---

## 🔄 5. EAS Over-The-Air (OTA) Updates

- Built-in global **`OtaUpdateCard.js`** component.
- Background check against Expo Application Services (EAS) servers on app launch.
- Automatic download of updated JavaScript bundles with one-tap restart without re-installing native APKs.

---

## 📡 Hardware & Beacon Configuration (MOKO Smart H2)

If you are using the **MOKO Smart H2 Navigation Beacon** (or any generic BLE iBeacon), configure the following parameters using the official **BeaconX Pro** app (Google Play / Apple App Store):

```text
┌────────────────────────────────────────────────────────┐
│             MOKO H2 BEACON CONFIGURATION               │
├──────────────────────┬─────────────────────────────────┤
│ Parameter            │ Recommended Value               │
├──────────────────────┼─────────────────────────────────┤
│ Protocol Slot        │ Slot 1 -> iBeacon (Enabled)     │
│ UUID                 │ 29394DEC-BCFD-4464-A5FA-1370... │
│ Major                │ 1                               │
│ Minor                │ 1 (for B1) or 2 (for B2)        │
│ Adv Interval         │ 200ms or 250ms (4 - 5 Hz)       │
│ Radio Tx Power       │ 0 dBm                           │
│ Ranging Data (@ 1m)  │ -59 dBm (Include negative sign) │
│ Trigger Mode         │ OFF / Disabled (Continuous)     │
└──────────────────────┴─────────────────────────────────┘
```

> [!IMPORTANT]
> **Bluetooth Connection Rule:** BLE beacons stop broadcasting public advertising packets while an active connection is maintained. After configuring in BeaconX Pro, always tap **DISCONNECT** and swipe away the app before scanning in the PDR app.

> [!TIP]
> **Power Button States:**
> - **Power ON:** Press and hold button for 3 seconds $\rightarrow$ Red LED flashes rapidly 3–4 times.
> - **Power OFF:** Press and hold button for 3 seconds $\rightarrow$ Red LED illuminates solid for 3 seconds then shuts down.

---

## 📐 Mathematical & Algorithmic Formulations

### 1. Log-Distance Path Loss Model
$$\text{Distance} = 10^{\frac{\text{TxPower}_{1\text{m}} - \text{RSSI}}{10 \cdot n}}$$

### 2. Analytical 2-Circle Intersection
Given beacons at $B_1(x_1, y_1)$ with distance $r_1$, and $B_2(x_2, y_2)$ with distance $r_2$:
- Baseline distance: $d = \sqrt{(x_2 - x_1)^2 + (y_2 - y_1)^2}$
- Distance to chord intersection: $a = \frac{r_1^2 - r_2^2 + d^2}{2d}$
- Orthogonal chord offset: $h = \sqrt{\max(0, r_1^2 - a^2)}$
- Midpoint: $P_0 = B_1 + \frac{a}{d}(B_2 - B_1)$
- Intersection candidates:
  $$P_{1,2} = \left( x_0 \pm \frac{h}{d}(y_2 - y_1), \; y_0 \mp \frac{h}{d}(x_2 - x_1) \right)$$

### 3. Adaptive 2D Kalman Filter
- **State Vector**: $\mathbf{x}_k = [x, y, v_x, v_y]^T$
- **Prediction**: $\mathbf{x}_{k|k-1} = \mathbf{F} \mathbf{x}_{k-1} + \mathbf{B} \mathbf{u}_k$ where $\mathbf{u}_k = [dx_{\text{PDR}}, dy_{\text{PDR}}]^T$
- **Update**: $\mathbf{y}_k = \mathbf{z}_{\text{BLE}} - \mathbf{H} \mathbf{x}_{k|k-1}$
- **Kalman Gain**: $\mathbf{K}_k = \mathbf{P}_{k|k-1} \mathbf{H}^T (\mathbf{H} \mathbf{P}_{k|k-1} \mathbf{H}^T + \mathbf{R}_k)^{-1}$

---

## 📂 Project Directory Structure

```text
c:\Users\harsh.p\Desktop\Indoor Navigation\PDR_ExpoGo\
├── App.android.js                     # Main Android application hub & PDR step detector
├── App.ios.js                         # iOS application hub
├── App.js                             # Cross-platform entry router
├── PathStorage.js                     # Local AsyncStorage engine for recorded paths
├── app.json                           # Expo app configuration, bundle IDs, and permissions
├── eas.json                           # EAS Build & OTA update channel profiles
├── package.json                       # Dependencies (Expo SDK 54, React Native 0.81, BLE-PLX, SVG)
│
├── components/
│   ├── AppSettingsScreen.js           # Live in-app parameter tuning panel (⚙️ Settings tab)
│   ├── BeaconDebugPanel.js            # Real-time mathematical diagnostic panel
│   ├── BleDistanceRssiTestPanel.js    # Distance vs RSSI testing & scatter/time-series suite
│   ├── BleScannerSection.js           # Full BLE scanner, 1€ filter, search bar & focused mode
│   ├── CalibrationPanel.js            # 1-meter live RSSI calibration panel
│   ├── OtaUpdateCard.js               # Global EAS OTA update card
│   ├── TestAreaMap.js                 # Interactive SVG indoor room map with PanResponder
│   └── TwoBeaconPositionScreen.js     # 4-stage 2-Beacon Indoor Positioning wizard
│
├── hooks/
│   └── useTwoBeaconPositioning.js     # Master hook driving 10Hz calculation loop & sensor fusion
│
├── services/
│   ├── BleScannerService.js           # BLE native manager, iBeacon decoder, One-Euro filter
│   ├── RttRangingService.js           # RTT ranging simulation & hardware offset calibrator
│   ├── appSettingsStorage.js          # Persistent storage for live tuning settings
│   ├── beaconConfigStorage.js         # Configuration storage for 2-beacon map positions
│   └── twoBeaconServices.js           # Mathematical positioning models, 2-circle solver, Kalman
│
└── knowledge base/                    # Complete architectural and algorithm specifications
    ├── 01_architecture_file_connections_and_wireframes.md
    ├── 02_core_logic_algorithms_and_math.md
    └── 03_codebase_critique_and_improvements.md
```

---

## 🚀 Getting Started & Build Guide

### Prerequisites
- **Node.js**: v20.x or higher
- **Expo CLI**: `npx expo`
- **EAS CLI**: `npm install -g eas-cli`
- Android phone with Bluetooth 4.2+ and Location enabled.

### 1. Installation
```bash
git clone https://github.com/harshpanchal-241/Expo-GO.git
cd Expo-GO
npm install
```

### 2. Running in Native Development
Because `react-native-ble-plx` requires native Bluetooth LE code, native scanning must be run as a development build rather than standard Expo Go:
```bash
# Run directly on an Android device via USB debugging
npx expo run:android
```

### 3. Building Standalone Test APK with EAS
```bash
# Build internal preview APK via EAS Cloud
eas build --profile preview --platform android
```

### 4. Deploying Over-The-Air (OTA) Updates
To push updates directly to installed test devices without reinstalling the APK:
```bash
eas update --branch preview --message "Your release description"
```

---

## 📄 License
Internal research and development project for Indoor Navigation and Pedestrian Dead Reckoning.
