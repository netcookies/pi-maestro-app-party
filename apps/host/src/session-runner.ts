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
import { MobileExtensionUiBridge } from "./mobile-ui-context.js";

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
    await this.session.bindExtensions({
      uiContext: this.uiBridge.createContext(),
      onError: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.recordCommandError("extension", message);
      },
    });
    this.unsubscribe = this.session.subscribe((event: unknown) => this.handleSessionEvent(event));
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