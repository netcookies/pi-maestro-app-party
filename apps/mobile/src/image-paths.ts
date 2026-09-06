/**
 * 从文本中提取图片路径（供 tool 输出渲染缩略图）
 *
 * 支持：
 *  - POSIX 绝对路径：/tmp/pi-clipboard-xxx.png、/Users/foo/bar.jpg
 *  - Windows 路径：C:\Users\foo\bar.png、file:///C:/Users/foo/bar.png
 *  - 常见图片扩展名：png/jpg/jpeg/gif/webp/bmp
 *  - 路径周围可能有引号、括号、空白、冒号（剪贴板提示格式）
 *
 * 返回去重后的路径列表（保持出现顺序）。
 */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)(?:["')\]]?)$/i;

const POSSIBLE_CHARS = /^\s*[>|:]\s*/;

/** Windows 盘符路径判定：C:/ 或 C:\ 开头 */
const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** 提取文本中所有图片路径 */
export function extractImagePaths(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  // file:// URI：POSIX（file:///tmp/x.png → /tmp/x.png）与 Windows（file:///C:/x.png → C:/x.png）
  const fileUriRe = /file:\/\/(\/[^\s"']+?\.(?:png|jpe?g|gif|webp|bmp))/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fileUriRe.exec(text)) !== null) {
    let cleaned = fm[1].trim();
    // Windows file URI：file:///C:/x.png 捕获组以 /C:/ 开头 → 去掉前导斜杠
    if (/^\/[A-Za-z]:\//.test(cleaned)) cleaned = cleaned.slice(1);
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }
  // 从 file:// 之后的位置继续找裸路径（避免重复匹配已提取的）
  const textWithoutFileUri = text.replace(/file:\/\/[^\s"']+\.(?:png|jpe?g|gif|webp|bmp)/gi, "");

  let m: RegExpExecArray | null;
  // 先提取 Windows 盘符路径（C:\... 或 C:/...）并从文本中移除，避免 POSIX 正则把 C:/Users/... 截成 /Users/...
  const winRe = /([A-Za-z]:[\\/](?:[A-Za-z0-9 ._~\-]+[\\/])*(?:[A-Za-z0-9 ._~\-]+)\.(?:png|jpe?g|gif|webp|bmp)(?=["')\s,<]|$))/gi;
  let textForPosix = textWithoutFileUri;
  while ((m = winRe.exec(textWithoutFileUri)) !== null) {
    const raw = m[1].trim();
    const cleaned = raw.replace(POSSIBLE_CHARS, "").trim();
    if (WIN_DRIVE_RE.test(cleaned) && IMAGE_EXT_RE.test(cleaned) && !seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
    textForPosix = textForPosix.replace(m[1], "");
  }

  // POSIX 绝对路径：以 / 开头，到扩展名结束
  const re = /(\/(?:[A-Za-z0-9._~\-/:]|%20|\\ )+?(?:\.(?:png|jpe?g|gif|webp|bmp)(?=["')\s,<]|$)))/gi;
  while ((m = re.exec(textForPosix)) !== null) {
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

/** 判断是否为图片路径（POSIX 绝对路径或 Windows 盘符路径） */
export function isImagePath(path: string): boolean {
  if (WIN_DRIVE_RE.test(path)) {
    return /^[A-Za-z]:[\\/](?:[A-Za-z0-9 ._~\-]+[\\/])*(?:[A-Za-z0-9 ._~\-]+)\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path);
  }
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