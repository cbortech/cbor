/**
 * Tests for the `float'...'` app-string extension.
 *
 * Covers:
 *  - Spec §3.7 example: [float'fe00', float'fe00'_2, float'47110815']
 *  - Natural encoding (no EI): float16 / float32 / float64 stored as-is
 *  - Bit-exact widening with NaN payload preservation:
 *      float16 → float32  (_2)
 *      float16 → float64  (_3)
 *      float32 → float64  (_3)
 *  - Special values: ±Infinity, ±0
 *  - Denormal float16 → normal float32/float64
 *  - Narrowing conversions (lossy warning for finite values, silent for NaN)
 *  - Sequence form: float<<h'...'>>`
 *  - Error cases
 */

import { describe, test, expect } from 'vitest';
import { parseCDN } from '../cdn/parser';
import { float } from './float';
import { CborFloat } from '../ast/CborFloat';
import { CborArray } from '../ast/CborArray';

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}

// ─── Spec §3.7 examples ───────────────────────────────────────────────────────

describe('float — spec §3.7 examples (draft-ietf-cbor-edn-literals)', () => {
  // 🔧 "[float'fe00', float'fe00'_2, float'47110815']" -tpretty ➔
  //    83             # array(3)
  //       F9 FE00     # primitive(65024)      ← float16 NaN, natural width
  //       FA FFC00000 # primitive(4290772992) ← float32, widened from float16 (NaN payload preserved)
  //       FA 47110815 # primitive(1192298517) ← float32, direct
  test("[float'fe00', float'fe00'_2, float'47110815'] → 83 f9fe00 faffc00000 fa47110815", () => {
    const arr = parseCDN("[float'fe00', float'fe00'_2, float'47110815']", {
      extensions: [float],
    }) as CborArray;
    expect(arr).toBeInstanceOf(CborArray);
    expect(hex(arr.toCBOR())).toBe('83f9fe00faffc00000fa47110815');
  });

  test("float'fe00' natural → F9 FE00 (float16)", () => {
    const v = parseCDN("float'fe00'", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('f9fe00');
    expect((v as CborFloat).precision).toBe('half');
  });

  test("float'fe00'_2 → FA FFC00000 (bit-exact NaN widening float16→float32)", () => {
    const v = parseCDN("float'fe00'_2", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('faffc00000');
    expect((v as CborFloat).precision).toBe('single');
  });

  test("float'47110815' → FA 47110815 (float32, direct)", () => {
    const v = parseCDN("float'47110815'", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fa47110815');
    expect((v as CborFloat).precision).toBe('single');
  });
});

// ─── NaN payload preservation: float16 → float32 ─────────────────────────────

describe('float — bit-exact NaN payload: float16 → float32 (_2)', () => {
  // Float16 NaN layout: sign(1) | exp(5=0x1F) | mant(10)
  // Float32 expand: bits32 = (sign<<31) | 0x7F800000 | (mant16<<13)

  test("float'7e00'_2 → FA 7FC00000 (positive quiet NaN, mant=0x200→0x400000)", () => {
    // float16 0x7E00: sign=0, exp=0x1F, mant=0x200
    // float32: 0x7F800000 | (0x200<<13) = 0x7F800000 | 0x400000 = 0x7FC00000
    const v = parseCDN("float'7e00'_2", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fa7fc00000');
  });

  test("float'fe00'_2 → FA FFC00000 (negative quiet NaN, mant=0x200→0x400000)", () => {
    // float16 0xFE00: sign=1, exp=0x1F, mant=0x200
    // float32: 0x80000000|0x7F800000|(0x200<<13) = 0xFFC00000
    const v = parseCDN("float'fe00'_2", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('faffc00000');
  });

  test("float'7c01'_2 → FA 7F802000 (minimal NaN payload mant=1→0x2000)", () => {
    // float16 0x7C01: sign=0, exp=0x1F, mant=1
    // float32: 0x7F800000 | (1<<13) = 0x7F800000 | 0x2000 = 0x7F802000
    const v = parseCDN("float'7c01'_2", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fa7f802000');
  });

  test("float'7fff'_2 → FA 7FFFE000 (max NaN payload mant=0x3FF→0x1FF800→0x7FFE000?)", () => {
    // float16 0x7FFF: sign=0, exp=0x1F, mant=0x3FF
    // float32: 0x7F800000 | (0x3FF<<13) = 0x7F800000 | 0x1FFE000 = 0x7FFFE000
    const v = parseCDN("float'7fff'_2", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fa7fffe000');
  });
});

// ─── NaN payload preservation: float16 → float64 ─────────────────────────────

describe('float — bit-exact NaN payload: float16 → float64 (_3)', () => {
  // Float64 expand: hi = (sign<<31) | 0x7FF00000 | (mant16<<10)

  test("float'7e00'_3 → FB 7FF8000000000000 (positive quiet NaN)", () => {
    // float16 0x7E00: mant=0x200
    // float64 hi = 0x7FF00000 | (0x200<<10) = 0x7FF00000 | 0x80000 = 0x7FF80000
    const v = parseCDN("float'7e00'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fb7ff8000000000000');
  });

  test("float'fe00'_3 → FB FFF8000000000000 (negative quiet NaN)", () => {
    // float64 hi = 0x80000000|0x7FF00000|0x80000 = 0xFFF80000
    const v = parseCDN("float'fe00'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fbfff8000000000000');
  });

  test("float'7c01'_3 → FB 7FF0040000000000 (minimal NaN payload mant=1→bit42)", () => {
    // float16 0x7C01: mant=1
    // float64 hi = 0x7FF00000 | (1<<10) = 0x7FF00000 | 0x400 = 0x7FF00400
    const v = parseCDN("float'7c01'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fb7ff0040000000000');
  });
});

// ─── NaN payload preservation: float32 → float64 ─────────────────────────────

describe('float — bit-exact NaN payload: float32 → float64 (_3)', () => {
  // Float64 expand: hi = (sign<<31)|0x7FF00000|(mant32>>>3), lo = (mant32&7)<<29

  test("float'7fc00000'_3 → FB 7FF8000000000000 (positive quiet NaN)", () => {
    // float32 0x7FC00000: sign=0, exp=0xFF, mant=0x400000
    // float64 hi = 0x7FF00000 | (0x400000>>>3) = 0x7FF00000 | 0x80000 = 0x7FF80000
    // float64 lo = (0x400000 & 7) << 29 = 0
    const v = parseCDN("float'7fc00000'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fb7ff8000000000000');
  });

  test("float'ffc00000'_3 → FB FFF8000000000000 (negative quiet NaN)", () => {
    const v = parseCDN("float'ffc00000'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fbfff8000000000000');
  });

  test("float'7fc01234'_3 → FB 7FF8024680000000 (NaN with non-trivial payload)", () => {
    // float32 0x7FC01234: sign=0, exp=0xFF, mant=0x401234
    // float64 hi = 0x7FF00000 | (0x401234>>>3) = 0x7FF00000 | 0x80246 = 0x7FF80246
    // float64 lo = (0x401234 & 7) << 29 = 4 << 29 = 0x80000000
    const v = parseCDN("float'7fc01234'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fb7ff8024680000000');
  });
});

// ─── Special values ───────────────────────────────────────────────────────────

describe('float — special values: ±Infinity', () => {
  test("float'7c00' → F9 7C00 (+∞ as float16, natural)", () => {
    const v = parseCDN("float'7c00'", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('f97c00');
  });

  test("float'fc00' → F9 FC00 (−∞ as float16, natural)", () => {
    const v = parseCDN("float'fc00'", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('f9fc00');
  });

  test("float'7c00'_2 → FA 7F800000 (+∞ float16→float32, bit-exact)", () => {
    const v = parseCDN("float'7c00'_2", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fa7f800000');
  });

  test("float'fc00'_2 → FA FF800000 (−∞ float16→float32, bit-exact)", () => {
    const v = parseCDN("float'fc00'_2", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('faff800000');
  });

  test("float'7c00'_3 → FB 7FF0000000000000 (+∞ float16→float64, bit-exact)", () => {
    const v = parseCDN("float'7c00'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fb7ff0000000000000');
  });

  test("float'7f800000'_3 → FB 7FF0000000000000 (+∞ float32→float64, bit-exact)", () => {
    const v = parseCDN("float'7f800000'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fb7ff0000000000000');
  });
});

describe('float — special values: signed zero', () => {
  test("float'0000' → F9 0000 (+0 as float16)", () => {
    const v = parseCDN("float'0000'", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('f90000');
  });

  test("float'8000' → F9 8000 (−0 as float16)", () => {
    const v = parseCDN("float'8000'", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('f98000');
  });

  test("float'8000'_2 → FA 80000000 (−0 float16→float32, bit-exact)", () => {
    const v = parseCDN("float'8000'_2", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fa80000000');
  });

  test("float'8000'_3 → FB 8000000000000000 (−0 float16→float64, bit-exact)", () => {
    const v = parseCDN("float'8000'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fb8000000000000000');
  });

  test("float'80000000'_3 → FB 8000000000000000 (−0 float32→float64, bit-exact)", () => {
    const v = parseCDN("float'80000000'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fb8000000000000000');
  });
});

// ─── Denormal float16 ────────────────────────────────────────────���────────────

describe('float — denormal float16 → normal float32/float64', () => {
  // float16 0x0001: min positive denormal = 2^(-14) × (1/1024) = 2^(-24)
  // float32 normal: exp=103 (2^(103-127)=2^(-24)), mant=0 → 0x33800000

  test("float'0001' → F9 0001 (float16 min positive denormal, natural)", () => {
    const v = parseCDN("float'0001'", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('f90001');
  });

  test("float'0001'_2 → FA 33800000 (denormal float16 → normal float32, bit-exact)", () => {
    // 2^(-24) → float32 exp=103, mant=0
    const v = parseCDN("float'0001'_2", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fa33800000');
  });

  test("float'0001'_3 → FB 3E70000000000000 (denormal float16 → float64, bit-exact)", () => {
    // 2^(-24) → float64 exp=999 (=1023-24), mant=0
    // hi = (999<<20) = 0x3E700000
    const v = parseCDN("float'0001'_3", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fb3e70000000000000');
  });

  test("float'03ff' → largest float16 denormal → normal float32 correct value", () => {
    // float16 0x03FF: sign=0, exp=0, mant=0x3FF (max denormal)
    // value = 2^(-14) × (1023/1024) ≈ 6.097e-5
    // After widening to float32, round-tripping the value back should be exact
    const v = parseCDN("float'03ff'_2", { extensions: [float] });
    const decoded = new DataView(v.toCBOR().buffer).getFloat32(1, false);
    expect(decoded).toBeCloseTo(2 ** -14 * (1023 / 1024), 10);
  });
});

// ─── Narrowing conversions ────────────────────────────────────────────────────

describe('float — narrowing conversions', () => {
  test("float'3f800000'_1 → F9 3C00 (float32 1.0 → float16, exact)", () => {
    // 1.0 is exactly representable as float16 (0x3C00)
    const v = parseCDN("float'3f800000'_1", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('f93c00');
  });

  test("float'3fc00000'_1 → F9 3E00 (float32 1.5 → float16, exact)", () => {
    // 1.5 = 0x3FC00000 in float32; float16 = 0x3E00
    const v = parseCDN("float'3fc00000'_1", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('f93e00');
  });

  test("float'7fc00000'_1 → float16 NaN (no error despite payload loss)", () => {
    // NaN narrowing: no error raised (isNaN guard), but payload may change.
    // Result must still be a float16 NaN: exp bits 0x1F, mant ≠ 0.
    const v = parseCDN("float'7fc00000'_1", { extensions: [float] });
    const cbor = v.toCBOR();
    expect(cbor[0]).toBe(0xf9); // float16 AI byte
    const bits16 = (cbor[1]! << 8) | cbor[2]!;
    expect((bits16 & 0x7c00) >>> 10).toBe(0x1f); // exponent = 31 (NaN/Inf range)
    expect(bits16 & 0x03ff).not.toBe(0); // mantissa ≠ 0 → NaN (not Infinity)
    expect((v as CborFloat).precision).toBe('half');
  });

  test("float'40490fdb'_1 warns (π as float32 is lossy as float16)", () => {
    // π ≈ 3.14159265 cannot be exactly represented as float16
    expect(() =>
      parseCDN("float'40490fdb'_1", { extensions: [float] })
    ).toThrow(/cannot be exactly represented as float16/);
  });

  test("float'4048f5c3'_1 warns (float32 3.14 is lossy as float16)", () => {
    expect(() =>
      parseCDN("float'4048f5c3'_1", { extensions: [float] })
    ).toThrow(/cannot be exactly represented as float16/);
  });

  test("float'400921fb54442d18'_2 warns (π as float64 is lossy as float32)", () => {
    expect(() =>
      parseCDN("float'400921fb54442d18'_2", { extensions: [float] })
    ).toThrow(/cannot be exactly represented as float32/);
  });
});

// ─── Sequence form ────────────────────────────────────────────────────────────

describe("float — sequence form float<<h'...'>>", () => {
  test("float<<h'3f800000'>> → FA 3F800000 (float32 1.0)", () => {
    const v = parseCDN("float<<h'3f800000'>>", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fa3f800000');
  });

  test("float<<h'7e00'>> → F9 7E00 (float16 NaN from sequence)", () => {
    const v = parseCDN("float<<h'7e00'>>", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('f97e00');
  });

  test("float<<h'7fc00000'>> → FA 7FC00000 (float32 quiet NaN)", () => {
    const v = parseCDN("float<<h'7fc00000'>>", { extensions: [float] });
    expect(hex(v.toCBOR())).toBe('fa7fc00000');
  });
});

// ─── Error cases ─────────────────────────────────────────────────────────────

describe('float — error cases', () => {
  test("float'abc' (3 hex digits = 1.5 bytes) throws", () => {
    expect(() => parseCDN("float'abc'", { extensions: [float] })).toThrow(
      /odd length/
    );
  });

  test("float'abcd12' (3 bytes) throws (must be 2, 4, or 8 bytes)", () => {
    expect(() => parseCDN("float'abcd12'", { extensions: [float] })).toThrow(
      /2, 4, or 8 bytes/
    );
  });

  test("float'fe00'_0 throws (EI _0 is not valid for float)", () => {
    expect(() => parseCDN("float'fe00'_0", { extensions: [float] })).toThrow(
      /not valid/
    );
  });

  test("float'fe00'_i throws (EI _i is not valid for float)", () => {
    expect(() => parseCDN("float'fe00'_i", { extensions: [float] })).toThrow(
      /not valid/
    );
  });
});

// ─── Natural encoding (no EI) — precision field ───────────────────────────────

describe('float — natural encoding sets correct precision', () => {
  test("float'7e00' (2 bytes) → precision='half'", () => {
    const v = parseCDN("float'7e00'", { extensions: [float] }) as CborFloat;
    expect(v.precision).toBe('half');
  });

  test("float'3f800000' (4 bytes) → precision='single'", () => {
    const v = parseCDN("float'3f800000'", { extensions: [float] }) as CborFloat;
    expect(v.precision).toBe('single');
  });

  test("float'3ff0000000000000' (8 bytes) → precision='double'", () => {
    const v = parseCDN("float'3ff0000000000000'", {
      extensions: [float],
    }) as CborFloat;
    expect(v.precision).toBe('double');
  });
});
