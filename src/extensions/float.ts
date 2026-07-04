/**
 * `float'...'` / `float<<...>>` app-string extension.
 *
 * Interprets a hex bit-pattern as an IEEE 754 floating-point value:
 *   - 4 hex digits  (2 bytes) → float16  (CBOR major-7, additional 25 / 0xf9)
 *   - 8 hex digits  (4 bytes) → float32  (CBOR major-7, additional 26 / 0xfa)
 *   - 16 hex digits (8 bytes) → float64  (CBOR major-7, additional 27 / 0xfb)
 *
 * The string form `float'...'` supports the same comment syntax as `h'...'`:
 * slash-delimited block comments, C-style block comments, line comments (`//`
 * and `#`).  The extension strips comments from the raw content itself.
 *
 * The sequence form `float<<byteStr>>` accepts a single byte-string expression
 * (e.g. `float<<h'7ef0'>>`) and interprets its bytes as float bits.
 *
 * Defined in draft-ietf-cbor-edn-literals-26 §3.7 and included in the default
 * extension set:
 *
 * @example
 * parseCDN("float'7ef0'"); // NaN as float16
 */

import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborFloat } from '../ast/CborFloat';
import { CborByteString } from '../ast/CborByteString';
import { float16BitsToFloat64, float64ToFloat16Bits } from '../utils/float16';
import { stripComments } from '../utils/strip-comments';
import { hexToBytes } from '../utils/hex';
import type { EncodingWidth } from '../cbor/encode';

// ── Bit-preserving CborFloat subclasses ───────────────────────────────────────
// CborFloat stores a JS `number`, which loses NaN payloads.  These subclasses
// override _toCBOR() to emit the original bit pattern verbatim.

class CborFloat16Bits extends CborFloat {
  private readonly _bits: number;
  constructor(bits: number) {
    super(float16BitsToFloat64(bits), { precision: 'half' });
    this._bits = bits & 0xffff;
  }
  override _toCBOR(): Uint8Array {
    return new Uint8Array([0xf9, (this._bits >> 8) & 0xff, this._bits & 0xff]);
  }
}

class CborFloat32Bits extends CborFloat {
  private readonly _raw: Uint8Array;
  constructor(bytes: Uint8Array) {
    super(new DataView(bytes.buffer, bytes.byteOffset).getFloat32(0, false), {
      precision: 'single',
    });
    this._raw = bytes.slice();
  }
  override _toCBOR(): Uint8Array {
    const out = new Uint8Array(5);
    out[0] = 0xfa;
    out.set(this._raw, 1);
    return out;
  }
}

class CborFloat64Bits extends CborFloat {
  private readonly _raw: Uint8Array;
  constructor(bytes: Uint8Array) {
    super(new DataView(bytes.buffer, bytes.byteOffset).getFloat64(0, false), {
      precision: 'double',
    });
    this._raw = bytes.slice();
  }
  override _toCBOR(): Uint8Array {
    const out = new Uint8Array(9);
    out[0] = 0xfb;
    out.set(this._raw, 1);
    return out;
  }
}

function floatFromBytes(bytes: Uint8Array): CborFloat {
  if (bytes.length === 2) {
    const bits = (bytes[0]! << 8) | bytes[1]!;
    return new CborFloat16Bits(bits);
  }
  if (bytes.length === 4) return new CborFloat32Bits(bytes);
  if (bytes.length === 8) return new CborFloat64Bits(bytes);
  throw new SyntaxError(
    `float'...' requires 4, 8, or 16 hex digits (2, 4, or 8 bytes); got ${bytes.length} bytes`
  );
}

/** Expand float16 bit pattern to 4-byte float32 (bit-exact, preserves NaN payloads). */
function float16BitsToFloat32Bytes(bits16: number): Uint8Array {
  const sign = (bits16 >>> 15) & 1;
  const exp16 = (bits16 >>> 10) & 0x1f;
  const mant16 = bits16 & 0x3ff;
  let bits32: number;
  if (exp16 === 0x1f) {
    bits32 = (sign << 31) | 0x7f800000 | (mant16 << 13);
  } else if (exp16 === 0 && mant16 === 0) {
    bits32 = sign << 31;
  } else if (exp16 === 0) {
    // Denormal float16 → normal float32
    let m = mant16;
    let shifts = 0;
    while ((m & 0x200) === 0) {
      m <<= 1;
      shifts++;
    }
    bits32 = (sign << 31) | ((112 - shifts) << 23) | ((m & 0x1ff) << 14);
  } else {
    bits32 = (sign << 31) | ((exp16 + 112) << 23) | (mant16 << 13);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, bits32 >>> 0, false);
  return out;
}

/** Expand float16 bit pattern to 8-byte float64 (bit-exact, preserves NaN payloads). */
function float16BitsToFloat64Bytes(bits16: number): Uint8Array {
  const sign = (bits16 >>> 15) & 1;
  const exp16 = (bits16 >>> 10) & 0x1f;
  const mant16 = bits16 & 0x3ff;
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  if (exp16 === 0x1f) {
    dv.setUint32(0, ((sign << 31) | 0x7ff00000 | (mant16 << 10)) >>> 0, false);
    dv.setUint32(4, 0, false);
  } else if (exp16 === 0 && mant16 === 0) {
    dv.setUint32(0, (sign << 31) >>> 0, false);
    dv.setUint32(4, 0, false);
  } else if (exp16 === 0) {
    // Denormal float16 → normal float64
    let m = mant16;
    let shifts = 0;
    while ((m & 0x200) === 0) {
      m <<= 1;
      shifts++;
    }
    dv.setUint32(
      0,
      ((sign << 31) | ((1008 - shifts) << 20) | ((m & 0x1ff) << 11)) >>> 0,
      false
    );
    dv.setUint32(4, 0, false);
  } else {
    dv.setUint32(
      0,
      ((sign << 31) | ((exp16 + 1008) << 20) | (mant16 << 10)) >>> 0,
      false
    );
    dv.setUint32(4, 0, false);
  }
  return out;
}

/** Expand float32 bit pattern to 8-byte float64 (bit-exact, preserves NaN payloads). */
function float32BitsToFloat64Bytes(bytes4: Uint8Array): Uint8Array {
  const bits32 = new DataView(bytes4.buffer, bytes4.byteOffset).getUint32(
    0,
    false
  );
  const sign = (bits32 >>> 31) & 1;
  const exp32 = (bits32 >>> 23) & 0xff;
  const mant32 = bits32 & 0x7fffff;
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  if (exp32 === 0xff) {
    dv.setUint32(0, ((sign << 31) | 0x7ff00000 | (mant32 >>> 3)) >>> 0, false);
    dv.setUint32(4, (mant32 & 7) << 29, false);
  } else if (exp32 === 0 && mant32 === 0) {
    dv.setUint32(0, (sign << 31) >>> 0, false);
    dv.setUint32(4, 0, false);
  } else {
    // Normal or denormal: JS arithmetic is exact (float32 ⊂ float64), NaN handled above.
    const f64 = new DataView(bytes4.buffer, bytes4.byteOffset).getFloat32(
      0,
      false
    );
    dv.setFloat64(0, f64, false);
  }
  return out;
}

/**
 * Re-encode float bytes at a target precision (_1=half, _2=single, _3=double).
 * Returns undefined if the conversion is lossy (caller should warn).
 */
function reencodeFloat(
  bytes: Uint8Array,
  targetWidth: 1 | 2 | 3,
  onError: (msg: string) => void
): CborFloat {
  const naturalWidth = bytes.length === 2 ? 1 : bytes.length === 4 ? 2 : 3;

  if (naturalWidth === 1) {
    const bits16 = (bytes[0]! << 8) | bytes[1]!;
    if (targetWidth === 2)
      return new CborFloat32Bits(float16BitsToFloat32Bytes(bits16));
    if (targetWidth === 3)
      return new CborFloat64Bits(float16BitsToFloat64Bytes(bits16));
  }

  if (naturalWidth === 2) {
    if (targetWidth === 3)
      return new CborFloat64Bits(float32BitsToFloat64Bytes(bytes));
    if (targetWidth === 1) {
      const f32 = new DataView(bytes.buffer, bytes.byteOffset).getFloat32(
        0,
        false
      );
      const bits16 = float64ToFloat16Bits(f32);
      if (!Object.is(float16BitsToFloat64(bits16), f32) && !isNaN(f32)) {
        onError(
          `float'...' value cannot be exactly represented as float16 (_1)`
        );
      }
      return new CborFloat16Bits(bits16);
    }
  }

  if (naturalWidth === 3) {
    const f64 = new DataView(bytes.buffer, bytes.byteOffset).getFloat64(
      0,
      false
    );
    if (targetWidth === 1) {
      const bits16 = float64ToFloat16Bits(f64);
      if (!Object.is(float16BitsToFloat64(bits16), f64) && !isNaN(f64)) {
        onError(
          `float'...' value cannot be exactly represented as float16 (_1)`
        );
      }
      return new CborFloat16Bits(bits16);
    }
    if (targetWidth === 2) {
      const f32 = Math.fround(f64);
      if (!Object.is(f32, f64) && !isNaN(f64)) {
        onError(
          `float'...' value cannot be exactly represented as float32 (_2)`
        );
      }
      const out = new Uint8Array(4);
      new DataView(out.buffer).setFloat32(0, f32, false);
      return new CborFloat32Bits(out);
    }
  }

  // naturalWidth === targetWidth: identity (already handled by caller)
  return floatFromBytes(bytes);
}

/**
 * Extension object for `float'...'` / `float<<...>>`.
 * Pass to `parseCDN(..., { extensions: [float] })`.
 */
export const float: CborExtension = {
  appStringPrefixes: ['float'],

  parseAppString(
    _prefix: string,
    content: string,
    onError?: (msg: string) => void,
    options?: { encodingWidth?: EncodingWidth }
  ): CborItem {
    const hex = stripComments(content);
    if (!/^[0-9a-fA-F]*$/.test(hex))
      throw new SyntaxError(`float'...' contains non-hex characters`);
    if (hex.length % 2 !== 0)
      throw new SyntaxError(
        `float'...' hex content has odd length (${hex.length} digits)`
      );
    const bytes = hexToBytes(hex);
    const ew = options?.encodingWidth;
    if (ew === undefined) return floatFromBytes(bytes);
    if (ew !== 1 && ew !== 2 && ew !== 3) {
      const msg = `float'...' encoding indicator _${ew} is not valid; use _1, _2, or _3`;
      if (onError) {
        onError(msg);
        return floatFromBytes(bytes);
      }
      throw new SyntaxError(msg);
    }
    const naturalWidth = bytes.length === 2 ? 1 : bytes.length === 4 ? 2 : 3;
    if (ew === naturalWidth) return floatFromBytes(bytes);
    const fallbackOnError =
      onError ??
      ((msg: string) => {
        throw new SyntaxError(msg);
      });
    return reencodeFloat(bytes, ew, fallbackOnError);
  },

  parseAppSequence(
    _prefix: string,
    items: CborItem[],
    onError?: (msg: string) => void
  ): CborItem {
    if (items.length === 0)
      throw new SyntaxError(
        `float<<...>> requires exactly one byte-string item`
      );
    if (items.length > 1) {
      const msg = `float<<...>> expects 1 item; got ${items.length} — using first`;
      if (onError) onError(msg);
      else throw new SyntaxError(msg);
    }
    if (!(items[0] instanceof CborByteString))
      throw new SyntaxError(`float<<...>> item must be a byte string`);
    return floatFromBytes(items[0].value);
  },
};

export default float;
