/** Embedded camera view for scanning Maestro pairing QR codes. */
import React from "react";
import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { MIUIX_RADIUS, MIUIX_SPACE, MIUIX_TYPE, useTheme } from "../theme";
import { useI18n } from "../i18n";

export function QRPairScanner({ active = true, disabled = false, onScanned, onError }: {
  active?: boolean;
  disabled?: boolean;
  onScanned: (raw: string) => void;
  onError?: (message: string) => void;
}) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const styles = makeStyles();
  const [permission, requestPermission] = useCameraPermissions();

  if (!permission?.granted) {
    return (
      <View style={styles.centerBox}>
        <Text style={[styles.hint, { color: theme.text }]}>{t.cameraPermRequired}</Text>
        <Text style={[styles.hintSub, { color: theme.onBackgroundVariant ?? theme.muted }]}>{t.cameraPermHint}</Text>
        <TouchableOpacity
          style={[styles.permissionButton, { backgroundColor: theme.buttonPrimary }]}
          onPress={() => permission?.canAskAgain === false ? void Linking.openSettings() : void requestPermission()}
          accessibilityRole="button"
          accessibilityLabel={permission?.canAskAgain === false ? t.goToSettings : t.grantCamera}
        >
          <Text style={styles.permissionButtonText}>{permission?.canAskAgain === false ? t.goToSettings : t.grantCamera}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.cameraWrap}>
      <CameraView
        style={StyleSheet.absoluteFill}
        active={active && !disabled}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={disabled ? undefined : ({ data }) => onScanned(data)}
        onMountError={(event) => onError?.(event.message ?? "相机启动失败")}
      />
      <View pointerEvents="none" style={styles.reticleOuter}>
        <View style={[styles.reticle, { borderColor: theme.accent }]} />
        <Text style={styles.cameraHint}>{t.alignQrHint}</Text>
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
