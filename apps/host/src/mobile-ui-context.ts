import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiRequest, ExtensionUiResponse, HostEvent } from "@maestro-mobile/shared";

/**
 * MobileExtensionUiBridge — 将 Pi SDK 的 ExtensionUIContext 桥接到移动端
 *
 * 这是解决 maestro ask-user-question 在 remote 环境失效的核心：
 * - maestro 的 ask 工具在 RPC 模式下调用 ctx.ui.select/input/confirm
 * - 本 bridge 将这些调用转为 extension_ui_request 事件，通过 WS 推给移动端
 * - 移动端弹窗渲染，用户作答后返回 extension_ui_response
 */
export class MobileExtensionUiBridge {
  private readonly pendingDialogs = new Map<string, {
    resolve(response: ExtensionUiResponse): void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: HostEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  createContext(): ExtensionUIContext {
    const context: ExtensionUIContext = {
      select: (title, options, opts) =>
        this.dialog(
          {
            method: "select",
            title,
            options,
            ...(opts?.timeout ? { timeout: opts.timeout } : {}),
          },
          (response) => {
            if (response.cancelled) return undefined;
            // select 为单选：优先 value（字符串）；兼容 selected 数组取其首项
            if ("value" in response && typeof response.value === "string") return response.value;
            if ("selected" in response) return response.selected[0];
            return undefined;
          },
        ),
      confirm: (title, message, opts) =>
        this.dialog(
          {
            method: "confirm",
            title,
            ...(message ? { message } : {}),
            ...(opts?.timeout ? { timeout: opts.timeout } : {}),
          },
          (response) => {
            if (response.cancelled) return false;
            return "confirmed" in response ? response.confirmed === true : false;
          },
        ),
      input: (title, placeholder, opts) =>
        this.dialog(
          {
            method: "input",
            title,
            ...(placeholder ? { placeholder } : {}),
            ...(opts?.timeout ? { timeout: opts.timeout } : {}),
          },
          (response) => {
            if (response.cancelled) return undefined;
            return "value" in response ? response.value : undefined;
          },
        ),
      editor: (title, prefill) =>
        this.dialog(
          { method: "editor", title, ...(prefill ? { prefill } : {}) },
          (response) => {
            if (response.cancelled) return undefined;
            return "value" in response ? response.value : undefined;
          },
        ),
      notify: (message, type) => {
        this.recordFireAndForget({ method: "notify", message, ...(type ? { notifyType: type } : {}) });
      },
      setStatus: (key, text) => {
        this.recordFireAndForget({ method: "setStatus", statusKey: key, ...(text ? { statusText: text } : {}) });
      },
      setWidget: (key, content, options) => {
        if (content === undefined || Array.isArray(content)) {
          this.recordFireAndForget({
            method: "setWidget",
            widgetKey: key,
            ...(content ? { widgetLines: content } : {}),
            ...(options?.placement ? { widgetPlacement: options.placement } : {}),
          });
        }
      },
      setTitle: (title) => {
        this.recordFireAndForget({ method: "setTitle", title });
      },
      setEditorText: (text) => {
        this.recordFireAndForget({ method: "set_editor_text", text });
      },
      pasteToEditor: (text) => {
        context.setEditorText(text);
      },
      getEditorText: () => "",
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setFooter: () => {},
      setHeader: () => {},
      custom: async <T,>() => undefined as T,
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: {} as ExtensionUIContext["theme"],
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching not supported by maestro-mobile host" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
    return context;
  }

  respond(requestId: string, response: ExtensionUiResponse): boolean {
    const pending = this.pendingDialogs.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pendingDialogs.delete(requestId);
    pending.resolve(response);
    this.emit({
      type: "extension_ui_cleared",
      sessionId: this.sessionId,
      requestId,
      seq: this.now(),
    });
    return true;
  }

  /** 关闭所有挂起的弹窗（会话中止/关闭时调用），返回已取消的数量 */
  cancelAll(): number {
    let count = 0;
    for (const [requestId, pending] of this.pendingDialogs) {
      clearTimeout(pending.timeout);
      pending.resolve({ id: requestId, cancelled: true });
      count++;
    }
    this.pendingDialogs.clear();
    return count;
  }

  get pendingCount(): number {
    return this.pendingDialogs.size;
  }

  private dialog<T>(
    request: Omit<ExtensionUiRequest, "id" | "sessionId">,
    parse: (response: ExtensionUiResponse) => T,
  ): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve) => {
      const timeoutMs = typeof request.timeout === "number" ? request.timeout : 120_000;
      const timeout = setTimeout(() => {
        this.pendingDialogs.delete(id);
        resolve(parse({ id, cancelled: true }));
      }, timeoutMs);
      this.pendingDialogs.set(id, {
        resolve: (response) => resolve(parse(response)),
        timeout,
      });
      this.recordRequest({ id, sessionId: this.sessionId, ...request });
    });
  }

  private recordFireAndForget(request: Omit<ExtensionUiRequest, "id" | "sessionId">): void {
    this.recordRequest({ id: randomUUID(), sessionId: this.sessionId, ...request });
  }

  private recordRequest(request: ExtensionUiRequest): void {
    this.emit({
      type: "extension_ui_request",
      sessionId: this.sessionId,
      request,
      seq: this.now(),
    });
  }
}