import { describe, test, expect } from 'vitest';
import { toCDN } from './serializer';
import { parseCDN } from './parser';
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

// ─── Unsigned integers ────────────────────────────────────────────────────────

describe('CborUint.toCDN()', () => {
  test('0', () => expect(toCDN(new CborUint(0n))).toBe('0'));
  test('1', () => expect(toCDN(new CborUint(1n))).toBe('1'));
  test('255', () => expect(toCDN(new CborUint(255n))).toBe('255'));
  test('18446744073709551615', () => {
    expect(toCDN(new CborUint(18_446_744_073_709_551_615n))).toBe(
      '18446744073709551615'
    );
  });
});

// ─── Negative integers ────────────────────────────────────────────────────────

describe('CborNint.toCDN()', () => {
  test('-1', () => expect(toCDN(new CborNint(-1n))).toBe('-1'));
  test('-10', () => expect(toCDN(new CborNint(-10n))).toBe('-10'));
  test('-100', () => expect(toCDN(new CborNint(-100n))).toBe('-100'));
  test('-1000', () => expect(toCDN(new CborNint(-1000n))).toBe('-1000'));
});

// ─── Byte strings ─────────────────────────────────────────────────────────────

describe('CborByteString.toCDN()', () => {
  test('empty → sqstr (printable-string default)', () => {
    expect(toCDN(new CborByteString(new Uint8Array()))).toBe("''");
  });
  test('empty → hex with sqstr:none', () => {
    expect(toCDN(new CborByteString(new Uint8Array()), { sqstr: 'none' })).toBe(
      "h''"
    );
  });

  test('[01,02,03,04] hex (default)', () => {
    expect(
      toCDN(new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04])))
    ).toBe("h'01020304'");
  });

  test('[01,02,03,04] hex via options override', () => {
    expect(
      toCDN(
        new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04]), {
          ednEncoding: 'base64',
        }),
        { bstrEncoding: 'hex' }
      )
    ).toBe("h'01020304'");
  });

  test('[01,02,03,04] base64', () => {
    expect(
      toCDN(new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04])), {
        bstrEncoding: 'base64',
      })
    ).toBe("b64'AQIDBA'");
  });

  test('[01,02,03,04] base64url', () => {
    expect(
      toCDN(new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04])), {
        bstrEncoding: 'base64url',
      })
    ).toBe("b64'AQIDBA'");
  });

  test('ednEncoding on node (no options)', () => {
    expect(
      toCDN(new CborByteString(new Uint8Array([0xff]), { ednEncoding: 'hex' }))
    ).toBe("h'ff'");
  });

  test("sqstr:'string' — valid UTF-8 → single-quoted", () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(toCDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "'Hello'"
    );
  });
  test("sqstr:'string' — single quote in value is escaped", () => {
    const bytes = new TextEncoder().encode("it's");
    expect(toCDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "'it\\'s'"
    );
  });
  test("sqstr:'string' — invalid UTF-8 falls back to hex", () => {
    const bytes = new Uint8Array([0xff, 0xfe]);
    expect(toCDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "h'fffe'"
    );
  });
  test("sqstr:'string' — control characters are escaped (not hex fallback)", () => {
    const bytes = new TextEncoder().encode('a\nb');
    expect(toCDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "'a\\nb'"
    );
  });
});

describe("sqstr:'printable-string' (default)", () => {
  test('printable ASCII → single-quoted', () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(toCDN(new CborByteString(bytes))).toBe("'Hello'");
  });
  test('single quote in value is escaped', () => {
    const bytes = new TextEncoder().encode("it's");
    expect(toCDN(new CborByteString(bytes))).toBe("'it\\'s'");
  });
  test('control character (\\n) → hex fallback', () => {
    const bytes = new TextEncoder().encode('a\nb');
    expect(toCDN(new CborByteString(bytes))).toBe("h'610a62'");
  });
  test('DEL (0x7F) → hex fallback', () => {
    const bytes = new Uint8Array([0x41, 0x7f, 0x42]);
    expect(toCDN(new CborByteString(bytes))).toBe("h'417f42'");
  });
  test('invalid UTF-8 → hex fallback', () => {
    const bytes = new Uint8Array([0xff, 0xfe]);
    expect(toCDN(new CborByteString(bytes))).toBe("h'fffe'");
  });
  test("sqstr:'none' suppresses single-quoted output", () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(toCDN(new CborByteString(bytes), { sqstr: 'none' })).toBe(
      "h'48656c6c6f'"
    );
  });
});

describe('CborIndefiniteByteString.toCDN()', () => {
  test('two chunks', () => {
    const node = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([0x01, 0x02])),
      new CborByteString(new Uint8Array([0x03, 0x04, 0x05])),
    ]);
    expect(toCDN(node)).toBe("(_ h'0102', h'030405')");
  });

  test('empty chunks', () => {
    expect(toCDN(new CborIndefiniteByteString([]))).toBe("''_");
  });
});

// ─── Text strings ─────────────────────────────────────────────────────────────

describe('CborTextString.toCDN()', () => {
  test('empty string', () => expect(toCDN(new CborTextString(''))).toBe('""'));
  test('hello', () =>
    expect(toCDN(new CborTextString('hello'))).toBe('"hello"'));
  test('with double quote', () =>
    expect(toCDN(new CborTextString('"'))).toBe('"\\""'));
  test('with backslash', () =>
    expect(toCDN(new CborTextString('\\'))).toBe('"\\\\"'));
  test('with newline', () =>
    expect(toCDN(new CborTextString('\n'))).toBe('"\\n"'));
  test('with tab', () => expect(toCDN(new CborTextString('\t'))).toBe('"\\t"'));
  test('with carriage return', () =>
    expect(toCDN(new CborTextString('\r'))).toBe('"\\r"'));
  test('control char U+0001', () =>
    expect(toCDN(new CborTextString('\x01'))).toBe('"\\u0001"'));
  test('unicode', () => expect(toCDN(new CborTextString('ü'))).toBe('"ü"'));
});

describe('CborIndefiniteTextString.toCDN()', () => {
  test('two chunks', () => {
    const node = new CborIndefiniteTextString([
      new CborTextString('strea'),
      new CborTextString('ming'),
    ]);
    expect(toCDN(node)).toBe('(_ "strea", "ming")');
  });

  test('empty', () => {
    expect(toCDN(new CborIndefiniteTextString([]))).toBe('""_');
  });
});

// ─── Arrays ───────────────────────────────────────────────────────────────────

describe('CborArray.toCDN() — single-line', () => {
  test('[]', () => expect(toCDN(new CborArray([]))).toBe('[]'));

  test('[1, 2, 3]', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborUint(2n),
      new CborUint(3n),
    ]);
    expect(toCDN(node)).toBe('[1,2,3]');
  });

  test('nested [1, [2, 3]]', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborArray([new CborUint(2n), new CborUint(3n)]),
    ]);
    expect(toCDN(node)).toBe('[1,[2,3]]');
  });

  test('[_ ] empty indefinite', () => {
    expect(toCDN(new CborArray([], { indefiniteLength: true }))).toBe('[_ ]');
  });

  test('[_ 1, 2] indefinite', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)], {
      indefiniteLength: true,
    });
    expect(toCDN(node)).toBe('[_ 1,2]');
  });
});

describe('CborArray.toCDN() — multi-line', () => {
  test('[1, 2, 3] with indent=2', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborUint(2n),
      new CborUint(3n),
    ]);
    expect(toCDN(node, { indent: 2 })).toBe('[\n  1,\n  2,\n  3\n]');
  });

  test('nested with indent=2', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborArray([new CborUint(2n), new CborUint(3n)]),
    ]);
    expect(toCDN(node, { indent: 2 })).toBe(
      '[\n  1,\n  [\n    2,\n    3\n  ]\n]'
    );
  });

  test('indefinite [_ 1, 2] with indent=2', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)], {
      indefiniteLength: true,
    });
    expect(toCDN(node, { indent: 2 })).toBe('[_ \n  1,\n  2\n]');
  });

  test('empty array with indent stays single-line', () => {
    expect(toCDN(new CborArray([]), { indent: 2 })).toBe('[]');
  });
});

describe('CborArray.toCDN() — commas option', () => {
  const node = () =>
    new CborArray([new CborUint(1n), new CborUint(2n), new CborUint(3n)]);

  test("commas:'none' single-line → space-separated", () => {
    expect(toCDN(node(), { commas: 'none' })).toBe('[1 2 3]');
  });

  test("commas:'none' multi-line → no trailing comma on lines", () => {
    expect(toCDN(node(), { commas: 'none', indent: 2 })).toBe(
      '[\n  1\n  2\n  3\n]'
    );
  });

  test("commas:'trailing' multi-line → trailing comma on last item", () => {
    expect(toCDN(node(), { commas: 'trailing', indent: 2 })).toBe(
      '[\n  1,\n  2,\n  3,\n]'
    );
  });

  test("commas:'trailing' has no effect on single-line", () => {
    expect(toCDN(node(), { commas: 'trailing' })).toBe('[1,2,3]');
  });
});

// ─── Maps ─────────────────────────────────────────────────────────────────────

describe('CborMap.toCDN() — single-line', () => {
  test('{}', () => expect(toCDN(new CborMap([]))).toBe('{}'));

  test('{1: 2, 3: 4}', () => {
    const node = new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);
    expect(toCDN(node)).toBe('{1:2,3:4}');
  });

  test('{_ } empty indefinite', () => {
    expect(toCDN(new CborMap([], { indefiniteLength: true }))).toBe('{_ }');
  });

  test('{_ "a": 1} indefinite', () => {
    const node = new CborMap([[new CborTextString('a'), new CborUint(1n)]], {
      indefiniteLength: true,
    });
    expect(toCDN(node)).toBe('{_ "a":1}');
  });
});

describe('CborMap.toCDN() — multi-line', () => {
  test('{1: 2, 3: 4} with indent=2', () => {
    const node = new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);
    expect(toCDN(node, { indent: 2 })).toBe('{\n  1: 2,\n  3: 4\n}');
  });

  test('empty map with indent stays single-line', () => {
    expect(toCDN(new CborMap([]), { indent: 2 })).toBe('{}');
  });
});

describe('CborMap.toCDN() — commas option', () => {
  const node = () =>
    new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);

  test("commas:'none' single-line → space-separated", () => {
    expect(toCDN(node(), { commas: 'none' })).toBe('{1:2 3:4}');
  });

  test("commas:'none' multi-line → no trailing comma on lines", () => {
    expect(toCDN(node(), { commas: 'none', indent: 2 })).toBe(
      '{\n  1: 2\n  3: 4\n}'
    );
  });

  test("commas:'trailing' multi-line → trailing comma on last item", () => {
    expect(toCDN(node(), { commas: 'trailing', indent: 2 })).toBe(
      '{\n  1: 2,\n  3: 4,\n}'
    );
  });

  test("commas:'trailing' has no effect on single-line", () => {
    expect(toCDN(node(), { commas: 'trailing' })).toBe('{1:2,3:4}');
  });
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('CborTag.toCDN()', () => {
  test('0("2013-03-21T20:04:00Z")', () => {
    const node = new CborTag(0n, new CborTextString('2013-03-21T20:04:00Z'));
    expect(toCDN(node)).toBe('0("2013-03-21T20:04:00Z")');
  });

  test('1(1363896240)', () => {
    const node = new CborTag(1n, new CborUint(1363896240n));
    expect(toCDN(node)).toBe('1(1363896240)');
  });

  test("23(h'01020304')", () => {
    const node = new CborTag(
      23n,
      new CborByteString(new Uint8Array([1, 2, 3, 4]))
    );
    expect(toCDN(node)).toBe("23(h'01020304')");
  });
});

// ─── Floats ───────────────────────────────────────────────────────────────────

describe('CborFloat.toCDN()', () => {
  test('0.0 (half, auto)', () => expect(toCDN(new CborFloat(0.0))).toBe('0.0'));
  test('-0.0 (half, auto)', () =>
    expect(toCDN(new CborFloat(-0.0))).toBe('-0.0'));
  test('1.0 (half, auto — no suffix)', () =>
    expect(toCDN(new CborFloat(1.0))).toBe('1.0'));
  test('1.5 (half, auto)', () => expect(toCDN(new CborFloat(1.5))).toBe('1.5'));
  test('1.1 (double, auto)', () =>
    expect(toCDN(new CborFloat(1.1))).toBe('1.1'));
  test('100000.0 (single, auto)', () =>
    expect(toCDN(new CborFloat(100000.0))).toBe('100000.0'));
  test('Infinity (half, auto)', () =>
    expect(toCDN(new CborFloat(Infinity))).toBe('Infinity'));
  test('-Infinity (half, auto)', () =>
    expect(toCDN(new CborFloat(-Infinity))).toBe('-Infinity'));
  test('NaN (half, auto)', () => expect(toCDN(new CborFloat(NaN))).toBe('NaN'));

  // ── NaN with non-auto precision ───────────────────────────────────────────

  test('NaN precision=half → NaN (matches auto)', () => {
    expect(toCDN(new CborFloat(NaN, { precision: 'half' }))).toBe('NaN');
  });
  test('NaN precision=single → NaN_2', () => {
    expect(toCDN(new CborFloat(NaN, { precision: 'single' }))).toBe('NaN_2');
  });
  test('NaN precision=double → NaN_3', () => {
    expect(toCDN(new CborFloat(NaN, { precision: 'double' }))).toBe('NaN_3');
  });

  // ── Infinity with non-auto precision ──────────────────────────────────────

  test('Infinity precision=half → Infinity (matches auto)', () => {
    expect(toCDN(new CborFloat(Infinity, { precision: 'half' }))).toBe(
      'Infinity'
    );
  });
  test('Infinity precision=single → Infinity_2', () => {
    expect(toCDN(new CborFloat(Infinity, { precision: 'single' }))).toBe(
      'Infinity_2'
    );
  });
  test('Infinity precision=double → Infinity_3', () => {
    expect(toCDN(new CborFloat(Infinity, { precision: 'double' }))).toBe(
      'Infinity_3'
    );
  });
  test('-Infinity precision=half → -Infinity (matches auto)', () => {
    expect(toCDN(new CborFloat(-Infinity, { precision: 'half' }))).toBe(
      '-Infinity'
    );
  });
  test('-Infinity precision=single → -Infinity_2', () => {
    expect(toCDN(new CborFloat(-Infinity, { precision: 'single' }))).toBe(
      '-Infinity_2'
    );
  });
  test('-Infinity precision=double → -Infinity_3', () => {
    expect(toCDN(new CborFloat(-Infinity, { precision: 'double' }))).toBe(
      '-Infinity_3'
    );
  });

  test('1.0 precision=half → no suffix (matches auto)', () => {
    expect(toCDN(new CborFloat(1.0, { precision: 'half' }))).toBe('1.0');
  });
  test('1.0 precision=single → _2 suffix', () => {
    expect(toCDN(new CborFloat(1.0, { precision: 'single' }))).toBe('1.0_2');
  });
  test('1.0 precision=double → _3 suffix', () => {
    expect(toCDN(new CborFloat(1.0, { precision: 'double' }))).toBe('1.0_3');
  });
  test('100000.0 precision=half → _1 suffix (mismatches auto=single)', () => {
    expect(toCDN(new CborFloat(100000.0, { precision: 'half' }))).toBe(
      '100000.0_1'
    );
  });
  test('1.1 precision=double → no suffix (matches auto)', () => {
    expect(toCDN(new CborFloat(1.1, { precision: 'double' }))).toBe('1.1');
  });
});

// ─── floatFormat: 'hex' ───────────────────────────────────────────────────────

describe("CborFloat.toCDN() — floatFormat: 'hex'", () => {
  test('1.5 → 0x1.8p+0', () => {
    expect(toCDN(new CborFloat(1.5), { floatFormat: 'hex' })).toBe('0x1.8p+0');
  });
  test('1.0 → 0x1p+0', () => {
    expect(toCDN(new CborFloat(1.0), { floatFormat: 'hex' })).toBe('0x1p+0');
  });
  test('-1.5 → -0x1.8p+0', () => {
    expect(toCDN(new CborFloat(-1.5), { floatFormat: 'hex' })).toBe(
      '-0x1.8p+0'
    );
  });
  test('+0 → 0x0p+0', () => {
    expect(toCDN(new CborFloat(0.0), { floatFormat: 'hex' })).toBe('0x0p+0');
  });
  test('-0 → -0x0p+0', () => {
    expect(toCDN(new CborFloat(-0.0), { floatFormat: 'hex' })).toBe('-0x0p+0');
  });

  // Non-finite values are unchanged regardless of floatFormat
  test('Infinity → "Infinity" (unchanged)', () => {
    expect(toCDN(new CborFloat(Infinity), { floatFormat: 'hex' })).toBe(
      'Infinity'
    );
  });
  test('-Infinity → "-Infinity" (unchanged)', () => {
    expect(toCDN(new CborFloat(-Infinity), { floatFormat: 'hex' })).toBe(
      '-Infinity'
    );
  });
  test('NaN → "NaN" (unchanged)', () => {
    expect(toCDN(new CborFloat(NaN), { floatFormat: 'hex' })).toBe('NaN');
  });

  // Precision suffix is still emitted with hex format
  test('1.0 precision=single → 0x1p+0_2', () => {
    expect(
      toCDN(new CborFloat(1.0, { precision: 'single' }), { floatFormat: 'hex' })
    ).toBe('0x1p+0_2');
  });
  test('1.0 precision=double → 0x1p+0_3', () => {
    expect(
      toCDN(new CborFloat(1.0, { precision: 'double' }), { floatFormat: 'hex' })
    ).toBe('0x1p+0_3');
  });

  // default floatFormat behaves same as 'decimal'
  test("floatFormat: 'decimal' same as default", () => {
    const f = new CborFloat(1.5);
    expect(toCDN(f, { floatFormat: 'decimal' })).toBe(toCDN(f));
  });
});

// ─── intFormat ────────────────────────────────────────────────────────────────

describe('CborUint.toCDN() — intFormat', () => {
  test("default (decimal): 42 → '42'", () => {
    expect(toCDN(new CborUint(42n))).toBe('42');
  });
  test("'hex': 42 → '0x2a'", () => {
    expect(toCDN(new CborUint(42n), { intFormat: 'hex' })).toBe('0x2a');
  });
  test("'octal': 42 → '0o52'", () => {
    expect(toCDN(new CborUint(42n), { intFormat: 'octal' })).toBe('0o52');
  });
  test("'binary': 42 → '0b101010'", () => {
    expect(toCDN(new CborUint(42n), { intFormat: 'binary' })).toBe('0b101010');
  });
  test("0 → '0x0' in hex", () => {
    expect(toCDN(new CborUint(0n), { intFormat: 'hex' })).toBe('0x0');
  });
  test("encodingWidth preserved: 42_1 in hex → '0x2a_1'", () => {
    expect(
      toCDN(new CborUint(42n, { encodingWidth: 1 }), { intFormat: 'hex' })
    ).toBe('0x2a_1');
  });
  test("'decimal' same as default", () => {
    const n = new CborUint(255n);
    expect(toCDN(n, { intFormat: 'decimal' })).toBe(toCDN(n));
  });
});

describe('CborNint.toCDN() — intFormat', () => {
  test("default (decimal): -1 → '-1'", () => {
    expect(toCDN(new CborNint(-1n))).toBe('-1');
  });
  test("'hex': -1 → '-0x1'", () => {
    expect(toCDN(new CborNint(-1n), { intFormat: 'hex' })).toBe('-0x1');
  });
  test("'hex': -14159024 → '-0xd80cb0'", () => {
    expect(toCDN(new CborNint(-14159024n), { intFormat: 'hex' })).toBe(
      '-0xd80cb0'
    );
  });
  test("'octal': -8 → '-0o10'", () => {
    expect(toCDN(new CborNint(-8n), { intFormat: 'octal' })).toBe('-0o10');
  });
  test("'binary': -1 → '-0b1'", () => {
    expect(toCDN(new CborNint(-1n), { intFormat: 'binary' })).toBe('-0b1');
  });
  test("encodingWidth preserved: -1_1 in hex → '-0x1_1'", () => {
    expect(
      toCDN(new CborNint(-1n, { encodingWidth: 1 }), { intFormat: 'hex' })
    ).toBe('-0x1_1');
  });
});

// ─── Simple values ────────────────────────────────────────────────────────────

describe('CborSimple.toCDN()', () => {
  test('false', () => expect(toCDN(CborSimple.FALSE)).toBe('false'));
  test('true', () => expect(toCDN(CborSimple.TRUE)).toBe('true'));
  test('null', () => expect(toCDN(CborSimple.NULL)).toBe('null'));
  test('undefined', () =>
    expect(toCDN(CborSimple.UNDEFINED)).toBe('undefined'));
  test('simple(16)', () =>
    expect(toCDN(new CborSimple(16))).toBe('simple(16)'));
  test('simple(255)', () =>
    expect(toCDN(new CborSimple(255))).toBe('simple(255)'));
});

// ─── toCDN() convenience function ────────────────────────────────────────────

describe('toCDN() delegates to node.toCDN()', () => {
  test('delegates', () => {
    const node = new CborUint(42n);
    expect(toCDN(node)).toBe(node.toCDN());
  });
});

// ─── preserveComments with comment conversion ─────────────────────────────────

/** Parse CDN with comments collected, then re-serialize with the given options. */
function fmt(
  src: string,
  preserveComments: boolean | 'c-style' | 'cdn-style' = true,
  indent = 2
): string {
  return parseCDN(src, { preserveComments: true }).toCDN({
    preserveComments,
    indent,
  });
}

describe("preserveComments: 'c-style'", () => {
  test('# line → //', () =>
    expect(fmt('[\n  # comment\n  1\n]', 'c-style')).toBe(
      '[\n  // comment\n  1\n]'
    ));

  test('// line stays //', () =>
    expect(fmt('[\n  // comment\n  1\n]', 'c-style')).toBe(
      '[\n  // comment\n  1\n]'
    ));

  test('/ block / → /* block */', () =>
    expect(fmt('[\n  1 / note /\n]', 'c-style')).toBe('[\n  1 /* note */\n]'));

  test('/* block */ stays /* block */', () =>
    expect(fmt('[\n  1 /* note */\n]', 'c-style')).toBe(
      '[\n  1 /* note */\n]'
    ));

  test('root trailing comment', () =>
    expect(fmt('42 # end', 'c-style')).toBe('42 // end'));

  test('root leading comment', () =>
    expect(fmt('# start\n42', 'c-style')).toBe('// start\n42'));
});

describe("preserveComments: 'cdn-style'", () => {
  test('// line → #', () =>
    expect(fmt('[\n  // comment\n  1\n]', 'cdn-style')).toBe(
      '[\n  # comment\n  1\n]'
    ));

  test('# line stays #', () =>
    expect(fmt('[\n  # comment\n  1\n]', 'cdn-style')).toBe(
      '[\n  # comment\n  1\n]'
    ));

  test('/* block */ → / block /', () =>
    expect(fmt('[\n  1 /* note */\n]', 'cdn-style')).toBe(
      '[\n  1 / note /\n]'
    ));

  test('/ block / stays / block /', () =>
    expect(fmt('[\n  1 / note /\n]', 'cdn-style')).toBe('[\n  1 / note /\n]'));

  test('/** double-star */ → / *double-star / (space inserted)', () =>
    expect(fmt('[\n  1 /**double-star*/\n]', 'cdn-style')).toBe(
      '[\n  1 / *double-star/\n]'
    ));

  test('/* content with / */ kept as /* */ (cannot represent in / /)', () =>
    expect(fmt('[\n  1 /* 2026/6/7 */\n]', 'cdn-style')).toBe(
      '[\n  1 /* 2026/6/7 */\n]'
    ));

  test('root trailing comment', () =>
    expect(fmt('42 // end', 'cdn-style')).toBe('42 # end'));

  test('root leading comment', () =>
    expect(fmt('// start\n42', 'cdn-style')).toBe('# start\n42'));
});

describe('preserveComments: true (preserve markers as-is)', () => {
  test('mixed markers are kept unchanged', () => {
    const src = '[\n  # hash\n  1,\n  2 // line\n]';
    expect(fmt(src, true)).toBe(src);
  });
});

describe('preserveComments — map comments', () => {
  test("'c-style': map key leading and entry trailing", () =>
    expect(
      fmt('{\n  # key-leading\n  "a": 1 / val-trailing /\n}', 'c-style')
    ).toBe('{\n  // key-leading\n  "a": 1 /* val-trailing */\n}'));

  test("'cdn-style': map key leading and entry trailing", () =>
    expect(
      fmt('{\n  /* key-leading */\n  "a": 1 // val-trailing\n}', 'cdn-style')
    ).toBe('{\n  / key-leading /\n  "a": 1 # val-trailing\n}'));
});
