/**
 * 从 host WebSocket URL 构建图片 HTTP URL（纯函数，可测试）
 * ws://host:port/ws → http://host:port/api/file?path=...
 */
export function imageUrlFor(hostUrl: string, path: string): string {
  if (!hostUrl || !path) return "";
  const baseUrl = hostUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/ws$/, "");
  return `${baseUrl}/api/file?path=${encodeURIComponent(path)}`;
}