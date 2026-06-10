import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_SIMPLE, AI_2BYTE, AI_4BYTE, AI_8BYTE } from '../cbor/constants';
import { autoSelectFloatPrecision, type CborWriter } from '../cbor/encode';
import { floatValueToString, floatSuffix } from '../cdn/serialize-utils';
import { floatToHexFloat } from '../utils/hexfloat';

export type FloatPrecision = 'half' | 'single' | 'double';

/**
 * CBOR Major Type 7 — IEEE 754 floating-point number.
 *
 * `precision` records the encoding size from the original CBOR stream so
 * that lossless round-trips are preserved.  When constructing from a JS
 * `number`, omit `precision` (`undefined`) and the encoder will choose
 * the smallest encoding that preserves the value exactly.
 */
export class CborFloat extends CborItem {
  readonly value: number;
  /**
   * Encoding size hint.
   * - `'half'` / `'single'` / `'double'`: use exactly this size (set by the
   *   decoder to guarantee lossless round-trips).
   * - `undefined`: encoder auto-selects the smallest lossless size.
   */
  readonly precision: FloatPrecision | undefined;
  /**
   * Original app-string source (e.g. `float'7e00'`), set by the parser when
   * this float is the result of a `float'...'` app-string.  Used by toCDN()
   * to round-trip the literal when `appStrings` is not false.
   */
  ednSource?: string;

  constructor(value: number, options?: { precision?: FloatPrecision }) {
    super();
    this.value = value;
    this.precision = options?.precision;
  }

  override _encodeTo(writer: CborWriter, _options?: ToCBOROptions): void {
    const precision = this.precision ?? autoSelectFloatPrecision(this.value);
    const initial = MT_SIMPLE << 5;

    if (precision === 'half') {
      writer.writeByte(initial | AI_2BYTE); // 0xf9
      writer.writeFloat16(this.value);
    } else if (precision === 'single') {
      writer.writeByte(initial | AI_4BYTE); // 0xfa
      writer.writeFloat32(this.value);
    } else {
      // double
      writer.writeByte(initial | AI_8BYTE); // 0xfb
      writer.writeFloat64(this.value);
    }
  }

  _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    if (options?.appStrings !== false && this.ednSource !== undefined)
      return this.ednSource;
    const autoSelected = autoSelectFloatPrecision(this.value);
    const numStr =
      options?.floatFormat === 'hex'
        ? floatToHexFloat(this.value)
        : floatValueToString(this.value);
    return numStr + floatSuffix(this.value, this.precision, autoSelected);
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this.value;
  }
}
