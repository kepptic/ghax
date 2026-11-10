/**
 * Minimal PNG decode / area-average downscale / encode (8-bit, non-interlaced,
 * gray / RGB / RGBA / gray+alpha), so `screenshot --scale` can hit an exact
 * size when the browser quantizes `clip.scale` (measured: dpr 2.5, asked 0.6,
 * got 0.749 = 0.3 * 2.5). No dependency: zlib comes with Node.
 */
import zlib from 'node:zlib';

export interface Raster { width: number; height: number; channels: number; data: Buffer }

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(png: Buffer): Raster {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('png: not a PNG');
  let off = 8;
  let width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const body = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8], color = body[9], interlace = body[12];
      if (depth !== 8 || !CHANNELS[color] || interlace !== 0) throw new Error(`png: unsupported format (depth ${depth}, color ${color}, interlace ${interlace})`);
      channels = CHANNELS[color];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !height) throw new Error('png: missing IHDR');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('png: truncated image data');
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = i >= channels && y > 0 ? out[dst - stride + i - channels] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`png: bad filter ${f}`);
      }
      out[dst + i] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(r: Raster): Buffer {
  const color = ({ 1: 0, 3: 2, 2: 4, 4: 6 } as Record<number, number>)[r.channels];
  if (color === undefined) throw new Error('png: bad channel count');
  const stride = r.width * r.channels;
  const raw = Buffer.alloc((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++) r.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0); ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8; ihdr[9] = color;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Area-average resample to exactly `width` x `height`. */
export function resize(r: Raster, width: number, height: number): Raster {
  const { channels } = r;
  const out = Buffer.alloc(width * height * channels);
  const sx = r.width / width, sy = r.height / height;
  const acc: number[] = Array.from({ length: channels }, () => 0);
  for (let y = 0; y < height; y++) {
    const y0 = y * sy, y1 = Math.min(r.height, (y + 1) * sy);
    for (let x = 0; x < width; x++) {
      const x0 = x * sx, x1 = Math.min(r.width, (x + 1) * sx);
      acc.fill(0);
      let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const w = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const p = (yy * r.width + xx) * channels;
          for (let c = 0; c < channels; c++) acc[c] += r.data[p + c] * w;
          wsum += w;
        }
      }
      const o = (y * width + x) * channels;
      for (let c = 0; c < channels; c++) out[o + c] = Math.round(acc[c] / (wsum || 1));
    }
  }
  return { width, height, channels, data: out };
}

export function resizePng(png: Buffer, width: number, height: number): Buffer {
  return encodePng(resize(decodePng(png), width, height));
}
