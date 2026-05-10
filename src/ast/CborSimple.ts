import type { ToEDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { Simple } from '../simple';
import { MT_SIMPLE, AI_1BYTE } from '../cbor/constants';

/**
 * CBOR Major Type 7 — simple value (0–255).
 *
 * Well-known values:
 *   20 → false
 *   21 → true
 *   22 → null
 *   23 → undefined
 */
export class CborSimple extends CborItem {
  readonly value: number;

  constructor(value: number) {
    super();
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new RangeError('CborSimple value must be an integer in 0–255');
    this.value = value;
  }

  static readonly FALSE = new CborSimple(20);
  static readonly TRUE = new CborSimple(21);
  static readonly NULL = new CborSimple(22);
  static readonly UNDEFINED = new CborSimple(23);

  _toCBOR(_options?: ToCBOROptions): Uint8Array {
    // Values 0–23: encoded in the initial byte (MT7 | value)
    if (this.value <= 23)
      return new Uint8Array([(MT_SIMPLE << 5) | this.value]);
    // Values 24–255: MT7, AI_1BYTE, then one value byte
    return new Uint8Array([(MT_SIMPLE << 5) | AI_1BYTE, this.value]);
  }

  _toEDN(_options: ToEDNOptions | undefined, _depth: number): string {
    switch (this.value) {
      case 20:
        return 'false';
      case 21:
        return 'true';
      case 22:
        return 'null';
      case 23:
        return 'undefined';
      default:
        return `simple(${this.value})`;
    }
  }

  _toJS(_options?: ToJSOptions): unknown {
    switch (this.value) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      default:
        return new Simple(this.value);
    }
  }
}
