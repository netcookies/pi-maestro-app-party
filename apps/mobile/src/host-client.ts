/**
 * Compatibility entrypoint for the pre-SDK app imports.
 * The transport/session implementation lives in @maestro-mobile/mobile-sdk.
 */
export {
  HostClient,
  MobileClient,
  calculateBackoffDelay,
  CommandConnectionLostError,
  ProtocolNotReadyError,
  WS_OPEN,
} from "@maestro-mobile/mobile-sdk";
export type {
  ConnectionState,
  HostClientOptions,
  MobileClientOptions,
  WebSocketLike,
} from "@maestro-mobile/mobile-sdk";
