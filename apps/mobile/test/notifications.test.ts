import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock AsyncStorage
const storage = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, val: string) => { storage.set(key, val); }),
  },
}));

// Mock expo-notifications
const scheduledNotifications: unknown[] = [];
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(async () => ({ granted: true })),
  requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
  scheduleNotificationAsync: vi.fn(async (notif: unknown) => {
    scheduledNotifications.push(notif);
    return "notif-id-123";
  }),
  IosAuthorizationStatus: { PROVISIONAL: 3 },
}));

// Mock haptics
vi.mock("../src/utils/haptics", () => ({
  hapticNotificationSuccess: vi.fn(),
  hapticImpactMedium: vi.fn(),
}));

import {
  notifyPendingAsk,
  notifyAgentSettled,
  setActiveViewingSession,
  onInAppBanner,
  setNotificationSettings,
  getNotificationSettings,
  initNotificationService,
} from "../src/notifications";

describe("notifications service", () => {
  beforeEach(() => {
    storage.clear();
    scheduledNotifications.length = 0;
    setActiveViewingSession(null);
  });

  it("dispatches in-app banner and schedules system notification for pending ask", async () => {
    let capturedBanner: any = null;
    const unsub = onInAppBanner((b) => {
      capturedBanner = b;
    });

    await notifyPendingAsk(
      "session-1",
      "call-abc",
      "确认部署",
      "是否开始部署到预发布环境？",
      "my-project",
    );

    expect(capturedBanner).toBeTruthy();
    expect(capturedBanner?.type).toBe("ask");
    expect(capturedBanner?.sessionId).toBe("session-1");
    expect(capturedBanner?.title).toContain("my-project");

    expect(scheduledNotifications.length).toBe(1);
    expect((scheduledNotifications[0] as any).content.title).toContain("my-project");
    expect((scheduledNotifications[0] as any).content.data).toEqual({
      type: "ask",
      sessionId: "session-1",
      toolCallId: "call-abc",
    });

    // 再次调用相同 toolCallId 应被去重过滤
    await notifyPendingAsk("session-1", "call-abc", "确认部署", "重复提问");
    expect(scheduledNotifications.length).toBe(1);

    unsub();
  });

  it("suppresses banners and schedules when user is actively viewing that session", async () => {
    let capturedBanner: any = null;
    const unsub = onInAppBanner((b) => {
      capturedBanner = b;
    });

    setActiveViewingSession("session-viewing");

    await notifyPendingAsk(
      "session-viewing",
      "call-xyz",
      "操作确认",
      "无需弹窗打扰",
    );

    // 用户正停留在该页面时，不弹横幅，仅保留原地触觉反馈
    expect(capturedBanner).toBeNull();
    unsub();
  });

  it("schedules agent settled notification and respects rate limit", async () => {
    let capturedBanner: any = null;
    const unsub = onInAppBanner((b) => {
      capturedBanner = b;
    });

    await notifyAgentSettled("session-2", "project-x", "已完成优化工作");

    expect(capturedBanner).toBeTruthy();
    expect(capturedBanner?.type).toBe("settled");
    expect(scheduledNotifications.length).toBe(1);

    // 短时间内同会话限频，不重复调度系统通知
    await notifyAgentSettled("session-2", "project-x", "第二次汇报");
    expect(scheduledNotifications.length).toBe(1);

    unsub();
  });

  it("respects preference settings", async () => {
    await setNotificationSettings({ askEnabled: false });
    expect(getNotificationSettings().askEnabled).toBe(false);

    let capturedBanner: any = null;
    const unsub = onInAppBanner((b) => {
      capturedBanner = b;
    });

    await notifyPendingAsk("session-3", "call-off", "测试关闭", "内容");
    expect(capturedBanner).toBeNull();
    expect(scheduledNotifications.length).toBe(0);

    unsub();
    await setNotificationSettings({ askEnabled: true });
  });
});
