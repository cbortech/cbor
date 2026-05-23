/**
 * Tests for reviver (ToJSOptions.reviver / CBOR.parse 2nd-arg) and
 * replacer (FromJSOptions.replacer / CBOR.stringify 2nd-arg).
 *
 * Both options are honoured at every entry point:
 *   - CborItem.toJS({ reviver })
 *   - CBOR.parse(text, reviver)  /  CBOR.parse(text, { reviver })
 *   - CBOR.decode(bytes, { reviver })
 *   - fromJS(value, { replacer })
 *   - CBOR.stringify(value, replacer)  /  CBOR.stringify(value, { replacer })
 *   - CBOR.encode(value, { replacer })
 */

import { describe, test, expect, vi } from 'vitest';
import { CBOR } from './cbor';
import { fromJS } from './js/fromJS';
import { MapEntries } from './mapEntries';

// ─── reviver — entry points ───────────────────────────────────────────────────

describe('reviver — entry points', () => {
  const doubleNumbers = (_key: unknown, val: unknown) =>
    typeof val === 'number' ? val * 2 : val;

  test('CBOR.parse(text, reviver) — positional arg', () => {
    expect(CBOR.parse('{"a":1,"b":2}', doubleNumbers)).toEqual({ a: 2, b: 4 });
  });

  test('CBOR.parse(text, { reviver }) — options form', () => {
    expect(CBOR.parse('{"a":1}', { reviver: doubleNumbers })).toEqual({ a: 2 });
  });

  test('CborItem.toJS({ reviver }) — direct call', () => {
    expect(CBOR.fromCDN('{"a":1}').toJS({ reviver: doubleNumbers })).toEqual({
      a: 2,
    });
  });

  test('CBOR.decode(bytes, { reviver })', () => {
    const bytes = CBOR.encode({ a: 1, b: 3 });
    expect(CBOR.decode(bytes, { reviver: doubleNumbers })).toEqual({
      a: 2,
      b: 6,
    });
  });

  test('fromCBOR().toJS({ reviver })', () => {
    const bytes = CBOR.encode([10, 20]);
    expect(CBOR.fromCBOR(bytes).toJS({ reviver: doubleNumbers })).toEqual([
      20, 40,
    ]);
  });
});

// ─── reviver — walk semantics ─────────────────────────────────────────────────

describe('reviver — walk semantics', () => {
  test('bottom-up order: leaves before parent, root last', () => {
    const keys: unknown[] = [];
    CBOR.parse('{"a":[1,2]}', (key, val) => {
      keys.push(key);
      return val;
    });
    expect(keys).toEqual(['0', '1', 'a', '']);
  });

  test('root is called with key "" and full result', () => {
    let rootKey: unknown;
    let rootVal: unknown;
    const result = CBOR.parse('"hello"', function (key, val) {
      rootKey = key;
      rootVal = val;
      return val;
    });
    expect(rootKey).toBe('');
    expect(rootVal).toBe('hello');
    expect(result).toBe('hello');
  });

  test('this inside reviver is the parent holder', () => {
    const holders: object[] = [];
    CBOR.parse('{"x":1}', function (key, val) {
      if (key === 'x') holders.push(this as object);
      return val;
    });
    expect(holders[0]).toEqual({ x: 1 });
  });

  test('reviver can transform nested values', () => {
    const result = CBOR.parse('{"a":{"b":3}}', (_key, val) =>
      typeof val === 'number' ? val + 10 : val
    );
    expect(result).toEqual({ a: { b: 13 } });
  });

  test('reviver can replace container with scalar', () => {
    const result = CBOR.parse('[1,2,3]', (_key, val) =>
      Array.isArray(val) ? val.length : val
    );
    expect(result).toBe(3);
  });

  test('reviver returning undefined removes object key (undefinedOmits: true)', () => {
    const result = CBOR.parse('{"a":1,"b":2,"c":3}', {
      undefinedOmits: true,
      reviver: (key, val) => (key === 'b' ? undefined : val),
    }) as Record<string, unknown>;
    expect(result).toEqual({ a: 1, c: 3 });
    expect(Object.keys(result)).not.toContain('b');
  });

  test('reviver returning undefined removes array element (undefinedOmits: true)', () => {
    const result = CBOR.parse('[10,20,30]', {
      undefinedOmits: true,
      reviver: (key, val) => (key === '1' ? undefined : val),
    });
    // CBOR reviver omits the element; result is a compact array without holes.
    expect(result).toEqual([10, 30]);
    expect((result as unknown[]).length).toBe(2);
  });

  test('reviver works on deeply nested arrays', () => {
    const result = CBOR.parse('[[1,2],[3,4]]', (_key, val) =>
      typeof val === 'number' ? val * 10 : val
    );
    expect(result).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  test('reviver combined with integerAs option', () => {
    const result = CBOR.parse('{"n":42}', {
      integerAs: 'bigint',
      reviver: (_key, val) => (typeof val === 'bigint' ? Number(val) + 1 : val),
    });
    expect(result).toEqual({ n: 43 });
  });
});

// ─── reviver — non-string keys (CBOR maps) ───────────────────────────────────

describe('reviver — non-string keys', () => {
  test('reviver receives integer keys from CBOR map with int keys', () => {
    const seen: [unknown, unknown][] = [];
    CBOR.parse('{1:"a",2:"b"}', (key, val) => {
      seen.push([key, val]);
      return val;
    });
    // keys 1 and 2 (numbers) from the map entries, then '' for root
    expect(seen.some(([k]) => k === 1)).toBe(true);
    expect(seen.some(([k]) => k === 2)).toBe(true);
    expect(seen.at(-1)![0]).toBe('');
  });

  test('reviver returning undefined removes MapEntries entry (undefinedOmits: true)', () => {
    const result = CBOR.parse('{1:"keep",2:"drop"}', {
      undefinedOmits: true,
      reviver: (key, val) => (key === 2 ? undefined : val),
    }) as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual([1, 'keep']);
  });

  test('reviver works on MapEntries produced by mapAs:entries', () => {
    const result = CBOR.parse('{"a":1,"b":2}', {
      mapAs: 'entries',
      reviver: (_key, val) => (typeof val === 'number' ? val * 3 : val),
    }) as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    const obj = Object.fromEntries(result as [string, unknown][]);
    expect(obj).toEqual({ a: 3, b: 6 });
  });
});

// ─── replacer — entry points ──────────────────────────────────────────────────

describe('replacer — entry points', () => {
  test('CBOR.stringify(value, fnReplacer) — positional arg', () => {
    const result = CBOR.stringify({ a: 1, b: 2 }, (_key, val) =>
      typeof val === 'number' ? val * 2 : val
    );
    expect(result).toBe('{"a":2,"b":4}');
  });

  test('CBOR.stringify(value, arrayReplacer) — positional arg', () => {
    expect(CBOR.stringify({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toBe(
      '{"a":1,"c":3}'
    );
  });

  test('CBOR.stringify(value, { replacer }) — options form', () => {
    expect(CBOR.stringify({ a: 1, b: 2 }, { replacer: ['a'] })).toBe('{"a":1}');
  });

  test('fromJS(value, { replacer }) — direct call', () => {
    const ast = fromJS({ a: 1, b: 2, c: 3 }, { replacer: ['a', 'c'] });
    expect(ast.toJS()).toEqual({ a: 1, c: 3 });
  });

  test('CBOR.encode(value, { replacer }) — binary round-trip', () => {
    const bytes = CBOR.encode({ a: 1, b: 2 }, { replacer: ['a'] });
    expect(CBOR.decode(bytes)).toEqual({ a: 1 });
  });

  test('CBOR.stringify(value, null, space) — null replacer with indent', () => {
    const result = CBOR.stringify({ a: 1 }, null, 2);
    expect(result).toMatch(/\n/);
    expect(result).toMatch(/"a"/);
  });
});

// ─── replacer — function replacer semantics ───────────────────────────────────

describe('replacer — function replacer semantics', () => {
  test('function replacer returning undefined omits key (undefinedOmits: true)', () => {
    const result = CBOR.stringify(
      { a: 1, b: 2 },
      {
        undefinedOmits: true,
        replacer: (key, val) => (key === 'b' ? undefined : val),
      }
    );
    expect(result).toBe('{"a":1}');
  });

  test('function replacer returning undefined from array element becomes null (undefinedOmits: true)', () => {
    const result = CBOR.stringify([1, 2, 3], {
      undefinedOmits: true,
      replacer: (key, val) => (key === '1' ? undefined : val),
    });
    // JSON.stringify behaviour: undefined in array → null
    expect(result).toBe('[1,null,3]');
  });

  test('function replacer transforms nested values', () => {
    const result = CBOR.stringify({ a: { b: 5 } }, (_key, val) =>
      typeof val === 'number' ? val + 100 : val
    );
    expect(result).toBe('{"a":{"b":105}}');
  });

  test('function replacer respects toJSON before invocation', () => {
    const obj = {
      a: {
        toJSON() {
          return 99;
        },
      },
    };
    const result = CBOR.stringify(obj, (_key, val) => val);
    expect(result).toBe('{"a":99}');
  });

  test('root value is passed to replacer with key ""', () => {
    const keys: unknown[] = [];
    CBOR.stringify({ x: 1 }, (key, val) => {
      keys.push(key);
      return val;
    });
    expect(keys).toContain('');
  });

  test('this inside function replacer is the parent holder', () => {
    const holders: object[] = [];
    CBOR.stringify({ x: 42 }, function (key, val) {
      if (key === 'x') holders.push(this as object);
      return val;
    });
    expect(holders[0]).toHaveProperty('x', 42);
  });

  test('function replacer combined with indent option', () => {
    const result = CBOR.stringify(
      { a: 1, b: 2 },
      { replacer: (_k, v) => v, indent: 2 }
    );
    expect(result).toMatch(/\n/);
    expect(CBOR.parse(result)).toEqual({ a: 1, b: 2 });
  });
});

// ─── replacer — array replacer semantics ─────────────────────────────────────

describe('replacer — array replacer semantics', () => {
  test('empty array replacer produces empty object', () => {
    expect(CBOR.stringify({ a: 1, b: 2 }, [])).toBe('{}');
  });

  test('array replacer filters keys at every nesting level', () => {
    const result = CBOR.stringify({ a: { x: 1, y: 2 }, b: 3 }, ['a', 'x']);
    expect(result).toBe('{"a":{"x":1}}');
  });

  test('array replacer does not filter array elements', () => {
    expect(CBOR.stringify([1, 2, 3], ['0'])).toBe('[1,2,3]');
  });

  test('array replacer with number entries (converted to string)', () => {
    expect(CBOR.stringify({ 0: 'zero', 1: 'one', 2: 'two' }, [0, 2])).toBe(
      '{"0":"zero","2":"two"}'
    );
  });
});

// ─── replacer — MapEntries ────────────────────────────────────────────────────

describe('replacer — MapEntries', () => {
  test('function replacer transforms values in MapEntries', () => {
    const entries = new MapEntries();
    entries.push([1, 10]);
    entries.push([2, 20]);
    const bytes = CBOR.encode(entries, {
      replacer: (_key, val) =>
        typeof val === 'number' && (_key as number) > 0 ? val * 2 : val,
    });
    const result = CBOR.decode(bytes, { mapAs: 'entries' }) as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    // values doubled (keys 1 and 2 are > 0 so val*2 for values 10 and 20)
    const map = new Map(result as [unknown, unknown][]);
    expect(map.get(1)).toBe(20);
    expect(map.get(2)).toBe(40);
  });

  test('function replacer returning undefined removes MapEntries entry', () => {
    const entries = new MapEntries();
    entries.push([1, 'keep']);
    entries.push([2, 'drop']);
    const ast = fromJS(entries, {
      undefinedOmits: true,
      replacer: (key, val) => (key === 2 ? undefined : val),
    });
    const result = ast.toJS({ mapAs: 'entries' }) as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual([1, 'keep']);
  });

  test('array replacer keeps all MapEntries entries but filters nested objects', () => {
    const entries = new MapEntries();
    entries.push([1, { a: 1, b: 2 }]);
    const ast = fromJS(entries, { replacer: ['a'] });
    // Default toJS: outer map has int key → MapEntries; inner map has string
    // keys → plain object (mapAs:'auto').
    const result = ast.toJS() as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    expect(result.length).toBe(1);
    expect(result[0][0]).toBe(1);
    // nested object is filtered to allowlist keys only
    expect(result[0][1]).toEqual({ a: 1 });
  });
});

// ─── reviver + replacer combined ─────────────────────────────────────────────

describe('reviver + replacer combined round-trip', () => {
  test('replacer on encode, reviver on decode', () => {
    const original = { secret: 'hidden', name: 'Alice', age: 30 };
    // encode: keep only name and age
    const bytes = CBOR.encode(original, { replacer: ['name', 'age'] });
    // decode: uppercase string values
    const result = CBOR.decode(bytes, {
      reviver: (_key, val) =>
        typeof val === 'string' ? val.toUpperCase() : val,
    });
    expect(result).toEqual({ name: 'ALICE', age: 30 });
  });

  test('CBOR.stringify with replacer and CBOR.parse with reviver', () => {
    const original = { a: 1, b: 2, c: 3 };
    const edn = CBOR.stringify(original, ['a', 'c']);
    const result = CBOR.parse(edn, (_key, val) =>
      typeof val === 'number' ? val * 10 : val
    );
    expect(result).toEqual({ a: 10, c: 30 });
  });
});

// ─── vi.fn() spy — call counts ────────────────────────────────────────────────

describe('reviver / replacer call counts', () => {
  test('reviver called once per value (leaf + container + root)', () => {
    const spy = vi.fn((_key: unknown, val: unknown) => val);
    CBOR.parse('{"a":1,"b":2}', spy);
    // "a"=1, "b"=2 (2 leaves), map itself (key ""), root = 3 calls total
    expect(spy).toHaveBeenCalledTimes(3);
  });

  test('replacer called once per value (root + keys)', () => {
    const spy = vi.fn((_key: unknown, val: unknown) => val);
    CBOR.stringify({ a: 1 }, spy);
    // root ("" → {a:1}), then "a" → 1
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ─── undefinedOmits: false (default) — undefined preserved ───────────────────

describe('undefinedOmits: false (default) — undefined preserved', () => {
  test('reviver returning undefined keeps the key (default)', () => {
    const bytes = CBOR.encode({ a: 1, b: undefined });
    const result = CBOR.decode(bytes, {
      reviver: (_key, val) => val,
    }) as Record<string, unknown>;
    expect(Object.keys(result)).toContain('b');
    expect(result['b']).toBeUndefined();
  });

  test('reviver returning undefined keeps array element (default)', () => {
    const bytes = CBOR.encode([1, undefined, 3]);
    const result = CBOR.decode(bytes, {
      reviver: (_key, val) => val,
    }) as unknown[];
    expect(result.length).toBe(3);
    expect(result[1]).toBeUndefined();
  });

  test('replacer returning undefined preserves value as CBOR undefined (default)', () => {
    const result = CBOR.stringify(
      { a: undefined },
      {
        replacer: (_key, val) => val,
      }
    );
    // undefined value → CBOR simple(23) → EDN "undefined"
    expect(result).toContain('undefined');
  });

  test('replacer returning undefined keeps object key (default)', () => {
    const ast = fromJS(
      { a: 1, b: undefined },
      {
        replacer: (_key, val) => val,
      }
    );
    const obj = ast.toJS() as Record<string, unknown>;
    expect(Object.keys(obj)).toContain('b');
    expect(obj['b']).toBeUndefined();
  });
});

// ─── CBOR.OMIT sentinel ───────────────────────────────────────────────────────

describe('CBOR.OMIT sentinel — reviver', () => {
  test('reviver returning CBOR.OMIT removes object key', () => {
    const result = CBOR.parse('{"a":1,"b":2}', (key, val) =>
      key === 'b' ? CBOR.OMIT : val
    ) as Record<string, unknown>;
    expect(Object.keys(result)).not.toContain('b');
    expect(result['a']).toBe(1);
  });

  test('reviver returning CBOR.OMIT removes array element (compact)', () => {
    const result = CBOR.parse('[10,20,30]', (key, val) =>
      key === '1' ? CBOR.OMIT : val
    ) as unknown[];
    expect(result).toEqual([10, 30]);
    expect(result.length).toBe(2);
  });

  test('reviver returning CBOR.OMIT removes MapEntries entry', () => {
    const result = CBOR.parse('{1:"keep",2:"drop"}', (key, val) =>
      key === 2 ? CBOR.OMIT : val
    ) as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual([1, 'keep']);
  });

  test('root reviver returning CBOR.OMIT yields undefined', () => {
    const result = CBOR.parse('"hello"', (_key, _val) => CBOR.OMIT);
    expect(result).toBeUndefined();
  });
});

describe('CBOR.OMIT sentinel — replacer', () => {
  test('replacer returning CBOR.OMIT omits object key', () => {
    const result = CBOR.stringify({ a: 1, b: 2 }, (key, val) =>
      key === 'b' ? CBOR.OMIT : val
    );
    expect(result).toBe('{"a":1}');
  });

  test('replacer returning CBOR.OMIT in array position → null (JSON compat)', () => {
    const result = CBOR.stringify([1, 2, 3], (key, val) =>
      key === '1' ? CBOR.OMIT : val
    );
    expect(result).toBe('[1,null,3]');
  });

  test('replacer returning CBOR.OMIT removes MapEntries entry', () => {
    const entries = new MapEntries();
    entries.push([1, 'keep']);
    entries.push([2, 'drop']);
    const ast = fromJS(entries, {
      replacer: (key, val) => (key === 2 ? CBOR.OMIT : val),
    });
    const result = ast.toJS({ mapAs: 'entries' }) as MapEntries;
    expect(result).toBeInstanceOf(MapEntries);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual([1, 'keep']);
  });

  test('root replacer returning CBOR.OMIT → stringify returns undefined', () => {
    const result = CBOR.stringify({ a: 1 }, (_key, _val) => CBOR.OMIT);
    expect(result).toBeUndefined();
  });

  test('root replacer returning CBOR.OMIT → encode does not throw', () => {
    const bytes = CBOR.encode(
      { a: 1 },
      { replacer: (_key, _val) => CBOR.OMIT }
    );
    // Root dropped → encoded as CBOR undefined (simple 23 = 0xF7)
    expect(bytes).toEqual(new Uint8Array([0xf7]));
  });

  test('root replacer returning CBOR.OMIT → fromJS does not throw', () => {
    const ast = fromJS({ a: 1 }, { replacer: (_key, _val) => CBOR.OMIT });
    expect(ast.toJS()).toBeUndefined();
  });
});
