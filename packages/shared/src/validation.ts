import {
  isClientCommand,
  isClientFrame,
  isHostEvent,
  isHostFrame,
  isProtocolHello,
  type ClientCommand,
  type ClientFrame,
  type HostEvent,
  type HostFrame,
  type ProtocolHello,
} from "./protocol.js";
import {
  isDesktopPluginClientFrame,
  isDesktopPluginServerFrame,
  isDesktopAskResult,
  type DesktopAskResult,
  type DesktopPluginClientFrame,
  type DesktopPluginServerFrame,
} from "./desktop-plugin-protocol.js";

export function validateHostEvent(value: unknown): HostEvent {
  if (!isHostEvent(value)) {
    throw new Error("Invalid HostEvent: unknown type or malformed fields");
  }
  return value;
}

export function validateClientCommand(value: unknown): ClientCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid ClientCommand: missing type");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") {
    throw new Error("Invalid ClientCommand: missing type");
  }
  if (record.id !== undefined && typeof record.id !== "string") {
    throw new Error("Invalid ClientCommand: id must be a string when present");
  }
  if (!isClientCommand(value)) {
    throw new Error("Invalid ClientCommand: unknown type or malformed fields");
  }
  return value;
}

export function validateClientFrame(value: unknown): ClientFrame {
  if (!isClientFrame(value)) {
    throw new Error("Invalid ClientFrame: protocol_hello or v2 command required");
  }
  return value;
}

export function validateProtocolHello(value: unknown): ProtocolHello {
  if (!isProtocolHello(value)) {
    throw new Error("Invalid protocol_hello: Protocol v2 handshake required");
  }
  return value;
}

export function validateHostFrame(value: unknown): HostFrame {
  if (!isHostFrame(value)) {
    throw new Error("Invalid HostFrame: unknown type or malformed fields");
  }
  return value;
}

export function validateDesktopPluginClientFrame(value: unknown): DesktopPluginClientFrame {
  if (!isDesktopPluginClientFrame(value)) {
    throw new Error("Invalid Desktop Plugin client frame");
  }
  return value;
}

export function validateDesktopPluginServerFrame(value: unknown): DesktopPluginServerFrame {
  if (!isDesktopPluginServerFrame(value)) {
    throw new Error("Invalid Desktop Plugin server frame");
  }
  return value;
}

export function validateDesktopAskResult(value: unknown): DesktopAskResult {
  if (!isDesktopAskResult(value)) throw new Error("Invalid Desktop ask result");
  return value;
}

/**
 * 验证 JSON 可序列化。
 */
export function validateJsonSerializable(value: unknown): void {
  try {
    JSON.stringify(value);
  } catch {
    throw new Error("Value is not JSON-serializable");
  }
}
