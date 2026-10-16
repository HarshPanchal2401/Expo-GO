// Wires the real native module, fetch and storage into the Cellular Test
// engine. Import this only from the Cellular Test screen.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { PermissionsAndroid, Platform } from "react-native";
import { CellularNative } from "./CellularNative.js";
import { OpenCelliDService } from "./OpenCelliDService.js";
import { CellularPositioningEngine } from "./CellularPositioningEngine.js";

export const openCelliD = new OpenCelliDService({ fetchImpl: (...a) => fetch(...a), storage: AsyncStorage });

export const cellularEngine = new CellularPositioningEngine({
  native: CellularNative,
  service: openCelliD,
  storage: AsyncStorage,
});

/** Asks for the location permission Android requires to read cell identifiers. */
export async function requestCellularPermission() {
  if (Platform.OS !== "android") return false;
  const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
    title: "Location permission",
    message: "Android only shows cell tower identifiers to apps that have location permission. This test does not read GPS.",
    buttonPositive: "Allow",
  });
  return res === PermissionsAndroid.RESULTS.GRANTED;
}
