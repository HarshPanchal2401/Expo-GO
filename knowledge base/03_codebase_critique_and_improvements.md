# 03. Codebase Critique, Technical Audit & Engineering Roadmap

This document provides an engineering critique of the indoor navigation codebase, highlighting recent architectural accomplishments, identifying remaining technical debt, and detailing the future roadmap.

---

## 1. Architectural Accomplishments & Resolved Debt

The following table summarizes recent engineering improvements that resolved critical bottlenecks:

| Previous Limitation | Root Cause | Engineering Solution Implemented | Status |
| :--- | :--- | :--- | :--- |
| **Anonymous iBeacon Filtering** | Standard iBeacons broadcast raw manufacturer data without a text name. Toggling "Named Only" rendered them invisible. | Implemented [`parseBeaconPayload()`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/BleScannerService.js) in `BleScannerService.js`. Decodes Apple Company ID, 16-byte UUID, Major, Minor, and TxPower. Automatically tags and names devices. | ✅ **RESOLVED** |
| **Close-Contact Signal Dropping** | Outlier filter clamped at `RSSI > -15 dBm`. When testing close to the beacon (<20 cm), RSSI reaches $-10$ to $-14\text{ dBm}$, causing every packet to drop. | Widened upper outlier clamp from $-15\text{ dBm}$ to **`-5 dBm`** across `BleScannerService.js` and `twoBeaconServices.js`. | ✅ **RESOLVED** |
| **Hardcoded Physical Constants** | Physical parameters (TxPower, path loss $n$, One-Euro filter cutoff/beta, room dimensions, Weinberg $K$) were static in code. | Built [`AppSettingsScreen.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/components/AppSettingsScreen.js) and [`services/appSettingsStorage.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/appSettingsStorage.js) with live AsyncStorage subscriptions, allowing in-app tuning without recompilation. | ✅ **RESOLVED** |
| **18–21 cm Near-Field Distance Floor** | Receiver saturation occurs around $-43\text{ dBm}$, which path-loss formulas calculate to $\approx 0.20\text{ m}$ even when touching the beacon. | Designed a polynomial **Near-Field Touch Curve** that smoothly attenuates estimated distance down to $0.00\text{ m}$ between $-50\text{ dBm}$ and $-43\text{ dBm}$. | ✅ **RESOLVED** |
| **Beacon Discovery Discovery Order** | Devices were sorted strictly by calculated distance. If distance was initializing, devices were placed at the very bottom of long device lists. | Updated sorting in `BleScannerSection.js` to prioritize **strongest RSSI first**, ensuring beacons near the phone immediately jump to position #1. Added live Search Bar. | ✅ **RESOLVED** |

---

## 2. Technical Audit: Current Strengths & Remaining Debt

### 2.1 Architectural Strengths
1. **Steady 60 FPS UI Rendering**: Using mutable `useRef` instances for 50 Hz accelerometer sampling and 10 Hz positioning loops keeps React state updates decoupled from high-frequency numerical routines.
2. **Resilient Signal Processing**: The combination of median filtering (eliminating 3-channel hopping spikes), One-Euro filtering (eliminating stationary jitter), and asymmetric EMA produces smooth physical distances.
3. **Loop Closure Drift Correction**: Linear drift error distribution across recorded waypoints allows closed-circuit paths to re-center cleanly at $(0,0)$.

---

### 2.2 Remaining Technical Debt & Bottlenecks

#### Issue 1: Component Size & Monolithic Structure
* **File Locations**:
  * [`components/BleScannerSection.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/components/BleScannerSection.js): **~2,280 lines**
  * [`components/TwoBeaconPositionScreen.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/components/TwoBeaconPositionScreen.js): **~1,715 lines**
  * [`App.android.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js): **~905 lines**
* **Impact**: These components manage multiple concerns simultaneously: Bluetooth lifecycle subscriptions, permission checks, timer intervals, SVG canvas rendering, and extensive styling.
* **Refactoring Recommendation**: Decompose into smaller, single-responsibility components:
  * `BleDeviceList.js`, `BleDeviceCard.js`, `BleFocusedDashboard.js`.
  * `SelectBeaconsStage.js`, `PlaceBeaconsStage.js`, `CalibrateStage.js`, `PositionTestStage.js`.

#### Issue 2: Platform Feature Divergence (iOS vs Android)
* **Status**: [`App.android.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.android.js) includes all four tabs (`pdr`, `ble`, `beacon`, `settings`). [`App.ios.js`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/App.ios.js) does not yet include the 2-Beacon module tab.
* **Refactoring Recommendation**: Consolidate `App.android.js` and `App.ios.js` into a unified `App.js` root, abstracting platform-specific Bluetooth and motion sensor differences into custom hooks (`usePlatformSensors.js`).

---

## 3. Mathematical & Algorithmic Roadmap

### 3.1 Resolving the Two-Beacon Baseline Singularity
* **Limitation**: Two-beacon trilateration mathematically yields two symmetric intersection points across the baseline. When a user walks near the baseline connecting the two beacons ($a \approx D/2, h \approx 0$), small RSSI noise causes the intersection point to flip across the baseline.
* **Proposed Enhancement (3+ Beacon Multilateration)**:
  Upgrade from 2-beacon intersection to $N$-beacon non-linear least-squares (Levenberg-Marquardt) solver:
  $$\hat{\mathbf{x}} = \arg\min_{\mathbf{x}} \sum_{i=1}^{N} w_i \cdot \left(\|\mathbf{x} - \mathbf{b}_i\| - d_i\right)^2$$
  With $N \ge 3$, geometric reflection ambiguity is completely eliminated.

### 3.2 6-State Extended Kalman Filter (EKF)
* **Current Filter**: [`AdaptiveKalman2D`](file:///c:/Users/harsh.p/Desktop/Indoor%20Navigation/PDR_ExpoGo/services/twoBeaconServices.js) tracks only 2D position $[x, y]^T$.
* **Proposed Filter**: Upgrade to a 6-state vector:
  $$\mathbf{x} = [x, \; y, \; v_x, \; v_y, \; \theta, \; b_\theta]^T$$
  Tracking velocity $[v_x, v_y]$ and heading gyro bias $b_\theta$ directly inside the state covariance matrix improves prediction accuracy across long walking corridors.

### 3.3 Dynamic Magnetic Disturbance Rejection
* **Limitation**: Indoor structural steel and high-voltage wiring cause magnetic declination shifts of $\pm 30^\circ$ to $\pm 60^\circ$.
* **Proposed Enhancement**: Compute the magnetic field magnitude norm $\|\vec{B}\| = \sqrt{B_x^2 + B_y^2 + B_z^2}$. When $\|\vec{B}\|$ deviates from the local geomagnetic baseline ($45 - 55\text{ }\mu\text{T}$), automatically downweight the magnetometer and rely on high-frequency gyroscope integration.

---

## 4. Phase-by-Phase Execution Roadmap

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ENGINEERING ROADMAP MILESTONES                        │
└─────────────────────────────────────────────────────────────────────────────┘

  PHASE 1: Code Modernization & File Decomposition (Completed / In Progress)
  ├── [x] Automated iBeacon / Eddystone payload decoding & tag display
  ├── [x] In-app settings engine (AppSettingsScreen.js) for live parameter tuning
  ├── [x] Near-field 0cm touch curve correction
  ├── [x] Live search & strongest-first RSSI sorting
  └── [ ] Split monolithic BleScannerSection.js and TwoBeaconPositionScreen.js

  PHASE 2: Platform Unification
  ├── [ ] Unify App.android.js and App.ios.js into a shared component tree
  ├── [ ] Enable 2-Beacon module on iOS
  └── [ ] Implement automated Jest unit tests for coordinate & filter math

  PHASE 3: Multilateration & Advanced Sensor Fusion
  ├── [ ] Multi-beacon support (3 to 6 beacons simultaneously)
  ├── [ ] Levenberg-Marquardt non-linear least-squares solver
  ├── [ ] 6-State Extended Kalman Filter (Position + Velocity + Heading Bias)
  └── [ ] Magnetic anomaly rejection filter using ||B|| flux gate

  PHASE 4: Floorplan Mapping & Enterprise Features
  ├── [ ] Import custom architectural floorplans (GeoJSON / SVG)
  ├── [ ] Wall collision constraints (Particle Filter / Raycasting)
  └── [ ] Cloud trajectory logging & analytics dashboard
```
