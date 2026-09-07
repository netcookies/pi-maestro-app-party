/**
 * QRPairScanner — 配对二维码扫描弹层（expo-camera）
 *
 * 扫描 PC 终端 `/maestro-mobile qr` 输出的二维码：
 *   maestro-mobile://pair?ws=ws://<ip>:<port>/ws&token=<token>
 * 兼容裸 ws URL（ws://<ip>:<port>/ws?token=...）。
 * 扫描成功回调 onScanned({ hostUrl, token })，由调用方持久化并连接。
 */
import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Linking, ActivityIndicator } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useTheme, MIUIX_RADIUS, MIUIX_TYPE, MIUIX_SPACE } from "../theme";
import { LineIcon } from "./LineIcon";
import { extractPairing, type PairingInfo } from "../pairing";

export function QRPairScanner({ visible, onClose, onScanned }: {
  visible: boolean;
  onClose: () => void;
  onScanned: (info: PairingInfo) => void;
}) {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const [permission, requestPermission] = useCameraPermissions();
  const [locked, setLocked] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const handleBarcode = ({ data }: { data: string }) => {
    if (locked) return;
    const info = extractPairing(data);
    if (!info) return; // 非配对码，继续扫
    setLocked(true);
    onScanned(info);
  };

  const close = () => {
    setLocked(false);
    setOpenError(null);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={close} accessibilityRole="button" accessibilityLabel="关闭扫码">
            <LineIcon name="collapse" size={22} color={theme.text} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: theme.text }]}>扫描配对二维码</Text>
          <View style={{ width: 22 }} />
        </View>

        <View style={styles.cameraArea}>
          {!permission?.granted ? (
            <View style={styles.centerBox}>
              <Text style={[styles.hint, { color: theme.text }]}>需要相机权限来扫描配对码</Text>
              <Text style={[styles.hintSub, { color: theme.onBackgroundVariant ?? theme.muted }]}>
                二维码在 PC 终端执行 /maestro-mobile qr 后显示
              </Text>
              {permission?.canAskAgain === false ? (
                <TouchableOpacity
                  style={[styles.permBtn, { backgroundColor: theme.buttonPrimary }]}
                  onPress={() => void Linking.openSettings()}
                  accessibilityRole="button"
                  accessibilityLabel="打开系统设置授权相机"
                >
                  <Text style={styles.permBtnText}>去系统设置开启</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.permBtn, { backgroundColor: theme.buttonPrimary }]}
                  onPress={() => void requestPermission()}
                  accessibilityRole="button"
                  accessibilityLabel="授权相机"
                >
                  <Text style={styles.permBtnText}>授权相机</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View style={styles.cameraWrap}>
              <CameraView
                style={StyleSheet.absoluteFill}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={handleBarcode}
                onMountError={(e) => setOpenError(e.message ?? "相机启动失败")}
              />
              {/* 取景框 */}
              <View pointerEvents="none" style={styles.reticleOuter}>
                <View style={[styles.reticle, { borderColor: theme.accent }]} />
                <Text style={[styles.hintSub, { color: "#fff", marginTop: MIUIX_SPACE.lg }]}>对准 PC 终端上的二维码</Text>
              </View>
              {openError ? (
                <View style={styles.centerBox}>
                  <Text style={[styles.hint, { color: theme.error }]}>{openError}</Text>
                </View>
              ) : null}
            </View>
          )}
        </View>

        <View style={styles.footer}>
          <ActivityIndicator size="small" />
          <Text style={[styles.hintSub, { color: theme.onBackgroundVariant ?? theme.muted }]}>
            识别后自动填入地址并连接，无需手动输入 token
          </Text>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    container: { flex: 1 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: MIUIX_SPACE.lg,
      paddingTop: MIUIX_SPACE.xl,
      paddingBottom: MIUIX_SPACE.md,
    },
    title: { fontSize: MIUIX_TYPE.body1, fontWeight: "700" },
    cameraArea: { flex: 1, overflow: "hidden" },
    cameraWrap: { flex: 1 },
    centerBox: { flex: 1, alignItems: "center", justifyContent: "center", padding: MIUIX_SPACE.xl, gap: MIUIX_SPACE.sm },
    reticleOuter: { ...StyleSheet.absoluteFillObject as object, alignItems: "center", justifyContent: "center" },
    reticle: { width: 240, height: 240, borderWidth: 2, borderRadius: MIUIX_RADIUS.lg, opacity: 0.9 },
    hint: { fontSize: MIUIX_TYPE.body2, fontWeight: "600", textAlign: "center" },
    hintSub: { fontSize: MIUIX_TYPE.footnote1, textAlign: "center", paddingHorizontal: MIUIX_SPACE.xl },
    permBtn: { borderRadius: MIUIX_RADIUS.md, paddingHorizontal: MIUIX_SPACE.xl, paddingVertical: MIUIX_SPACE.md, marginTop: MIUIX_SPACE.md },
    permBtnText: { color: "#fff", fontWeight: "600", fontSize: MIUIX_TYPE.body2 },
    footer: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: MIUIX_SPACE.sm, paddingVertical: MIUIX_SPACE.lg },
  });
}
