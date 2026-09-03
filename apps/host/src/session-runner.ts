import type {
  SessionState,
  TimelineItem,
  SessionSnapshot,
  HostEvent,
  JsonValue,
} from "@maestro-mobile/shared";
import type { DistributiveOmit } from "./event-log.js";
import type { MobileAgentRuntime, MobileAgentSession } from "./mobile-agent.js";
import type { SessionRunner, RuntimeFactory } from "./types.js";
import { EventLog } from "./event-log.js";
import { replayFromJsonl } from "./jsonl-replay.js";
import { replayTailFromJsonl, replayPageFromJsonl, searchInJsonl } from "./jsonl-pager.js";
import { MobileExtensionUiBridge } from "./mobile-ui-context.js";

const HISTORY_PAGE_SIZE = 80;

/**
 * SdkSessionRunner — 管理一个 AgentSession 的生命周期
 * 订阅 SDK 事件，投影为 timeline + session 状态，转发为 HostEvent
 */
export class SdkSessionRunner implements SessionRunner {
  private readonly eventLog = new EventLog();
  private readonly timeline: TimelineItem[] = [];
  private readonly uiBridge: MobileExtensionUiBridge;
  private unsubscribe: (() => void) | undefined;
  private session: MobileAgentSession;
  private _state: SessionState;
  private historyCursor = 0;
  private historyTotalEntries = 0;
  private hasMoreHistoryFlag = false;

  private constructor(
    private readonly runtime: MobileAgentRuntime,
    private readonly emit: (event: HostEvent) => void,
  ) {
    this.session = runtime.session;
    this._state = this.createState(runtime.session);
    this.uiBridge = new MobileExtensionUiBridge(this.id, (event) => this.emit(this.eventLog.record(event)));
  }

  static async open(
    runtimeFactory: RuntimeFactory,
    request: { cwd: string; mode?: "create" | "continue"; sessionFile?: string },
    emit: (event: HostEvent) => void,
  ): Promise<SdkSessionRunner> {
    const runtime = await runtimeFactory.createRuntime(request);
    const runner = new SdkSessionRunner(runtime, emit);
    await runner.bindSession();
    return runner;
  }

  get id(): string {
    return this.session.sessionId;
  }

  get state(): SessionState {
    return this._state;
  }

  get bridge(): MobileExtensionUiBridge {
    return this.uiBridge;
  }

  snapshot(): SessionSnapshot {
    return {
      session: this._state,
      timeline: [...this.timeline],
      nextSeq: this.eventLog.nextSequence,
      hasMoreHistory: this.hasMoreHistoryFlag,
    };
  }

  eventsSince(seq: number): HostEvent[] {
    return this.eventLog.eventsSince(seq);
  }

  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    let accepted = false;
    let recordedPrompt = false;
    await new Promise<void>((resolve, reject) => {
      void this.session
        .prompt(message, {
          streamingBehavior,
          source: "rpc",
          preflightResult: (success: boolean) => {
            if (success) {
              accepted = true;
              if (!recordedPrompt) {
                recordedPrompt = true;
                this.recordUserMessage(message);
              }
              resolve();
            } else {
              reject(new Error("Prompt was rejected before execution"));
            }
          },
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!accepted) {
            reject(new Error(message));
          }
          this.recordCommandError("prompt", message);
        });
    });
  }

  async steer(message: string): Promise<void> {
    await this.session.steer(message);
  }

  async followUp(message: string): Promise<void> {
    await this.session.followUp(message);
  }

  async abort(): Promise<void> {
    this.uiBridge.cancelAll();
    await this.session.abort();
  }

  respondToExtensionUi(requestId: string, response: Parameters<MobileExtensionUiBridge["respond"]>[1]): boolean {
    return this.uiBridge.respond(requestId, response);
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.uiBridge.cancelAll();
    await this.runtime.dispose();
  }

  private async bindSession(): Promise<void> {
    this.unsubscribe?.();
    this.session = this.runtime.session;
    this._state = this.createState(this.session);
    // 懒加载：只回放尾部 N 条（长会话不一次性解析全部），滚动到顶再加载更早
    let hasMoreTail = false;
    this.historyCursor = 0;
    let replayed: TimelineItem[] = [];
    if (this.session.sessionFile) {
      const tail = await replayTailFromJsonl(this.session.sessionFile, HISTORY_PAGE_SIZE);
      if (tail.items.length > 0) {
        replayed = tail.items;
        hasMoreTail = tail.hasMore;
        this.historyCursor = tail.cursor;
        this.historyTotalEntries = tail.totalEntries;
      }
    }
    if (replayed.length === 0) {
      replayed = this.restoreTimelineFromMessages(this.session.messages);
    }
    this.hasMoreHistoryFlag = hasMoreTail;
    this.timeline.splice(0, this.timeline.length, ...replayed);
    // 告知客户端历史已就绪（App 侧收到后拉取 snapshot 完整渲染）
    if (replayed.length > 0) {
      this.emit(this.eventLog.record({
        type: "host_status",
        status: `replayed ${replayed.length} history messages`,
      }));
    }
    await this.session.bindExtensions({
      uiContext: this.uiBridge.createContext(),
      onError: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.recordCommandError("extension", message);
      },
    });
    this.unsubscribe = this.session.subscribe((event: unknown) => this.handleSessionEvent(event));
  }

  /** 是否还有更早的历史可加载 */
  get hasMoreHistory(): boolean {
    return this.hasMoreHistoryFlag;
  }
  /** 搜索会话历史消息 */
  async searchHistory(keyword: string, maxResults?: number): Promise<{ matches: { index: number; text: string; kind: string }[]; totalEntries: number }> {
    if (!this.session.sessionFile) {
      return { matches: [], totalEntries: 0 };
    }
    return searchInJsonl(this.session.sessionFile, keyword, maxResults);
  }

  /** 加载更早的一页历史，返回新增的 timeline 条目（追加到最前面） */
  async loadMoreHistory(): Promise<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }> {
    if (!this.session.sessionFile || this.historyCursor <= 0) {
      return { items: [], hasMore: false, totalEntries: this.historyTotalEntries };
    }
    const page = await replayPageFromJsonl(this.session.sessionFile, this.historyCursor, HISTORY_PAGE_SIZE);
    if (page.items.length === 0) {
      this.hasMoreHistoryFlag = false;
      return { items: [], hasMore: false, totalEntries: this.historyTotalEntries };
    }
    // 追加到 timeline 最前面（更早的内容）
    this.timeline.unshift(...page.items);
    this.hasMoreHistoryFlag = page.hasMore;
    this.historyCursor = page.cursor;
    if (page.totalEntries > 0) this.historyTotalEntries = page.totalEntries;
    return { items: page.items, hasMore: page.hasMore, totalEntries: this.historyTotalEntries };
  }

  /** 将 session.messages（AgentMessage[]）投影为 TimelineItem[] */
  private restoreTimelineFromMessages(messages: unknown[]): TimelineItem[] {
    const items: TimelineItem[] = [];
    const seenToolResults = new Set<string>();
    for (const raw of messages ?? []) {
      const msg = raw as Record<string, unknown>;
      const role = String(msg.role ?? "");
      const createdAt = typeof msg.timestamp === "number"
        ? new Date(msg.timestamp).toISOString()
        : new Date().toISOString();

      if (role === "toolResult") {
        // 工具结果（bash 输出/表格/路径提示等）——去重后展示
        const toolCallId = String(msg.toolCallId ?? "");
        if (toolCallId && seenToolResults.has(toolCallId)) continue;
        if (toolCallId) seenToolResults.add(toolCallId);
        const toolName = String(msg.toolName ?? "tool");
        const text = extractText(msg.content) || (msg.text as string | undefined) || "";
        if (!text) continue;
        items.push({
          id: `replay-tool-${items.length}`,
          kind: "tool",
          text,
          createdAt,
          toolName,
          toolCallId,
          isError: msg.isError === true,
        });
        continue;
      }

      if (role === "tool" || role === "toolCall") {
        // 工具调用描述（toolName + args）
        const toolName = String(msg.toolName ?? "tool");
        const text = extractText(msg.content) || (msg.text as string | undefined) || "";
        items.push({
          id: `replay-toolcall-${items.length}`,
          kind: "tool",
          text: text || `调用 ${toolName}`,
          createdAt,
          toolName,
        });
        continue;
      }

      const content = extractText(msg.content);
      if (!content && role !== "thinking" && role !== "system") continue;

      if (role === "user") {
        items.push({ id: `replay-user-${items.length}`, kind: "user", text: content, createdAt });
      } else if (role === "assistant" || role === "system") {
        items.push({ id: `replay-assistant-${items.length}`, kind: "assistant", text: content, createdAt });
      } else if (role === "thinking") {
        items.push({ id: `replay-thinking-${items.length}`, kind: "thinking", text: content, createdAt });
      }
      // 其余类型（compactionSummary 等）暂不展开
    }
    return items;
  }

  private handleSessionEvent(event: unknown): void {
    const jsonEvent = toJsonValue(event);
    this.emit(this.eventLog.record({ type: "raw_event", sessionId: this.id, event: jsonEvent }));

    this._state = this.applyEventToState(this._state, jsonEvent);
    this.emit(this.eventLog.record({ type: "session_updated", session: this._state }));
  }

  private applyEventToState(state: SessionState, event: JsonValue): SessionState {
    const e = event as Record<string, unknown>;
    switch (e.type) {
      case "message_end":
        return { ...state, messageCount: state.messageCount + 1, updatedAt: new Date().toISOString() };
      case "agent_start":
        return { ...state, runState: "streaming", updatedAt: new Date().toISOString() };
      case "agent_end":
        return { ...state, runState: "idle", updatedAt: new Date().toISOString() };
      case "turn_end":
        return { ...state, runState: "idle", updatedAt: new Date().toISOString() };
      default:
        return state;
    }
  }

  private recordUserMessage(message: string): void {
    const item: TimelineItem = {
      id: `user-${this.eventLog.nextSequence}`,
      kind: "user",
      text: message,
      createdAt: new Date().toISOString(),
    };
    this.timeline.push(item);
    this.emit(this.eventLog.record({ type: "timeline_item", sessionId: this.id, item }));
  }

  private recordCommandError(command: string, message: string): void {
    this.emit(this.eventLog.record({ type: "command_error", sessionId: this.id, command, message }));
  }

  private createState(session: MobileAgentSession): SessionState {
    return {
      id: session.sessionId,
      cwd: this.runtime.cwd,
      title: session.sessionName ?? this.runtime.cwd.split("/").pop() ?? session.sessionId.slice(0, 8),
      runState: session.isCompacting ? "compacting" : session.isStreaming ? "streaming" : "idle",
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
      updatedAt: new Date().toISOString(),
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      ...(session.model === undefined ? {} : { model: session.model as JsonValue }),
      ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
    };
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** 从 AgentMessage.content（string 或 content block 数组）提取纯文本 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}