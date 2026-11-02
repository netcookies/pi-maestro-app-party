/**
 * 系统通告与续跑判定
 *
 * 识别由系统/引擎自动注入的续跑与断点恢复提示，将其呈现为系统通告卡片，
 * 避免在历史会话或未重启旧 Host 下被误渲染为用户的聊天气泡。
 */
export function isSystemContinuationPrompt(text: string): boolean {
  if (!text) return false;
  return (
    /^continue the active goal(?:\b|\s*[:：])/iu.test(text) ||
    /^continue the interrupted task from the compacted session checkpoint/iu.test(text) ||
    /\[maestro-recovery-delivery:[a-f0-9]+\]/i.test(text)
  );
}
