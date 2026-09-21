import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { LineIcon } from "../src/components/LineIcon";
import { useHost } from "../src/store";
import { MIUIX_RADIUS, useTheme } from "../src/theme";
import { useI18n } from "../src/i18n";

interface ModelItem {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  vision: boolean;
}

// 全局模型列表内存缓存，跨会话秒级复用
let cachedModelsList: ModelItem[] = [];

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return hex;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export default function ModelSelectScreen() {
  const { id, currentModelId, targetKey } = useLocalSearchParams<{ id: string; currentModelId?: string; targetKey?: string }>();
  const { state, listModels, setModel } = useHost();
  const { theme } = useTheme();
  const { t } = useI18n();

  const session = (targetKey ? state.targetedSessions.get(targetKey) : undefined) ?? (id ? state.sessions.get(id) : undefined);
  const sessionModel = session?.model;
  const initialModelProvider = typeof sessionModel === "object" && sessionModel !== null && typeof (sessionModel as { provider?: unknown }).provider === "string"
    ? (sessionModel as { provider: string }).provider
    : undefined;
  const initialModel = currentModelId
    || (typeof sessionModel === "string" ? sessionModel : undefined)
    || (typeof sessionModel === "object" && sessionModel !== null && typeof (sessionModel as { id?: unknown }).id === "string" ? (sessionModel as { id: string }).id : "");

  const [availableModels, setAvailableModels] = useState<ModelItem[]>(cachedModelsList);
  const [selectedModelDraft, setSelectedModelDraft] = useState<string>(initialModel);
  const [selectedModelProvider, setSelectedModelProvider] = useState<string | undefined>(initialModelProvider);
  const [modelsLoading, setModelsLoading] = useState(cachedModelsList.length === 0);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const fetchModels = useCallback(async (forceRefresh = false) => {
    if (!id) return;
    if (!forceRefresh && cachedModelsList.length > 0) {
      setAvailableModels(cachedModelsList);
      setModelsLoading(false);
      return;
    }
    if (forceRefresh) setRefreshingModels(true);
    else setModelsLoading(true);
    try {
      const list = await listModels(id);
      cachedModelsList = list;
      setAvailableModels(list);
    } catch {
      // 忽略拉取错误
    } finally {
      setModelsLoading(false);
      setRefreshingModels(false);
    }
  }, [id, listModels]);

  useEffect(() => {
    void fetchModels(false);
  }, [fetchModels]);

  const handleApply = async () => {
    if (!id || !selectedModelDraft || applying) return;
    setApplying(true);
    try {
      const result = await setModel(id, selectedModelDraft, selectedModelProvider);
      if (!result?.ok) {
        setApplyError(result?.error ?? "无法切换模型");
        return;
      }
      setApplyError(null);
      router.back();
    } catch (error) {
      setApplyError(error instanceof Error && error.message ? error.message : "无法切换模型");
    } finally {
      setApplying(false);
    }
  };

  const filteredModels = (availableModels || []).filter((m) => {
    if (!modelSearchQuery.trim()) return true;
    const q = modelSearchQuery.toLowerCase();
    const idStr = String(m?.id ?? "").toLowerCase();
    const provStr = String(m?.provider ?? "").toLowerCase();
    const nameStr = String(m?.name ?? "").toLowerCase();
    return idStr.includes(q) || provStr.includes(q) || nameStr.includes(q);
  });

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg }]} edges={["top", "bottom"]}>
      {/* 顶部标题栏 */}
      <View style={[styles.header, { borderBottomColor: theme.border, backgroundColor: theme.headerBg }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="返回会话"
        >
          <LineIcon name="arrowLeft" size={20} color={theme.text} strokeWidth={2.4} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>
          {t.tabSessions === "会话" ? "选择会话模型" : "Select Session Model"}
        </Text>
        <TouchableOpacity
          onPress={handleApply}
          disabled={!selectedModelDraft || applying}
          style={[
            styles.applyBtn,
            {
              backgroundColor: theme.buttonPrimary,
              opacity: selectedModelDraft && !applying ? 1 : 0.4,
            },
          ]}
        >
          {applying ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.applyBtnText}>
              {t.tabSessions === "会话" ? "应用" : "Apply"}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {applyError ? (
        <Text style={{ color: theme.error, fontSize: 12, paddingHorizontal: 16, paddingTop: 8 }}>
          {applyError}
        </Text>
      ) : null}

      {/* 搜索框 */}
      <View style={[styles.searchRow, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <View style={{ marginLeft: 8 }}>
          <LineIcon name="search" size={16} color={theme.muted} />
        </View>
        <TextInput
          style={[styles.searchInput, { color: theme.text }]}
          placeholder={t.tabSessions === "会话" ? "搜索模型名称或厂商 (Gemini, Claude, GPT...)" : "Search model name or provider..."}
          placeholderTextColor={theme.dim}
          value={modelSearchQuery}
          onChangeText={setModelSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {modelSearchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setModelSearchQuery("")} style={{ padding: 6 }}>
            <LineIcon name="x" size={14} color={theme.muted} />
          </TouchableOpacity>
        )}
      </View>

      {/* 模型列表 */}
      {modelsLoading && availableModels.length === 0 ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={{ color: theme.muted, fontSize: 13, marginTop: 10 }}>正在检索可用模型列表...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredModels}
          keyExtractor={(m) => `${m.provider}/${m.id}`}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          keyboardShouldPersistTaps="handled"
          refreshing={refreshingModels}
          onRefresh={() => void fetchModels(true)}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={{ color: theme.muted, fontSize: 13 }}>未找到匹配的模型</Text>
              <TouchableOpacity
                onPress={() => void fetchModels(true)}
                style={[styles.retryBtn, { borderColor: theme.border }]}
              >
                <Text style={{ color: theme.accent, fontSize: 12 }}>重新加载</Text>
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item: m }) => {
            const isSelected = selectedModelDraft === m.id && (!selectedModelProvider || selectedModelProvider === m.provider);
            return (
              <TouchableOpacity
                style={[
                  styles.modelCard,
                  {
                    borderColor: isSelected ? theme.accent : theme.border,
                    backgroundColor: theme.cardBg,
                  },
                ]}
                onPress={() => { setSelectedModelDraft(m.id); setSelectedModelProvider(m.provider); }}
                activeOpacity={0.7}
              >
                <View style={styles.modelCardHeader}>
                  <Text style={[styles.modelCardTitle, { color: theme.text }]}>{m.name || m.id}</Text>
                  {isSelected && <LineIcon name="check" size={16} color={theme.accent} strokeWidth={2.4} />}
                </View>
                <Text style={[styles.modelCardProvider, { color: theme.muted }]}>{m.provider} · #{m.id}</Text>
                <View style={styles.modelCardTags}>
                  {m.reasoning && (
                    <View
                      style={[
                        styles.tagBadge,
                        {
                          backgroundColor: hexToRgba(theme.accent, 0.14),
                          borderColor: hexToRgba(theme.accent, 0.35),
                        },
                      ]}
                    >
                      <Text style={[styles.tagText, { color: theme.accent }]}>
                        ● {t.reasoningLabel}
                      </Text>
                    </View>
                  )}
                  {m.vision && (
                    <View
                      style={[
                        styles.tagBadge,
                        {
                          backgroundColor: "rgba(59, 130, 246, 0.14)",
                          borderColor: "rgba(59, 130, 246, 0.35)",
                        },
                      ]}
                    >
                      <Text style={[styles.tagText, { color: "#60A5FA" }]}>
                        ● {t.visionLabel}
                      </Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    padding: 6,
    marginRight: 8,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
  },
  applyBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: MIUIX_RADIUS.md,
    minWidth: 54,
    alignItems: "center",
    justifyContent: "center",
  },
  applyBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 6,
    borderRadius: MIUIX_RADIUS.md,
    borderWidth: 1,
    height: 38,
  },
  searchInput: {
    flex: 1,
    paddingHorizontal: 8,
    fontSize: 13,
  },
  loadingBox: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyBox: {
    alignItems: "center",
    paddingVertical: 48,
    gap: 8,
  },
  retryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: MIUIX_RADIUS.md,
    borderWidth: 1,
    marginTop: 8,
  },
  modelCard: {
    padding: 14,
    borderRadius: MIUIX_RADIUS.md,
    borderWidth: 1,
    gap: 4,
  },
  modelCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modelCardTitle: {
    fontSize: 13,
    fontWeight: "700",
  },
  modelCardProvider: {
    fontSize: 11,
    fontFamily: "monospace",
  },
  modelCardTags: {
    flexDirection: "row",
    gap: 6,
    marginTop: 4,
  },
  tagBadge: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: MIUIX_RADIUS.sm,
  },
  tagText: {
    fontSize: 10,
    fontFamily: "monospace",
    fontWeight: "600",
  },
});
