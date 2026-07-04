import { describe, test, expect } from 'vitest';
import { encodeCBOR } from './encoder';
import { decodeCBOR } from './decoder';
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

/** Convert a hex string (spaces allowed) to Uint8Array. */
function hex(s: string): Uint8Array {
  s = s.replace(/\s+/g, '');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2)
    out[i / 2] = parseInt(s.slice(i, i + 2), 16);
  return out;
}

/** Convert Uint8Array to lowercase hex string. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── RFC 8949 Appendix A — encode direction ───────────────────────────────────

describe('unsigned integers — encode (RFC 8949 Appendix A)', () => {
  const cases: [bigint, string][] = [
    [0n, '00'],
    [1n, '01'],
    [10n, '0a'],
    [23n, '17'],
    [24n, '1818'],
    [25n, '1819'],
    [100n, '1864'],
    [1000n, '1903e8'],
    [1_000_000n, '1a000f4240'],
    [1_000_000_000_000n, '1b000000e8d4a51000'],
    [18_446_744_073_709_551_615n, '1bffffffffffffffff'],
  ];

  for (const [value, expected] of cases) {
    test(`CborUint(${value}) → 0x${expected}`, () => {
      expect(toHex(new CborUint(value).toCBOR())).toBe(expected);
    });
  }
});

describe('negative integers — encode (RFC 8949 Appendix A)', () => {
  const cases: [bigint, string][] = [
    [-1n, '20'],
    [-10n, '29'],
    [-100n, '3863'],
    [-1000n, '3903e7'],
  ];

  for (const [value, expected] of cases) {
    test(`CborNint(${value}) → 0x${expected}`, () => {
      expect(toHex(new CborNint(value).toCBOR())).toBe(expected);
    });
  }
});

describe('floating-point — encode (RFC 8949 Appendix A)', () => {
  test('0.0 → f90000 (half, auto)', () => {
    expect(toHex(new CborFloat(0.0).toCBOR())).toBe('f90000');
  });

  test('-0.0 → f98000 (half, auto)', () => {
    expect(toHex(new CborFloat(-0.0).toCBOR())).toBe('f98000');
  });

  test('1.0 → f93c00 (half, auto)', () => {
    expect(toHex(new CborFloat(1.0).toCBOR())).toBe('f93c00');
  });

  test('1.5 → f93e00 (half, auto)', () => {
    expect(toHex(new CborFloat(1.5).toCBOR())).toBe('f93e00');
  });

  test('Infinity → f97c00 (half, auto)', () => {
    expect(toHex(new CborFloat(Infinity).toCBOR())).toBe('f97c00');
  });

  test('-Infinity → f9fc00 (half, auto)', () => {
    expect(toHex(new CborFloat(-Infinity).toCBOR())).toBe('f9fc00');
  });

  test('NaN → f97e00 (half, auto)', () => {
    expect(toHex(new CborFloat(NaN).toCBOR())).toBe('f97e00');
  });

  test('100000.0 → fa47c35000 (single, auto)', () => {
    expect(toHex(new CborFloat(100000.0).toCBOR())).toBe('fa47c35000');
  });

  test('1.1 → fb3ff199999999999a (double, auto)', () => {
    expect(toHex(new CborFloat(1.1).toCBOR())).toBe('fb3ff199999999999a');
  });

  test('-4.1 → fbc010666666666666 (double, auto)', () => {
    expect(toHex(new CborFloat(-4.1).toCBOR())).toBe('fbc010666666666666');
  });
});

describe('byte strings — encode', () => {
  test('empty → 40', () => {
    expect(toHex(new CborByteString(new Uint8Array()).toCBOR())).toBe('40');
  });

  test('[01,02,03,04] → 4401020304', () => {
    expect(
      toHex(new CborByteString(new Uint8Array([1, 2, 3, 4])).toCBOR())
    ).toBe('4401020304');
  });

  test("indefinite (_ h'0102', h'030405') → 5f420102 43030405 ff", () => {
    const node = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([0x01, 0x02])),
      new CborByteString(new Uint8Array([0x03, 0x04, 0x05])),
    ]);
    expect(toHex(node.toCBOR())).toBe('5f420102' + '43030405' + 'ff');
  });
});

describe('text strings — encode', () => {
  test('"" → 60', () => {
    expect(toHex(new CborTextString('').toCBOR())).toBe('60');
  });

  test('"a" → 6161', () => {
    expect(toHex(new CborTextString('a').toCBOR())).toBe('6161');
  });

  test('"IETF" → 6449455446', () => {
    expect(toHex(new CborTextString('IETF').toCBOR())).toBe('6449455446');
  });

  test('"\\"\\\\\" → 62225c', () => {
    expect(toHex(new CborTextString('"\\').toCBOR())).toBe('62225c');
  });

  test('"\u00fc" → 62c3bc', () => {
    expect(toHex(new CborTextString('\u00fc').toCBOR())).toBe('62c3bc');
  });

  test('"\u6c34" → 63e6b0b4', () => {
    expect(toHex(new CborTextString('\u6c34').toCBOR())).toBe('63e6b0b4');
  });

  test('indefinite (_ "strea","ming") → 7f...ff', () => {
    const node = new CborIndefiniteTextString([
      new CborTextString('strea'),
      new CborTextString('ming'),
    ]);
    expect(toHex(node.toCBOR())).toBe(
      '7f' + '657374726561' + '646d696e67' + 'ff'
    );
  });

  // Multi-byte strings whose UTF-8 length needs a wider head than the UTF-16
  // length predicts — exercises the head-size fixup in writeTextString().
  describe('head-width boundary crossings (UTF-16 length vs UTF-8 length)', () => {
    test('12 × "あ" (UTF-16 len 12 → 36 bytes): head grows 1 → 2 bytes', () => {
      const s = 'あ'.repeat(12);
      const bytes = new CborTextString(s).toCBOR();
      expect(bytes[0]).toBe(0x78); // MT3, AI 24 (1-byte length)
      expect(bytes[1]).toBe(36);
      expect(bytes.length).toBe(2 + 36);
      expect(decodeCBOR(bytes).toJS()).toBe(s);
    });

    test('100 × "あ" (UTF-16 len 100 → 300 bytes): head grows 2 → 3 bytes', () => {
      const s = 'あ'.repeat(100);
      const bytes = new CborTextString(s).toCBOR();
      expect(bytes[0]).toBe(0x79); // MT3, AI 25 (2-byte length)
      expect((bytes[1] << 8) | bytes[2]).toBe(300);
      expect(decodeCBOR(bytes).toJS()).toBe(s);
    });

    test('30000 × "あ" (UTF-16 len 30000 → 90000 bytes): head grows 3 → 5 bytes', () => {
      const s = 'あ'.repeat(30000);
      const bytes = new CborTextString(s).toCBOR();
      expect(bytes[0]).toBe(0x7a); // MT3, AI 26 (4-byte length)
      expect(decodeCBOR(bytes).toJS()).toBe(s);
    });

    test('surrogate pair "🎉" (UTF-16 len 2 → 4 bytes)', () => {
      const bytes = new CborTextString('🎉').toCBOR();
      expect(toHex(bytes)).toBe('64f09f8e89');
    });

    test('string after a boundary-crossing string keeps correct offsets', () => {
      const node = new CborArray([
        new CborTextString('あ'.repeat(12)),
        new CborTextString('tail'),
      ]);
      expect(decodeCBOR(node.toCBOR()).toJS()).toEqual([
        'あ'.repeat(12),
        'tail',
      ]);
    });
  });

  test('explicit encodingWidth too small for UTF-8 length throws RangeError', () => {
    // UTF-16 length 23 fits _i, but the UTF-8 length (69) does not.
    const node = new CborTextString('あ'.repeat(23), { encodingWidth: 'i' });
    expect(() => node.toCBOR()).toThrow(RangeError);
  });

  test('explicit wider encodingWidth is honored', () => {
    const bytes = new CborTextString('a', { encodingWidth: 1 }).toCBOR();
    expect(toHex(bytes)).toBe('79000161');
  });
});

describe('arrays — encode', () => {
  test('[] → 80', () => {
    expect(toHex(new CborArray([]).toCBOR())).toBe('80');
  });

  test('[1,2,3] → 83010203', () => {
    const node = new CborArray([
      new CborUint(1),
      new CborUint(2),
      new CborUint(3),
    ]);
    expect(toHex(node.toCBOR())).toBe('83010203');
  });

  test('[1,[2,3],[4,5]] → 8301820203820405', () => {
    const node = new CborArray([
      new CborUint(1),
      new CborArray([new CborUint(2), new CborUint(3)]),
      new CborArray([new CborUint(4), new CborUint(5)]),
    ]);
    expect(toHex(node.toCBOR())).toBe('8301820203820405');
  });

  test('[_ ] → 9fff', () => {
    expect(toHex(new CborArray([], { indefiniteLength: true }).toCBOR())).toBe(
      '9fff'
    );
  });

  test('[_ 1,[2,3],[_ 4,5]] → 9f01820203 9f0405ff ff', () => {
    const node = new CborArray(
      [
        new CborUint(1),
        new CborArray([new CborUint(2), new CborUint(3)]),
        new CborArray([new CborUint(4), new CborUint(5)], {
          indefiniteLength: true,
        }),
      ],
      { indefiniteLength: true }
    );
    expect(toHex(node.toCBOR())).toBe('9f01820203' + '9f0405ff' + 'ff');
  });
});

describe('maps — encode', () => {
  test('{} → a0', () => {
    expect(toHex(new CborMap([]).toCBOR())).toBe('a0');
  });

  test('{1:2, 3:4} → a201020304', () => {
    const node = new CborMap([
      [new CborUint(1), new CborUint(2)],
      [new CborUint(3), new CborUint(4)],
    ]);
    expect(toHex(node.toCBOR())).toBe('a201020304');
  });

  test('{_ "a":1,"b":[_2,3]} → bf 6161 01 6162 9f0203ff ff', () => {
    const node = new CborMap(
      [
        [new CborTextString('a'), new CborUint(1)],
        [
          new CborTextString('b'),
          new CborArray([new CborUint(2), new CborUint(3)], {
            indefiniteLength: true,
          }),
        ],
      ],
      { indefiniteLength: true }
    );
    expect(toHex(node.toCBOR())).toBe(
      'bf' + '616101' + '6162' + '9f0203ff' + 'ff'
    );
  });
});

describe('tags — encode', () => {
  test('0("2013-03-21T20:04:00Z") → c074...', () => {
    const node = new CborTag(0n, new CborTextString('2013-03-21T20:04:00Z'));
    expect(toHex(node.toCBOR())).toBe(
      'c074323031332d30332d32315432303a30343a30305a'
    );
  });

  test('1(1363896240) → c11a514b67b0', () => {
    const node = new CborTag(1n, new CborUint(1363896240n));
    expect(toHex(node.toCBOR())).toBe('c11a514b67b0');
  });

  test("23(h'01020304') → d74401020304", () => {
    const node = new CborTag(
      23n,
      new CborByteString(new Uint8Array([1, 2, 3, 4]))
    );
    expect(toHex(node.toCBOR())).toBe('d74401020304');
  });
});

describe('simple values — encode', () => {
  test('false → f4', () => {
    expect(toHex(CborSimple.FALSE.toCBOR())).toBe('f4');
  });
  test('true  → f5', () => {
    expect(toHex(CborSimple.TRUE.toCBOR())).toBe('f5');
  });
  test('null  → f6', () => {
    expect(toHex(CborSimple.NULL.toCBOR())).toBe('f6');
  });
  test('undef → f7', () => {
    expect(toHex(CborSimple.UNDEFINED.toCBOR())).toBe('f7');
  });
  test('simple(16) → f0', () => {
    expect(toHex(new CborSimple(16).toCBOR())).toBe('f0');
  });
  test('simple(255) → f8ff', () => {
    expect(toHex(new CborSimple(255).toCBOR())).toBe('f8ff');
  });
});

// ─── Explicit precision overrides ────────────────────────────────────────────

describe('CborFloat explicit precision', () => {
  test('1.0 with precision=half → f93c00', () => {
    expect(toHex(new CborFloat(1.0, { precision: 'half' }).toCBOR())).toBe(
      'f93c00'
    );
  });

  test('1.0 with precision=single → fa3f800000', () => {
    expect(toHex(new CborFloat(1.0, { precision: 'single' }).toCBOR())).toBe(
      'fa3f800000'
    );
  });

  test('1.0 with precision=double → fb3ff0000000000000', () => {
    expect(toHex(new CborFloat(1.0, { precision: 'double' }).toCBOR())).toBe(
      'fb3ff0000000000000'
    );
  });
});

// ─── Byte-exact round-trip: encode(decode(bytes)) === bytes ──────────────────

describe('byte-exact round-trip (RFC 8949 Appendix A)', () => {
  // All RFC 8949 Appendix A test vectors — encoding must reproduce the exact bytes
  const vectors = [
    '00',
    '01',
    '0a',
    '17',
    '1818',
    '1819',
    '1864',
    '1903e8',
    '1a000f4240',
    '1b000000e8d4a51000',
    '1bffffffffffffffff',
    '20',
    '29',
    '3863',
    '3903e7',
    'f90000',
    'f98000',
    'f93c00',
    'fb3ff199999999999a',
    'f93e00',
    'fbc010666666666666',
    'f97c00',
    'f97e00',
    'f9fc00',
    'fa47c35000',
    'fa7f7fffff',
    'fb7e37e43c8800759c',
    'f90001',
    'f90400',
    'f9c400',
    '40',
    '4401020304',
    '60',
    '6161',
    '6449455446',
    '62225c',
    '62c3bc',
    '63e6b0b4',
    '64f0908591',
    '80',
    '83010203',
    '8301820203820405',
    '98190102030405060708090a0b0c0d0e0f101112131415161718181819',
    'a0',
    'a201020304',
    'a26161016162820203',
    'c074323031332d30332d32315432303a30343a30305a',
    'c11a514b67b0',
    'd74401020304',
    'd818456449455446',
    'd82076687474703a2f2f7777772e6578616d706c652e636f6d',
    'f4',
    'f5',
    'f6',
    'f7',
    'f0',
    'f8ff',
    // indefinite-length
    '5f42010243030405ff',
    '7f657374726561646d696e67ff',
    '9fff',
    '9f018202039f0405ffff',
    '9f01820203820405ff',
    '83018202039f0405ff',
    '83019f0203ff820405',
    '9f0102030405060708090a0b0c0d0e0f101112131415161718181819ff',
    'bf61610161629f0203ffff',
    '826161bf61626163ff',
    'bf6346756ef563416d7421ff',
  ];

  for (const h of vectors) {
    test(`round-trip 0x${h.slice(0, 16)}${h.length > 16 ? '…' : ''}`, () => {
      const original = hex(h);
      const reencoded = decodeCBOR(original).toCBOR();
      expect(toHex(reencoded)).toBe(h);
    });
  }
});

// ─── encodeCBOR convenience function ─────────────────────────────────────────

describe('encodeCBOR()', () => {
  test('delegates to toCBOR()', () => {
    const node = new CborUint(42n);
    expect(encodeCBOR(node)).toEqual(node.toCBOR());
  });
});
