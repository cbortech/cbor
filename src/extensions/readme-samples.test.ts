/**
 * Verify the code samples shown in README.md / README.ja.md for the optional
 * bundled extensions (b32, h32, float, same).
 */

import { describe, test, expect } from 'vitest';
import { CBOR, b32, h32, float, same } from '../index';

describe('README samples — b32 / h32', () => {
  test("b32'AEBAGBA' → h'01020304' with appStrings: false", () => {
    const v = CBOR.fromCDN("b32'AEBAGBA'", { extensions: [b32] });
    expect(v.toCDN({ appStrings: false })).toBe("h'01020304'");
  });

  test("h32'00P00' → h'003200' with appStrings: false", () => {
    const v = CBOR.fromCDN("h32'00P00'", { extensions: [h32] });
    expect(v.toCDN({ appStrings: false })).toBe("h'003200'");
  });
});

describe('README samples — float', () => {
  test("float'7e00' → NaN with appStrings: false", () => {
    const v = CBOR.fromCDN("float'7e00'", { extensions: [float] });
    expect(v.toCDN({ appStrings: false })).toBe('NaN');
  });

  test("float<<h'3f800000'>> round-trips", () => {
    const v = CBOR.fromCDN("float<<h'3f800000'>>", { extensions: [float] });
    expect(v.toCDN()).toBe("float<<h'3f800000'>>");
  });

  test("float<<h'3f800000'>> → 1.0_2 with appStrings: false", () => {
    const v = CBOR.fromCDN("float<<h'3f800000'>>", { extensions: [float] });
    expect(v.toCDN({ appStrings: false })).toBe('1.0_2');
  });
});

describe('README samples — same', () => {
  test("same<<h'0102', h'0102'>> round-trips", () => {
    const v = CBOR.fromCDN("same<<h'0102', h'0102'>>", { extensions: [same] });
    expect(v.toCDN()).toBe("same<<h'0102', h'0102'>>");
  });

  test("same<<h'0102', h'0102'>> → h'0102' with appStrings: false", () => {
    const v = CBOR.fromCDN("same<<h'0102', h'0102'>>", { extensions: [same] });
    expect(v.toCDN({ appStrings: false })).toBe("h'0102'");
  });

  test('same<<42>> round-trips', () => {
    const v = CBOR.fromCDN('same<<42>>', { extensions: [same] });
    expect(v.toCDN()).toBe('same<<42>>');
  });

  test('same<<42>> → 42 with appStrings: false', () => {
    const v = CBOR.fromCDN('same<<42>>', { extensions: [same] });
    expect(v.toCDN({ appStrings: false })).toBe('42');
  });
});
