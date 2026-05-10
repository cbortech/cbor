export const CBOR_TAG: unique symbol = Symbol.for('cbor.tag');

// ─── Internal wrappers ────────────────────────────────────────────────────────

export class Null {
  valueOf(): null {
    return null;
  }
  toJSON(): null {
    return null;
  }
}

export class Undefined {
  valueOf(): undefined {
    return undefined;
  }
  toJSON(): undefined {
    return undefined;
  }
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/** @internal */
export function getCborTag(value: unknown): bigint | undefined {
  if (!_canHaveTag(value)) return undefined;
  const sym = (value as Record<symbol, unknown>)[CBOR_TAG];
  return typeof sym === 'bigint' ? sym : undefined;
}

/** @internal */
export function setCborTag(value: unknown, tag: bigint): object {
  let obj: object;
  switch (typeof value) {
    case 'number':
      obj = new Number(value);
      break;
    case 'string':
      obj = new String(value);
      break;
    case 'boolean':
      obj = new Boolean(value);
      break;
    case 'bigint':
      obj = Object(value);
      break;
    case 'undefined':
      obj = new Undefined();
      break;
    case 'object':
      if (value === null) {
        obj = new Null();
        break;
      }
      obj = value as object;
      break;
    default:
      throw new TypeError(
        `setCborTag: cannot tag value of type ${typeof value}`
      );
  }
  (obj as Record<symbol, bigint>)[CBOR_TAG] = tag;
  return obj;
}

/** @internal */
export function removeCborTag(value: unknown): unknown {
  if (value instanceof Number) return value.valueOf();
  if (value instanceof String) return value.valueOf();
  if (value instanceof Boolean) return value.valueOf();
  if (Object.prototype.toString.call(value) === '[object BigInt]')
    return (value as { valueOf(): bigint }).valueOf();
  if (value instanceof Null) return null;
  if (value instanceof Undefined) return undefined;
  if (typeof value === 'object' && value !== null) {
    delete (value as Record<symbol, unknown>)[CBOR_TAG];
    return value;
  }
  return value;
}

/** @internal */
export function getCborTaggedValue(value: unknown): unknown {
  if (value instanceof Number) return value.valueOf();
  if (value instanceof String) return value.valueOf();
  if (value instanceof Boolean) return value.valueOf();
  if (Object.prototype.toString.call(value) === '[object BigInt]')
    return (value as { valueOf(): bigint }).valueOf();
  if (value instanceof Null) return null;
  if (value instanceof Undefined) return undefined;
  return value;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

/** Return true if value can carry the [CBOR_TAG] symbol (i.e. is a non-null object). */
function _canHaveTag(value: unknown): value is object {
  // All boxed primitives (Number, String, Boolean, BigInt objects) also have
  // typeof === 'object', so a single check covers all cases.
  return typeof value === 'object' && value !== null;
}

// ─── Tag namespace ────────────────────────────────────────────────────────────

/**
 * Namespace for CBOR tag annotation utilities.
 *
 * @example
 * const v = CBOR.fromEDN('42("hello")').toJS();
 * Tag.get(v);        // 42n
 * Tag.getValue(v);   // "hello"
 *
 * const tagged = Tag.set([1, 2, 3], 100n);
 * Tag.remove(tagged); // [1, 2, 3]
 */
export class Tag {
  private constructor() {}

  /** Unique symbol used to attach a CBOR tag number to a JS value. */
  static readonly symbol: typeof CBOR_TAG = CBOR_TAG;

  /** Wrapper class for tagged `null` values. */
  static readonly Null = Null;

  /** Wrapper class for tagged `undefined` values. */
  static readonly Undefined = Undefined;

  /** Return the CBOR tag number attached to `value`, or `undefined` if none. */
  static get(value: unknown): bigint | undefined {
    return getCborTag(value);
  }

  /** Attach a CBOR tag number to `value` and return the annotated value. */
  static set(value: unknown, tag: bigint): object {
    return setCborTag(value, tag);
  }

  /** Remove the `[Tag.symbol]` annotation from `value` and return the plain value. */
  static remove(value: unknown): unknown {
    return removeCborTag(value);
  }

  /** Return the underlying plain JS value held inside a tagged wrapper. */
  static getValue(value: unknown): unknown {
    return getCborTaggedValue(value);
  }
}
