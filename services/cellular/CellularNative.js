// The Android cell-info module (modules/cellular-info), loaded as OPTIONAL: in
// Expo Go, on iOS, or in an APK built before this module existed it is simply
// absent (isAvailable false) and the Cellular Test tab says so. No other part
// of the app imports this file.
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

const mod = Platform.OS === "android" ? requireOptionalNativeModule("CellularInfo") : null;

export const CellularNative = {
  isAvailable: Boolean(mod),
  getCellInfo: () => mod.getCellInfo(),
};
