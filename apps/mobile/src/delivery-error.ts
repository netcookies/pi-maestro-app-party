/**
 * 投递失败的可读化映射。
 *
 * Host 侧 Desktop Plugin 用稳定的 `code` 表示「未投递」，并把具体原因放在 `message`
 * （见 desktop-pi-session-adapter.ts 的 delivery_failed）。移动端 HostClient 在命令失败时
 * 以 `message ?? code` 构造 Error，因此这里收到的是原因串。
 *
 * 未知原因一律回落到通用文案，不能吞掉失败（否则用户只看到消息没发出去）。
 */
export function describeSendFailure(raw: unknown): string {
  const message = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw ?? "");
  const known: Record<string, string> = {
    no_model_selected: "无法发送：目标会话未选择模型",
    missing_model_auth: "无法发送：目标会话的模型未配置凭据",
    delivery_failed: "无法发送：消息未投递到目标会话",
    target_unavailable: "无法发送：目标会话已不可用",
    capability_mismatch: "无法发送：目标会话的插件版本不支持该操作",
    deadline_exceeded: "无法发送：目标会话未及时响应",
    desktop_confirmation_unavailable: "无法发送：与目标会话的连接已中断",
    host_command_failed: "无法发送：主机执行失败",
  };
  if (known[message]) return known[message];
  // 兼容形如 "Error: delivery_failed" 或带前缀的错误串
  for (const [code, text] of Object.entries(known)) {
    if (message.includes(code)) return text;
  }
  return message.length > 0 ? `发送失败：${message}` : "发送失败：未知原因";
}
