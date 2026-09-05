import { Redirect } from "expo-router";

/**
 * 入口页 → 重定向到会话列表（Tabs 首页）。
 * 原「Host 连接 + 功能导航」职责已迁移：连接 → 会话页 HostConnectCard；导航 → 底部 Tabs。
 */
export default function HomeRedirect() {
  return <Redirect href="/host-sessions" />;
}
