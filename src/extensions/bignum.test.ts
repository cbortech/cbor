import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { decodeCBOR } from '../cbor/decoder';
import {
  CborBigUint,
  CborBigNint,
  bigintToBytes,
  bytesToBigint,
} from '../ast/CborBignum';
import { CborTag } from '../ast/CborTag';
import { CborByteString } from '../ast/CborByteString';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';

// ─── bigintToBytes / bytesToBigint helpers ────────────────────────────────────

describe('bigintToBytes / bytesToBigint', () => {
  test('0n → empty bytes → 0n', () => {
    const b = bigintToBytes(0n);
    expect(b).toEqual(new Uint8Array(0));
    expect(bytesToBigint(b)).toBe(0n);
  });

  test('1n → 0x01 → 1n', () => {
    const b = bigintToBytes(1n);
    expect(b).toEqual(new Uint8Array([0x01]));
    expect(bytesToBigint(b)).toBe(1n);
  });

  test('2^64 → 9 bytes starting with 0x01', () => {
    const n = 0xffff_ffff_ffff_ffffn + 1n; // 2^64
    const b = bigintToBytes(n);
    expect(b).toEqual(
      new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    );
    expect(bytesToBigint(b)).toBe(n);
  });

  test('round-trip for large value', () => {
    const n = 123456789012345678901234567890n;
    expect(bytesToBigint(bigintToBytes(n))).toBe(n);
  });
});

// ─── CborBigUint ──────────────────────────────────────────────────────────────

describe('CborBigUint', () => {
  const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
  const TWO_POW_64 = UINT64_MAX + 1n;

  test('constructor rejects values ≤ UINT64_MAX', () => {
    expect(() => new CborBigUint(UINT64_MAX)).toThrow(RangeError);
    expect(() => new CborBigUint(0n)).toThrow(RangeError);
  });

  test('toCBOR() encodes as tag(2, bytes)', () => {
    const v = new CborBigUint(TWO_POW_64);
    const cbor = v.toCBOR();
    // tag(2) head: 0xc2; 9-byte bstr head: 0x49; then 9 bytes
    expect(cbor[0]).toBe(0xc2);
    expect(cbor[1]).toBe(0x49); // 0x40 | 9
  });

  test('toCDN() emits plain decimal', () => {
    expect(new CborBigUint(TWO_POW_64).toCDN()).toBe('18446744073709551616');
    expect(new CborBigUint(123456789012345678901234567890n).toCDN()).toBe(
      '123456789012345678901234567890'
    );
  });

  test('toJS() returns bigint', () => {
    expect(new CborBigUint(TWO_POW_64).toJS()).toBe(TWO_POW_64);
  });
});

// ─── CborBigNint ──────────────────────────────────────────────────────────────

describe('CborBigNint', () => {
  const NINT64_MIN = -(0xffff_ffff_ffff_ffffn + 1n); // -2^64
  const FIRST_BIGNINT = NINT64_MIN - 1n; // -(2^64 + 1)

  test('constructor rejects values ≥ NINT64_MIN', () => {
    expect(() => new CborBigNint(NINT64_MIN)).toThrow(RangeError);
    expect(() => new CborBigNint(-1n)).toThrow(RangeError);
  });

  test('toCBOR() encodes as tag(3, bytes)', () => {
    const v = new CborBigNint(FIRST_BIGNINT);
    const cbor = v.toCBOR();
    expect(cbor[0]).toBe(0xc3); // tag(3) head
  });

  test('toCDN() emits plain decimal', () => {
    expect(new CborBigNint(FIRST_BIGNINT).toCDN()).toBe(
      '-18446744073709551617'
    );
  });

  test('toJS() returns bigint', () => {
    expect(new CborBigNint(FIRST_BIGNINT).toJS()).toBe(FIRST_BIGNINT);
  });
});

// ─── CDN parser — bignum auto-detection ──────────────────────────────────────

describe('parseCDN — bignum integers', () => {
  test('2^64 → CborBigUint', () => {
    const v = CBOR.fromCDN('18446744073709551616');
    expect(v).toBeInstanceOf(CborBigUint);
    expect((v as CborBigUint).bigValue).toBe(18446744073709551616n);
  });

  test('2^64 - 1 (UINT64_MAX) → plain CborUint, not bignum', () => {
    const v = CBOR.fromCDN('18446744073709551615');
    expect(v).toBeInstanceOf(CborUint);
    expect(v).not.toBeInstanceOf(CborBigUint);
  });

  test('large positive → CborBigUint round-trips through toCDN', () => {
    const n = '123456789012345678901234567890';
    expect(CBOR.fromCDN(n).toCDN()).toBe(n);
  });

  test('hex notation 0x10000000000000000 → CborBigUint', () => {
    const v = CBOR.fromCDN('0x10000000000000000');
    expect(v).toBeInstanceOf(CborBigUint);
    expect((v as CborBigUint).bigValue).toBe(0x10000000000000000n);
  });

  test('-(2^64 + 1) → CborBigNint', () => {
    const v = CBOR.fromCDN('-18446744073709551617');
    expect(v).toBeInstanceOf(CborBigNint);
    expect((v as CborBigNint).bigValue).toBe(-18446744073709551617n);
  });

  test('-2^64 (NINT64_MIN) → plain CborNint, not bignum', () => {
    const v = CBOR.fromCDN('-18446744073709551616');
    expect(v).toBeInstanceOf(CborNint);
    expect(v).not.toBeInstanceOf(CborBigNint);
  });

  test('large negative → CborBigNint round-trips through toCDN', () => {
    const n = '-123456789012345678901234567890';
    expect(CBOR.fromCDN(n).toCDN()).toBe(n);
  });

  test('oversized tag number before ( is a SyntaxError', () => {
    expect(() => CBOR.fromCDN('18446744073709551616(42)')).toThrow(SyntaxError);
  });
});

// ─── CBOR decoder — bignum tag interception ───────────────────────────────────

describe('fromCBOR — bignum tag interception', () => {
  test('tag(2, 9-byte bstr) → CborBigUint', () => {
    // Manually build tag(2, h'010000000000000000') = 2^64
    const bignumUint = new CborBigUint(18446744073709551616n);
    const decoded = decodeCBOR(bignumUint.toCBOR());
    expect(decoded).toBeInstanceOf(CborBigUint);
    expect((decoded as CborBigUint).bigValue).toBe(18446744073709551616n);
  });

  test('tag(3, 9-byte bstr) → CborBigNint', () => {
    const bignumNint = new CborBigNint(-18446744073709551617n);
    const decoded = decodeCBOR(bignumNint.toCBOR());
    expect(decoded).toBeInstanceOf(CborBigNint);
    expect((decoded as CborBigNint).bigValue).toBe(-18446744073709551617n);
  });

  test('tag(2, 1-byte bstr) with in-range value → plain CborTag (not CborBigUint)', () => {
    // tag(2, h'01') = non-canonical encoding of 1; stays as CborTag
    const tag = new CborTag(2n, new CborByteString(new Uint8Array([0x01])));
    const decoded = decodeCBOR(tag.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect(decoded).not.toBeInstanceOf(CborBigUint);
  });

  test('CBOR round-trip: EDN → toCBOR → fromCBOR → toCDN', () => {
    const original = CBOR.fromCDN('18446744073709551616');
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborBigUint);
    expect(decoded.toCDN()).toBe('18446744073709551616');
  });

  test('CBOR round-trip for negative bignum', () => {
    const original = CBOR.fromCDN('-18446744073709551617');
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborBigNint);
    expect(decoded.toCDN()).toBe('-18446744073709551617');
  });
});

// ─── EDN tag notation 2(h'...') / 3(h'...') ──────────────────────────────────

describe('parseCDN — tag notation for out-of-range bignums', () => {
  test("2(h'010000000000000000') → CborBigUint", () => {
    const v = CBOR.fromCDN("2(h'010000000000000000')");
    expect(v).toBeInstanceOf(CborBigUint);
    expect((v as CborBigUint).bigValue).toBe(18446744073709551616n);
    expect(v.toCDN()).toBe('18446744073709551616');
  });

  test("3(h'010000000000000000') → CborBigNint", () => {
    const v = CBOR.fromCDN("3(h'010000000000000000')");
    expect(v).toBeInstanceOf(CborBigNint);
    expect((v as CborBigNint).bigValue).toBe(-18446744073709551617n);
    expect(v.toCDN()).toBe('-18446744073709551617');
  });

  test("2(h'01') with in-range value → plain CborTag", () => {
    const v = CBOR.fromCDN("2(h'01')");
    expect(v).toBeInstanceOf(CborTag);
    expect(v).not.toBeInstanceOf(CborBigUint);
  });
});
