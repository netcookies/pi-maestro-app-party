import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

const ASK_RESPONSE_PREFIX = "pi-ask-response-";
const ASK_RESPONSE_SUFFIX = ".json";
const MAX_FILENAME_COMPONENT_BYTES = 240;
const SAFE_TOOL_CALL_ID = /^[A-Za-z0-9._:|-]+$/;
const ASK_RESPONSE_TEMP_PREFIX = "pi-ask-response-tmp-";
const ASK_RESPONSE_TEMP_SUFFIX = ".tmp";
const MAX_TEMP_FILENAME_COMPONENT_BYTES = 64;

export function resolveAskResponseFilename(rawToolCallId: string): string | undefined {
  if (!rawToolCallId || rawToolCallId === "." || rawToolCallId === ".." || !SAFE_TOOL_CALL_ID.test(rawToolCallId)) {
    return undefined;
  }
  const filename = `${ASK_RESPONSE_PREFIX}${rawToolCallId}${ASK_RESPONSE_SUFFIX}`;
  return Buffer.byteLength(filename, "utf8") <= MAX_FILENAME_COMPONENT_BYTES ? filename : undefined;
}

export function resolveAskResponsePath(rawToolCallId: string, directory: string): string | undefined {
  if (!isAbsolute(directory) || directory.includes("\0")) return undefined;
  const filename = resolveAskResponseFilename(rawToolCallId);
  return filename === undefined ? undefined : join(directory, filename);
}

export function createAskResponseTempFilename(): string {
  const filename = `${ASK_RESPONSE_TEMP_PREFIX}${randomUUID()}${ASK_RESPONSE_TEMP_SUFFIX}`;
  if (Buffer.byteLength(filename, "utf8") > MAX_TEMP_FILENAME_COMPONENT_BYTES) {
    throw new Error("ask response temporary filename exceeds component limit");
  }
  return filename;
}
