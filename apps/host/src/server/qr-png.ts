/**
 * qr-png — 高对比度 QR PNG 生成（零外部依赖）
 *
 * 背景：终端 small 模式用 ▀▄█ 半块字符，颜色取自终端前景/背景 —— 暗色主题下对比度仅 ~72 灰度级
 * （实测 37..109），微信能扫但 iOS Vision / expo-camera 的解码阈值严格，扫不出。
 * PNG 输出纯黑(0x00)/纯白(0xFF) + 4 模块静默区，对比度 255 级，所有扫描器通吃。
 */
import { deflateSync } from "node:zlib";
import { crc32 } from "node:zlib";
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";

const SCALE = 8;          // 每模块像素
const QUIET = 4;          // 静默区模块数（标准 ≥4）

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成 PNG buffer：payload 文本 → 高对比度黑白 QR 图 */
export function generateQrPng(payload: string): Buffer {
  const qr = new QRCode(-1, 1); // level M 容错（1=L 最低；够用且模块数最小）
  qr.addData(payload);
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + QUIET * 2) * SCALE;

  // 8-bit grayscale（color type 0），每行前置 filter byte 0
  const raw = Buffer.alloc((size + 1) * size);
  let off = 0;
  for (let y = 0; y < size; y++) {
    raw[off++] = 0; // filter: None
    const my = Math.floor(y / SCALE) - QUIET;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / SCALE) - QUIET;
      const dark = my >= 0 && my < count && mx >= 0 && mx < count && qr.isDark(my, mx);
      raw[off++] = dark ? 0x00 : 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 0;   // color type: grayscale
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
