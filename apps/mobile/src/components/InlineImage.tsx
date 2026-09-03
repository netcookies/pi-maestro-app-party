import React, { useState } from "react";
import {
  Image, Modal, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
} from "react-native";
import { useHost } from "../store";
import { imageUrlFor } from "../image-url";

/**
 * InlineImage — 渲染 tool 输出中的图片（缩略图 + 点击全屏预览）
 *
 * 图片通过 host 的 /api/file?path= 接口读取（安全校验：绝对路径+扩展名）。
 * 需要 host 地址构建 URL。
 */

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
  const imageUrl = imageUrlFor(host.hostUrl, path);

  if (!imageUrl) return null;

  return (
    <>
      <TouchableOpacity onPress={() => setPreview(true)} style={styles.thumbWrap}>
        {loading && <ActivityIndicator size="small" color="#58a6ff" />}
        <Image
          source={{ uri: imageUrl }}
          style={styles.thumb}
          resizeMode="contain"
          onLoadStart={() => setLoading(true)}
          onLoad={() => { setLoading(false); setFailed(false); }}
          onError={() => { setLoading(false); setFailed(true); }}
        />
        {failed && <Text style={styles.failed}>⚠ 图片加载失败</Text>}
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

const styles = StyleSheet.create({
  thumbWrap: {
    marginVertical: 6,
    alignSelf: "flex-start",
    maxWidth: 200,
    backgroundColor: "#0d1117",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#30363d",
    overflow: "hidden",
  },
  thumb: { width: 160, height: 120 },
  failed: { fontSize: 11, color: "#f85149", padding: 4 },
  previewOverlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.92)",
    justifyContent: "center", alignItems: "center", padding: 16,
  },
  previewClose: {
    position: "absolute", top: 60, right: 20, zIndex: 10,
    backgroundColor: "#21262d", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8,
  },
  previewCloseText: { color: "#e6edf3", fontWeight: "600", fontSize: 14 },
  previewImage: { width: "100%", height: "75%" },
  previewPath: { color: "#8b949e", fontSize: 12, marginTop: 12, textAlign: "center" },
});