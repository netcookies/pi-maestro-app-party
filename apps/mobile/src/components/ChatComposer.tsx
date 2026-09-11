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
  Animated, AccessibilityInfo,
} from "react-native";
import { useTheme } from "../theme";
import { LineIcon } from "./LineIcon";

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
  const [focused, setFocused] = useState(false);
  const [fullscreenEdit, setFullscreenEdit] = useState(false);
  const [fsPanel, setFsPanel] = useState<null | "models" | "thinking" | "plan" | "skills">(null);

  // reduce-motion：系统开启时动画直接置终值，不播动画
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (alive) setReduceMotion(v); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { alive = false; sub.remove(); };
  }, []);

  // fsPanel 内嵌面板进出场（RN 内置 Animated）
  const panelAnim = useRef(new Animated.Value(0)).current;
  const panelCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fsPanel === null) return;
    // 重新打开时取消尚未落地的退场卸载，避免把刚打开的面板清掉
    if (panelCloseTimer.current !== null) {
      clearTimeout(panelCloseTimer.current);
      panelCloseTimer.current = null;
    }
    if (reduceMotion) { panelAnim.setValue(1); return; }
    panelAnim.setValue(0);
    Animated.timing(panelAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, [fsPanel, reduceMotion, panelAnim]);

  useEffect(() => () => {
    if (panelCloseTimer.current !== null) clearTimeout(panelCloseTimer.current);
  }, []);

  // 退场：先 timing 到 0，200ms 后再清 state 卸载面板
  const closeFsPanel = () => {
    if (reduceMotion) { setFsPanel(null); return; }
    Animated.timing(panelAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    if (panelCloseTimer.current !== null) clearTimeout(panelCloseTimer.current);
    panelCloseTimer.current = setTimeout(() => { panelCloseTimer.current = null; setFsPanel(null); }, 200);
  };

  const canSend = (text.trim().length > 0 || images.length > 0) && !sending;

  // 发送失败时恢复草稿；actions.send 在 session 侧已 catch 不一定 reject，这里防御性兜底
  const handleSend = async () => {
    if (!canSend || !actions.send) return;
    const msg = text.trim();
    const imgs = [...images];
    setText("");
    setImages([]);
    try {
      await actions.send(msg, imgs.length > 0 ? imgs : undefined);
    } catch {
      setText(msg);
      setImages(imgs);
    }
  };

  const openModels = async () => {
    setShowModels(true);
    if (models.length > 0) return;
    setModelsLoading(true);
    try {
      const list = await actions.listModels?.() ?? [];
      setModels(list);
    } catch {
      // P2-9：拉取失败不再抛未处理 rejection，清空列表并收起面板
      setModels([]);
      setShowModels(false);
    } finally {
      setModelsLoading(false);
    }
  };

  // 全屏 Model 面板加载/重试共用
  const loadModels = () => {
    setModelsLoading(true);
    actions.listModels?.().then(setModels).catch(() => {}).finally(() => setModelsLoading(false));
  };

  const pickImage = async () => {
    const img = await actions.pickImage?.();
    if (img) setImages((prev) => [...prev, img]);
  };

  const [modelError, setModelError] = useState<string | null>(null);

  const switchModel = async (id: string) => {
    try {
      const r = await actions.setModel?.(id);
      if (r && !r.ok) {
        // P2-9：切换失败给出轻提示而非静默
        setModelError(r.error ?? "切换失败");
        setTimeout(() => setModelError(null), 3000);
        return;
      }
      setShowModels(false);
    } catch {
      setModelError("切换失败（连接异常）");
      setTimeout(() => setModelError(null), 3000);
    }
  };

  const planActions = [
    { key: "plan", label: "进入 Plan 模式", prompt: "请调用 plan 工具（action: enter）进入 Plan 模式。" },
    { key: "act", label: "退出到 Act 模式", prompt: "请调用 plan 工具（action: exit）退出到 Act 模式。" },
    { key: "status", label: "查看 Plan 状态", prompt: "请调用 plan 工具（action: status）查看当前 Plan 状态。" },
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
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityRole="button"
                accessibilityLabel="移除图片"
                onPress={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <Text style={styles.imageRemoveText}>
                  <LineIcon name="x" size={10} color="#fff" strokeWidth={2.2} />
                </Text>
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      {/* 标准四件套输入行: [ / | 📎 | 输入框 | 🚀 ] */}
      <View style={styles.inputRow}>
        {/* / 按钮：弹 skill 弹窗 */}
        <TouchableOpacity
          onPress={() => setShowSkills(true)}
          style={[styles.slashBtn, { borderColor: theme.border }]}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}>
          <Text style={[styles.slashText, { color: theme.accent }]}>/</Text>
        </TouchableOpacity>
        {/* 图片按钮：选图发送 */}
        <TouchableOpacity
          onPress={pickImage}
          style={[styles.slashBtn, { borderColor: theme.border }]}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          accessibilityRole="button"
          accessibilityLabel="添加图片"
        >
          <LineIcon name="clip" size={18} color={theme.text} />
        </TouchableOpacity>
        {/* 输入框（聚焦时内侧右缘显示全屏按钮） */}
        <View style={styles.inputWrap}>
          <TextInput
            style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text, borderColor: focused ? theme.accent : theme.border }]}
            value={text}
            onChangeText={setText}
            placeholder={placeholder ?? "Message..."}
            placeholderTextColor={theme.dim}
            multiline
            maxLength={4000}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          {focused && (
            <TouchableOpacity
              style={[styles.expandBtn, { backgroundColor: theme.cardBg, borderColor: theme.border }]}
              hitSlop={{ top: 9, bottom: 9, left: 9, right: 9 }}
              accessibilityRole="button"
              accessibilityLabel="展开全屏编辑"
              onPress={() => { setFullscreenEdit(true); void actions.listModels?.().then(setModels).catch(() => {}); }}
            >
              <LineIcon name="expand" size={13} color={theme.accent} strokeWidth={2.2} />
            </TouchableOpacity>
          )}
        </View>
        {/* 发送按钮 */}
        <TouchableOpacity
          style={[styles.sendButton, { backgroundColor: canSend ? theme.buttonPrimary : theme.border }]}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          accessibilityRole="button"
          accessibilityLabel="发送消息"
          accessibilityState={{ disabled: !canSend || sending, busy: sending }}
          onPress={() => void handleSend()}
          disabled={!canSend || sending}
        >
          <LineIcon name="send" size={16} color="#fff" strokeWidth={2} />
        </TouchableOpacity>
      </View>

      {/* 全屏编辑弹窗 */}
      <Modal visible={fullscreenEdit} animationType="slide" onRequestClose={() => setFullscreenEdit(false)}>
        <View style={[styles.fsRoot, { backgroundColor: theme.bg }]}>
          {/* 右上角最小化 */}
          <View style={[styles.fsTopBar, { paddingTop: 60 }]}>
            <Text style={[styles.fsTitle, { color: theme.muted }]}>Edit</Text>
            <TouchableOpacity
              style={[styles.fsMinBtn, { backgroundColor: theme.cardBg, borderColor: theme.border }]}
              hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
              accessibilityRole="button"
              accessibilityLabel="收起全屏编辑"
              onPress={() => setFullscreenEdit(false)}
            >
              <LineIcon name="collapse" size={18} color={theme.accent} strokeWidth={2} />
            </TouchableOpacity>
          </View>
          {/* 大输入框（自动聚焦） */}
          <TextInput
            style={[styles.fsInput, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
            value={text}
            onChangeText={setText}
            placeholder={placeholder ?? "Message..."}
            placeholderTextColor={theme.dim}
            multiline
            autoFocus
            textAlignVertical="top"
            maxLength={8000}
          />
          {/* 底部工具栏（聚焦时显示） */}
          <View style={[styles.fsToolbar, { borderTopColor: theme.border, backgroundColor: theme.headerBg }]}>
            <TouchableOpacity
              onPress={() => { setFsPanel("models"); if (models.length === 0) loadModels(); }}
              style={styles.fsToolBtn}
            >
              <LineIcon name="brain" size={18} color={theme.muted} />
              <Text style={[styles.toolLabel, { color: theme.muted }]}>Model</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFsPanel("thinking")} style={styles.fsToolBtn}>
              <LineIcon name="bolt" size={18} color={theme.muted} />
              <Text style={[styles.toolLabel, { color: theme.muted }]}>Think</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFsPanel("plan")} style={styles.fsToolBtn}>
              <LineIcon name="plan" size={18} color={theme.muted} />
              <Text style={[styles.toolLabel, { color: theme.muted }]}>Plan</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFsPanel("skills")} style={styles.fsToolBtn}>
              <Text style={[styles.slashText, { color: theme.accent }]}>/</Text>
              <Text style={[styles.toolLabel, { color: theme.muted }]}>Skill</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={pickImage} style={styles.fsToolBtn}>
              <LineIcon name="clip" size={18} color={theme.muted} />
              <Text style={[styles.toolLabel, { color: theme.muted }]}>Image</Text>
            </TouchableOpacity>
            <View style={styles.fsSpacer} />
            <TouchableOpacity
              style={[styles.sendButton, { backgroundColor: canSend ? theme.buttonPrimary : theme.border }]}
              hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
              accessibilityRole="button"
              accessibilityLabel="发送消息"
              accessibilityState={{ disabled: !canSend || sending, busy: sending }}
              onPress={() => { setFullscreenEdit(false); void handleSend(); }}
              disabled={!canSend || sending}
            >
              <LineIcon name="send" size={16} color="#fff" strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {/* 内嵌面板（全屏内的工具弹层，非独立 Modal，避免层级问题） */}
          {fsPanel !== null && (
            <Animated.View style={styles.fsPanelOverlay}>
              <Animated.View style={[styles.fsPanelScrim, { opacity: panelAnim }]} />
              <Animated.View
                style={[
                  styles.fsPanel,
                  {
                    backgroundColor: theme.cardBg,
                    borderColor: theme.border,
                    opacity: panelAnim,
                    transform: [{ translateY: panelAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
                  },
                ]}
              >
                <View style={styles.modalHeader}>
                  <Text style={[styles.modalTitle, { color: theme.text }]}>
                    {fsPanel === "models" ? "选择模型" : fsPanel === "thinking" ? "思考等级" : fsPanel === "plan" ? "Plan / Act 模式" : "Skills"}
                  </Text>
                  <TouchableOpacity onPress={closeFsPanel} accessibilityRole="button" accessibilityLabel="关闭">
                    <LineIcon name="x" size={14} color={theme.muted} strokeWidth={2.2} />
                  </TouchableOpacity>
                </View>
                {fsPanel === "models" && (
                  models.length === 0 ? (
                    modelsLoading ? (
                      <Text style={[styles.modalEmpty, { color: theme.muted }]}>加载中...</Text>
                    ) : (
                      <View>
                        <Text style={[styles.modalEmpty, { color: theme.muted }]}>无法获取模型列表</Text>
                        <TouchableOpacity
                          style={[styles.retryBtn, { borderColor: theme.border }]}
                          accessibilityRole="button"
                          accessibilityLabel="重试加载模型列表"
                          onPress={loadModels}
                        >
                          <Text style={[styles.retryText, { color: theme.accent }]}>重试</Text>
                        </TouchableOpacity>
                      </View>
                    )
                  ) : (
                    <FlatList
                      data={models}
                      keyExtractor={(m) => `${m.provider}/${m.id}`}
                      renderItem={({ item }) => (
                        <TouchableOpacity
                          style={[styles.modelItem, { borderBottomColor: theme.border }]}
                          onPress={async () => { await actions.setModel?.(item.id); closeFsPanel(); }}
                        >
                          <Text style={[styles.modelName, { color: theme.text }]}>{item.name}</Text>
                          <View style={styles.modelMeta}>
                            <Text style={[styles.modelProvider, { color: theme.muted }]}>{item.provider}</Text>
                            {item.vision && <View style={styles.badgeRow}><LineIcon name="eye" size={12} color={theme.success} strokeWidth={2} /><Text style={[styles.modelBadge, { color: theme.success }]}> vision</Text></View>}
                            {item.reasoning && <View style={styles.badgeRow}><LineIcon name="brain" size={12} color={theme.accent} strokeWidth={2} /><Text style={[styles.modelBadge, { color: theme.accent }]}> reasoning</Text></View>}
                          </View>
                        </TouchableOpacity>
                      )}
                      style={{ maxHeight: 360 }}
                    />
                  )
                )}
                {fsPanel === "thinking" && THINKING_LEVELS.map((lv) => (
                  <TouchableOpacity
                    key={lv}
                    style={[styles.modelItem, { borderBottomColor: theme.border }]}
                    onPress={async () => { await actions.setThinking?.(lv); closeFsPanel(); }}
                  >
                    <Text style={[styles.modelName, { color: theme.text }]}>{lv}</Text>
                  </TouchableOpacity>
                ))}
                {fsPanel === "plan" && planActions.map((p) => (
                  <TouchableOpacity
                    key={p.key}
                    style={[styles.modelItem, { borderBottomColor: theme.border }]}
                    onPress={async () => { closeFsPanel(); await actions.send(p.prompt); }}
                  >
                    <Text style={[styles.modelName, { color: theme.text }]}>{p.label}</Text>
                  </TouchableOpacity>
                ))}
                {fsPanel === "skills" && (
                  <TextInput
                    style={[styles.skillSearch, { backgroundColor: theme.inputBg, color: theme.text, borderColor: theme.border }]}
                    value={skillQuery}
                    onChangeText={setSkillQuery}
                    placeholder="Search skills..."
                    placeholderTextColor={theme.dim}
                    autoCapitalize="none"
                  />
                )}
                {fsPanel === "skills" && (
                  <FlatList
                    data={skills.map((s) => (typeof s === "string" ? { name: s, description: undefined } : s)).filter((s) => s.name.toLowerCase().includes(skillQuery.toLowerCase()))}
                    keyExtractor={(s) => s.name}
                    renderItem={({ item }) => (
                      <TouchableOpacity
                        style={[styles.skillItem, { borderBottomColor: theme.border }]}
                        onPress={() => { setText(`/skill:${item.name} `); closeFsPanel(); }}
                      >
                        <Text style={[styles.skillName, { color: theme.text }]} numberOfLines={1}>/skill:{item.name}</Text>
                      </TouchableOpacity>
                    )}
                    ListEmptyComponent={<Text style={[styles.modalEmpty, { color: theme.muted }]}>No skills found</Text>}
                    style={{ maxHeight: 300 }}
                  />
                )}
              </Animated.View>
            </Animated.View>
          )}
        </View>
      </Modal>

      <Modal visible={showSkills} transparent animationType="slide" onRequestClose={() => setShowSkills(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Skills</Text>
              <TouchableOpacity onPress={() => setShowSkills(false)} accessibilityRole="button" accessibilityLabel="关闭"><LineIcon name="x" size={14} color={theme.muted} strokeWidth={2.2} /></TouchableOpacity>
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

      {/* 模型选择 Modal */}
      <Modal visible={showModels} transparent animationType="slide" onRequestClose={() => setShowModels(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>选择模型</Text>
              <TouchableOpacity onPress={() => setShowModels(false)} accessibilityRole="button" accessibilityLabel="关闭"><LineIcon name="x" size={14} color={theme.muted} strokeWidth={2.2} /></TouchableOpacity>
            </View>
            {modelError ? (
              <Text style={[styles.modalEmpty, { color: theme.error }]}>{modelError}</Text>
            ) : null}
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
                      {item.vision && <View style={styles.badgeRow}><LineIcon name="eye" size={12} color={theme.success} strokeWidth={2} /><Text style={[styles.modelBadge, { color: theme.success }]}> 视觉</Text></View>}
                      {item.reasoning && <View style={styles.badgeRow}><LineIcon name="brain" size={12} color={theme.accent} strokeWidth={2} /><Text style={[styles.modelBadge, { color: theme.accent }]}> 推理</Text></View>}
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
      <Modal visible={showThinking} transparent animationType="slide" onRequestClose={() => setShowThinking(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>思考等级</Text>
              <TouchableOpacity onPress={() => setShowThinking(false)} accessibilityRole="button" accessibilityLabel="关闭"><LineIcon name="x" size={14} color={theme.muted} strokeWidth={2.2} /></TouchableOpacity>
            </View>
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
      <Modal visible={showPlanPicker} transparent animationType="slide" onRequestClose={() => setShowPlanPicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Plan / Act 模式</Text>
              <TouchableOpacity onPress={() => setShowPlanPicker(false)} accessibilityRole="button" accessibilityLabel="关闭"><LineIcon name="x" size={14} color={theme.muted} strokeWidth={2.2} /></TouchableOpacity>
            </View>
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
  toolbarScroll: { flexShrink: 1 },
  toolbarBtns: { flexDirection: "row", alignItems: "center" },
  toolIcon: { fontSize: 18 },
  modelLabel: { flexShrink: 1, fontSize: 11, textAlign: "right", marginLeft: 8 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 10, paddingBottom: 8, gap: 6 },
  inputWrap: { flex: 1, position: "relative" },
  expandBtn: {
    position: "absolute",
    right: 6,
    bottom: 6,
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  expandIcon: { fontSize: 13, fontWeight: "700" },
  fsRoot: { flex: 1 },
  fsTopBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  fsTitle: { fontSize: 13, flex: 1 },
  fsMinBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  fsMinIcon: { fontSize: 18, fontWeight: "700" },
  fsInput: {
    flex: 1,
    margin: 12,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    fontSize: 15,
    lineHeight: 22,
  },
  fsToolbar: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 4,
  },
  fsToolBtn: { alignItems: "center", paddingHorizontal: 10 },
  fsSpacer: { flex: 1 },
  fsPanelOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  fsPanelScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.5)" },
  fsPanel: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    padding: 16,
    maxHeight: 480,
  },
  input: { flex: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, fontSize: 15, maxHeight: 120 },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  modalSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: 1, padding: 16, maxHeight: 480 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  modalTitle: { fontSize: 16, fontWeight: "700", marginBottom: 8 },
  modalClose: { fontSize: 16, padding: 4 },
  modalEmpty: { textAlign: "center", padding: 20 },
  retryBtn: { alignSelf: "center", marginTop: 8, paddingHorizontal: 20, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  retryText: { fontSize: 14, fontWeight: "600" },
  modelItem: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  modelName: { fontSize: 14, fontWeight: "600" },
  modelMeta: { flexDirection: "row", gap: 8, marginTop: 2 },
  modelProvider: { fontSize: 11 },
  modelBadge: { fontSize: 11 },
  badgeRow: { flexDirection: "row", alignItems: "center" },
});