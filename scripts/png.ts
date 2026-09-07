/**
 * Minimal RGBA PNG encoder.
 *
 * Used only by the placeholder-icon generator. Hand-rolled rather than pulling
 * in `sharp` so the build stays free of native dependencies - `png2icons`,
 * which converts these into .ico/.icns, is pure JS too.
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Encode straight RGBA bytes (4 per pixel, row-major) as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} bytes of RGBA, got ${rgba.length}`)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // One filter byte (0 = None) per scanline.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0))
  ])
}

export interface Rgb {
  r: number
  g: number
  b: number
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '')
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  }
}

/** A signed-distance canvas: negative inside the shape, positive outside. */
export class Canvas {
  readonly data: Uint8Array

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.data = new Uint8Array(width * height * 4)
  }

  /**
   * Composite `color` over the canvas wherever `sdf` reports coverage, using a
   * one-pixel linear ramp across the boundary for antialiasing.
   */
  fill(sdf: (x: number, y: number) => number, color: Rgb, opacity = 1): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const d = sdf(x + 0.5, y + 0.5)
        const coverage = Math.min(1, Math.max(0, 0.5 - d)) * opacity
        if (coverage <= 0) continue
        const i = (y * this.width + x) * 4
        const dstA = this.data[i + 3]! / 255
        const outA = coverage + dstA * (1 - coverage)
        for (let c = 0; c < 3; c++) {
          const src = c === 0 ? color.r : c === 1 ? color.g : color.b
          const dst = this.data[i + c]!
          this.data[i + c] = Math.round((src * coverage + dst * dstA * (1 - coverage)) / outA)
        }
        this.data[i + 3] = Math.round(outA * 255)
      }
    }
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.data)
  }
}

export type Sdf = (x: number, y: number) => number

/** SDF for an axis-aligned rounded rectangle. */
export function roundedRect(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  radius: number
): Sdf {
  const r = Math.min(radius, halfW, halfH)
  return (x, y) => {
    const qx = Math.abs(x - cx) - halfW + r
    const qy = Math.abs(y - cy) - halfH + r
    return (
      Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
    )
  }
}

/** SDF for an axis-aligned ellipse. Scaled-circle approximation - close enough
 *  for antialiasing, and free of the exact form's numerical instability. */
export function ellipse(cx: number, cy: number, rx: number, ry: number): Sdf {
  const scale = Math.min(rx, ry)
  return (x, y) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * scale
}

/**
 * Union of shapes with a soft blend of radius `k`.
 *
 * A plain `Math.min` union leaves a visible crease where two shapes meet. The
 * polynomial smooth-minimum fuses them into one continuous form instead, which
 * is what makes a stack of ellipses read as a single moulded object rather than
 * as separate discs.
 */
export function smoothUnion(k: number, ...shapes: Sdf[]): Sdf {
  return (x, y) =>
    shapes
      .map((shape) => shape(x, y))
      .reduce((a, b) => {
        const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k))
        return b * (1 - h) + a * h - k * h * (1 - h)
      })
}
