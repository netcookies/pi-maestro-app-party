export const HEADING_AMBER = "#F59E0B";

/**
 * 辅助函数：判断是否为合法的 Hex 颜色代码
 */
export function isHexColor(str: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(str.trim());
}

/**
 * 辅助函数：根据 Hex 颜色背景计算最佳对比文字颜色
 * 暗色背景返回浅色字 #FFFFFF，浅色背景返回深色字 #0F172A
 */
export function getContrastColor(hexColor: string): string {
  let clean = hexColor.trim().replace("#", "");
  if (clean.length === 3) {
    clean = clean.split("").map((c) => c + c).join("");
  }
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  // YIQ 亮度公式
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? "#0F172A" : "#FFFFFF";
}
