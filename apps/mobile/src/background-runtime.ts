interface BackgroundRuntimeModule {
  beginGracePeriod?: (name: string) => Promise<void>;
  endGracePeriod?: () => Promise<void>;
  startBackgroundService?: (url: string, token?: string) => Promise<void>;
  stopBackgroundService?: () => Promise<void>;
}

interface ReactNativeRuntime {
  Platform?: { OS?: string };
  NativeModules?: { MaestroBackgroundRuntime?: BackgroundRuntimeModule };
}

function runtime(): ReactNativeRuntime | undefined {
  try {
    // Keep Node/Vitest able to import Store without parsing React Native Flow sources.
    return require("react-native") as ReactNativeRuntime;
  } catch {
    return undefined;
  }
}

function nativeModule(): BackgroundRuntimeModule | undefined {
  return runtime()?.NativeModules?.MaestroBackgroundRuntime;
}

export function isAndroidRuntime(): boolean {
  return runtime()?.Platform?.OS === "android";
}

export function isIosRuntime(): boolean {
  return runtime()?.Platform?.OS === "ios";
}

export async function beginGracePeriod(name = "Maestro Mobile background sync"): Promise<void> {
  await nativeModule()?.beginGracePeriod?.(name);
}

export async function endGracePeriod(): Promise<void> {
  await nativeModule()?.endGracePeriod?.();
}

export async function startBackgroundService(url: string, token?: string): Promise<void> {
  await nativeModule()?.startBackgroundService?.(url, token);
}

export async function stopBackgroundService(): Promise<void> {
  await nativeModule()?.stopBackgroundService?.();
}
