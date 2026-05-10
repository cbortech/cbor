/**
 * Float16 (IEEE 754 binary16) encode/decode utilities.
 *
 * Uses native DataView.getFloat16 / setFloat16 when both are available,
 * and falls back to a manual bit-manipulation implementation otherwise.
 *
 * binary16 format:
 *   bit 15    : sign
 *   bits 14-10: exponent (5 bits, bias = 15)
 *   bits  9- 0: mantissa (10 bits)
 */

export const hasNativeFloat16 =
  'getFloat16' in DataView.prototype && 'setFloat16' in DataView.prototype;

// Reusable 8-byte buffer for float64 bit extraction (avoids per-call allocation)
const _buf8 = new ArrayBuffer(8);
const _dv8 = new DataView(_buf8);

/**
 * float64 → float16 bit pattern (16-bit unsigned integer).
 *
 * Operates directly on float64 bits to avoid double-rounding artifacts that
 * arise from a float64 → float32 → float16 two-step conversion.
 * Implements IEEE 754 round-to-nearest-ties-to-even (RN-TE).
 *
 * Exported for testing (manual vs native consistency checks).
 */
export function float64ToFloat16Bits(value: number): number {
  // Store the float64 in big-endian order so the bit layout is predictable
  _dv8.setFloat64(0, value, false);
  const hi = _dv8.getUint32(0, false); // bits 63-32 of IEEE 754 binary64
  const lo = _dv8.getUint32(4, false); // bits 31-0

  const sign = (hi >>> 31) & 1;
  const exp64 = (hi >>> 20) & 0x7ff; // 11-bit exponent, bias 1023
  const mantHi = hi & 0x000f_ffff; // top 20 bits of the 52-bit mantissa
  // lo  = lower 32 bits of the mantissa

  // ── Infinity / NaN ──────────────────────────────────────────────────────────
  if (exp64 === 0x7ff) {
    if (mantHi === 0 && lo === 0) return (sign << 15) | 0x7c00; // ±Infinity
    // NaN: carry top 10 mantissa bits; guarantee at least one bit is set
    const f16mant = (mantHi >> 10) | (lo !== 0 ? 1 : 0) || 1;
    return (sign << 15) | 0x7c00 | (f16mant & 0x3ff);
  }

  // Rebias: float64 exponent bias 1023 → float16 bias 15
  const f16Exp = exp64 - 1023 + 15;

  // ── Overflow → ±Infinity ────────────────────────────────────────────────────
  if (f16Exp >= 31) return (sign << 15) | 0x7c00;

  let f16mant: number;
  let roundBit: number;
  let sticky: boolean;

  if (f16Exp <= 0) {
    // ── Underflow ──────────────────────────────────────────────────────────────
    if (f16Exp < -10) return sign << 15; // → ±0

    // ── Denormal ───────────────────────────────────────────────────────────────
    // Reconstruct the 53-bit significand's top 21 bits: [implicit 1][mantHi 20-bit]
    const top21 = (1 << 20) | mantHi;

    // Right-shift amount to align the significand for a float16 denormal:
    //   f16mant = round(top53 / 2^(43 - f16Exp))
    // We approximate top53 ≈ top21 × 2^32 (low bits from `lo` affect only rounding).
    const s = 11 - f16Exp; // s ∈ [11, 21]

    if (s <= 20) {
      f16mant = (top21 >> s) & 0x3ff;
      roundBit = (top21 >> (s - 1)) & 1;
      sticky = (top21 & ((1 << (s - 1)) - 1)) !== 0 || lo !== 0;
    } else {
      // s = 21: the implicit-1 bit becomes the round bit; truncated result is 0
      f16mant = 0;
      roundBit = 1; // implicit 1 is always present
      sticky = mantHi !== 0 || lo !== 0;
    }
  } else {
    // ── Normal ─────────────────────────────────────────────────────────────────
    // Take the top 10 bits of the 52-bit mantissa; round using the next bits.
    f16mant = mantHi >> 10;
    roundBit = (mantHi >> 9) & 1;
    sticky = (mantHi & 0x1ff) !== 0 || lo !== 0;
  }

  // ── Round-to-nearest-ties-to-even (RN-TE) ───────────────────────────────────
  if (roundBit !== 0 && (sticky || (f16mant & 1) !== 0)) {
    f16mant++;
  }

  // ── Mantissa overflow: carry into exponent ───────────────────────────────────
  if (f16mant >= 1024) {
    // Denormal rounds up to the smallest normal (exp = 1), or normal exponent increments
    const newExp = f16Exp <= 0 ? 1 : f16Exp + 1;
    if (newExp >= 31) return (sign << 15) | 0x7c00; // overflow to Infinity
    return (sign << 15) | (newExp << 10); // mant = 0
  }

  const outExp = f16Exp <= 0 ? 0 : f16Exp;
  return (sign << 15) | (outExp << 10) | f16mant;
}

/**
 * float16 bit pattern → float64.
 * Exported for testing purposes.
 */
export function float16BitsToFloat64(bits: number): number {
  const sign = (bits >>> 15) & 1;
  const exp = (bits >>> 10) & 0x1f;
  const mant = bits & 0x3ff;

  if (exp === 0x1f) {
    return mant === 0 ? (sign ? -Infinity : Infinity) : NaN;
  }
  if (exp === 0) {
    if (mant === 0) return sign ? -0 : 0;
    // Denormal: (-1)^sign × 2^(-14) × (mant / 1024)
    return (sign ? -1 : 1) * 2 ** -14 * (mant / 1024);
  }
  // Normal: (-1)^sign × 2^(exp-15) × (1 + mant/1024)
  return (sign ? -1 : 1) * 2 ** (exp - 15) * (1 + mant / 1024);
}

/**
 * Write a float16 value at the given offset in a DataView.
 */
type WriteFloat16 = (
  view: DataView,
  offset: number,
  value: number,
  littleEndian: boolean
) => void;

/**
 * Read a float16 value from the given offset in a DataView, returned as float64.
 */
type ReadFloat16 = (
  view: DataView,
  offset: number,
  littleEndian: boolean
) => number;

const writeFloat16Native: WriteFloat16 = (
  view,
  offset,
  value,
  littleEndian
) => {
  view.setFloat16(offset, value, littleEndian);
};

const writeFloat16Fallback: WriteFloat16 = (
  view,
  offset,
  value,
  littleEndian
) => {
  view.setUint16(offset, float64ToFloat16Bits(value), littleEndian);
};

const readFloat16Native: ReadFloat16 = (view, offset, littleEndian) => {
  return view.getFloat16(offset, littleEndian);
};

const readFloat16Fallback: ReadFloat16 = (view, offset, littleEndian) => {
  return float16BitsToFloat64(view.getUint16(offset, littleEndian));
};

// Dispatch between native and fallback once at module initialization time.
export const writeFloat16: WriteFloat16 = hasNativeFloat16
  ? writeFloat16Native
  : writeFloat16Fallback;

export const readFloat16: ReadFloat16 = hasNativeFloat16
  ? readFloat16Native
  : readFloat16Fallback;
