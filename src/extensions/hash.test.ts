import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { CborByteString } from '../ast/CborByteString';

// Expected hash values (RFC 9054 / Table 5, §3.3 draft-ietf-cbor-edn-literals-22)
const SHA1_FOO = '0beec7b5ea3f0fdbc95d0dd47f3c5bc275da8a33';
const SHA256_64_FOO = '2c26b46b68ffc68f'; // -15: SHA-256 truncated to 64 bits
const SHA256_FOO =
  '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae';
const SHA512_256_FOO =
  'd58042e6aa5a335e03ad576c6a9e43b41591bfd2077f72dec9df7930e492055d'; // -17
const SHAKE128_32_FOO =
  'f84e95cb5fbd2038863ab27d3cdeac295ad2d4ab96ad1f4b070c0bf36078ef08'; // -18
const SHA384_FOO =
  '98c11ffdfdd540676b1a137cb1a22b2a70350c9a44171d6b1180c6be5cbb2ee3f79d532c8a1dd9ef2e8e08e752a3babb';
const SHA512_FOO =
  'f7fbba6e0636f890e56fbbf3283e524c6fa3204ae298382d624741d0dc6638326e282c41be5e4254d8820772c5518a2c5a8c0c7f7eda19594a7eb539453e1ed7';
const SHAKE256_64_FOO =
  '1af97f7818a28edfdfce5ec66dbdc7e871813816d7d585fe1f12475ded5b6502b7723b74e2ee36f2651a10a8eaca72aa9148c3c761aaceac8f6d6cc64381ed39'; // -45

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

// ─── hash'…' (app-string form, default SHA-256) ───────────────────────────────

describe("hash — hash'…' (app-string, default SHA-256)", () => {
  test("hash'foo' → SHA-256 byte string", () => {
    const v = CBOR.fromEDN("hash'foo'");
    expect(v).toBeInstanceOf(CborByteString);
    expect((v as CborByteString).value).toEqual(fromHex(SHA256_FOO));
  });

  test("hash'foo' → toEDN() roundtrips to hash'foo'", () => {
    const v = CBOR.fromEDN("hash'foo'");
    expect(v.toEDN()).toBe("hash'foo'");
  });

  test("hash'foo' → toEDN({appStrings:false}) emits h'…'", () => {
    const v = CBOR.fromEDN("hash'foo'");
    expect(v.toEDN({ appStrings: false })).toBe(`h'${SHA256_FOO}'`);
  });

  test("hash'' (empty string) → SHA-256 of empty bytes", () => {
    const v = CBOR.fromEDN("hash''");
    // SHA-256 of empty string
    const expected =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect((v as CborByteString).value).toEqual(fromHex(expected));
  });
});

// ─── hash<<…>> (app-sequence form) ────────────────────────────────────────────

describe('hash — hash<<…>> (app-sequence)', () => {
  test("hash<<'foo'>> → SHA-256 (default algorithm)", () => {
    const v = CBOR.fromEDN("hash<<'foo'>>");
    expect((v as CborByteString).value).toEqual(fromHex(SHA256_FOO));
  });

  test("hash<<'foo', -16>> → explicit SHA-256 by COSE integer ID", () => {
    const v = CBOR.fromEDN("hash<<'foo', -16>>");
    expect((v as CborByteString).value).toEqual(fromHex(SHA256_FOO));
  });

  test('hash<<\'foo\', "SHA-256">> → explicit SHA-256 by COSE name', () => {
    const v = CBOR.fromEDN('hash<<\'foo\', "SHA-256">>');
    expect((v as CborByteString).value).toEqual(fromHex(SHA256_FOO));
  });

  test("hash<<'foo', -43>> → SHA-384", () => {
    const v = CBOR.fromEDN("hash<<'foo', -43>>");
    expect((v as CborByteString).value).toEqual(fromHex(SHA384_FOO));
  });

  test('hash<<\'foo\', "SHA-384">> → SHA-384 by name', () => {
    const v = CBOR.fromEDN('hash<<\'foo\', "SHA-384">>');
    expect((v as CborByteString).value).toEqual(fromHex(SHA384_FOO));
  });

  test("hash<<'foo', -44>> → SHA-512", () => {
    const v = CBOR.fromEDN("hash<<'foo', -44>>");
    expect((v as CborByteString).value).toEqual(fromHex(SHA512_FOO));
  });

  test('hash<<\'foo\', "SHA-512">> → SHA-512 by name', () => {
    const v = CBOR.fromEDN('hash<<\'foo\', "SHA-512">>');
    expect((v as CborByteString).value).toEqual(fromHex(SHA512_FOO));
  });

  test("hash<<'foo', -14>> → SHA-1 (legacy)", () => {
    const v = CBOR.fromEDN("hash<<'foo', -14>>");
    expect((v as CborByteString).value).toEqual(fromHex(SHA1_FOO));
  });

  test('hash<<\'foo\', "SHA-1">> → SHA-1 by name', () => {
    const v = CBOR.fromEDN('hash<<\'foo\', "SHA-1">>');
    expect((v as CborByteString).value).toEqual(fromHex(SHA1_FOO));
  });

  test("hash<<'foo', -15>> → SHA-256/64 (64-bit truncation)", () => {
    const v = CBOR.fromEDN("hash<<'foo', -15>>");
    expect((v as CborByteString).value).toEqual(fromHex(SHA256_64_FOO));
    expect((v as CborByteString).value).toHaveLength(8);
  });

  test('hash<<\'foo\', "SHA-256/64">> → SHA-256/64 by name', () => {
    const v = CBOR.fromEDN('hash<<\'foo\', "SHA-256/64">>');
    expect((v as CborByteString).value).toEqual(fromHex(SHA256_64_FOO));
  });

  test("hash<<'foo', -17>> → SHA-512/256", () => {
    const v = CBOR.fromEDN("hash<<'foo', -17>>");
    expect((v as CborByteString).value).toEqual(fromHex(SHA512_256_FOO));
    expect((v as CborByteString).value).toHaveLength(32);
  });

  test('hash<<\'foo\', "SHA-512/256">> → SHA-512/256 by name', () => {
    const v = CBOR.fromEDN('hash<<\'foo\', "SHA-512/256">>');
    expect((v as CborByteString).value).toEqual(fromHex(SHA512_256_FOO));
  });

  test("hash<<'foo', -18>> → SHAKE128 256-bit output", () => {
    const v = CBOR.fromEDN("hash<<'foo', -18>>");
    expect((v as CborByteString).value).toEqual(fromHex(SHAKE128_32_FOO));
    expect((v as CborByteString).value).toHaveLength(32);
  });

  test('hash<<\'foo\', "SHAKE128">> → SHAKE128 by name', () => {
    const v = CBOR.fromEDN('hash<<\'foo\', "SHAKE128">>');
    expect((v as CborByteString).value).toEqual(fromHex(SHAKE128_32_FOO));
  });

  test("hash<<'foo', -45>> → SHAKE256 512-bit output", () => {
    const v = CBOR.fromEDN("hash<<'foo', -45>>");
    expect((v as CborByteString).value).toEqual(fromHex(SHAKE256_64_FOO));
    expect((v as CborByteString).value).toHaveLength(64);
  });

  test('hash<<\'foo\', "SHAKE256">> → SHAKE256 by name', () => {
    const v = CBOR.fromEDN('hash<<\'foo\', "SHAKE256">>');
    expect((v as CborByteString).value).toEqual(fromHex(SHAKE256_64_FOO));
  });

  test("hash<<h'0102', -16>> → SHA-256 of raw bytes", () => {
    const v = CBOR.fromEDN("hash<<h'0102', -16>>");
    const expected =
      'a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222';
    expect((v as CborByteString).value).toEqual(fromHex(expected));
  });
});

// ─── toEDN() notation ────────────────────────────────────────────────────────

describe('hash — toEDN() notation', () => {
  test("hash'foo' → hash'foo' (text input, default algo)", () => {
    expect(CBOR.fromEDN("hash'foo'").toEDN()).toBe("hash'foo'");
  });

  // In EDN sequences, 'foo' (single-quote) is a CborByteString (UTF-8 bytes).
  // With default sqstr:'printable-string', printable bytes round-trip as sqstr.
  // Double-quoted "foo" is a CborTextString and normalises to the hash'...' form.
  test("hash<<'foo'>> → hash<<'foo'>> (printable bytes round-trip as sqstr)", () => {
    expect(CBOR.fromEDN("hash<<'foo'>>").toEDN()).toBe("hash<<'foo'>>");
  });
  test("hash<<'foo'>> → hash<<h'666f6f'>> with sqstr:none", () => {
    expect(CBOR.fromEDN("hash<<'foo'>>").toEDN({ sqstr: 'none' })).toBe(
      "hash<<h'666f6f'>>"
    );
  });

  test('hash<<"foo">> → hash\'foo\' (double-quoted text normalises to string form)', () => {
    expect(CBOR.fromEDN('hash<<"foo">>').toEDN()).toBe("hash'foo'");
  });

  test('hash<<"foo", -16>> → hash\'foo\' (explicit default algo omitted)', () => {
    expect(CBOR.fromEDN('hash<<"foo", -16>>').toEDN()).toBe("hash'foo'");
  });

  test('hash<<"foo", "SHA-256">> → hash\'foo\' (name form normalises)', () => {
    expect(CBOR.fromEDN('hash<<"foo", "SHA-256">>').toEDN()).toBe("hash'foo'");
  });

  test('hash<<"foo", -44>> → hash<<\'foo\', "SHA-512">> (non-default algo uses name)', () => {
    expect(CBOR.fromEDN('hash<<"foo", -44>>').toEDN()).toBe(
      'hash<<\'foo\', "SHA-512">>'
    );
  });

  test("hash<<h'0102', -16>> → hash<<h'0102'>> (byte input, default algo)", () => {
    expect(CBOR.fromEDN("hash<<h'0102', -16>>").toEDN()).toBe(
      "hash<<h'0102'>>"
    );
  });

  test("hash<<h'0102', -44>> → hash<<h'0102', \"SHA-512\">>", () => {
    expect(CBOR.fromEDN("hash<<h'0102', -44>>").toEDN()).toBe(
      'hash<<h\'0102\', "SHA-512">>'
    );
  });

  test("appStrings:false → h'…' (raw hex bytes)", () => {
    expect(CBOR.fromEDN("hash'foo'").toEDN({ appStrings: false })).toBe(
      `h'${SHA256_FOO}'`
    );
  });

  test("sqstr:'printable-string' (default) — printable bytes emit '...' in sequence", () => {
    // 'foo' in a seq becomes CborByteString([102,111,111]); printable → 'foo'
    expect(CBOR.fromEDN("hash<<'foo', -44>>").toEDN()).toBe(
      'hash<<\'foo\', "SHA-512">>'
    );
  });

  test("sqstr:'printable-string' — binary bytes still emit h'…'", () => {
    expect(CBOR.fromEDN("hash<<h'0102', -44>>").toEDN()).toBe(
      'hash<<h\'0102\', "SHA-512">>'
    );
  });
});

// ─── hash'…' = hash<<'…'>> = hash<<'…', -16>> ────────────────────────────────

describe('hash — all three forms produce identical output', () => {
  test("hash'foo' == hash<<'foo'>> == hash<<'foo', -16>> == hash<<'foo', \"SHA-256\">>", () => {
    const a = (CBOR.fromEDN("hash'foo'") as CborByteString).value;
    const b = (CBOR.fromEDN("hash<<'foo'>>") as CborByteString).value;
    const c = (CBOR.fromEDN("hash<<'foo', -16>>") as CborByteString).value;
    const d = (CBOR.fromEDN('hash<<\'foo\', "SHA-256">>') as CborByteString)
      .value;
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a).toEqual(d);
  });
});

// ─── CBOR round-trip ─────────────────────────────────────────────────────────

describe('hash — CBOR round-trip', () => {
  test("hash'foo' → toCBOR() → fromCBOR() → same bytes", () => {
    const v = CBOR.fromEDN("hash'foo'");
    const cbor = v.toCBOR();
    const v2 = CBOR.fromCBOR(cbor);
    expect((v2 as CborByteString).value).toEqual(fromHex(SHA256_FOO));
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('hash — error cases', () => {
  test('hash<<>> (no items) throws SyntaxError', () => {
    expect(() => CBOR.fromEDN('hash<<>>')).toThrow(SyntaxError);
  });

  test('hash<<\'foo\', -16, "extra">> (3 items) throws SyntaxError', () => {
    expect(() => CBOR.fromEDN('hash<<\'foo\', -16, "extra">>')).toThrow(
      SyntaxError
    );
  });

  test('hash<<42>> (integer data) throws SyntaxError', () => {
    expect(() => CBOR.fromEDN('hash<<42>>')).toThrow(SyntaxError);
  });

  test("hash<<'foo', 999>> (unsupported algorithm ID) throws SyntaxError", () => {
    expect(() => CBOR.fromEDN("hash<<'foo', 999>>")).toThrow(SyntaxError);
  });

  test('hash<<\'foo\', "MD5">> (unknown algorithm name) throws SyntaxError', () => {
    expect(() => CBOR.fromEDN('hash<<\'foo\', "MD5">>')).toThrow(SyntaxError);
  });
});
