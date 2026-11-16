import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert
} from "react-native";

let Updates = null;
try {
  Updates = require("expo-updates");
} catch (e) {}

export default function OtaUpdateCard() {
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateStatusText, setUpdateStatusText] = useState("");

  const handleCheckForUpdate = async () => {
    if (!Updates || !Updates.checkForUpdateAsync) {
      Alert.alert(
        "EAS Updates",
        "OTA updates are active on EAS preview/production builds. In local development mode, changes reload automatically via the Metro bundler."
      );
      return;
    }

    try {
      setIsCheckingUpdate(true);
      setUpdateStatusText("Checking for latest OTA update...");
      const check = await Updates.checkForUpdateAsync();

      if (check.isAvailable) {
        setUpdateStatusText("Downloading new update...");
        await Updates.fetchUpdateAsync();
        setUpdateStatusText("Update downloaded. Reload to apply.");
        Alert.alert(
          "Update Downloaded! 🎉",
          "A new version of the app has been downloaded. Would you like to reload now to apply it?",
          [
            { text: "Later", style: "cancel" },
            {
              text: "Reload Now",
              onPress: async () => {
                await Updates.reloadAsync();
              }
            }
          ]
        );
      } else {
        setUpdateStatusText("App is already up to date!");
        Alert.alert("Up to Date", "Your app is currently running the latest available code.");
      }
    } catch (e) {
      console.warn("OTA update check error:", e);
      setUpdateStatusText("Update check completed.");
      Alert.alert("Update Check", e.message || "Failed to check for updates.");
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const runtimeVersion = (Updates && Updates.runtimeVersion) || "1.0.0";
  const channel = (Updates && Updates.channel) || "preview";

  return (
    <View style={s.otaBox}>
      <View style={{ flex: 1, paddingRight: 8 }}>
        <Text style={s.otaTitle}>Over-The-Air (OTA) Updates</Text>
        <Text style={s.otaSub}>
          {updateStatusText || `Runtime: ${runtimeVersion} • Channel: ${channel}`}
        </Text>
      </View>
      <Pressable
        onPress={handleCheckForUpdate}
        disabled={isCheckingUpdate}
        style={[s.otaBtn, isCheckingUpdate && { opacity: 0.6 }]}
      >
        {isCheckingUpdate ? (
          <ActivityIndicator size="small" color="#4d8dff" />
        ) : (
          <Text style={s.otaBtnText}>🔄 Check Update</Text>
        )}
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  otaBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#13161d",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#232834",
    padding: 14,
    marginTop: 6,
    marginBottom: 14
  },
  otaTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#f2f4f8"
  },
  otaSub: {
    fontSize: 11,
    color: "#9aa3b2",
    marginTop: 2
  },
  otaBtn: {
    backgroundColor: "transparent",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#4d8dff",
    alignItems: "center",
    justifyContent: "center"
  },
  otaBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#4d8dff"
  }
});
