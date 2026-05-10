import { float64ToFloat16Bits, float16BitsToFloat64 } from '../utils/float16';
import type { FloatPrecision } from '../ast/CborFloat';
import { AI_1BYTE, AI_2BYTE, AI_4BYTE, AI_8BYTE } from './constants';

// ─── Encoding width ───────────────────────────────────────────────────────────

/**
 * EDN encoding indicator, mapping to a specific CBOR AI encoding:
 *   'i' → ai 0–23  (argument in initial byte, value must be 0–23)
 *   0   → AI 24    (1-byte argument, value must be 0–0xFF)
 *   1   → AI 25    (2-byte argument, value must be 0–0xFFFF)
 *   2   → AI 26    (4-byte argument, value must be 0–0xFFFFFFFF)
 *   3   → AI 27    (8-byte argument, value must be 0–0xFFFFFFFFFFFFFFFF)
 */
export type EncodingWidth = 'i' | 0 | 1 | 2 | 3;

// ─── Header encoding ──────────────────────────────────────────────────────────

/**
 * Encode a CBOR initial byte + argument into a Uint8Array.
 *
 * When `encodingWidth` is provided the argument is always written using that
 * many additional bytes (AI = 24 + encodingWidth), even if the value would fit
 * in fewer bytes.  Without it the smallest valid encoding is chosen.
 */
export function writeHead(
  mt: number,
  value: bigint,
  encodingWidth?: EncodingWidth
): Uint8Array {
  if (encodingWidth !== undefined) {
    // Immediate encoding: value must fit in the lower 5 bits of the initial byte
    if (encodingWidth === 'i') {
      if (value > 23n)
        throw new RangeError(
          `value ${value} does not fit in immediate encoding _i (max 23)`
        );
      return new Uint8Array([(mt << 5) | Number(value)]);
    }
    const maxForWidth = [
      0xffn,
      0xffffn,
      0xffff_ffffn,
      0xffff_ffff_ffff_ffffn,
    ] as const;
    if (value > maxForWidth[encodingWidth]) {
      throw new RangeError(
        `value ${value} does not fit in encodingWidth _${encodingWidth} (max ${maxForWidth[encodingWidth]})`
      );
    }
    const ai = AI_1BYTE + encodingWidth; // 24, 25, 26, or 27
    if (ai === AI_1BYTE) {
      return new Uint8Array([(mt << 5) | AI_1BYTE, Number(value)]);
    }
    if (ai === AI_2BYTE) {
      const buf = new Uint8Array(3);
      buf[0] = (mt << 5) | AI_2BYTE;
      buf[1] = Number(value >> 8n);
      buf[2] = Number(value & 0xffn);
      return buf;
    }
    if (ai === AI_4BYTE) {
      const buf = new Uint8Array(5);
      buf[0] = (mt << 5) | AI_4BYTE;
      new DataView(buf.buffer).setUint32(1, Number(value), false);
      return buf;
    }
    // ai === AI_8BYTE
    const buf = new Uint8Array(9);
    buf[0] = (mt << 5) | AI_8BYTE;
    new DataView(buf.buffer).setBigUint64(1, value, false);
    return buf;
  }
  if (value <= 23n) {
    return new Uint8Array([(mt << 5) | Number(value)]);
  }
  if (value <= 0xffn) {
    return new Uint8Array([(mt << 5) | AI_1BYTE, Number(value)]);
  }
  if (value <= 0xffffn) {
    const buf = new Uint8Array(3);
    buf[0] = (mt << 5) | AI_2BYTE;
    buf[1] = Number(value >> 8n);
    buf[2] = Number(value & 0xffn);
    return buf;
  }
  if (value <= 0xffff_ffffn) {
    const buf = new Uint8Array(5);
    buf[0] = (mt << 5) | AI_4BYTE;
    new DataView(buf.buffer).setUint32(1, Number(value), false);
    return buf;
  }
  const buf = new Uint8Array(9);
  buf[0] = (mt << 5) | AI_8BYTE;
  new DataView(buf.buffer).setBigUint64(1, value, false);
  return buf;
}

/** Concatenate multiple Uint8Arrays into one. */
export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ─── Float precision helpers ──────────────────────────────────────────────────

const _f32buf = new DataView(new ArrayBuffer(4));

/**
 * Returns true if `value` can be exactly represented as a float16 without
 * precision loss (including -0, Infinity, -Infinity, NaN identity).
 */
export function canEncodeAsFloat16(value: number): boolean {
  return Object.is(float16BitsToFloat64(float64ToFloat16Bits(value)), value);
}

/**
 * Returns true if `value` can be exactly represented as a float32 without
 * precision loss.
 */
export function canEncodeAsFloat32(value: number): boolean {
  _f32buf.setFloat32(0, value, false);
  return Object.is(_f32buf.getFloat32(0, false), value);
}

/**
 * Choose the smallest float precision that represents `value` exactly.
 * Used by CborFloat.toCBOR() when `precision` is undefined.
 */
export function autoSelectFloatPrecision(value: number): FloatPrecision {
  if (canEncodeAsFloat16(value)) return 'half';
  if (canEncodeAsFloat32(value)) return 'single';
  return 'double';
}
