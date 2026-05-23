import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { decodeCBOR } from '../cbor/decoder';
import { CborUnresolvedAppExt, CPA999_TAG } from './CborUnresolvedAppExt';
import { CborTag } from './CborTag';
import { CborArray } from './CborArray';
import { CborTextString } from './CborTextString';

// ─── app-string form (cpa999 is the default) ──────────────────────────────────

describe('CPA999 stand-in — app-string form', () => {
  test("geo'48.2,16.3' → CborUnresolvedAppExt, tag 999 (default)", () => {
    const v = CBOR.fromCDN("geo'48.2,16.3'");
    expect(v).toBeInstanceOf(CborUnresolvedAppExt);
    expect((v as CborTag).tag).toBe(CPA999_TAG);
  });

  test('stand-in content structure: CPA999(["geo", "48.2,16.3"])', () => {
    const v = CBOR.fromCDN("geo'48.2,16.3'") as CborTag;
    const arr = v.content as CborArray;
    expect((arr.items[0] as CborTextString).value).toBe('geo');
    expect(arr.items[1]).toBeInstanceOf(CborTextString);
    expect((arr.items[1] as CborTextString).value).toBe('48.2,16.3');
  });

  test("geo'...' toCDN() reconstructs geo'...' notation", () => {
    const v = CBOR.fromCDN("geo'48.2,16.3'");
    expect(v.toCDN()).toBe("geo'48.2,16.3'");
  });

  test('unknown extension toCBOR() → decodable as plain CborTag', () => {
    const v = CBOR.fromCDN("geo'48.2,16.3'");
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(CPA999_TAG);
  });
});

// ─── app-sequence form ────────────────────────────────────────────────────────

describe('CPA999 stand-in — app-sequence form', () => {
  test('geo<<"data", -44>> → CborUnresolvedAppExt (default)', () => {
    const v = CBOR.fromCDN('geo<<"data", -44>>');
    expect(v).toBeInstanceOf(CborUnresolvedAppExt);
    expect((v as CborTag).tag).toBe(CPA999_TAG);
  });

  test('stand-in content structure: CPA999(["geo", ["data", -44]])', () => {
    const v = CBOR.fromCDN('geo<<"data", -44>>') as CborTag;
    const arr = v.content as CborArray;
    expect((arr.items[0] as CborTextString).value).toBe('geo');
    const inner = arr.items[1] as CborArray;
    expect(inner.items).toHaveLength(2);
  });

  test('geo<<...>> toCDN() reconstructs geo<<...>> notation', () => {
    const v = CBOR.fromCDN('geo<<"data", -44>>');
    expect(v.toCDN()).toBe('geo<<"data", -44>>');
  });

  test('empty app-sequence: myext<<>> → stand-in with empty inner array', () => {
    const v = CBOR.fromCDN('myext<<>>') as CborTag;
    const inner = (v.content as CborArray).items[1] as CborArray;
    expect(inner.items).toHaveLength(0);
    expect(v.toCDN()).toBe('myext<<>>');
  });
});

// ─── error mode (opt-in) ──────────────────────────────────────────────────────

describe("CPA999 stand-in — error mode (unresolvedExtension: 'error')", () => {
  test("unknown prefix throws SyntaxError with unresolvedExtension: 'error'", () => {
    expect(() =>
      CBOR.fromCDN("geo'48.2,16.3'", { unresolvedExtension: 'error' })
    ).toThrow(SyntaxError);
  });

  test("unknown app-sequence throws SyntaxError with unresolvedExtension: 'error'", () => {
    expect(() =>
      CBOR.fromCDN('geo<<"data", -44>>', { unresolvedExtension: 'error' })
    ).toThrow(SyntaxError);
  });
});

// ─── known extensions still work ─────────────────────────────────────────────

describe('CPA999 stand-in — known extensions unaffected', () => {
  test("dt'...' still parsed normally", () => {
    const v = CBOR.fromCDN("dt'1970-01-01T00:00:00Z'");
    expect(v).not.toBeInstanceOf(CborUnresolvedAppExt);
  });

  test("IP'...' still parsed normally", () => {
    const v = CBOR.fromCDN("IP'192.0.2.42'");
    expect(v).not.toBeInstanceOf(CborUnresolvedAppExt);
  });
});
