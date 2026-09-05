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
import { replayTailFromJsonl, replayPageFromJsonl, searchInJsonl } from "./jsonl-pager.js";
import { MobileExtensionUiBridge } from "./mobile-ui-context.js";

const HISTORY_PAGE_SIZE = 80;
/** 流式 delta 节流间隔：每个条目最多每 200ms 发一次，避免刷屏事件环 */
const DELTA_THROTTLE_MS = 200;

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
    try {
      await runner.bindSession();
    } catch (error) {
      // bindSession 失败时 runtime 无人接管，必须释放否则泄漏
      await runtime.dispose();
      throw error;
    }
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

  async prompt(message: string, streamingBehavior?: "steer" | "followUp", images?: unknown[]): Promise<void> {
    let accepted = false;
    let recordedPrompt = false;
    await new Promise<void>((resolve, reject) => {
      void this.session
        .prompt(message, {
          streamingBehavior,
          source: "rpc",
          ...(images && images.length > 0 ? { images } : {}),
          preflightResult: (success: boolean) => {
            if (success) {
              accepted = true;
              if (!recordedPrompt) {
                recordedPrompt = true;
                this.recordUserMessage(message, images);
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

  /** 列出可用模型（已配置 auth 的，与 TUI 选择器一致） */
  listModels(): { id: string; provider: string; name: string; reasoning: boolean; vision: boolean }[] {
    const reg = this.session.modelRegistry;
    if (!reg || typeof reg.getAll !== "function") return [];
    // getAvailable() = 已配置 auth 的模型（与 TUI /model 选择器一致）；
    // getAll() 会返回 1000+ 内置未配置模型。
    const source = typeof reg.getAvailable === "function" ? reg.getAvailable() : reg.getAll();
    return source.map((m) => ({
      id: String(m.id ?? ""),
      provider: String(m.provider ?? ""),
      name: String(m.name ?? m.id ?? ""),
      reasoning: Boolean(m.reasoning),
      vision: Array.isArray(m.input) && m.input.includes("image"),
    }));
  }

  /** 列出实际加载的 skills（与 TUI 一致，走 resourceLoader） */
  listLoadedSkills(): { name: string; description?: string }[] {
    const loader = this.session.resourceLoader;
    if (!loader || typeof loader.getSkills !== "function") return [];
    try {
      return (loader.getSkills().skills ?? []).map((s) => ({
        name: String(s.name ?? ""),
        description: typeof s.description === "string" ? s.description : undefined,
      }));
    } catch {
      return [];
    }
  }

  /** 切换模型 */
  async setModel(modelId: string): Promise<{ ok: boolean; error?: string }> {
    const reg = this.session.modelRegistry;
    if (!reg || typeof reg.getAll !== "function") {
      return { ok: false, error: "model registry unavailable" };
    }
    const model = reg.getAll().find((m) => String(m.id ?? "") === modelId)
      ?? (typeof reg.getById === "function" ? reg.getById(modelId) : undefined);
    if (!model || typeof this.session.setModel !== "function") {
      return { ok: false, error: "model not found" };
    }
    try {
      await this.session.setModel(model);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 切换思考等级 */
  setThinking(level: string): { ok: boolean; error?: string } {
    if (typeof this.session.setThinkingLevel !== "function") {
      return { ok: false, error: "thinking unavailable" };
    }
    try {
      this.session.setThinkingLevel(level);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 手动压缩上下文 */
  async compact(customInstructions?: string): Promise<{ ok: boolean; error?: string }> {
    if (typeof this.session.compact !== "function") {
      return { ok: false, error: "compact unavailable" };
    }
    try {
      await this.session.compact(customInstructions);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 重命名会话 */
  renameSession(name: string): { ok: boolean; error?: string } {
    if (typeof this.session.setSessionName !== "function") {
      return { ok: false, error: "rename unavailable" };
    }
    try {
      this.session.setSessionName(name);
      this._state = { ...this._state, title: name };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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
  async searchHistory(keyword: string, maxResults?: number, previewLength = 120): Promise<{ matches: { index: number; text: string; kind: string }[]; totalEntries: number }> {
    if (!this.session.sessionFile) {
      return { matches: [], totalEntries: 0 };
    }
    const result = await searchInJsonl(this.session.sessionFile, keyword, maxResults);
    // 按配置的预览长度截断
    const truncated = result.matches.map((m) => ({
      ...m,
      text: m.text.length > previewLength ? `${m.text.slice(0, previewLength)}…` : m.text,
    }));
    return { matches: truncated, totalEntries: result.totalEntries };
  }

  /** 加载更早的一页历史（count 可配，默认 HISTORY_PAGE_SIZE），返回新增的 timeline 条目 */
  /** P2-3：进行中的历史加载。并发合并 + 互斥：后来者共享同一 Promise 结果，
   *  保证多客户端并发时只拉一页、cursor 只前进一次、无重复历史；
   *  完成后仅当占锁者仍是自己才清空（防止清掉后续加载的锁）。 */
  private historyLoadLock: Promise<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }> | null = null;
  async loadMoreHistory(count?: number): Promise<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }> {
    const inFlight = this.historyLoadLock;
    if (inFlight) return inFlight;
    const guarded = this.doLoadMoreHistory(count).finally(() => {
      if (this.historyLoadLock === guarded) this.historyLoadLock = null;
    });
    this.historyLoadLock = guarded;
    return guarded;
  }

  private async doLoadMoreHistory(count?: number): Promise<{ items: TimelineItem[]; hasMore: boolean; totalEntries: number }> {
    if (!this.session.sessionFile || this.historyCursor <= 0) {
      return { items: [], hasMore: false, totalEntries: this.historyTotalEntries };
    }
    const pageSize = Number.isInteger(count) && (count as number) > 0 ? (count as number) : HISTORY_PAGE_SIZE;
    const page = await replayPageFromJsonl(this.session.sessionFile, this.historyCursor, pageSize);
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

    // P1-1：将 assistant/thinking/toolResult 消息实时投影为 timeline，
    // 否则 live 会话中客户端只能看到用户消息（重连后才能从 jsonl 重放看到回复）。
    // user 消息不在此投影：prompt 路径的 recordUserMessage 已覆盖，避免重复。
    this.projectLiveMessage(jsonEvent);

    this._state = this.applyEventToState(this._state, jsonEvent);
    this.emit(this.eventLog.record({ type: "session_updated", session: this._state }));
  }

  /** 稳定 id 映射：同一消息的 update 与 end 复用同一 id，客户端据此去重/替换 */
  private readonly liveItemIds = new Map<string, string>();
  private readonly liveDeltaAt = new Map<string, number>();
  private liveSeq = 0;

  private projectLiveMessage(event: JsonValue): void {
    const e = event as Record<string, unknown>;
    const type = e.type;
    if (type !== "message_end" && type !== "message_update") return;
    const message = e.message as Record<string, unknown> | undefined;
    if (!message) return;
    const role = String(message.role ?? "");
    if (role === "user") return; // 由 recordUserMessage 投影，避免重复

    if (type === "message_end") {
      const item = this.liveMessageToTimelineItem(message);
      if (!item) return;
      this.upsertTimelineItem(item);
      this.liveDeltaAt.delete(item.id);
      this.emit(this.eventLog.record({ type: "timeline_item", sessionId: this.id, item }));
      return;
    }

    // message_update：流式增量（节流）。客户端尚未建条目时会忽略，终态由 message_end 补齐。
    const text = extractText(message.content);
    if (!text) return;
    const id = this.ensureLiveId(message);
    if (!id) return;
    const now = Date.now();
    const last = this.liveDeltaAt.get(id) ?? 0;
    if (now - last < DELTA_THROTTLE_MS) return;
    this.liveDeltaAt.set(id, now);
    // delta 语义是追加：只发新增部分（非前缀扩展时发全文，由客户端替换语义兑底）
    const sent = this.lastSentText.get(id);
    const delta = sent !== undefined && text.startsWith(sent) ? text.slice(sent.length) : text;
    this.lastSentText.set(id, text);
    if (!delta) return;
    this.emit(this.eventLog.record({ type: "timeline_delta", sessionId: this.id, itemId: id, delta }));
  }

  private readonly lastSentText = new Map<string, string>();

  /** 为 assistant/thinking/system 消息分配（或复用）稳定 id；其他角色返回 undefined */
  private ensureLiveId(message: Record<string, unknown>): string | undefined {
    const role = String(message.role ?? "");
    const kind = role === "thinking" ? "thinking" : role === "system" ? "system" : role === "assistant" ? "assistant" : undefined;
    if (!kind) return undefined;
    const key = this.liveMessageKey(message);
    let id = this.liveItemIds.get(key);
    if (!id) {
      id = `live-${kind}-${++this.liveSeq}`;
      this.liveItemIds.set(key, id);
    }
    return id;
  }

  private liveMessageKey(message: Record<string, unknown>): string {
    const role = String(message.role ?? "");
    const toolCallId = String(message.toolCallId ?? "");
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
    return `${role}:${toolCallId}:${timestamp}`;
  }

  private liveMessageToTimelineItem(message: Record<string, unknown>): TimelineItem | undefined {
    const role = String(message.role ?? "");
    const timestamp = typeof message.timestamp === "number"
      ? new Date(message.timestamp).toISOString()
      : new Date().toISOString();

    if (role === "toolResult") {
      const toolCallId = String(message.toolCallId ?? "");
      const text = extractText(message.content) || (message.text as string | undefined) || "";
      if (!text) return undefined;
      return {
        id: toolCallId ? `live-tool-${toolCallId}` : `live-tool-${++this.liveSeq}`,
        kind: "tool",
        text,
        createdAt: timestamp,
        toolName: String(message.toolName ?? "tool"),
        ...(toolCallId ? { toolCallId } : {}),
        isError: message.isError === true,
      };
    }

    if (role === "tool" || role === "toolCall") {
      const toolName = String(message.toolName ?? "tool");
      const text = extractText(message.content) || (message.text as string | undefined) || "";
      const toolCallId = String(message.toolCallId ?? "");
      return {
        id: toolCallId ? `live-toolcall-${toolCallId}` : `live-toolcall-${++this.liveSeq}`,
        kind: "tool",
        text: text || `调用 ${toolName}`,
        createdAt: timestamp,
        toolName,
      };
    }

    const kind = role === "thinking" ? "thinking" : role === "system" ? "system" : role === "assistant" ? "assistant" : undefined;
    if (!kind) return undefined; // 未知角色（compactionSummary 等）不投影
    const id = this.ensureLiveId(message);
    if (!id) return undefined;
    const text = extractText(message.content);
    if (!text) return undefined;
    this.lastSentText.delete(id);
    return { id, kind, text, createdAt: timestamp };
  }

  /** 终态条目按 id 替换（同一消息更新时避免重复） */
  private upsertTimelineItem(item: TimelineItem): void {
    const index = this.timeline.findIndex((t) => t.id === item.id);
    if (index >= 0) {
      this.timeline[index] = item;
    } else {
      this.timeline.push(item);
    }
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

  private recordUserMessage(message: string, images?: unknown[]): void {
    const item: TimelineItem = {
      id: `user-${this.eventLog.nextSequence}`,
      kind: "user",
      text: images && images.length > 0 ? `${message}${message ? "\n" : ""}[🖼 ${images.length} 张图片]` : message,
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