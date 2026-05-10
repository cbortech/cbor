/**
 * Wrapper for unrecognised CBOR simple values (0–255, excluding false/true/
 * null/undefined). Returned by CborSimple.toJS() so that fromJS() can
 * reconstruct the original CborSimple node and preserve the round-trip.
 *
 * Also serves as a namespace for simple-value utilities.
 *
 * @example
 * const v = CBOR.fromEDN('simple(19)').toJS();
 * Simple.is(v);    // true
 * Simple.get(v);   // 19
 *
 * const node = CBOR.fromJS(new Simple(19));
 * node.toEDN();    // "simple(19)"
 */
export class Simple {
  readonly value: number;

  constructor(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new RangeError('Simple value must be an integer in 0–255');
    this.value = value;
  }

  valueOf(): number {
    return this.value;
  }

  toJSON(): never {
    throw new TypeError(`simple(${this.value}) cannot be serialized to JSON`);
  }

  /** Return true if value is a Simple instance. */
  static is(value: unknown): value is Simple {
    return value instanceof Simple;
  }

  /** Return the simple number if value is a Simple instance, otherwise undefined. */
  static get(value: unknown): number | undefined {
    return value instanceof Simple ? value.value : undefined;
  }
}
