import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_NINT } from '../cbor/constants';
import { writeHead, type EncodingWidth } from '../cbor/encode';

/**
 * CBOR Major Type 1 — negative integer (−2^64 … −1).
 *
 * The constructor accepts the actual negative value (e.g. `-5n`).
 * Internally the CBOR "argument" `n` is stored, where the decoded value
 * equals `−1 − n`.  This matches the wire encoding directly.
 *
 * Examples:
 *   new CborNint(-1n)  → argument = 0n
 *   new CborNint(-5n)  → argument = 4n
 */
export class CborNint extends CborItem {
  /** CBOR raw argument n, where actual value = −1 − n. */
  readonly argument: bigint;
  readonly encodingWidth: EncodingWidth | undefined;

  constructor(
    value: number | bigint,
    options?: { encodingWidth?: EncodingWidth }
  ) {
    super();
    const v = BigInt(value);
    if (v >= 0n) throw new RangeError('CborNint value must be negative');
    if (v < -(0xffff_ffff_ffff_ffffn + 1n))
      throw new RangeError('CborNint value exceeds minimum int64');
    this.argument = -1n - v;
    this.encodingWidth = options?.encodingWidth;
  }

  /** The actual decoded negative value (−1 − argument). */
  get value(): bigint {
    return -1n - this.argument;
  }

  _toCBOR(_options?: ToCBOROptions): Uint8Array {
    return writeHead(MT_NINT, this.argument, this.encodingWidth);
  }

  _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    const suffix =
      this.encodingWidth !== undefined ? `_${this.encodingWidth}` : '';
    const abs = this.argument + 1n; // absolute value of the negative number
    switch (options?.intFormat) {
      case 'hex':
        return `-0x${abs.toString(16)}${suffix}`;
      case 'octal':
        return `-0o${abs.toString(8)}${suffix}`;
      case 'binary':
        return `-0b${abs.toString(2)}${suffix}`;
      default:
        return this.value.toString() + suffix;
    }
  }

  _toJS(options?: ToJSOptions): unknown {
    const v = this.value;
    const mode = options?.integerAs ?? 'auto';
    if (mode === 'bigint') return v;
    if (mode === 'number') return Number(v);
    return v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v;
  }
}
