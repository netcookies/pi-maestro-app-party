/**
 * LineIcon — 线性语义图标集（react-native-svg）
 *
 * 与设计稿（miuix-prototype/design-demos/final.html）的 IC 图标库同一语言：
 * 24×24 viewBox、stroke currentColor、round cap/join、1.8-2.2 描边。
 * 用法：<LineIcon name="brain" size={18} color={theme.muted} />
 */
import React from "react";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

export type LineIconName =
  | "brain"
  | "bolt"
  | "plan"
  | "compress"
  | "clip"
  | "send"
  | "expand"
  | "collapse"
  | "x"
  | "eye"
  | "image";

interface Props {
  name: LineIconName;
  /** 渲染尺寸（宽高同值），默认 18 */
  size?: number;
  /** 颜色（stroke 用），默认 currentColor 语义由调用方传入 theme 色 */
  color?: string;
  /** 描边宽度覆盖，默认 1.8 */
  strokeWidth?: number;
}

const PATHS: Record<LineIconName, React.ReactNode> = {
  brain: (
    <G>
      <Path d="M12 4a3.2 3.2 0 0 0-3.2 3.2v.3A3.2 3.2 0 0 0 6 10.6a3.2 3.2 0 0 0 1.2 2.5A3.2 3.2 0 0 0 6.4 15a3.2 3.2 0 0 0 3 3.2c.4 1 1.4 1.8 2.6 1.8s2.2-.8 2.6-1.8a3.2 3.2 0 0 0 3-3.2 3.2 3.2 0 0 0-.8-1.9A3.2 3.2 0 0 0 18 10.6a3.2 3.2 0 0 0-2.8-3.1v-.3A3.2 3.2 0 0 0 12 4z" />
      <Path d="M12 4v16" />
    </G>
  ),
  bolt: <Path d="M13 2L4.5 13.5H11L9.5 22 18 10.5h-6.5L13 2z" />,
  plan: (
    <G>
      <Rect x="4" y="3" width="16" height="18" rx="2" />
      <Path d="M8 7h8M8 11h8M8 15h5" />
    </G>
  ),
  compress: (
    <G>
      <Path d="M8 3v5M8 21v-5M3 8h5M16 3v5M16 21v-5M21 8h-5M3 16h5M21 16h-5" />
      <Circle cx="12" cy="12" r="2.2" />
    </G>
  ),
  clip: (
    <Path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
  send: <Path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />,
  expand: <Path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  collapse: <Path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />,
  x: <Path d="M18 6L6 18M6 6l12 12" />,
  eye: (
    <G>
      <Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <Circle cx="12" cy="12" r="3" />
    </G>
  ),
  image: (
    <G>
      <Rect x="3" y="3" width="18" height="18" rx="2" />
      <Circle cx="8.5" cy="8.5" r="1.5" />
      <Path d="M21 15l-5-5L5 21" />
    </G>
  ),
};

export function LineIcon({ name, size = 18, color = "#000", strokeWidth = 1.8 }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <G
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {PATHS[name]}
      </G>
    </Svg>
  );
}
