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
  | "image"
  | "folder"
  | "search"
  | "arrowLeft"
  | "arrowDown"
  | "thinkBrain"
  | "planClipboard"
  | "compactSqueeze"
  | "chevronDown"
  | "check"
  | "radio"
  | "key"
  | "refresh"
  | "qrcode"
  | "smartphone"
  | "moon"
  | "sun"
  | "workbench"
  | "chat"
  | "monitor"
  | "settings";

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
  folder: (
    <Path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  ),
  search: (
    <G>
      <Circle cx="11" cy="11" r="8" />
      <Path d="M21 21l-4.35-4.35" />
    </G>
  ),
  arrowLeft: (
    <G>
      <Path d="M19 12H5M12 19l-7-7 7-7" />
    </G>
  ),
  arrowDown: (
    <G>
      <Path d="M12 5v14M19 12l-7 7-7-7" />
    </G>
  ),
  thinkBrain: (
    <G>
      <Path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <Path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <Path d="M12 5v14" />
    </G>
  ),
  planClipboard: (
    <G>
      <Path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <Rect x="8" y="2" width="8" height="4" rx="1" />
      <Path d="M9 14l2 2 4-4" />
      <Path d="M9 10h6" />
    </G>
  ),
  compactSqueeze: (
    <G>
      <Path d="M4 12h16" />
      <Path d="M12 3v6M9 6l3 3 3-3" />
      <Path d="M12 21v-6M9 18l3-3 3 3" />
    </G>
  ),
  chevronDown: (
    <Path d="M6 9l6 6 6-6" />
  ),
  check: (
    <Path d="M20 6L9 17l-5-5" />
  ),
  radio: (
    <G>
      <Circle cx="12" cy="12" r="2" />
      <Path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
    </G>
  ),
  key: (
    <G>
      <Circle cx="7.5" cy="15.5" r="5.5" />
      <Path d="M11.5 11.5L22 1l-3 3 2 2-2 2 2 2" />
    </G>
  ),
  refresh: (
    <G>
      <Path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19" />
    </G>
  ),
  qrcode: (
    <G>
      <Rect x="3" y="3" width="7" height="7" rx="1" />
      <Rect x="14" y="3" width="7" height="7" rx="1" />
      <Rect x="14" y="14" width="7" height="7" rx="1" />
      <Rect x="3" y="14" width="7" height="7" rx="1" />
    </G>
  ),
  smartphone: (
    <G>
      <Rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <Path d="M12 18h.01" />
    </G>
  ),
  moon: (
    <Path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  ),
  sun: (
    <G>
      <Circle cx="12" cy="12" r="5" />
      <Path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </G>
  ),
  workbench: (
    <Path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  chat: (
    <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  ),
  monitor: (
    <G>
      <Rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <Path d="M8 21h8M12 17v4" />
    </G>
  ),
  settings: (
    <G>
      <Circle cx="12" cy="12" r="3" />
      <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
