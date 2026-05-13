import { describe, test, expect } from 'vitest';
import { MapEntries } from '../mapEntries';
import { CborItem } from './CborItem';
import { CborUint } from './CborUint';
import { CborNint } from './CborNint';
import { CborByteString } from './CborByteString';
import { CborIndefiniteByteString } from './CborIndefiniteByteString';
import { CborTextString } from './CborTextString';
import { CborIndefiniteTextString } from './CborIndefiniteTextString';
import { CborArray } from './CborArray';
import { CborMap } from './CborMap';
import { CborTag } from './CborTag';
import { CborFloat } from './CborFloat';
import { CborSimple } from './CborSimple';
import { Tag } from '../tag';

// ─── CborUint ─────────────────────────────────────────────────────────────────

describe('CborUint', () => {
  test('stores value as bigint from number', () => {
    expect(new CborUint(42).value).toBe(42n);
  });

  test('stores value as bigint from bigint', () => {
    expect(new CborUint(42n).value).toBe(42n);
  });

  test('accepts 0', () => {
    expect(new CborUint(0).value).toBe(0n);
  });

  test('accepts maximum uint64', () => {
    const max = 0xffff_ffff_ffff_ffffn;
    expect(new CborUint(max).value).toBe(max);
  });

  test('rejects negative values', () => {
    expect(() => new CborUint(-1)).toThrow(RangeError);
    expect(() => new CborUint(-1n)).toThrow(RangeError);
  });

  test('rejects values exceeding uint64 max', () => {
    expect(() => new CborUint(0x1_0000_0000_0000_0000n)).toThrow(RangeError);
  });

  test('is instanceof CborItem', () => {
    expect(new CborUint(0)).toBeInstanceOf(CborItem);
  });

  describe('toJS() — integerAs option', () => {
    const safe = new CborUint(42n);
    const large = new CborUint(0xffff_ffff_ffff_ffffn);
    test('default (auto): safe → number', () => {
      expect(safe.toJS()).toBe(42);
      expect(typeof safe.toJS()).toBe('number');
    });
    test('default (auto): large → bigint', () => {
      expect(large.toJS()).toBe(0xffff_ffff_ffff_ffffn);
      expect(typeof large.toJS()).toBe('bigint');
    });
    test("integerAs 'number': always number", () => {
      expect(safe.toJS({ integerAs: 'number' })).toBe(42);
      expect(typeof large.toJS({ integerAs: 'number' })).toBe('number');
    });
    test("integerAs 'bigint': always bigint", () => {
      expect(safe.toJS({ integerAs: 'bigint' })).toBe(42n);
      expect(typeof safe.toJS({ integerAs: 'bigint' })).toBe('bigint');
      expect(large.toJS({ integerAs: 'bigint' })).toBe(0xffff_ffff_ffff_ffffn);
    });
    test("integerAs 'auto': same as default", () => {
      expect(safe.toJS({ integerAs: 'auto' })).toBe(42);
      expect(large.toJS({ integerAs: 'auto' })).toBe(0xffff_ffff_ffff_ffffn);
    });
  });
});

// ─── CborNint ─────────────────────────────────────────────────────────────────

describe('CborNint', () => {
  test('argument = -1 - value: -1 → argument 0', () => {
    const n = new CborNint(-1n);
    expect(n.argument).toBe(0n);
    expect(n.value).toBe(-1n);
  });

  test('argument = -1 - value: -5 → argument 4', () => {
    const n = new CborNint(-5n);
    expect(n.argument).toBe(4n);
    expect(n.value).toBe(-5n);
  });

  test('value getter returns -1 - argument', () => {
    const n = new CborNint(-100n);
    expect(n.value).toBe(-100n);
    expect(n.argument).toBe(99n);
  });

  test('accepts number input', () => {
    const n = new CborNint(-10);
    expect(n.value).toBe(-10n);
  });

  test('accepts minimum value (-2^64)', () => {
    const min = -(0xffff_ffff_ffff_ffffn + 1n);
    const n = new CborNint(min);
    expect(n.value).toBe(min);
    expect(n.argument).toBe(0xffff_ffff_ffff_ffffn);
  });

  test('rejects zero', () => {
    expect(() => new CborNint(0)).toThrow(RangeError);
    expect(() => new CborNint(0n)).toThrow(RangeError);
  });

  test('rejects positive values', () => {
    expect(() => new CborNint(1)).toThrow(RangeError);
  });

  test('rejects values below minimum', () => {
    expect(() => new CborNint(-(0xffff_ffff_ffff_ffffn + 2n))).toThrow(
      RangeError
    );
  });

  test('is instanceof CborItem', () => {
    expect(new CborNint(-1)).toBeInstanceOf(CborItem);
  });

  describe('toJS() — integerAs option', () => {
    const safe = new CborNint(-42n);
    const large = new CborNint(-(0xffff_ffff_ffff_ffffn + 1n));
    test('default (auto): safe → number', () => {
      expect(safe.toJS()).toBe(-42);
      expect(typeof safe.toJS()).toBe('number');
    });
    test('default (auto): large → bigint', () => {
      expect(large.toJS()).toBe(-(0xffff_ffff_ffff_ffffn + 1n));
      expect(typeof large.toJS()).toBe('bigint');
    });
    test("integerAs 'number': always number", () => {
      expect(safe.toJS({ integerAs: 'number' })).toBe(-42);
      expect(typeof large.toJS({ integerAs: 'number' })).toBe('number');
    });
    test("integerAs 'bigint': always bigint", () => {
      expect(safe.toJS({ integerAs: 'bigint' })).toBe(-42n);
      expect(typeof safe.toJS({ integerAs: 'bigint' })).toBe('bigint');
    });
    test("integerAs 'auto': same as default", () => {
      expect(safe.toJS({ integerAs: 'auto' })).toBe(-42);
      expect(large.toJS({ integerAs: 'auto' })).toBe(
        -(0xffff_ffff_ffff_ffffn + 1n)
      );
    });
  });
});

// ─── CborByteString ───────────────────────────────────────────────────────────

describe('CborByteString', () => {
  test('stores value', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const node = new CborByteString(bytes);
    expect(node.value).toBe(bytes);
  });

  test('indefiniteLength is false', () => {
    expect(new CborByteString(new Uint8Array()).indefiniteLength).toBe(false);
  });

  test('ednEncoding defaults to hex', () => {
    expect(new CborByteString(new Uint8Array()).ednEncoding).toBe('hex');
  });

  test('ednEncoding can be overridden', () => {
    const node = new CborByteString(new Uint8Array(), {
      ednEncoding: 'base64',
    });
    expect(node.ednEncoding).toBe('base64');
  });

  test('accepts empty byte string', () => {
    expect(new CborByteString(new Uint8Array()).value).toHaveLength(0);
  });

  test('is instanceof CborItem', () => {
    expect(new CborByteString(new Uint8Array())).toBeInstanceOf(CborItem);
  });
});

// ─── CborIndefiniteByteString ─────────────────────────────────────────────────

describe('CborIndefiniteByteString', () => {
  test('stores chunks', () => {
    const c1 = new CborByteString(new Uint8Array([0xde]));
    const c2 = new CborByteString(new Uint8Array([0xad]));
    const node = new CborIndefiniteByteString([c1, c2]);
    expect(node.chunks).toHaveLength(2);
    expect(node.chunks[0]).toBe(c1);
    expect(node.chunks[1]).toBe(c2);
  });

  test('indefiniteLength is true', () => {
    expect(new CborIndefiniteByteString([]).indefiniteLength).toBe(true);
  });

  test('accepts empty chunk list', () => {
    expect(new CborIndefiniteByteString([]).chunks).toHaveLength(0);
  });

  test('is instanceof CborItem', () => {
    expect(new CborIndefiniteByteString([])).toBeInstanceOf(CborItem);
  });
});

// ─── CborTextString ───────────────────────────────────────────────────────────

describe('CborTextString', () => {
  test('stores value', () => {
    expect(new CborTextString('hello').value).toBe('hello');
  });

  test('indefiniteLength is false', () => {
    expect(new CborTextString('').indefiniteLength).toBe(false);
  });

  test('accepts empty string', () => {
    expect(new CborTextString('').value).toBe('');
  });

  test('accepts Unicode', () => {
    expect(new CborTextString('日本語').value).toBe('日本語');
  });

  test('is instanceof CborItem', () => {
    expect(new CborTextString('')).toBeInstanceOf(CborItem);
  });
});

// ─── CborIndefiniteTextString ─────────────────────────────────────────────────

describe('CborIndefiniteTextString', () => {
  test('stores chunks', () => {
    const c1 = new CborTextString('hello');
    const c2 = new CborTextString(' world');
    const node = new CborIndefiniteTextString([c1, c2]);
    expect(node.chunks).toHaveLength(2);
    expect(node.chunks[0]).toBe(c1);
    expect(node.chunks[1]).toBe(c2);
  });

  test('indefiniteLength is true', () => {
    expect(new CborIndefiniteTextString([]).indefiniteLength).toBe(true);
  });

  test('is instanceof CborItem', () => {
    expect(new CborIndefiniteTextString([])).toBeInstanceOf(CborItem);
  });
});

// ─── CborArray ────────────────────────────────────────────────────────────────

describe('CborArray', () => {
  test('stores items', () => {
    const items = [new CborUint(1), new CborUint(2), new CborUint(3)];
    const node = new CborArray(items);
    expect(node.items).toHaveLength(3);
    expect(node.items[0]).toBe(items[0]);
  });

  test('indefiniteLength defaults to false', () => {
    expect(new CborArray([]).indefiniteLength).toBe(false);
  });

  test('indefiniteLength can be set to true', () => {
    expect(new CborArray([], { indefiniteLength: true }).indefiniteLength).toBe(
      true
    );
  });

  test('accepts empty array', () => {
    expect(new CborArray([]).items).toHaveLength(0);
  });

  test('is instanceof CborItem', () => {
    expect(new CborArray([])).toBeInstanceOf(CborItem);
  });
});

// ─── CborMap ──────────────────────────────────────────────────────────────────

describe('CborMap', () => {
  test('stores entries', () => {
    const entries: [CborItem, CborItem][] = [
      [new CborTextString('key'), new CborUint(1)],
    ];
    const node = new CborMap(entries);
    expect(node.entries).toHaveLength(1);
    expect(node.entries[0][0]).toBeInstanceOf(CborTextString);
    expect(node.entries[0][1]).toBeInstanceOf(CborUint);
  });

  test('indefiniteLength defaults to false', () => {
    expect(new CborMap([]).indefiniteLength).toBe(false);
  });

  test('indefiniteLength can be set to true', () => {
    expect(new CborMap([], { indefiniteLength: true }).indefiniteLength).toBe(
      true
    );
  });

  test('accepts non-string keys', () => {
    const entries: [CborItem, CborItem][] = [
      [new CborUint(1), new CborTextString('one')],
    ];
    expect(new CborMap(entries).entries[0][0]).toBeInstanceOf(CborUint);
  });

  test('accepts empty map', () => {
    expect(new CborMap([]).entries).toHaveLength(0);
  });

  test('is instanceof CborItem', () => {
    expect(new CborMap([])).toBeInstanceOf(CborItem);
  });
});

// ─── CborTag ──────────────────────────────────────────────────────────────────

describe('CborTag', () => {
  test('stores tag as bigint from number', () => {
    const node = new CborTag(1, new CborTextString(''));
    expect(node.tag).toBe(1n);
  });

  test('stores tag as bigint from bigint', () => {
    const node = new CborTag(1n, new CborTextString(''));
    expect(node.tag).toBe(1n);
  });

  test('stores content', () => {
    const content = new CborTextString('2013-03-21T20:04:00Z');
    const node = new CborTag(1n, content);
    expect(node.content).toBe(content);
  });

  test('accepts tag 0', () => {
    expect(new CborTag(0, new CborUint(0)).tag).toBe(0n);
  });

  test('accepts large tag numbers', () => {
    const large = 0xffff_ffff_ffff_ffffn;
    expect(new CborTag(large, new CborUint(0)).tag).toBe(large);
  });

  test('rejects negative tag numbers', () => {
    expect(() => new CborTag(-1, new CborUint(0))).toThrow(RangeError);
    expect(() => new CborTag(-1n, new CborUint(0))).toThrow(RangeError);
  });

  test('is instanceof CborItem', () => {
    expect(new CborTag(0, new CborUint(0))).toBeInstanceOf(CborItem);
  });

  test('toJS preserves tag annotations by default', () => {
    const value = new CborTag(42n, new CborTextString('hello')).toJS();

    expect(Tag.get(value)).toBe(42n);
    expect(Tag.getValue(value)).toBe('hello');
  });

  test('toJS stripTags returns plain content value', () => {
    const value = new CborTag(42n, new CborTextString('hello')).toJS({
      stripTags: true,
    });

    expect(value).toBe('hello');
    expect(Tag.get(value)).toBeUndefined();
  });

  test('toJS stripTags applies to nested tags', () => {
    const value = new CborTag(
      1n,
      new CborTag(2n, new CborTextString('hello'))
    ).toJS({ stripTags: true });

    expect(value).toBe('hello');
    expect(Tag.get(value)).toBeUndefined();
  });
});

// ─── CborFloat ────────────────────────────────────────────────────────────────

describe('CborFloat', () => {
  test('stores value', () => {
    expect(new CborFloat(1.5).value).toBe(1.5);
  });

  test('precision is undefined by default (encoder auto-selects)', () => {
    expect(new CborFloat(1.5).precision).toBeUndefined();
  });

  test('precision can be set to half', () => {
    expect(new CborFloat(1.5, { precision: 'half' }).precision).toBe('half');
  });

  test('precision can be set to single', () => {
    expect(new CborFloat(1.5, { precision: 'single' }).precision).toBe(
      'single'
    );
  });

  test('precision can be set to double', () => {
    expect(new CborFloat(1.5, { precision: 'double' }).precision).toBe(
      'double'
    );
  });

  test('stores NaN', () => {
    expect(new CborFloat(NaN).value).toBeNaN();
  });

  test('stores +Infinity', () => {
    expect(new CborFloat(Infinity).value).toBe(Infinity);
  });

  test('stores -Infinity', () => {
    expect(new CborFloat(-Infinity).value).toBe(-Infinity);
  });

  test('stores -0', () => {
    expect(Object.is(new CborFloat(-0).value, -0)).toBe(true);
  });

  test('is instanceof CborItem', () => {
    expect(new CborFloat(0)).toBeInstanceOf(CborItem);
  });
});

// ─── CborSimple ───────────────────────────────────────────────────────────────

describe('CborSimple', () => {
  test('stores value', () => {
    expect(new CborSimple(0).value).toBe(0);
  });

  test('static FALSE has value 20', () => {
    expect(CborSimple.FALSE.value).toBe(20);
  });

  test('static TRUE has value 21', () => {
    expect(CborSimple.TRUE.value).toBe(21);
  });

  test('static NULL has value 22', () => {
    expect(CborSimple.NULL.value).toBe(22);
  });

  test('static UNDEFINED has value 23', () => {
    expect(CborSimple.UNDEFINED.value).toBe(23);
  });

  test('static constants are instances of CborSimple', () => {
    expect(CborSimple.TRUE).toBeInstanceOf(CborSimple);
    expect(CborSimple.FALSE).toBeInstanceOf(CborSimple);
    expect(CborSimple.NULL).toBeInstanceOf(CborSimple);
    expect(CborSimple.UNDEFINED).toBeInstanceOf(CborSimple);
  });

  test('accepts 0', () => {
    expect(new CborSimple(0).value).toBe(0);
  });

  test('accepts 255', () => {
    expect(new CborSimple(255).value).toBe(255);
  });

  test('rejects negative values', () => {
    expect(() => new CborSimple(-1)).toThrow(RangeError);
  });

  test('rejects values above 255', () => {
    expect(() => new CborSimple(256)).toThrow(RangeError);
  });

  test('rejects non-integer', () => {
    expect(() => new CborSimple(1.5)).toThrow(RangeError);
  });

  test('is instanceof CborItem', () => {
    expect(new CborSimple(0)).toBeInstanceOf(CborItem);
  });
});

// ─── instanceof CborItem (全サブクラス) ──────────────────────────────────────

describe('instanceof CborItem', () => {
  const nodes = [
    new CborUint(0),
    new CborNint(-1),
    new CborByteString(new Uint8Array()),
    new CborIndefiniteByteString([]),
    new CborTextString(''),
    new CborIndefiniteTextString([]),
    new CborArray([]),
    new CborMap([]),
    new CborTag(0, new CborUint(0)),
    new CborFloat(0),
    new CborSimple(0),
  ];

  for (const node of nodes) {
    test(`${node.constructor.name} is instanceof CborItem`, () => {
      expect(node).toBeInstanceOf(CborItem);
    });
  }
});

// ─── CborMap.toJS() — mapAs option ───────────────────────────────────────────

describe('CborMap.toJS() — mapAs', () => {
  // {1: "to", 1: "fro"}  — duplicate key
  const dupMap = () =>
    new CborMap([
      [new CborUint(1n), new CborTextString('to')],
      [new CborUint(1n), new CborTextString('fro')],
    ]);
  // {"a": 1, "b": 2}  — text keys
  const textMap = () =>
    new CborMap([
      [new CborTextString('a'), new CborUint(1n)],
      [new CborTextString('b'), new CborUint(2n)],
    ]);
  // {1: "x", "y": 2}  — mixed keys
  const mixedMap = () =>
    new CborMap([
      [new CborUint(1n), new CborTextString('x')],
      [new CborTextString('y'), new CborUint(2n)],
    ]);

  // ── default ('auto') ────────────────────────────────────────────────────

  // CborUint.toJS() returns Number (not BigInt), CborTextString.toJS() returns string

  test('auto: text-only keys → plain object', () => {
    expect(textMap().toJS()).toEqual({ a: 1, b: 2 });
  });
  test('auto: mixed keys → MapEntries', () => {
    expect(textMap().toJS()).not.toBeInstanceOf(MapEntries);
    expect(mixedMap().toJS()).toBeInstanceOf(MapEntries);
  });
  test('auto: duplicate key → both entries preserved', () => {
    const result = dupMap().toJS() as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    expect(result).toEqual([
      [1, 'to'],
      [1, 'fro'],
    ]);
  });

  // ── mapAs: 'entries' ────────────────────────────────────────────────────

  test("mapAs:'entries': returns MapEntries instance", () => {
    const result = textMap().toJS({ mapAs: 'entries' });
    expect(result).toBeInstanceOf(MapEntries);
    expect(Array.isArray(result)).toBe(true); // MapEntries extends Array
    expect(result).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });
  test("mapAs:'entries': preserves duplicate keys", () => {
    const result = dupMap().toJS({ mapAs: 'entries' }) as unknown[][];
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([1, 'to']);
    expect(result[1]).toEqual([1, 'fro']);
  });
  test("mapAs:'entries': mixed keys preserved as-is", () => {
    const result = mixedMap().toJS({ mapAs: 'entries' }) as unknown[][];
    expect(result[0]).toEqual([1, 'x']);
    expect(result[1]).toEqual(['y', 2]);
  });

  // ── mapAs: 'object' ─────────────────────────────────────────────────────

  test("mapAs:'object': text-only keys → plain object (same as auto)", () => {
    expect(textMap().toJS({ mapAs: 'object' })).toEqual({ a: 1, b: 2 });
  });
  test("mapAs:'object': numeric keys → string keys via String()", () => {
    const result = mixedMap().toJS({ mapAs: 'object' }) as Record<
      string,
      unknown
    >;
    expect(result['1']).toBe('x');
    expect(result['y']).toBe(2);
  });
  test("mapAs:'object': duplicate key → last value wins", () => {
    const result = dupMap().toJS({ mapAs: 'object' }) as Record<
      string,
      unknown
    >;
    expect(result['1']).toBe('fro');
    expect(Object.keys(result)).toHaveLength(1);
  });

  // ── propagation through nested structures ───────────────────────────────

  test("mapAs:'entries' propagates into nested array", () => {
    const inner = new CborMap([[new CborTextString('k'), new CborUint(1n)]]);
    const arr = new CborArray([inner]);
    const result = arr.toJS({ mapAs: 'entries' }) as unknown[][];
    expect(result[0]).toEqual([['k', 1]]);
  });
});
