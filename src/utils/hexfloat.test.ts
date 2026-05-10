import { describe, test, expect } from 'vitest';
import { parseHexFloat, floatToHexFloat } from './hexfloat';

// ─── parseHexFloat ────────────────────────────────────────────────────────────

describe('parseHexFloat', () => {
  describe('integer mantissa (no fractional part)', () => {
    test('0x1p+0 = 1', () => expect(parseHexFloat('0x1p+0')).toBe(1));
    test('0x1p+1 = 2', () => expect(parseHexFloat('0x1p+1')).toBe(2));
    test('0x1p-1 = 0.5', () => expect(parseHexFloat('0x1p-1')).toBe(0.5));
    test('0x4p+0 = 4', () => expect(parseHexFloat('0x4p+0')).toBe(4));
    test('0x4711p+03 = 145544 (spec example)', () =>
      expect(parseHexFloat('0x4711p+03')).toBe(145544));
    test('0x0p+0 = 0', () =>
      expect(Object.is(parseHexFloat('0x0p+0'), 0)).toBe(true));
  });

  describe('fractional mantissa', () => {
    test('0x1.8p+0 = 1.5', () => expect(parseHexFloat('0x1.8p+0')).toBe(1.5));
    test('0x1.8p+1 = 3', () => expect(parseHexFloat('0x1.8p+1')).toBe(3));
    test('0x1.fp+3 = 15.5', () => expect(parseHexFloat('0x1.fp+3')).toBe(15.5));
    test('0x1.1c44p+17 = 145544', () =>
      expect(parseHexFloat('0x1.1c44p+17')).toBe(145544));
    test('0x1.fffffffffffffp+1023 = Number.MAX_VALUE', () =>
      expect(parseHexFloat('0x1.fffffffffffffp+1023')).toBe(Number.MAX_VALUE));
  });

  describe('negative values', () => {
    test('-0x1p+0 = -1', () => expect(parseHexFloat('-0x1p+0')).toBe(-1));
    test('-0x1.8p+0 = -1.5', () =>
      expect(parseHexFloat('-0x1.8p+0')).toBe(-1.5));
    test('-0x4711p+03 = -145544', () =>
      expect(parseHexFloat('-0x4711p+03')).toBe(-145544));
  });

  describe('uppercase P exponent', () => {
    test('0x1.8P+0 = 1.5', () => expect(parseHexFloat('0x1.8P+0')).toBe(1.5));
    test('0x4711P+03 = 145544', () =>
      expect(parseHexFloat('0x4711P+03')).toBe(145544));
  });

  describe('subnormal numbers', () => {
    test('smallest positive double 0x0.0000000000001p-1022 = 5e-324', () =>
      expect(parseHexFloat('0x0.0000000000001p-1022')).toBe(5e-324));
    test('smallest normal double 0x1p-1022 = 2^-1022', () =>
      expect(parseHexFloat('0x1p-1022')).toBe(2 ** -1022));
  });

  describe('error handling', () => {
    test('missing p exponent throws SyntaxError', () =>
      expect(() => parseHexFloat('0x1.8')).toThrow(SyntaxError));
    test('missing p exponent error message mentions exponent', () =>
      expect(() => parseHexFloat('0x1.8')).toThrow(/exponent/));

    // Exponent present but empty / invalid
    test('0x1p — empty exponent throws SyntaxError', () =>
      expect(() => parseHexFloat('0x1p')).toThrow(SyntaxError));
    test('0x1p+ — sign but no digits throws SyntaxError', () =>
      expect(() => parseHexFloat('0x1p+')).toThrow(SyntaxError));
    test('0x1p- — sign but no digits throws SyntaxError', () =>
      expect(() => parseHexFloat('0x1p-')).toThrow(SyntaxError));

    // No mantissa digits
    test('0x.p+1 — no mantissa digits throws SyntaxError', () =>
      expect(() => parseHexFloat('0x.p+1')).toThrow(SyntaxError));
    test('0xp+0 — no mantissa digits throws SyntaxError', () =>
      expect(() => parseHexFloat('0xp+0')).toThrow(SyntaxError));
  });
});

// ─── floatToHexFloat ──────────────────────────────────────────────────────────

describe('floatToHexFloat', () => {
  describe('non-finite values', () => {
    test('NaN → "NaN"', () => expect(floatToHexFloat(NaN)).toBe('NaN'));
    test('Infinity → "Infinity"', () =>
      expect(floatToHexFloat(Infinity)).toBe('Infinity'));
    test('-Infinity → "-Infinity"', () =>
      expect(floatToHexFloat(-Infinity)).toBe('-Infinity'));
  });

  describe('zero', () => {
    test('+0 → "0x0p+0"', () => expect(floatToHexFloat(0)).toBe('0x0p+0'));
    test('-0 → "-0x0p+0"', () => expect(floatToHexFloat(-0)).toBe('-0x0p+0'));
  });

  describe('powers of two (no fractional hex digits)', () => {
    test('1 → "0x1p+0"', () => expect(floatToHexFloat(1)).toBe('0x1p+0'));
    test('2 → "0x1p+1"', () => expect(floatToHexFloat(2)).toBe('0x1p+1'));
    test('0.5 → "0x1p-1"', () => expect(floatToHexFloat(0.5)).toBe('0x1p-1'));
    test('0.25 → "0x1p-2"', () => expect(floatToHexFloat(0.25)).toBe('0x1p-2'));
    test('1024 → "0x1p+10"', () =>
      expect(floatToHexFloat(1024)).toBe('0x1p+10'));
  });

  describe('values with fractional hex digits', () => {
    test('1.5 → "0x1.8p+0"', () =>
      expect(floatToHexFloat(1.5)).toBe('0x1.8p+0'));
    test('-1.5 → "-0x1.8p+0"', () =>
      expect(floatToHexFloat(-1.5)).toBe('-0x1.8p+0'));
    test('3 → "0x1.8p+1"', () => expect(floatToHexFloat(3)).toBe('0x1.8p+1'));
    test('0.75 → "0x1.8p-1"', () =>
      expect(floatToHexFloat(0.75)).toBe('0x1.8p-1'));
    test('145544 → "0x1.1c44p+17" (spec example)', () =>
      expect(floatToHexFloat(145544)).toBe('0x1.1c44p+17'));
    test('trailing zeros in mantissa are stripped', () => {
      // 1.5 = 0x1.8p+0, not 0x1.80000000000000p+0
      expect(floatToHexFloat(1.5)).toBe('0x1.8p+0');
    });
  });

  describe('negative values', () => {
    test('-1 → "-0x1p+0"', () => expect(floatToHexFloat(-1)).toBe('-0x1p+0'));
    test('-145544 → "-0x1.1c44p+17"', () =>
      expect(floatToHexFloat(-145544)).toBe('-0x1.1c44p+17'));
  });

  describe('subnormal numbers', () => {
    test('smallest positive double (5e-324) → subnormal form', () => {
      const s = floatToHexFloat(5e-324);
      expect(s).toBe('0x0.0000000000001p-1022');
    });
    test('smallest normal double (2^-1022) → normal form', () => {
      expect(floatToHexFloat(2 ** -1022)).toBe('0x1p-1022');
    });
    test('subnormal output starts with "0x0."', () => {
      expect(floatToHexFloat(5e-324).startsWith('0x0.')).toBe(true);
    });
    test('normal output starts with "0x1"', () => {
      expect(floatToHexFloat(1.5).startsWith('0x1')).toBe(true);
    });
  });
});

// ─── round-trip: parseHexFloat(floatToHexFloat(v)) === v ─────────────────────

describe('round-trip: parseHexFloat(floatToHexFloat(v))', () => {
  const finiteValues = [
    0,
    1,
    -1,
    0.5,
    1.5,
    -1.5,
    2,
    0.25,
    0.75,
    145544,
    -145544,
    1 / 3,
    Math.PI,
    -Math.E,
    Number.MAX_VALUE,
    Number.MIN_VALUE, // smallest positive subnormal
    2 ** -1022, // smallest normal double
    1e100,
    1e-100,
    1.0000000000000002, // 1 + epsilon (1 ULP above 1)
  ];

  for (const v of finiteValues) {
    test(`round-trips ${v}`, () => {
      const hex = floatToHexFloat(v);
      const back = parseHexFloat(hex);
      expect(Object.is(back, v)).toBe(true);
    });
  }

  test('+0 round-trips as +0', () => {
    expect(Object.is(parseHexFloat(floatToHexFloat(0)), 0)).toBe(true);
  });

  test('-0 round-trips as -0', () => {
    expect(Object.is(parseHexFloat(floatToHexFloat(-0)), -0)).toBe(true);
  });
});
