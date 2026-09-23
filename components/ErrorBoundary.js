import React from "react";
import { View, Text, StyleSheet, Pressable, ScrollView } from "react-native";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("[ErrorBoundary] Caught error:", error, errorInfo);
    this.setState({ errorInfo });
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <View style={styles.card}>
            <Text style={styles.icon}>⚠️</Text>
            <Text style={styles.title}>Something went wrong</Text>
            <Text style={styles.subtitle}>
              {this.props.fallbackMessage || "An unexpected error occurred in this view."}
            </Text>

            <View style={styles.errorBox}>
              <ScrollView style={{ maxHeight: 160 }}>
                <Text style={styles.errorText}>
                  {this.state.error?.message || String(this.state.error)}
                </Text>
              </ScrollView>
            </View>

            <Pressable style={styles.btn} onPress={this.handleReset}>
              <Text style={styles.btnText}>🔄 Reload View</Text>
            </Pressable>
          </View>
        </View>
      );
    } 

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: "#f6f8fa",
    justifyContent: "center",
    alignItems: "center",
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 20,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#d0d7de",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 3,
  },
  icon: {
    fontSize: 40,
    marginBottom: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: "800",
    color: "#cf222e",
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 13,
    color: "#57606a",
    textAlign: "center",
    marginBottom: 14,
  },
  errorBox: {
    width: "100%",
    backgroundColor: "#ffebe9",
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#ff8182",
    marginBottom: 16,
  },
  errorText: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#cf222e",
  },
  btn: {
    backgroundColor: "#0969da",
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: "center",
  },
  btnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 14,
  },
});
