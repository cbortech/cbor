/**
 * Tests for the `t1` / `b1` string-concatenation app-extensions
 * (§3.4 of draft-ietf-cbor-edn-literals-26).
 *
 * Covers:
 *  - Spec §3.4 equivalence examples (text and byte)
 *  - Mixing text and byte string arguments
 *  - Single-quoted / raw-string shorthand forms
 *  - Ellipsis arguments → tag CPA888 array, adjacent-ellipsis collapsing,
 *    and flattening of nested ellipsis arguments
 *  - UTF-8 validity of the t1 result (strict error / non-strict recovery)
 *  - toCDN round-trip of the original source
 *  - Error cases (non-string arguments)
 */

import { describe, test, expect } from 'vitest';
import { parseCDN } from '../cdn/parser';

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}

function cborHex(text: string): string {
  return hex(parseCDN(text).toCBOR());
}

// ─── Spec §3.4 equivalence examples ───────────────────────────────────────────

describe('t1 — spec §3.4 text-string equivalences', () => {
  const expected = cborHex('"Hello world"');

  test.each([
    't1<<"Hello ", "world">>',
    `t1<<"Hello", h'20', "world">>`,
    `t1<<h'48656c6c6f20776f726c64'>>`,
  ])('%s ≡ "Hello world"', (text) => {
    expect(cborHex(text)).toBe(expected);
    expect(expected).toBe('6b48656c6c6f20776f726c64');
  });
});

describe('b1 — spec §3.4 byte-string equivalences', () => {
  const expected = cborHex("'Hello world'");

  test.each([
    'b1<<"Hello world">>',
    "b1<<'Hello ', 'world'>>",
    `b1<<'Hello ', h'776f726c64'>>`,
    `b1<<'Hello', h'20', 'world'>>`,
    `b1<<h'48656c6c6f20776f726c64', '', b64''>>`,
    `b1<<h'4 86 56c 6c6f', h' 20776 f726c64'>>`,
  ])("%s ≡ 'Hello world'", (text) => {
    expect(cborHex(text)).toBe(expected);
    expect(expected).toBe('4b48656c6c6f20776f726c64');
  });
});

// ─── Shorthand string forms ───────────────────────────────────────────────────

describe('t1 / b1 — string shorthand forms (§2.1)', () => {
  test("t1'foo' → text string", () => {
    const v = parseCDN("t1'foo'");
    expect(v.toJS()).toBe('foo');
  });

  test('t1`foo` (raw string form) → text string', () => {
    expect(parseCDN('t1`foo`').toJS()).toBe('foo');
  });

  test("b1'foo' → byte string of the UTF-8 bytes", () => {
    expect(cborHex("b1'foo'")).toBe('43666f6f');
  });

  test('empty sequences produce empty strings', () => {
    expect(cborHex('t1<<>>')).toBe('60');
    expect(cborHex('b1<<>>')).toBe('40');
  });
});

// ─── Ellipsis arguments (§3.4 / §4.2) ─────────────────────────────────────────

describe('t1 / b1 — ellipsis arguments', () => {
  test("b1<<'Hello', ..., 'world'>> ≡ h'48656c6c6f...776f726c64'", () => {
    const expected = cborHex("h'48656c6c6f...776f726c64'");
    expect(cborHex("b1<<'Hello', ..., 'world'>>")).toBe(expected);
    expect(cborHex("b1<<h'48656c6c6f...', ..., h'...776f726c64'>>")).toBe(
      expected
    );
  });

  test('t1<<"He", ..., "ob">> → 888(["He", 888(null), "ob"])', () => {
    // d9 0378 (tag 888) [ 62 4865 "He", d9 0378 f6 888(null), 62 6f62 "ob" ]
    expect(cborHex('t1<<"He", ..., "ob">>')).toBe(
      'd9037883624865d90378f6626f62'
    );
  });

  test('adjacent ellipses collapse into one', () => {
    expect(cborHex('t1<<"a", ..., ..., "b">>')).toBe(
      cborHex('t1<<"a", ..., "b">>')
    );
  });

  test('a lone ellipsis argument list is a plain ellipsis', () => {
    expect(cborHex('t1<<...>>')).toBe(cborHex('...'));
    expect(cborHex('b1<<..., ...>>')).toBe(cborHex('...'));
  });

  test('empty spans adjacent to an ellipsis add nothing', () => {
    expect(cborHex('b1<<"", ..., \'\'>>')).toBe(cborHex('...'));
  });

  test('fragments have the result type (text for t1, bytes for b1)', () => {
    // t1 fragments are text strings (62 xx), b1 fragments byte strings (42 xx)
    expect(cborHex('t1<<"ab", ..., "cd">>')).toBe(
      'd9037883626162d90378f6626364'
    );
    expect(cborHex("b1<<'ab', ..., 'cd'>>")).toBe(
      'd9037883426162d90378f6426364'
    );
  });
});

// ─── UTF-8 validity of the t1 result ──────────────────────────────────────────

describe('t1 — UTF-8 validity (§3.4 / §2.5.8)', () => {
  test("t1<<h'ff'>> throws in strict mode", () => {
    expect(() => parseCDN("t1<<h'ff'>>")).toThrow(SyntaxError);
  });

  test("t1<<h'ff'>> recovers with a warning in non-strict mode", () => {
    const warnings: string[] = [];
    const v = parseCDN("t1<<h'ff'>>", {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    });
    expect(warnings.some((m) => m.includes('not valid UTF-8'))).toBe(true);
    expect(typeof v.toJS()).toBe('string');
  });

  test('a multi-byte character may be split across arguments', () => {
    // "あ" = e3 81 82
    expect(parseCDN("t1<<h'e3', h'8182'>>").toJS()).toBe('あ');
  });

  test('b1 accepts arbitrary bytes', () => {
    expect(cborHex("b1<<h'ff', h'fe'>>")).toBe('42fffe');
  });
});

// ─── Round-trip and error cases ───────────────────────────────────────────────

describe('t1 / b1 — round-trip and errors', () => {
  test('toCDN preserves the original source', () => {
    expect(parseCDN('t1<<"Hello ", "world">>').toCDN()).toBe(
      't1<<"Hello ", "world">>'
    );
  });

  test('appStrings: false serializes the resolved value', () => {
    expect(
      parseCDN('t1<<"Hello ", "world">>').toCDN({ appStrings: false })
    ).toBe('"Hello world"');
  });

  test('result types', () => {
    const t = parseCDN('t1<<"a">>').toCBOR();
    expect(hex(t)).toBe('6161');
    expect(parseCDN("b1<<'a'>>")).toBeDefined();
  });

  test('non-string arguments throw', () => {
    expect(() => parseCDN('t1<<1>>')).toThrow(SyntaxError);
    expect(() => parseCDN('b1<<[1]>>')).toThrow(SyntaxError);
    expect(() => parseCDN('t1<<null>>')).toThrow(SyntaxError);
  });

  test('indefinite-length string arguments are accepted at the data model level', () => {
    expect(parseCDN('t1<<(_ "a", "b"), "c">>').toJS()).toBe('abc');
  });

  test('CborTextString / CborByteString results for plain concatenation', () => {
    const inner = parseCDN('t1<<"a", "b">>').toJS();
    expect(inner).toBe('ab');
    const b = parseCDN("b1<<'a', 'b'>>").toJS() as Uint8Array;
    expect(hex(b)).toBe('6162');
  });
});
