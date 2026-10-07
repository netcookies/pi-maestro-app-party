export {
  validateClientCommand,
  validateClientFrame,
  validateHostEvent,
  validateHostFrame,
  validateJsonSerializable,
  validateProtocolHello,
} from "@maestro-mobile/mobile-sdk/protocol";

import {
  isDesktopPluginClientFrame,
  isDesktopPluginServerFrame,
  isDesktopAskResult,
  type DesktopAskResult,
  type DesktopPluginClientFrame,
  type DesktopPluginServerFrame,
} from "./desktop-plugin-protocol.js";

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
