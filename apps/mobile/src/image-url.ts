/**
 * 从 host WebSocket URL 构建图片 HTTP URL（纯函数，可测试）
 * ws://host:port/ws → http://host:port/api/file?path=...&token=...
 *
 * P1-5：host 开启 token 后所有路由（含 /api/file）都要求鉴权，
 * 图片 URL 必须携带 ?token=，否则缩略图/预览 401。
 */
export function imageUrlFor(hostUrl: string, path: string, token?: string): string {
  if (!hostUrl || !path) return "";
  const baseUrl = hostUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/ws$/, "");
  const url = `${baseUrl}/api/file?path=${encodeURIComponent(path)}`;
  return token ? `${url}&token=${encodeURIComponent(token)}` : url;
}
