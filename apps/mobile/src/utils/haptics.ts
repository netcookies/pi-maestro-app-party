/**
 * Haptics Engine — 跨平台触觉反馈服务 (iOS & Android 10+)
 *
 * 规范：
 * - impactLight: Tab 切换、卡片按压、分段器刻度、轻量点击
 * - impactMedium: 消息发送、连接成功、核心操作确认
 * - notificationSuccess: 代码块复制成功、配对完成
 * - notificationWarning: 告警、断线、操作失败
 *
 * 安全性：捕获所有平台未知异常，无原生抛错，不阻塞 UI 线程。
 */
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

export async function hapticImpactLight(): Promise<void> {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {}
}

export async function hapticImpactMedium(): Promise<void> {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  } catch {}
}

export async function hapticImpactHeavy(): Promise<void> {
  try {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  } catch {}
}

export async function hapticSelection(): Promise<void> {
  try {
    await Haptics.selectionAsync();
  } catch {}
}

export async function hapticNotificationSuccess(): Promise<void> {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } catch {}
}

export async function hapticNotificationWarning(): Promise<void> {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  } catch {}
}

export async function hapticNotificationError(): Promise<void> {
  try {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } catch {}
}
