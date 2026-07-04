/**
 * Tests for the `ilbs` / `ilts` indefinite-length string app-extensions
 * (§3.5 of draft-ietf-cbor-edn-literals-26).
 *
 * Covers:
 *  - Spec §3.5 examples (including per-argument encoding indicators)
 *  - One chunk per argument; text/byte argument mixing
 *  - Zero-chunk forms ilbs<<>> / ilts<<>>
 *  - Shorthand string forms
 *  - UTF-8 chunk validity for ilts
 *  - Ellipsis rejection
 *  - toCDN round-trip of the original source
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

// ─── Spec §3.5 examples ───────────────────────────────────────────────────────

describe('ilbs / ilts — spec §3.5 examples', () => {
  test("'Hello world' → 4b 48656c6c6f20776f726c64 (definite, for contrast)", () => {
    expect(cborHex("'Hello world'")).toBe('4b48656c6c6f20776f726c64');
  });

  test('ilbs<<>> → 5f ff', () => {
    expect(cborHex('ilbs<<>>')).toBe('5fff');
  });

  test('ilts<<>> → 7f ff', () => {
    expect(cborHex('ilts<<>>')).toBe('7fff');
  });

  test('ilbs<<"Hello world">> → 5f 4b 48656c6c6f20776f726c64 ff', () => {
    expect(cborHex('ilbs<<"Hello world">>')).toBe(
      '5f4b48656c6c6f20776f726c64ff'
    );
  });

  test(`ilbs<<'Hello ', "world">> → 5f 46 48656c6c6f20 45 776f726c64 ff`, () => {
    expect(cborHex(`ilbs<<'Hello ', "world">>`)).toBe(
      '5f4648656c6c6f2045776f726c64ff'
    );
  });

  test(`ilbs<<'Hello '_0, 'world'>> honors per-argument encoding indicators`, () => {
    expect(cborHex(`ilbs<<'Hello '_0, 'world'>>`)).toBe(
      '5f580648656c6c6f2045776f726c64ff'
    );
  });
});

// ─── Chunk semantics ──────────────────────────────────────────────────────────

describe('ilbs / ilts — chunk semantics', () => {
  test('one chunk per argument', () => {
    // 7f 61 61 / 61 62 / 61 63 ff
    expect(cborHex('ilts<<"a", "b", "c">>')).toBe('7f616161626163ff');
  });

  test('ilts converts byte-string arguments to text chunks', () => {
    expect(cborHex(`ilts<<'Hello ', "world">>`)).toBe(
      '7f6648656c6c6f2065776f726c64ff'
    );
  });

  test('ilts per-argument encoding indicators are kept on the chunk', () => {
    expect(cborHex('ilts<<"a"_0, "b">>')).toBe('7f7801616162ff');
  });

  test('empty chunks are preserved', () => {
    expect(cborHex("ilbs<<''>>")).toBe('5f40ff');
    expect(cborHex('ilts<<"">>')).toBe('7f60ff');
  });

  test('decodes back to the joined value via toJS', () => {
    expect(parseCDN('ilts<<"Hello ", "world">>').toJS()).toBe('Hello world');
    expect(hex(parseCDN("ilbs<<'Hello '>>").toJS() as Uint8Array)).toBe(
      '48656c6c6f20'
    );
  });

  test('an indefinite-length string argument contributes one merged chunk', () => {
    // (_ "a", "b") is a text string at the data model level → one chunk "ab"
    expect(cborHex('ilts<<(_ "a", "b")>>')).toBe('7f626162ff');
    expect(cborHex("ilbs<<(_ h'01', h'02')>>")).toBe('5f420102ff');
    // Mixed with definite arguments, and across string kinds
    expect(cborHex('ilts<<(_ "a", "b"), "c">>')).toBe('7f6261626163ff');
    expect(cborHex('ilbs<<(_ "a", "b")>>')).toBe('5f426162ff');
  });
});

// ─── Shorthand string forms ───────────────────────────────────────────────────

describe('ilbs / ilts — string shorthand forms (§2.1)', () => {
  test("ilbs'foo' → single byte chunk", () => {
    expect(cborHex("ilbs'foo'")).toBe('5f43666f6fff');
  });

  test('ilts`foo` → single text chunk', () => {
    expect(cborHex('ilts`foo`')).toBe('7f63666f6fff');
  });
});

// ─── Validity and error cases ─────────────────────────────────────────────────

describe('ilbs / ilts — validity and errors', () => {
  test('ilts byte-string chunk must itself be valid UTF-8 (RFC 8949 §3.2.3)', () => {
    // e3 / 8182 splits "あ" across chunks — each chunk alone is invalid UTF-8
    expect(() => parseCDN("ilts<<h'e3', h'8182'>>")).toThrow(SyntaxError);
  });

  test('ilts invalid chunk recovers with a warning in non-strict mode', () => {
    const warnings: string[] = [];
    parseCDN("ilts<<h'ff'>>", {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    });
    expect(warnings.some((m) => m.includes('not valid UTF-8'))).toBe(true);
  });

  test('ellipsis arguments are rejected', () => {
    expect(() => parseCDN("ilbs<<'a', ...>>")).toThrow(SyntaxError);
    expect(() => parseCDN('ilts<<...>>')).toThrow(SyntaxError);
  });

  test('non-string arguments are rejected', () => {
    expect(() => parseCDN('ilbs<<1>>')).toThrow(SyntaxError);
    expect(() => parseCDN('ilts<<[1]>>')).toThrow(SyntaxError);
  });
});

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe('ilbs / ilts — round-trip', () => {
  test('toCDN preserves the original source', () => {
    expect(parseCDN(`ilbs<<'Hello ', "world">>`).toCDN()).toBe(
      `ilbs<<'Hello ', "world">>`
    );
  });

  test('string shorthand forms round-trip as app-strings, not `(_ ...)`', () => {
    expect(parseCDN("ilbs'foo'").toCDN()).toBe("ilbs'foo'");
    expect(parseCDN("ilts'foo'").toCDN()).toBe("ilts'foo'");
    // The raw string form normalizes to the single-quoted form
    expect(parseCDN('ilts`foo`').toCDN()).toBe("ilts'foo'");
    // Content requiring escapes is re-escaped correctly
    expect(parseCDN("ilts'a\\'b'").toCDN()).toBe("ilts'a\\'b'");
  });

  test('string shorthand forms fall back to streamstring with appStrings: false', () => {
    expect(parseCDN("ilbs'foo'").toCDN({ appStrings: false })).toBe(
      "(_ 'foo')"
    );
  });

  test('appStrings: false falls back to the streamstring notation', () => {
    expect(
      parseCDN('ilts<<"Hello ", "world">>').toCDN({ appStrings: false })
    ).toBe('(_ "Hello ", "world")');
  });

  test('equivalent to the legacy streamstring syntax', () => {
    expect(cborHex('ilts<<"foo", "bar">>')).toBe(cborHex('(_ "foo", "bar")'));
    expect(cborHex("ilbs<<h'0123', h'4567'>>")).toBe(
      cborHex("(_ h'0123', h'4567')")
    );
  });
});
