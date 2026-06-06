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
 * This extension is NOT part of draft-ietf-cbor-edn-literals and is not
 * included in the default extension set.  Add it explicitly:
 *
 * @example
 * import { float } from '@cbortech/cbor';
 * parseCDN("float'7ef0'", { extensions: [float] }); // NaN as float16
 */

import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborFloat } from '../ast/CborFloat';
import { CborByteString } from '../ast/CborByteString';
import { float16BitsToFloat64 } from '../utils/float16';
import { stripComments } from '../utils/strip-comments';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _fromHex =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof (Uint8Array as any).fromHex === 'function'
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h: string) => (Uint8Array as any).fromHex(h) as Uint8Array
    : (h: string): Uint8Array => {
        const out = new Uint8Array(h.length / 2);
        for (let i = 0; i < h.length; i += 2)
          out[i / 2] = parseInt(h.slice(i, i + 2), 16);
        return out;
      };

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

/**
 * Extension object for `float'...'` / `float<<...>>`.
 * Pass to `parseCDN(..., { extensions: [float] })`.
 */
export const float: CborExtension = {
  appStringPrefixes: ['float'],

  parseAppString(_prefix: string, content: string): CborItem {
    const hex = stripComments(content);
    if (!/^[0-9a-fA-F]*$/.test(hex))
      throw new SyntaxError(`float'...' contains non-hex characters`);
    if (hex.length % 2 !== 0)
      throw new SyntaxError(
        `float'...' hex content has odd length (${hex.length} digits)`
      );
    return floatFromBytes(_fromHex(hex));
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
