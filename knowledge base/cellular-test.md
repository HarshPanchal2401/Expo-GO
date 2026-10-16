# Cellular Test (experimental, isolated)

A proof of concept: read the cell tower the phone is connected to (Android), ask OpenCelliD where that **tower** is, and plot it. It is **not** wired into the positioning engines.

## What it is not
- OpenCelliD returns a **tower's** coordinates and a coverage range. It never returns the phone's position.
- With one tower there is no defensible phone position, so the screen always says "Phone position: none". No trilateration is claimed: a cell's range is a coverage estimate, not a distance to the phone.
- No GPS, Wi-Fi, IP location, BLE or PDR is used as a fallback.

## Files (all new, easy to remove)
| File | Role |
|---|---|
| `modules/cellular-info/` | Kotlin Expo module `CellularInfo`: `TelephonyManager` cells (LTE, NR, GSM, WCDMA→`UMTS`). Missing values are `null`, never 0. |
| `services/cellular/CellularTypes.js` | Normalise and validate identifiers, mask ids, build lookup parameters |
| `services/cellular/OpenCelliDService.js` | Lookup through the proxy: cache, de-duplication, timeout, call limits |
| `services/cellular/CellularPositioningEngine.js` | `getCellInfo`, `lookupCell`, `findLocation`, `startMonitoring`, `stopMonitoring`, `getStatus`, history |
| `services/cellular/CellularNative.js`, `index.js` | Optional native module, wiring, permission request |
| `services/cellular/CellularLocationUtils.js` | Distance, plot layout, `geo:` link |
| `components/v2/CellularPositioningScreen.js`, `CellularTowerMap.js` | The "📶 Cell" tab and the tower plot |
| `cellular-proxy/worker.mjs`, `README.md` | Cloudflare Worker that holds the API key |
| `tests/cellular.test.mjs` | 24 unit tests with fake data |

**The only existing file changed:** `App.android.js` (3 marked `[cellular-test]` additions: import, tab button, tab view). `App.ios.js`, the engines, BLE/PDR code, `app.json`, `eas.json` and `package.json` are unchanged. To remove the experiment, delete the files above and those 3 additions.

## Verified OpenCelliD API (wiki.opencellid.org)
`GET https://opencellid.org/cell/get` with `key`, `mcc`, `mnc`, `lac` (TAC for LTE/NR), `cellid`, optional `radio` (GSM, UMTS, LTE, NBIOT, NR, CDMA) and `format=json`. Answer: `lat`, `lon`, `range`, `samples`, `changeable`, `averageSignalStrength`, `radio`. Errors: 1 not found (HTTP 200), 2 key unknown (401), 3 invalid input (400), 5 server (500), 7 daily limit (429); some errors come as HTTP 200 text. **1,000 requests per day per key.** Data is CC BY-SA 4.0 (credit OpenCelliD when sharing).

## Build (no Android Studio needed)
- Native code **cannot** be delivered by `eas update`. A new APK build is required once:
  `npx eas build --platform android --profile preview` (internal APK, channel `preview`; use `--profile development` for a dev client).
- `app.json`: **no change**. `ACCESS_FINE_LOCATION` is already declared (Android requires location permission to show cell identifiers). The module autolinks from `modules/` on the cloud build. No new npm dependency.
- It does **not** work in Expo Go. In Expo Go, iOS and old APKs the tab shows "not in this build" (the module is loaded as optional, so an OTA update with this tab cannot crash an old APK; `runtimeVersion` stays `appVersion` 1.0.0).
- Multi-SIM: only the default `TelephonyManager` is read. Reading other SIMs needs `READ_PHONE_STATE`, which is not requested.

## Proxy (needs your OpenCelliD key)
See `cellular-proxy/README.md`. The key is a secret in the Worker's environment only. In the app: Cell tab → Proxy → address (+ optional token).

## Real-phone test procedure
Results are only real if they come from this procedure; the unit tests use fake data.
1. Install the new APK, open the **📶 Cell** tab, grant location permission, set the proxy.
2. At each position type a label and tap **Find Location**: outdoors (open sky), the building entrance, inside the office, and 2–3 different areas of the office (note the floor).
3. Per position record: the label (the app keeps time, radio, masked cell id, signal, lookup status, cache, latency, tower coordinates), and separately the **true position** (e.g. a pin dropped in a maps app).
4. Check: Is a serving cell reported indoors? Is the tower found in OpenCelliD (or "not in OpenCelliD")? How far is the tower from the true position (it is a tower distance, not a phone error; no phone error exists)? Does the serving cell change between positions?
5. Optionally Start Monitoring while walking in and out of the building: it reads every 10 s and looks up only a changed cell.
6. Share the history (screenshots) for review.

## Expected limits (honest assessment)
- A cell tower covers hundreds of metres to kilometres. Even a perfect lookup cannot locate a phone inside a 72 × 72 ft office; at best it says "this neighbourhood".
- Indoors, Android often reports only a cached or neighbour list; some cells are missing from OpenCelliD.
- So cellular data is unlikely to help indoor navigation positioning. The test measures that rather than assuming it.

## Status
- Verified in Node: 24 unit tests (identifier validation, cache, limits, errors, monitoring start/stop, proxy), screen renders with the module absent, Android / iOS / web bundles build, autolinking discovers the module.
- **Not verified:** the Kotlin module has not been compiled (no Android SDK on the dev PC; it compiles on the EAS cloud build) and nothing has run on a real phone. Success must not be claimed until step 1–4 above are done.
