import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { hapticNotificationSuccess, hapticImpactMedium } from "./utils/haptics";

const NOTIF_ASK_KEY = "maestro-mobile.notif-ask-enabled";
const NOTIF_SETTLED_KEY = "maestro-mobile.notif-settled-enabled";

// 配置系统通知前台行为（即便 App 在前台也展示系统弹窗与声音）
try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
} catch {}

// 全局通知开关内存缓存
let askNotifEnabled = true;
let settledNotifEnabled = true;

// 记录已通知过的 ID，防重复打扰
const notifiedAskIds = new Set<string>();
const notifiedSettleTimes = new Map<string, number>();

// 当前前台活跃的 session ID（如果用户正停留在该会话页，则不弹横幅，仅触觉反馈）
let currentActiveSessionId: string | null = null;

export function setActiveViewingSession(sessionId: string | null) {
  currentActiveSessionId = sessionId;
}

export function getNotificationSettings() {
  return {
    askEnabled: askNotifEnabled,
    settledEnabled: settledNotifEnabled,
  };
}

export async function setNotificationSettings(settings: { askEnabled?: boolean; settledEnabled?: boolean }) {
  if (settings.askEnabled !== undefined) {
    askNotifEnabled = settings.askEnabled;
    await AsyncStorage.setItem(NOTIF_ASK_KEY, JSON.stringify(askNotifEnabled)).catch(() => {});
  }
  if (settings.settledEnabled !== undefined) {
    settledNotifEnabled = settings.settledEnabled;
    await AsyncStorage.setItem(NOTIF_SETTLED_KEY, JSON.stringify(settledNotifEnabled)).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 系统级通知权限管理
// ─────────────────────────────────────────────────────────────────────────────

export async function requestSystemNotificationPermissions(): Promise<boolean> {
  try {
    const settings = await Notifications.getPermissionsAsync();
    if (settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
      return true;
    }
    const requested = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    return Boolean(requested.granted);
  } catch {
    return false;
  }
}

export async function getSystemNotificationPermissionStatus(): Promise<boolean> {
  try {
    const settings = await Notifications.getPermissionsAsync();
    return Boolean(settings.granted);
  } catch {
    return false;
  }
}

async function scheduleSystemNotification(title: string, body: string, data: Record<string, unknown>) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data,
        sound: true,
      },
      trigger: null, // null 表示立即下发系统通知
    });
  } catch (err) {
    // 捕获权限未获或平台不支持异常，保障核心体验
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 应用内顶部横幅（In-App Notification Banner）事件发布订阅
// ─────────────────────────────────────────────────────────────────────────────

export interface InAppBannerPayload {
  id: string;
  type: "ask" | "settled";
  title: string;
  body: string;
  sessionId: string;
  toolCallId?: string;
}

type BannerListener = (banner: InAppBannerPayload | null) => void;
const bannerListeners = new Set<BannerListener>();

export function onInAppBanner(listener: BannerListener): () => void {
  bannerListeners.add(listener);
  return () => bannerListeners.delete(listener);
}

export function emitInAppBanner(payload: InAppBannerPayload | null) {
  for (const fn of bannerListeners) {
    try { fn(payload); } catch {}
  }
}

/** 启动时初始化通知服务与偏好 */
export async function initNotificationService() {
  try {
    const rawAsk = await AsyncStorage.getItem(NOTIF_ASK_KEY);
    if (rawAsk !== null) askNotifEnabled = JSON.parse(rawAsk);
    const rawSettled = await AsyncStorage.getItem(NOTIF_SETTLED_KEY);
    if (rawSettled !== null) settledNotifEnabled = JSON.parse(rawSettled);
    // 请求系统通知权限
    void requestSystemNotificationPermissions();
  } catch {}
}

/** 触发 Ask 待办问答通知 */
export async function notifyPendingAsk(
  sessionId: string,
  toolCallId: string,
  title: string,
  message: string,
  projectName?: string,
) {
  if (!askNotifEnabled) return;
  if (notifiedAskIds.has(toolCallId)) return;
  notifiedAskIds.add(toolCallId);

  // 如果用户当前正停留在该会话页，仅触觉反馈，不弹系统横幅挡屏幕
  if (currentActiveSessionId === sessionId) {
    void hapticImpactMedium();
    return;
  }

  const header = projectName ? `⚠️ 待确认 · ${projectName}` : "⚠️ 待处理提问";
  const body = message ? `${title ? `【${title}】` : ""}${message}` : title || "Agent 等待您的选择或确认";

  // 1. 触发系统触觉震动
  void hapticImpactMedium();

  // 2. 派发应用内优雅顶部浮窗横幅
  emitInAppBanner({
    id: `ask-${toolCallId}`,
    type: "ask",
    title: header,
    body,
    sessionId,
    toolCallId,
  });

  // 3. 派发系统级本地通知（用于系统通知中心、锁屏以及横幅提示）
  void scheduleSystemNotification(header, body, {
    type: "ask",
    sessionId,
    toolCallId,
  });
}

/** 触发 Agent 轮次回复完成通知 */
export async function notifyAgentSettled(
  sessionId: string,
  projectName?: string,
  summary?: string,
) {
  if (!settledNotifEnabled) return;

  // 10 秒内同一会话不重复触发完成通知
  const now = Date.now();
  const lastTime = notifiedSettleTimes.get(sessionId) ?? 0;
  if (now - lastTime < 10_000) return;
  notifiedSettleTimes.set(sessionId, now);

  // 如果用户当前正停留在该会话页看着它生成完毕，仅给轻微成功震动，不弹通知横幅
  if (currentActiveSessionId === sessionId) {
    void hapticNotificationSuccess();
    return;
  }

  const header = projectName ? `✅ 回复已完成 · ${projectName}` : "✅ Agent 回复已完成";
  const body = summary && summary.trim().length > 0
    ? summary.trim().replace(/\n+/g, " ").slice(0, 100)
    : "任务本轮执行与思考已全部完成，可前往查验结果";

  // 1. 触发成功触觉震动
  void hapticNotificationSuccess();

  // 2. 派发应用内优雅顶部浮窗横幅
  emitInAppBanner({
    id: `settle-${sessionId}-${now}`,
    type: "settled",
    title: header,
    body,
    sessionId,
  });

  // 3. 派发系统级本地通知
  void scheduleSystemNotification(header, body, {
    type: "settled",
    sessionId,
  });
}
