/** Breaking wire compatibility gate. Bump only when protocol shapes are incompatible. */
export const MOBILE_PROTOCOL_MAJOR = 2 as const;
export const MOBILE_PROTOCOL_REVISION = 0 as const;
export const MOBILE_PROTOCOL_VERSION = MOBILE_PROTOCOL_MAJOR;
export type MobileProtocolVersion = typeof MOBILE_PROTOCOL_VERSION;

/** Independent client runtime package version. It is diagnostic metadata, not a handshake gate. */
export const MOBILE_SDK_VERSION = "1.0.0" as const;
/** Product/app version used for diagnostics and legacy release bridging only. */
export const MOBILE_PRODUCT_VERSION = "0.11.0" as const;
/** @deprecated Use MOBILE_PRODUCT_VERSION for product metadata. */
export const MOBILE_RELEASE_VERSION = MOBILE_PRODUCT_VERSION;

export type MobileRolloutMode = "disabled" | "shadow" | "enabled";

const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && RELEASE_VERSION_RE.test(value);
}

/**
 * Legacy exact-match helper retained for the bridge period only.
 * New Mobile protocol handshakes must use isCompatibleProtocolVersion and capabilities.
 */
export function isCompatibleReleaseVersion(
  value: unknown,
  expected: string = MOBILE_RELEASE_VERSION,
): boolean {
  return isReleaseVersion(value) && value === expected;
}

export function isCompatibleProtocolVersion(
  value: unknown,
  expected: number = MOBILE_PROTOCOL_MAJOR,
): value is MobileProtocolVersion {
  return typeof value === "number" && Number.isInteger(value) && value === expected;
}

export function isProtocolRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseRolloutMode(
  value: unknown,
  fallback: MobileRolloutMode = "enabled",
): MobileRolloutMode {
  return value === "disabled" || value === "shadow" || value === "enabled" ? value : fallback;
}

export interface MobileProtocolContract {
  protocolVersion: MobileProtocolVersion;
  protocolRevision: number;
}

export interface MobileReleaseContract {
  /** @deprecated Product metadata only; not a compatibility gate. */
  releaseVersion: string;
  protocolVersion: MobileProtocolVersion;
  rolloutMode: MobileRolloutMode;
}
