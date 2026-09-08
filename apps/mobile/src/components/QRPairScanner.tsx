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
import { buildCandidateUrl } from "./ip-picker";

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
  // 多候选 IP 选择：扫到含 ips 列表的码后先弹选择（null = 不弹）
  const [pending, setPending] = useState<PairingInfo | null>(null);
  const [probing, setProbing] = useState(true);
  const [probeMap, setProbeMap] = useState<Map<string, "ok" | "fail" | "probing">>(new Map());
  const [pairError, setPairError] = useState<string | null>(null);

  const startProbing = (enriched: PairingInfo) => {
    setPending(enriched);
    setProbing(true);
    const map = new Map<string, "ok" | "fail" | "probing">();
    enriched.candidateIps.forEach((ip) => map.set(ip, "probing"));
    setProbeMap(new Map(map));
    void Promise.all(
      enriched.candidateIps.map(async (ip) => {
        const url = buildCandidateUrl(enriched, ip);
        const httpBase = url.replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");
        try {
          await fetch(`${httpBase}/api/health`, { signal: AbortSignal.timeout(2500) });
          map.set(ip, "ok");
        } catch {
          map.set(ip, "fail");
        }
        setProbeMap(new Map(map));
      }),
    ).finally(() => setProbing(false));
  };

  const handleBarcode = ({ data }: { data: string }) => {
    if (locked) return;
    const info = extractPairing(data);
    if (!info) return; // 非配对码，继续扫
    setLocked(true);

    // 两段式短码（v0.2.7）：GET /api/pair-short?code= 换取 {token, ips}
    if (info.shortCode) {
      void (async () => {
        try {
          const httpBase = info.hostUrl.replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");
          const res = await fetch(`${httpBase}/api/pair-short?code=${encodeURIComponent(info.shortCode!)}`, { signal: AbortSignal.timeout(2500) });
          if (!res.ok) throw new Error(`pair-short ${res.status}`);
          const d = (await res.json()) as { token: string; ips: string[]; port: number };
          const ips = (d.ips ?? []).filter((s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
          const enriched: PairingInfo = {
            ...info,
            token: d.token || undefined,
            candidateIps: ips.length > 0 ? ips : [new URL(info.hostUrl).hostname],
          };
          startProbing(enriched);
        } catch {
          // 短码换取失败（网络不通/过期）：仍弹层让用户看到候选与状态，不再静默直连
          setPairError("配对码换取失败（网络不可达或已过期），请确认手机与 PC 网络后重试");
          startProbing(info);
        }
      })();
      return;
    }

    // 旧格式（token 在 QR 里）：尝试拉候选，失败也弹层（可观测）
    void (async () => {
      let enriched = info;
      try {
        const httpBase = info.hostUrl.replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");
        const res = await fetch(`${httpBase}/api/pair-ips`, { signal: AbortSignal.timeout(2500) });
        if (res.ok) {
          const d = (await res.json()) as { ips?: string[] };
          const ips = (d.ips ?? []).filter((s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
          if (ips.length > 1) enriched = { ...info, candidateIps: ips.includes(new URL(info.hostUrl).hostname) ? ips : [new URL(info.hostUrl).hostname, ...ips] };
        }
      } catch { /* 拉取失败退化为单候选（0.2.3 旧 host） */ }
      if (enriched.candidateIps.length <= 1) {
        onScanned(enriched);
        return;
      }
      startProbing(enriched);
    })();
  };

  const chooseCandidate = (ip: string) => {
    if (!pending) return;
    const url = buildCandidateUrl(pending, ip);
    onScanned({ ...pending, hostUrl: url, displayHost: `${ip}:${pending.port}` });
    setPending(null);
    setProbing(false);
  };

  const close = () => {
    setLocked(false);
    setOpenError(null);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        {/* 多候选 IP 选择 sheet（绝对定位覆盖在相机上方） */}
        {pending ? (
          <View style={[styles.pickerSheet, { backgroundColor: theme.cardBg }]}>
            <Text style={[styles.pickerTitle, { color: theme.text }]}>选择要连接的地址</Text>
            {pairError ? <Text style={[styles.pickerHint, { color: theme.error }]}>{pairError}</Text> : null}
            <Text style={[styles.pickerHint, { color: theme.onBackgroundVariant ?? theme.muted }]}>
              绿点 = 已探测可达 · 红 = 不可达
            </Text>
            {pending.candidateIps.map((ip) => {
              const st = probeMap.get(ip) ?? "probing";
              const color = st === "ok" ? theme.success : st === "fail" ? theme.error : theme.muted;
              return (
                <TouchableOpacity
                  key={ip}
                  style={[styles.candRow, { borderColor: theme.border }]}
                  onPress={() => chooseCandidate(ip)}
                  accessibilityRole="button"
                  accessibilityLabel={`连接 ${ip}`}
                >
                  <View style={[styles.candDot, { backgroundColor: color }]} />
                  <Text style={[styles.candText, { color: theme.text }]}>{ip}:{pending.port}</Text>
                  <Text style={[styles.candTag, { color: theme.onBackgroundVariant ?? theme.muted }]}>
                    {ip.startsWith("100.") ? "VPN" : /^(198\.18|198\.19)\./.test(ip) ? "代理" : ip.startsWith("127.") ? "本机" : "局域网"}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {probing ? <Text style={[styles.pickerHint, { color: theme.muted }]}>探测中…</Text> : null}
            <TouchableOpacity style={[styles.cancelBtn, { borderColor: theme.border }]} onPress={() => { setPending(null); setLocked(false); }} accessibilityRole="button" accessibilityLabel="取消选择继续扫码">
              <Text style={{ color: theme.accent, fontWeight: "600" }}>返回继续扫码</Text>
            </TouchableOpacity>
          </View>
        ) : null}
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
    pickerSheet: { position: "absolute", left: MIUIX_SPACE.lg, right: MIUIX_SPACE.lg, bottom: MIUIX_SPACE.xxl, borderRadius: MIUIX_RADIUS.lg, padding: MIUIX_SPACE.lg },
    pickerTitle: { fontSize: MIUIX_TYPE.body1, fontWeight: "700", marginBottom: MIUIX_SPACE.xs },
    pickerHint: { fontSize: MIUIX_TYPE.footnote2, marginBottom: MIUIX_SPACE.md },
    candRow: { flexDirection: "row", alignItems: "center", gap: MIUIX_SPACE.md, borderWidth: 1, borderRadius: MIUIX_RADIUS.md, padding: MIUIX_SPACE.md, marginBottom: MIUIX_SPACE.sm },
    candDot: { width: 9, height: 9, borderRadius: MIUIX_RADIUS.pill },
    candText: { fontSize: MIUIX_TYPE.body2, fontWeight: "600", flex: 1 },
    candTag: { fontSize: MIUIX_TYPE.footnote2 },
    cancelBtn: { alignItems: "center", borderWidth: 1, borderRadius: MIUIX_RADIUS.md, paddingVertical: MIUIX_SPACE.md, marginTop: MIUIX_SPACE.xs },
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
