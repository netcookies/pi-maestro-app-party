/**
 * ChatComposer — 增强版输入栏
 *
 * 功能：
 *  - 文字输入 + 发送
 *  - 图片附加（相册/相机 → base64 → 随 prompt 发送）
 *  - 模型选择（list_models → 选择 → set_model）
 *  - Plan/Act 模式切换（发送指令让 agent 调用 plan 工具）
 *  - skill 联想（/ 触发，显示可用 skill，快速输入 /skill:name）
 *  - 思考等级切换
 */
import React, { useState, useRef, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, FlatList, Image, ScrollView,
} from "react-native";
import { useTheme } from "../theme";

export interface ComposerActions {
  send(text: string, images?: { data: string; mime: string }[]): Promise<void>;
  listModels?(): Promise<{ id: string; provider: string; name: string; reasoning: boolean; vision: boolean }[]>;
  setModel?(modelId: string): Promise<{ ok: boolean; error?: string }>;
  setThinking?(level: string): Promise<{ ok: boolean; error?: string }>;
  pickImage?(): Promise<{ data: string; mime: string } | null>;
  compact?(): Promise<{ ok: boolean; error?: string }>;
}

interface Props {
  actions: ComposerActions;
  /** 当前模型显示 */
  currentModel?: string;
  /** 发送中状态 */
  sending?: boolean;
  /** 可用 skills（名称或 {name, description} 对象列表） */
  skills?: (string | { name: string; description?: string })[];
  placeholder?: string;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function ChatComposer({ actions, currentModel, sending, skills = [], placeholder }: Props) {
  const { theme } = useTheme();
  const [text, setText] = useState("");
  const [images, setImages] = useState<{ data: string; mime: string }[]>([]);
  const [showModels, setShowModels] = useState(false);
  const [models, setModels] = useState<{ id: string; provider: string; name: string; reasoning: boolean; vision: boolean }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [showPlanPicker, setShowPlanPicker] = useState(false);

  const canSend = (text.trim().length > 0 || images.length > 0) && !sending;

  const handleSend = async () => {
    if (!canSend || !actions.send) return;
    const msg = text.trim();
    const imgs = images.length > 0 ? [...images] : undefined;
    setText("");
    setImages([]);
    await actions.send(msg, imgs);
  };

  const openModels = async () => {
    setShowModels(true);
    if (models.length > 0) return;
    setModelsLoading(true);
    try {
      const list = await actions.listModels?.() ?? [];
      setModels(list);
    } finally {
      setModelsLoading(false);
    }
  };

  const pickImage = async () => {
    const img = await actions.pickImage?.();
    if (img) setImages((prev) => [...prev, img]);
  };

  const switchModel = async (id: string) => {
    await actions.setModel?.(id);
    setShowModels(false);
  };

  const planActions = [
    { key: "plan", label: "📋 进入 Plan 模式", prompt: "请调用 plan 工具（action: enter）进入 Plan 模式。" },
    { key: "act", label: "⚡ 退出到 Act 模式", prompt: "请调用 plan 工具（action: exit）退出到 Act 模式。" },
    { key: "status", label: "📊 查看 Plan 状态", prompt: "请调用 plan 工具（action: status）查看当前 Plan 状态。" },
  ];

  return (
    <View style={[styles.container, { backgroundColor: theme.headerBg, borderTopColor: theme.border }]}>
      {/* 已附加图片预览 */}
      {images.length > 0 && (
        <ScrollView horizontal style={styles.imageStrip} showsHorizontalScrollIndicator={false}>
          {images.map((img, i) => (
            <View key={i} style={[styles.imageChip, { borderColor: theme.border }]}>
              <Image source={{ uri: `data:${img.mime};base64,${img.data}` }} style={styles.imageThumb} />
              <TouchableOpacity
                style={styles.imageRemove}
                onPress={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <Text style={styles.imageRemoveText}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      {/* skill 弹窗（带搜索条） */}
      <Modal visible={showSkills} transparent animationType="fade" onRequestClose={() => setShowSkills(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Skills</Text>
              <TouchableOpacity onPress={() => setShowSkills(false)}><Text style={[styles.modalClose, { color: theme.muted }]}>✕</Text></TouchableOpacity>
            </View>
            <TextInput
              style={[styles.skillSearch, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
              value={skillQuery}
              onChangeText={setSkillQuery}
              placeholder="Search skills..."
              placeholderTextColor={theme.dim}
              autoCapitalize="none"
              autoFocus
            />
            <FlatList
              data={skills
                .map((s) => (typeof s === "string" ? { name: s, description: undefined } : s))
                .filter((s) => s.name.toLowerCase().includes(skillQuery.toLowerCase()))}
              keyExtractor={(s) => s.name}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.skillItem, { borderBottomColor: theme.border }]}
                  onPress={() => { setText(`/skill:${item.name} `); setShowSkills(false); }}
                >
                  <Text style={[styles.skillName, { color: theme.text }]} numberOfLines={1}>
                    /skill:{item.name}
                  </Text>
                  {item.description ? (
                    <Text style={[styles.skillDesc, { color: theme.muted }]} numberOfLines={1}>
                      {item.description}
                    </Text>
                  ) : null}
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={[styles.modalEmpty, { color: theme.muted }]}>No skills found</Text>
              }
              style={{ maxHeight: 340 }}
            />
          </View>
        </View>
      </Modal>

      {/* 工具行（图标 + 英文文字） */}
      <View style={styles.toolbar}>
        <TouchableOpacity onPress={openModels} style={styles.toolBtn}>
          <Text style={[styles.toolIcon, { color: theme.muted }]}>🧠</Text>
          <Text style={[styles.toolLabel, { color: theme.muted }]}>Model</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowThinking(true)} style={styles.toolBtn}>
          <Text style={[styles.toolIcon, { color: theme.muted }]}>⚡</Text>
          <Text style={[styles.toolLabel, { color: theme.muted }]}>Think</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowPlanPicker(true)} style={styles.toolBtn}>
          <Text style={[styles.toolIcon, { color: theme.muted }]}>📋</Text>
          <Text style={[styles.toolLabel, { color: theme.muted }]}>Plan</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={async () => { await actions.compact?.(); }}
          style={styles.toolBtn}
        >
          <Text style={[styles.toolIcon, { color: theme.muted }]}>🗜</Text>
          <Text style={[styles.toolLabel, { color: theme.muted }]}>Compact</Text>
        </TouchableOpacity>
        <Text style={[styles.modelLabel, { color: theme.dim }]} numberOfLines={1}>
          {currentModel ?? "no model"}
        </Text>
      </View>

      <View style={styles.inputRow}>
        {/* 附件按钮（输入框左侧）：发送图片 */}
        <TouchableOpacity onPress={pickImage} style={styles.attachBtn}>
          <Text style={[styles.toolIcon, { color: theme.accent }]}>📎</Text>
        </TouchableOpacity>
        <TextInput
          style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
          value={text}
          onChangeText={setText}
          placeholder={placeholder ?? "Message..."}
          placeholderTextColor={theme.dim}
          multiline
          maxLength={4000}
        />
        {/* / 按钮：弹 skill 弹窗 */}
        <TouchableOpacity
          onPress={() => setShowSkills(true)}
          style={[styles.slashBtn, { borderColor: theme.border }]}>
          <Text style={[styles.slashText, { color: theme.accent }]}>/</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.sendButton, { backgroundColor: canSend ? theme.buttonPrimary : theme.border }]}
          onPress={() => void handleSend()}
          disabled={!canSend}
        >
          <Text style={styles.sendText}>{sending ? "…" : "Send"}</Text>
        </TouchableOpacity>
      </View>

      {/* 模型选择 Modal */}
      <Modal visible={showModels} transparent animationType="slide" onRequestClose={() => setShowModels(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>选择模型</Text>
              <TouchableOpacity onPress={() => setShowModels(false)}><Text style={[styles.modalClose, { color: theme.muted }]}>✕</Text></TouchableOpacity>
            </View>
            {modelsLoading ? (
              <Text style={[styles.modalEmpty, { color: theme.muted }]}>加载中...</Text>
            ) : (
              <FlatList
                data={models}
                keyExtractor={(m) => `${m.provider}/${m.id}`}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={[styles.modelItem, { borderBottomColor: theme.border }]}
                    onPress={() => void switchModel(item.id)}
                  >
                    <Text style={[styles.modelName, { color: theme.text }]}>{item.name}</Text>
                    <View style={styles.modelMeta}>
                      <Text style={[styles.modelProvider, { color: theme.muted }]}>{item.provider}</Text>
                      {item.vision && <Text style={[styles.modelBadge, { color: theme.success }]}>👁 视觉</Text>}
                      {item.reasoning && <Text style={[styles.modelBadge, { color: theme.accent }]}>🧠 推理</Text>}
                    </View>
                  </TouchableOpacity>
                )}
                style={{ maxHeight: 400 }}
              />
            )}
          </View>
        </View>
      </Modal>

      {/* 思考等级 Modal */}
      <Modal visible={showThinking} transparent animationType="fade" onRequestClose={() => setShowThinking(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>思考等级</Text>
            {THINKING_LEVELS.map((lv) => (
              <TouchableOpacity
                key={lv}
                style={[styles.modelItem, { borderBottomColor: theme.border }]}
                onPress={async () => { await actions.setThinking?.(lv); setShowThinking(false); }}
              >
                <Text style={[styles.modelName, { color: theme.text }]}>{lv}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>

      {/* Plan 模式 Modal */}
      <Modal visible={showPlanPicker} transparent animationType="fade" onRequestClose={() => setShowPlanPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Plan / Act 模式</Text>
            {planActions.map((p) => (
              <TouchableOpacity
                key={p.key}
                style={[styles.modelItem, { borderBottomColor: theme.border }]}
                onPress={async () => {
                  setShowPlanPicker(false);
                  await actions.send(p.prompt);
                }}
              >
                <Text style={[styles.modelName, { color: theme.text }]}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderTopWidth: 1, paddingTop: 4 },
  imageStrip: { flexDirection: "row", paddingHorizontal: 10, paddingVertical: 6 },
  imageChip: { borderWidth: 1, borderRadius: 8, marginRight: 8, padding: 2, position: "relative" },
  imageThumb: { width: 56, height: 56, borderRadius: 6 },
  imageRemove: { position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 9, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center" },
  imageRemoveText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  skillPopup: { marginHorizontal: 10, marginBottom: 4, borderRadius: 8, borderWidth: 1, padding: 8 },
  skillTitle: { fontSize: 11, marginBottom: 6, fontWeight: "600" },
  skillItem: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  skillName: { fontSize: 13, fontWeight: "600" },
  skillDesc: { fontSize: 11, marginTop: 2 },
  skillSearch: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    marginBottom: 8,
  },
  attachBtn: { paddingHorizontal: 4, paddingVertical: 10 },
  slashBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 4,
  },
  slashText: { fontSize: 18, fontWeight: "700" },
  toolBtn: { alignItems: "center", paddingHorizontal: 8, paddingVertical: 2 },
  toolLabel: { fontSize: 10, marginTop: 1 },
  toolbar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 4 },
  toolIcon: { fontSize: 18 },
  modelLabel: { flex: 1, fontSize: 11, textAlign: "right", marginLeft: 8 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 10, paddingBottom: 8, gap: 8 },
  input: { flex: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, fontSize: 15, maxHeight: 120 },
  sendButton: { borderRadius: 8, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  modalSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: 1, padding: 16, maxHeight: 480 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  modalTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  modalClose: { fontSize: 16, padding: 4 },
  modalEmpty: { textAlign: "center", padding: 20 },
  modelItem: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  modelName: { fontSize: 14, fontWeight: "600" },
  modelMeta: { flexDirection: "row", gap: 8, marginTop: 2 },
  modelProvider: { fontSize: 11 },
  modelBadge: { fontSize: 11 },
});