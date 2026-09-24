import { isHostError, type HostError, type JsonValue } from "@maestro-mobile/shared";

const MAX_SOURCE_TEXT = 1200;
const SECRET_PATTERNS = [
  /(Bearer\s+)["']?[A-Za-z0-9._~+\/-]+=*["']?/gi,
  /(["']?\b(?:api[_-]?key|token|authorization|password|secret)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
  /([?&](?:token|key|secret|password)=)[^&\s]+/gi,
];
const DEFAULT_CODES: Record<HostError["source"], string> = {
  model: "model_error",
  provider: "provider_error",
  command: "host_command_failed",
  transport: "desktop_confirmation_unavailable",
  extension: "extension_error",
  protocol: "protocol_error",
  tool: "tool_error",
};

function safeText(value: string): string {
  let text = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "$1[REDACTED]");
  return text.slice(0, MAX_SOURCE_TEXT);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validSource(value: unknown): value is HostError["source"] {
  return value === "model" || value === "provider" || value === "command" || value === "transport"
    || value === "extension" || value === "protocol" || value === "tool";
}

/** Normalize only explicit status fields or the known provider's `API error (N):` syntax. */
export function normalizeHostError(error: unknown, fallbackSource: HostError["source"] = "provider"): HostError {
  const sourceError = record(error);
  const existing = isHostError(error) ? error : undefined;
  const response = record(sourceError?.response);
  const rawMessage = error instanceof Error
    ? error.message
    : stringField(sourceError?.message) ?? stringField(sourceError?.errorMessage)
      ?? (typeof error === "string" ? error : String(error));
  const message = safeText(rawMessage || "Unknown error");
  const explicit = [sourceError?.status, sourceError?.statusCode, response?.status]
    .find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  const syntax = rawMessage.match(/\bAPI error \((\d{3})\):\s*(.*)$/s);
  const status = explicit ?? (syntax ? Number(syntax[1]) : undefined);
  let parsed: Record<string, unknown> | undefined;
  const candidate = syntax?.[2]?.trim();
  if (candidate?.startsWith("{")) {
    try { parsed = JSON.parse(candidate) as Record<string, unknown>; } catch { /* keep bounded source text */ }
  }
  const responseData = record(response?.data);
  parsed = parsed ?? responseData;
  const code = stringField(sourceError?.code) ?? existing?.code ?? stringField(parsed?.code) ?? DEFAULT_CODES[fallbackSource];
  const providerSyntax = rawMessage.match(/Error:\s*([A-Za-z0-9._-]+)\s+API error/);
  const provider = stringField(sourceError?.provider) ?? existing?.provider ?? stringField(parsed?.provider) ?? providerSyntax?.[1];
  const bodyMessage = stringField(parsed?.message);
  const sourceText = safeText(rawMessage || existing?.details && typeof existing.details === "object" && !Array.isArray(existing.details) && stringField(existing.details.sourceText) || "Unknown error");
  const details: Record<string, JsonValue> = { sourceText };
  if (stringField(parsed?.code)) details.providerCode = safeText(parsed!.code as string);
  return {
    code: safeText(code),
    message: bodyMessage ? safeText(bodyMessage) : message,
    source: existing?.source ?? (validSource(sourceError?.source) ? sourceError.source : fallbackSource),
    ...(status !== undefined ? { httpStatus: status } : existing?.httpStatus !== undefined ? { httpStatus: existing.httpStatus } : {}),
    ...(provider ? { provider: safeText(provider) } : {}),
    ...(stringField(sourceError?.model) ?? existing?.model ? { model: safeText((stringField(sourceError?.model) ?? existing?.model) as string) } : {}),
    ...(stringField(parsed?.type) ?? stringField(sourceError?.type) ?? existing?.type ? { type: safeText((stringField(parsed?.type) ?? stringField(sourceError?.type) ?? existing?.type) as string) } : {}),
    ...(typeof sourceError?.retryable === "boolean" ? { retryable: sourceError.retryable } : existing?.retryable !== undefined ? { retryable: existing.retryable } : {}),
    ...(stringField(sourceError?.requestId) ?? existing?.requestId ? { requestId: safeText((stringField(sourceError?.requestId) ?? existing?.requestId) as string) } : {}),
    details,
  };
}

/** Safely obtain a message without discarding structured fields for callers that need them. */
export function safeErrorMessage(error: unknown): string {
  return normalizeHostError(error, "command").message;
}
