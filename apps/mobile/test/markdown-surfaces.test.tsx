import React, { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { Highlight, themes } from "prism-react-renderer";
import type { DesktopPlanRequest, SessionTargetIdentity } from "@maestro-mobile/shared";
import { DICTIONARIES, I18nProvider } from "../src/i18n";
import { THEMES, ThemeProvider, type AppTheme } from "../src/theme";

// These host adapters expose props/events, not native layout, selection or gestures.
// React, Prism and all Markdown/Plan components retain their real hooks/lifecycle.
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator", Modal: "Modal", ScrollView: "ScrollView", Text: "Text",
  TextInput: "TextInput", TouchableOpacity: "TouchableOpacity", View: "View", Pressable: "Pressable",
  Linking: { openURL: vi.fn(async () => undefined) }, NativeModules: {},
  Platform: { OS: "ios" }, useColorScheme: () => "light",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Animated: {
    Value: class { constructor(readonly value: number) {} }, View: "AnimatedView",
    sequence: vi.fn(() => ({ start: vi.fn() })), timing: vi.fn(() => ({ start: vi.fn() })),
    spring: vi.fn(() => ({ start: vi.fn() })),
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: "SafeAreaProvider", SafeAreaView: "SafeAreaView", initialWindowMetrics: null,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Circle: "Circle", G: "G", Path: "Path", Rect: "Rect" }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async (key: string) => key === "maestro-mobile.language" ? "en" : null), setItem: vi.fn(async () => undefined) },
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));
vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(async () => undefined), NotificationFeedbackType: { Success: "success" },
}));
vi.mock("@ronradtke/react-native-markdown-display", () => {
  // Bounded parsing adapter: feed fence nodes into the actual supplied rules.
  // Parsing correctness belongs to markdown-display; fence rendering is real.
  function MarkdownAdapter({ children, rules }: {
    children: string;
    rules: ReturnType<typeof createChatMarkdownRules>;
  }) {
    const fences = Array.from(children.matchAll(/```([^\n]*)\n([\s\S]*?)```/g));
    return <>{fences.map((match, index) => rules.fence({
      key: `fence-${index}`, sourceInfo: match[1], content: match[2],
    }))}</>;
  }
  return { default: MarkdownAdapter, MarkdownStream: MarkdownAdapter };
});

import { PlanSurface } from "../src/components/PlanSurface";
import { ChatMarkdown } from "../src/components/chat/ChatMarkdown";
import { HighlightedCode, createChatMarkdownRules } from "../src/components/chat/chatMarkdownRules";
import { MarkdownExpandContent, MarkdownExpandViewer, type MarkdownExpandRequest } from "../src/components/chat/MarkdownExpandViewer";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const renderers: ReactTestRenderer[] = [];
const t = DICTIONARIES.en;
const code = "\tconst value = 1;  \n\n  console.log(value);\n";
const markdown = `# Plan\n\n**Goal**\n\n\`\`\`typescript\n${code}\n\`\`\``;
const target: SessionTargetIdentity = { sessionId: "s", endpointId: "e", normalizedCwd: "/work", processGeneration: "g" };
const request: DesktopPlanRequest = {
  type: "desktop_plan_request", requestId: "plan", kind: "confirm", sessionId: "s", operationId: 1,
  cwd: "/work", mode: "plan", markdown, revision: 1, pathLabel: "Plan.md",
  availableActions: ["execute", "modify"], decisionDocuments: [], drafts: [],
};

function Providers({ children }: { children: React.ReactNode }) {
  return <ThemeProvider><I18nProvider>{children}</I18nProvider></ThemeProvider>;
}

async function mount(element: ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => { renderer = TestRenderer.create(<Providers>{element}</Providers>); });
  if (!renderer) throw new Error("Renderer did not mount");
  renderers.push(renderer);
  return renderer;
}

afterEach(async () => {
  await act(async () => { renderers.splice(0).forEach((renderer) => renderer.unmount()); });
});

function hosts(root: ReactTestInstance, name: string): ReactTestInstance[] {
  return root.findAll((node) => typeof node.type === "string" && node.type === name);
}

function host(root: ReactTestInstance, name: string): ReactTestInstance {
  const nodes = hosts(root, name);
  expect(nodes).toHaveLength(1);
  return nodes[0];
}

function textContent(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textContent).join("");
}

async function press(root: ReactTestInstance, label: string): Promise<void> {
  const button = hosts(root, "Pressable").find((node) => node.props.accessibilityLabel === label)
    ?? hosts(root, "TouchableOpacity").find((node) => textContent(node) === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  await act(async () => { button.props.onPress(); });
}

async function layoutExpanded(root: ReactTestInstance): Promise<ReactTestInstance> {
  const expanded = root.findByType(MarkdownExpandContent);
  const body = hosts(expanded, "View").find((node) => typeof node.props.onLayout === "function");
  if (!body) throw new Error("Expanded viewport did not expose onLayout");
  await act(async () => { body.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } } }); });
  return expanded;
}

function selectableCode(root: ReactTestInstance): ReactTestInstance {
  const regions = hosts(root, "Text").filter((node) => node.props.selectable === true);
  expect(regions).toHaveLength(1);
  return regions[0];
}

describe("mounted Plan Markdown integration", () => {
  it("expands through the real fence button in one Modal and restores preview on close/back", async () => {
    const onCancel = vi.fn();
    const onResponse = vi.fn();
    const renderer = await mount(<PlanSurface request={request} target={target} onCancel={onCancel} onResponse={onResponse} />);
    const modal = host(renderer.root, "Modal");
    expect(modal.props.transparent).toBe(true);
    expect(renderer.root.findByType(ChatMarkdown).props.content).toBe(markdown);
    expect(textContent(selectableCode(renderer.root))).toBe(code);

    await press(renderer.root, t.expand);
    expect(host(renderer.root, "Modal")).toBe(modal);
    expect(modal.props.transparent).toBe(false);
    expect(renderer.root.findAllByType(ChatMarkdown)).toHaveLength(0);
    const expanded = await layoutExpanded(renderer.root);
    expect(expanded.props.title).toBe(`TYPESCRIPT ${t.code}`);
    expect(textContent(selectableCode(expanded))).toBe(code);
    await press(renderer.root, t.closeExpandedContent);
    expect(host(renderer.root, "Modal")).toBe(modal);
    expect(modal.props.transparent).toBe(true);
    expect(renderer.root.findByType(ChatMarkdown).props.content).toBe(markdown);
    expect(renderer.root.findAllByType(MarkdownExpandContent)).toHaveLength(0);
    expect(onCancel).not.toHaveBeenCalled();

    await press(renderer.root, t.expand);
    expect(host(renderer.root, "Modal")).toBe(modal);
    await act(async () => { modal.props.onRequestClose(); });
    expect(renderer.root.findByType(ChatMarkdown).props.content).toBe(markdown);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onResponse).not.toHaveBeenCalled();
    await act(async () => { modal.props.onRequestClose(); });
    expect(onCancel).toHaveBeenCalledExactlyOnceWith(request, target);
  });

  it("preserves an edited draft across expansion and resets expansion/draft on revision update", async () => {
    const onCancel = vi.fn();
    const onResponse = vi.fn();
    const props = { request: { ...request, kind: "review" as const }, target, initialDraft: "# Unsaved draft", onCancel, onResponse };
    const renderer = await mount(<PlanSurface {...props} />);
    expect(host(renderer.root, "TextInput").props.value).toBe(props.initialDraft);
    await act(async () => { host(renderer.root, "TextInput").props.onChangeText("# Local edits"); });
    await press(renderer.root, t.planBackPreview);
    await press(renderer.root, t.expand);
    await press(renderer.root, t.closeExpandedContent);
    await press(renderer.root, t.planActionModify);
    expect(host(renderer.root, "TextInput").props.value).toBe("# Local edits");

    await press(renderer.root, t.planBackPreview);
    await press(renderer.root, t.expand);
    await act(async () => { host(renderer.root, "Modal").props.onRequestClose(); });
    await press(renderer.root, t.planActionModify);
    expect(host(renderer.root, "TextInput").props.value).toBe("# Local edits");
    await press(renderer.root, t.planBackPreview);
    await press(renderer.root, t.expand);
    const revised = { ...props.request, revision: 2, markdown: "# Revised plan" };
    await act(async () => { renderer.update(<Providers><PlanSurface {...props} request={revised} initialDraft={undefined} /></Providers>); });
    expect(host(renderer.root, "Modal").props.transparent).toBe(true);
    expect(renderer.root.findAllByType(MarkdownExpandContent)).toHaveLength(0);
    expect(renderer.root.findByType(ChatMarkdown).props.content).toBe(revised.markdown);
    await press(renderer.root, t.planActionModify);
    expect(host(renderer.root, "TextInput").props.value).toBe(revised.markdown);
    await press(renderer.root, t.planSaveEdit);
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      type: "desktop_plan_response", requestId: revised.requestId, kind: "review", status: "edited",
      markdown: revised.markdown, expectedRevision: 2,
    }, target);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

function FenceHarness({ theme, language, source }: { theme: AppTheme; language: string; source: string }) {
  const [expanded, setExpanded] = useState<MarkdownExpandRequest | null>(null);
  const rules = createChatMarkdownRules(theme, undefined, undefined, setExpanded);
  return <>
    {rules.fence({ key: "code", content: `${source}\n`, sourceInfo: language })}
    {expanded ? <MarkdownExpandViewer visible title={expanded.title} theme={theme} onClose={() => setExpanded(null)}>
      {expanded.children}
    </MarkdownExpandViewer> : null}
  </>;
}

describe("mounted expanded Prism code", () => {
  it.each(["dark", "light"] as const)("retains %s token colors, language, whitespace, selection and scroll props", async (name) => {
    const theme: AppTheme = { ...THEMES[name === "dark" ? "dark" : "notion"], name };
    const renderer = await mount(<FenceHarness theme={theme} language="typescript" source={code} />);
    await press(renderer.root, t.expand);
    const expanded = await layoutExpanded(renderer.root);
    const highlighted = expanded.findByType(HighlightedCode);
    expect(highlighted.props.language).toBe("typescript");
    expect(highlighted.props.code).toBe(code);
    const prismTheme = name === "dark" ? themes.oneDark : themes.oneLight;
    expect(expanded.findByType(Highlight).props.theme).toBe(prismTheme);
    const region = selectableCode(expanded);
    expect(textContent(region)).toBe(code);
    const keywordColor = prismTheme.styles.find((entry) => entry.types.includes("keyword"))?.style.color;
    expect(keywordColor).toBeDefined();
    const keyword = hosts(region, "Text").find((node) => textContent(node) === "const");
    expect(keyword).toBeDefined();
    expect(keyword?.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ color: keywordColor })]));
    const scrolls = hosts(expanded, "ScrollView");
    expect(scrolls).toHaveLength(2);
    expect(scrolls.find((node) => node.props.horizontal)?.props).toMatchObject({
      horizontal: true, nestedScrollEnabled: true, showsHorizontalScrollIndicator: true,
    });
    expect(scrolls.find((node) => !node.props.horizontal)?.props).toMatchObject({
      nestedScrollEnabled: true, keyboardShouldPersistTaps: "handled",
    });
    await press(renderer.root, t.closeExpandedContent);
    expect(hosts(renderer.root, "Modal")).toHaveLength(0);
  });

  it("renders unknown languages as plain text without losing whitespace or selection", async () => {
    const source = "\tunknown words  \n\n  untouched();\n";
    const theme: AppTheme = { ...THEMES.notion, name: "light" };
    const renderer = await mount(<FenceHarness theme={theme} language="unsupported-language" source={source} />);
    await press(renderer.root, t.expand);
    const expanded = await layoutExpanded(renderer.root);
    expect(expanded.props.title).toBe(`UNSUPPORTED-LANGUAGE ${t.code}`);
    expect(expanded.findByType(HighlightedCode).props.language).toBe("unsupported-language");
    const region = selectableCode(expanded);
    expect(textContent(region)).toBe(source);
    const tokenLeaves = hosts(region, "Text").filter((node) => Array.isArray(node.props.style) && node.children.length > 0 && node.children.every((child) => typeof child === "string"));
    expect(tokenLeaves.length).toBeGreaterThan(0);
    for (const token of tokenLeaves) {
      expect(token.props.style).toEqual(expect.arrayContaining([
        expect.objectContaining({ color: theme.text }),
      ]));
    }
  });
});
