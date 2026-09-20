#!/usr/bin/env node
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { DesktopBroker, DesktopBrokerHostClient } from "./plugin/desktop-broker.js";
import {
  DEFAULT_DESKTOP_BROKER_HOST_SOCKET,
  DEFAULT_DESKTOP_BROKER_PID_FILE,
  DEFAULT_DESKTOP_BROKER_PLUGIN_SOCKET,
  DEFAULT_DESKTOP_BROKER_REGISTRY_FILE,
  DEFAULT_DESKTOP_BROKER_SECRET_FILE,
} from "./plugin/desktop-broker-supervisor.js";

interface BrokerArgs {
  secretFile: string;
  pluginSocket: string;
  hostSocket: string;
  registry: string;
  pidFile: string;
}

function parseArgs(argv: string[]): BrokerArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    values.set(key, value);
    index += 1;
  }
  return {
    secretFile: values.get("secret-file") ?? DEFAULT_DESKTOP_BROKER_SECRET_FILE,
    pluginSocket: values.get("plugin-socket") ?? DEFAULT_DESKTOP_BROKER_PLUGIN_SOCKET,
    hostSocket: values.get("host-socket") ?? DEFAULT_DESKTOP_BROKER_HOST_SOCKET,
    registry: values.get("registry") ?? DEFAULT_DESKTOP_BROKER_REGISTRY_FILE,
    pidFile: values.get("pid-file") ?? DEFAULT_DESKTOP_BROKER_PID_FILE,
  };
}

async function readSecret(path: string): Promise<string> {
  const secret = (await readFile(path, "utf8")).trim();
  if (secret.length < 24) throw new Error("desktop broker secret is missing or too short");
  return secret;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const secret = await readSecret(args.secretFile);
  const broker = new DesktopBroker({
    pluginSocketPath: args.pluginSocket,
    registryPath: args.registry,
    secret,
  });
  const hostClient = new DesktopBrokerHostClient(broker, { socketPath: args.hostSocket, secret });
  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[maestro-mobile-broker] received ${reason}, shutting down...`);
    hostClient.close();
    await broker.close().catch(() => undefined);
    try {
      const current = (await readFile(args.pidFile, "utf8")).trim();
      if (current === String(process.pid)) await unlink(args.pidFile);
    } catch {
      // PID file may have been removed by the supervisor.
    }
    process.exit(exitCode);
  };
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("uncaughtException", (error) => {
    console.error("[maestro-mobile-broker] uncaught exception", error);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[maestro-mobile-broker] unhandled rejection", reason);
    void shutdown("unhandledRejection", 1);
  });

  await broker.start();
  await writeFile(args.pidFile, `${process.pid}\n`, { mode: 0o600 });
  await chmod(args.pidFile, 0o600);
  hostClient.start();
  console.log(`[maestro-mobile-broker] plugin socket ${args.pluginSocket}`);
}

main().catch((error) => {
  console.error("[maestro-mobile-broker] fatal", error);
  process.exit(1);
});
