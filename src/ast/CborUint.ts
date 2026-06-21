import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_UINT } from '../cbor/constants';
import {
  writeHeadTo,
  type CborWriter,
  type EncodingWidth,
} from '../cbor/encode';

/** CBOR Major Type 0 — unsigned integer (0 … 2^64−1). */
export class CborUint extends CborItem {
  readonly value: bigint;
  encodingWidth: EncodingWidth | undefined;

  constructor(
    value: number | bigint,
    options?: { encodingWidth?: EncodingWidth }
  ) {
    super();
    this.value = BigInt(value);
    if (this.value < 0n)
      throw new RangeError('CborUint value must be non-negative');
    if (this.value > 0xffff_ffff_ffff_ffffn)
      throw new RangeError('CborUint value exceeds maximum uint64');
    this.encodingWidth = options?.encodingWidth;
  }

  override _encodeTo(writer: CborWriter, _options?: ToCBOROptions): void {
    writeHeadTo(writer, MT_UINT, this.value, this.encodingWidth);
  }

  _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    const suffix =
      this.encodingWidth !== undefined ? `_${this.encodingWidth}` : '';
    const v = this.value;
    switch (options?.intFormat) {
      case 'hex':
        return `0x${v.toString(16)}${suffix}`;
      case 'octal':
        return `0o${v.toString(8)}${suffix}`;
      case 'binary':
        return `0b${v.toString(2)}${suffix}`;
      default:
        return v.toString() + suffix;
    }
  }

  _toJS(options?: ToJSOptions): unknown {
    const mode = options?.integerAs ?? 'auto';
    if (mode === 'bigint') return this.value;
    if (mode === 'number') return Number(this.value);
    return this.value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(this.value)
      : this.value;
  }
}
