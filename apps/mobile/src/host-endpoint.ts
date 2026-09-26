export interface HostEndpoint {
  host: string;
  port: number;
}

export function parseHostEndpoint(input: string, defaultPort = 4739): HostEndpoint {
  const value = input.trim();
  if (!value) throw new Error("请输入 PC 端点地址");

  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  const hostPort = value.match(/^([^:]+)(?::(\d+))?$/);
  const match = bracketed ?? hostPort;
  if (!match) throw new Error("PC 端点地址格式无效");

  const host = match[1].trim();
  const port = Number(match[2] ?? defaultPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PC 端点地址格式无效");
  }
  return { host, port };
}
