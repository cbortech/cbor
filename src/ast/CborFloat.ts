import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_SIMPLE, AI_2BYTE, AI_4BYTE, AI_8BYTE } from '../cbor/constants';
import { autoSelectFloatPrecision } from '../cbor/encode';
import { writeFloat16 } from '../utils/float16';
import { floatValueToString, floatSuffix } from '../edn/serialize-utils';
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

  constructor(value: number, options?: { precision?: FloatPrecision }) {
    super();
    this.value = value;
    this.precision = options?.precision;
  }

  _toCBOR(_options?: ToCBOROptions): Uint8Array {
    const precision = this.precision ?? autoSelectFloatPrecision(this.value);
    const initial = MT_SIMPLE << 5;

    if (precision === 'half') {
      const buf = new Uint8Array(3);
      buf[0] = initial | AI_2BYTE; // 0xf9
      writeFloat16(new DataView(buf.buffer), 1, this.value, false);
      return buf;
    }
    if (precision === 'single') {
      const buf = new Uint8Array(5);
      buf[0] = initial | AI_4BYTE; // 0xfa
      new DataView(buf.buffer).setFloat32(1, this.value, false);
      return buf;
    }
    // double
    const buf = new Uint8Array(9);
    buf[0] = initial | AI_8BYTE; // 0xfb
    new DataView(buf.buffer).setFloat64(1, this.value, false);
    return buf;
  }

  _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
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
