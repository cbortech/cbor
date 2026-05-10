import { describe, test, expect } from 'vitest';
import {
  writeFloat16,
  readFloat16,
  float64ToFloat16Bits,
  float16BitsToFloat64,
  hasNativeFloat16,
} from './float16';

function makeView(size: number): DataView {
  return new DataView(new ArrayBuffer(size));
}

describe('writeFloat16 / readFloat16', () => {
  describe('normal numbers', () => {
    test('1.0 LE: bytes=[0x00, 0x3c]', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 1.0, true);
      expect(v.getUint8(0)).toBe(0x00);
      expect(v.getUint8(1)).toBe(0x3c);
      expect(readFloat16(v, 0, true)).toBe(1.0);
    });

    test('1.0 BE: bytes=[0x3c, 0x00]', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 1.0, false);
      expect(v.getUint8(0)).toBe(0x3c);
      expect(v.getUint8(1)).toBe(0x00);
      expect(readFloat16(v, 0, false)).toBe(1.0);
    });

    test('-2.0 LE: bytes=[0x00, 0xc0]', () => {
      const v = makeView(2);
      writeFloat16(v, 0, -2.0, true);
      expect(v.getUint8(0)).toBe(0x00);
      expect(v.getUint8(1)).toBe(0xc0);
      expect(readFloat16(v, 0, true)).toBe(-2.0);
    });

    test('1.5 round-trips', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 1.5, true);
      expect(readFloat16(v, 0, true)).toBe(1.5);
    });

    test('0.5 round-trips', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 0.5, true);
      expect(readFloat16(v, 0, true)).toBe(0.5);
    });

    test('float16 max value 65504: bytes=[0xff, 0x7b]', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 65504, true);
      expect(v.getUint8(0)).toBe(0xff);
      expect(v.getUint8(1)).toBe(0x7b);
      expect(readFloat16(v, 0, true)).toBe(65504);
    });
  });

  describe('special values', () => {
    test('+Infinity LE: bytes=[0x00, 0x7c]', () => {
      const v = makeView(2);
      writeFloat16(v, 0, Infinity, true);
      expect(v.getUint8(0)).toBe(0x00);
      expect(v.getUint8(1)).toBe(0x7c);
      expect(readFloat16(v, 0, true)).toBe(Infinity);
    });

    test('-Infinity LE: bytes=[0x00, 0xfc]', () => {
      const v = makeView(2);
      writeFloat16(v, 0, -Infinity, true);
      expect(v.getUint8(0)).toBe(0x00);
      expect(v.getUint8(1)).toBe(0xfc);
      expect(readFloat16(v, 0, true)).toBe(-Infinity);
    });

    test('NaN → NaN', () => {
      const v = makeView(2);
      writeFloat16(v, 0, NaN, true);
      expect(readFloat16(v, 0, true)).toBeNaN();
    });

    test('+0: bytes=[0x00, 0x00]', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 0, true);
      expect(v.getUint8(0)).toBe(0x00);
      expect(v.getUint8(1)).toBe(0x00);
      expect(readFloat16(v, 0, true)).toBe(0);
    });

    test('-0: bytes=[0x00, 0x80]', () => {
      const v = makeView(2);
      writeFloat16(v, 0, -0, true);
      expect(v.getUint8(0)).toBe(0x00);
      expect(v.getUint8(1)).toBe(0x80);
      const result = readFloat16(v, 0, true);
      expect(Object.is(result, -0)).toBe(true);
    });
  });

  describe('overflow / underflow', () => {
    test('65519 (one below overflow threshold) rounds to max finite 65504', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 65519, true);
      expect(v.getUint16(0, true)).toBe(0x7bff); // max finite
      expect(readFloat16(v, 0, true)).toBe(65504);
    });

    test('65520 (overflow threshold, ties-to-even) rounds to +Infinity', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 65520, true);
      expect(v.getUint16(0, true)).toBe(0x7c00); // +Infinity
      expect(readFloat16(v, 0, true)).toBe(Infinity);
    });

    test('positive overflow (1e6) → +Infinity', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 1e6, true);
      expect(v.getUint8(0)).toBe(0x00);
      expect(v.getUint8(1)).toBe(0x7c);
      expect(readFloat16(v, 0, true)).toBe(Infinity);
    });

    test('negative overflow (-1e6) → -Infinity', () => {
      const v = makeView(2);
      writeFloat16(v, 0, -1e6, true);
      expect(readFloat16(v, 0, true)).toBe(-Infinity);
    });

    test('underflow (1e-8) → +0', () => {
      const v = makeView(2);
      writeFloat16(v, 0, 1e-8, true);
      expect(readFloat16(v, 0, true)).toBe(0);
    });
  });

  describe('denormal numbers', () => {
    test('smallest positive denormal 2^-24: bits=0x0001', () => {
      const v = makeView(2);
      const minDenormal = 2 ** -24; // ≈ 5.96e-8
      writeFloat16(v, 0, minDenormal, true);
      expect(v.getUint16(0, true)).toBe(0x0001);
      expect(readFloat16(v, 0, true)).toBe(minDenormal);
    });

    test('smallest positive normal 2^-14: bits=0x0400', () => {
      const v = makeView(2);
      const minNormal = 2 ** -14;
      writeFloat16(v, 0, minNormal, true);
      expect(v.getUint16(0, true)).toBe(0x0400);
      expect(readFloat16(v, 0, true)).toBe(minNormal);
    });
  });

  describe('non-zero offset', () => {
    test('write at offset 2; first 2 bytes remain 0x00', () => {
      const v = makeView(4);
      writeFloat16(v, 2, 1.0, true);
      expect(v.getUint8(0)).toBe(0x00);
      expect(v.getUint8(1)).toBe(0x00);
      expect(v.getUint8(2)).toBe(0x00);
      expect(v.getUint8(3)).toBe(0x3c);
      expect(readFloat16(v, 2, true)).toBe(1.0);
    });
  });
});

// ─── float64ToFloat16Bits / float16BitsToFloat64 unit tests ──────────────────

describe('float64ToFloat16Bits', () => {
  describe('RN-TE rounding boundaries', () => {
    // float16 has a 10-bit mantissa.
    // Verify rounding at the midpoint between 1.0 (0x3C00) and 1.0009765625 (0x3C01).
    //
    // Unbiased exponent at 1.0 = 0, float16 ULP = 2^(0-10) = 2^-10
    // Midpoint = 1.0 + 0.5 × 2^-10 = 1.0 + 2^-11
    //
    // ties-to-even: 0x3C00 is even → round down
    test('midpoint 1.0 + 0.5 ULP → round down (ties-to-even: even 0x3C00)', () => {
      const mid = 1.0 + 2 ** -11; // exact midpoint, representable in float64
      expect(float64ToFloat16Bits(mid)).toBe(0x3c00);
    });

    // 0x3C01 is odd → midpoint rounds up
    test('midpoint 1.0009765625 + 0.5 ULP → round up (ties-to-even: odd 0x3C01)', () => {
      // 0x3C01 = 1.0 + 2^-10 = 1.0009765625
      // ULP = 2^-10 (same exponent band), 0.5 ULP = 2^-11
      // midpoint = 1.0009765625 + 2^-11
      const base = float16BitsToFloat64(0x3c01); // 1.0009765625
      const halfUlp = 2 ** -11;
      const mid = base + halfUlp;
      expect(float64ToFloat16Bits(mid)).toBe(0x3c02);
    });

    // one float64 ULP below midpoint → round down
    test('1.0 + (0.5 ULP - 1 float64 ULP) → round down', () => {
      // float64 ULP in [1,2) = 2^-52; midpoint - 1 ULP = 1.0 + 2^-11 - 2^-52
      const justBelow = 1.0 + 2 ** -11 - 2 ** -52;
      expect(float64ToFloat16Bits(justBelow)).toBe(0x3c00);
    });

    // one float64 ULP above midpoint → round up
    test('1.0 + (0.5 ULP + 1 float64 ULP) → round up', () => {
      const justAbove = 1.0 + 2 ** -11 + 2 ** -52;
      expect(float64ToFloat16Bits(justAbove)).toBe(0x3c01);
    });

    // mantissa overflow carries into exponent
    test('max mantissa + round → exponent carry (0x3DFF → 0x3E00)', () => {
      // 0x3DFF: sign=0, exp=15, mant=0x3FF → 1.1111111111 × 2^0 = 1.9990234375
      // next float16 = 0x3E00 = 2.0
      // midpoint = (1.9990234375 + 2.0) / 2; 0x3DFF is odd → round up
      const base = float16BitsToFloat64(0x3dff);
      const next = float16BitsToFloat64(0x3e00);
      const mid = (base + next) / 2;
      expect(float64ToFloat16Bits(mid)).toBe(0x3e00);
    });
  });

  describe('denormal rounding boundaries', () => {
    // smallest denormal = 2^-24 (0x0001), next = 2×2^-24 (0x0002)
    // midpoint = 1.5×2^-24; 0x0001 is odd → round up
    test('midpoint of smallest denormal → round up (ties-to-even: odd 0x0001)', () => {
      const mid = 1.5 * 2 ** -24;
      expect(float64ToFloat16Bits(mid)).toBe(0x0002);
    });

    // 0x0002 is even → midpoint rounds down
    test('midpoint of 2×smallest denormal → round down (ties-to-even: even 0x0002)', () => {
      const mid = 2.5 * 2 ** -24;
      expect(float64ToFloat16Bits(mid)).toBe(0x0002);
    });

    // denormal rounds up to smallest normal (0x03FF → 0x0400)
    // 0x03FF is odd → midpoint rounds up
    test('midpoint of largest denormal → smallest normal 0x0400 (ties-to-even)', () => {
      const maxDenormal = float16BitsToFloat64(0x03ff);
      const minNormal = float16BitsToFloat64(0x0400);
      const mid = (maxDenormal + minNormal) / 2;
      expect(float64ToFloat16Bits(mid)).toBe(0x0400);
    });
  });

  describe('special values', () => {
    test('+Infinity → 0x7C00', () => {
      expect(float64ToFloat16Bits(Infinity)).toBe(0x7c00);
    });

    test('-Infinity → 0xFC00', () => {
      expect(float64ToFloat16Bits(-Infinity)).toBe(0xfc00);
    });

    test('NaN → NaN bit pattern (mantissa ≠ 0)', () => {
      const bits = float64ToFloat16Bits(NaN);
      expect(bits & 0x7c00).toBe(0x7c00); // exp all-1s
      expect(bits & 0x03ff).not.toBe(0); // mantissa non-zero
    });

    test('+0 → 0x0000', () => {
      expect(float64ToFloat16Bits(0)).toBe(0x0000);
    });

    test('-0 → 0x8000', () => {
      expect(float64ToFloat16Bits(-0)).toBe(0x8000);
    });
  });
});

// ─── native vs fallback consistency tests ────────────────────────────────────

describe('native vs manual consistency', () => {
  // Test values covering: normals, denormals, special values, and boundary cases
  const testValues = [
    0,
    -0,
    1,
    -1,
    0.5,
    -0.5,
    1.5,
    -1.5,
    2 ** -14, // smallest normal
    2 ** -24, // smallest denormal
    65504, // float16 max finite
    65505, // near max: rounds to 65504 under RN-TE
    65520, // overflow threshold: rounds to +Infinity
    Infinity,
    -Infinity,
    NaN,
    1e-8, // underflow
    1e6, // overflow
    1.0 + 2 ** -25, // below midpoint (rounds down, ties-to-even even side)
    Math.PI,
    -Math.E,
  ];

  test('float64ToFloat16Bits matches DataView.setFloat16 when native is available', () => {
    if (!hasNativeFloat16) {
      // skip on environments without native float16 support
      return;
    }
    const nativeDv = new DataView(new ArrayBuffer(2));
    for (const v of testValues) {
      (nativeDv as DataView).setFloat16(0, v, false);
      const nativeBits = nativeDv.getUint16(0, false);
      const manualBits = float64ToFloat16Bits(v);

      if (isNaN(v)) {
        // NaN sign/payload is implementation-defined; only check exponent all-1s and non-zero mantissa
        expect(manualBits & 0x7c00).toBe(0x7c00);
        expect(manualBits & 0x03ff).not.toBe(0);
      } else {
        expect(manualBits).toBe(nativeBits);
      }
    }
  });

  test('readFloat16(writeFloat16(x)) matches float16-quantized x', () => {
    for (const v of testValues) {
      const dv = makeView(2);
      writeFloat16(dv, 0, v, true);
      const result = readFloat16(dv, 0, true);
      const quantized = float16BitsToFloat64(float64ToFloat16Bits(v));

      if (isNaN(v)) {
        expect(result).toBeNaN();
      } else {
        // verify round-trip matches float16 quantization (covers ±0, subnormals, overflow)
        expect(Object.is(result, quantized)).toBe(true);
      }
    }
  });
});
