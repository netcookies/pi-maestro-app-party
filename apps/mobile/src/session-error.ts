import type { HostError } from "@maestro-mobile/shared";

export interface SessionErrorPresentation {
  title: string;
  provider?: string;
  httpStatus?: number;
  message: string;
  type?: string;
  code?: string;
  sourceText?: string;
}

export function sessionErrorPresentation(error: HostError | undefined, fallbackText: string): SessionErrorPresentation {
  const sourceText = typeof error?.details === "object" && error.details !== null && !Array.isArray(error.details)
    && typeof error.details.sourceText === "string"
    ? error.details.sourceText
    : undefined;
  return {
    title: error?.source === "provider" || error?.source === "model" ? "模型请求失败" : "错误",
    ...(error?.provider ? { provider: error.provider } : {}),
    ...(error?.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
    message: error?.message || fallbackText,
    ...(error?.type ? { type: error.type } : {}),
    ...(error?.code ? { code: error.code } : {}),
    ...(sourceText && sourceText !== error?.message ? { sourceText } : {}),
  };
}
