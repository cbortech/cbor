import {
  float64ToFloat16Bits,
  float16BitsToFloat64,
  writeFloat16 as writeFloat16ToView,
} from '../utils/float16';
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

// ─── Output writer ────────────────────────────────────────────────────────────

/** Scratch space for float conversions (single-threaded use only). */
const SCRATCH = new DataView(new ArrayBuffer(8));
const SCRATCH_BYTES = new Uint8Array(SCRATCH.buffer);

/**
 * Growable byte buffer used by the CBOR encoder.
 *
 * AST nodes write themselves into a single shared writer via `_encodeTo`,
 * so an encode pass performs one buffer copy at the end instead of
 * re-copying every child's bytes at each nesting level.
 *
 * @internal
 */
export class CborWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private _ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.buf.length) return;
    let capacity = this.buf.length * 2;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buf);
    this.buf = grown;
  }

  writeByte(b: number): void {
    this._ensure(1);
    this.buf[this.len++] = b;
  }

  writeBytes(bytes: Uint8Array): void {
    this._ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  writeUint16(value: number): void {
    this._ensure(2);
    const b = this.buf;
    b[this.len++] = (value >>> 8) & 0xff;
    b[this.len++] = value & 0xff;
  }

  writeUint32(value: number): void {
    this._ensure(4);
    const b = this.buf;
    b[this.len++] = (value >>> 24) & 0xff;
    b[this.len++] = (value >>> 16) & 0xff;
    b[this.len++] = (value >>> 8) & 0xff;
    b[this.len++] = value & 0xff;
  }

  writeBigUint64(value: bigint): void {
    SCRATCH.setBigUint64(0, value, false);
    this._ensure(8);
    this.buf.set(SCRATCH_BYTES, this.len);
    this.len += 8;
  }

  writeFloat16(value: number): void {
    writeFloat16ToView(SCRATCH, 0, value, false);
    this._ensure(2);
    const b = this.buf;
    b[this.len++] = SCRATCH_BYTES[0];
    b[this.len++] = SCRATCH_BYTES[1];
  }

  writeFloat32(value: number): void {
    SCRATCH.setFloat32(0, value, false);
    this._ensure(4);
    const b = this.buf;
    b[this.len++] = SCRATCH_BYTES[0];
    b[this.len++] = SCRATCH_BYTES[1];
    b[this.len++] = SCRATCH_BYTES[2];
    b[this.len++] = SCRATCH_BYTES[3];
  }

  writeFloat64(value: number): void {
    SCRATCH.setFloat64(0, value, false);
    this._ensure(8);
    this.buf.set(SCRATCH_BYTES, this.len);
    this.len += 8;
  }

  /** Copy of the bytes written so far. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// ─── Header encoding ──────────────────────────────────────────────────────────

const MAX_FOR_WIDTH = [
  0xffn,
  0xffffn,
  0xffff_ffffn,
  0xffff_ffff_ffff_ffffn,
] as const;

/**
 * Write a CBOR initial byte + argument into `w`.
 *
 * When `encodingWidth` is provided the argument is always written using that
 * many additional bytes (AI = 24 + encodingWidth), even if the value would fit
 * in fewer bytes.  Without it the smallest valid encoding is chosen.
 *
 * `value` may be a number (common for lengths and counts — avoids a BigInt
 * allocation per head) or a bigint (required for full uint64 range).
 */
export function writeHeadTo(
  w: CborWriter,
  mt: number,
  value: number | bigint,
  encodingWidth?: EncodingWidth
): void {
  // Fast path: auto-width number argument below 2^32
  if (
    encodingWidth === undefined &&
    typeof value === 'number' &&
    value < 0x1_0000_0000
  ) {
    if (value <= 23) {
      w.writeByte((mt << 5) | value);
    } else if (value <= 0xff) {
      w.writeByte((mt << 5) | AI_1BYTE);
      w.writeByte(value);
    } else if (value <= 0xffff) {
      w.writeByte((mt << 5) | AI_2BYTE);
      w.writeUint16(value);
    } else {
      w.writeByte((mt << 5) | AI_4BYTE);
      w.writeUint32(value);
    }
    return;
  }

  const v = typeof value === 'number' ? BigInt(value) : value;
  if (encodingWidth !== undefined) {
    // Immediate encoding: value must fit in the lower 5 bits of the initial byte
    if (encodingWidth === 'i') {
      if (v > 23n)
        throw new RangeError(
          `value ${v} does not fit in immediate encoding _i (max 23)`
        );
      w.writeByte((mt << 5) | Number(v));
      return;
    }
    if (v > MAX_FOR_WIDTH[encodingWidth]) {
      throw new RangeError(
        `value ${v} does not fit in encodingWidth _${encodingWidth} (max ${MAX_FOR_WIDTH[encodingWidth]})`
      );
    }
    const ai = AI_1BYTE + encodingWidth; // 24, 25, 26, or 27
    w.writeByte((mt << 5) | ai);
    if (ai === AI_1BYTE) w.writeByte(Number(v));
    else if (ai === AI_2BYTE) w.writeUint16(Number(v));
    else if (ai === AI_4BYTE) w.writeUint32(Number(v));
    else w.writeBigUint64(v);
    return;
  }
  if (v <= 23n) {
    w.writeByte((mt << 5) | Number(v));
  } else if (v <= 0xffn) {
    w.writeByte((mt << 5) | AI_1BYTE);
    w.writeByte(Number(v));
  } else if (v <= 0xffffn) {
    w.writeByte((mt << 5) | AI_2BYTE);
    w.writeUint16(Number(v));
  } else if (v <= 0xffff_ffffn) {
    w.writeByte((mt << 5) | AI_4BYTE);
    w.writeUint32(Number(v));
  } else {
    w.writeByte((mt << 5) | AI_8BYTE);
    w.writeBigUint64(v);
  }
}

/**
 * Encode a CBOR initial byte + argument into a Uint8Array.
 * Convenience wrapper around {@link writeHeadTo} for callers that need the
 * bytes directly (e.g. hex dumps).
 */
export function writeHead(
  mt: number,
  value: number | bigint,
  encodingWidth?: EncodingWidth
): Uint8Array {
  const w = new CborWriter(9);
  writeHeadTo(w, mt, value, encodingWidth);
  return w.finish();
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
