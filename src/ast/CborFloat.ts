import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_SIMPLE, AI_2BYTE, AI_4BYTE, AI_8BYTE } from '../cbor/constants';
import { autoSelectFloatPrecision, type CborWriter } from '../cbor/encode';
import {
  floatValueToString,
  floatSuffix,
  resolveIndent,
} from '../cdn/serialize-utils';
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
  precision: FloatPrecision | undefined;
  /**
   * Original app-string source (e.g. `float'7e00'`), set by the parser when
   * this float is the result of a `float'...'` app-string.  Used by toCDN()
   * to round-trip the literal when `appStrings` is not false.
   */
  ednSource?: string;

  /**
   * Original encoded payload bytes (big-endian, without the initial byte),
   * set by the decoder when the value is NaN so that NaN payloads survive a
   * decode → encode round-trip (a JS `number` cannot carry them).
   * Used by the encoder only when `value` is NaN and the length matches the
   * byte size of the encoded `precision`; ignored otherwise.
   */
  rawBits?: Uint8Array;

  constructor(
    value: number,
    options?: { precision?: FloatPrecision; rawBits?: Uint8Array }
  ) {
    super();
    this.value = value;
    this.precision = options?.precision;
    this.rawBits = options?.rawBits;
  }

  override _encodeTo(writer: CborWriter, _options?: ToCBOROptions): void {
    const precision = this.precision ?? autoSelectFloatPrecision(this.value);
    const initial = MT_SIMPLE << 5;
    // rawBits carries a NaN payload only; for any other value it would let
    // the encoded bytes contradict `value`, so it is ignored.
    const rawBits = Number.isNaN(this.value) ? this.rawBits : undefined;

    if (precision === 'half') {
      writer.writeByte(initial | AI_2BYTE); // 0xf9
      if (rawBits?.length === 2) writer.writeBytes(rawBits);
      else writer.writeFloat16(this.value);
    } else if (precision === 'single') {
      writer.writeByte(initial | AI_4BYTE); // 0xfa
      if (rawBits?.length === 4) writer.writeBytes(rawBits);
      else writer.writeFloat32(this.value);
    } else {
      // double
      writer.writeByte(initial | AI_8BYTE); // 0xfb
      if (rawBits?.length === 8) writer.writeBytes(rawBits);
      else writer.writeFloat64(this.value);
    }
  }

  _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    const mode = options?.encodingIndicators ?? 'auto';
    // In single-line output (no `indent`), a source spelling that spans
    // multiple lines (e.g. a `float<<...>>` app-sequence written across
    // lines) cannot be re-emitted, so it falls back to normal serialization.
    if (
      options?.appStrings !== false &&
      this.ednSource !== undefined &&
      (resolveIndent(options) !== null || !/[\r\n]/.test(this.ednSource))
    ) {
      const ednSource = this.ednSource;
      if (mode === 'never') return ednSource.replace(/_[0-3i]$/, '');
      if (mode === 'always') {
        if (/_[0-3i]$/.test(ednSource)) return ednSource;
        const actual = this.precision ?? autoSelectFloatPrecision(this.value);
        const suffix =
          actual === 'half' ? '_1' : actual === 'single' ? '_2' : '_3';
        return ednSource + suffix;
      }
      return ednSource;
    }
    const autoSelected = autoSelectFloatPrecision(this.value);
    const numStr =
      options?.floatFormat === 'hex'
        ? floatToHexFloat(this.value)
        : floatValueToString(this.value);
    return numStr + floatSuffix(this.value, this.precision, autoSelected, mode);
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this.value;
  }
}
