/** Embedded camera view for scanning Maestro pairing QR codes. */
import React from "react";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE, useTheme } from "../theme";

export function QRPairScanner({ disabled = false, onScanned, onError }: {
  disabled?: boolean;
  onScanned: (raw: string) => void;
  onError?: (message: string) => void;
}) {
  const { theme } = useTheme();
  const styles = makeStyles();
  const [permission, requestPermission] = useCameraPermissions();

  if (!permission?.granted) {
    return (
      <View style={styles.centerBox}>
        <Text style={[styles.hint, { color: theme.text }]}>需要相机权限来扫描配对码</Text>
        <Text style={[styles.hintSub, { color: theme.onBackgroundVariant ?? theme.muted }]}>二维码在 PC 终端执行 /maestro-mobile qr 后显示</Text>
        <TouchableOpacity
          style={[styles.permissionButton, { backgroundColor: theme.buttonPrimary }]}
          onPress={() => permission?.canAskAgain === false ? void Linking.openSettings() : void requestPermission()}
          accessibilityRole="button"
          accessibilityLabel={permission?.canAskAgain === false ? "打开系统设置授权相机" : "授权相机"}
        >
          <Text style={styles.permissionButtonText}>{permission?.canAskAgain === false ? "去系统设置开启" : "授权相机"}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.cameraWrap}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={disabled ? undefined : ({ data }) => onScanned(data)}
        onMountError={(event) => onError?.(event.message ?? "相机启动失败")}
      />
      <View pointerEvents="none" style={styles.reticleOuter}>
        <View style={[styles.reticle, { borderColor: theme.accent }]} />
        <Text style={styles.cameraHint}>对准 PC 终端上的二维码</Text>
      </View>
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
    cameraWrap: { flex: 1, overflow: "hidden" },
    centerBox: { flex: 1, alignItems: "center", justifyContent: "center", padding: MIUIX_SPACE.xl, gap: MIUIX_SPACE.sm },
    hint: { fontSize: MIUIX_TYPE.body2, fontWeight: "600", textAlign: "center" },
    hintSub: { fontSize: MIUIX_TYPE.footnote1, textAlign: "center", paddingHorizontal: MIUIX_SPACE.xl },
    permissionButton: { borderRadius: MIUIX_RADIUS.md, paddingHorizontal: MIUIX_SPACE.xl, paddingVertical: MIUIX_SPACE.md, marginTop: MIUIX_SPACE.md },
    permissionButtonText: { color: "#fff", fontWeight: "600", fontSize: MIUIX_TYPE.body2 },
    reticleOuter: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
    reticle: { width: 240, height: 240, borderWidth: 2, borderRadius: MIUIX_RADIUS.lg, opacity: 0.9 },
    cameraHint: { color: "#fff", fontSize: MIUIX_TYPE.footnote1, textAlign: "center", marginTop: MIUIX_SPACE.lg },
  });
}
