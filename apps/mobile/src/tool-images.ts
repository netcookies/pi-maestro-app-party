/**
 * 工具/消息图片路径解析
 *
 * Host 只对 user 消息下发 `images`；toolResult 的图片路径写在正文里
 * （例如 `Wrote screenshot to: /tmp/x.png`）。因此渲染缩略图时必须
 * 同时消费显式字段与正文路径，否则工具组展开后会静默丢图。
 */
import type { TimelineItem } from "@maestro-mobile/shared";
import { splitImageSegments } from "./image-paths";

type ImageSource = Pick<TimelineItem, "text" | "images">;

/** 合并显式 images 与正文解析出的图片路径，按出现顺序去重。 */
export function collectImagePaths(item: ImageSource): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  for (const path of item.images ?? []) push(path);
  for (const segment of splitImageSegments(item.text ?? "")) {
    if (segment.type === "image") push(segment.path);
  }
  return paths;
}
