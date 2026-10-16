# cellular-info (experimental, Android only)

Local Expo module for the **Cellular Test** tab. It only READS what Android's
`TelephonyManager` reports about the serving and neighbouring cells. It does not
use GPS, Wi-Fi or any network, and nothing else in the app imports it.

- `getCellInfo()` -> `{ hasTelephony, permissionGranted, locationServicesOn, simState,
  operatorName, operator, apiLevel, cells: [{ radio, registered, mcc, mnc, areaCode,
  cellId, pci, signalDbm, ageMs, supported }], error? }`
- Missing or invalid values (`Int.MAX_VALUE`) are returned as `null`, never as 0.
- Needs `ACCESS_FINE_LOCATION` (already in app.json) granted at runtime.
- Autolinked from `modules/` on `expo prebuild` / EAS Build. NOT available in Expo Go.

To remove the experiment: delete this folder, `services/cellular/`,
`components/v2/Cellular*.js`, `cellular-proxy/`, `tests/cellular.test.mjs`, and the
3 marked lines in `App.android.js`.
