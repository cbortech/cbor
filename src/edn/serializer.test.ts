import { describe, test, expect } from 'vitest';
import { toEDN } from './serializer';
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

describe('CborUint.toEDN()', () => {
  test('0', () => expect(toEDN(new CborUint(0n))).toBe('0'));
  test('1', () => expect(toEDN(new CborUint(1n))).toBe('1'));
  test('255', () => expect(toEDN(new CborUint(255n))).toBe('255'));
  test('18446744073709551615', () => {
    expect(toEDN(new CborUint(18_446_744_073_709_551_615n))).toBe(
      '18446744073709551615'
    );
  });
});

// ─── Negative integers ────────────────────────────────────────────────────────

describe('CborNint.toEDN()', () => {
  test('-1', () => expect(toEDN(new CborNint(-1n))).toBe('-1'));
  test('-10', () => expect(toEDN(new CborNint(-10n))).toBe('-10'));
  test('-100', () => expect(toEDN(new CborNint(-100n))).toBe('-100'));
  test('-1000', () => expect(toEDN(new CborNint(-1000n))).toBe('-1000'));
});

// ─── Byte strings ─────────────────────────────────────────────────────────────

describe('CborByteString.toEDN()', () => {
  test('empty → sqstr (printable-string default)', () => {
    expect(toEDN(new CborByteString(new Uint8Array()))).toBe("''");
  });
  test('empty → hex with sqstr:none', () => {
    expect(toEDN(new CborByteString(new Uint8Array()), { sqstr: 'none' })).toBe(
      "h''"
    );
  });

  test('[01,02,03,04] hex (default)', () => {
    expect(
      toEDN(new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04])))
    ).toBe("h'01020304'");
  });

  test('[01,02,03,04] hex via options override', () => {
    expect(
      toEDN(
        new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04]), {
          ednEncoding: 'base64',
        }),
        { bstrEncoding: 'hex' }
      )
    ).toBe("h'01020304'");
  });

  test('[01,02,03,04] base64', () => {
    expect(
      toEDN(new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04])), {
        bstrEncoding: 'base64',
      })
    ).toBe("b64'AQIDBA'");
  });

  test('[01,02,03,04] base64url', () => {
    expect(
      toEDN(new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04])), {
        bstrEncoding: 'base64url',
      })
    ).toBe("b64'AQIDBA'");
  });

  test('ednEncoding on node (no options)', () => {
    expect(
      toEDN(new CborByteString(new Uint8Array([0xff]), { ednEncoding: 'hex' }))
    ).toBe("h'ff'");
  });

  test("sqstr:'string' — valid UTF-8 → single-quoted", () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(toEDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "'Hello'"
    );
  });
  test("sqstr:'string' — single quote in value is escaped", () => {
    const bytes = new TextEncoder().encode("it's");
    expect(toEDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "'it\\'s'"
    );
  });
  test("sqstr:'string' — invalid UTF-8 falls back to hex", () => {
    const bytes = new Uint8Array([0xff, 0xfe]);
    expect(toEDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "h'fffe'"
    );
  });
  test("sqstr:'string' — control characters are escaped (not hex fallback)", () => {
    const bytes = new TextEncoder().encode('a\nb');
    expect(toEDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "'a\\nb'"
    );
  });
});

describe("sqstr:'printable-string' (default)", () => {
  test('printable ASCII → single-quoted', () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(toEDN(new CborByteString(bytes))).toBe("'Hello'");
  });
  test('single quote in value is escaped', () => {
    const bytes = new TextEncoder().encode("it's");
    expect(toEDN(new CborByteString(bytes))).toBe("'it\\'s'");
  });
  test('control character (\\n) → hex fallback', () => {
    const bytes = new TextEncoder().encode('a\nb');
    expect(toEDN(new CborByteString(bytes))).toBe("h'610a62'");
  });
  test('DEL (0x7F) → hex fallback', () => {
    const bytes = new Uint8Array([0x41, 0x7f, 0x42]);
    expect(toEDN(new CborByteString(bytes))).toBe("h'417f42'");
  });
  test('invalid UTF-8 → hex fallback', () => {
    const bytes = new Uint8Array([0xff, 0xfe]);
    expect(toEDN(new CborByteString(bytes))).toBe("h'fffe'");
  });
  test("sqstr:'none' suppresses single-quoted output", () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(toEDN(new CborByteString(bytes), { sqstr: 'none' })).toBe(
      "h'48656c6c6f'"
    );
  });
});

describe('CborIndefiniteByteString.toEDN()', () => {
  test('two chunks', () => {
    const node = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([0x01, 0x02])),
      new CborByteString(new Uint8Array([0x03, 0x04, 0x05])),
    ]);
    expect(toEDN(node)).toBe("(_ h'0102', h'030405')");
  });

  test('empty chunks', () => {
    expect(toEDN(new CborIndefiniteByteString([]))).toBe("''_");
  });
});

// ─── Text strings ─────────────────────────────────────────────────────────────

describe('CborTextString.toEDN()', () => {
  test('empty string', () => expect(toEDN(new CborTextString(''))).toBe('""'));
  test('hello', () =>
    expect(toEDN(new CborTextString('hello'))).toBe('"hello"'));
  test('with double quote', () =>
    expect(toEDN(new CborTextString('"'))).toBe('"\\""'));
  test('with backslash', () =>
    expect(toEDN(new CborTextString('\\'))).toBe('"\\\\"'));
  test('with newline', () =>
    expect(toEDN(new CborTextString('\n'))).toBe('"\\n"'));
  test('with tab', () => expect(toEDN(new CborTextString('\t'))).toBe('"\\t"'));
  test('with carriage return', () =>
    expect(toEDN(new CborTextString('\r'))).toBe('"\\r"'));
  test('control char U+0001', () =>
    expect(toEDN(new CborTextString('\x01'))).toBe('"\\u0001"'));
  test('unicode', () => expect(toEDN(new CborTextString('ü'))).toBe('"ü"'));
});

describe('CborIndefiniteTextString.toEDN()', () => {
  test('two chunks', () => {
    const node = new CborIndefiniteTextString([
      new CborTextString('strea'),
      new CborTextString('ming'),
    ]);
    expect(toEDN(node)).toBe('(_ "strea", "ming")');
  });

  test('empty', () => {
    expect(toEDN(new CborIndefiniteTextString([]))).toBe('""_');
  });
});

// ─── Arrays ───────────────────────────────────────────────────────────────────

describe('CborArray.toEDN() — single-line', () => {
  test('[]', () => expect(toEDN(new CborArray([]))).toBe('[]'));

  test('[1, 2, 3]', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborUint(2n),
      new CborUint(3n),
    ]);
    expect(toEDN(node)).toBe('[1,2,3]');
  });

  test('nested [1, [2, 3]]', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborArray([new CborUint(2n), new CborUint(3n)]),
    ]);
    expect(toEDN(node)).toBe('[1,[2,3]]');
  });

  test('[_ ] empty indefinite', () => {
    expect(toEDN(new CborArray([], { indefiniteLength: true }))).toBe('[_ ]');
  });

  test('[_ 1, 2] indefinite', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)], {
      indefiniteLength: true,
    });
    expect(toEDN(node)).toBe('[_ 1,2]');
  });
});

describe('CborArray.toEDN() — multi-line', () => {
  test('[1, 2, 3] with indent=2', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborUint(2n),
      new CborUint(3n),
    ]);
    expect(toEDN(node, { indent: 2 })).toBe('[\n  1,\n  2,\n  3\n]');
  });

  test('nested with indent=2', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborArray([new CborUint(2n), new CborUint(3n)]),
    ]);
    expect(toEDN(node, { indent: 2 })).toBe(
      '[\n  1,\n  [\n    2,\n    3\n  ]\n]'
    );
  });

  test('indefinite [_ 1, 2] with indent=2', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)], {
      indefiniteLength: true,
    });
    expect(toEDN(node, { indent: 2 })).toBe('[_ \n  1,\n  2\n]');
  });

  test('empty array with indent stays single-line', () => {
    expect(toEDN(new CborArray([]), { indent: 2 })).toBe('[]');
  });
});

describe('CborArray.toEDN() — commas option', () => {
  const node = () =>
    new CborArray([new CborUint(1n), new CborUint(2n), new CborUint(3n)]);

  test("commas:'none' single-line → space-separated", () => {
    expect(toEDN(node(), { commas: 'none' })).toBe('[1 2 3]');
  });

  test("commas:'none' multi-line → no trailing comma on lines", () => {
    expect(toEDN(node(), { commas: 'none', indent: 2 })).toBe(
      '[\n  1\n  2\n  3\n]'
    );
  });

  test("commas:'trailing' multi-line → trailing comma on last item", () => {
    expect(toEDN(node(), { commas: 'trailing', indent: 2 })).toBe(
      '[\n  1,\n  2,\n  3,\n]'
    );
  });

  test("commas:'trailing' has no effect on single-line", () => {
    expect(toEDN(node(), { commas: 'trailing' })).toBe('[1,2,3]');
  });
});

// ─── Maps ─────────────────────────────────────────────────────────────────────

describe('CborMap.toEDN() — single-line', () => {
  test('{}', () => expect(toEDN(new CborMap([]))).toBe('{}'));

  test('{1: 2, 3: 4}', () => {
    const node = new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);
    expect(toEDN(node)).toBe('{1:2,3:4}');
  });

  test('{_ } empty indefinite', () => {
    expect(toEDN(new CborMap([], { indefiniteLength: true }))).toBe('{_ }');
  });

  test('{_ "a": 1} indefinite', () => {
    const node = new CborMap([[new CborTextString('a'), new CborUint(1n)]], {
      indefiniteLength: true,
    });
    expect(toEDN(node)).toBe('{_ "a":1}');
  });
});

describe('CborMap.toEDN() — multi-line', () => {
  test('{1: 2, 3: 4} with indent=2', () => {
    const node = new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);
    expect(toEDN(node, { indent: 2 })).toBe('{\n  1: 2,\n  3: 4\n}');
  });

  test('empty map with indent stays single-line', () => {
    expect(toEDN(new CborMap([]), { indent: 2 })).toBe('{}');
  });
});

describe('CborMap.toEDN() — commas option', () => {
  const node = () =>
    new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);

  test("commas:'none' single-line → space-separated", () => {
    expect(toEDN(node(), { commas: 'none' })).toBe('{1:2 3:4}');
  });

  test("commas:'none' multi-line → no trailing comma on lines", () => {
    expect(toEDN(node(), { commas: 'none', indent: 2 })).toBe(
      '{\n  1: 2\n  3: 4\n}'
    );
  });

  test("commas:'trailing' multi-line → trailing comma on last item", () => {
    expect(toEDN(node(), { commas: 'trailing', indent: 2 })).toBe(
      '{\n  1: 2,\n  3: 4,\n}'
    );
  });

  test("commas:'trailing' has no effect on single-line", () => {
    expect(toEDN(node(), { commas: 'trailing' })).toBe('{1:2,3:4}');
  });
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('CborTag.toEDN()', () => {
  test('0("2013-03-21T20:04:00Z")', () => {
    const node = new CborTag(0n, new CborTextString('2013-03-21T20:04:00Z'));
    expect(toEDN(node)).toBe('0("2013-03-21T20:04:00Z")');
  });

  test('1(1363896240)', () => {
    const node = new CborTag(1n, new CborUint(1363896240n));
    expect(toEDN(node)).toBe('1(1363896240)');
  });

  test("23(h'01020304')", () => {
    const node = new CborTag(
      23n,
      new CborByteString(new Uint8Array([1, 2, 3, 4]))
    );
    expect(toEDN(node)).toBe("23(h'01020304')");
  });
});

// ─── Floats ───────────────────────────────────────────────────────────────────

describe('CborFloat.toEDN()', () => {
  test('0.0 (half, auto)', () => expect(toEDN(new CborFloat(0.0))).toBe('0.0'));
  test('-0.0 (half, auto)', () =>
    expect(toEDN(new CborFloat(-0.0))).toBe('-0.0'));
  test('1.0 (half, auto — no suffix)', () =>
    expect(toEDN(new CborFloat(1.0))).toBe('1.0'));
  test('1.5 (half, auto)', () => expect(toEDN(new CborFloat(1.5))).toBe('1.5'));
  test('1.1 (double, auto)', () =>
    expect(toEDN(new CborFloat(1.1))).toBe('1.1'));
  test('100000.0 (single, auto)', () =>
    expect(toEDN(new CborFloat(100000.0))).toBe('100000.0'));
  test('Infinity (half, auto)', () =>
    expect(toEDN(new CborFloat(Infinity))).toBe('Infinity'));
  test('-Infinity (half, auto)', () =>
    expect(toEDN(new CborFloat(-Infinity))).toBe('-Infinity'));
  test('NaN (half, auto)', () => expect(toEDN(new CborFloat(NaN))).toBe('NaN'));

  // ── NaN with non-auto precision ───────────────────────────────────────────

  test('NaN precision=half → NaN (matches auto)', () => {
    expect(toEDN(new CborFloat(NaN, { precision: 'half' }))).toBe('NaN');
  });
  test('NaN precision=single → NaN_2', () => {
    expect(toEDN(new CborFloat(NaN, { precision: 'single' }))).toBe('NaN_2');
  });
  test('NaN precision=double → NaN_3', () => {
    expect(toEDN(new CborFloat(NaN, { precision: 'double' }))).toBe('NaN_3');
  });

  // ── Infinity with non-auto precision ──────────────────────────────────────

  test('Infinity precision=half → Infinity (matches auto)', () => {
    expect(toEDN(new CborFloat(Infinity, { precision: 'half' }))).toBe(
      'Infinity'
    );
  });
  test('Infinity precision=single → Infinity_2', () => {
    expect(toEDN(new CborFloat(Infinity, { precision: 'single' }))).toBe(
      'Infinity_2'
    );
  });
  test('Infinity precision=double → Infinity_3', () => {
    expect(toEDN(new CborFloat(Infinity, { precision: 'double' }))).toBe(
      'Infinity_3'
    );
  });
  test('-Infinity precision=half → -Infinity (matches auto)', () => {
    expect(toEDN(new CborFloat(-Infinity, { precision: 'half' }))).toBe(
      '-Infinity'
    );
  });
  test('-Infinity precision=single → -Infinity_2', () => {
    expect(toEDN(new CborFloat(-Infinity, { precision: 'single' }))).toBe(
      '-Infinity_2'
    );
  });
  test('-Infinity precision=double → -Infinity_3', () => {
    expect(toEDN(new CborFloat(-Infinity, { precision: 'double' }))).toBe(
      '-Infinity_3'
    );
  });

  test('1.0 precision=half → no suffix (matches auto)', () => {
    expect(toEDN(new CborFloat(1.0, { precision: 'half' }))).toBe('1.0');
  });
  test('1.0 precision=single → _2 suffix', () => {
    expect(toEDN(new CborFloat(1.0, { precision: 'single' }))).toBe('1.0_2');
  });
  test('1.0 precision=double → _3 suffix', () => {
    expect(toEDN(new CborFloat(1.0, { precision: 'double' }))).toBe('1.0_3');
  });
  test('100000.0 precision=half → _1 suffix (mismatches auto=single)', () => {
    expect(toEDN(new CborFloat(100000.0, { precision: 'half' }))).toBe(
      '100000.0_1'
    );
  });
  test('1.1 precision=double → no suffix (matches auto)', () => {
    expect(toEDN(new CborFloat(1.1, { precision: 'double' }))).toBe('1.1');
  });
});

// ─── floatFormat: 'hex' ───────────────────────────────────────────────────────

describe("CborFloat.toEDN() — floatFormat: 'hex'", () => {
  test('1.5 → 0x1.8p+0', () => {
    expect(toEDN(new CborFloat(1.5), { floatFormat: 'hex' })).toBe('0x1.8p+0');
  });
  test('1.0 → 0x1p+0', () => {
    expect(toEDN(new CborFloat(1.0), { floatFormat: 'hex' })).toBe('0x1p+0');
  });
  test('-1.5 → -0x1.8p+0', () => {
    expect(toEDN(new CborFloat(-1.5), { floatFormat: 'hex' })).toBe(
      '-0x1.8p+0'
    );
  });
  test('+0 → 0x0p+0', () => {
    expect(toEDN(new CborFloat(0.0), { floatFormat: 'hex' })).toBe('0x0p+0');
  });
  test('-0 → -0x0p+0', () => {
    expect(toEDN(new CborFloat(-0.0), { floatFormat: 'hex' })).toBe('-0x0p+0');
  });

  // Non-finite values are unchanged regardless of floatFormat
  test('Infinity → "Infinity" (unchanged)', () => {
    expect(toEDN(new CborFloat(Infinity), { floatFormat: 'hex' })).toBe(
      'Infinity'
    );
  });
  test('-Infinity → "-Infinity" (unchanged)', () => {
    expect(toEDN(new CborFloat(-Infinity), { floatFormat: 'hex' })).toBe(
      '-Infinity'
    );
  });
  test('NaN → "NaN" (unchanged)', () => {
    expect(toEDN(new CborFloat(NaN), { floatFormat: 'hex' })).toBe('NaN');
  });

  // Precision suffix is still emitted with hex format
  test('1.0 precision=single → 0x1p+0_2', () => {
    expect(
      toEDN(new CborFloat(1.0, { precision: 'single' }), { floatFormat: 'hex' })
    ).toBe('0x1p+0_2');
  });
  test('1.0 precision=double → 0x1p+0_3', () => {
    expect(
      toEDN(new CborFloat(1.0, { precision: 'double' }), { floatFormat: 'hex' })
    ).toBe('0x1p+0_3');
  });

  // default floatFormat behaves same as 'decimal'
  test("floatFormat: 'decimal' same as default", () => {
    const f = new CborFloat(1.5);
    expect(toEDN(f, { floatFormat: 'decimal' })).toBe(toEDN(f));
  });
});

// ─── intFormat ────────────────────────────────────────────────────────────────

describe('CborUint.toEDN() — intFormat', () => {
  test("default (decimal): 42 → '42'", () => {
    expect(toEDN(new CborUint(42n))).toBe('42');
  });
  test("'hex': 42 → '0x2a'", () => {
    expect(toEDN(new CborUint(42n), { intFormat: 'hex' })).toBe('0x2a');
  });
  test("'octal': 42 → '0o52'", () => {
    expect(toEDN(new CborUint(42n), { intFormat: 'octal' })).toBe('0o52');
  });
  test("'binary': 42 → '0b101010'", () => {
    expect(toEDN(new CborUint(42n), { intFormat: 'binary' })).toBe('0b101010');
  });
  test("0 → '0x0' in hex", () => {
    expect(toEDN(new CborUint(0n), { intFormat: 'hex' })).toBe('0x0');
  });
  test("encodingWidth preserved: 42_1 in hex → '0x2a_1'", () => {
    expect(
      toEDN(new CborUint(42n, { encodingWidth: 1 }), { intFormat: 'hex' })
    ).toBe('0x2a_1');
  });
  test("'decimal' same as default", () => {
    const n = new CborUint(255n);
    expect(toEDN(n, { intFormat: 'decimal' })).toBe(toEDN(n));
  });
});

describe('CborNint.toEDN() — intFormat', () => {
  test("default (decimal): -1 → '-1'", () => {
    expect(toEDN(new CborNint(-1n))).toBe('-1');
  });
  test("'hex': -1 → '-0x1'", () => {
    expect(toEDN(new CborNint(-1n), { intFormat: 'hex' })).toBe('-0x1');
  });
  test("'hex': -14159024 → '-0xd80cb0'", () => {
    expect(toEDN(new CborNint(-14159024n), { intFormat: 'hex' })).toBe(
      '-0xd80cb0'
    );
  });
  test("'octal': -8 → '-0o10'", () => {
    expect(toEDN(new CborNint(-8n), { intFormat: 'octal' })).toBe('-0o10');
  });
  test("'binary': -1 → '-0b1'", () => {
    expect(toEDN(new CborNint(-1n), { intFormat: 'binary' })).toBe('-0b1');
  });
  test("encodingWidth preserved: -1_1 in hex → '-0x1_1'", () => {
    expect(
      toEDN(new CborNint(-1n, { encodingWidth: 1 }), { intFormat: 'hex' })
    ).toBe('-0x1_1');
  });
});

// ─── Simple values ────────────────────────────────────────────────────────────

describe('CborSimple.toEDN()', () => {
  test('false', () => expect(toEDN(CborSimple.FALSE)).toBe('false'));
  test('true', () => expect(toEDN(CborSimple.TRUE)).toBe('true'));
  test('null', () => expect(toEDN(CborSimple.NULL)).toBe('null'));
  test('undefined', () =>
    expect(toEDN(CborSimple.UNDEFINED)).toBe('undefined'));
  test('simple(16)', () =>
    expect(toEDN(new CborSimple(16))).toBe('simple(16)'));
  test('simple(255)', () =>
    expect(toEDN(new CborSimple(255))).toBe('simple(255)'));
});

// ─── toEDN() convenience function ────────────────────────────────────────────

describe('toEDN() delegates to node.toEDN()', () => {
  test('delegates', () => {
    const node = new CborUint(42n);
    expect(toEDN(node)).toBe(node.toEDN());
  });
});
