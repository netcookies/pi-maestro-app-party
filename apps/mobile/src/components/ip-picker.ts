/** 拼 wcandidate：把 PairingInfo 的 hostUrl 替换为指定 IP 的同端口地址 */
export function buildCandidateUrl(info: { hostUrl: string; port: string }, ip: string): string {
  try {
    const u = new URL(info.hostUrl);
    u.hostname = ip;
    u.port = info.port;
    return u.toString();
  } catch {
    return info.hostUrl;
  }
}
