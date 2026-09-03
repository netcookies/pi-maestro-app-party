/**
 * 从文本中提取图片路径（供 tool 输出渲染缩略图）
 *
 * 支持：
 *  - 绝对路径：/tmp/pi-clipboard-xxx.png、/Users/foo/bar.jpg
 *  - 常见图片扩展名：png/jpg/jpeg/gif/webp/bmp
 *  - 路径周围可能有引号、括号、空白、冒号（剪贴板提示格式）
 *
 * 返回去重后的路径列表（保持出现顺序）。
 */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)(?:["')\]]?)$/i;

const POSSIBLE_CHARS = /^\s*[>|:]\s*/;

/** 提取文本中所有图片路径 */
export function extractImagePaths(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  // 找所有可能含绝对路径的片段：以 / 开头，到扩展名结束
  const re = /(\/(?:[A-Za-z0-9._~\-/:]|%20|\\ )+?(?:\.(?:png|jpe?g|gif|webp|bmp)(?=["')\s,<]|$)))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    // 去掉行首装饰符（> | : 等）
    const cleaned = raw.replace(POSSIBLE_CHARS, "").trim();
    if (cleaned.startsWith("/") && IMAGE_EXT_RE.test(cleaned) && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  return result;
}

/** 判断是否为图片路径 */
export function isImagePath(path: string): boolean {
  return /^\/(?:[A-Za-z0-9._~\-/:]+)\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path);
}

/**
 * 将 tool 文本按图片路径分段，返回 [{ text } | { image }] 片段列表
 * 用于渲染时文本与缩略图交错
 */
export type Segment =
  | { type: "text"; text: string }
  | { type: "image"; path: string };

export function splitImageSegments(text: string): Segment[] {
  if (!text) return [];
  const paths = extractImagePaths(text);
  if (paths.length === 0) return [{ type: "text", text }];

  const segments: Segment[] = [];
  let rest = text;
  for (const path of paths) {
    const idx = rest.indexOf(path);
    if (idx < 0) continue;
    if (idx > 0) {
      const before = rest.slice(0, idx);
      segments.push({ type: "text", text: trimLineNoise(before) });
    }
    segments.push({ type: "image", path });
    rest = rest.slice(idx + path.length);
  }
  if (rest.trim()) segments.push({ type: "text", text: trimLineNoise(rest) });
  return segments;
}

function trimLineNoise(s: string): string {
  return s.replace(POSSIBLE_CHARS, "").replace(/\s*["']?\s*$/, "").trim();
}