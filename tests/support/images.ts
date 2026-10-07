import { deflateSync } from "node:zlib";

/**
 * Real, tiny pictures for the chat image tests and the live check (no fixtures on disk): a PNG drawn
 * in memory (a diagonal gradient, so it is visibly an image), a 1×1 GIF, and an SVG that must never
 * load.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A `width`×`height` RGB PNG: a gradient from `from` to `to`. */
export function makePng(width = 64, height = 40, from: [number, number, number] = [246, 196, 83], to: [number, number, number] = [40, 60, 160]): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const t = (x / Math.max(1, width - 1) + y / Math.max(1, height - 1)) / 2;
      for (let c = 0; c < 3; c += 1) raw[y * (width * 3 + 1) + 1 + x * 3 + c] = Math.round(from[c]! + (to[c]! - from[c]!) * t);
    }
  }
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { png.set(part, at); at += part.length; }
  return png;
}

export const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
export const pngDataUrl = (width?: number, height?: number) => `data:image/png;base64,${base64(makePng(width, height))}`;
/** The classic 1×1 transparent GIF. */
export const GIF_1X1 = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
export const SVG_IMAGE = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"><rect width=\"10\" height=\"10\"/></svg>");
