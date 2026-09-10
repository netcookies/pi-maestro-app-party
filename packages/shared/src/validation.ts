import { isHostEvent, isClientCommand, type HostEvent, type ClientCommand } from "./protocol.js";

export function validateHostEvent(value: unknown): HostEvent {
  if (!isHostEvent(value)) {
    throw new Error("Invalid HostEvent: missing type or seq");
  }
  return value;
}

export function validateClientCommand(value: unknown): ClientCommand {
  if (!isClientCommand(value)) {
    throw new Error("Invalid ClientCommand: missing type");
  }
  // P3-2 收紧（向后兼容）：id 不在 ClientCommand 类型联合里声明（protocol.ts:342-368），
  // 它是宿主侧可选的「回显定位符」：服务端把 command.id 原样写入 in_reply_to，
  // 客户端靠它匹配 pendingCommands（host-client.ts:263）。
  // 非字符串 id 会被服务端归一为空串 → 客户端匹配不到 → 该命令挂满 30s 超时，
  // 所以下沉到这里拦住。现有客户端不受影响：mobile 自生成 id 恒为 `cmd-N` 字符串
  // （host-client.ts:106），不带 id 的载荷也仍然合法。
  const id = (value as { id?: unknown }).id;
  if (id !== undefined && typeof id !== "string") {
    throw new Error("Invalid ClientCommand: id must be a string when present");
  }
  return value;
}

/**
 * 验证 JSON 可序列化
 */
export function validateJsonSerializable(value: unknown): void {
  try {
    JSON.stringify(value);
  } catch {
    throw new Error("Value is not JSON-serializable");
  }
}