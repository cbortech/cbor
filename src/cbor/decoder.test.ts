import { describe, test, expect } from 'vitest';
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
  const result = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    result[i / 2] = parseInt(s.slice(i, i + 2), 16);
  }
  return result;
}

// ─── RFC 8949 Appendix A — Unsigned integers ──────────────────────────────────

describe('unsigned integers (RFC 8949 Appendix A)', () => {
  const cases: [string, bigint][] = [
    ['00', 0n],
    ['01', 1n],
    ['0a', 10n],
    ['17', 23n],
    ['1818', 24n],
    ['1819', 25n],
    ['1864', 100n],
    ['1903e8', 1000n],
    ['1a000f4240', 1_000_000n],
    ['1b000000e8d4a51000', 1_000_000_000_000n],
    ['1bffffffffffffffff', 18_446_744_073_709_551_615n],
  ];

  for (const [h, expected] of cases) {
    test(`0x${h} → CborUint(${expected})`, () => {
      const result = decodeCBOR(hex(h));
      expect(result).toBeInstanceOf(CborUint);
      expect((result as CborUint).value).toBe(expected);
    });
  }
});

// ─── RFC 8949 Appendix A — Negative integers ─────────────────────────────────

describe('negative integers (RFC 8949 Appendix A)', () => {
  const cases: [string, bigint][] = [
    ['20', -1n],
    ['29', -10n],
    ['3863', -100n],
    ['3903e7', -1000n],
  ];

  for (const [h, expected] of cases) {
    test(`0x${h} → CborNint(${expected})`, () => {
      const result = decodeCBOR(hex(h));
      expect(result).toBeInstanceOf(CborNint);
      expect((result as CborNint).value).toBe(expected);
    });
  }
});

// ─── RFC 8949 Appendix A — Floating-point numbers ────────────────────────────

describe('floating-point numbers (RFC 8949 Appendix A)', () => {
  test('f90000 → CborFloat(0.0, half)', () => {
    const r = decodeCBOR(hex('f90000')) as CborFloat;
    expect(r).toBeInstanceOf(CborFloat);
    expect(Object.is(r.value, 0)).toBe(true);
    expect(r.precision).toBe('half');
  });

  test('f98000 → CborFloat(-0.0, half)', () => {
    const r = decodeCBOR(hex('f98000')) as CborFloat;
    expect(Object.is(r.value, -0)).toBe(true);
    expect(r.precision).toBe('half');
  });

  test('f93c00 → CborFloat(1.0, half)', () => {
    const r = decodeCBOR(hex('f93c00')) as CborFloat;
    expect(r.value).toBe(1.0);
    expect(r.precision).toBe('half');
  });

  test('fb3ff199999999999a → CborFloat(1.1, double)', () => {
    const r = decodeCBOR(hex('fb 3f f1 99 99 99 99 99 9a')) as CborFloat;
    expect(r.value).toBe(1.1);
    expect(r.precision).toBe('double');
  });

  test('f93e00 → CborFloat(1.5, half)', () => {
    const r = decodeCBOR(hex('f93e00')) as CborFloat;
    expect(r.value).toBe(1.5);
    expect(r.precision).toBe('half');
  });

  test('fbc010666666666666 → CborFloat(-4.1, double)', () => {
    const r = decodeCBOR(hex('fb c0 10 66 66 66 66 66 66')) as CborFloat;
    expect(r.value).toBe(-4.1);
    expect(r.precision).toBe('double');
  });

  test('f97c00 → CborFloat(+Infinity, half)', () => {
    const r = decodeCBOR(hex('f97c00')) as CborFloat;
    expect(r.value).toBe(Infinity);
    expect(r.precision).toBe('half');
  });

  test('f97e00 → CborFloat(NaN, half)', () => {
    const r = decodeCBOR(hex('f97e00')) as CborFloat;
    expect(r.value).toBeNaN();
    expect(r.precision).toBe('half');
  });

  test('f9fc00 → CborFloat(-Infinity, half)', () => {
    const r = decodeCBOR(hex('f9fc00')) as CborFloat;
    expect(r.value).toBe(-Infinity);
    expect(r.precision).toBe('half');
  });

  test('fa47c35000 → CborFloat(100000.0, single)', () => {
    const r = decodeCBOR(hex('fa47c35000')) as CborFloat;
    expect(r.value).toBe(100000.0);
    expect(r.precision).toBe('single');
  });

  test('fa7f7fffff → CborFloat(3.4028234663852886e+38, single)', () => {
    const r = decodeCBOR(hex('fa7f7fffff')) as CborFloat;
    expect(r.value).toBeCloseTo(3.4028234663852886e38, 30);
    expect(r.precision).toBe('single');
  });

  test('fb7e37e43c8800759c → CborFloat(1.0e+300, double)', () => {
    const r = decodeCBOR(hex('fb 7e 37 e4 3c 88 00 75 9c')) as CborFloat;
    expect(r.value).toBe(1.0e300);
    expect(r.precision).toBe('double');
  });

  test('f90001 → CborFloat(min half denormal, half)', () => {
    const r = decodeCBOR(hex('f90001')) as CborFloat;
    expect(r.value).toBe(5.960464477539063e-8);
    expect(r.precision).toBe('half');
  });

  test('f90400 → CborFloat(min half normal, half)', () => {
    const r = decodeCBOR(hex('f90400')) as CborFloat;
    expect(r.value).toBe(6.103515625e-5);
    expect(r.precision).toBe('half');
  });

  test('f9c400 → CborFloat(-4.0, half)', () => {
    const r = decodeCBOR(hex('f9c400')) as CborFloat;
    expect(r.value).toBe(-4.0);
    expect(r.precision).toBe('half');
  });
});

// ─── RFC 8949 Appendix A — Byte strings ──────────────────────────────────────

describe('byte strings (RFC 8949 Appendix A)', () => {
  test('40 → CborByteString(empty)', () => {
    const r = decodeCBOR(hex('40')) as CborByteString;
    expect(r).toBeInstanceOf(CborByteString);
    expect(r.value).toHaveLength(0);
  });

  test('4401020304 → CborByteString([01,02,03,04])', () => {
    const r = decodeCBOR(hex('4401020304')) as CborByteString;
    expect(r.value).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
  });
});

// ─── RFC 8949 Appendix A — Text strings ──────────────────────────────────────

describe('text strings (RFC 8949 Appendix A)', () => {
  const cases: [string, string][] = [
    ['60', ''],
    ['6161', 'a'],
    ['6449455446', 'IETF'],
    ['62225c', '"\\'],
    ['62c3bc', '\u00fc'], // ü
    ['63e6b0b4', '\u6c34'], // 水
    ['64f0908591', '\ud800\udd51'], // 𐅑 (U+10151, surrogate pair in JS)
  ];

  for (const [h, expected] of cases) {
    test(`0x${h} → CborTextString(${JSON.stringify(expected)})`, () => {
      const r = decodeCBOR(hex(h)) as CborTextString;
      expect(r).toBeInstanceOf(CborTextString);
      expect(r.value).toBe(expected);
    });
  }
});

// ─── RFC 8949 Appendix A — Arrays ────────────────────────────────────────────

describe('arrays (RFC 8949 Appendix A)', () => {
  test('80 → CborArray([])', () => {
    const r = decodeCBOR(hex('80')) as CborArray;
    expect(r).toBeInstanceOf(CborArray);
    expect(r.items).toHaveLength(0);
    expect(r.indefiniteLength).toBe(false);
  });

  test('83010203 → CborArray([1, 2, 3])', () => {
    const r = decodeCBOR(hex('83010203')) as CborArray;
    expect(r.items).toHaveLength(3);
    expect((r.items[0] as CborUint).value).toBe(1n);
    expect((r.items[1] as CborUint).value).toBe(2n);
    expect((r.items[2] as CborUint).value).toBe(3n);
  });

  test('8301820203820405 → CborArray([1, [2, 3], [4, 5]])', () => {
    const r = decodeCBOR(hex('8301820203820405')) as CborArray;
    expect(r.items).toHaveLength(3);
    expect((r.items[0] as CborUint).value).toBe(1n);
    const inner1 = r.items[1] as CborArray;
    expect(inner1.items).toHaveLength(2);
    expect((inner1.items[0] as CborUint).value).toBe(2n);
    const inner2 = r.items[2] as CborArray;
    expect((inner2.items[0] as CborUint).value).toBe(4n);
  });

  test('9819... → CborArray([1..25])', () => {
    const data = hex(
      '98 19 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18 18 18 19'
    );
    const r = decodeCBOR(data) as CborArray;
    expect(r.items).toHaveLength(25);
    for (let i = 0; i < 25; i++) {
      expect((r.items[i] as CborUint).value).toBe(BigInt(i + 1));
    }
  });
});

// ─── RFC 8949 Appendix A — Maps ──────────────────────────────────────────────

describe('maps (RFC 8949 Appendix A)', () => {
  test('a0 → CborMap({})', () => {
    const r = decodeCBOR(hex('a0')) as CborMap;
    expect(r).toBeInstanceOf(CborMap);
    expect(r.entries).toHaveLength(0);
    expect(r.indefiniteLength).toBe(false);
  });

  test('a201020304 → CborMap({1:2, 3:4})', () => {
    const r = decodeCBOR(hex('a201020304')) as CborMap;
    expect(r.entries).toHaveLength(2);
    expect((r.entries[0][0] as CborUint).value).toBe(1n);
    expect((r.entries[0][1] as CborUint).value).toBe(2n);
    expect((r.entries[1][0] as CborUint).value).toBe(3n);
    expect((r.entries[1][1] as CborUint).value).toBe(4n);
  });

  test('a26161016162820203 → CborMap({"a":1, "b":[2,3]})', () => {
    const r = decodeCBOR(hex('a2 61 61 01 61 62 82 02 03')) as CborMap;
    expect(r.entries).toHaveLength(2);
    expect((r.entries[0][0] as CborTextString).value).toBe('a');
    expect((r.entries[0][1] as CborUint).value).toBe(1n);
    expect((r.entries[1][0] as CborTextString).value).toBe('b');
    const arr = r.entries[1][1] as CborArray;
    expect(arr.items).toHaveLength(2);
  });
});

// ─── RFC 8949 Appendix A — Tags ──────────────────────────────────────────────

describe('tags (RFC 8949 Appendix A)', () => {
  test('c0 74 32303133... → CborTag(0, "2013-03-21T20:04:00Z")', () => {
    const r = decodeCBOR(
      hex('c0 74 32 30 31 33 2d 30 33 2d 32 31 54 32 30 3a 30 34 3a 30 30 5a')
    ) as CborTag;
    expect(r).toBeInstanceOf(CborTag);
    expect(r.tag).toBe(0n);
    expect((r.content as CborTextString).value).toBe('2013-03-21T20:04:00Z');
  });

  test('c11a514b67b0 → CborTag(1, 1363896240)', () => {
    const r = decodeCBOR(hex('c11a514b67b0')) as CborTag;
    expect(r.tag).toBe(1n);
    expect((r.content as CborUint).value).toBe(1363896240n);
  });

  test("d74401020304 → CborTag(23, h'01020304')", () => {
    const r = decodeCBOR(hex('d74401020304')) as CborTag;
    expect(r.tag).toBe(23n);
    expect((r.content as CborByteString).value).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
  });

  test('d82076... → CborTag(32, "http://www.example.com")', () => {
    const r = decodeCBOR(
      hex('d820 76 68747470 3a2f2f77 77772e65 78616d70 6c652e63 6f6d')
    ) as CborTag;
    expect(r.tag).toBe(32n);
    expect((r.content as CborTextString).value).toBe('http://www.example.com');
  });
});

// ─── RFC 8949 Appendix A — Simple values ─────────────────────────────────────

describe('simple values (RFC 8949 Appendix A)', () => {
  test('f4 → false', () => {
    const r = decodeCBOR(hex('f4'));
    expect(r).toBeInstanceOf(CborSimple);
    expect((r as CborSimple).value).toBe(20);
  });

  test('f5 → true', () => {
    const r = decodeCBOR(hex('f5'));
    expect((r as CborSimple).value).toBe(21);
  });

  test('f6 → null', () => {
    const r = decodeCBOR(hex('f6'));
    expect((r as CborSimple).value).toBe(22);
  });

  test('f7 → undefined', () => {
    const r = decodeCBOR(hex('f7'));
    expect((r as CborSimple).value).toBe(23);
  });

  test('f0 → simple(16)', () => {
    const r = decodeCBOR(hex('f0')) as CborSimple;
    expect(r.value).toBe(16);
  });

  test('f8ff → simple(255)', () => {
    const r = decodeCBOR(hex('f8ff')) as CborSimple;
    expect(r.value).toBe(255);
  });
});

// ─── RFC 8949 Appendix A — Indefinite-length ─────────────────────────────────

describe('indefinite-length (RFC 8949 Appendix A)', () => {
  test("5f 4201 02 43 03 04 05 ff → (_ h'0102', h'030405')", () => {
    const r = decodeCBOR(
      hex('5f 42 01 02 43 03 04 05 ff')
    ) as CborIndefiniteByteString;
    expect(r).toBeInstanceOf(CborIndefiniteByteString);
    expect(r.indefiniteLength).toBe(true);
    expect(r.chunks).toHaveLength(2);
    expect(r.chunks[0].value).toEqual(new Uint8Array([0x01, 0x02]));
    expect(r.chunks[1].value).toEqual(new Uint8Array([0x03, 0x04, 0x05]));
  });

  test('7f 65"strea" 64"ming" ff → (_ "strea", "ming")', () => {
    const r = decodeCBOR(
      hex('7f 65 73 74 72 65 61 64 6d 69 6e 67 ff')
    ) as CborIndefiniteTextString;
    expect(r).toBeInstanceOf(CborIndefiniteTextString);
    expect(r.indefiniteLength).toBe(true);
    expect(r.chunks).toHaveLength(2);
    expect(r.chunks[0].value).toBe('strea');
    expect(r.chunks[1].value).toBe('ming');
  });

  test('9fff → [_ ] (empty indefinite array)', () => {
    const r = decodeCBOR(hex('9fff')) as CborArray;
    expect(r).toBeInstanceOf(CborArray);
    expect(r.indefiniteLength).toBe(true);
    expect(r.items).toHaveLength(0);
  });

  test('9f 01 82 02 03 9f 04 05 ff ff → [_ 1, [2, 3], [_ 4, 5]]', () => {
    const r = decodeCBOR(hex('9f 01 82 02 03 9f 04 05 ff ff')) as CborArray;
    expect(r.indefiniteLength).toBe(true);
    expect(r.items).toHaveLength(3);
    expect((r.items[0] as CborUint).value).toBe(1n);
    const inner2 = r.items[2] as CborArray;
    expect(inner2.indefiniteLength).toBe(true);
    expect((inner2.items[0] as CborUint).value).toBe(4n);
  });

  test('bf 6161 01 6162 9f0203ff ff → {_ "a":1, "b":[_ 2,3]}', () => {
    const r = decodeCBOR(hex('bf 61 61 01 61 62 9f 02 03 ff ff')) as CborMap;
    expect(r).toBeInstanceOf(CborMap);
    expect(r.indefiniteLength).toBe(true);
    expect(r.entries).toHaveLength(2);
    expect((r.entries[0][0] as CborTextString).value).toBe('a');
    const bVal = r.entries[1][1] as CborArray;
    expect(bVal.indefiniteLength).toBe(true);
    expect(bVal.items).toHaveLength(2);
  });

  test('indefinite array containing definite subarrays', () => {
    // [_ 1, [2, 3], [4, 5]]
    const r = decodeCBOR(hex('9f 01 82 02 03 82 04 05 ff')) as CborArray;
    expect(r.indefiniteLength).toBe(true);
    expect((r.items[1] as CborArray).indefiniteLength).toBe(false);
  });

  test('definite array containing indefinite subarray', () => {
    // [1, [2, 3], [_ 4, 5]]
    const r = decodeCBOR(hex('83 01 82 02 03 9f 04 05 ff')) as CborArray;
    expect(r.indefiniteLength).toBe(false);
    expect((r.items[2] as CborArray).indefiniteLength).toBe(true);
  });
});

// ─── Offset / trailing input ─────────────────────────────────────────────────

describe('offset and trailing input', () => {
  test('allowTrailing decodes one item and reports byte offsets', () => {
    const first = decodeCBOR(hex('01 02'), {
      allowTrailing: true,
    }) as CborUint;
    expect(first.value).toBe(1n);
    expect(first.start).toBe(0);
    expect(first.end).toBe(1);

    const second = decodeCBOR(hex('01 02'), {
      offset: first.end,
      allowTrailing: true,
    }) as CborUint;
    expect(second.value).toBe(2n);
    expect(second.start).toBe(1);
    expect(second.end).toBe(2);
  });

  test('offset starts decoding from the requested byte position', () => {
    const n = decodeCBOR(hex('00 18 18'), { offset: 1 }) as CborUint;
    expect(n.value).toBe(24n);
    expect(n.start).toBe(1);
    expect(n.end).toBe(3);
  });

  test('trailing bytes still throw unless allowTrailing is true', () => {
    expect(() => decodeCBOR(hex('01 02'), { offset: 0 })).toThrow(
      'CBOR decode error: 1 trailing byte(s) after end of CBOR item'
    );
  });

  test('last sequence item can omit allowTrailing to catch unexpected data', () => {
    const first = decodeCBOR(hex('01 02 03'), {
      allowTrailing: true,
    }) as CborUint;
    const last = decodeCBOR(hex('01 02'), { offset: first.end }) as CborUint;
    expect(last.value).toBe(2n);
    expect(last.end).toBe(2);

    expect(() => decodeCBOR(hex('01 02 03'), { offset: first.end })).toThrow(
      'CBOR decode error: 1 trailing byte(s) after end of CBOR item'
    );
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('error handling', () => {
  test('empty input throws', () => {
    expect(() => decodeCBOR(hex(''))).toThrow('CBOR decode error');
  });

  test('truncated integer (0x1818 with only 1 byte) throws', () => {
    expect(() => decodeCBOR(hex('18'))).toThrow('CBOR decode error');
  });

  test('truncated byte string throws', () => {
    // 0x43 says 3-byte string but only 2 bytes follow
    expect(() => decodeCBOR(hex('43 01 02'))).toThrow('CBOR decode error');
  });

  test('truncated text string throws', () => {
    expect(() => decodeCBOR(hex('62 61'))).toThrow('CBOR decode error');
  });

  test('indefinite byte string with wrong chunk type throws', () => {
    // 0x5f then a text chunk instead of byte chunk
    expect(() => decodeCBOR(hex('5f 61 61 ff'))).toThrow('CBOR decode error');
  });

  test('indefinite text string with wrong chunk type throws', () => {
    // 0x7f then a byte chunk instead of text chunk
    expect(() => decodeCBOR(hex('7f 41 61 ff'))).toThrow('CBOR decode error');
  });

  test('trailing bytes throw', () => {
    // valid 0x01 followed by extra 0x00
    expect(() => decodeCBOR(hex('01 00'))).toThrow(
      'CBOR decode error: 1 trailing byte(s) after end of CBOR item'
    );
  });

  test('standalone break code throws', () => {
    expect(() => decodeCBOR(hex('ff'))).toThrow('CBOR decode error');
  });

  test('reserved simple value (0xf818) throws', () => {
    // simple value 24 encoded as 0xf8 0x18 → invalid (must use 0xf8 with value >= 32)
    expect(() => decodeCBOR(hex('f8 18'))).toThrow('CBOR decode error');
  });

  test('invalid UTF-8 in text string throws', () => {
    // 0x62 = 2-byte text string, then 0x80 0x80 = invalid UTF-8 continuation bytes
    expect(() => decodeCBOR(hex('62 80 80'))).toThrow('CBOR decode error');
  });
});

// ─── Non-zero byteOffset input ────────────────────────────────────────────────

describe('input with non-zero byteOffset', () => {
  test('decodes correctly when Uint8Array has byteOffset > 0', () => {
    // Build a buffer with 2 padding bytes then the CBOR data for 0x01
    const fullBuffer = new Uint8Array([0x00, 0x00, 0x01]).buffer;
    const slice = new Uint8Array(fullBuffer, 2, 1); // byteOffset = 2
    const r = decodeCBOR(slice) as CborUint;
    expect(r.value).toBe(1n);
  });

  test('decodes byte string with non-zero byteOffset', () => {
    const fullBuffer = new Uint8Array([0x00, 0x43, 0x01, 0x02, 0x03]).buffer;
    const slice = new Uint8Array(fullBuffer, 1, 4);
    const r = decodeCBOR(slice) as CborByteString;
    expect(r.value).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
  });
});
