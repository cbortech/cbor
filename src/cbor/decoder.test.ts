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
import { CborEmbeddedCBOR } from '../ast/CborEmbeddedCBOR';
import { CborBigUint } from '../ast/CborBignum';
import { dt, CborTaggedEpochDtExt } from '../extensions/dt';
import { BUILTIN_EXTENSIONS } from '../extensions/builtins';

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

// ─── Trailing bytes — strict: false (CBOR Sequence lenient mode) ─────────────

describe('trailing bytes — strict: false', () => {
  test('valid sequence: returns first item with warning', () => {
    const warnings: { message: string }[] = [];
    const node = decodeCBOR(hex('01 f4'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborUint;
    expect(node.value).toBe(1n);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/1 trailing byte/);
  });

  test('warning is attached to the returned AST node', () => {
    const node = decodeCBOR(hex('01 f4'), {
      strict: false,
      silent: true,
    }) as CborUint;
    expect(node.warnings).toHaveLength(1);
    expect(node.warnings![0]!.message).toMatch(/1 trailing byte/);
  });

  test('truncated trailing item throws even with strict: false', () => {
    // 0x01 = 1 (valid), 0x18 = uint needing one more byte (truncated)
    expect(() =>
      decodeCBOR(hex('01 18'), { strict: false, silent: true })
    ).toThrow('CBOR decode error');
  });

  test('strict mode (default) still throws for trailing bytes', () => {
    expect(() => decodeCBOR(hex('01 02'), { strict: true })).toThrow(
      'CBOR decode error: 1 trailing byte(s) after end of CBOR item'
    );
    expect(() => decodeCBOR(hex('01 02'), {})).toThrow(
      'CBOR decode error: 1 trailing byte(s) after end of CBOR item'
    );
  });

  test('multi-item sequence: all trailing items validated', () => {
    // 01 02 03 = three integers; strict:false returns 1 with warning
    const warnings: { message: string }[] = [];
    const node = decodeCBOR(hex('01 02 03'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborUint;
    expect(node.value).toBe(1n);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/2 trailing byte/);
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

// ─── strict / onWarning option ───────────────────────────────────────────────

describe('strict / onWarning option', () => {
  // ── Simple value < 32 in extended form (ai=24) ──────────────────────────────

  test('strict mode (default): simple value < 32 in extended form throws', () => {
    // 0xf8 0x18 → ai=24 (1-byte), simpleVal=0x18=24 — invalid (must use initial byte)
    expect(() => decodeCBOR(hex('f8 18'))).toThrow('CBOR decode error');
  });

  test('strict: true: simple value < 32 in extended form calls onWarning then throws', () => {
    const warnings: { message: string; offset: number }[] = [];
    expect(() =>
      decodeCBOR(hex('f8 18'), {
        strict: true,
        onWarning: (w) => warnings.push(w),
      })
    ).toThrow('CBOR decode error');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('simple value 24');
    expect(warnings[0].offset).toBe(0);
  });

  test('strict: false: simple value < 32 in extended form warns and continues', () => {
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('f8 18'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborSimple;
    expect(result).toBeInstanceOf(CborSimple);
    expect(result.value).toBe(24);
    expect(result.warnings).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('simple value 24');
    expect(warnings[0].offset).toBe(0);
  });

  test('strict: false: falls back to console.warn when no onWarning is provided', () => {
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => captured.push(msg);
    try {
      const result = decodeCBOR(hex('f8 00'), { strict: false }) as CborSimple;
      expect(result).toBeInstanceOf(CborSimple);
      expect(result.value).toBe(0);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain('simple value 0');
      expect(captured[0]).toContain('offset 0');
    } finally {
      console.warn = orig;
    }
  });

  test('silent: true suppresses console.warn', () => {
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (msg: string) => captured.push(msg);
    try {
      decodeCBOR(hex('f8 00'), { strict: false, silent: true });
      expect(captured).toHaveLength(0);
    } finally {
      console.warn = orig;
    }
  });

  test('silent: true does not suppress an explicit onWarning callback', () => {
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('f8 00'), {
      strict: false,
      silent: true,
      onWarning: (w) => warnings.push(w),
    }) as CborSimple;
    expect(result.value).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  // ── Invalid UTF-8 in text string ─────────────────────────────────────────────

  test('strict mode (default): invalid UTF-8 throws', () => {
    expect(() => decodeCBOR(hex('62 80 80'))).toThrow('CBOR decode error');
  });

  test('strict: false: invalid UTF-8 warns and returns string with replacement chars', () => {
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('62 80 80'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborTextString;
    expect(result).toBeInstanceOf(CborTextString);
    // TextDecoder with fatal:false replaces invalid bytes with U+FFFD
    expect(result.value).toContain('�');
    expect(result.warnings).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('UTF-8');
    expect(warnings[0].offset).toBe(1); // text bytes start at offset 1
  });

  // ── Duplicate map keys ────────────────────────────────────────────────────────

  test('strict mode (default): duplicate map keys throw', () => {
    // {1: "a", 1: "b"} — key 0x01 appears twice
    // a2 01 61 61  01 61 62
    expect(() => decodeCBOR(hex('a2 01 61 61 01 61 62'))).toThrow(
      'CBOR decode error'
    );
  });

  test('strict: false: duplicate map keys warn and decode all entries', () => {
    // {1: "a", 1: "b"} — key 0x01 appears twice
    // a2=map(2), 01="1", 6161="a", 01="1"(dup at offset 4), 6162="b"
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('a2 01 61 61 01 61 62'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborMap;
    expect(result).toBeInstanceOf(CborMap);
    expect(result.entries).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('duplicate map key');
    expect(warnings[0].offset).toBe(4); // second key 0x01 is at offset 4
  });

  test('strict mode: different encodings of the same integer key are detected as duplicate', () => {
    // {0: "a", 0_1: "b"} — a2 00 61 61  18 00 61 62
    // key 0x00 = CborUint(0), key 0x1800 = CborUint(0) with extended encoding
    // canonical re-encoding of both is "00" → duplicate detected
    expect(() => decodeCBOR(hex('a2 00 61 61 18 00 61 62'))).toThrow(
      'CBOR decode error'
    );
  });

  test('strict: false: different encodings of same integer key warn and decode', () => {
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('a2 00 61 61 18 00 61 62'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborMap;
    expect(result.entries).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('duplicate map key');
  });

  test('strict: false: indefinite map with duplicate keys warns and continues', () => {
    // {_ 1: "a", 1: "b"} — bf 01 61 61 01 61 62 ff
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('bf 01 61 61 01 61 62 ff'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborMap;
    expect(result).toBeInstanceOf(CborMap);
    expect(result.indefiniteLength).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('duplicate map key');
    expect(warnings[0].offset).toBe(4); // second key 0x01 is at offset 4
  });

  test('strict: false: float keys with same numeric value but different widths are detected as duplicate', () => {
    // {f16(1.0): "a", f32(1.0): "b"} — both fingerprint as "f:1"
    // f9 3c 00 = half 1.0, fa 3f 80 00 00 = single 1.0
    // a2 f9 3c 00 61 61 fa 3f 80 00 00 61 62
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('a2 f9 3c 00 61 61 fa 3f 80 00 00 61 62'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborMap;
    expect(result).toBeInstanceOf(CborMap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('duplicate map key');
  });

  test('strict: false: indefinite byte-string key equal to definite byte-string key is detected as duplicate', () => {
    // {h'0102': "a", (_ h'01', h'02'): "b"} — both fingerprint as b"0102"
    // a2 42 01 02 61 61 5f 41 01 41 02 ff 61 62
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(
      hex('a2 42 01 02 61 61 5f 41 01 41 02 ff 61 62'),
      {
        strict: false,
        onWarning: (w) => warnings.push(w),
      }
    ) as CborMap;
    expect(result).toBeInstanceOf(CborMap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('duplicate map key');
  });

  test('strict: false: indefinite text key equal to definite text key is detected as duplicate', () => {
    // {"ab": 1, indefinite("a"+"b"): 2} — both fingerprint as ["t","ab"]
    // a2 62 61 62 01 7f 61 61 61 62 ff 02
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('a2 62 61 62 01 7f 61 61 61 62 ff 02'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborMap;
    expect(result).toBeInstanceOf(CborMap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('duplicate map key');
  });

  test('strict: false: definite array key and indefinite array key with same elements are detected as duplicate', () => {
    // {[1]: "a", [_ 1]: "b"} — both fingerprint as ["A",[["u","1"]]]
    // a2 81 01 61 61 9f 01 ff 61 62
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('a2 81 01 61 61 9f 01 ff 61 62'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborMap;
    expect(result).toBeInstanceOf(CborMap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('duplicate map key');
  });

  test('strict: false: array keys containing floats of different widths but same value are detected as duplicate', () => {
    // {[f16(1.0)]: "a", [f32(1.0)]: "b"} — both fingerprint as ["A",[["f","1"]]]
    // a2 81 f9 3c 00 61 61 81 fa 3f 80 00 00 61 62
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(
      hex('a2 81 f9 3c 00 61 61 81 fa 3f 80 00 00 61 62'),
      { strict: false, onWarning: (w) => warnings.push(w) }
    ) as CborMap;
    expect(result).toBeInstanceOf(CborMap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('duplicate map key');
  });

  test('strict: false: array key ["a,t:b"] is NOT a duplicate of array key ["a"]', () => {
    // Regression: raw string concatenation collided t:"a,t:b" with t:"a" inside
    // array fingerprints.  With JSON.stringify escaping this must not warn.
    // {["a,t:b"]: 1, ["a"]: 2}
    // a2 81 65 61 2c 74 3a 62 01 81 61 61 02
    const warnings: { message: string; offset: number }[] = [];
    decodeCBOR(hex('a2 81 65 61 2c 74 3a 62 01 81 61 61 02'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    });
    expect(warnings).toHaveLength(0);
  });

  test('strict: false: map keys with same entries in different insertion order are detected as duplicate', () => {
    // {{1:2, 3:4}: "a", {3:4, 1:2}: "b"} — both fingerprint as ["M",...]
    // with sorted key pairs, so they are data-model equal.
    // a2 a2 01 02 03 04 61 61 a2 03 04 01 02 61 62
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(
      hex('a2 a2 01 02 03 04 61 61 a2 03 04 01 02 61 62'),
      { strict: false, onWarning: (w) => warnings.push(w) }
    ) as CborMap;
    expect(result).toBeInstanceOf(CborMap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('duplicate map key');
  });
});

// ─── tag 24 embedded CBOR options propagation ────────────────────────────────

describe('tag 24 embedded CBOR options propagation', () => {
  test('strict mode (default): tag 24 inner violation throws', () => {
    // d8 18 = tag(24), 42 f8 18 = h'f818' (simple value 24 in extended form)
    // In strict mode the extension re-throws so the outer decode also throws.
    expect(() => decodeCBOR(hex('d8 18 42 f8 18'), { silent: true })).toThrow();
  });

  test('strict mode with onWarning: inner violation emits warning then throws', () => {
    // onWarning IS called before the inner throw is re-thrown by the extension.
    const warnings: { message: string; offset: number }[] = [];
    expect(() =>
      decodeCBOR(hex('d8 18 42 f8 18'), {
        onWarning: (w) => warnings.push(w),
      })
    ).toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('simple value 24');
  });

  test('strict: false: violation inside tag 24 warns and produces embedded CBOR', () => {
    // Previously (without options propagation) this fell back to CborTag because
    // the inner decodeCBOR always used strict:true (default) and threw.
    // Now strict:false is propagated so the inner decode recovers.
    const warnings: { message: string; offset: number }[] = [];
    const result = decodeCBOR(hex('d8 18 42 f8 18'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborTag;
    expect(result).toBeInstanceOf(CborTag);
    expect(result.tag).toBe(24n);
    expect(result.content).toBeInstanceOf(CborEmbeddedCBOR);
    const embedded = result.content as CborEmbeddedCBOR;
    expect(embedded.items[0]).toBeInstanceOf(CborSimple);
    expect((embedded.items[0] as CborSimple).value).toBe(24);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('simple value 24');
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

// ─── builtinExtensions option ─────────────────────────────────────────────────

describe('decodeCBOR — builtinExtensions option', () => {
  const DT_TAGGED_BYTES = hex('c11a6955b900'); // 1(1767225600) via tag 1

  test('omitted: default bundled dt extension resolves tag 1', () => {
    const r = decodeCBOR(DT_TAGGED_BYTES);
    expect(r).toBeInstanceOf(CborTaggedEpochDtExt);
  });

  test('false: tag 1 falls back to plain CborTag', () => {
    const r = decodeCBOR(DT_TAGGED_BYTES, { builtinExtensions: false });
    expect(r).toBeInstanceOf(CborTag);
    expect(r).not.toBeInstanceOf(CborTaggedEpochDtExt);
    expect((r as CborTag).tag).toBe(1n);
  });

  test('array: an explicit [dt] set still resolves tag 1', () => {
    const r = decodeCBOR(DT_TAGGED_BYTES, { builtinExtensions: [dt] });
    expect(r).toBeInstanceOf(CborTaggedEpochDtExt);
  });

  test('core RFC 8949 features (bignum, embedded CBOR) stay active regardless of builtinExtensions', () => {
    // 2(h'010000000000000000') = bignum for 2^64
    const big = decodeCBOR(hex('c249010000000000000000'), {
      builtinExtensions: false,
    });
    expect(big).toBeInstanceOf(CborBigUint);

    // 24(h'820102') = embedded CBOR data item [1, 2]
    const embedded = decodeCBOR(hex('d81843820102'), {
      builtinExtensions: false,
    }) as CborTag;
    expect(embedded).toBeInstanceOf(CborTag);
    expect(embedded.content).toBeInstanceOf(CborEmbeddedCBOR);
  });

  test('builtinExtensions is forwarded into embedded CBOR (tag 24) decoding', () => {
    // 24(h'c100') = embedded CBOR data item 1(0) — tag 1 is the `dt` prefix.
    const EMBEDDED_TAG1_BYTES = hex('d81842c100');

    // Disabled outside → must stay disabled for the tag found inside the
    // embedded byte string too: the inner item stays a plain CborTag(1, 0),
    // not a CborTaggedEpochDtExt.
    const disabled = decodeCBOR(EMBEDDED_TAG1_BYTES, {
      builtinExtensions: false,
    }) as CborTag;
    const disabledInner = (disabled.content as CborEmbeddedCBOR).items[0];
    expect(disabledInner).toBeInstanceOf(CborTag);
    expect(disabledInner).not.toBeInstanceOf(CborTaggedEpochDtExt);

    // Explicitly re-enabling dt via builtinExtensions still resolves inside
    // the embedded item.
    const enabled = decodeCBOR(EMBEDDED_TAG1_BYTES, {
      builtinExtensions: [dt],
    }) as CborTag;
    const enabledInner = (enabled.content as CborEmbeddedCBOR).items[0];
    expect(enabledInner).toBeInstanceOf(CborTaggedEpochDtExt);
  });

  test('user extensions still take priority over a custom builtinExtensions array', () => {
    const r = decodeCBOR(DT_TAGGED_BYTES, {
      builtinExtensions: [dt],
      extensions: [
        {
          tagNumbers: [1n],
          parseTag: () => new CborTextString('custom'),
        },
      ],
    });
    expect(r).toBeInstanceOf(CborTextString);
  });

  test('a custom array can reorder/reuse the same extension objects exported as BUILTIN_EXTENSIONS', () => {
    const r = decodeCBOR(DT_TAGGED_BYTES, {
      builtinExtensions: [...BUILTIN_EXTENSIONS].reverse(),
    });
    expect(r).toBeInstanceOf(CborTaggedEpochDtExt);
  });
});

// ─── CBOR → CDN: non-canonical widths produce EI suffix ──────────────────────

describe('CBOR → CDN: non-canonical encoding width is captured as EI', () => {
  test('uint: 18 01 (1-byte header for value 1, canonical is inline) → "1_0"', () => {
    // AI_1BYTE with value ≤ 23 is non-canonical; canonical would be 0x01 (inline)
    const n = decodeCBOR(hex('18 01')) as CborUint;
    expect(n.encodingWidth).toBe(0);
    expect(n.toCDN()).toBe('1_0');
  });

  test('nint: 38 00 (1-byte header for -1, canonical is inline) → "-1_0"', () => {
    // argument 0 ≤ 23; canonical inline = 0x20
    const n = decodeCBOR(hex('38 00')) as CborNint;
    expect(n.encodingWidth).toBe(0);
    expect(n.toCDN()).toBe('-1_0');
  });

  test('byte string: 59 0001 ff (2-byte length for 1-byte content) → "h\'ff\'_1"', () => {
    // length 1 ≤ 0xff; canonical would use 1-byte header (0x41)
    const n = decodeCBOR(hex('59 0001 ff')) as CborByteString;
    expect(n.encodingWidth).toBe(1);
    expect(n.toCDN()).toBe("h'ff'_1");
  });

  test('text string: 79 0001 41 (2-byte length for "A") → \'"A"_1\'', () => {
    // UTF-8 length 1 ≤ 0xff; canonical would use 1-byte header (0x61)
    const n = decodeCBOR(hex('79 0001 41')) as CborTextString;
    expect(n.encodingWidth).toBe(1);
    expect(n.toCDN()).toBe('"A"_1');
  });

  test('array: 99 0002 01 02 (2-byte count for 2 items) → "[_1 1,2]"', () => {
    // count 2 ≤ 0xff; canonical would use 1-byte header (0x82)
    const n = decodeCBOR(hex('99 0002 01 02')) as CborArray;
    expect(n.encodingWidth).toBe(1);
    expect(n.toCDN()).toBe('[_1 1,2]');
  });

  test('map: b9 0001 6161 01 (2-byte count for 1 entry) → \'{_1 "a":1}\'', () => {
    // count 1 ≤ 0xff; canonical would use 1-byte header (0xa1)
    const n = decodeCBOR(hex('b9 0001 61 61 01')) as CborMap;
    expect(n.encodingWidth).toBe(1);
    expect(n.toCDN()).toBe('{_1 "a":1}');
  });

  test('tag: d9 002a 01 (2-byte tag number 42) → "42_1(1)"', () => {
    // tag 42 ≤ 0xff; canonical would be 1-byte (d8 2a); 2-byte header is non-canonical
    const n = decodeCBOR(hex('d9 002a 01')) as CborTag;
    expect(n.encodingWidth).toBe(1);
    expect(n.toCDN()).toBe('42_1(1)');
  });

  test('float: fb 3ff0000000000000 (double-precision 1.0, canonical is half) → "1.0_3"', () => {
    // 1.0 is exactly representable in float16; double is non-canonical
    const n = decodeCBOR(hex('fb 3ff0 0000 0000 0000')) as CborFloat;
    expect(n.precision).toBe('double');
    expect(n.toCDN()).toBe('1.0_3');
  });
});
