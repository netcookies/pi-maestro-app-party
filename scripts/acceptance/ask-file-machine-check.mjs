#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith("--")) continue;
  const next = process.argv[index + 1];
  args.set(value.slice(2), next && !next.startsWith("--") ? next : true);
  if (next && !next.startsWith("--")) index += 1;
}
const repoRoot = resolve(args.get("repo-root") || resolve(fileURLToPath(new URL("../..", import.meta.url))));
const flowRoot = resolve(args.get("flow-root") || "");
const hostDist = resolve(args.get("host-dist") || "");
const runner = resolve(args.get("runner") || "");
const FLOW_PACKAGE_MANIFEST_SHA256 = "4593f0c191032f98dc21332ddef8e578bdb0b2ae6562b28dedbe55825e1502f1";
const FLOW_BASELINE = Object.freeze({
  "src/tools/ask.ts": "57835002110720ebc67c26dd2bac778017f1b50899cdb8e37358c62ea26bb066",
  "src/extension/index.ts": "432251caad9bc7d2b57e128dc6699f5708d8a31e538ae8e410c431a5fd8585e4",
});
const FLOW_ABSENT = Object.freeze(["src/tools/ask-file-bridge.ts", "test/ask-file-bridge.test.ts"]);
const read = async (path) => readFile(path, "utf8");
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const requireFile = async (path, label) => {
  if (!path || !existsSync(path) || !(await stat(path)).isFile()) throw new Error(`${label} missing: ${path}`);
};
const requireText = async (path, pattern, label) => {
  const text = await read(path);
  if (!text.includes(pattern)) throw new Error(`${label} missing ${pattern}`);
};
async function readJsonLines(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
const sameTarget = (left, right) => Boolean(left && right && left.sessionId === right.sessionId && left.endpointId === right.endpointId && left.normalizedCwd === right.normalizedCwd && left.processGeneration === right.processGeneration);
const legacyFilename = (toolCallId) => `pi-ask-response-${toolCallId}.json`;

async function independentCaseCheck(evidence, caseFile, caseData) {
  const caseName = basename(caseFile, ".json").replace(/^ask-/, "");
  const frames = await readJsonLines(join(evidence, `ask-${caseName}.frames.jsonl`));
  const target = caseData.target;
  const requestId = caseData.requestId;
  const toolCallId = caseData.toolCallId;
  const hostRequestId = caseData.hostRequestId;
  const plugin = frames.filter((entry) => entry.source === "plugin" && ["adapter_register", "adapter_answer"].includes(entry.event) && entry.toolCallId === toolCallId);
  const pluginRegister = plugin.filter((entry) => entry.event === "adapter_register");
  const pluginAnswer = plugin.filter((entry) => entry.event === "adapter_answer");
  const hostAsk = frames.filter((entry) => entry.source === "host" && entry.event === "ask_request" && sameTarget(entry.target, target) && entry.request?.requestId === requestId && entry.request?.toolCallId === toolCallId);
  const gateway = frames.filter((entry) => entry.source === "host" && entry.event === "gateway_ask_result" && sameTarget(entry.target, target) && entry.requestId === requestId && entry.toolCallId === toolCallId);
  const brokerAsk = frames.filter((entry) => entry.source === "broker" && entry.frame?.type === "desktop_broker_ask_request" && sameTarget(entry.frame.target, target) && entry.frame.request?.requestId === requestId && entry.frame.request?.toolCallId === toolCallId);
  const brokerResult = frames.filter((entry) => entry.source === "broker" && entry.frame?.type === "desktop_broker_ask_result" && sameTarget(entry.frame.target, target) && entry.frame.result?.requestId === requestId && entry.frame.result?.toolCallId === toolCallId);
  const mobileRequest = frames.filter((entry) => entry.source === "mobile" && entry.frame?.type === "extension_ui_request" && sameTarget(entry.frame.target, target) && entry.frame.request?.id === hostRequestId);
  const mobileResponse = frames.filter((entry) => entry.source === "mobile" && entry.frame?.type === "extension_ui_response" && sameTarget(entry.frame.target, target) && entry.frame.requestId === hostRequestId);
  const mobileClear = frames.filter((entry) => entry.source === "mobile" && entry.frame?.type === "extension_ui_cleared" && sameTarget(entry.frame.target, target) && entry.frame.requestId === hostRequestId);
  const expectedAnswers = caseName === "expired" ? 0 : caseName === "retry" ? 2 : 1;
  const expectedResults = expectedAnswers;
  const counts = { pluginRegister: pluginRegister.length, pluginAnswer: pluginAnswer.length, hostAsk: hostAsk.length, gateway: gateway.length, brokerAsk: brokerAsk.length, brokerResult: brokerResult.length, mobileRequest: mobileRequest.length, mobileResponse: mobileResponse.length, mobileClear: mobileClear.length };
  const targetAndIds = Boolean(caseData.requestId === `question:${toolCallId}` && toolCallId.includes("|") && hostAsk.length === 1 && brokerAsk.length === 1 && mobileRequest.length === 1 && mobileRequest[0].frame.request?.questions?.length > 0);
  const exactCounts = counts.pluginRegister === 1 && counts.pluginAnswer === expectedAnswers && counts.hostAsk === 1 && counts.gateway === expectedResults && counts.brokerAsk === 1 && counts.brokerResult === expectedResults && counts.mobileRequest === 1 && counts.mobileResponse === (caseName === "expired" ? 1 : caseName === "retry" ? 2 : 1) && counts.mobileClear === 1;
  const noFiles = Array.isArray(caseData.responseFiles) && caseData.responseFiles.length === 0;
  const accepted = caseName === "accepted" && pluginAnswer[0]?.result?.status === "accepted" && brokerResult[0]?.frame.result?.status === "accepted" && gateway[0]?.result?.status === "accepted" && pluginAnswer[0]?.result?.path?.endsWith(legacyFilename(toolCallId));
  const retry = caseName === "retry" && pluginAnswer[0]?.result?.error?.code === "response_write_failed" && pluginAnswer[1]?.result?.status === "accepted" && brokerResult[0]?.frame.result?.error?.code === "plugin_ask_rejected" && brokerResult[0]?.frame.result?.error?.message === "response_write_failed" && brokerResult[1]?.frame.result?.status === "accepted" && gateway[0]?.result?.error?.code === "plugin_ask_rejected" && gateway[0]?.result?.error?.message === "response_write_failed" && gateway[1]?.result?.status === "accepted" && caseData.failureInjection?.blockerCreated === true && caseData.failureInjection?.blockerRemoved === true;
  const expired = caseName === "expired" && caseData.lateResult?.error?.code === "request_not_found" && pluginAnswer.length === 0 && brokerResult.length === 0 && gateway.length === 0 && caseData.postDeadlineReceipts?.length === 0 && caseData.resurrectionCount === 0;
  return { caseName, counts, targetAndIds, exactCounts, noFiles, behavior: Boolean(accepted || retry || expired), pass: caseData.pass === true && caseData.status === "passed" && targetAndIds && exactCounts && noFiles && Boolean(accepted || retry || expired) };
}

async function verifyFlowBaseline(provenance, flowRoot) {
  if (await sha256(join(flowRoot, "package.json")) !== FLOW_PACKAGE_MANIFEST_SHA256) {
    throw new Error("consumer package manifest baseline mismatch");
  }
  if (provenance?.package?.manifestSha256 !== undefined && provenance.package.manifestSha256 !== FLOW_PACKAGE_MANIFEST_SHA256) {
    throw new Error("consumer package manifest provenance mismatch");
  }
  for (const [path, expected] of Object.entries(FLOW_BASELINE)) {
    if (provenance && provenance.preEdit?.[path] !== expected) throw new Error(`consumer provenance baseline mismatch: ${path}`);
    if (await sha256(join(flowRoot, path)) !== expected) throw new Error(`consumer baseline hash mismatch: ${path}`);
  }
  for (const path of FLOW_ABSENT) {
    if (provenance && provenance.preEdit?.[path] !== null) throw new Error(`consumer provenance must declare absent: ${path}`);
    if (existsSync(join(flowRoot, path))) throw new Error(`unexpected consumer file remains: ${path}`);
  }
}

async function verifyProvenance(provenance, flowRoot, hostDist) {
  await verifyFlowBaseline(provenance, flowRoot);
  for (const [path, expected] of Object.entries(provenance.hostDist ?? {})) if (expected && await sha256(join(hostDist, path)) !== expected) throw new Error(`Host dist provenance hash mismatch: ${path}`);
  const pi = provenance.pi;
  if (!pi?.path || !pi.realpath || resolve(pi.path) !== pi.realpath || !existsSync(pi.path)) throw new Error("pi executable provenance missing or changed");
  const version = spawnSync(pi.path, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== pi.version) throw new Error("pi executable version provenance mismatch");
}

async function staticCheck() {
  await requireFile(join(repoRoot, "scripts/acceptance/ask-file-golden-vectors.json"), "compatibility vectors");
  await requireFile(join(repoRoot, "apps/host/src/plugin/ask-response-file.ts"), "Host response helper");
  await requireFile(join(flowRoot, "src/tools/ask.ts"), "Flow ask tool");
  await requireFile(join(flowRoot, "src/extension/index.ts"), "Flow extension");
  await verifyFlowBaseline(undefined, flowRoot);
  await requireFile(join(hostDist, "plugin/desktop-plugin-extension.js"), "Host extension dist");
  await requireFile(runner, "acceptance runner");
  for (const distFile of [
    join(hostDist, "plugin/ask-response-file.js"),
    join(hostDist, "plugin/desktop-flow-ask-adapter.js"),
  ]) {
    await requireFile(distFile, "rebuilt Host response dist");
  }
  await requireText(join(hostDist, "plugin/ask-response-file.js"), "pi-ask-response-", "legacy response prefix");
  await requireText(join(hostDist, "plugin/ask-response-file.js"), "SAFE_TOOL_CALL_ID", "Host tool-call ID allow-list");
  await requireText(join(repoRoot, "apps/host/src/plugin/ask-response-file.ts"), "resolveAskResponseFilename", "Host response helper");
  const vectors = JSON.parse(await read(join(repoRoot, "scripts/acceptance/ask-file-golden-vectors.json")));
  const helper = await import(`${pathToFileURL(join(hostDist, "plugin/ask-response-file.js")).href}?acceptance=${Date.now()}`);
  if (typeof helper.resolveAskResponseFilename !== "function") throw new Error("rebuilt Host response helper export missing");
  for (const vector of vectors.accepted ?? []) {
    if (helper.resolveAskResponseFilename(vector.raw) !== vector.filename) throw new Error(`accepted compatibility vector failed: ${vector.name}`);
  }
  for (const raw of vectors.rejected ?? []) {
    if (helper.resolveAskResponseFilename(raw) !== undefined) throw new Error(`unsafe compatibility vector accepted: ${JSON.stringify(raw)}`);
  }
  const acceptedBoundary = "a".repeat(vectors.boundary?.acceptedToolCallIdBytes ?? 0);
  const rejectedBoundary = "a".repeat(vectors.boundary?.rejectedToolCallIdBytes ?? 0);
  const acceptedBoundaryFilename = helper.resolveAskResponseFilename(acceptedBoundary);
  if (!acceptedBoundaryFilename || Buffer.byteLength(acceptedBoundaryFilename, "utf8") !== vectors.maxFilenameComponentBytes) throw new Error("accepted filename boundary failed");
  if (helper.resolveAskResponseFilename(rejectedBoundary) !== undefined) throw new Error("rejected filename boundary failed");
  await requireText(join(flowRoot, "src/tools/ask.ts"), "`/tmp/pi-ask-response-${reqId}.json`", "unchanged Flow request path");
  await requireText(join(flowRoot, "src/tools/ask.ts"), "`/tmp/pi-ask-response-${cleanId}.json`", "unchanged Flow clean path");
  await requireText(join(flowRoot, "src/extension/index.ts"), "requestId: `question:${_id}`", "unchanged Flow request identity");
  const forbiddenByFile = new Map([
    [join(repoRoot, "apps/host/src/plugin/ask-response-file.ts"), [/base64url/, /createHash/, /digest\(/]],
    [join(repoRoot, "apps/host/src/plugin/desktop-flow-ask-adapter.ts"), [/PI_ASK_RESPONSE_DIR/]],
    [join(flowRoot, "src/tools/ask.ts"), [/PI_ASK_RESPONSE_DIR/, /resolveAskResponsePath/, /ask-file-bridge/, /toolCallId\?: string/]],
    [join(flowRoot, "src/extension/index.ts"), [/toolCallId: _id/]],
  ]);
  for (const [file, forbidden] of forbiddenByFile) {
    const text = await read(file);
    for (const pattern of forbidden) {
      if (pattern.test(text)) throw new Error(`${file} contains forbidden compatibility pattern ${pattern}`);
    }
  }
  if ((await read(runner)).match(/registerTool|addTool/)) throw new Error("acceptance runner registers a substitute tool");
  return { status: "passed", files: [
    join(repoRoot, "apps/host/src/plugin/ask-response-file.ts"),
    join(flowRoot, "src/tools/ask.ts"),
    join(flowRoot, "src/extension/index.ts"),
    runner,
  ] };
}

async function liveCheck() {
  const runDir = resolve(args.get("run-dir") || "");
  if (!runDir) throw new Error("--run-dir is required for live checks");
  const evidence = join(runDir, "evidence");
  const provenancePath = args.get("consumer-provenance") || join(evidence, "consumer-provenance.json");
  await requireFile(provenancePath, "consumer provenance");
  const provenance = JSON.parse(await read(provenancePath));
  await verifyProvenance(provenance, flowRoot, hostDist);
  const expectedCases = String(args.get("cases") || "").split(",").filter(Boolean);
  for (const name of expectedCases) {
    const casePath = join(evidence, name);
    await requireFile(casePath, `case evidence ${name}`);
    await requireFile(join(evidence, `ask-${basename(name, ".json").replace(/^ask-/, "")}.frames.jsonl`), `raw frame evidence ${name}`);
  }
  const cleanupPath = join(evidence, args.get("cleanup") || "cleanup-proof.json");
  await requireFile(cleanupPath, "cleanup proof");
  await requireFile(join(evidence, args.get("correlation") || "correlation-index.json"), "correlation index");
  const cleanup = JSON.parse(await read(cleanupPath));
  if (cleanup.status !== "passed" || cleanup.fixedConsumerResponseDirectory !== "/tmp" || cleanup.responseTempsGone !== true || cleanup.credentialContentsCaptured === true) throw new Error("cleanup proof is not consumer-compatible and passed");
  const provider = args.get("provider");
  const model = args.get("model");
  const independentChecks = [];
  for (const name of expectedCases) {
    const casePath = join(evidence, name);
    const caseData = JSON.parse(await read(casePath));
    if (caseData.provider !== provider || caseData.model !== model) throw new Error(`${name} provider/model mismatch`);
    const check = await independentCaseCheck(evidence, casePath, caseData);
    independentChecks.push(check);
    if (!check.pass) throw new Error(`${name} failed independent raw-evidence check: ${JSON.stringify(check)}`);
  }
  return { status: "passed", cases: expectedCases, independentChecks };
}

try {
  if (args.has("static-only")) {
    console.log(JSON.stringify(await staticCheck()));
  } else {
    console.log(JSON.stringify(await liveCheck()));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
