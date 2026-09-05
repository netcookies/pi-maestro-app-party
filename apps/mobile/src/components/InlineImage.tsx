import React, { useState, useMemo } from "react";
import {
  Image, Modal, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
} from "react-native";
import { useHost } from "../store";
import { useTheme } from "../../src/theme";
import { imageUrlFor } from "../image-url";

/**
 * InlineImage — 渲染 tool 输出中的图片（缩略图 + 点击全屏预览）
 *
 * 图片通过 host 的 /api/file?path= 接口读取（安全校验：绝对路径+扩展名）。
 * 需要 host 地址构建 URL。
 */
interface Props {
  path: string;
}

export function InlineImage({ path }: Props) {
  const [preview, setPreview] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const host = useHost();
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const imageUrl = imageUrlFor(host.hostUrl, path);

  if (!imageUrl) return null;

  return (
    <>
      <TouchableOpacity onPress={() => setPreview(true)} style={styles.thumbWrap}>
        {loading && <ActivityIndicator size="small" color={theme.accent} />}
        <Image
          source={{ uri: imageUrl }}
          style={styles.thumb}
          resizeMode="contain"
          onLoadStart={() => setLoading(true)}
          onLoad={() => { setLoading(false); setFailed(false); }}
          onError={() => { setLoading(false); setFailed(true); }}
        />
        {failed && <Text style={styles.failed}>图片加载失败</Text>}
      </TouchableOpacity>

      <Modal visible={preview} transparent animationType="fade" onRequestClose={() => setPreview(false)}>
        <View style={styles.previewOverlay}>
          <TouchableOpacity style={styles.previewClose} onPress={() => setPreview(false)}>
            <Text style={styles.previewCloseText}>✕ 关闭</Text>
          </TouchableOpacity>
          <Image
            source={{ uri: imageUrl }}
            style={styles.previewImage}
            resizeMode="contain"
          />
          <Text style={styles.previewPath} numberOfLines={2}>{path}</Text>
        </View>
      </Modal>
    </>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    thumbWrap: {
      marginVertical: 6,
      alignSelf: "flex-start",
      maxWidth: 200,
      backgroundColor: theme.toolBubble,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.border,
      overflow: "hidden",
    },
    thumb: { width: 160, height: 120 },
    failed: { fontSize: 11, color: theme.error, padding: 4 },
    previewOverlay: {
      flex: 1, backgroundColor: "rgba(0,0,0,0.92)",
      justifyContent: "center", alignItems: "center", padding: 16,
    },
    previewClose: {
      position: "absolute", top: 60, right: 20, zIndex: 10,
      backgroundColor: theme.cardBg, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8,
    },
    previewCloseText: { color: theme.text, fontWeight: "600", fontSize: 14 },
    previewImage: { width: "100%", height: "75%" },
    previewPath: { color: theme.muted, fontSize: 12, marginTop: 12, textAlign: "center" },
  });
}