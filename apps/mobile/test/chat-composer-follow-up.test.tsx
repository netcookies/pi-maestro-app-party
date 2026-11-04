import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TestRenderer, { act } from "react-test-renderer";
import type { ComposerActions } from "../src/components/ChatComposer";

vi.mock("react-native", () => {
  class AnimatedValue {
    constructor(readonly value: number) {}
    setValue(): void {}
    interpolate(): number { return 0; }
  }
  const animation = () => ({ start: vi.fn(), stop: vi.fn() });
  return {
    ActivityIndicator: "ActivityIndicator",
    Alert: { alert: vi.fn() },
    Animated: { Value: AnimatedValue, View: "AnimatedView", loop: animation, sequence: animation, timing: animation },
    AccessibilityInfo: { isReduceMotionEnabled: async () => true, addEventListener: () => ({ remove: vi.fn() }) },
    Easing: { linear: vi.fn() },
    FlatList: "FlatList",
    Image: "Image",
    Keyboard: { isVisible: () => false, addListener: () => ({ remove: vi.fn() }) },
    KeyboardAvoidingView: "KeyboardAvoidingView",
    Modal: "Modal",
    Platform: { OS: "ios" },
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    StyleSheet: { absoluteFill: {}, absoluteFillObject: {}, create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: "Text",
    TextInput: "TextInput",
    TouchableOpacity: "TouchableOpacity",
    View: "View",
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));
vi.mock("../src/theme", () => ({ useTheme: () => ({ theme: new Proxy({}, { get: () => "#000000" }) }) }));
vi.mock("../src/i18n", () => ({ useI18n: () => ({ t: {
  addImage: "Add image", close: "Close", collapseFullscreen: "Collapse", expandFullscreen: "Expand",
  followUp: "Follow-up", followUpFailed: "Follow-up failed", removeImage: "Remove image",
  sendMessage: "Send", stopRunning: "Stop",
} }) }));
vi.mock("../src/components/LineIcon", () => ({ LineIcon: "LineIcon" }));
vi.mock("../src/utils/haptics", () => ({ hapticImpactMedium: vi.fn(async () => undefined) }));

import { ChatComposer } from "../src/components/ChatComposer";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const renderers: TestRenderer.ReactTestRenderer[] = [];

function Harness({ followUp }: { followUp: NonNullable<ComposerActions["followUp"]> }) {
  const [text, setText] = useState("draft message");
  const actions: ComposerActions = {
    send: async () => undefined,
    followUp,
    openModelPicker: () => undefined,
    openThinkingPicker: () => undefined,
    openPlanPicker: () => undefined,
  };
  return <ChatComposer actions={actions} isStreaming text={text} onTextChange={setText} />;
}

async function mount(followUp: NonNullable<ComposerActions["followUp"]>): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => { renderer = TestRenderer.create(<Harness followUp={followUp} />); });
  if (!renderer) throw new Error("Renderer did not mount");
  renderers.push(renderer);
  return renderer;
}

function composerInput(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType("TextInput" as never)[0];
}

function followUpButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType("TouchableOpacity" as never)
    .find((node) => node.props.accessibilityLabel === "Follow-up")!;
}

afterEach(async () => {
  await act(async () => { renderers.splice(0).forEach((renderer) => renderer.unmount()); });
});

describe("ChatComposer Follow-up draft outcomes", () => {
  it("preserves the draft when a response belongs to a stale target", async () => {
    const renderer = await mount(async () => "stale");
    await act(async () => { followUpButton(renderer).props.onPress(); });
    expect(composerInput(renderer).props.value).toBe("draft message");
  });

  it("keeps unknown text and blocks resending the same draft until it is edited", async () => {
    const renderer = await mount(async () => "unknown");
    await act(async () => { followUpButton(renderer).props.onPress(); });
    expect(composerInput(renderer).props.value).toBe("draft message");
    expect(followUpButton(renderer).props.disabled).toBe(true);
    await act(async () => { composerInput(renderer).props.onChangeText("edited message"); });
    expect(followUpButton(renderer).props.disabled).toBe(false);
  });

  it("does not clear newer text entered while an accepted request is pending", async () => {
    let resolve!: (result: undefined) => void;
    const followUp = () => new Promise<undefined>((complete) => { resolve = complete; });
    const renderer = await mount(followUp);
    await act(async () => { followUpButton(renderer).props.onPress(); });
    await act(async () => { composerInput(renderer).props.onChangeText("next message"); });
    await act(async () => { resolve(undefined); await Promise.resolve(); });
    expect(composerInput(renderer).props.value).toBe("next message");
  });
});
