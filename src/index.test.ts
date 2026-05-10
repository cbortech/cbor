/**
 * Phase 9 — Comprehensive integration tests.
 *
 * Tests three-way round-trips across all supported formats:
 *   CBOR binary → AST → CBOR binary           (byte-exact)
 *   CBOR binary → AST → EDN → AST → CBOR      (byte-exact)
 *   CBOR binary → AST → JS  → ...             (value-equivalent, where lossless)
 *   JS  → AST → CBOR → AST → JS              (value-equivalent)
 *
 * These tests also serve as browser-compatibility smoke tests — no Node.js-
 * specific APIs are used anywhere in the library (Uint8Array + TextEncoder/
 * TextDecoder only; no Buffer, no node:* modules).
 *
 * Run with:
 *   npm run test:node     — Node.js (default)
 *   npm run test:browser  — Chromium via Playwright
 */

import { describe, test, expect } from 'vitest';
import { CBOR } from './cbor';
import { decodeCBOR } from './cbor/decoder';
import { parseEDN } from './edn/parser';
import { toEDN } from './edn/serializer';
import { fromJS } from './js/fromJS';
import { CborUint } from './ast/CborUint';
import { CborNint } from './ast/CborNint';
import { CborTextString } from './ast/CborTextString';
import { CborByteString } from './ast/CborByteString';
import { CborArray } from './ast/CborArray';
import { CborMap } from './ast/CborMap';
import { MapEntries } from './mapEntries';
import { Simple } from './simple';
import { CborTag } from './ast/CborTag';
import { CborFloat } from './ast/CborFloat';
import { CborSimple } from './ast/CborSimple';
import { CborIndefiniteByteString } from './ast/CborIndefiniteByteString';
import { CborIndefiniteTextString } from './ast/CborIndefiniteTextString';

// ─── Hex utilities ────────────────────────────────────────────────────────────

function hex(s: string): Uint8Array {
  s = s.replace(/\s+/g, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2)
    out[i / 2] = parseInt(s.slice(i, i + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── RFC 8949 Appendix A — all test vectors ───────────────────────────────────
//
// Each entry: [hex, description]
// All 70 vectors from Appendix A plus the indefinite-length examples.

const APPENDIX_A: [string, string][] = [
  // unsigned integers
  ['00', 'uint 0'],
  ['01', 'uint 1'],
  ['0a', 'uint 10'],
  ['17', 'uint 23'],
  ['1818', 'uint 24'],
  ['1819', 'uint 25'],
  ['1864', 'uint 100'],
  ['1903e8', 'uint 1000'],
  ['1a000f4240', 'uint 1000000'],
  ['1b000000e8d4a51000', 'uint 1000000000000'],
  ['1bffffffffffffffff', 'uint 18446744073709551615'],
  // negative integers
  ['20', 'nint -1'],
  ['29', 'nint -10'],
  ['3863', 'nint -100'],
  ['3903e7', 'nint -1000'],
  // floating-point
  ['f90000', 'float 0.0 (half)'],
  ['f98000', 'float -0.0 (half)'],
  ['f93c00', 'float 1.0 (half)'],
  ['fb3ff199999999999a', 'float 1.1 (double)'],
  ['f93e00', 'float 1.5 (half)'],
  ['fbc010666666666666', 'float -4.1 (double)'],
  ['f97c00', 'float Infinity (half)'],
  ['f97e00', 'float NaN (half)'],
  ['f9fc00', 'float -Infinity (half)'],
  ['fa47c35000', 'float 100000.0 (single)'],
  ['fa7f7fffff', 'float 3.4028234663852886e+38 (single)'],
  ['fb7e37e43c8800759c', 'float 1.0e+300 (double)'],
  ['f90001', 'float 5.960464477539063e-8 (half, subnormal)'],
  ['f90400', 'float 6.103515625e-5 (half, min normal)'],
  ['f9c400', 'float -4.0 (half)'],
  // byte strings
  ['40', 'bytes empty'],
  ['4401020304', 'bytes [01,02,03,04]'],
  // text strings
  ['60', 'text ""'],
  ['6161', 'text "a"'],
  ['6449455446', 'text "IETF"'],
  ['62225c', 'text "\\"\\\\"'],
  ['62c3bc', 'text "\\u00fc"'],
  ['63e6b0b4', 'text "\\u6c34"'],
  ['64f0908591', 'text "\\ud800\\udd51" (surrogate pair)'],
  // arrays
  ['80', 'array []'],
  ['83010203', 'array [1,2,3]'],
  ['8301820203820405', 'array [1,[2,3],[4,5]]'],
  [
    '98190102030405060708090a0b0c0d0e0f101112131415161718181819',
    'array [1..25]',
  ],
  // maps
  ['a0', 'map {}'],
  ['a201020304', 'map {1:2,3:4}'],
  ['a26161016162820203', 'map {"a":1,"b":[2,3]}'],
  // tags
  [
    'c074323031332d30332d32315432303a30343a30305a',
    'tag 0("2013-03-21T20:04:00Z")',
  ],
  ['c11a514b67b0', 'tag 1(1363896240)'],
  ['d74401020304', 'tag 23(h"01020304")'],
  ['d818456449455446', 'tag 24(h"6449455446")'],
  [
    'd82076687474703a2f2f7777772e6578616d706c652e636f6d',
    'tag 32("http://www.example.com")',
  ],
  // simple values
  ['f4', 'false'],
  ['f5', 'true'],
  ['f6', 'null'],
  ['f7', 'undefined'],
  ['f0', 'simple(16)'],
  ['f8ff', 'simple(255)'],
  // indefinite-length
  ['5f42010243030405ff', 'indefinite bytes (_ h"0102", h"030405")'],
  ['7f657374726561646d696e67ff', 'indefinite text (_ "strea", "ming")'],
  ['9fff', 'indefinite array [_ ]'],
  ['9f018202039f0405ffff', 'indefinite array [_ 1,[2,3],[_ 4,5]]'],
  ['9f01820203820405ff', 'indefinite array [_ 1,[2,3],[4,5]]'],
  ['83018202039f0405ff', 'array [1,[2,3],[_ 4,5]]'],
  ['83019f0203ff820405', 'array [1,[_ 2,3],[4,5]]'],
  [
    '9f0102030405060708090a0b0c0d0e0f101112131415161718181819ff',
    'indefinite array [_ 1..25]',
  ],
  ['bf61610161629f0203ffff', 'indefinite map {_ "a":1,"b":[_ 2,3]}'],
  ['826161bf61626163ff', 'array ["a",{_ "b":"c"}]'],
  ['bf6346756ef563416d7421ff', 'indefinite map {_ "Fun":true,"Amt":-2}'],
];

// ─── 1. CBOR → AST → CBOR  (byte-exact, all Appendix A vectors) ──────────────

describe('RFC 8949 Appendix A — CBOR→AST→CBOR byte-exact round-trip', () => {
  for (const [h, desc] of APPENDIX_A) {
    test(desc, () => {
      const original = hex(h);
      expect(toHex(decodeCBOR(original).toCBOR())).toBe(h);
    });
  }
});

// ─── 2. CBOR → AST → EDN → AST → CBOR  (byte-exact, all Appendix A) ─────────

describe('RFC 8949 Appendix A — CBOR→EDN→CBOR byte-exact round-trip', () => {
  for (const [h, desc] of APPENDIX_A) {
    test(desc, () => {
      const original = hex(h);
      const ast = decodeCBOR(original);
      const edn = toEDN(ast);
      const reparsed = parseEDN(edn);
      expect(toHex(reparsed.toCBOR())).toBe(h);
    });
  }
});

// ─── 3. JS → AST → CBOR → AST → JS  (value-equivalent) ─────────────────────

describe('JS→CBOR→JS value-equivalent round-trip', () => {
  const cases: [unknown, string][] = [
    [null, 'null'],
    [undefined, 'undefined'],
    [true, 'true'],
    [false, 'false'],
    [0, '0'],
    [1, '1'],
    [23, '23 (1-byte boundary)'],
    [24, '24 (2-byte boundary)'],
    [255, '255'],
    [256, '256'],
    [65535, '65535'],
    [65536, '65536'],
    [-1, '-1'],
    [-100, '-100'],
    [-1000, '-1000'],
    [1.5, '1.5'],
    [1.1, '1.1'],
    [100000.0, '100000.0'],
    ['', 'empty string'],
    ['a', '"a"'],
    ['IETF', '"IETF"'],
    ['ü', '"ü" (UTF-8 2-byte)'],
    ['水', '"水" (UTF-8 3-byte)'],
    [[], '[]'],
    [[1, 2, 3], '[1,2,3]'],
    [[1, [2, 3], [4, 5]], '[1,[2,3],[4,5]]'],
    [{}, '{}'],
    [{ a: 1 }, '{"a":1}'],
    [{ a: 1, b: [2, 3] }, '{"a":1,"b":[2,3]}'],
    [new Uint8Array([]), 'bytes empty'],
    [new Uint8Array([1, 2, 3, 4]), 'bytes [01,02,03,04]'],
  ];

  for (const [value, desc] of cases) {
    test(desc, () => {
      const encoded = CBOR.encode(value);
      const decoded = CBOR.decode(encoded);
      expect(decoded).toEqual(value);
    });
  }

  test('bigint 0n', () => {
    const encoded = fromJS(0n).toCBOR();
    const decoded = decodeCBOR(encoded).toJS();
    expect(decoded).toBe(0); // ≤ MAX_SAFE_INTEGER → number
  });

  test('bigint above MAX_SAFE_INTEGER → stays bigint', () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const encoded = fromJS(big).toCBOR();
    const decoded = decodeCBOR(encoded).toJS();
    expect(decoded).toBe(big);
  });

  test('-0 round-trips as -0.0 (CborFloat)', () => {
    const encoded = CBOR.encode(-0);
    const decoded = CBOR.decode(encoded);
    expect(Object.is(decoded, -0)).toBe(true);
  });

  test('NaN round-trips', () => {
    const encoded = CBOR.encode(NaN);
    const decoded = CBOR.decode(encoded);
    expect(isNaN(decoded as number)).toBe(true);
  });
});

// ─── 4. CBOR.encode → decode byte-exact (via fromJS matching) ────────────────

describe('CBOR.encode produces correct Appendix-A-compatible bytes', () => {
  test('encode(0) = 0x00', () => expect(toHex(CBOR.encode(0))).toBe('00'));
  test('encode(23) = 0x17', () => expect(toHex(CBOR.encode(23))).toBe('17'));
  test('encode(24) = 0x1818', () =>
    expect(toHex(CBOR.encode(24))).toBe('1818'));
  test('encode(100) = 0x1864', () =>
    expect(toHex(CBOR.encode(100))).toBe('1864'));
  test('encode(-1) = 0x20', () => expect(toHex(CBOR.encode(-1))).toBe('20'));
  test('encode(-10) = 0x29', () => expect(toHex(CBOR.encode(-10))).toBe('29'));
  test('encode("") = 0x60', () => expect(toHex(CBOR.encode(''))).toBe('60'));
  test('encode("IETF") = 0x6449455446', () =>
    expect(toHex(CBOR.encode('IETF'))).toBe('6449455446'));
  test('encode([]) = 0x80', () => expect(toHex(CBOR.encode([]))).toBe('80'));
  test('encode({}) = 0xa0', () => expect(toHex(CBOR.encode({}))).toBe('a0'));
  test('encode(null) = 0xf6', () =>
    expect(toHex(CBOR.encode(null))).toBe('f6'));
  test('encode(true) = 0xf5', () =>
    expect(toHex(CBOR.encode(true))).toBe('f5'));
  test('encode(false) = 0xf4', () =>
    expect(toHex(CBOR.encode(false))).toBe('f4'));
});

// ─── 5. CBOR.stringify / CBOR.parse end-to-end ───────────────────────────────

describe('CBOR.stringify ↔ CBOR.parse end-to-end', () => {
  const cases: [unknown, string][] = [
    [42, '42'],
    [-5, '-5'],
    [1.5, '1.5'],
    ['hello', '"hello"'],
    [true, 'true'],
    [false, 'false'],
    [null, 'null'],
    [[1, 2, 3], '[1,2,3]'],
    [{ a: 1 }, '{"a":1}'],
  ];

  for (const [value, expectedEDN] of cases) {
    test(`stringify(${JSON.stringify(value)}) = "${expectedEDN}"`, () => {
      expect(CBOR.stringify(value)).toBe(expectedEDN);
    });
  }

  test('parse(stringify(value)) ≡ value for nested object', () => {
    const value = { x: [1, 2], y: { z: 'hi' } };
    expect(CBOR.parse(CBOR.stringify(value))).toEqual(value);
  });

  test('stringify with indent=2', () => {
    const result = CBOR.stringify([1, 2, 3], { indent: 2 });
    expect(result).toBe('[\n  1,\n  2,\n  3\n]');
    // parse back ignoring whitespace
    expect(CBOR.parse(result)).toEqual([1, 2, 3]);
  });
});

// ─── 6. Complex nested structure: full 4-way round-trip ──────────────────────

describe('Complex nested structures — 4-way round-trip', () => {
  test('RFC 8949 §3.4 "Concise Binary Object Representation" example structure', () => {
    // Build AST directly
    const ast = new CborMap([
      [new CborTextString('a'), new CborUint(1n)],
      [
        new CborTextString('b'),
        new CborArray([new CborUint(2n), new CborUint(3n)]),
      ],
    ]);

    // AST → CBOR → AST (byte-exact)
    const cbor = ast.toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(toHex(decoded.toCBOR())).toBe(toHex(cbor));

    // AST → EDN → AST → CBOR (byte-exact)
    const edn = toEDN(ast);
    const reparsed = parseEDN(edn);
    expect(toHex(reparsed.toCBOR())).toBe(toHex(cbor));

    // AST → JS
    const js = ast.toJS() as Record<string, unknown>;
    expect(js).toEqual({ a: 1, b: [2, 3] });
  });

  test('Deeply nested array [[[1,2],[3,4]],[[5,6]]]', () => {
    const ast = new CborArray([
      new CborArray([
        new CborArray([new CborUint(1n), new CborUint(2n)]),
        new CborArray([new CborUint(3n), new CborUint(4n)]),
      ]),
      new CborArray([new CborArray([new CborUint(5n), new CborUint(6n)])]),
    ]);
    const cbor = ast.toCBOR();
    expect(toHex(parseEDN(toEDN(ast)).toCBOR())).toBe(toHex(cbor));
    expect(decodeCBOR(cbor).toJS()).toEqual([
      [
        [1, 2],
        [3, 4],
      ],
      [[5, 6]],
    ]);
  });

  test('Mixed indefinite-length array and definite map', () => {
    const ast = new CborArray(
      [
        new CborUint(1n),
        new CborArray([new CborUint(2n), new CborUint(3n)]),
        new CborArray([new CborUint(4n), new CborUint(5n)], {
          indefiniteLength: true,
        }),
      ],
      { indefiniteLength: true }
    );

    const cbor = ast.toCBOR();
    expect(toHex(cbor)).toBe('9f01820203' + '9f0405ff' + 'ff');
    expect(toHex(parseEDN(toEDN(ast)).toCBOR())).toBe(toHex(cbor));
  });

  test('Tagged value with nested content', () => {
    const ast = new CborTag(
      1n,
      new CborArray([new CborUint(10n), new CborTextString('hello')])
    );
    const cbor = ast.toCBOR();
    const edn = toEDN(ast);
    expect(edn).toBe('1([10,"hello"])');
    expect(toHex(parseEDN(edn).toCBOR())).toBe(toHex(cbor));
  });

  test('Map with non-string keys (integer keys)', () => {
    const ast = new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);
    const js = ast.toJS();
    expect(js).toBeInstanceOf(MapEntries);
    expect(js).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('Indefinite byte string concatenates correctly in toJS()', () => {
    const ast = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([1, 2])),
      new CborByteString(new Uint8Array([3, 4, 5])),
    ]);
    expect(ast.toJS()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

    // Also round-trips through EDN
    const edn = toEDN(ast);
    expect(edn).toBe("(_ h'0102', h'030405')");
    const reparsed = parseEDN(edn);
    expect(toHex(reparsed.toCBOR())).toBe(toHex(ast.toCBOR()));
  });

  test('Indefinite text string concatenates correctly in toJS()', () => {
    const ast = new CborIndefiniteTextString([
      new CborTextString('Hello'),
      new CborTextString(', '),
      new CborTextString('world!'),
    ]);
    expect(ast.toJS()).toBe('Hello, world!');
  });
});

// ─── 7. CborSimple round-trips ────────────────────────────────────────────────

describe('CborSimple — toJS / fromCBOR / toEDN', () => {
  const simpleVectors: [number, string, unknown, string][] = [
    [20, 'f4', false, 'false'],
    [21, 'f5', true, 'true'],
    [22, 'f6', null, 'null'],
    [23, 'f7', undefined, 'undefined'],
    [16, 'f0', new Simple(16), 'simple(16)'],
    [255, 'f8ff', new Simple(255), 'simple(255)'],
  ];

  for (const [n, h, jsVal, edn] of simpleVectors) {
    test(`simple(${n})`, () => {
      const ast = new CborSimple(n);
      expect(toHex(ast.toCBOR())).toBe(h);
      expect(ast.toJS()).toEqual(jsVal);
      expect(toEDN(ast)).toBe(edn);
      // decode → same EDN
      expect(toEDN(decodeCBOR(hex(h)))).toBe(edn);
    });
  }
});

// ─── 8. Float precision: explicit encoding-indicator suffix ──────────────────

describe('CborFloat encoding-indicator suffix round-trip', () => {
  const floatVectors: [number, string, string, string][] = [
    // [value, hex(half), hex(single), hex(double)]
    [1.0, 'f93c00', 'fa3f800000', 'fb3ff0000000000000'],
    [0.0, 'f90000', 'fa00000000', 'fb0000000000000000'],
  ];

  for (const [value, halfHex, singleHex, doubleHex] of floatVectors) {
    test(`${value} — auto (half)`, () => {
      const ast = new CborFloat(value);
      expect(toHex(ast.toCBOR())).toBe(halfHex);
    });
    test(`${value} — explicit single → ${singleHex}`, () => {
      const ast = new CborFloat(value, { precision: 'single' });
      expect(toHex(ast.toCBOR())).toBe(singleHex);
      // EDN has _2 suffix; round-trips back to single
      const edn = toEDN(ast);
      expect(edn).toContain('_2');
      expect(toHex(parseEDN(edn).toCBOR())).toBe(singleHex);
    });
    test(`${value} — explicit double → ${doubleHex}`, () => {
      const ast = new CborFloat(value, { precision: 'double' });
      expect(toHex(ast.toCBOR())).toBe(doubleHex);
      const edn = toEDN(ast);
      expect(edn).toContain('_3');
      expect(toHex(parseEDN(edn).toCBOR())).toBe(doubleHex);
    });
    test(`${value} — CBOR(single)→EDN→CBOR byte-exact`, () => {
      const bytes = hex(singleHex);
      expect(toHex(parseEDN(toEDN(decodeCBOR(bytes))).toCBOR())).toBe(
        singleHex
      );
    });
    test(`${value} — CBOR(double)→EDN→CBOR byte-exact`, () => {
      const bytes = hex(doubleHex);
      expect(toHex(parseEDN(toEDN(decodeCBOR(bytes))).toCBOR())).toBe(
        doubleHex
      );
    });
  }
});

// ─── 9. Error handling ────────────────────────────────────────────────────────

describe('Error handling', () => {
  test('decodeCBOR: truncated input', () => {
    expect(() => decodeCBOR(hex('1818'))).not.toThrow(); // complete
    expect(() => decodeCBOR(hex('18'))).toThrow(); // truncated after AI=24
  });
  test('decodeCBOR: trailing bytes', () => {
    expect(() => decodeCBOR(hex('0001'))).toThrow(); // extra byte
  });
  test('decodeCBOR: break code at top level', () => {
    expect(() => decodeCBOR(hex('ff'))).toThrow();
  });
  test('parseEDN: empty input', () => {
    expect(() => parseEDN('')).toThrow(SyntaxError);
  });
  test('parseEDN: unclosed array', () => {
    expect(() => parseEDN('[1, 2')).toThrow(SyntaxError);
  });
  test('parseEDN: unknown identifier', () => {
    expect(() => parseEDN('foo')).toThrow(SyntaxError);
  });
  test('fromJS: symbol throws TypeError', () => {
    expect(() => fromJS(Symbol())).toThrow(TypeError);
  });
  test('CborUint: negative value', () => {
    expect(() => new CborUint(-1n)).toThrow(RangeError);
  });
  test('CborNint: zero value', () => {
    expect(() => new CborNint(0n)).toThrow(RangeError);
  });
  test('CborSimple: out-of-range value', () => {
    expect(() => new CborSimple(256)).toThrow(RangeError);
    expect(() => new CborSimple(-1)).toThrow(RangeError);
  });
  test('CborTag: negative tag number', () => {
    expect(() => new CborTag(-1n, CborSimple.NULL)).toThrow(RangeError);
  });
});

// ─── 10. SPEC.md usage examples ──────────────────────────────────────────────

describe('SPEC.md usage examples', () => {
  test('CBOR binary → AST → CBOR binary', () => {
    const bytes = hex('83010203'); // [1, 2, 3]
    const ast = CBOR.fromCBOR(bytes);
    const reencoded = ast.toCBOR();
    expect(toHex(reencoded)).toBe('83010203');
  });

  test('CBOR binary → AST → EDN text', () => {
    const bytes = hex('83010203');
    const ast = CBOR.fromCBOR(bytes);
    expect(ast.toEDN()).toBe('[1,2,3]');
  });

  test('CBOR binary → AST → EDN text (pretty-printed)', () => {
    const bytes = hex('83010203');
    const ast = CBOR.fromCBOR(bytes);
    expect(ast.toEDN({ indent: 2 })).toBe('[\n  1,\n  2,\n  3\n]');
  });

  test('CBOR binary → JS value (shortcut)', () => {
    const bytes = hex('83010203');
    expect(CBOR.decode(bytes)).toEqual([1, 2, 3]);
  });

  test('JS value → CBOR binary (shortcut)', () => {
    const bytes = CBOR.encode([1, 2, 3]);
    expect(toHex(bytes)).toBe('83010203');
  });

  test('EDN text → AST → CBOR binary', () => {
    const ast = CBOR.fromEDN('[1, 2, 3]');
    expect(toHex(ast.toCBOR())).toBe('83010203');
  });

  test('JS value → EDN text (shortcut)', () => {
    expect(CBOR.stringify([1, 2, 3])).toBe('[1,2,3]');
  });

  test('EDN text → JS value (shortcut)', () => {
    expect(CBOR.parse('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  test('AST construction and inspection', () => {
    const node = new CborMap([[new CborTextString('key'), new CborUint(42n)]]);
    expect(node.entries).toHaveLength(1);
    expect((node.entries[0][0] as CborTextString).value).toBe('key');
    expect((node.entries[0][1] as CborUint).value).toBe(42n);
    expect(node.toEDN()).toBe('{"key":42}');
    expect(toHex(node.toCBOR())).toBe('a1636b6579182a');
  });

  test('CborFloat precision control', () => {
    const half = new CborFloat(1.0); // auto → half
    const single = new CborFloat(1.0, { precision: 'single' });
    const double = new CborFloat(1.0, { precision: 'double' });
    expect(toHex(half.toCBOR())).toBe('f93c00');
    expect(toHex(single.toCBOR())).toBe('fa3f800000');
    expect(toHex(double.toCBOR())).toBe('fb3ff0000000000000');
    expect(half.toEDN()).toBe('1.0');
    expect(single.toEDN()).toBe('1.0_2');
    expect(double.toEDN()).toBe('1.0_3');
  });
});

// ─── 11. Package entry point ─────────────────────────────────────────────────

test('package entry point imports without error', async () => {
  await import('./index');
});

// ─── 12. __proto__ key safety ─────────────────────────────────────────────────

describe('CborMap.toJS() — __proto__ key safety', () => {
  test('{"__proto__": 1} stores __proto__ as own property, not prototype change', () => {
    const ast = parseEDN('{"__proto__": 1}');
    const result = ast.toJS() as Record<string, unknown>;

    // The key must be an ordinary own enumerable property
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(
      true
    );
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe(1);

    // The prototype chain must be unchanged
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  test('{"__proto__": {"x": 1}} does not mutate prototype chain', () => {
    const savedProto = Object.getPrototypeOf({});
    const ast = parseEDN('{"__proto__": {"x": 1}}');
    ast.toJS();

    // Object.prototype must remain unaffected
    expect(Object.getPrototypeOf({})).toBe(savedProto);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test('normal keys are unaffected by the fix', () => {
    const result = parseEDN('{"a": 1, "b": 2}').toJS();
    expect(result).toEqual({ a: 1, b: 2 });
  });

  test('CBOR binary round-trip preserves __proto__ key', () => {
    const ast = parseEDN('{"__proto__": 42}');
    const decoded = decodeCBOR(ast.toCBOR());
    const result = decoded.toJS() as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(
      true
    );
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe(
      42
    );
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});

// ─── 13. toHexDump / CBOR.fromHexDump round-trip ─────────────────────────────

describe('toHexDump / CBOR.fromHexDump', () => {
  test('leaf value round-trips through hex dump', () => {
    const ast = parseEDN('42');
    const dump = ast.toHexDump();
    expect(toHex(CBOR.fromHexDump(dump).toCBOR())).toBe(toHex(ast.toCBOR()));
  });

  test('definite-length array round-trips through hex dump', () => {
    const ast = parseEDN('[1, 2, 3]');
    const dump = ast.toHexDump();
    expect(toHex(CBOR.fromHexDump(dump).toCBOR())).toBe(toHex(ast.toCBOR()));
  });

  test('indefinite-length array round-trips through hex dump', () => {
    const ast = parseEDN('[_ 1, [2, 3]]');
    const dump = ast.toHexDump();
    expect(toHex(CBOR.fromHexDump(dump).toCBOR())).toBe(toHex(ast.toCBOR()));
  });

  test('map round-trips through hex dump', () => {
    const ast = parseEDN('{"a": 1, "b": [2, 3]}');
    const dump = ast.toHexDump();
    expect(toHex(CBOR.fromHexDump(dump).toCBOR())).toBe(toHex(ast.toCBOR()));
  });

  test('fromHexDump accepts // comments', () => {
    const node = CBOR.fromHexDump(`83 // array(3)
      01 // 1
      02 // 2
      03 // 3`);
    expect(node.toEDN()).toBe('[1,2,3]');
  });

  test('fromHexDump accepts slash-delimited block comments', () => {
    const node = CBOR.fromHexDump('83 / array(3) / 01 / 1 / 02 / 2 / 03 / 3 /');
    expect(node.toEDN()).toBe('[1,2,3]');
  });

  test('fromHexDump accepts slash-delimited block comments spanning lines', () => {
    const node = CBOR.fromHexDump(`82
      01
      / comment
        spanning lines /
      02`);
    expect(node.toEDN()).toBe('[1,2]');
  });

  test('fromHexDump accepts star-delimited block comments', () => {
    const node = CBOR.fromHexDump(`83 /* array(3)
      spanning lines */ 01
      /* 2 */ 02
      03 /* 3 */`);
    expect(node.toEDN()).toBe('[1,2,3]');
  });

  test('fromHexDump rejects invalid token', () => {
    expect(() => CBOR.fromHexDump('GG -- bad')).toThrow(SyntaxError);
  });

  test('fromHexDump rejects unterminated block comment', () => {
    expect(() => CBOR.fromHexDump('01 /* nope')).toThrow(SyntaxError);
    expect(() => CBOR.fromHexDump('01 / nope')).toThrow(SyntaxError);
  });
});
