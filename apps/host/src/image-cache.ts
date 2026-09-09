import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const IMAGE_CACHE_DIR = join(tmpdir(), "pi-maestro-image-cache");
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_CACHE_FILES = 256;
const IMAGE_TYPES: Record<string, { ext: string; mime: string }> = {
  "image/png": { ext: "png", mime: "image/png" },
  "image/jpeg": { ext: "jpg", mime: "image/jpeg" },
  "image/gif": { ext: "gif", mime: "image/gif" },
  "image/webp": { ext: "webp", mime: "image/webp" },
};

/** Extract image blocks without retaining their base64 data in timeline state. */
export function imageBlocksFromContent(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => {
    const value = block as Record<string, unknown>;
    return value.type === "image";
  });
}

/** Materialize validated SDK image content into private, host-readable files. */
export function materializeImages(images: unknown[] | undefined): string[] {
  if (!images || images.length === 0) return [];
  const paths: string[] = [];
  for (const image of images.slice(0, MAX_IMAGES)) {
    const value = image as Record<string, unknown>;
    const data = typeof value.data === "string" ? value.data : "";
    const rawMime = typeof value.mime === "string"
      ? value.mime
      : typeof value.mimeType === "string" ? value.mimeType : "";
    const mime = rawMime.toLowerCase();
    const type = IMAGE_TYPES[mime];
    if (!type || !data || data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) continue;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) continue;

    let bytes: Buffer;
    try {
      bytes = Buffer.from(data, "base64");
    } catch {
      continue;
    }
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;

    try {
      mkdirSync(IMAGE_CACHE_DIR, { recursive: true, mode: 0o700 });
      const cached = readdirSync(IMAGE_CACHE_DIR)
        .map((name) => {
          try {
            return { name, mtime: statSync(join(IMAGE_CACHE_DIR, name)).mtimeMs };
          } catch {
            return undefined;
          }
        })
        .filter((entry): entry is { name: string; mtime: number } => entry !== undefined)
        .sort((a, b) => a.mtime - b.mtime);
      while (cached.length >= MAX_CACHE_FILES) {
        const oldest = cached.shift();
        if (!oldest) break;
        try { unlinkSync(join(IMAGE_CACHE_DIR, oldest.name)); } catch { /* best effort cleanup */ }
      }
      const filename = `${Date.now()}-${paths.length}-${Math.random().toString(36).slice(2)}.${type.ext}`;
      const filePath = join(IMAGE_CACHE_DIR, filename);
      writeFileSync(filePath, bytes, { mode: 0o600 });
      const fileStat = statSync(filePath);
      if (fileStat.size !== bytes.length || fileStat.size > MAX_IMAGE_BYTES) continue;
      paths.push(filePath);
    } catch {
      // A cache write failure should not reject the already accepted prompt.
    }
  }
  return paths;
}
