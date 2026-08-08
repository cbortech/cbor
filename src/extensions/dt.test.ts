import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborFloat } from '../ast/CborFloat';
import { CborTag } from '../ast/CborTag';
import {
  CborEpochDtExtUint,
  CborEpochDtExtNint,
  CborEpochDtExtFloat,
  CborTaggedEpochDtExt,
  CborTaggedEpochDtAsDateExt,
  dt_as_Date,
  epochToRfc3339,
} from './dt';
import { decodeCBOR } from '../cbor/decoder';
import { fromJS } from '../js/fromJS';
import { Tag } from '../tag';

// ─── dt / DT extension (§3.2) ─────────────────────────────────────────────────
// Table 3 from draft-ietf-cbor-edn-literals-27 §3.2

describe('dt — dt app-string', () => {
  test("dt'1969-07-21T02:56:16Z' → CborEpochDtExtNint(-14159024n)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtNint);
    expect((n as CborNint).value).toBe(-14159024n);
  });

  test("dt'1969-07-21T02:56:16.0Z' → CborEpochDtExtFloat(-14159024.0)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16.0Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(-14159024.0);
  });

  test("dt'1969-07-21T02:56:16.5Z' → CborEpochDtExtFloat(-14159023.5)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16.5Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(-14159023.5);
  });

  test("dt'1970-01-01T00:00:00Z' → CborEpochDtExtUint(0n)", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtUint);
    expect((n as CborUint).value).toBe(0n);
  });

  test('dt double-quoted form dt"..." → SyntaxError', () => {
    expect(() => CBOR.fromCDN('dt"1970-01-01T00:00:00Z"')).toThrow(SyntaxError);
  });

  test('dt invalid datetime throws SyntaxError', () => {
    expect(() => CBOR.fromCDN("dt'not-a-date'")).toThrow(SyntaxError);
  });
});

// ─── dt<<…>> — app-sequence form ──────────────────────────────────────────────

describe('dt — dt<<…>> / DT<<…>> (app-sequence form)', () => {
  test("dt<<'1969-07-21T02:56:16.5Z'>> → float (single-quoted bytes form)", () => {
    const n = CBOR.fromCDN("dt<<'1969-07-21T02:56:16.5Z'>>");
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(-14159023.5);
  });

  test('dt<<"1969-07-21T02:56:16.5Z">> → float (double-quoted text form)', () => {
    const n = CBOR.fromCDN('dt<<"1969-07-21T02:56:16.5Z">>');
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(-14159023.5);
  });

  test("DT<<'1969-07-21T02:56:16Z'>> → CborTaggedEpochDtExt", () => {
    const n = CBOR.fromCDN("DT<<'1969-07-21T02:56:16Z'>>");
    expect(n).toBeInstanceOf(CborTaggedEpochDtExt);
    expect((n as CborTag).tag).toBe(1n);
    expect(((n as CborTag).content as CborNint).value).toBe(-14159024n);
  });
});

// ─── DT app-string ────────────────────────────────────────────────────────────

describe('dt — DT app-string', () => {
  test("DT'1969-07-21T02:56:16Z' → CborTaggedEpochDtExt, tag(1, -14159024)", () => {
    const n = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    expect(n).toBeInstanceOf(CborTaggedEpochDtExt);
    expect((n as CborTag).tag).toBe(1n);
    expect(((n as CborTag).content as CborNint).value).toBe(-14159024n);
  });
});

// ─── toCDN round-trips ────────────────────────────────────────────────────────

describe('dt — toCDN', () => {
  test("dt'…' round-trips through toCDN (integer)", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00Z'");
    expect(n.toCDN()).toBe("dt'1970-01-01T00:00:00Z'");
  });

  test("dt'…' round-trips through toCDN (negative integer)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16Z'");
    expect(n.toCDN()).toBe("dt'1969-07-21T02:56:16Z'");
  });

  test("DT'…' round-trips through toCDN", () => {
    const n = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    expect(n.toCDN()).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test("appStrings:false — dt'…' falls back to plain integer", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16Z'");
    expect(n.toCDN({ appStrings: false })).toBe('-14159024');
  });

  test("appStrings:false — dt'…' (float) falls back to plain float", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16.5Z'");
    expect(n.toCDN({ appStrings: false })).toBe('-14159023.5');
  });

  test("appStrings:false — DT'…' falls back to integer tag notation", () => {
    const n = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    expect(n.toCDN({ appStrings: false })).toBe('1(-14159024)');
  });
});

describe('dt — preserveNumberFormat', () => {
  // parseTag() rebuilds a fresh CborEpochDtExt* node from the tagged
  // content; it must carry the original ednSource/literalSource along so
  // preserveNumberFormat isn't silently dropped for values reached via
  // 1(...) tag notation (as opposed to dt'...' / DT'...' app-strings).
  test('0x1(0xff) + appStrings:false preserves both tag number and content base', () => {
    expect(
      CBOR.format('0x1(0xff)', {
        preserveNumberFormat: true,
        appStrings: false,
      })
    ).toBe('0x1(0xff)');
  });

  test('0x1(-0x10) + appStrings:false preserves negative content base', () => {
    expect(
      CBOR.format('0x1(-0x10)', {
        preserveNumberFormat: true,
        appStrings: false,
      })
    ).toBe('0x1(-0x10)');
  });

  test('0x1(1.5_1) + appStrings:false preserves float spelling and indicator', () => {
    expect(
      CBOR.format('0x1(1.5_1)', {
        preserveNumberFormat: true,
        appStrings: false,
      })
    ).toBe('0x1(1.5_1)');
  });

  test('appStrings default still prefers DT notation over raw tag spelling', () => {
    // appStrings takes precedence over preserveNumberFormat by design: it
    // controls whether known tags use app-string notation at all,
    // independently of how any underlying integer/float literal is spelled.
    expect(CBOR.format('0x1(0xff)', { preserveNumberFormat: true })).toBe(
      "DT'1970-01-01T00:04:15Z'"
    );
  });
});

describe('dt — preserveAppSequence', () => {
  // By design, dt/DT regenerate their notation from the resolved value on
  // every format() call — so <<...>> normally collapses to '...' even
  // though both spell the same value. preserveAppSequence keeps the
  // original bracketed spelling instead, without changing the parsed
  // node's class (CborEpochDtExt* / CborTaggedEpochDtExt).

  test('DT<<...>> keeps its bracketed notation when requested', () => {
    expect(
      CBOR.format("DT<<'1969-07-21T02:56:16Z'>>", {
        preserveAppSequence: true,
      })
    ).toBe("DT<<'1969-07-21T02:56:16Z'>>");
    // Default output normalises to the DT'...' form.
    expect(CBOR.format("DT<<'1969-07-21T02:56:16Z'>>")).toBe(
      "DT'1969-07-21T02:56:16Z'"
    );
  });

  test('dt<<...>> (integer) keeps its bracketed notation when requested', () => {
    expect(
      CBOR.format("dt<<'1969-07-21T02:56:16Z'>>", {
        preserveAppSequence: true,
      })
    ).toBe("dt<<'1969-07-21T02:56:16Z'>>");
  });

  test('dt<<...>> (float) keeps its bracketed notation when requested', () => {
    expect(
      CBOR.format("dt<<'1969-07-21T02:56:16.5Z'>>", {
        preserveAppSequence: true,
      })
    ).toBe("dt<<'1969-07-21T02:56:16.5Z'>>");
  });

  test('encoding indicator on the >> is kept, and stripped under never', () => {
    expect(
      CBOR.format("DT<<'1969-07-21T02:56:16Z'>>_1", {
        preserveAppSequence: true,
      })
    ).toBe("DT<<'1969-07-21T02:56:16Z'>>_1");
    expect(
      CBOR.format("DT<<'1969-07-21T02:56:16Z'>>_1", {
        preserveAppSequence: true,
        encodingIndicators: 'never',
      })
    ).toBe("DT<<'1969-07-21T02:56:16Z'>>");
  });

  test('encodingIndicators: never also strips an inner (item-level) indicator', () => {
    // The app-sequence's sole inner item can carry its own indicator
    // (right before the closing >>), independent of the wrapper's own
    // (right after >>). 'never' means neither should survive.
    expect(
      CBOR.format("DT<<'1969-07-21T02:56:16Z'_1>>_1", {
        preserveAppSequence: true,
        encodingIndicators: 'never',
      })
    ).toBe("DT<<'1969-07-21T02:56:16Z'>>");
  });

  test('encodingIndicators: never strips an inner indicator across whitespace/comma before >>', () => {
    // CDN allows whitespace and/or a trailing comma between an
    // app-sequence's item and its closing >>; the inner indicator isn't
    // always immediately adjacent to it.
    expect(
      CBOR.format("DT<<'1969-07-21T02:56:16Z'_1, >>_1", {
        preserveAppSequence: true,
        encodingIndicators: 'never',
      })
    ).toBe("DT<<'1969-07-21T02:56:16Z', >>");
  });

  test('encodingIndicators: never strips an inner indicator across a comment before >>', () => {
    // The inner indicator is located by its actual parsed position, not by
    // pattern-matching text near '>>', so a comment (of any form) between
    // it and '>>' doesn't defeat the strip.
    expect(
      CBOR.format("DT<<'1969-07-21T02:56:16Z'_1 /note/ >>_1", {
        preserveAppSequence: true,
        encodingIndicators: 'never',
      })
    ).toBe("DT<<'1969-07-21T02:56:16Z' /note/ >>");
  });

  test('comment style options keep app-sequence/backtick notation when there are no comments', () => {
    expect(
      CBOR.format("DT<<'1969-07-21T02:56:16Z'>>", {
        preserveAppSequence: true,
        preserveComments: 'c-style',
        indent: 2,
      })
    ).toBe("DT<<'1969-07-21T02:56:16Z'>>");
    expect(
      CBOR.format('DT`1969-07-21T02:56:16Z`', {
        preserveAppSequence: true,
        preserveComments: 'cdn-style',
        indent: 2,
      })
    ).toBe('DT`1969-07-21T02:56:16Z`');
  });

  test('normalises comments inside preserved app-sequence notation', () => {
    expect(
      CBOR.format("DT<</before/ '1969-07-21T02:56:16Z'_1 # after\n>>_1", {
        preserveAppSequence: true,
        preserveComments: 'c-style',
        encodingIndicators: 'never',
        indent: 2,
      })
    ).toBe("DT<</*before*/ '1969-07-21T02:56:16Z' // after\n>>");
    expect(
      CBOR.format("DT<</* before */ '1969-07-21T02:56:16Z'>>", {
        preserveAppSequence: true,
        preserveComments: 'cdn-style',
        indent: 2,
      })
    ).toBe("DT<</ before / '1969-07-21T02:56:16Z'>>");
  });

  test('preserveComments: false removes comments without losing app-sequence notation', () => {
    expect(
      CBOR.format("DT<</note/ '1969-07-21T02:56:16Z'>>", {
        preserveAppSequence: true,
        preserveComments: false,
        indent: 2,
      })
    ).toBe("DT<< '1969-07-21T02:56:16Z'>>");
  });

  test('untagged dt<<...>> keeps its bracketed notation under always/never too', () => {
    expect(
      CBOR.format("dt<<'1969-07-21T02:56:16Z'>>", {
        preserveAppSequence: true,
        encodingIndicators: 'never',
      })
    ).toBe("dt<<'1969-07-21T02:56:16Z'>>");
    expect(
      CBOR.format("dt<<'1969-07-21T02:56:16Z'>>", {
        preserveAppSequence: true,
        encodingIndicators: 'always',
      })
    ).toBe("dt<<'1969-07-21T02:56:16Z'>>_2");
  });

  test('explicit text/raw-string overrides apply inside <<...>>', () => {
    expect(
      CBOR.format('DT<<"1969-07-21T02:56:16\\u005a">>', {
        preserveAll: true,
        preserveTextString: false,
      })
    ).toBe("DT'1969-07-21T02:56:16Z'");
    expect(
      CBOR.format('DT<<`1969-07-21T02:56:16Z`>>', {
        preserveAll: true,
        preserveRawString: false,
      })
    ).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test('an unrelated explicit byte-string override keeps text-string <<...>> source', () => {
    expect(
      CBOR.format('DT<<"1969-07-21T02:56:16\\u005a">>', {
        preserveAll: true,
        preserveByteString: false,
      })
    ).toBe('DT<<"1969-07-21T02:56:16\\u005a">>');
  });

  test('a byte-string concatenation part is not misclassified as an unpreservable text string', () => {
    // The single-quoted part here has no preserved raw source (only
    // backtick/RAWSTRING parts do) — the same as an unpreserved
    // double-quoted literal would have. preserveTextString: false must not
    // veto <<...>> notation just because of that: there is no actual
    // double-quoted string in this concatenation, only a byte string merged
    // into text per draft-25 §5.1.
    expect(
      CBOR.format("DT<<`1969-` + '07-21T02:56:16Z'>>", {
        preserveAll: true,
        preserveTextString: false,
        indent: 2,
      })
    ).toBe("DT<<`1969-` + '07-21T02:56:16Z'>>");
    // preserveByteString: false, on the other hand, is a relevant override
    // here and must still veto it.
    expect(
      CBOR.format("DT<<`1969-` + '07-21T02:56:16Z'>>", {
        preserveAll: true,
        preserveByteString: false,
        indent: 2,
      })
    ).toBe("DT'1969-07-21T02:56:16Z'");
    // An actual double-quoted part must still be vetoed by preserveTextString: false.
    expect(
      CBOR.format('DT<<`1969-` + "07-21T02:56:16Z">>', {
        preserveAll: true,
        preserveTextString: false,
        indent: 2,
      })
    ).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test('encodingIndicators: always adds a missing indicator to <<...>> / `...` notation', () => {
    // Unlike raw tag notation, <<...>> / `...` have only one indicator
    // position (right after the closing bracket/backtick), so it can be
    // added without losing the bracketed/backtick notation itself.
    expect(
      CBOR.format("DT<<'1969-07-21T02:56:16Z'>>", {
        preserveAppSequence: true,
        encodingIndicators: 'always',
      })
    ).toBe("DT<<'1969-07-21T02:56:16Z'>>_i");
    expect(
      CBOR.format('DT`1969-07-21T02:56:16Z`', {
        preserveAppSequence: true,
        encodingIndicators: 'always',
      })
    ).toBe('DT`1969-07-21T02:56:16Z`_i');
  });

  test('appStrings:false still wins over preserveAppSequence', () => {
    expect(
      CBOR.format("DT<<'1969-07-21T02:56:16Z'>>", {
        preserveAppSequence: true,
        appStrings: false,
      })
    ).toBe('1(-14159024)');
  });

  test('keeps a non-canonical dt/DT app-string spelling too, not just <<...>>', () => {
    // '+00:00' / a non-canonical fractional-digit count are both valid
    // RFC 3339 spellings of the same instant that epochToRfc3339() would
    // normally regenerate differently.
    expect(
      CBOR.format("dt'1969-07-21T02:56:16+00:00'", {
        preserveAppSequence: true,
      })
    ).toBe("dt'1969-07-21T02:56:16+00:00'");
    expect(CBOR.format("dt'1969-07-21T02:56:16+00:00'")).toBe(
      "dt'1969-07-21T02:56:16Z'"
    );

    expect(
      CBOR.format("dt'1969-07-21T02:56:16.50Z'", {
        preserveAppSequence: true,
      })
    ).toBe("dt'1969-07-21T02:56:16.50Z'");
    expect(CBOR.format("dt'1969-07-21T02:56:16.50Z'")).toBe(
      "dt'1969-07-21T02:56:16.500Z'"
    );
  });

  test('keeps prefix`...` (backtick app-rstring) notation when requested', () => {
    expect(
      CBOR.format('dt`1969-07-21T02:56:16Z`', { preserveAppSequence: true })
    ).toBe('dt`1969-07-21T02:56:16Z`');
    expect(
      CBOR.format('DT`1969-07-21T02:56:16Z`', { preserveAppSequence: true })
    ).toBe('DT`1969-07-21T02:56:16Z`');
    // Default output normalises to the single-quoted form.
    expect(CBOR.format('dt`1969-07-21T02:56:16Z`')).toBe(
      "dt'1969-07-21T02:56:16Z'"
    );
  });

  test('prefix`...` (float, backtick) keeps its notation when requested', () => {
    expect(
      CBOR.format('dt`1969-07-21T02:56:16.5Z`', {
        preserveAppSequence: true,
      })
    ).toBe('dt`1969-07-21T02:56:16.5Z`');
  });

  test('backtick node keeps its dedicated class/identity', () => {
    const n = CBOR.fromCDN('dt`1969-07-21T02:56:16Z`');
    expect(n).toBeInstanceOf(CborEpochDtExtNint);
  });

  test('keeps raw tag notation (1(...)) instead of upgrading to DT notation', () => {
    expect(CBOR.format('1(1749772800)', { preserveAppSequence: true })).toBe(
      '1(1749772800)'
    );
    // Default output normalises to the regenerated DT'...' form.
    expect(CBOR.format('1(1749772800)')).toBe("DT'2025-06-13T00:00:00Z'");
  });

  test('raw tag notation combines with preserveNumberFormat for the tag/content bases', () => {
    expect(
      CBOR.format('0x1(0xff)', {
        preserveAppSequence: true,
        preserveNumberFormat: true,
      })
    ).toBe('0x1(0xff)');
  });

  test('appStrings:false still wins over preserveAppSequence for raw tag notation', () => {
    expect(
      CBOR.format('1(1749772800)', {
        preserveAppSequence: true,
        appStrings: false,
      })
    ).toBe('1(1749772800)');
  });

  test('raw tag notation node keeps its dedicated class/identity', () => {
    const n = CBOR.fromCDN('1(1749772800)');
    expect(n).toBeInstanceOf(CborTaggedEpochDtExt);
  });

  test('encodingIndicators applies to both items in raw tag notation', () => {
    // The tag number and content each carry their own indicator.
    expect(
      CBOR.format('1_1(1749772800_3)', {
        preserveAppSequence: true,
        encodingIndicators: 'never',
      })
    ).toBe('1(1749772800)');
    expect(
      CBOR.format('1(1749772800)', {
        preserveAppSequence: true,
        encodingIndicators: 'always',
      })
    ).toBe('1_i(1749772800_2)');
  });

  test('encodingIndicators edits raw-tag source without changing unrelated spelling/layout', () => {
    expect(
      CBOR.format('0x1_1( 0xff_1 )', {
        preserveAppSequence: true,
        encodingIndicators: 'never',
      })
    ).toBe('0x1( 0xff )');
    expect(
      CBOR.format('0x1( 0xff )', {
        preserveAppSequence: true,
        encodingIndicators: 'always',
      })
    ).toBe('0x1_i( 0xff_0 )');
    expect(
      CBOR.format('0x1_1(/note/ 0xff_1)', {
        preserveAppSequence: true,
        preserveComments: 'c-style',
        encodingIndicators: 'never',
        indent: 2,
      })
    ).toBe('0x1(/*note*/ 0xff)');
  });

  test('preserveNumberFormat: false overrides verbatim raw tag notation', () => {
    // preserveAll turns preserveAppSequence on but leaves an explicit
    // preserveNumberFormat: false alone; verbatim raw-tag text is itself
    // number-literal spelling, so it must not be used when that's off.
    expect(
      CBOR.format('0x1(0xff)', {
        preserveAll: true,
        preserveNumberFormat: false,
      })
    ).toBe('1(255)');
  });

  test('preserveComments: false overrides verbatim raw tag notation', () => {
    // The raw-tag verbatim text embeds a comment written inside the
    // parens; preserveComments: false must still strip it, same as it
    // would for a comment anywhere else in the document.
    expect(
      CBOR.format('0x1(/note/ 0xff)', {
        preserveAll: true,
        preserveComments: false,
        indent: 2,
      })
    ).toBe('0x1( 0xff)');
    // Left unset, preserveAppSequence alone keeps the comment (consistent
    // with preserveNumberFormat/preserveByteString also defaulting to
    // "verbatim wins" rather than "off wins" when merely left unset).
    expect(CBOR.format('0x1(/note/ 0xff)', { preserveAppSequence: true })).toBe(
      '0x1(/note/ 0xff)'
    );
  });

  test('preserveComments: c-style/cdn-style override verbatim, normalising the marker', () => {
    // Only the comment marker changes; number spelling and surrounding raw
    // tag layout remain verbatim.
    expect(
      CBOR.format('0x1(/note/ 0xff)', {
        preserveAll: true,
        preserveComments: 'c-style',
        indent: 2,
      })
    ).toBe('0x1(/*note*/ 0xff)');
    expect(
      CBOR.format('0x1(/note/ 0xff)', {
        preserveAll: true,
        preserveComments: 'cdn-style',
        indent: 2,
      })
    ).toBe('0x1(/note/ 0xff)');
    expect(
      CBOR.format('0x1( 0xff )', {
        preserveAppSequence: true,
        preserveComments: 'c-style',
        indent: 2,
      })
    ).toBe('0x1( 0xff )');
    expect(
      CBOR.format('0x1(/note/ 0xff)', {
        preserveAppSequence: true,
        preserveComments: 'c-style',
        indent: 2,
      })
    ).toBe('0x1(/*note*/ 0xff)');
  });

  test('parsed node keeps its dedicated class/identity, unlike CborAppSeqResult wrapping', () => {
    const n = CBOR.fromCDN("dt<<'1969-07-21T02:56:16Z'>>");
    expect(n).toBeInstanceOf(CborEpochDtExtNint);
    const t = CBOR.fromCDN("DT<<'1969-07-21T02:56:16Z'>>");
    expect(t).toBeInstanceOf(CborTaggedEpochDtExt);
  });
});

// ─── fromCBOR round-trip (DT_EXT built-in, no extensions option needed) ───────

describe('dt — fromCBOR round-trip', () => {
  test("DT'…' → toCBOR → fromCBOR → toCDN round-trips (negative integer)", () => {
    const original = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test("DT'…' → toCBOR → fromCBOR → toCDN round-trips (positive integer)", () => {
    const original = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'");
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test("DT'…' → toCBOR → fromCBOR → toCDN round-trips (fractional seconds)", () => {
    const original = CBOR.fromCDN("DT'1969-07-21T02:56:16.500Z'");
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });

  test('tag(1, uint) without extensions → CborTaggedEpochDtExt', () => {
    const cbor = new CborTag(1n, new CborUint(1672574400n)).toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test('tag(1, nint) without extensions → CborTaggedEpochDtExt', () => {
    const cbor = new CborTag(1n, new CborNint(-14159024n)).toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test('tag(1, float) without extensions → CborTaggedEpochDtExt', () => {
    const cbor = new CborTag(1n, new CborFloat(-14159023.5)).toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });

  test('tag(5, …) is not intercepted by DT_EXT', () => {
    const cbor = new CborTag(5n, new CborUint(42n)).toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(decoded).toBeInstanceOf(CborTag);
    expect(decoded).not.toBeInstanceOf(CborTaggedEpochDtExt);
  });
});

// ─── parseTag byte-offset propagation ────────────────────────────────────────

describe('dt — parseTag byte-offset propagation', () => {
  test('fromCBOR: result.content carries start/end byte offsets from original value', () => {
    // Bug: parseTag created a new content node without copying value.start/end,
    // so buildRows() could not split the hex view into separate tag + content rows.
    // Encoding: C1 (tag 1, 1 byte) + 1A 6A 2D EF 00 (uint 1781395200, 5 bytes).
    const cbor = new CborTag(1n, new CborUint(1781395200n)).toCBOR();
    const decoded = decodeCBOR(cbor) as CborTaggedEpochDtExt;
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.content.start).toBe(1); // tag header is 1 byte (C1)
    expect(decoded.content.end).toBe(6); // total: 1 + 5 = 6 bytes
  });
});

// ─── fromJS round-trip (DT_EXT built-in, no extensions option needed) ─────────

describe('dt — fromJS round-trip', () => {
  test("DT'…' → toJS → fromJS → toCDN round-trips (negative integer)", () => {
    const original = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    const js = original.toJS();
    const restored = fromJS(js);
    expect(restored).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(restored.toCDN()).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test("DT'…' → toJS → fromJS → toCDN round-trips (positive integer)", () => {
    const original = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'");
    const js = original.toJS();
    const restored = fromJS(js);
    expect(restored).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(restored.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test("DT'…' → toJS → fromJS → toCDN round-trips (fractional seconds)", () => {
    const original = CBOR.fromCDN("DT'1969-07-21T02:56:16.500Z'");
    const js = original.toJS();
    const restored = fromJS(js);
    expect(restored).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(restored.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });
});

// ─── epochToRfc3339 ───────────────────────────────────────────────────────────

describe('epochToRfc3339', () => {
  test('integer epoch → no fractional seconds', () => {
    expect(epochToRfc3339(0)).toBe('1970-01-01T00:00:00Z');
    expect(epochToRfc3339(1672574400)).toBe('2023-01-01T12:00:00Z');
    expect(epochToRfc3339(-14159024)).toBe('1969-07-21T02:56:16Z');
  });
  test('millisecond-precision epoch → 3 decimal places', () => {
    expect(epochToRfc3339(-14159023.5)).toBe('1969-07-21T02:56:16.500Z');
    expect(epochToRfc3339(1.5)).toBe('1970-01-01T00:00:01.500Z');
    expect(epochToRfc3339(0.001)).toBe('1970-01-01T00:00:00.001Z');
    expect(epochToRfc3339(0.123)).toBe('1970-01-01T00:00:00.123Z');
  });
  test('sub-millisecond epoch → minimal decimal places (≥3)', () => {
    expect(epochToRfc3339(0.0001)).toBe('1970-01-01T00:00:00.0001Z');
    expect(epochToRfc3339(0.0005)).toBe('1970-01-01T00:00:00.0005Z');
    expect(epochToRfc3339(0.123456)).toBe('1970-01-01T00:00:00.123456Z');
    expect(epochToRfc3339(-0.0001)).toBe('1969-12-31T23:59:59.9999Z');
  });
});

describe('parseDtAppString — sub-millisecond precision', () => {
  test("dt'…0.0001Z' → CborEpochDtExtFloat with value 0.0001", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00.0001Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(0.0001);
  });
  test("dt'…0.0001Z' round-trips through toCDN", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00.0001Z'");
    expect(n.toCDN()).toBe("dt'1970-01-01T00:00:00.0001Z'");
  });
  test("dt'…0.123456Z' round-trips through toCDN", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00.123456Z'");
    expect(n.toCDN()).toBe("dt'1970-01-01T00:00:00.123456Z'");
  });
  test("dt'…16.5Z' still round-trips with .500Z (ms-precision path)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16.5Z'");
    expect(n.toCDN()).toBe("dt'1969-07-21T02:56:16.500Z'");
  });
});

// ─── dt_as_Date — fromCDN ───────────────────────────────────────────────────────

const DATE_OPTS = { extensions: [dt_as_Date] };

describe('dt_as_Date — fromCDN', () => {
  test("dt'...' (positive integer) → CborEpochDtExtUint, toJS=number (not Date)", () => {
    const v = CBOR.fromCDN("dt'1970-01-01T00:00:00Z'", DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtUint);
    expect(v.toCDN()).toBe("dt'1970-01-01T00:00:00Z'");
    expect(v.toJS()).not.toBeInstanceOf(Date);
  });

  test("dt'...' (negative integer) → CborEpochDtExtNint, toJS=number (not Date)", () => {
    const v = CBOR.fromCDN("dt'1969-07-21T02:56:16Z'", DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtNint);
    expect(v.toCDN()).toBe("dt'1969-07-21T02:56:16Z'");
    expect(v.toJS()).not.toBeInstanceOf(Date);
  });

  test("dt'...' (fractional) → CborEpochDtExtFloat, toJS=number (not Date)", () => {
    const v = CBOR.fromCDN("dt'1969-07-21T02:56:16.5Z'", DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtFloat);
    expect(v.toCDN()).toBe("dt'1969-07-21T02:56:16.500Z'");
    expect(v.toJS()).not.toBeInstanceOf(Date);
  });

  test("DT'...' → CborTaggedEpochDtAsDateExt, toCDN()=DT'...'", () => {
    const v = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'", DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect(v.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test("DT'...' toJS() → plain Date", () => {
    const v = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'", DATE_OPTS);
    const d = v.toJS() as Date;
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2023-01-01T12:00:00.000Z');
  });

  test("DT'...' toCBOR() produces tag(1, integer)", () => {
    const v = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'", DATE_OPTS);
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(1n);
    expect((decoded as CborTag).content).toBeInstanceOf(CborUint);
  });

  test('1(epoch) in EDN → CborTaggedEpochDtAsDateExt via parseTag hook', () => {
    const v = CBOR.fromCDN('1(1672574400)', DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).toISOString()).toBe('2023-01-01T12:00:00.000Z');
  });

  test('1(negative epoch) in EDN → CborTaggedEpochDtAsDateExt', () => {
    const v = CBOR.fromCDN('1(-14159024)', DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).toISOString()).toBe('1969-07-21T02:56:16.000Z');
  });

  test('1(float epoch) in EDN → CborTaggedEpochDtAsDateExt', () => {
    const v = CBOR.fromCDN('1(-14159023.5)', DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).getTime()).toBeCloseTo(-14159023500, -1);
  });

  test("dt<<'...'>> (bytes form) → CborEpochDtExtUint", () => {
    const v = CBOR.fromCDN("dt<<'2023-01-01T12:00:00Z'>>", DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtUint);
  });

  test('dt<<"...">> (text form) → CborEpochDtExtUint', () => {
    const v = CBOR.fromCDN('dt<<"2023-01-01T12:00:00Z">>', DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtUint);
  });
});

// ─── dt_as_Date — fromCBOR ──────────────────────────────────────────────────────

describe('dt_as_Date — fromCBOR', () => {
  test('tag(1, uint) → CborTaggedEpochDtAsDateExt', () => {
    const cbor = new CborTag(1n, new CborUint(1672574400n)).toCBOR();
    const v = decodeCBOR(cbor, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).toISOString()).toBe('2023-01-01T12:00:00.000Z');
  });

  test('tag(1, nint) → CborTaggedEpochDtAsDateExt', () => {
    const cbor = new CborTag(1n, new CborNint(-14159024n)).toCBOR();
    const v = decodeCBOR(cbor, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).toISOString()).toBe('1969-07-21T02:56:16.000Z');
  });

  test('tag(1, float) → CborTaggedEpochDtAsDateExt', () => {
    const cbor = new CborTag(1n, new CborFloat(-14159023.5)).toCBOR();
    const v = decodeCBOR(cbor, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).getTime()).toBeCloseTo(-14159023500, -1);
  });

  test('tag(5, …) is not intercepted by dt_as_Date', () => {
    const cbor = new CborTag(5n, new CborUint(42n)).toCBOR();
    const v = decodeCBOR(cbor, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTag);
    expect(v).not.toBeInstanceOf(CborTaggedEpochDtAsDateExt);
  });
});

// ─── dt_as_Date — fromJS ────────────────────────────────────────────────────────

describe('dt_as_Date — fromJS', () => {
  test('Date → CborTaggedEpochDtAsDateExt', () => {
    const d = new Date('2023-01-01T12:00:00.000Z');
    const v = fromJS(d, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect(v.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test('Date with fractional seconds', () => {
    const d = new Date('1969-07-21T02:56:16.500Z');
    const v = fromJS(d, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect(v.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });

  test('{ [Tag.symbol]: 1n } → CborTaggedEpochDtAsDateExt', () => {
    const tagged = Object.assign(Object(1672574400), { [Tag.symbol]: 1n });
    const v = fromJS(tagged, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
  });

  test('non-Date objects are not intercepted', () => {
    const v = fromJS({ x: 1 }, DATE_OPTS);
    expect(v).not.toBeInstanceOf(CborTaggedEpochDtAsDateExt);
  });
});

// ─── dt_as_Date — round-trip ────────────────────────────────────────────────────

describe('dt_as_Date — round-trip', () => {
  test('EDN → CBOR → fromCBOR → toJS → fromJS → toCBOR', () => {
    const original = CBOR.fromCDN("DT'2023-06-15T09:30:00Z'", DATE_OPTS);
    const cbor = original.toCBOR();
    const decoded = decodeCBOR(cbor, DATE_OPTS);
    const date = decoded.toJS() as Date;
    const restored = fromJS(date, DATE_OPTS);
    expect(restored.toCBOR()).toEqual(cbor);
  });

  test('DT with fractional seconds round-trips through toJS/fromJS', () => {
    const v = CBOR.fromCDN("DT'1969-07-21T02:56:16.500Z'", DATE_OPTS);
    const date = v.toJS() as Date;
    const restored = fromJS(date, DATE_OPTS) as CborTaggedEpochDtAsDateExt;
    expect(restored.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });
});

// ─── DT: non-canonical inner encoding falls back to generic tag notation ──────

describe('dt — non-canonical inner encoding falls back to generic tag notation', () => {
  // Per §4.1: DT'...'_N encodes only the tag number's width.
  // When the inner content uses a non-canonical encoding that cannot be
  // expressed in app-string notation, _toCDN() falls back to CborTag._toCDN()
  // so the inner EI is preserved in generic tag notation.

  test('tag(1, float64(1.0)) — double is non-canonical, falls back to 1(1.0_3)', () => {
    // 1.0 is exactly representable in float16; using float64 is non-canonical.
    // parseTag must copy float.precision so _toCDN can detect the discrepancy.
    const content = new CborEpochDtExtFloat(1.0);
    content.precision = 'double';
    const tagged = new CborTaggedEpochDtExt(content);
    expect(tagged.toCDN()).toBe('1(1.0_3)');
  });

  test('tag(1, uint(1_0)) — 1-byte header non-canonical, falls back to 1(1_0)', () => {
    // Value 1 fits in inline encoding; 1-byte header (AI=24) is non-canonical.
    const content = new CborEpochDtExtUint(1n, { encodingWidth: 0 });
    const tagged = new CborTaggedEpochDtExt(content);
    expect(tagged.toCDN()).toBe('1(1_0)');
  });

  test('fromCBOR tag(1, float64(1.0)) → fallback preserved through decoding', () => {
    // c1 = tag(1, inline AI), fb 3ff0... = float64(1.0).
    // After decodeCBOR, parseTag must copy precision='double' to CborEpochDtExtFloat.
    const bytes = new Uint8Array([
      0xc1, 0xfb, 0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const n = decodeCBOR(bytes) as CborTaggedEpochDtExt;
    expect(n).toBeInstanceOf(CborTaggedEpochDtExt);
    const cdn = n.toCDN();
    expect(cdn).toBe('1(1.0_3)');
    expect(CBOR.fromCDN(cdn).toCBOR()).toEqual(bytes);
  });

  test('fromCBOR tag(1, uint(1) with 1-byte header) → fallback preserved through decoding', () => {
    // c1 = tag(1, inline AI), 18 01 = uint(1) with 1-byte header (non-canonical).
    const bytes = new Uint8Array([0xc1, 0x18, 0x01]);
    const n = decodeCBOR(bytes) as CborTaggedEpochDtExt;
    expect(n).toBeInstanceOf(CborTaggedEpochDtExt);
    const cdn = n.toCDN();
    expect(cdn).toBe('1(1_0)');
    expect(CBOR.fromCDN(cdn).toCBOR()).toEqual(bytes);
  });
});
