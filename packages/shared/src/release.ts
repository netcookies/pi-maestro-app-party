export const MOBILE_RELEASE_VERSION = "0.4.0" as const;

export type MobileRolloutMode = "disabled" | "shadow" | "enabled";

const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && RELEASE_VERSION_RE.test(value);
}

export function isCompatibleReleaseVersion(
  value: unknown,
  expected: string = MOBILE_RELEASE_VERSION,
): boolean {
  return isReleaseVersion(value) && value === expected;
}

export function parseRolloutMode(
  value: unknown,
  fallback: MobileRolloutMode = "enabled",
): MobileRolloutMode {
  return value === "disabled" || value === "shadow" || value === "enabled" ? value : fallback;
}

export interface MobileReleaseContract {
  releaseVersion: string;
  protocolVersion: 2;
  rolloutMode: MobileRolloutMode;
}
