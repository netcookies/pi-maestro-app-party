import type { PairingInfo } from "./pairing";
import { buildCandidateUrl } from "./components/ip-picker";

export function isPairingFlowActive(mounted: boolean, cancelled: boolean, signalAborted: boolean): boolean {
  return mounted && !cancelled && !signalAborted;
}

export function shouldBlockPairingBack(state: string, navigationAllowed = false): boolean {
  return state === "saving" && !navigationAllowed;
}

export function requiresCandidateSelection(info: PairingInfo): boolean {
  return info.candidateIps.length > 1;
}

export function resolvePairingCandidate(info: PairingInfo, selectedIp?: string): PairingInfo | null {
  if (requiresCandidateSelection(info) && !selectedIp) return null;
  const ip = selectedIp ?? info.candidateIps[0];
  if (!ip || !info.candidateIps.includes(ip)) return null;
  return { ...info, hostUrl: buildCandidateUrl(info, ip), displayHost: `${ip}:${info.port}` };
}
