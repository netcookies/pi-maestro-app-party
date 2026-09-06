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