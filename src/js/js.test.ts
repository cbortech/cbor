import { describe, test, expect } from 'vitest';
import { fromJS } from './fromJS';
import { toJS } from './toJS';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborByteString } from '../ast/CborByteString';
import { CborIndefiniteByteString } from '../ast/CborIndefiniteByteString';
import { CborTextString } from '../ast/CborTextString';
import { CborIndefiniteTextString } from '../ast/CborIndefiniteTextString';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborTag } from '../ast/CborTag';
import { Tag } from '../tag';
import { MapEntries } from '../mapEntries';
import { CborFloat } from '../ast/CborFloat';
import { CborSimple } from '../ast/CborSimple';
import { CborBigUint, CborBigNint } from '../ast/CborBignum';
import { Simple } from '../simple';

// ─── fromJS ───────────────────────────────────────────────────────────────────

describe('fromJS — null / undefined / boolean', () => {
  test('null → CborSimple.NULL', () => {
    expect(fromJS(null)).toBe(CborSimple.NULL);
  });
  test('undefined → CborSimple.UNDEFINED', () => {
    expect(fromJS(undefined)).toBe(CborSimple.UNDEFINED);
  });
  test('true → CborSimple.TRUE', () => {
    expect(fromJS(true)).toBe(CborSimple.TRUE);
  });
  test('false → CborSimple.FALSE', () => {
    expect(fromJS(false)).toBe(CborSimple.FALSE);
  });
});

describe('fromJS — bigint', () => {
  test('0n → CborUint(0n)', () => {
    const node = fromJS(0n);
    expect(node).toBeInstanceOf(CborUint);
    expect((node as CborUint).value).toBe(0n);
  });
  test('42n → CborUint(42n)', () => {
    const node = fromJS(42n);
    expect(node).toBeInstanceOf(CborUint);
    expect((node as CborUint).value).toBe(42n);
  });
  test('-1n → CborNint(-1n)', () => {
    const node = fromJS(-1n);
    expect(node).toBeInstanceOf(CborNint);
    expect((node as CborNint).value).toBe(-1n);
  });
  test('-100n → CborNint(-100n)', () => {
    const node = fromJS(-100n);
    expect(node).toBeInstanceOf(CborNint);
    expect((node as CborNint).value).toBe(-100n);
  });
  test('2^64 → CborBigUint', () => {
    const n = 18446744073709551616n;
    const node = fromJS(n);
    expect(node).toBeInstanceOf(CborBigUint);
    expect((node as CborBigUint).bigValue).toBe(n);
  });
  test('-(2^64 + 1) → CborBigNint', () => {
    const n = -18446744073709551617n;
    const node = fromJS(n);
    expect(node).toBeInstanceOf(CborBigNint);
    expect((node as CborBigNint).bigValue).toBe(n);
  });
});

describe("fromJS — number (integerAs default='int')", () => {
  test('0 → CborUint(0n)', () => {
    const node = fromJS(0);
    expect(node).toBeInstanceOf(CborUint);
    expect((node as CborUint).value).toBe(0n);
  });
  test('42 → CborUint(42n)', () => {
    const node = fromJS(42);
    expect(node).toBeInstanceOf(CborUint);
  });
  test('-1 → CborNint(-1n)', () => {
    const node = fromJS(-1);
    expect(node).toBeInstanceOf(CborNint);
    expect((node as CborNint).value).toBe(-1n);
  });
  test('1.5 → CborFloat(1.5)', () => {
    const node = fromJS(1.5);
    expect(node).toBeInstanceOf(CborFloat);
    expect((node as CborFloat).value).toBe(1.5);
  });
  test('-0 → CborFloat(-0) (not CborNint)', () => {
    const node = fromJS(-0);
    expect(node).toBeInstanceOf(CborFloat);
    expect(Object.is((node as CborFloat).value, -0)).toBe(true);
  });
  test('NaN → CborFloat(NaN)', () => {
    const node = fromJS(NaN);
    expect(node).toBeInstanceOf(CborFloat);
    expect(isNaN((node as CborFloat).value)).toBe(true);
  });
  test('Infinity → CborFloat(Infinity)', () => {
    const node = fromJS(Infinity);
    expect(node).toBeInstanceOf(CborFloat);
  });
});

describe("fromJS — number with encodeIntegerAs='float'", () => {
  test('42 → CborFloat(42)', () => {
    const node = fromJS(42, { encodeIntegerAs: 'float' });
    expect(node).toBeInstanceOf(CborFloat);
    expect((node as CborFloat).value).toBe(42);
  });
  test('-1 → CborFloat(-1)', () => {
    const node = fromJS(-1, { encodeIntegerAs: 'float' });
    expect(node).toBeInstanceOf(CborFloat);
  });
});

describe('fromJS — string', () => {
  test('"" → CborTextString("")', () => {
    const node = fromJS('');
    expect(node).toBeInstanceOf(CborTextString);
    expect((node as CborTextString).value).toBe('');
  });
  test('"hello" → CborTextString("hello")', () => {
    const node = fromJS('hello');
    expect(node).toBeInstanceOf(CborTextString);
    expect((node as CborTextString).value).toBe('hello');
  });
});

describe('fromJS — Uint8Array', () => {
  test('Uint8Array → CborByteString (default)', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const node = fromJS(bytes);
    expect(node).toBeInstanceOf(CborByteString);
    expect((node as CborByteString).value).toEqual(bytes);
  });
  test("Uint8Array with uint8ArrayAs='array' → CborArray of CborUint", () => {
    const bytes = new Uint8Array([10, 20]);
    const node = fromJS(bytes, { uint8ArrayAs: 'array' });
    expect(node).toBeInstanceOf(CborArray);
    const arr = node as CborArray;
    expect(arr.items).toHaveLength(2);
    expect(arr.items[0]).toBeInstanceOf(CborUint);
    expect((arr.items[0] as CborUint).value).toBe(10n);
    expect((arr.items[1] as CborUint).value).toBe(20n);
  });
});

describe('fromJS — Array', () => {
  test('[] → CborArray([])', () => {
    const node = fromJS([]);
    expect(node).toBeInstanceOf(CborArray);
    expect((node as CborArray).items).toHaveLength(0);
  });
  test('[1, "a", null] → CborArray', () => {
    const node = fromJS([1, 'a', null]) as CborArray;
    expect(node).toBeInstanceOf(CborArray);
    expect(node.items[0]).toBeInstanceOf(CborUint);
    expect(node.items[1]).toBeInstanceOf(CborTextString);
    expect(node.items[2]).toBe(CborSimple.NULL);
  });
  test('nested [[1, 2]]', () => {
    const node = fromJS([[1, 2]]) as CborArray;
    expect(node.items[0]).toBeInstanceOf(CborArray);
  });
});

describe('fromJS — plain object', () => {
  test('{} → CborMap([])', () => {
    const node = fromJS({}) as CborMap;
    expect(node).toBeInstanceOf(CborMap);
    expect(node.entries).toHaveLength(0);
  });
  test('{ a: 1, b: "x" } → CborMap with CborTextString keys', () => {
    const node = fromJS({ a: 1, b: 'x' }) as CborMap;
    expect(node.entries).toHaveLength(2);
    expect(node.entries[0][0]).toBeInstanceOf(CborTextString);
    expect((node.entries[0][0] as CborTextString).value).toBe('a');
    expect(node.entries[0][1]).toBeInstanceOf(CborUint);
    expect(node.entries[1][0]).toBeInstanceOf(CborTextString);
    expect((node.entries[1][0] as CborTextString).value).toBe('b');
    expect(node.entries[1][1]).toBeInstanceOf(CborTextString);
  });
});

describe('fromJS — unsupported types', () => {
  test('function throws TypeError', () => {
    expect(() => fromJS(() => {})).toThrow(TypeError);
  });
  test('symbol throws TypeError', () => {
    expect(() => fromJS(Symbol())).toThrow(TypeError);
  });
});

describe('fromJS — builtinExtensions option', () => {
  class Marker {
    constructor(readonly text: string) {}
  }
  const markerExt = {
    isJSType: (v: unknown): v is Marker => v instanceof Marker,
    fromJS: (v: unknown) =>
      v instanceof Marker ? new CborTextString(v.text) : undefined,
  };

  test('a custom extension passed via `extensions` still applies with builtinExtensions: false', () => {
    const node = fromJS(new Marker('hi'), {
      extensions: [markerExt],
      builtinExtensions: false,
    }) as CborTextString;
    expect(node).toBeInstanceOf(CborTextString);
    expect(node.value).toBe('hi');
  });

  test('none of the default bundled extensions implement fromJS/isJSType, so omitting builtinExtensions behaves the same as false for plain values', () => {
    expect(fromJS(42, { builtinExtensions: false })).toBeInstanceOf(CborUint);
    expect(fromJS(42)).toBeInstanceOf(CborUint);
  });
});

// ─── toJS ────────────────────────────────────────────────────────────────────

describe('CborUint.toJS()', () => {
  test('small value → number', () => {
    expect(new CborUint(42n).toJS()).toBe(42);
  });
  test('MAX_SAFE_INTEGER → number', () => {
    expect(new CborUint(BigInt(Number.MAX_SAFE_INTEGER)).toJS()).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });
  test('MAX_SAFE_INTEGER+1 → bigint', () => {
    const n = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(new CborUint(n).toJS()).toBe(n);
  });
  test('0 → 0 (number)', () => {
    expect(new CborUint(0n).toJS()).toBe(0);
    expect(typeof new CborUint(0n).toJS()).toBe('number');
  });
});

describe('CborNint.toJS()', () => {
  test('-1 → -1 (number)', () => {
    expect(new CborNint(-1n).toJS()).toBe(-1);
  });
  test('MIN_SAFE_INTEGER → number', () => {
    expect(new CborNint(BigInt(Number.MIN_SAFE_INTEGER)).toJS()).toBe(
      Number.MIN_SAFE_INTEGER
    );
  });
  test('below MIN_SAFE_INTEGER → bigint', () => {
    const n = BigInt(Number.MIN_SAFE_INTEGER) - 1n;
    expect(new CborNint(n).toJS()).toBe(n);
  });
});

describe('CborByteString.toJS()', () => {
  test('returns the Uint8Array', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(new CborByteString(bytes).toJS()).toBe(bytes);
  });
});

describe('CborIndefiniteByteString.toJS()', () => {
  test('concatenates chunks', () => {
    const node = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([1, 2])),
      new CborByteString(new Uint8Array([3, 4, 5])),
    ]);
    expect(node.toJS()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
  test('empty chunks → empty Uint8Array', () => {
    expect(new CborIndefiniteByteString([]).toJS()).toEqual(new Uint8Array(0));
  });
});

describe('CborTextString.toJS()', () => {
  test('returns the string value', () => {
    expect(new CborTextString('hello').toJS()).toBe('hello');
  });
});

describe('CborIndefiniteTextString.toJS()', () => {
  test('concatenates chunks', () => {
    const node = new CborIndefiniteTextString([
      new CborTextString('strea'),
      new CborTextString('ming'),
    ]);
    expect(node.toJS()).toBe('streaming');
  });
  test('empty → ""', () => {
    expect(new CborIndefiniteTextString([]).toJS()).toBe('');
  });
});

describe('CborArray.toJS()', () => {
  test('[] → []', () => {
    expect(new CborArray([]).toJS()).toEqual([]);
  });
  test('[1, 2, 3] → [1, 2, 3]', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborUint(2n),
      new CborUint(3n),
    ]);
    expect(node.toJS()).toEqual([1, 2, 3]);
  });
  test('nested', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborArray([new CborUint(2n), new CborUint(3n)]),
    ]);
    expect(node.toJS()).toEqual([1, [2, 3]]);
  });
});

describe('CborMap.toJS() — all text keys → Record', () => {
  test('{} → {}', () => {
    expect(new CborMap([]).toJS()).toEqual({});
  });
  test('{"a": 1} → { a: 1 }', () => {
    const node = new CborMap([[new CborTextString('a'), new CborUint(1n)]]);
    expect(node.toJS()).toEqual({ a: 1 });
  });
  test('mixed values', () => {
    const node = new CborMap([
      [new CborTextString('x'), new CborUint(10n)],
      [new CborTextString('y'), new CborTextString('hello')],
    ]);
    expect(node.toJS()).toEqual({ x: 10, y: 'hello' });
  });
});

describe('CborMap.toJS() — non-text keys → MapEntries', () => {
  test('integer key → MapEntries', () => {
    const node = new CborMap([[new CborUint(1n), new CborUint(2n)]]);
    const result = node.toJS() as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    expect(result).toEqual([[1, 2]]);
  });
  test('mixed key types → MapEntries', () => {
    const node = new CborMap([
      [new CborUint(1n), new CborUint(10n)],
      [new CborTextString('a'), new CborUint(20n)],
    ]);
    const result = node.toJS() as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    expect(result).toEqual([
      [1, 10],
      ['a', 20],
    ]);
  });
});

describe('CborTag.toJS()', () => {
  test('integer content → boxed Number with [Tag.symbol]', () => {
    const result = new CborTag(1n, new CborUint(1363896240n)).toJS();
    expect(result instanceof Number).toBe(true);
    expect((result as Number).valueOf()).toBe(1363896240);
    expect((result as Record<typeof Tag.symbol, bigint>)[Tag.symbol]).toBe(1n);
    expect(Tag.get(result)).toBe(1n);
  });
  test('string content → boxed String with [Tag.symbol]', () => {
    const result = new CborTag(42n, new CborTextString('hello')).toJS();
    expect(result instanceof String).toBe(true);
    expect((result as String).valueOf()).toBe('hello');
    expect(Tag.get(result)).toBe(42n);
  });
  test('boolean content → boxed Boolean with [Tag.symbol]', () => {
    const result = new CborTag(7n, CborSimple.TRUE).toJS();
    expect(result instanceof Boolean).toBe(true);
    expect((result as Boolean).valueOf()).toBe(true);
    expect(Tag.get(result)).toBe(7n);
  });
  test('bigint content → boxed BigInt with [Tag.symbol]', () => {
    const result = new CborTag(2n, new CborUint(0xffff_ffff_ffff_ffffn)).toJS();
    expect(Object.prototype.toString.call(result)).toBe('[object BigInt]');
    expect((result as { valueOf(): bigint }).valueOf()).toBe(
      0xffff_ffff_ffff_ffffn
    );
    expect(Tag.get(result)).toBe(2n);
  });
  test('array content → Array with [Tag.symbol]', () => {
    const result = new CborTag(100n, new CborArray([new CborUint(1n)])).toJS();
    expect(Array.isArray(result)).toBe(true);
    expect(Tag.get(result)).toBe(100n);
    expect((result as unknown[])[0]).toBe(1);
  });
  test('null content → Tag.Null with [Tag.symbol]', () => {
    const result = new CborTag(5n, CborSimple.NULL).toJS();
    expect(Tag.get(result)).toBe(5n);
    expect((result as { valueOf(): unknown }).valueOf()).toBe(null);
  });
  test('Tag.get returns undefined for untagged values', () => {
    expect(Tag.get(42)).toBeUndefined();
    expect(Tag.get('hello')).toBeUndefined();
    expect(Tag.get(null)).toBeUndefined();
    expect(Tag.get({})).toBeUndefined();
  });

  test('fromJS round-trip: tagged integer', () => {
    const original = new CborTag(1n, new CborUint(42n));
    const jsVal = original.toJS();
    const restored = fromJS(jsVal);
    expect(restored).toBeInstanceOf(CborTag);
    expect((restored as CborTag).tag).toBe(1n);
    expect((restored as CborTag).content).toBeInstanceOf(CborUint);
    expect(((restored as CborTag).content as CborUint).value).toBe(42n);
  });
  test('fromJS round-trip: tagged string', () => {
    const original = new CborTag(42n, new CborTextString('hello'));
    const jsVal = original.toJS();
    const restored = fromJS(jsVal);
    expect(restored).toBeInstanceOf(CborTag);
    expect((restored as CborTag).tag).toBe(42n);
    expect(((restored as CborTag).content as CborTextString).value).toBe(
      'hello'
    );
  });
  test('fromJS round-trip: tagged null', () => {
    const original = new CborTag(5n, CborSimple.NULL);
    const jsVal = original.toJS();
    const restored = fromJS(jsVal);
    expect(restored).toBeInstanceOf(CborTag);
    expect((restored as CborTag).tag).toBe(5n);
    expect((restored as CborTag).content).toBe(CborSimple.NULL);
  });
});

describe('Tag.set()', () => {
  test('number primitive → boxed Number with tag', () => {
    const v = Tag.set(42, 1n);
    expect(v instanceof Number).toBe(true);
    expect((v as Number).valueOf()).toBe(42);
    expect(Tag.get(v)).toBe(1n);
  });
  test('string primitive → boxed String with tag', () => {
    const v = Tag.set('hello', 99n);
    expect(v instanceof String).toBe(true);
    expect(Tag.get(v)).toBe(99n);
  });
  test('boolean primitive → boxed Boolean with tag', () => {
    const v = Tag.set(false, 7n);
    expect(v instanceof Boolean).toBe(true);
    expect(Tag.get(v)).toBe(7n);
  });
  test('bigint primitive → boxed BigInt with tag', () => {
    const v = Tag.set(42n, 2n);
    expect(Object.prototype.toString.call(v)).toBe('[object BigInt]');
    expect(Tag.get(v)).toBe(2n);
  });
  test('null → Tag.Null with tag', () => {
    const v = Tag.set(null, 5n);
    expect(Tag.get(v)).toBe(5n);
    expect((v as { valueOf(): unknown }).valueOf()).toBe(null);
  });
  test('undefined → Tag.Undefined with tag', () => {
    const v = Tag.set(undefined, 6n);
    expect(Tag.get(v)).toBe(6n);
    expect((v as { valueOf(): unknown }).valueOf()).toBeUndefined();
  });
  test('array → same array mutated with tag', () => {
    const arr = [1, 2, 3];
    const v = Tag.set(arr, 10n);
    expect(v).toBe(arr); // same reference
    expect(Tag.get(v)).toBe(10n);
  });
  test('plain object → same object mutated with tag', () => {
    const obj = { x: 1 };
    const v = Tag.set(obj, 20n);
    expect(v).toBe(obj);
    expect(Tag.get(v)).toBe(20n);
  });
  test('already-boxed Number → tag updated in-place', () => {
    const boxed = new Number(7);
    Tag.set(boxed, 1n);
    const v = Tag.set(boxed, 2n); // overwrite
    expect(v).toBe(boxed);
    expect(Tag.get(v)).toBe(2n);
  });
});

describe('Tag.remove()', () => {
  test('boxed Number → number primitive', () => {
    expect(Tag.remove(Tag.set(3.14, 1n))).toBe(3.14);
  });
  test('boxed String → string primitive', () => {
    expect(Tag.remove(Tag.set('hi', 1n))).toBe('hi');
  });
  test('boxed Boolean → boolean primitive', () => {
    expect(Tag.remove(Tag.set(true, 1n))).toBe(true);
  });
  test('boxed BigInt → bigint primitive', () => {
    expect(Tag.remove(Tag.set(99n, 1n))).toBe(99n);
  });
  test('Tag.Null → null', () => {
    expect(Tag.remove(Tag.set(null, 1n))).toBe(null);
  });
  test('Tag.Undefined → undefined', () => {
    expect(Tag.remove(Tag.set(undefined, 1n))).toBeUndefined();
  });
  test('tagged array → symbol removed, same array returned', () => {
    const arr = [1, 2];
    const tagged = Tag.set(arr, 5n);
    const result = Tag.remove(tagged);
    expect(result).toBe(arr);
    expect(Tag.get(result)).toBeUndefined();
  });
  test('untagged primitive → returned as-is', () => {
    expect(Tag.remove(42)).toBe(42);
    expect(Tag.remove('x')).toBe('x');
  });
});

describe('Tag.getValue()', () => {
  test('boxed Number → number primitive', () => {
    expect(Tag.getValue(Tag.set(7, 1n))).toBe(7);
  });
  test('boxed String → string primitive', () => {
    expect(Tag.getValue(Tag.set('world', 1n))).toBe('world');
  });
  test('Tag.Null → null', () => {
    expect(Tag.getValue(Tag.set(null, 1n))).toBe(null);
  });
  test('tagged array → array itself (symbol NOT removed)', () => {
    const arr = [1, 2];
    const tagged = Tag.set(arr, 5n);
    const result = Tag.getValue(tagged);
    expect(result).toBe(arr);
    expect(Tag.get(result)).toBe(5n); // tag still present
  });
  test('untagged number → returned as-is', () => {
    expect(Tag.getValue(123)).toBe(123);
  });
});

describe('CborFloat.toJS()', () => {
  test('1.5 → 1.5', () => expect(new CborFloat(1.5).toJS()).toBe(1.5));
  test('NaN → NaN', () =>
    expect(isNaN(new CborFloat(NaN).toJS() as number)).toBe(true));
  test('-0 → -0', () =>
    expect(Object.is(new CborFloat(-0).toJS(), -0)).toBe(true));
});

describe('CborSimple.toJS()', () => {
  test('false (20)', () => expect(CborSimple.FALSE.toJS()).toBe(false));
  test('true (21)', () => expect(CborSimple.TRUE.toJS()).toBe(true));
  test('null (22)', () => expect(CborSimple.NULL.toJS()).toBe(null));
  test('undefined (23)', () =>
    expect(CborSimple.UNDEFINED.toJS()).toBe(undefined));
  test('simple(16) → Simple(16)', () => {
    const v = new CborSimple(16).toJS();
    expect(v).toBeInstanceOf(Simple);
    expect((v as Simple).value).toBe(16);
  });
  test('simple(255) → Simple(255)', () => {
    const v = new CborSimple(255).toJS();
    expect(v).toBeInstanceOf(Simple);
    expect((v as Simple).value).toBe(255);
  });
});

// ─── Round-trip toJS(fromJS(x)) ──────────────────────────────────────────────

describe('toJS(fromJS(x)) round-trip', () => {
  test('null', () => expect(toJS(fromJS(null))).toBe(null));
  test('undefined', () => expect(toJS(fromJS(undefined))).toBe(undefined));
  test('true', () => expect(toJS(fromJS(true))).toBe(true));
  test('false', () => expect(toJS(fromJS(false))).toBe(false));
  test('42 (integer)', () => expect(toJS(fromJS(42))).toBe(42));
  test('-5 (negative integer)', () => expect(toJS(fromJS(-5))).toBe(-5));
  test('1.5 (float)', () => expect(toJS(fromJS(1.5))).toBe(1.5));
  test('"hello" (string)', () => expect(toJS(fromJS('hello'))).toBe('hello'));
  test('[1, 2, 3] (array)', () =>
    expect(toJS(fromJS([1, 2, 3]))).toEqual([1, 2, 3]));
  test('{ a: 1 } (object)', () =>
    expect(toJS(fromJS({ a: 1 }))).toEqual({ a: 1 }));
  test('Uint8Array', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toJS(fromJS(bytes))).toEqual(bytes);
  });
  test('nested object', () => {
    const val = { x: [1, 2], y: { z: 'hi' } };
    expect(toJS(fromJS(val))).toEqual(val);
  });
  test('bigint 0n', () => expect(toJS(fromJS(0n))).toBe(0));
  test('bigint large → stays bigint', () => {
    const n = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(toJS(fromJS(n))).toBe(n);
  });
});

// ─── ArrayBufferView / ArrayBufferLike ────────────────────────────────────────

describe('fromJS — ArrayBufferView / ArrayBufferLike', () => {
  test('ArrayBuffer → CborByteString', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const node = fromJS(buf) as CborByteString;
    expect(node).toBeInstanceOf(CborByteString);
    expect(node.value).toEqual(new Uint8Array([1, 2, 3]));
  });
  test('Int16Array → CborByteString (raw bytes)', () => {
    const arr = new Int16Array([0x0102]);
    const node = fromJS(arr) as CborByteString;
    expect(node).toBeInstanceOf(CborByteString);
    expect(node.value.byteLength).toBe(2);
  });
  test('DataView → CborByteString', () => {
    const buf = new Uint8Array([0xde, 0xad]).buffer;
    const dv = new DataView(buf);
    const node = fromJS(dv) as CborByteString;
    expect(node).toBeInstanceOf(CborByteString);
    expect(node.value).toEqual(new Uint8Array([0xde, 0xad]));
  });
  test('Uint8Array with uint8ArrayAs:"array" still works', () => {
    const arr = new Uint8Array([1, 2]);
    const node = fromJS(arr, { uint8ArrayAs: 'array' }) as CborArray;
    expect(node).toBeInstanceOf(CborArray);
    expect(node.items).toHaveLength(2);
  });
  test('Float32Array subarray (byteOffset) → correct bytes', () => {
    const buf = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer;
    const view = new Uint8Array(buf, 2, 3); // bytes [2,3,4]
    const node = fromJS(view) as CborByteString;
    expect(node.value).toEqual(new Uint8Array([2, 3, 4]));
  });
});

// ─── Boxed primitives ─────────────────────────────────────────────────────────

describe('fromJS — boxed primitives', () => {
  test('new Number(42) → same as fromJS(42)', () => {
    expect(fromJS(new Number(42)).toCBOR()).toEqual(fromJS(42).toCBOR());
  });
  test('new Number(1.5) → CborFloat', () => {
    expect(fromJS(new Number(1.5)).toCBOR()).toEqual(fromJS(1.5).toCBOR());
  });
  test('new Boolean(true) → CborSimple.TRUE', () => {
    expect(fromJS(new Boolean(true)).toCBOR()).toEqual(fromJS(true).toCBOR());
  });
  test('new Boolean(false) → CborSimple.FALSE', () => {
    expect(fromJS(new Boolean(false)).toCBOR()).toEqual(fromJS(false).toCBOR());
  });
  test('new String("hi") → CborTextString', () => {
    expect(fromJS(new String('hi')).toCBOR()).toEqual(fromJS('hi').toCBOR());
  });
  test('Object(1n) → same as fromJS(1n)', () => {
    expect(fromJS(Object(1n)).toCBOR()).toEqual(fromJS(1n).toCBOR());
  });
  test('Object(-5n) → same as fromJS(-5n)', () => {
    expect(fromJS(Object(-5n)).toCBOR()).toEqual(fromJS(-5n).toCBOR());
  });
});

// ─── MapEntries ───────────────────────────────────────────────────────────────

describe('fromJS — MapEntries', () => {
  test('MapEntries → CborMap', () => {
    const entries = MapEntries.from([
      ['a', 1],
      ['b', 2],
    ] as [unknown, unknown][]);
    expect(fromJS(entries)).toBeInstanceOf(CborMap);
  });

  test('round-trip: CborMap → toJS entries → fromJS → CborMap', () => {
    const original = new CborMap([
      [new CborTextString('a'), new CborUint(1n)],
      [new CborTextString('b'), new CborUint(2n)],
    ]);
    const entries = original.toJS({ mapAs: 'entries' });
    expect(entries).toBeInstanceOf(MapEntries);
    const restored = fromJS(entries) as CborMap;
    expect(restored).toBeInstanceOf(CborMap);
    expect(restored.toJS()).toEqual({ a: 1, b: 2 });
  });

  test('round-trip: preserves duplicate keys', () => {
    const original = new CborMap([
      [new CborUint(1n), new CborTextString('to')],
      [new CborUint(1n), new CborTextString('fro')],
    ]);
    const entries = original.toJS({ mapAs: 'entries' });
    const restored = fromJS(entries) as CborMap;
    expect(restored.entries).toHaveLength(2);
    expect(restored.toJS({ mapAs: 'entries' })).toEqual([
      [1, 'to'],
      [1, 'fro'],
    ]);
  });

  test('round-trip: non-string keys preserved', () => {
    const original = new CborMap([
      [new CborUint(42n), new CborTextString('x')],
      [new CborTextString('y'), new CborUint(2n)],
    ]);
    const entries = original.toJS({ mapAs: 'entries' });
    const restored = fromJS(entries) as CborMap;
    expect(restored.toJS({ mapAs: 'entries' })).toEqual([
      [42, 'x'],
      ['y', 2],
    ]);
  });
});
