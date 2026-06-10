import { describe, test, expect, vi } from 'vitest';
import { parseCDN } from './parser';
import type { ParseWarning } from '../types';
import { toCDN } from './serializer';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborByteString } from '../ast/CborByteString';
import { CborIndefiniteByteString } from '../ast/CborIndefiniteByteString';
import { CborTextString } from '../ast/CborTextString';
import { CborIndefiniteTextString } from '../ast/CborIndefiniteTextString';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborTag } from '../ast/CborTag';
import { CborFloat } from '../ast/CborFloat';
import { CborSimple } from '../ast/CborSimple';
import { CborEmbeddedCBOR } from '../ast/CborEmbeddedCBOR';
import { CborUnresolvedAppExt } from '../ast/CborUnresolvedAppExt';
import { CborEllipsis } from '../ast/CborEllipsis';
import { b32, h32 } from '../extensions/b32';

/** Convert Uint8Array to lowercase hex string. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Unsigned integers ────────────────────────────────────────────────────────

describe('parseCDN — unsigned integers', () => {
  test('0', () => {
    const n = parseCDN('0') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.value).toBe(0n);
  });
  test('42', () => {
    const n = parseCDN('42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('18446744073709551615 (uint64 max)', () => {
    const n = parseCDN('18446744073709551615') as CborUint;
    expect(n.value).toBe(18_446_744_073_709_551_615n);
  });
  test('0xff (hex)', () => {
    const n = parseCDN('0xff') as CborUint;
    expect(n.value).toBe(255n);
  });
  test('0xFF (hex uppercase)', () => {
    const n = parseCDN('0xFF') as CborUint;
    expect(n.value).toBe(255n);
  });
  test('0o17 (octal)', () => {
    const n = parseCDN('0o17') as CborUint;
    expect(n.value).toBe(15n);
  });
  test('0b1010 (binary)', () => {
    const n = parseCDN('0b1010') as CborUint;
    expect(n.value).toBe(10n);
  });
});

// ─── Negative integers ────────────────────────────────────────────────────────

describe('parseCDN — negative integers', () => {
  test('-1', () => {
    const n = parseCDN('-1') as CborNint;
    expect(n).toBeInstanceOf(CborNint);
    expect(n.value).toBe(-1n);
  });
  test('-1000', () => {
    const n = parseCDN('-1000') as CborNint;
    expect(n.value).toBe(-1000n);
  });
  test('-0xff', () => {
    const n = parseCDN('-0xff') as CborNint;
    expect(n.value).toBe(-255n);
  });
});

// ─── Floating-point ───────────────────────────────────────────────────────────

describe('parseCDN — floats', () => {
  test('0.0', () => {
    const n = parseCDN('0.0') as CborFloat;
    expect(n).toBeInstanceOf(CborFloat);
    expect(n.value).toBe(0.0);
    expect(n.precision).toBeUndefined();
  });
  test('-0.0', () => {
    const n = parseCDN('-0.0') as CborFloat;
    expect(Object.is(n.value, -0)).toBe(true);
  });
  test('1.5', () => {
    const n = parseCDN('1.5') as CborFloat;
    expect(n.value).toBe(1.5);
  });
  test('1.1', () => {
    expect((parseCDN('1.1') as CborFloat).value).toBeCloseTo(1.1);
  });
  test('NaN', () => {
    expect(isNaN((parseCDN('NaN') as CborFloat).value)).toBe(true);
  });
  test('Infinity', () => {
    expect((parseCDN('Infinity') as CborFloat).value).toBe(Infinity);
  });
  test('-Infinity', () => {
    expect((parseCDN('-Infinity') as CborFloat).value).toBe(-Infinity);
  });
  test('3.14e-2', () => {
    const n = parseCDN('3.14e-2') as CborFloat;
    expect(n.value).toBeCloseTo(0.0314);
  });

  // ── positive sign ─────────────────────────────────────────────────────────
  // Per draft-ietf-cbor-edn-literals-25 §2.4: 0, +0, -0 are all uint (00).

  test('+0 → uint 0 (same as 0)', () => {
    const n = parseCDN('+0') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.value).toBe(0n);
  });
  test('-0 → uint 0 (same as 0)', () => {
    const n = parseCDN('-0') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.value).toBe(0n);
  });
  // ── leading-dot floats ────────────────────────────────────────────────────

  test('.5 → 0.5', () => {
    expect((parseCDN('.5') as CborFloat).value).toBe(0.5);
  });
  test('.1 → 0.1', () => {
    expect((parseCDN('.1') as CborFloat).value).toBeCloseTo(0.1);
  });
  test('.1e2 → 10', () => {
    expect((parseCDN('.1e2') as CborFloat).value).toBe(10);
  });

  test('+0.0 → positive zero float', () => {
    const n = parseCDN('+0.0') as CborFloat;
    expect(n).toBeInstanceOf(CborFloat);
    expect(Object.is(n.value, +0)).toBe(true);
  });
  test('+1.5 → 1.5', () => {
    expect((parseCDN('+1.5') as CborFloat).value).toBe(1.5);
  });
  test('+Infinity', () => {
    expect((parseCDN('+Infinity') as CborFloat).value).toBe(Infinity);
  });
  test('+Infinity_2 → precision=single', () => {
    const n = parseCDN('+Infinity_2') as CborFloat;
    expect(n.value).toBe(Infinity);
    expect(n.precision).toBe('single');
  });

  // ── NaN with encoding indicator ───────────────────────────────────────────

  test('NaN_1 → precision=half', () => {
    const n = parseCDN('NaN_1') as CborFloat;
    expect(isNaN(n.value)).toBe(true);
    expect(n.precision).toBe('half');
  });
  test('NaN_2 → precision=single', () => {
    const n = parseCDN('NaN_2') as CborFloat;
    expect(isNaN(n.value)).toBe(true);
    expect(n.precision).toBe('single');
  });
  test('NaN_3 → precision=double', () => {
    const n = parseCDN('NaN_3') as CborFloat;
    expect(isNaN(n.value)).toBe(true);
    expect(n.precision).toBe('double');
  });
  test('NaN_i → SyntaxError', () => {
    expect(() => parseCDN('NaN_i')).toThrow(SyntaxError);
  });
  test('NaN_0 → SyntaxError (_0 is not valid for floats)', () => {
    expect(() => parseCDN('NaN_0')).toThrow(SyntaxError);
  });

  // ── Infinity with encoding indicator ─────────────────────────────────────

  test('Infinity_1 → precision=half', () => {
    const n = parseCDN('Infinity_1') as CborFloat;
    expect(n.value).toBe(Infinity);
    expect(n.precision).toBe('half');
  });
  test('Infinity_2 → precision=single', () => {
    const n = parseCDN('Infinity_2') as CborFloat;
    expect(n.value).toBe(Infinity);
    expect(n.precision).toBe('single');
  });
  test('-Infinity_1 → precision=half', () => {
    const n = parseCDN('-Infinity_1') as CborFloat;
    expect(n.value).toBe(-Infinity);
    expect(n.precision).toBe('half');
  });
  test('-Infinity_2 → precision=single', () => {
    const n = parseCDN('-Infinity_2') as CborFloat;
    expect(n.value).toBe(-Infinity);
    expect(n.precision).toBe('single');
  });
  test('Infinity_i → SyntaxError', () => {
    expect(() => parseCDN('Infinity_i')).toThrow(SyntaxError);
  });
  test('Infinity_0 → SyntaxError (_0 is not valid for floats)', () => {
    expect(() => parseCDN('Infinity_0')).toThrow(SyntaxError);
  });
  test('-Infinity_0 → SyntaxError (_0 is not valid for floats)', () => {
    expect(() => parseCDN('-Infinity_0')).toThrow(SyntaxError);
  });

  // ── hex float literals ────────────────────────────────────────────────────

  test('0x1p+0 → 1.0', () => {
    expect((parseCDN('0x1p+0') as CborFloat).value).toBe(1.0);
  });
  test('0x1.8p+0 → 1.5', () => {
    expect((parseCDN('0x1.8p+0') as CborFloat).value).toBe(1.5);
  });
  test('-0x1.8p+0 → -1.5', () => {
    expect((parseCDN('-0x1.8p+0') as CborFloat).value).toBe(-1.5);
  });
  test('0x0p+0 → +0 float', () => {
    const n = parseCDN('0x0p+0') as CborFloat;
    expect(Object.is(n.value, 0)).toBe(true);
  });

  // Malformed hex floats must throw, not silently return NaN/0
  test('0x1p — no exponent digits → SyntaxError', () =>
    expect(() => parseCDN('0x1p')).toThrow(SyntaxError));
  test('0x.p+1 — no mantissa digits → SyntaxError', () =>
    expect(() => parseCDN('0x.p+1')).toThrow(SyntaxError));
  test('0xp+0 — no mantissa digits → SyntaxError', () =>
    expect(() => parseCDN('0xp+0')).toThrow(SyntaxError));

  test('1.0_1 → precision=half', () => {
    const n = parseCDN('1.0_1') as CborFloat;
    expect(n.value).toBe(1.0);
    expect(n.precision).toBe('half');
  });
  test('1.0_2 → precision=single', () => {
    const n = parseCDN('1.0_2') as CborFloat;
    expect(n.precision).toBe('single');
  });
  test('1.0_3 → precision=double', () => {
    const n = parseCDN('1.0_3') as CborFloat;
    expect(n.precision).toBe('double');
  });
});

// ─── Text strings ─────────────────────────────────────────────────────────────

describe('parseCDN — text strings', () => {
  test('empty ""', () => {
    const n = parseCDN('""') as CborTextString;
    expect(n).toBeInstanceOf(CborTextString);
    expect(n.value).toBe('');
  });
  test('"hello"', () => {
    expect((parseCDN('"hello"') as CborTextString).value).toBe('hello');
  });
  test('escape sequences', () => {
    expect((parseCDN('"\\n\\t\\r"') as CborTextString).value).toBe('\n\t\r');
  });
  test('\\u escape', () => {
    expect((parseCDN('"\\u00fc"') as CborTextString).value).toBe('ü');
  });
  test('string concatenation "a" + "b"', () => {
    const n = parseCDN('"hello" + " " + "world"') as CborTextString;
    expect(n).toBeInstanceOf(CborTextString);
    expect(n.value).toBe('hello world');
  });
  test('"Hello" + h\'20\' + "world" → CborTextString "Hello world"', () => {
    // text-leading: byte chunks are decoded as UTF-8 into the text string
    const n = parseCDN('"Hello" + h\'20\' + "world"');
    expect(n).toBeInstanceOf(CborTextString);
    expect((n as CborTextString).value).toBe('Hello world');
  });
  test('"Hello" + h\'48656c6c6f20776f726c64\' → same as "Hello world"', () => {
    const n = parseCDN('"" + h\'48656c6c6f20776f726c64\' + ""');
    expect(n).toBeInstanceOf(CborTextString);
    expect((n as CborTextString).value).toBe('Hello world');
  });
  test("'Hello ' + 'world' → CborByteString (bytes concat)", () => {
    // byte-leading: result is a byte string
    const n = parseCDN("'Hello ' + 'world'");
    expect(n).toBeInstanceOf(CborByteString);
    expect((n as CborByteString).value).toEqual(
      new Uint8Array([
        0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64,
      ])
    );
  });
  test("'Hello' + h'20' + 'world' → CborByteString (byte concat)", () => {
    const n = parseCDN("'Hello' + h'20' + 'world'");
    expect(n).toBeInstanceOf(CborByteString);
    expect((n as CborByteString).value).toEqual(
      new Uint8Array([
        0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64,
      ])
    );
  });
  test('byte-leading concat with double-quoted text → strict:true throws', () => {
    // §5.1: text string on the right of a byte-leading concat is not allowed
    expect(() => parseCDN('h\'48\' + "ello"')).toThrow(SyntaxError);
  });
  test('byte-leading concat with double-quoted text → strict:false warns + UTF-8 encodes', () => {
    const warnings: ParseWarning[] = [];
    const n = parseCDN('h\'48\' + "ello"', {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new TextEncoder().encode('Hello'));
    expect(warnings[0].message).toMatch(
      /text string in a byte-string concatenation/
    );
  });
  test('byte-leading concat with backtick raw string → strict:true throws', () => {
    expect(() => parseCDN("'' + `a`")).toThrow(SyntaxError);
  });
  test('byte-leading concat with backtick raw string → strict:false warns + UTF-8 encodes', () => {
    const warnings: ParseWarning[] = [];
    const n = parseCDN("'' + `a`", {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new TextEncoder().encode('a'));
    expect(warnings[0].message).toMatch(
      /text string in a byte-string concatenation/
    );
  });

  test('text-leading concat with invalid UTF-8 byte chunk → SyntaxError by default', () => {
    // h'ff' is not valid UTF-8; should throw without allowInvalidUtf8
    expect(() => parseCDN('"a" + h\'ff\'')).toThrow(SyntaxError);
  });

  test('text-leading concat with invalid UTF-8 byte chunk → U+FFFD with allowInvalidUtf8', () => {
    const n = parseCDN('"a" + h\'ff\'', {
      allowInvalidUtf8: true,
    }) as CborTextString;
    expect(n).toBeInstanceOf(CborTextString);
    expect(n.value).toBe('a\uFFFD');
  });
  test('escaped quote', () => {
    expect((parseCDN('"\\""') as CborTextString).value).toBe('"');
  });
  test('escaped backslash', () => {
    expect((parseCDN('"\\\\"') as CborTextString).value).toBe('\\');
  });

  // ── Unicode escape \u{NNN} ──────────────────────────────────────────────────

  test('\\u{41} → "A"', () => {
    expect((parseCDN('"\\u{41}"') as CborTextString).value).toBe('A');
  });
  test('\\u{FC} → "ü"', () => {
    expect((parseCDN('"\\u{fc}"') as CborTextString).value).toBe('ü');
  });
  test('\\u{1F600} → emoji 😀', () => {
    expect((parseCDN('"\\u{1F600}"') as CborTextString).value).toBe('😀');
  });
  test('\\u{10FFFF} → last Unicode code point', () => {
    const val = (parseCDN('"\\u{10FFFF}"') as CborTextString).value;
    expect(val.codePointAt(0)).toBe(0x10ffff);
  });
  test('\\u{110000} → SyntaxError (out of range)', () => {
    expect(() => parseCDN('"\\u{110000}"')).toThrow(SyntaxError);
  });
  test('\\u{D800} → SyntaxError (surrogate not a scalar value)', () => {
    expect(() => parseCDN('"\\u{D800}"')).toThrow(SyntaxError);
  });
  test('\\u{DFFF} → SyntaxError (surrogate not a scalar value)', () => {
    expect(() => parseCDN('"\\u{DFFF}"')).toThrow(SyntaxError);
  });
  test('\\u{} → SyntaxError (empty)', () => {
    expect(() => parseCDN('"\\u{}"')).toThrow(SyntaxError);
  });

  // ── Surrogate pair \uXXXX\uXXXX ────────────────────────────────────────────

  test('valid surrogate pair \\uD83D\\uDE00 → "😀"', () => {
    expect((parseCDN('"\\uD83D\\uDE00"') as CborTextString).value).toBe('😀');
  });
  test('valid surrogate pair \\uD800\\uDC00 → U+10000', () => {
    const val = (parseCDN('"\\uD800\\uDC00"') as CborTextString).value;
    expect(val.codePointAt(0)).toBe(0x10000);
  });
  test('lone high surrogate \\uD800 → SyntaxError', () => {
    expect(() => parseCDN('"\\uD800"')).toThrow(SyntaxError);
  });
  test('lone low surrogate \\uDFFF → SyntaxError', () => {
    expect(() => parseCDN('"\\uDFFF"')).toThrow(SyntaxError);
  });
  test('high surrogate followed by non-surrogate → SyntaxError', () => {
    expect(() => parseCDN('"\\uD800\\u0041"')).toThrow(SyntaxError);
  });

  // ── Literal LF and CR in source ─────────────────────────────────────────────

  test('literal LF inside string is allowed (spec §2.5.1)', () => {
    const val = (parseCDN('"hello\nworld"') as CborTextString).value;
    expect(val).toBe('hello\nworld');
  });
  test('literal CR is stripped (cross-platform normalisation)', () => {
    const val = (parseCDN('"hello\rworld"') as CborTextString).value;
    expect(val).toBe('helloworld');
  });
  test('literal CRLF → only LF kept', () => {
    const val = (parseCDN('"hello\r\nworld"') as CborTextString).value;
    expect(val).toBe('hello\nworld');
  });

  // ── Escaped newline (§5.1 escapable1: \ newline → swallow) ──────────────────

  // §5.1 escapable1 does not include backslash-newline.
  test('backslash-LF is a SyntaxError (draft-25 §5.1)', () => {
    expect(() => parseCDN('"hello\\\nworld"')).toThrow(SyntaxError);
  });
  test('backslash-CRLF is a SyntaxError (draft-25 §5.1)', () => {
    expect(() => parseCDN('"hello\\\r\nworld"')).toThrow(SyntaxError);
  });
  test('backslash-CR is a SyntaxError (draft-25 §5.1)', () => {
    expect(() => parseCDN('"hello\\\rworld"')).toThrow(SyntaxError);
  });
});

// ─── Raw string literals (backtick strings) ───────────────────────────────────

describe('parseCDN — raw string literals (backtick)', () => {
  // ── Single-backtick delimiter ────────────────────────────────────────────

  test('simple content `hello`', () => {
    expect((parseCDN('`hello`') as CborTextString).value).toBe('hello');
  });

  test('backslash is not an escape (literal \\n)', () => {
    // In a raw string, \n is two characters: backslash + n
    expect((parseCDN('`\\n`') as CborTextString).value).toBe('\\n');
  });

  test('backslash sequences stay literal', () => {
    expect((parseCDN('`\\t\\r\\u0041`') as CborTextString).value).toBe(
      '\\t\\r\\u0041'
    );
  });

  test('double-quote inside raw string', () => {
    expect((parseCDN('`say "hello"`') as CborTextString).value).toBe(
      'say "hello"'
    );
  });

  test('single-quote inside raw string', () => {
    expect((parseCDN("`it's`") as CborTextString).value).toBe("it's");
  });

  test('multiline content (no leading newline to strip)', () => {
    const n = parseCDN('`line1\nline2`') as CborTextString;
    expect(n.value).toBe('line1\nline2');
  });

  test('CRLF is normalized to LF within content', () => {
    // \r before line2 is stripped; \n becomes content
    const n = parseCDN('`line1\r\nline2`') as CborTextString;
    expect(n.value).toBe('line1\nline2');
  });

  // ── Leading newline stripping (§2.5.3) ───────────────────────────────────

  test('leading LF is stripped', () => {
    // `\nhello` → "hello"
    expect((parseCDN('`\nhello`') as CborTextString).value).toBe('hello');
  });

  test('leading CRLF is stripped', () => {
    expect((parseCDN('`\r\nhello`') as CborTextString).value).toBe('hello');
  });

  test('only the first leading newline is stripped', () => {
    // `\n\nhello` → "\nhello"
    expect((parseCDN('`\n\nhello`') as CborTextString).value).toBe('\nhello');
  });

  // ── Multi-backtick delimiter (N > 1) ─────────────────────────────────────

  test('double-backtick delimiter allows single backtick in content (spec §2.5.3 example)', () => {
    // ``[^ \t\n\r"'`]`` from the spec
    const n = parseCDN('``[^ \\t\\n\\r"\'`]``') as CborTextString;
    expect(n).toBeInstanceOf(CborTextString);
    expect(n.value).toBe('[^ \\t\\n\\r"\'`]');
  });

  test('triple-backtick delimiter allows double backtick in content', () => {
    // ```a``b``` → "a``b"
    const n = parseCDN('```a``b```') as CborTextString;
    expect(n.value).toBe('a``b');
  });

  test('excess closing backticks become content (§2.5.3)', () => {
    // ```a = ``foo````` (3-backtick delimited, 5 closing) → "a = ``foo``"
    const n = parseCDN('```a = ``foo`````') as CborTextString;
    expect(n.value).toBe('a = ``foo``');
  });

  test('leading newline stripped with multi-backtick delimiter', () => {
    // ```\na``` → "a"
    const n = parseCDN('```\na```') as CborTextString;
    expect(n.value).toBe('a');
  });

  // ── Encoding indicator and concatenation ─────────────────────────────────

  test('encoding indicator `hello`_1', () => {
    const n = parseCDN('`hello`_1') as CborTextString;
    expect(n).toBeInstanceOf(CborTextString);
    expect(n.value).toBe('hello');
    expect(n.encodingWidth).toBe(1);
  });

  test('concatenation `foo` + `bar`', () => {
    const n = parseCDN('`foo` + `bar`') as CborTextString;
    expect(n).toBeInstanceOf(CborTextString);
    expect(n.value).toBe('foobar');
  });

  test('mixed concatenation `foo` + " " + `bar`', () => {
    const n = parseCDN('`foo` + " " + `bar`') as CborTextString;
    expect(n).toBeInstanceOf(CborTextString);
    expect(n.value).toBe('foo bar');
  });

  // ── Error cases ──────────────────────────────────────────────────────────

  test('unterminated raw string throws SyntaxError', () => {
    expect(() => parseCDN('`oops')).toThrow(SyntaxError);
  });

  test('unterminated double-backtick raw string throws SyntaxError', () => {
    expect(() => parseCDN('``oops`')).toThrow(SyntaxError);
  });

  // ── Empty raw strings are forbidden (§2.5.3) ─────────────────────────────

  test('empty bare raw string `` throws SyntaxError', () => {
    expect(() => parseCDN('``')).toThrow(SyntaxError);
  });

  test('empty double-backtick raw string ```` throws SyntaxError', () => {
    expect(() => parseCDN('````')).toThrow(SyntaxError);
  });

  test('raw string with only a leading newline (stripped → empty) throws SyntaxError', () => {
    expect(() => parseCDN('`\n`')).toThrow(SyntaxError);
  });

  // rawchars forbids HT (draft-25 §2.5.3)
  test('raw string containing literal HT (tab) throws SyntaxError', () => {
    expect(() => parseCDN('`foo\tbar`')).toThrow(SyntaxError);
  });

  test('empty h backtick h`` throws SyntaxError', () => {
    expect(() => parseCDN('h``')).toThrow(SyntaxError);
  });

  test('empty b64 backtick b64`` throws SyntaxError', () => {
    expect(() => parseCDN('b64``')).toThrow(SyntaxError);
  });

  test('empty dt backtick dt`` throws SyntaxError', () => {
    expect(() => parseCDN('dt``')).toThrow(SyntaxError);
  });
});

// ─── Byte strings ─────────────────────────────────────────────────────────────

describe('parseCDN — byte strings', () => {
  test("h'' (empty hex)", () => {
    const n = parseCDN("h''") as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new Uint8Array(0));
  });
  test("h'0102'", () => {
    const n = parseCDN("h'0102'") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02]));
  });
  test("h'deadbeef'", () => {
    const n = parseCDN("h'deadbeef'") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
  test("b64'AQIDBA==' (padded) is accepted", () => {
    const n = parseCDN("b64'AQIDBA=='") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  test("b64'AQIDBA' (missing ==) is accepted — draft-25 allows omitting padding", () => {
    const n = parseCDN("b64'AQIDBA'") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  test("b64'3q2-7w==' (base64url, padded) is accepted", () => {
    // 0xDE 0xAD 0xBE 0xEF in base64url
    const n = parseCDN("b64'3q2-7w=='") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
  test("b64'3q2-7w' (base64url, missing ==) is accepted", () => {
    const n = parseCDN("b64'3q2-7w'") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
  test('base64 mixed classic and URL-safe chars in one literal (b64dig, draft-25 §5.2.2)', () => {
    // 3q2+7w== = 0xDE 0xAD 0xBE 0xEF in classic base64 (+ instead of -)
    // draft-25 b64dig allows +, /, -, _ in any combination
    const n = parseCDN("b64'3q2+7w=='") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
  test("b64'AA=' (partial padding: 1 of 2) throws in strict mode", () => {
    // AA needs == (rem=2, expectedPad=2), but only 1 '=' given
    expect(() => parseCDN("b64'AA='")).toThrow(SyntaxError);
  });
  test("b64'AA=' (partial padding) warns and decodes in lenient mode", () => {
    const warnings: string[] = [];
    const n = parseCDN("b64'AA='", {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    }) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x00]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/needs exactly 2/i);
  });
  test("b64'AA===' (excess padding: 3 of max 2) throws in strict mode", () => {
    expect(() => parseCDN("b64'AA==='")).toThrow(SyntaxError);
  });
  test("b64'AA===' (excess padding) warns and decodes in lenient mode", () => {
    const warnings: string[] = [];
    const n = parseCDN("b64'AA==='", {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    }) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x00]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/requires at most 2/i);
  });
  test("b64'AQID====' (excess padding: 4 of max 0) throws in strict mode", () => {
    expect(() => parseCDN("b64'AQID===='")).toThrow(SyntaxError);
  });
  test("b64'AQID====' (excess padding) warns and decodes in lenient mode", () => {
    const warnings: string[] = [];
    const n = parseCDN("b64'AQID===='", {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    }) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([1, 2, 3]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/requires at most 0/i);
  });
  test('base64 with rem=1 always throws (no valid byte sequence yields 1 mod 4)', () => {
    // 'A' alone = 1 char, rem=1 — never a valid base64 sequence
    expect(() => parseCDN("b64'A'")).toThrow(SyntaxError);
    expect(() => parseCDN("b64'A'", { strict: false })).toThrow(SyntaxError);
  });
  test("b64'AE==' (non-zero trailing bits) throws in strict mode (RFC 4648 §3.5)", () => {
    // A=0, E=4=000100; 2-char quantum, mask=0x0f; 000100 & 0x0f = 4 ≠ 0
    expect(() => parseCDN("b64'AE=='")).toThrow(SyntaxError);
  });
  test("b64'AE==' (non-zero trailing bits) warns and decodes in lenient mode", () => {
    // A=0, E=4=000100; bottom 4 bits = 0100 ≠ 0
    const warnings: string[] = [];
    const n = parseCDN("b64'AE=='", {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    }) as CborByteString;
    // The actual byte decoded: 000000 000100 → top 8 bits = 00000000 = 0x00
    expect(n.value).toEqual(new Uint8Array([0x00]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/trailing bits|RFC 4648.*3\.5/i);
  });
  test('base64 with invalid character always throws', () => {
    expect(() => parseCDN("b64'AQ!D'")).toThrow(SyntaxError);
    expect(() => parseCDN("b64'AQ!D'", { strict: false })).toThrow(SyntaxError);
  });
  test("hex with spaces h'01 02 03'", () => {
    const n = parseCDN("h'01 02 03'") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([1, 2, 3]));
  });

  // ── h'...' comments (§2.5.5) ────────────────────────────────────────────────

  test("h'...' with / block comment /", () => {
    const n = parseCDN("h'01 /first byte/ 02'") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02]));
  });
  test("h'...' with multi-word block comment", () => {
    const n = parseCDN("h'dead /skip this/ beef'") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
  test("h'...' with # line comment", () => {
    const n = parseCDN("h'01 # first\n02'") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02]));
  });
  test("h'...' with mixed comments", () => {
    const n = parseCDN(
      "h'\n  01 /byte one/\n  02 # byte two\n'"
    ) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02]));
  });
  test("h'...' invalid character throws SyntaxError", () => {
    expect(() => parseCDN("h'0g'")).toThrow(SyntaxError);
  });

  // lblank = %x0A / %x20 only — HT forbidden (draft-25 §5.2.1)
  test("h'...' with HT (tab) throws SyntaxError", () => {
    expect(() => parseCDN("h'01\t02'")).toThrow(SyntaxError);
  });

  // ── b64'...' comments — only # line comment; / is a base64 char ─────────────

  // lblank = %x0A / %x20 only — HT forbidden (draft-25 §5.2.2)
  test("b64'...' with HT (tab) throws SyntaxError", () => {
    expect(() => parseCDN("b64'AQID\tBA=='")).toThrow(SyntaxError);
  });

  test("b64'...' with # line comment", () => {
    // AQID = [1, 2, 3], BA== = [4]
    const n = parseCDN("b64'AQID # first three\nBA=='") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  test("b64'...' / is treated as base64 character, not comment", () => {
    // '/' is a valid base64 character and must not be treated as a comment delimiter
    const n = parseCDN("b64'AQIDBA=='") as CborByteString;
    expect(n.value).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe('parseCDN — indefinite byte string', () => {
  test("(_ h'0102', h'030405')", () => {
    const n = parseCDN("(_ h'0102', h'030405')") as CborIndefiniteByteString;
    expect(n).toBeInstanceOf(CborIndefiniteByteString);
    expect(n.chunks).toHaveLength(2);
    expect(n.chunks[0].value).toEqual(new Uint8Array([0x01, 0x02]));
    expect(n.chunks[1].value).toEqual(new Uint8Array([0x03, 0x04, 0x05]));
  });
  test("''_ (empty indefinite byte string)", () => {
    const n = parseCDN("''_") as CborIndefiniteByteString;
    expect(n).toBeInstanceOf(CborIndefiniteByteString);
    expect(n.chunks).toHaveLength(0);
  });
  test('(_ ) throws — ambiguous', () => {
    expect(() => parseCDN('(_ )')).toThrow(SyntaxError);
  });
  test("(_ 'Hello', \" \", 'world') — mixed chunk types → SyntaxError", () => {
    expect(() => parseCDN("(_ 'Hello', \" \", 'world')")).toThrow(SyntaxError);
  });
});

describe('parseCDN — indefinite text string', () => {
  test('(_ "strea", "ming")', () => {
    const n = parseCDN('(_ "strea", "ming")') as CborIndefiniteTextString;
    expect(n).toBeInstanceOf(CborIndefiniteTextString);
    expect(n.chunks).toHaveLength(2);
    expect(n.chunks[0].value).toBe('strea');
    expect(n.chunks[1].value).toBe('ming');
  });
  test('""_ (empty indefinite text string)', () => {
    const n = parseCDN('""_') as CborIndefiniteTextString;
    expect(n).toBeInstanceOf(CborIndefiniteTextString);
    expect(n.chunks).toHaveLength(0);
  });
  test('(_ "Hello", h\'20\', "world") — mixed chunk types → SyntaxError', () => {
    expect(() => parseCDN('(_ "Hello", h\'20\', "world")')).toThrow(
      SyntaxError
    );
  });
});

describe('parseCDN — indefinite group: _7 alias and missing _ recovery', () => {
  test('(_7 "a", "b") strict: false warns and parses as indefinite text string', () => {
    const warnings: ParseWarning[] = [];
    const n = parseCDN('(_7 "a", "b")', {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborIndefiniteTextString;
    expect(n).toBeInstanceOf(CborIndefiniteTextString);
    expect(n.chunks).toHaveLength(2);
    expect(n.chunks[0].value).toBe('a');
    expect(n.chunks[1].value).toBe('b');
    // _7 is non-standard but valid — warns without throwing
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/_7.*non-standard/);
    // Warning is on the group node, not on a chunk
    expect(n.warnings).toHaveLength(1);
    expect(n.chunks[0].warnings).toBeUndefined();
  });

  test("(_7 h'aa', h'bb') strict: false warns and parses as indefinite byte string", () => {
    const n = parseCDN("(_7 h'aa', h'bb')", {
      strict: false,
      silent: true,
    }) as CborIndefiniteByteString;
    expect(n).toBeInstanceOf(CborIndefiniteByteString);
    expect(n.chunks[0].value).toEqual(new Uint8Array([0xaa]));
    expect(n.chunks[1].value).toEqual(new Uint8Array([0xbb]));
    expect(n.warnings).toHaveLength(1);
    expect(n.warnings![0].message).toMatch(/_7.*non-standard/);
  });

  test('(_7 "a") strict: true throws', () => {
    expect(() => parseCDN('(_7 "a")')).toThrow(SyntaxError);
  });

  test('("a", "b") strict: true throws', () => {
    expect(() => parseCDN('("a", "b")')).toThrow(SyntaxError);
  });

  test('("a", "b") strict: false warns and parses as indefinite text string', () => {
    const warnings: ParseWarning[] = [];
    const n = parseCDN('("a", "b")', {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborIndefiniteTextString;
    expect(n).toBeInstanceOf(CborIndefiniteTextString);
    expect(n.chunks).toHaveLength(2);
    expect(n.chunks[0].value).toBe('a');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/missing _/);
    expect(n.warnings).toHaveLength(1);
  });

  test("(h'aa', h'bb') strict: false warns and parses as indefinite byte string", () => {
    const warnings: ParseWarning[] = [];
    const n = parseCDN("(h'aa', h'bb')", {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborIndefiniteByteString;
    expect(n).toBeInstanceOf(CborIndefiniteByteString);
    expect(n.chunks[0].value).toEqual(new Uint8Array([0xaa]));
    expect(warnings[0].message).toMatch(/missing _/);
  });
});

// ─── Arrays ───────────────────────────────────────────────────────────────────

describe('parseCDN — arrays', () => {
  test('[]', () => {
    const n = parseCDN('[]') as CborArray;
    expect(n).toBeInstanceOf(CborArray);
    expect(n.items).toHaveLength(0);
    expect(n.indefiniteLength).toBe(false);
  });
  test('[1, 2, 3]', () => {
    const n = parseCDN('[1, 2, 3]') as CborArray;
    expect(n.items).toHaveLength(3);
    expect((n.items[0] as CborUint).value).toBe(1n);
  });
  test('[_ ]', () => {
    const n = parseCDN('[_ ]') as CborArray;
    expect(n.indefiniteLength).toBe(true);
    expect(n.items).toHaveLength(0);
  });
  test('[_ 1, 2, 3]', () => {
    const n = parseCDN('[_ 1, 2, 3]') as CborArray;
    expect(n.indefiniteLength).toBe(true);
    expect(n.items).toHaveLength(3);
  });
  test('nested [1, [2, 3]]', () => {
    const n = parseCDN('[1, [2, 3]]') as CborArray;
    expect(n.items[1]).toBeInstanceOf(CborArray);
    expect(((n.items[1] as CborArray).items[0] as CborUint).value).toBe(2n);
  });

  // ── optional commas ──────────────────────────────────────────────────────────

  test('[1 2 3] whitespace-separated (no commas)', () => {
    const n = parseCDN('[1 2 3]') as CborArray;
    expect(n.items).toHaveLength(3);
    expect((n.items[0] as CborUint).value).toBe(1n);
    expect((n.items[2] as CborUint).value).toBe(3n);
  });
  test('[1 2,3] mixed comma and no-comma', () => {
    const n = parseCDN('[1 2,3]') as CborArray;
    expect(n.items).toHaveLength(3);
  });
  test('[1,] trailing comma', () => {
    const n = parseCDN('[1,]') as CborArray;
    expect(n.items).toHaveLength(1);
  });
});

// ─── Maps ─────────────────────────────────────────────────────────────────────

describe('parseCDN — maps', () => {
  test('{}', () => {
    const n = parseCDN('{}') as CborMap;
    expect(n).toBeInstanceOf(CborMap);
    expect(n.entries).toHaveLength(0);
    expect(n.indefiniteLength).toBe(false);
  });
  test('{1: 2, 3: 4}', () => {
    const n = parseCDN('{1: 2, 3: 4}') as CborMap;
    expect(n.entries).toHaveLength(2);
    expect((n.entries[0][0] as CborUint).value).toBe(1n);
    expect((n.entries[0][1] as CborUint).value).toBe(2n);
  });
  test('{_ "a": 1}', () => {
    const n = parseCDN('{_ "a": 1}') as CborMap;
    expect(n.indefiniteLength).toBe(true);
    expect(n.entries).toHaveLength(1);
    expect((n.entries[0][0] as CborTextString).value).toBe('a');
  });
  test('{_ }', () => {
    const n = parseCDN('{_ }') as CborMap;
    expect(n.indefiniteLength).toBe(true);
    expect(n.entries).toHaveLength(0);
  });

  // ── optional commas ──────────────────────────────────────────────────────────

  test('{1: 2 3: 4} whitespace-separated (no commas)', () => {
    const n = parseCDN('{1: 2 3: 4}') as CborMap;
    expect(n.entries).toHaveLength(2);
    expect((n.entries[1][0] as CborUint).value).toBe(3n);
  });
  test('{1: 2,} trailing comma', () => {
    const n = parseCDN('{1: 2,}') as CborMap;
    expect(n.entries).toHaveLength(1);
  });
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('parseCDN — tags', () => {
  test('0("2013-03-21T20:04:00Z")', () => {
    const n = parseCDN('0("2013-03-21T20:04:00Z")') as CborTag;
    expect(n).toBeInstanceOf(CborTag);
    expect(n.tag).toBe(0n);
    expect((n.content as CborTextString).value).toBe('2013-03-21T20:04:00Z');
  });
  test('1(1363896240)', () => {
    const n = parseCDN('1(1363896240)') as CborTag;
    expect(n.tag).toBe(1n);
    expect((n.content as CborUint).value).toBe(1363896240n);
  });
  test("23(h'01020304')", () => {
    const n = parseCDN("23(h'01020304')") as CborTag;
    expect(n.tag).toBe(23n);
    expect((n.content as CborByteString).value).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
  });
  test('nested tag: 1([1, 2])', () => {
    const n = parseCDN('1([1, 2])') as CborTag;
    expect(n.tag).toBe(1n);
    expect(n.content).toBeInstanceOf(CborArray);
  });
});

// ─── Simple values ────────────────────────────────────────────────────────────

describe('parseCDN — simple values', () => {
  test('true', () => expect(parseCDN('true')).toBe(CborSimple.TRUE));
  test('false', () => expect(parseCDN('false')).toBe(CborSimple.FALSE));
  test('null', () => expect(parseCDN('null')).toBe(CborSimple.NULL));
  test('undefined', () =>
    expect(parseCDN('undefined')).toBe(CborSimple.UNDEFINED));
  test('simple(16)', () => {
    const n = parseCDN('simple(16)') as CborSimple;
    expect(n).toBeInstanceOf(CborSimple);
    expect(n.value).toBe(16);
  });
  test('simple(255)', () => {
    expect((parseCDN('simple(255)') as CborSimple).value).toBe(255);
  });
});

// ─── Whitespace tolerance ─────────────────────────────────────────────────────

describe('parseCDN — whitespace', () => {
  test('whitespace around brackets', () => {
    const n = parseCDN('  [  1 ,  2  ]  ') as CborArray;
    expect(n.items).toHaveLength(2);
  });
  test('newlines inside map', () => {
    const n = parseCDN('{\n  "a": 1,\n  "b": 2\n}') as CborMap;
    expect(n.entries).toHaveLength(2);
  });
});

// ─── Offset / trailing input ─────────────────────────────────────────────────

describe('parseCDN — offset and trailing input', () => {
  test('allowTrailing parses one item and reports source offsets', () => {
    const first = parseCDN('1 2', { allowTrailing: true }) as CborUint;
    expect(first.value).toBe(1n);
    expect(first.start).toBe(0);
    expect(first.end).toBe(1);

    const second = parseCDN('1 2', {
      offset: first.end,
      allowTrailing: true,
    }) as CborUint;
    expect(second.value).toBe(2n);
    expect(second.start).toBe(2);
    expect(second.end).toBe(3);
  });

  test('offset starts parsing from the requested character position', () => {
    const n = parseCDN('1  2', { offset: 1 }) as CborUint;
    expect(n.value).toBe(2n);
    expect(n.start).toBe(3);
    expect(n.end).toBe(4);
  });

  test('trailing tokens still throw unless allowTrailing is true', () => {
    expect(() => parseCDN('1 2', { offset: 0 })).toThrow(SyntaxError);
  });

  test('last sequence item can omit allowTrailing to catch unexpected data', () => {
    const first = parseCDN('1 2 3', { allowTrailing: true }) as CborUint;
    const last = parseCDN('1 2', { offset: first.end }) as CborUint;
    expect(last.value).toBe(2n);
    expect(last.end).toBe(3);

    expect(() => parseCDN('1 2 3', { offset: first.end })).toThrow(SyntaxError);
  });

  test('offset at end of input is EOF, while offset beyond input is out of range', () => {
    expect(() => parseCDN('1', { offset: 1 })).toThrow(SyntaxError);
    expect(() => parseCDN('1', { offset: 2 })).toThrow(RangeError);
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('parseCDN — errors', () => {
  test('empty input throws', () => {
    expect(() => parseCDN('')).toThrow(SyntaxError);
  });
  test('trailing garbage throws', () => {
    expect(() => parseCDN('1 2')).toThrow(SyntaxError);
  });
  test('unclosed array throws', () => {
    expect(() => parseCDN('[1, 2')).toThrow(SyntaxError);
  });
  test('unclosed map throws', () => {
    expect(() => parseCDN('{1: 2')).toThrow(SyntaxError);
  });
  test('invalid token throws', () => {
    expect(() => parseCDN('@')).toThrow(SyntaxError);
  });
  test('missing colon in map', () => {
    expect(() => parseCDN('{1 2}')).toThrow(SyntaxError);
  });
  test('negative tag number throws', () => {
    expect(() => parseCDN('-1(42)')).toThrow(SyntaxError);
  });
  test('h"abcd" → SyntaxError (double quotes not valid for byte prefix)', () => {
    expect(() => parseCDN('h"abcd"')).toThrow(SyntaxError);
  });
  test('b64"AQID" → SyntaxError', () => {
    expect(() => parseCDN('b64"AQID"')).toThrow(SyntaxError);
  });
  test('IP"192.0.2.42" → SyntaxError', () => {
    expect(() => parseCDN('IP"192.0.2.42"')).toThrow(SyntaxError);
  });
  test('dt"2013-03-21T20:04:00Z" → SyntaxError', () => {
    expect(() => parseCDN('dt"2013-03-21T20:04:00Z"')).toThrow(SyntaxError);
  });

  // ── #1: invalid escape sequences ────────────────────────────────────────
  test('\\q is not a valid escape sequence → SyntaxError', () => {
    expect(() => parseCDN('"\\q"')).toThrow(SyntaxError);
  });
  test('\\/ is valid in double-quoted strings', () => {
    expect((parseCDN('"\\/url"') as CborTextString).value).toBe('/url');
  });
  test('\\/ is invalid in single-quoted strings (§5.1)', () => {
    expect(() => parseCDN("'\\/url'")).toThrow(SyntaxError);
  });
  test('\\\\ (backslash) is valid in double-quoted strings', () => {
    expect((parseCDN('"a\\\\b"') as CborTextString).value).toBe('a\\b');
  });
  test('\\\\ (backslash) is valid in single-quoted strings (§5.1 escapable1)', () => {
    const v = parseCDN("'a\\\\b'") as CborByteString;
    expect(v).toBeInstanceOf(CborByteString);
    expect(new TextDecoder().decode(v.value)).toBe('a\\b');
  });
  test('\\u005C (U+005C) in single-quoted strings is a SyntaxError in strict mode', () => {
    expect(() => parseCDN("'a\\u005Cb'")).toThrow(SyntaxError);
  });
  test('\\u005C (U+005C) in single-quoted strings emits a warning in lenient mode', () => {
    const warnings: string[] = [];
    const v = parseCDN("'a\\u005Cb'", {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    }) as CborByteString;
    expect(v).toBeInstanceOf(CborByteString);
    expect(new TextDecoder().decode(v.value)).toBe('a\\b');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/\\u.*005C.*single-quoted/i);
  });
  test('\\u{5C} (U+005C) in single-quoted strings emits a warning in lenient mode', () => {
    const warnings: string[] = [];
    const v = parseCDN("'a\\u{5C}b'", {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    }) as CborByteString;
    expect(v).toBeInstanceOf(CborByteString);
    expect(new TextDecoder().decode(v.value)).toBe('a\\b');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/\\u.*005C.*single-quoted/i);
  });

  // ── #2: unescaped C0 control characters ─────────────────────────────────
  test('unescaped NUL (U+0000) in string → SyntaxError', () => {
    expect(() => parseCDN('"a\x00b"')).toThrow(SyntaxError);
  });
  test('unescaped TAB (U+0009) in string → SyntaxError', () => {
    expect(() => parseCDN('"a\x09b"')).toThrow(SyntaxError);
  });
  test('unescaped DEL (U+007F) in string → SyntaxError', () => {
    expect(() => parseCDN('"a\x7fb"')).toThrow(SyntaxError);
  });
  test('literal LF inside string is allowed', () => {
    // LF is explicitly permitted per spec
    expect((parseCDN('"a\nb"') as CborTextString).value).toBe('a\nb');
  });

  // ── #3: \\u printable ASCII in single-quoted strings ────────────────────
  test("\\u0041 ('A') in single-quoted string → SyntaxError", () => {
    expect(() => parseCDN("'\\u0041'")).toThrow(SyntaxError);
  });
  test('\\u0020 (space) in single-quoted string → SyntaxError', () => {
    expect(() => parseCDN("'\\u0020'")).toThrow(SyntaxError);
  });
  test("\\u007E ('~') in single-quoted string → SyntaxError", () => {
    expect(() => parseCDN("'\\u007e'")).toThrow(SyntaxError);
  });
  test("\\u00fc ('ü') in single-quoted string is allowed (non-printable-ASCII)", () => {
    // U+00FC is not in U+0020–U+007E, so it is valid
    const n = parseCDN("'\\u00fc'") as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new TextEncoder().encode('ü'));
  });
  test('\\u0041 in double-quoted string is allowed', () => {
    expect((parseCDN('"\\u0041"') as CborTextString).value).toBe('A');
  });

  // ── #4: non-standard JS escape sequences (strict: false) ────────────────
  describe('non-standard JS escape sequences (strict: false)', () => {
    const opts = { strict: false as const, silent: true };

    test('\\0 → U+0000, warns, strict: true throws', () => {
      expect(() => parseCDN('"\\0"')).toThrow(SyntaxError);
      const warnings: ParseWarning[] = [];
      const r = parseCDN('"\\0"', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      }) as CborTextString;
      expect(r.value).toBe('\0');
      expect(warnings[0].message).toMatch(/\\0.*non-standard/);
      expect(r.warnings).toHaveLength(1);
    });

    test('\\v → U+000B (vertical tab), warns', () => {
      expect(() => parseCDN('"\\v"')).toThrow(SyntaxError);
      const r = parseCDN('"\\v"', opts) as CborTextString;
      expect(r.value).toBe('\v');
      expect(r.warnings?.[0]?.message).toMatch(/\\v.*non-standard/);
    });

    test('\\xHH → hex character, warns', () => {
      expect(() => parseCDN('"\\x41"')).toThrow(SyntaxError);
      const r = parseCDN('"\\x41"', opts) as CborTextString;
      expect(r.value).toBe('A');
      expect(r.warnings?.[0]?.message).toMatch(/\\x41.*non-standard/);
    });

    test('\\x in single-quoted string → byte', () => {
      expect(() => parseCDN("'\\x41'")).toThrow(SyntaxError);
      // \x41 = 'A' (ASCII), UTF-8 encoding is the same single byte 0x41
      const r = parseCDN("'\\x41'", opts) as CborByteString;
      expect(r).toBeInstanceOf(CborByteString);
      expect(r.value[0]).toBe(0x41);
    });

    test('identity escape \\a → "a", warns', () => {
      expect(() => parseCDN('"\\a"')).toThrow(SyntaxError);
      const r = parseCDN('"\\a"', opts) as CborTextString;
      expect(r.value).toBe('a');
      expect(r.warnings?.[0]?.message).toMatch(/unknown escape/);
    });

    test("cross-quote \\' in double-quoted string, warns", () => {
      expect(() => parseCDN('"\\\'"')).toThrow(SyntaxError);
      const r = parseCDN('"\\\'"', opts) as CborTextString;
      expect(r.value).toBe("'");
      expect(r.warnings?.[0]?.message).toMatch(/non-standard/);
    });

    test('cross-quote \\" in single-quoted string, warns', () => {
      expect(() => parseCDN("'\\\"'")).toThrow(SyntaxError);
      const r = parseCDN("'\\\"'", opts) as CborByteString;
      expect(r).toBeInstanceOf(CborByteString);
      expect(new TextDecoder().decode(r.value)).toBe('"');
      expect(r.warnings?.[0]?.message).toMatch(/non-standard/);
    });

    test('warning is attached to the string node, not a sibling', () => {
      const r = parseCDN('[1, "\\v"]', opts) as CborArray;
      expect(r.items[0].warnings).toBeUndefined();
      expect(r.items[1].warnings).toHaveLength(1);
    });

    test('multiple escapes produce multiple warnings', () => {
      const warnings: ParseWarning[] = [];
      const r = parseCDN('"\\v\\0"', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      }) as CborTextString;
      expect(r.value).toBe('\v\0');
      expect(warnings).toHaveLength(2);
      expect(r.warnings).toHaveLength(2);
    });

    test('onWarning is called before throw in strict: true', () => {
      const warnings: ParseWarning[] = [];
      expect(() =>
        parseCDN('"\\v"', { onWarning: (w) => warnings.push(w) })
      ).toThrow(SyntaxError);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/\\v.*non-standard/);
    });

    test('line continuation \\<LF> adds nothing, warns', () => {
      expect(() => parseCDN('"a\\\nb"')).toThrow(SyntaxError);
      const r = parseCDN('"a\\\nb"', opts) as CborTextString;
      expect(r.value).toBe('ab');
      expect(r.warnings?.[0]?.message).toMatch(/line continuation/);
    });

    test('line continuation \\<CRLF> adds nothing, warns', () => {
      const r = parseCDN('"a\\\r\nb"', opts) as CborTextString;
      expect(r.value).toBe('ab');
      expect(r.warnings?.[0]?.message).toMatch(/line continuation/);
    });

    test('warning position points to the backslash, not the escape char', () => {
      // "  \v" — the backslash is at offset 3, column 4 (1-based), \v at column 5
      const warnings: ParseWarning[] = [];
      parseCDN('"  \\v"', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(warnings[0].offset).toBe(3);
      expect(warnings[0].column).toBe(4);
    });
  });
});

// ─── Encoding indicators ──────────────────────────────────────────────────────

describe('parseCDN — encoding indicators on integers', () => {
  test('1_0 → CborUint(1n, encodingWidth=0)', () => {
    const n = parseCDN('1_0') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.value).toBe(1n);
    expect(n.encodingWidth).toBe(0);
  });
  test('1_1 → CborUint(1n, encodingWidth=1) — NOT a float', () => {
    const n = parseCDN('1_1') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.value).toBe(1n);
    expect(n.encodingWidth).toBe(1);
  });
  test('1_2 → CborUint(1n, encodingWidth=2)', () => {
    const n = parseCDN('1_2') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.encodingWidth).toBe(2);
  });
  test('1_3 → CborUint(1n, encodingWidth=3)', () => {
    const n = parseCDN('1_3') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.encodingWidth).toBe(3);
  });
  test('-1_1 → CborNint(-1n, encodingWidth=1)', () => {
    const n = parseCDN('-1_1') as CborNint;
    expect(n).toBeInstanceOf(CborNint);
    expect(n.value).toBe(-1n);
    expect(n.encodingWidth).toBe(1);
  });
  test('0_0 → CborUint(0n, encodingWidth=0)', () => {
    const n = parseCDN('0_0') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.value).toBe(0n);
    expect(n.encodingWidth).toBe(0);
  });
  test('0xff_1 → CborUint(255n, encodingWidth=1)', () => {
    const n = parseCDN('0xff_1') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.value).toBe(255n);
    expect(n.encodingWidth).toBe(1);
  });
});

describe('parseCDN — encoding indicators on tags', () => {
  test('5_1(42) → CborTag(5n, CborUint(42n), encodingWidth=1)', () => {
    const n = parseCDN('5_1(42)') as CborTag;
    expect(n).toBeInstanceOf(CborTag);
    expect(n.tag).toBe(5n);
    expect(n.encodingWidth).toBe(1);
    expect((n.content as CborUint).value).toBe(42n);
  });
});

describe('parseCDN — encoding indicators on strings', () => {
  test('"A"_1 → CborTextString("A", encodingWidth=1)', () => {
    const n = parseCDN('"A"_1') as CborTextString;
    expect(n).toBeInstanceOf(CborTextString);
    expect(n.value).toBe('A');
    expect(n.encodingWidth).toBe(1);
  });
  test("h'ff'_1 → CborByteString([0xff], encodingWidth=1)", () => {
    const n = parseCDN("h'ff'_1") as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new Uint8Array([0xff]));
    expect(n.encodingWidth).toBe(1);
  });
  test('"A" + "B"_1 → CborTextString("AB", encodingWidth=1)', () => {
    const n = parseCDN('"A" + "B"_1') as CborTextString;
    expect(n).toBeInstanceOf(CborTextString);
    expect(n.value).toBe('AB');
    expect(n.encodingWidth).toBe(1);
  });
});

describe('parseCDN — encoding indicators on arrays', () => {
  test('[_0 1, 2] → CborArray, encodingWidth=0', () => {
    const n = parseCDN('[_0 1, 2]') as CborArray;
    expect(n).toBeInstanceOf(CborArray);
    expect(n.indefiniteLength).toBe(false);
    expect(n.encodingWidth).toBe(0);
    expect(n.items).toHaveLength(2);
  });
  test('[_1 ] → empty CborArray, encodingWidth=1', () => {
    const n = parseCDN('[_1 ]') as CborArray;
    expect(n.encodingWidth).toBe(1);
    expect(n.items).toHaveLength(0);
  });
});

describe('parseCDN — encoding indicators on maps', () => {
  test('{_1 "a": 1} → CborMap, encodingWidth=1', () => {
    const n = parseCDN('{_1 "a": 1}') as CborMap;
    expect(n).toBeInstanceOf(CborMap);
    expect(n.indefiniteLength).toBe(false);
    expect(n.encodingWidth).toBe(1);
    expect(n.entries).toHaveLength(1);
  });
});

describe('toCDN — encoding indicators', () => {
  test('CborUint(1n, {encodingWidth:0}) → "1_0"', () => {
    expect(toCDN(new CborUint(1n, { encodingWidth: 0 }))).toBe('1_0');
  });
  test('CborUint(1n, {encodingWidth:1}) → "1_1"', () => {
    expect(toCDN(new CborUint(1n, { encodingWidth: 1 }))).toBe('1_1');
  });
  test('CborNint(-1n, {encodingWidth:1}) → "-1_1"', () => {
    expect(toCDN(new CborNint(-1n, { encodingWidth: 1 }))).toBe('-1_1');
  });
  test('CborTag(1n, ..., {encodingWidth:1}) → "1_1(...)"', () => {
    expect(
      toCDN(new CborTag(1n, new CborUint(42n), { encodingWidth: 1 }))
    ).toBe('1_1(42)');
  });
  test('CborTextString("A", {encodingWidth:1}) → \'"A"_1\'', () => {
    expect(toCDN(new CborTextString('A', { encodingWidth: 1 }))).toBe('"A"_1');
  });
  test('CborByteString([0xff], {encodingWidth:1}) → "h\'ff\'_1"', () => {
    expect(
      toCDN(new CborByteString(new Uint8Array([0xff]), { encodingWidth: 1 }))
    ).toBe("h'ff'_1");
  });
  test('CborArray with encodingWidth=0 → "[_0 1, 2]"', () => {
    expect(
      toCDN(
        new CborArray([new CborUint(1n), new CborUint(2n)], {
          encodingWidth: 0,
        })
      )
    ).toBe('[_0 1,2]');
  });
  test('CborMap with encodingWidth=1 → \'{_1 "a": 1}\'', () => {
    expect(
      toCDN(
        new CborMap([[new CborTextString('a'), new CborUint(1n)]], {
          encodingWidth: 1,
        })
      )
    ).toBe('{_1 "a":1}');
  });
});

// ─── encodingWidth value-overflow validation ──────────────────────────────────

describe('parseCDN — _i encoding indicator (immediate / inline encoding)', () => {
  test('5_i → CborUint(5n, encodingWidth="i")', () => {
    const n = parseCDN('5_i') as CborUint;
    expect(n).toBeInstanceOf(CborUint);
    expect(n.value).toBe(5n);
    expect(n.encodingWidth).toBe('i');
  });
  test('23_i → CborUint(23n, encodingWidth="i") — boundary', () => {
    const n = parseCDN('23_i') as CborUint;
    expect(n.value).toBe(23n);
    expect(n.encodingWidth).toBe('i');
  });
  test('-1_i → CborNint(-1n, encodingWidth="i")', () => {
    const n = parseCDN('-1_i') as CborNint;
    expect(n).toBeInstanceOf(CborNint);
    expect(n.value).toBe(-1n);
    expect(n.encodingWidth).toBe('i');
  });
  test('[_i 1, 2] → CborArray with encodingWidth="i"', () => {
    const a = parseCDN('[_i 1, 2]') as CborArray;
    expect(a).toBeInstanceOf(CborArray);
    expect(a.indefiniteLength).toBe(false);
    expect(a.encodingWidth).toBe('i');
    expect(a.items).toHaveLength(2);
  });
  test('{_i "a": 1} → CborMap with encodingWidth="i"', () => {
    const m = parseCDN('{_i "a": 1}') as CborMap;
    expect(m).toBeInstanceOf(CborMap);
    expect(m.indefiniteLength).toBe(false);
    expect(m.encodingWidth).toBe('i');
  });
  test('5_i(42) → CborTag with encodingWidth="i"', () => {
    const t = parseCDN('5_i(42)') as CborTag;
    expect(t).toBeInstanceOf(CborTag);
    expect(t.tag).toBe(5n);
    expect(t.encodingWidth).toBe('i');
  });
  test('1.5_i → SyntaxError (float cannot use _i)', () => {
    expect(() => parseCDN('1.5_i')).toThrow(SyntaxError);
  });
  test('1.5_0 → SyntaxError (float cannot use _0)', () => {
    expect(() => parseCDN('1.5_0')).toThrow(SyntaxError);
  });
  test('0.0_0 → SyntaxError (float cannot use _0)', () => {
    expect(() => parseCDN('0.0_0')).toThrow(SyntaxError);
  });
});

describe('toCBOR / toCDN — _i encoding indicator round-trip', () => {
  test('CborUint(5n, _i).toCBOR() → 0x05 (inline)', () => {
    expect(toHex(new CborUint(5n, { encodingWidth: 'i' }).toCBOR())).toBe('05');
  });
  test('CborUint(23n, _i).toCBOR() → 0x17 (boundary)', () => {
    expect(toHex(new CborUint(23n, { encodingWidth: 'i' }).toCBOR())).toBe(
      '17'
    );
  });
  test('CborUint(24n, _i).toCBOR() → RangeError (24 > 23)', () => {
    expect(() => new CborUint(24n, { encodingWidth: 'i' }).toCBOR()).toThrow(
      RangeError
    );
  });
  test('CborUint(5n, _i).toCDN() → "5_i"', () => {
    expect(toCDN(new CborUint(5n, { encodingWidth: 'i' }))).toBe('5_i');
  });
  test('CborNint(-1n, _i).toCDN() → "-1_i"', () => {
    expect(toCDN(new CborNint(-1n, { encodingWidth: 'i' }))).toBe('-1_i');
  });
  test('CborArray(2 items, _i).toCBOR() → 0x82 ... (inline length)', () => {
    const a = new CborArray([new CborUint(1n), new CborUint(2n)], {
      encodingWidth: 'i',
    });
    expect(toHex(a.toCBOR())).toBe('820102');
  });
  test('CborArray(24 items, _i).toCBOR() → RangeError (24 > 23)', () => {
    const items = Array.from({ length: 24 }, () => new CborUint(0n));
    expect(() => new CborArray(items, { encodingWidth: 'i' }).toCBOR()).toThrow(
      RangeError
    );
  });
  test('parse(toCDN(ast)) round-trip preserves _i on array', () => {
    const ast = new CborArray([new CborUint(1n), new CborUint(2n)], {
      encodingWidth: 'i',
    });
    const reparsed = parseCDN(toCDN(ast)) as CborArray;
    expect(reparsed.encodingWidth).toBe('i');
    expect(toHex(reparsed.toCBOR())).toBe(toHex(ast.toCBOR()));
  });
});

describe('writeHead — encodingWidth overflow raises RangeError', () => {
  // Integers
  test('CborUint(256n, _0) → RangeError (256 > 0xFF)', () => {
    expect(() => new CborUint(256n, { encodingWidth: 0 }).toCBOR()).toThrow(
      RangeError
    );
  });
  test('CborUint(65536n, _1) → RangeError (65536 > 0xFFFF)', () => {
    expect(() => new CborUint(65536n, { encodingWidth: 1 }).toCBOR()).toThrow(
      RangeError
    );
  });
  test('CborUint(0x1_0000_0000n, _2) → RangeError (> 0xFFFFFFFF)', () => {
    expect(() =>
      new CborUint(0x1_0000_0000n, { encodingWidth: 2 }).toCBOR()
    ).toThrow(RangeError);
  });
  test('CborNint(-256n, _0) via argument=255 → fits in _0 (no error)', () => {
    // argument = -1 - (-256) = 255, which fits in 1 byte
    expect(() =>
      new CborNint(-256n, { encodingWidth: 0 }).toCBOR()
    ).not.toThrow();
  });
  test('CborNint(-257n, _0) via argument=256 → RangeError (256 > 0xFF)', () => {
    // argument = -1 - (-257) = 256, which does not fit in 1 byte
    expect(() => new CborNint(-257n, { encodingWidth: 0 }).toCBOR()).toThrow(
      RangeError
    );
  });

  // Boundary: values that exactly fit should not throw
  test('CborUint(255n, _0) → no error (boundary)', () => {
    expect(() =>
      new CborUint(255n, { encodingWidth: 0 }).toCBOR()
    ).not.toThrow();
  });
  test('CborUint(65535n, _1) → no error (boundary)', () => {
    expect(() =>
      new CborUint(65535n, { encodingWidth: 1 }).toCBOR()
    ).not.toThrow();
  });

  // Small values with explicit wider encoding are valid (non-canonical but correct)
  test('CborUint(0n, _0) → no error (non-canonical but valid CBOR)', () => {
    expect(() => new CborUint(0n, { encodingWidth: 0 }).toCBOR()).not.toThrow();
  });

  // Byte/text strings: the length must fit in the specified width
  test('CborByteString(256 bytes, _0) → RangeError (length 256 > 0xFF)', () => {
    const bytes = new Uint8Array(256);
    expect(() =>
      new CborByteString(bytes, { encodingWidth: 0 }).toCBOR()
    ).toThrow(RangeError);
  });
  test('CborTextString(256 chars, _0) → RangeError (UTF-8 length > 0xFF)', () => {
    const s = 'a'.repeat(256);
    expect(() => new CborTextString(s, { encodingWidth: 0 }).toCBOR()).toThrow(
      RangeError
    );
  });

  // Arrays and maps: the item/entry count must fit
  test('CborArray(256 items, _0) → RangeError (count 256 > 0xFF)', () => {
    const items = Array.from({ length: 256 }, () => new CborUint(0n));
    expect(() => new CborArray(items, { encodingWidth: 0 }).toCBOR()).toThrow(
      RangeError
    );
  });
  test('CborMap(256 entries, _0) → RangeError (count 256 > 0xFF)', () => {
    const entries = Array.from(
      { length: 256 },
      (_, i): [CborUint, CborUint] => [
        new CborUint(BigInt(i)),
        new CborUint(0n),
      ]
    );
    expect(() => new CborMap(entries, { encodingWidth: 0 }).toCBOR()).toThrow(
      RangeError
    );
  });

  // Tags: the tag number must fit
  test('CborTag(256n, ..., _0) → RangeError (tag 256 > 0xFF)', () => {
    expect(() =>
      new CborTag(256n, new CborSimple(22), { encodingWidth: 0 }).toCBOR()
    ).toThrow(RangeError);
  });
});

describe('toCBOR — encoding indicator forces non-shortest header', () => {
  function toHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  test('CborUint(1n, encodingWidth=0) → 0x18 0x01', () => {
    expect(toHex(new CborUint(1n, { encodingWidth: 0 }).toCBOR())).toBe('1801');
  });
  test('CborUint(1n, encodingWidth=1) → 0x19 0x00 0x01', () => {
    expect(toHex(new CborUint(1n, { encodingWidth: 1 }).toCBOR())).toBe(
      '190001'
    );
  });
  test('CborUint(1n, encodingWidth=2) → 0x1a 0x00 0x00 0x00 0x01', () => {
    expect(toHex(new CborUint(1n, { encodingWidth: 2 }).toCBOR())).toBe(
      '1a00000001'
    );
  });
  test('CborUint(1n, encodingWidth=3) → 0x1b … 0x01', () => {
    expect(toHex(new CborUint(1n, { encodingWidth: 3 }).toCBOR())).toBe(
      '1b0000000000000001'
    );
  });
  test('CborNint(-1n, encodingWidth=0) → 0x38 0x00', () => {
    expect(toHex(new CborNint(-1n, { encodingWidth: 0 }).toCBOR())).toBe(
      '3800'
    );
  });
  test('CborArray([], encodingWidth=0) → 0x98 0x00', () => {
    expect(toHex(new CborArray([], { encodingWidth: 0 }).toCBOR())).toBe(
      '9800'
    );
  });
  test('CborMap([], encodingWidth=1) → 0xb9 0x00 0x00', () => {
    expect(toHex(new CborMap([], { encodingWidth: 1 }).toCBOR())).toBe(
      'b90000'
    );
  });
});

// ─── Round-trip: parse(serialize(ast)).toCBOR() === ast.toCBOR() ──────────────

describe('round-trip: parse(toCDN(node)).toCBOR() === node.toCBOR()', () => {
  function rt(node: ReturnType<typeof parseCDN>): void {
    const edn = toCDN(node);
    const reparsed = parseCDN(edn);
    expect(toHex(reparsed.toCBOR())).toBe(toHex(node.toCBOR()));
  }

  test('CborUint(42)', () => rt(new CborUint(42n)));
  test('CborNint(-5)', () => rt(new CborNint(-5n)));
  test('CborFloat(1.5)', () => rt(new CborFloat(1.5)));
  test('CborFloat(1.0, precision=single)', () =>
    rt(new CborFloat(1.0, { precision: 'single' })));
  test('CborFloat(NaN)', () => rt(new CborFloat(NaN)));
  test('CborFloat(-Infinity)', () => rt(new CborFloat(-Infinity)));
  test('CborFloat(-0.0)', () => rt(new CborFloat(-0.0)));
  test('CborTextString("hello")', () => rt(new CborTextString('hello')));
  test('CborTextString with escapes', () => rt(new CborTextString('a\nb\tc')));
  test('CborByteString([1,2,3])', () =>
    rt(new CborByteString(new Uint8Array([1, 2, 3]))));
  test('CborByteString(empty)', () => rt(new CborByteString(new Uint8Array())));
  test('CborIndefiniteByteString', () =>
    rt(
      new CborIndefiniteByteString([
        new CborByteString(new Uint8Array([1, 2])),
        new CborByteString(new Uint8Array([3, 4])),
      ])
    ));
  test('CborIndefiniteByteString empty', () =>
    rt(new CborIndefiniteByteString([])));
  test('CborIndefiniteTextString', () =>
    rt(
      new CborIndefiniteTextString([
        new CborTextString('strea'),
        new CborTextString('ming'),
      ])
    ));
  test('CborIndefiniteTextString empty', () =>
    rt(new CborIndefiniteTextString([])));
  test('CborArray([1,2,3])', () =>
    rt(new CborArray([new CborUint(1n), new CborUint(2n), new CborUint(3n)])));
  test('CborArray indefinite', () =>
    rt(
      new CborArray([new CborUint(1n), new CborUint(2n)], {
        indefiniteLength: true,
      })
    ));
  test('CborMap string keys', () =>
    rt(
      new CborMap([
        [new CborTextString('a'), new CborUint(1n)],
        [new CborTextString('b'), new CborUint(2n)],
      ])
    ));
  test('CborMap integer keys', () =>
    rt(
      new CborMap([
        [new CborUint(1n), new CborUint(2n)],
        [new CborUint(3n), new CborUint(4n)],
      ])
    ));
  test('CborMap indefinite', () =>
    rt(
      new CborMap([[new CborTextString('x'), new CborUint(1n)]], {
        indefiniteLength: true,
      })
    ));
  test('CborTag(0, text)', () =>
    rt(new CborTag(0n, new CborTextString('2013-03-21T20:04:00Z'))));
  test('CborSimple.TRUE', () => rt(CborSimple.TRUE));
  test('CborSimple.NULL', () => rt(CborSimple.NULL));
  test('CborSimple(16)', () => rt(new CborSimple(16)));
  test('nested [1, {2: "x"}]', () =>
    rt(
      new CborArray([
        new CborUint(1n),
        new CborMap([[new CborUint(2n), new CborTextString('x')]]),
      ])
    ));
  test('CborUint(1n, encodingWidth=0)', () =>
    rt(new CborUint(1n, { encodingWidth: 0 })));
  test('CborUint(1n, encodingWidth=1)', () =>
    rt(new CborUint(1n, { encodingWidth: 1 })));
  test('CborNint(-1n, encodingWidth=1)', () =>
    rt(new CborNint(-1n, { encodingWidth: 1 })));
  test('CborTag(5n, content, encodingWidth=1)', () =>
    rt(new CborTag(5n, new CborUint(42n), { encodingWidth: 1 })));
  test('CborTextString("A", encodingWidth=1)', () =>
    rt(new CborTextString('A', { encodingWidth: 1 })));
  test('CborByteString([0xff], encodingWidth=1)', () =>
    rt(new CborByteString(new Uint8Array([0xff]), { encodingWidth: 1 })));
  test('CborArray([1,2], encodingWidth=0)', () =>
    rt(
      new CborArray([new CborUint(1n), new CborUint(2n)], { encodingWidth: 0 })
    ));
  test('CborMap([["a",1]], encodingWidth=1)', () =>
    rt(
      new CborMap([[new CborTextString('a'), new CborUint(1n)]], {
        encodingWidth: 1,
      })
    ));
  test('multi-line EDN round-trips', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborUint(2n),
      new CborUint(3n),
    ]);
    const edn = toCDN(node, { indent: 2 });
    const reparsed = parseCDN(edn);
    expect(toHex(reparsed.toCBOR())).toBe(toHex(node.toCBOR()));
  });
});

// ─── Comments ─────────────────────────────────────────────────────────────────

describe('parseCDN — CDN comments (always enabled)', () => {
  test('# line comment before value', () => {
    const n = parseCDN('# comment\n42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('# line comment after value is ignored', () => {
    const n = parseCDN('42 # comment') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('# comment inside array', () => {
    const a = parseCDN('[1, # one\n2]') as CborArray;
    expect(a.items).toHaveLength(2);
  });
  test('/ block comment / before value', () => {
    const n = parseCDN('/this is a comment/42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('/ block comment / between array items', () => {
    const a = parseCDN('[1, /comment/ 2]') as CborArray;
    expect(a.items).toHaveLength(2);
  });
  test('/ block comment / spanning lines', () => {
    const n = parseCDN('/line1\nline2/42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('unterminated / comment throws SyntaxError', () => {
    expect(() => parseCDN('/unterminated 42')).toThrow(SyntaxError);
  });
  test('multiple comments and whitespace', () => {
    const n = parseCDN('# first\n/second/ 99 # trailing') as CborUint;
    expect(n.value).toBe(99n);
  });
});

describe('parseCDN — comments (§2.2)', () => {
  test('// line comment before value', () => {
    const n = parseCDN('// comment\n42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('// line comment after value', () => {
    const n = parseCDN('42 // comment') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('/* block comment */ before value', () => {
    const n = parseCDN('/* comment */42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('/* block comment */ spanning lines', () => {
    const n = parseCDN('/* line1\nline2 */42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('/* block comment */ inside array', () => {
    const a = parseCDN('[1, /* comment */ 2]') as CborArray;
    expect(a.items).toHaveLength(2);
  });
  test('/* block comment */ with slash in content', () => {
    const n = parseCDN('/* HMAC 256/64 */42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('unterminated /* comment throws SyntaxError', () => {
    expect(() => parseCDN('/* unterminated 42')).toThrow(SyntaxError);
  });
  test('# comment still works', () => {
    const n = parseCDN('# edn comment\n42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('/ ... / block comment still works', () => {
    const n = parseCDN('/edn block/42') as CborUint;
    expect(n.value).toBe(42n);
  });
  test('mixed: // and /.../ and # in same input', () => {
    const a = parseCDN(
      `[
        // line comment
        1,
        /* block comment */ 2,
        # EDN line comment
        /EDN block/ 3
      ]`
    ) as CborArray;
    expect(a.items).toHaveLength(3);
  });

  // Comments inside h'...' byte string literals
  test("h'...' with // comment", () => {
    const b = parseCDN("h'dead // skip\nbeef'") as CborByteString;
    expect(b.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
  test("h'...' with /* */ comment containing slash", () => {
    const b = parseCDN("h'de /* algo 1/2 */ ad beef'") as CborByteString;
    expect(b.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  // b64'...' supports only # comments (/ is a valid B64DIGIT so // is ambiguous)
  test("b64'...' with # comment", () => {
    const b = parseCDN("b64'3q2+7w== # deadbeef in base64'") as CborByteString;
    expect(b.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
  test("b64'//8=' parses // as base64 chars, not a comment", () => {
    // 0xFF 0xFF encodes to //8= in standard base64
    const b = parseCDN("b64'//8='") as CborByteString;
    expect(b.value).toEqual(new Uint8Array([0xff, 0xff]));
  });

  // Comments inside b32'...' byte string literals (AAAAAAAA = 5 zero bytes)
  test("b32'...' with // comment", () => {
    const b = parseCDN("b32'AA // skip\nAAAAAA'", {
      extensions: [b32],
    }) as CborByteString;
    expect(b.value).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]));
  });
  test("b32'...' with /* */ comment", () => {
    const b = parseCDN("b32'AAAA /* skip */ AAAA'", {
      extensions: [b32],
    }) as CborByteString;
    expect(b.value).toEqual(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]));
  });
});

describe('parseCDN — embedded CBOR sequence (§2.5.6)', () => {
  test('<<>> — empty sequence', () => {
    const n = parseCDN('<<>>') as CborEmbeddedCBOR;
    expect(n).toBeInstanceOf(CborEmbeddedCBOR);
    expect(n.items).toHaveLength(0);
    expect(n.toCBOR()).toEqual(new Uint8Array([0x40])); // h''
  });

  test('<<1>> — single item', () => {
    const n = parseCDN('<<1>>') as CborEmbeddedCBOR;
    expect(n).toBeInstanceOf(CborEmbeddedCBOR);
    expect(n.toCBOR()).toEqual(new Uint8Array([0x41, 0x01])); // h'01'
  });

  test('<<1, 2>>', () => {
    const n = parseCDN('<<1, 2>>') as CborEmbeddedCBOR;
    expect(n.toCBOR()).toEqual(new Uint8Array([0x42, 0x01, 0x02])); // h'0102'
  });

  test('<<"hello", null>>', () => {
    // "hello" = 65 68656c6c6f, null/f6 — byte string wrapping both
    const n = parseCDN('<<"hello", null>>') as CborEmbeddedCBOR;
    expect(n.toCBOR()).toEqual(
      new Uint8Array([0x47, 0x65, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xf6])
    );
  });

  test('toJS() returns Uint8Array of content bytes', () => {
    const n = parseCDN('<<1, 2>>') as CborEmbeddedCBOR;
    expect(n.toJS()).toEqual(new Uint8Array([0x01, 0x02]));
  });

  test('toCDN() round-trips as <<...>>', () => {
    const n = parseCDN('<<1, 2>>') as CborEmbeddedCBOR;
    expect(n.toCDN()).toBe('<<1,2>>');
  });

  test('toCDN() empty', () => {
    expect(parseCDN('<<>>').toCDN()).toBe('<<>>');
  });

  test('nested: <<1, <<2>>>>', () => {
    const n = parseCDN('<<1, <<2>>>>') as CborEmbeddedCBOR;
    expect(n).toBeInstanceOf(CborEmbeddedCBOR);
    expect(n.items[1]).toBeInstanceOf(CborEmbeddedCBOR);
  });

  test('trailing comma allowed', () => {
    const n = parseCDN('<<1, 2,>>') as CborEmbeddedCBOR;
    expect(n.items).toHaveLength(2);
  });
});

describe('parseCDN — base32 / base32hex byte strings', () => {
  // b32'...' — RFC 4648 §6 alphabet: A-Z 2-7
  test("b32'AEBAGBA' decodes correctly", () => {
    // AEBAGBA = [0x01, 0x02, 0x03, 0x04]
    const n = parseCDN("b32'AEBAGBA'", { extensions: [b32] }) as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    expect(n.ednEncoding).toBe('base32');
  });
  test('b32 round-trips via toCDN', () => {
    const n = parseCDN("b32'AEBAGBA'", { extensions: [b32] });
    expect(n.toCDN()).toBe("b32'AEBAGBA'");
  });
  test("b32'GE======' (padded) is accepted", () => {
    // GE====== = [0x31]
    const n = parseCDN("b32'GE======'", {
      extensions: [b32],
    }) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x31]));
  });
  test('b32 strips long optional padding without regex backtracking', () => {
    const n = parseCDN(`b32'GE${'='.repeat(4096)}'`, {
      extensions: [b32],
    }) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x31]));
  });
  test('b32 accepts lowercase', () => {
    const n = parseCDN("b32'aebagba'", { extensions: [b32] }) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
  });
  test('b32 accepts whitespace and # comment', () => {
    const n = parseCDN("b32'AEBA # first two bytes\nGBA'", {
      extensions: [b32],
    }) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
  });
  test('b32 accepts /.../ block comment', () => {
    const n = parseCDN("b32'AEBA /mid/ GBA'", {
      extensions: [b32],
    }) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
  });
  test('b32 invalid character throws SyntaxError', () => {
    expect(() => parseCDN("b32'1!'", { extensions: [b32] })).toThrow(
      SyntaxError
    );
  });
  // RFC 4648: invalid unpadded lengths (mod 8 ∈ {1, 3, 6})
  test("b32'A' (length 1 mod 8) throws SyntaxError", () => {
    expect(() => parseCDN("b32'A'", { extensions: [b32] })).toThrow(
      SyntaxError
    );
  });
  test("b32'AAA' (length 3 mod 8) throws SyntaxError", () => {
    expect(() => parseCDN("b32'AAA'", { extensions: [b32] })).toThrow(
      SyntaxError
    );
  });
  test("b32'AAAAAA' (length 6 mod 8) throws SyntaxError", () => {
    expect(() => parseCDN("b32'AAAAAA'", { extensions: [b32] })).toThrow(
      SyntaxError
    );
  });
  // RFC 4648 §3.5: non-zero trailing bits must be rejected
  test("b32'AB' non-zero trailing bits throws SyntaxError", () => {
    // A=0, B=1 → 00000 00001 → 1 byte (8 bits) + 2 trailing bits = 01 (non-zero)
    expect(() => parseCDN("b32'AB'", { extensions: [b32] })).toThrow(
      SyntaxError
    );
  });
  test("b32'AA' zero trailing bits is valid (0x00)", () => {
    // A=0, A=0 → 00000 00000 → 1 byte = 0x00, trailing 2 bits = 00 (zero)
    const n = parseCDN("b32'AA'", { extensions: [b32] }) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x00]));
  });

  // h32'...' — RFC 4648 §7 alphabet: 0-9 A-V
  test("h32'04106' decodes correctly", () => {
    // 04106 in base32hex = [0x01, 0x02, 0x03]
    const n = parseCDN("h32'04106'", { extensions: [h32] }) as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    expect(n.ednEncoding).toBe('base32hex');
  });
  test('h32 round-trips via toCDN', () => {
    const n = parseCDN("h32'04106'", { extensions: [h32] });
    expect(n.toCDN()).toBe("h32'04106'");
  });
  test('h32 invalid character throws SyntaxError', () => {
    expect(() => parseCDN("h32'ZZ'", { extensions: [h32] })).toThrow(
      SyntaxError
    );
  });

  // Unterminated block comments must throw (regression guard: previously caught by tokenizer)
  test("b32'AE /* unterminated' throws SyntaxError", () => {
    expect(() =>
      parseCDN("b32'AE /* unterminated'", { extensions: [b32] })
    ).toThrow(SyntaxError);
  });
  test("b32'AE /unterminated' throws SyntaxError", () => {
    expect(() =>
      parseCDN("b32'AE /unterminated'", { extensions: [b32] })
    ).toThrow(SyntaxError);
  });
  test('b32` AE /* unterminated` throws SyntaxError', () => {
    expect(() =>
      parseCDN('b32`AE /* unterminated`', { extensions: [b32] })
    ).toThrow(SyntaxError);
  });
  test('b32` AE /unterminated` throws SyntaxError', () => {
    expect(() =>
      parseCDN('b32`AE /unterminated`', { extensions: [b32] })
    ).toThrow(SyntaxError);
  });
});

// ─── app-rstring: prefix + backtick raw string (§2.5.3 / app-rstring) ──────────

describe('parseCDN — app-rstring (prefix + backtick)', () => {
  test('h`0102` → CborByteString [0x01, 0x02]', () => {
    const n = parseCDN('h`0102`') as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02]));
  });

  test('h`01 02 03` with whitespace', () => {
    const n = parseCDN('h`01 02 03`') as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
  });

  test('b64`AQID` → CborByteString [0x01, 0x02, 0x03]', () => {
    const n = parseCDN('b64`AQID`') as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
  });

  test('IP`192.0.2.42` → app-string extension picks it up', () => {
    const n = parseCDN('IP`192.0.2.42`');
    // IP extension handles this — same result as IP'192.0.2.42'
    const expected = parseCDN("IP'192.0.2.42'");
    expect(n.toCDN()).toBe(expected.toCDN());
  });

  test('dt`2013-03-21T20:04:00Z` → same as dt app-string', () => {
    const n = parseCDN('dt`2013-03-21T20:04:00Z`');
    const expected = parseCDN("dt'2013-03-21T20:04:00Z'");
    expect(n.toCDN()).toBe(expected.toCDN());
  });

  test('multi-backtick delimiter for app-rstring', () => {
    // h``0102`` - double backtick delimiter
    const n = parseCDN('h``0102``') as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02]));
  });

  // ── §5.3.3: h`` with block comments and ellipsis ──────────────────────────

  test('h`` with / block comment / (§5.3.3)', () => {
    const n = parseCDN('h`01 /first byte/ 02`') as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02]));
  });

  test('h`` with multi-word block comment', () => {
    const n = parseCDN('h`dead /skip this/ beef`') as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test('h`` with # line comment (§5.3.3)', () => {
    const n = parseCDN('h`01 # first byte\n02`') as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0x01, 0x02]));
  });

  test('h`` with trailing # comment before closing delimiter (§5.3.3)', () => {
    const n = parseCDN('h`\n  deadbeef\n  # the bytes\n`') as CborByteString;
    expect(n.value).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test('h`` with ellipsis produces CborEllipsis (§5.3.3)', () => {
    const n = parseCDN('h`01...ff`');
    expect(n).toBeInstanceOf(CborEllipsis);
  });

  test('h`` ellipsis with surrounding comments', () => {
    const n = parseCDN('h`\n  01 /start/\n  ... # elided\n  ff\n`');
    expect(n).toBeInstanceOf(CborEllipsis);
  });

  // ── §5.3.4: b64`` with # line comments ───────────────────────────────────

  test('b64`` with # line comment (§5.3.4)', () => {
    const n = parseCDN('b64`AQID # first three\nBA==`') as CborByteString;
    expect(n.value).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test('b64`` with trailing # comment before closing delimiter', () => {
    const n = parseCDN(
      'b64`\n  AQIDBA==\n  # these are the bytes [1,2,3,4]\n`'
    ) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test('b64`` multiline with # comments between chunks', () => {
    const n = parseCDN(
      'b64`\n  AQID # first three bytes\n  BA== # fourth byte\n`'
    ) as CborByteString;
    expect(n.value).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  // ── b32`` and h32`` support same comment grammar as quoted b32''/h32'' ────

  test("b32`` with / block comment / (same as b32'')", () => {
    // AEBA = [0x01, 0x02] in base32
    const quoted = parseCDN("b32'AEBA'", {
      extensions: [b32],
    }) as CborByteString;
    const raw = parseCDN('b32`AEBA`', { extensions: [b32] }) as CborByteString;
    expect(raw.value).toEqual(quoted.value);
  });

  test('b32`` with / block comment / does not regress', () => {
    const n = parseCDN('b32`AE /skip/ BA`', {
      extensions: [b32],
    }) as CborByteString;
    const expected = parseCDN("b32'AEBA'", {
      extensions: [b32],
    }) as CborByteString;
    expect(n.value).toEqual(expected.value);
  });

  test('h32`` with # line comment', () => {
    // "00" in base32hex encodes a single zero byte
    const n = parseCDN('h32`00 # comment\n`', {
      extensions: [h32],
    }) as CborByteString;
    expect(n).toBeInstanceOf(CborByteString);
    expect(n.value).toEqual(new Uint8Array([0x00]));
  });
});

describe('parseCDN — pluggable app-string extensions', () => {
  test("user-defined extension: myext'hello' → CborTextString", () => {
    const result = parseCDN("myext'hello'", {
      extensions: [
        {
          appStringPrefixes: ['myext'],
          parseAppString: (_p, s) => new CborTextString(s + '!'),
        },
      ],
    });
    expect(result).toBeInstanceOf(CborTextString);
    expect((result as CborTextString).value).toBe('hello!');
  });

  test('user extension overrides built-in dt', () => {
    const result = parseCDN("dt'custom'", {
      extensions: [
        {
          appStringPrefixes: ['dt'],
          parseAppString: (_p, s) => new CborTextString(s),
        },
      ],
    });
    expect(result).toBeInstanceOf(CborTextString);
    expect((result as CborTextString).value).toBe('custom');
  });

  test('unknown extension produces CPA999 stand-in by default', () => {
    expect(parseCDN("unknown'hello'")).toBeInstanceOf(CborUnresolvedAppExt);
  });

  test('CborUnresolvedAppExt.toCDN() escapes single quotes in content', () => {
    // foo`it's a test` → round-trips as foo'it\'s a test'
    const n = parseCDN("foo`it's a test`");
    expect(n.toCDN()).toBe("foo'it\\'s a test'");
  });

  test('CborUnresolvedAppExt.toCDN() escapes backslash in content', () => {
    const n = parseCDN('foo`path\\to\\file`');
    expect(n.toCDN()).toBe("foo'path\\\\to\\\\file'");
  });

  test("unknown extension throws SyntaxError with unresolvedExtension: 'error'", () => {
    expect(() =>
      parseCDN("unknown'hello'", { unresolvedExtension: 'error' })
    ).toThrow(SyntaxError);
  });

  test('user extension with <<...>> form via parseAppSequence', () => {
    const result = parseCDN('myext<<42, "hello">>', {
      extensions: [
        {
          appStringPrefixes: ['myext'],
          parseAppString: (_p, s) => new CborTextString(s),
          parseAppSequence: (_p, items) => new CborArray(items),
        },
      ],
    });
    expect(result).toBeInstanceOf(CborArray);
    expect((result as CborArray).items).toHaveLength(2);
  });

  test('extension without parseAppSequence rejects <<...>> form', () => {
    expect(() =>
      parseCDN('noSeq<<"hello">>', {
        extensions: [
          {
            appStringPrefixes: ['noSeq'],
            parseAppString: (_p, s) => new CborTextString(s),
          },
        ],
      })
    ).toThrow(SyntaxError);
  });

  test("hyphenated prefix: my-ext'hello'", () => {
    const result = parseCDN("my-ext'hello'", {
      extensions: [
        {
          appStringPrefixes: ['my-ext'],
          parseAppString: (_p, s) => new CborTextString(s),
        },
      ],
    });
    expect(result).toBeInstanceOf(CborTextString);
    expect((result as CborTextString).value).toBe('hello');
  });

  test("uppercase prefix: MY'hello'", () => {
    const result = parseCDN("MY'hello'", {
      extensions: [
        {
          appStringPrefixes: ['MY'],
          parseAppString: (_p, s) => new CborTextString(s),
        },
      ],
    });
    expect(result).toBeInstanceOf(CborTextString);
    expect((result as CborTextString).value).toBe('hello');
  });

  test("mixed-case prefix fOO'...' is rejected as unknown identifier", () => {
    expect(() => parseCDN("fOO'hello'")).toThrow(SyntaxError);
  });

  test("underscore prefix my_ext'...' is rejected as unknown identifier", () => {
    expect(() => parseCDN("my_ext'hello'")).toThrow(SyntaxError);
  });

  describe('lenient mode: extension parse errors fall back to CborUnresolvedAppExt', () => {
    test("strict: true — invalid dt'...' throws", () => {
      expect(() => parseCDN("dt'not-a-date'")).toThrow(SyntaxError);
    });

    test("strict: false — invalid dt'...' returns CborUnresolvedAppExt + exactly one warning", () => {
      const warnings: string[] = [];
      const result = parseCDN("dt'not-a-date'", {
        strict: false,
        onWarning: (w) => warnings.push(w.message),
      });
      expect(result).toBeInstanceOf(CborUnresolvedAppExt);
      // toCDN() round-trips back to the original app-string form
      expect(result.toCDN()).toBe("dt'not-a-date'");
      // dt.ts calls onError() then falls through to a direct throw — only one warning expected
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/not-a-date/);
    });

    test('strict: false — extension that throws without calling onError falls back', () => {
      const warnings: string[] = [];
      const result = parseCDN("boom'hello'", {
        strict: false,
        onWarning: (w) => warnings.push(w.message),
        extensions: [
          {
            appStringPrefixes: ['boom'],
            parseAppString: () => {
              throw new SyntaxError('boom extension failed');
            },
          },
        ],
      });
      expect(result).toBeInstanceOf(CborUnresolvedAppExt);
      expect(result.toCDN()).toBe("boom'hello'");
      expect(warnings.some((w) => w.includes('boom extension failed'))).toBe(
        true
      );
    });

    test('strict: false — parseAppSequence failure falls back to CborUnresolvedAppExt', () => {
      const warnings: string[] = [];
      const result = parseCDN('boom<<1, 2>>', {
        strict: false,
        onWarning: (w) => warnings.push(w.message),
        extensions: [
          {
            appStringPrefixes: ['boom'],
            parseAppString: (_p, s) => new CborTextString(s),
            parseAppSequence: () => {
              throw new SyntaxError('boom sequence failed');
            },
          },
        ],
      });
      expect(result).toBeInstanceOf(CborUnresolvedAppExt);
      expect(result.toCDN()).toBe('boom<<1, 2>>');
      expect(warnings.some((w) => w.includes('boom sequence failed'))).toBe(
        true
      );
    });
  });
});

describe('parseCDN — missing-extension hints', () => {
  test.each([
    ["hash'sha-256:0011'", 'hash', 'hash', '@cbortech/hash-extension'],
    [
      "uuid'550e8400-e29b-41d4-a716-446655440000'",
      'uuid',
      'uuid',
      '@cbortech/uuid-extension',
    ],
    [
      "UUID'550e8400-e29b-41d4-a716-446655440000'",
      'UUID',
      'uuid',
      '@cbortech/uuid-extension',
    ],
    ["b32'AEBAGBA'", 'b32', 'b32', '@cbortech/cbor'],
    ["h32'00P00'", 'h32', 'h32', '@cbortech/cbor'],
    ["float'7e00'", 'float', 'float', '@cbortech/cbor'],
    ['same<<42, 42>>', 'same', 'same', '@cbortech/cbor'],
  ])('%s hints to enable the %s extension', (text, prefix, name, pkg) => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = parseCDN(text);
      expect(result).toBeInstanceOf(CborUnresolvedAppExt);
      expect(spy).toHaveBeenCalledTimes(1);
      const msg = spy.mock.calls[0]![0] as string;
      expect(msg).toContain(`'${prefix}'`);
      expect(msg).toContain(pkg);
      expect(msg).toContain(`extensions: [${name}]`);
    } finally {
      spy.mockRestore();
    }
  });

  test('silent: true suppresses the hint', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = parseCDN("hash'sha-256:0011'", { silent: true });
      expect(result).toBeInstanceOf(CborUnresolvedAppExt);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('onWarning receives the hint instead of console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const warnings: ParseWarning[] = [];
      parseCDN("uuid'550e8400-e29b-41d4-a716-446655440000'", {
        onWarning: (w) => warnings.push(w),
      });
      expect(spy).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain('@cbortech/uuid-extension');
      expect(warnings[0]!.line).toBe(1);
      expect(warnings[0]!.column).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('no hint when the extension is registered', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      parseCDN("b32'AEBAGBA'", { extensions: [b32] });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('no hint for prefixes without a known extension', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseCDN("unknown'hello'")).toBeInstanceOf(CborUnresolvedAppExt);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('hint is emitted once per prefix per parse', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      parseCDN("[float'7e00', float'7e00', b32'AEBAGBA']");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("hint precedes the error with unresolvedExtension: 'error'", () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() =>
        parseCDN("hash'sha-256:0011'", { unresolvedExtension: 'error' })
      ).toThrow(SyntaxError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('strict mode', () => {
  describe('float encoding indicator _0 / _i', () => {
    test('strict: true (default) throws on _0', () => {
      expect(() => parseCDN('1.0_0')).toThrow(SyntaxError);
    });

    test('strict: true (default) throws on _i', () => {
      expect(() => parseCDN('1.5_i')).toThrow(SyntaxError);
    });

    test('strict: false warns and returns float for _0', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('1.0_0', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborFloat);
      expect((result as CborFloat).value).toBe(1.0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/_0 and _i/);
    });

    test('strict: false warns and returns float for _i', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('1.5_i', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborFloat);
      expect((result as CborFloat).value).toBe(1.5);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/_0 and _i/);
    });

    test('strict: false warning carries line and column', () => {
      const warnings: ParseWarning[] = [];
      parseCDN('1.0_0', { strict: false, onWarning: (w) => warnings.push(w) });
      expect(warnings[0].line).toBe(1);
      expect(warnings[0].column).toBeGreaterThanOrEqual(1);
    });
  });

  describe('base32 non-zero trailing bits', () => {
    // b32'AB' → 10 bits (0b0000000001), first byte 0x00, trailing bit = 1 (non-zero).
    test('strict: true (default) throws', () => {
      expect(() => parseCDN("b32'AB'", { extensions: [b32] })).toThrow(
        SyntaxError
      );
    });

    test('strict: false warns and returns bytes', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN("b32'AB'", {
        strict: false,
        extensions: [b32],
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborByteString);
      expect((result as CborByteString).value).toEqual(new Uint8Array([0x00]));
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toBe(
        'non-zero trailing bits in base32 input'
      );
    });
  });

  describe('invalid UTF-8 in text concatenation', () => {
    // "a" + h'ff': 0xff is not valid UTF-8.
    test('strict: true (default) throws', () => {
      expect(() => parseCDN('"a" + h\'ff\'')).toThrow(SyntaxError);
    });

    test('strict: false warns and returns text with replacement character', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('"a" + h\'ff\'', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborTextString);
      expect((result as CborTextString).value).toBe('a�');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toBe(
        'byte string in text concatenation is not valid UTF-8'
      );
    });

    test('allowInvalidUtf8: true silently allows without warning', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('"a" + h\'ff\'', {
        strict: false,
        allowInvalidUtf8: true,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborTextString);
      expect((result as CborTextString).value).toBe('a�');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('warnings stored on AST node', () => {
    test('float _0: warning attached to CborFloat node', () => {
      const result = parseCDN('1.0_0', { strict: false, silent: true });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].message).toMatch(/_0 and _i/);
    });

    test('base32 trailing bits: warning attached to CborByteString node', () => {
      const result = parseCDN("b32'AB'", {
        strict: false,
        silent: true,
        extensions: [b32],
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].message).toBe(
        'non-zero trailing bits in base32 input'
      );
    });

    test('invalid UTF-8: warning attached to CborTextString node', () => {
      const result = parseCDN('"a" + h\'ff\'', { strict: false, silent: true });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].message).toBe(
        'byte string in text concatenation is not valid UTF-8'
      );
    });

    test('inner element warning not leaked to outer array', () => {
      const arr = parseCDN('[1.0_0]', { strict: false, silent: true });
      expect(arr).toBeInstanceOf(CborArray);
      expect(arr.warnings).toBeUndefined();
      const inner = (arr as CborArray).items[0];
      expect(inner.warnings).toHaveLength(1);
    });
  });

  describe('onWarning and silent options', () => {
    test('onWarning is called even when strict: true (before throw)', () => {
      const warnings: ParseWarning[] = [];
      expect(() =>
        parseCDN('1.0_0', { strict: true, onWarning: (w) => warnings.push(w) })
      ).toThrow(SyntaxError);
      expect(warnings).toHaveLength(1);
    });

    test('onWarning suppresses console.warn (mutually exclusive)', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        parseCDN('1.0_0', {
          strict: false,
          onWarning: () => {},
        });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    test('silent: true suppresses console.warn', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        parseCDN('1.0_0', { strict: false, silent: true });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    test('no onWarning and silent: false calls console.warn', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        parseCDN('1.0_0', { strict: false, silent: false });
        expect(spy).toHaveBeenCalledOnce();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('reserved encoding indicators _4 / _5 / _6', () => {
    test('strict: true throws on _4 for integer', () => {
      expect(() => parseCDN('1_4')).toThrow(SyntaxError);
    });

    test('strict: false warns and drops _4 for integer', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('1_4', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborUint);
      expect((result as CborUint).value).toBe(1n);
      expect((result as CborUint).encodingWidth).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/_4.*AI 28/);
    });

    test('strict: false warns and drops _6 for float', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('1.5_6', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborFloat);
      expect((result as CborFloat).value).toBe(1.5);
      expect(warnings[0].message).toMatch(/_6.*AI 30/);
    });

    test('strict: false warns and drops _5 for byte string', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN("h'ff'_5", {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborByteString);
      expect((result as CborByteString).encodingWidth).toBeUndefined();
      expect(warnings[0].message).toMatch(/_5.*AI 29/);
    });

    test('strict: false warns and drops _4 for array encoding width', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('[_4 1, 2]', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborArray);
      expect((result as CborArray).encodingWidth).toBeUndefined();
      expect(warnings[0].message).toMatch(/_4.*AI 28/);
    });

    test('reserved indicator warning attached to AST node', () => {
      const result = parseCDN('42_6', { strict: false, silent: true });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].message).toMatch(/_6/);
    });

    test('NaN_5: warns and returns NaN', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('NaN_5', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborFloat);
      expect(isNaN((result as CborFloat).value)).toBe(true);
      expect(warnings[0].message).toMatch(/_5/);
    });
  });

  describe('_7 as indefinite-length encoding indicator', () => {
    test('[_7 ...] strict: true throws', () => {
      expect(() => parseCDN('[_7 1, 2]')).toThrow(SyntaxError);
    });

    test('[_7 ...] strict: false warns and produces indefinite array', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('[_7 1, 2]', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborArray);
      expect((result as CborArray).indefiniteLength).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/_7.*non-standard/);
      expect(result.warnings).toHaveLength(1);
    });

    test('{_7 "k": "v"} strict: true throws', () => {
      expect(() => parseCDN('{_7 "k": "v"}')).toThrow(SyntaxError);
    });

    test('{_7 "k": "v"} strict: false warns and produces indefinite map', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('{_7 "k": "v"}', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborMap);
      expect((result as CborMap).indefiniteLength).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/_7.*non-standard/);
      expect(result.warnings).toHaveLength(1);
    });

    test('strict: true throws _7 on integer', () => {
      expect(() => parseCDN('1_7')).toThrow(SyntaxError);
    });

    test('strict: false warns and drops _7 on integer', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('1_7', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborUint);
      expect((result as CborUint).value).toBe(1n);
      expect((result as CborUint).encodingWidth).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/indefinite/);
    });

    test('strict: false warns and drops _7 on float', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('1.5_7', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborFloat);
      expect((result as CborFloat).value).toBe(1.5);
      expect(warnings[0].message).toMatch(/indefinite/);
    });

    test('strict: false warns and drops _7 on byte string', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN("h'ff'_7", {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborByteString);
      expect((result as CborByteString).encodingWidth).toBeUndefined();
      expect(warnings[0].message).toMatch(/indefinite/);
    });

    test('Infinity_7: warns and returns Infinity', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('Infinity_7', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborFloat);
      expect((result as CborFloat).value).toBe(Infinity);
      expect(warnings[0].message).toMatch(/indefinite/);
    });
  });

  describe('warning attribution — setup warnings belong to the container node', () => {
    test('[_4 1] warning on array node, not on item 1', () => {
      const result = parseCDN('[_4 1]', { strict: false, silent: true });
      expect(result).toBeInstanceOf(CborArray);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].message).toMatch(/_4/);
      // The child item must be clean
      expect((result as CborArray).items[0].warnings).toBeUndefined();
    });

    test('{_5 "k": 1} warning on map node, not on key or value', () => {
      const result = parseCDN('{_5 "k": 1}', { strict: false, silent: true });
      expect(result).toBeInstanceOf(CborMap);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].message).toMatch(/_5/);
      const [key, val] = (result as CborMap).entries[0];
      expect(key.warnings).toBeUndefined();
      expect(val.warnings).toBeUndefined();
    });

    test('1_4("hello") warning on tag node, not on content', () => {
      const result = parseCDN('1_4("hello")', { strict: false, silent: true });
      expect(result).toBeInstanceOf(CborTag);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].message).toMatch(/_4/);
      const content = (result as CborTag).content;
      expect(content.warnings).toBeUndefined();
    });
  });

  describe('indefinite group: non-standard indicators _0/_1/_2/_3/_i', () => {
    test('(_0 "a","b") strict: true throws', () => {
      expect(() => parseCDN('(_0 "a","b")')).toThrow(SyntaxError);
    });

    test('(_0 "a","b") strict: false warns on group, not on first chunk', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('(_0 "a","b")', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      }) as CborIndefiniteTextString;
      expect(result).toBeInstanceOf(CborIndefiniteTextString);
      expect(result.chunks).toHaveLength(2);
      // Warning is on the group node, not on a chunk
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].message).toMatch(/_0/);
      expect(result.chunks[0].warnings).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    test("(_3 h'aa') strict: false warns and produces indefinite byte string", () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN("(_3 h'aa')", {
        strict: false,
        onWarning: (w) => warnings.push(w),
      }) as CborIndefiniteByteString;
      expect(result).toBeInstanceOf(CborIndefiniteByteString);
      expect(result.warnings).toHaveLength(1);
      expect(result.chunks[0].warnings).toBeUndefined();
    });
  });

  describe('encoding indicator overflow (parse-time validation)', () => {
    // ── integers ──────────────────────────────────────────────────────────────
    test('strict: true throws when uint exceeds _i range', () => {
      expect(() => parseCDN('12345678_i')).toThrow(/does not fit.*_i/);
    });

    test('strict: true throws when uint exceeds _0 range', () => {
      expect(() => parseCDN('300_0')).toThrow(/does not fit.*_0/);
    });

    test('strict: true throws when nint CBOR argument exceeds _i range', () => {
      // -25 → argument = 24, which exceeds _i max of 23
      expect(() => parseCDN('-25_i')).toThrow(/does not fit.*_i/);
    });

    test('strict: false warns and falls back to natural encoding for 12345678_i', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('12345678_i', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborUint);
      expect((result as CborUint).value).toBe(12345678n);
      expect((result as CborUint).encodingWidth).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toMatch(/12345678.*_i/);
      // toCBOR() must succeed with natural (4-byte) encoding
      expect(result.toCBOR()).toEqual(
        new Uint8Array([0x1a, 0x00, 0xbc, 0x61, 0x4e])
      );
    });

    test('strict: false warns and falls back for -25_i', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('-25_i', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborNint);
      expect((result as CborNint).value).toBe(-25n);
      expect((result as CborNint).encodingWidth).toBeUndefined();
      expect(warnings[0].message).toMatch(/24.*_i/);
    });

    test('nint within _i range is accepted: -24_i', () => {
      // -24 → argument = 23, fits in _i
      const result = parseCDN('-24_i');
      expect(result).toBeInstanceOf(CborNint);
      expect((result as CborNint).encodingWidth).toBe('i');
    });

    test('uint at _i boundary is accepted: 23_i', () => {
      const result = parseCDN('23_i');
      expect(result).toBeInstanceOf(CborUint);
      expect((result as CborUint).encodingWidth).toBe('i');
    });

    // ── text strings ──────────────────────────────────────────────────────────
    test('strict: true throws when text string byte-length exceeds _i range', () => {
      // 24-character ASCII string → 24 UTF-8 bytes > 23
      expect(() => parseCDN('"a 24-char string here!!!"_i')).toThrow(
        /does not fit.*_i/
      );
    });

    test('strict: false warns and drops _i on oversized text string', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN('"a 24-char string here!!!"_i', {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborTextString);
      expect((result as CborTextString).encodingWidth).toBeUndefined();
      expect(warnings[0].message).toMatch(/24.*_i/);
    });

    test('text string within _i range is accepted', () => {
      const result = parseCDN('"hello"_i'); // 5 bytes
      expect(result).toBeInstanceOf(CborTextString);
      expect((result as CborTextString).encodingWidth).toBe('i');
    });

    // ── byte strings ──────────────────────────────────────────────────────────
    test('strict: true throws when byte string length exceeds _i range', () => {
      // 24 bytes (0x00–0x17) → does not fit in _i (max 23)
      expect(() =>
        parseCDN("h'000102030405060708090a0b0c0d0e0f1011121314151617'_i")
      ).toThrow(/does not fit.*_i/);
    });

    test('strict: false warns and drops _i on oversized byte string', () => {
      const warnings: ParseWarning[] = [];
      const result = parseCDN(
        "h'000102030405060708090a0b0c0d0e0f1011121314151617'_i",
        { strict: false, onWarning: (w) => warnings.push(w) }
      );
      expect(result).toBeInstanceOf(CborByteString);
      expect((result as CborByteString).encodingWidth).toBeUndefined();
      expect(warnings[0].message).toMatch(/24.*_i/);
    });

    // ── arrays ────────────────────────────────────────────────────────────────
    test('strict: true throws when array item count exceeds _i range', () => {
      const items = Array.from({ length: 24 }, (_, i) => i).join(', ');
      expect(() => parseCDN(`[_i ${items}]`)).toThrow(/does not fit.*_i/);
    });

    test('strict: false warns and drops _i on oversized array', () => {
      const warnings: ParseWarning[] = [];
      const items = Array.from({ length: 24 }, (_, i) => i).join(', ');
      const result = parseCDN(`[_i ${items}]`, {
        strict: false,
        onWarning: (w) => warnings.push(w),
      });
      expect(result).toBeInstanceOf(CborArray);
      expect((result as CborArray).encodingWidth).toBeUndefined();
      expect(warnings[0].message).toMatch(/24.*_i/);
    });

    test('array within _i count is accepted: [_i 1, 2, 3]', () => {
      const result = parseCDN('[_i 1, 2, 3]');
      expect(result).toBeInstanceOf(CborArray);
      expect((result as CborArray).encodingWidth).toBe('i');
    });

    // ── maps ──────────────────────────────────────────────────────────────────
    test('strict: true throws when map entry count exceeds _0 range', () => {
      // build a map with 256 entries
      const entries = Array.from({ length: 256 }, (_, i) => `${i}: ${i}`).join(
        ', '
      );
      expect(() => parseCDN(`{_0 ${entries}}`)).toThrow(/does not fit.*_0/);
    });
  });
});
