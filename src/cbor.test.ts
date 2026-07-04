import { describe, test, expect, vi } from 'vitest';
import { CBOR } from './cbor';
import { b32, h32 } from './extensions/b32';
import { CborUint } from './ast/CborUint';
import { CborNint } from './ast/CborNint';
import { CborTextString } from './ast/CborTextString';
import { CborByteString } from './ast/CborByteString';
import { CborArray } from './ast/CborArray';
import { CborMap } from './ast/CborMap';
import { CborFloat } from './ast/CborFloat';
import { CborSimple } from './ast/CborSimple';

/** Convert a hex string to Uint8Array. */
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

// ─── CBOR.fromCBOR ───────────────────────────────────────────────────────────

describe('CBOR.fromCBOR()', () => {
  test('decodes CborUint', () => {
    const node = CBOR.fromCBOR(hex('1864')); // 100
    expect(node).toBeInstanceOf(CborUint);
    expect((node as CborUint).value).toBe(100n);
  });

  test('decodes CborNint', () => {
    const node = CBOR.fromCBOR(hex('3863')); // -100
    expect(node).toBeInstanceOf(CborNint);
    expect((node as CborNint).value).toBe(-100n);
  });

  test('decodes CborTextString', () => {
    const node = CBOR.fromCBOR(hex('6449455446')); // "IETF"
    expect(node).toBeInstanceOf(CborTextString);
    expect((node as CborTextString).value).toBe('IETF');
  });

  test('decodes CborArray', () => {
    const node = CBOR.fromCBOR(hex('83010203')); // [1, 2, 3]
    expect(node).toBeInstanceOf(CborArray);
  });

  test('decodes CborMap', () => {
    const node = CBOR.fromCBOR(hex('a201020304')); // {1: 2, 3: 4}
    expect(node).toBeInstanceOf(CborMap);
  });

  test('decodes CborFloat', () => {
    const node = CBOR.fromCBOR(hex('f93c00')); // 1.0 (half)
    expect(node).toBeInstanceOf(CborFloat);
    expect((node as CborFloat).value).toBe(1.0);
  });

  test('decodes CborSimple.TRUE', () => {
    const node = CBOR.fromCBOR(hex('f5'));
    expect(node).toBeInstanceOf(CborSimple);
    expect((node as CborSimple).value).toBe(21);
  });

  test('decodes CborSimple.NULL', () => {
    const node = CBOR.fromCBOR(hex('f6'));
    expect(node).toBeInstanceOf(CborSimple);
    expect((node as CborSimple).value).toBe(22);
  });

  test('supports offset and allowTrailing', () => {
    const first = CBOR.fromCBOR(hex('01 02'), {
      allowTrailing: true,
    }) as CborUint;
    const second = CBOR.fromCBOR(hex('01 02'), {
      offset: first.end,
      allowTrailing: true,
    }) as CborUint;
    expect(first.value).toBe(1n);
    expect(first.end).toBe(1);
    expect(second.value).toBe(2n);
    expect(second.start).toBe(1);
  });
});

// ─── CBOR.fromCDN ────────────────────────────────────────────────────────────

describe('CBOR.fromCDN()', () => {
  test('parses integer', () => {
    const node = CBOR.fromCDN('42');
    expect(node).toBeInstanceOf(CborUint);
    expect((node as CborUint).value).toBe(42n);
  });

  test('parses string', () => {
    const node = CBOR.fromCDN('"hello"');
    expect(node).toBeInstanceOf(CborTextString);
    expect((node as CborTextString).value).toBe('hello');
  });

  test('parses byte string', () => {
    const node = CBOR.fromCDN("h'0102'");
    expect(node).toBeInstanceOf(CborByteString);
    expect((node as CborByteString).value).toEqual(new Uint8Array([1, 2]));
  });

  test('parses array', () => {
    const node = CBOR.fromCDN('[1, 2, 3]');
    expect(node).toBeInstanceOf(CborArray);
    expect((node as CborArray).items).toHaveLength(3);
  });

  test('parses true/false/null', () => {
    expect(CBOR.fromCDN('true')).toBeInstanceOf(CborSimple);
    expect((CBOR.fromCDN('true') as CborSimple).value).toBe(21);
    expect((CBOR.fromCDN('false') as CborSimple).value).toBe(20);
    expect((CBOR.fromCDN('null') as CborSimple).value).toBe(22);
  });

  // ── Adjacent items without separator ──────────────────────────────────────

  test('adjacent array items without separator throw in strict mode', () => {
    expect(() => CBOR.fromCDN('[{}{}]')).toThrow(SyntaxError);
    expect(() => CBOR.fromCDN('[1 2]')).not.toThrow(); // space is valid
    expect(() => CBOR.fromCDN('[1,2]')).not.toThrow(); // comma is valid
  });

  test('adjacent map entries without separator throw in strict mode', () => {
    expect(() => CBOR.fromCDN('{[]:[][]:[]}', { allowTrailing: true })).toThrow(
      SyntaxError
    );
    expect(() => CBOR.fromCDN('{"a":1 "b":2}')).not.toThrow(); // space is valid
  });

  test('adjacent items without separator warn in non-strict mode', () => {
    const warnings: string[] = [];
    const node = CBOR.fromCDN('[{}{}]', {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
      silent: true,
    });
    expect((node as CborArray).items).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('separated');
  });

  // ── Indefinite string group adjacent chunks ────────────────────────────────

  test('adjacent indefinite string chunks without separator throw in strict mode', () => {
    expect(() => CBOR.fromCDN("(_ h'01'h'02')")).toThrow(SyntaxError);
    expect(() => CBOR.fromCDN('(_ """")')).toThrow(SyntaxError);
  });

  test('indefinite string chunks with separator are valid', () => {
    expect(() => CBOR.fromCDN("(_ h'01' h'02')")).not.toThrow(); // space
    expect(() => CBOR.fromCDN("(_ h'01',h'02')")).not.toThrow(); // comma
    expect(() => CBOR.fromCDN('(_ "" "")')).not.toThrow(); // space
    expect(() => CBOR.fromCDN('(_ "", "")')).not.toThrow(); // comma
  });

  test('supports offset and allowTrailing', () => {
    const first = CBOR.fromCDN('1 2', {
      allowTrailing: true,
    }) as CborUint;
    const second = CBOR.fromCDN('1 2', {
      offset: first.end,
      allowTrailing: true,
    }) as CborUint;
    expect(first.value).toBe(1n);
    expect(first.end).toBe(1);
    expect(second.value).toBe(2n);
    expect(second.start).toBe(2);
  });
});

// ─── CBOR.fromJS ─────────────────────────────────────────────────────────────

describe('CBOR.fromJS()', () => {
  test('converts null', () => {
    expect(CBOR.fromJS(null)).toBe(CborSimple.NULL);
  });

  test('converts integer number', () => {
    const node = CBOR.fromJS(42);
    expect(node).toBeInstanceOf(CborUint);
  });

  test('converts negative number', () => {
    const node = CBOR.fromJS(-5);
    expect(node).toBeInstanceOf(CborNint);
  });

  test('converts string', () => {
    const node = CBOR.fromJS('hello');
    expect(node).toBeInstanceOf(CborTextString);
  });

  test('converts array', () => {
    const node = CBOR.fromJS([1, 2, 3]);
    expect(node).toBeInstanceOf(CborArray);
  });

  test('converts object', () => {
    const node = CBOR.fromJS({ a: 1 });
    expect(node).toBeInstanceOf(CborMap);
  });

  test('encodeIntegerAs=float option', () => {
    const node = CBOR.fromJS(42, { encodeIntegerAs: 'float' });
    expect(node).toBeInstanceOf(CborFloat);
  });
});

// ─── CBOR.decode ─────────────────────────────────────────────────────────────

describe('CBOR.decode()', () => {
  test('uint → number', () => {
    expect(CBOR.decode(hex('1864'))).toBe(100);
  });

  test('text string → string', () => {
    expect(CBOR.decode(hex('6449455446'))).toBe('IETF');
  });

  test('array → Array', () => {
    expect(CBOR.decode(hex('83010203'))).toEqual([1, 2, 3]);
  });

  test('map with text keys → object', () => {
    // {"a": 1, "b": [2, 3]}
    const bytes = hex('a26161016162820203');
    const result = CBOR.decode(bytes) as Record<string, unknown>;
    expect(result).toEqual({ a: 1, b: [2, 3] });
  });

  test('true/false/null → JS booleans/null', () => {
    expect(CBOR.decode(hex('f5'))).toBe(true);
    expect(CBOR.decode(hex('f4'))).toBe(false);
    expect(CBOR.decode(hex('f6'))).toBe(null);
  });
});

// ─── CBOR.encode ─────────────────────────────────────────────────────────────

describe('CBOR.encode()', () => {
  test('encodes integer 0', () => {
    expect(toHex(CBOR.encode(0))).toBe('00');
  });

  test('encodes integer 42', () => {
    expect(toHex(CBOR.encode(42))).toBe('182a');
  });

  test('encodes negative -1', () => {
    expect(toHex(CBOR.encode(-1))).toBe('20');
  });

  test('encodes string', () => {
    expect(toHex(CBOR.encode('IETF'))).toBe('6449455446');
  });

  test('encodes null', () => {
    expect(toHex(CBOR.encode(null))).toBe('f6');
  });

  test('encodes true', () => {
    expect(toHex(CBOR.encode(true))).toBe('f5');
  });

  test('encodes array', () => {
    expect(toHex(CBOR.encode([1, 2, 3]))).toBe('83010203');
  });

  test('encodes plain object', () => {
    // {"a": 1} — keys will be text strings since fromJS uses CborTextString for string keys
    const bytes = CBOR.encode({ a: 1 });
    // "a": 0x61, 1: 0x01
    expect(toHex(bytes)).toBe('a161610 1'.replace(/\s/g, ''));
    // Actually let's just check it round-trips
    const decoded = CBOR.decode(bytes);
    expect(decoded).toEqual({ a: 1 });
  });
});

// ─── CBOR.cborToCdn / CBOR.cborEdnToCbor ────────────────────────────────

describe('CBOR.cborToCdn()', () => {
  test('converts CBOR bytes to compact CDN text', () => {
    expect(CBOR.cborToCdn(hex('83010203'))).toBe('[1,2,3]');
  });

  test('accepts ToCDNOptions', () => {
    expect(CBOR.cborToCdn(hex('83010203'), { indent: 2 })).toBe(
      '[\n  1,\n  2,\n  3\n]'
    );
  });
});

describe('CBOR.cborEdnToCbor()', () => {
  test('converts CDN text to CBOR bytes', () => {
    expect(toHex(CBOR.cborEdnToCbor('[1, 2, 3]'))).toBe('83010203');
  });

  test('accepts FromCDNOptions', () => {
    expect(
      toHex(
        CBOR.cborEdnToCbor("h'68' + h'69'", {
          unresolvedExtension: 'error',
        })
      )
    ).toBe('426869');
  });
});

// ─── CBOR.parse ──────────────────────────────────────────────────────────────

describe('CBOR.parse()', () => {
  test('parses integer EDN to JS number', () => {
    expect(CBOR.parse('42')).toBe(42);
  });

  test('parses string EDN to JS string', () => {
    expect(CBOR.parse('"hello"')).toBe('hello');
  });

  test('parses array EDN to JS array', () => {
    expect(CBOR.parse('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  test('parses map EDN to JS object (string keys)', () => {
    expect(CBOR.parse('{"a": 1, "b": 2}')).toEqual({ a: 1, b: 2 });
  });

  test('parses true/false/null', () => {
    expect(CBOR.parse('true')).toBe(true);
    expect(CBOR.parse('false')).toBe(false);
    expect(CBOR.parse('null')).toBe(null);
  });
});

// ─── CBOR.stringify ───────────────────────────────────────────────────────────

describe('CBOR.stringify()', () => {
  test('stringifies integer', () => {
    expect(CBOR.stringify(42)).toBe('42');
  });

  test('stringifies string', () => {
    expect(CBOR.stringify('hello')).toBe('"hello"');
  });

  test('stringifies null', () => {
    expect(CBOR.stringify(null)).toBe('null');
  });

  test('stringifies true', () => {
    expect(CBOR.stringify(true)).toBe('true');
  });

  test('stringifies array [1, 2, 3]', () => {
    expect(CBOR.stringify([1, 2, 3])).toBe('[1,2,3]');
  });

  test('stringifies with indent', () => {
    const result = CBOR.stringify([1, 2], { indent: 2 });
    expect(result).toBe('[\n  1,\n  2\n]');
  });

  test('stringifies float', () => {
    expect(CBOR.stringify(1.5)).toBe('1.5');
  });

  test('stringifies -0', () => {
    expect(CBOR.stringify(-0)).toBe('-0.0');
  });
});

// ─── CBOR.format ──────────────────────────────────────────────────────────────

describe('CBOR.format()', () => {
  test('normalizes extra whitespace to compact output by default', () => {
    expect(CBOR.format('[  1 ,  2 ,  3  ]')).toBe('[1,2,3]');
  });

  test('normalizes map whitespace to compact output by default', () => {
    expect(CBOR.format('{  1 :  2 ,  3 :  4  }')).toBe('{1:2,3:4}');
  });

  test('pretty-prints with indent option', () => {
    expect(CBOR.format('[1, 2, 3]', { indent: 2 })).toBe(
      '[\n  1,\n  2,\n  3\n]'
    );
  });

  test('nested structure with indent', () => {
    expect(CBOR.format('{1: [2, 3]}', { indent: 2 })).toBe(
      '{\n  1: [\n    2,\n    3\n  ]\n}'
    );
  });

  test('splits text strings at newline characters when requested', () => {
    expect(
      CBOR.format('{"text": "line1\\nline2\\nline3"}', {
        indent: 2,
        textStringFormat: ['newline'],
      })
    ).toBe('{\n  "text": "line1\\n" +\n    "line2\\n" +\n    "line3"\n}');
  });

  test('does not split text strings without indent', () => {
    expect(
      CBOR.format('{"text": "line1\\nline2"}', {
        textStringFormat: ['newline'],
      })
    ).toBe('{"text":"line1\\nline2"}');
  });

  test('splits text strings containing CDN when requested', () => {
    expect(
      CBOR.format('{"json": "{\\"key\\":\\"value\\"}"}', {
        indent: 2,
        textStringFormat: ['cdn'],
      })
    ).toBe('{\n  "json": "{" +\n      "\\"key\\":\\"value\\"" +\n    "}"\n}');
  });

  test('accepts cboredn as a deprecated alias for cdn text string formatting', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(
      CBOR.format('{"json": "{\\"key\\":\\"value\\"}"}', {
        indent: 2,
        textStringFormat: ['cboredn'],
      })
    ).toBe('{\n  "json": "{" +\n      "\\"key\\":\\"value\\"" +\n    "}"\n}');

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "`textStringFormat: ['cboredn']` is deprecated; use `textStringFormat: ['cdn']` instead."
    );
    warn.mockRestore();
  });

  test('combines CDN split points with newline split points', () => {
    expect(
      CBOR.format('{"edn": "[\\n1,2\\n]"}', {
        indent: 2,
        textStringFormat: ['cdn', 'newline'],
      })
    ).toBe('{\n  "edn": "[\\n" +\n      "1," +\n      "2\\n" +\n    "]"\n}');
  });

  test('splits newlines inside CDN text string chunks', () => {
    expect(
      CBOR.format('{"json": "{\\"key\\": \\"line1\\nline2\\"}"}', {
        indent: 2,
        textStringFormat: ['newline', 'cdn'],
      })
    ).toBe(
      '{\n  "json": "{" +\n      "\\"key\\": \\"line1\\n" +\n        "line2\\"" +\n    "}"\n}'
    );
  });

  test('splits trailing comma before closing CDN container', () => {
    expect(
      CBOR.format('{"json":"{\\"a\\":\\"1\\",}"}', {
        indent: 2,
        textStringFormat: ['newline', 'cdn'],
      })
    ).toBe('{\n  "json": "{" +\n      "\\"a\\":\\"1\\"," +\n    "}"\n}');
  });

  test('keeps CDN container encoding indicators with the opener chunk', () => {
    expect(
      CBOR.format('{"json":"{_1 \\"a\\":\\"1\\"}"}', {
        indent: 2,
        textStringFormat: ['newline', 'cdn'],
      })
    ).toBe('{\n  "json": "{_1 " +\n      "\\"a\\":\\"1\\"" +\n    "}"\n}');
  });

  test('keeps CDN indefinite marker with the opener chunk', () => {
    expect(
      CBOR.format('{"json":"{_ \\"a\\":\\"1\\"}"}', {
        indent: 2,
        textStringFormat: ['newline', 'cdn'],
      })
    ).toBe('{\n  "json": "{_ " +\n      "\\"a\\":\\"1\\"" +\n    "}"\n}');
  });

  test('does not split empty CDN containers with opener modifiers', () => {
    expect(
      CBOR.format(
        '{"object": "{_1 }", "array": "[_1 ]", "indefObject": "{_ }", "indefArray": "[_ ]"}',
        {
          indent: 2,
          textStringFormat: ['cdn'],
        }
      )
    ).toBe(
      '{\n  "object": "{_1 }",\n  "array": "[_1 ]",\n  "indefObject": "{_ }",\n  "indefArray": "[_ ]"\n}'
    );
  });

  test('keeps CDN array opener modifiers with the opener chunk', () => {
    expect(
      CBOR.format('{"array":"[_ \\"a\\"]"}', {
        indent: 2,
        textStringFormat: ['cdn'],
      })
    ).toBe('{\n  "array": "[_ " +\n      "\\"a\\"" +\n    "]"\n}');
  });

  test('keeps CDN layout whitespace at the end of previous chunks', () => {
    expect(
      CBOR.format('{ "json": "{\\n  1: 2\\n}" }', {
        indent: 2,
        textStringFormat: ['cdn'],
      })
    ).toBe('{\n  "json": "{\\n  " +\n      "1: 2\\n" +\n    "}"\n}');
  });

  test('indents nested CDN text string chunks by content depth', () => {
    expect(
      CBOR.format('{"json": "{\\"a\\":{\\"b\\":1}}"}', {
        indent: 2,
        textStringFormat: ['cdn'],
      })
    ).toBe(
      '{\n  "json": "{" +\n      "\\"a\\":{" +\n        "\\"b\\":1" +\n      "}" +\n    "}"\n}'
    );
  });

  test('does not split empty CDN containers in text strings', () => {
    expect(
      CBOR.format('{"object": "{}", "array": "[]"}', {
        indent: 2,
        textStringFormat: ['cdn'],
      })
    ).toBe('{\n  "object": "{}",\n  "array": "[]"\n}');
  });

  test('splits commented CDN text strings without hiding comments in leading chunks', () => {
    expect(
      CBOR.format(
        '{"json": "//leading comment\\n{\\n  1: 2,\\n  /* block comment */\\n  3: 4\\n}\\n// trailing comment"}',
        {
          indent: 2,
          textStringFormat: ['cdn'],
        }
      )
    ).toBe(
      '{\n  "json": "//leading comment\\n" +\n    "{\\n  " +\n      "1: 2,\\n  /* block comment */\\n  " +\n      "3: 4\\n" +\n    "}\\n" +\n    "// trailing comment"\n}'
    );
  });

  test('falls back to newline splitting when CDN parsing fails', () => {
    expect(
      CBOR.format('{"text": "line1\\nline2"}', {
        indent: 2,
        textStringFormat: ['cdn', 'newline'],
      })
    ).toBe('{\n  "text": "line1\\n" +\n    "line2"\n}');
  });

  test('keeps text string encoding indicator on the concatenation chain', () => {
    expect(
      CBOR.format('"line1\\nline2"_1', {
        indent: 2,
        textStringFormat: ['newline'],
      })
    ).toBe('"line1\\n" +\n  "line2"_1');
  });

  test('passes commas option through to toCDN', () => {
    expect(CBOR.format('[1, 2, 3]', { indent: 2, commas: 'trailing' })).toBe(
      '[\n  1,\n  2,\n  3,\n]'
    );
  });

  test('preserves non-concatenated byte string literals when requested', () => {
    expect(CBOR.format("h'6869'", { preserveByteString: true })).toBe(
      "h'6869'"
    );
    expect(
      CBOR.format("h'01 # first\n 02'", {
        preserveByteString: true,
      })
    ).toBe("h'01 # first\n 02'");
    expect(
      CBOR.format("b64' aGk # greeting\n '", {
        preserveByteString: true,
      })
    ).toBe("b64' aGk # greeting\n '");
    expect(
      CBOR.format("b32' NBUQ # b32\n '", {
        preserveByteString: true,
        extensions: [b32],
      })
    ).toBe("b32' NBUQ # b32\n '");
    expect(
      CBOR.format("h32' D1KG # h32\n '", {
        preserveByteString: true,
        extensions: [h32],
      })
    ).toBe("h32' D1KG # h32\n '");
    expect(CBOR.format("'hi'", { preserveByteString: true })).toBe("'hi'");
  });

  test('preserves raw byte string literals when requested', () => {
    expect(
      CBOR.format('h`01 # first\n 02`', {
        preserveByteString: true,
      })
    ).toBe('h`01 # first\n 02`');
  });

  test('does not preserve byte string literals across concatenation', () => {
    expect(
      CBOR.format("h'68' + h'69'", {
        preserveByteString: true,
      })
    ).toBe("'hi'");
  });

  test('joins text string concatenation by default', () => {
    expect(CBOR.format('"a" + "b"')).toBe('"ab"');
  });

  test('preserves text string concatenation when requested', () => {
    expect(CBOR.format('"a" + "b"', { preserveConcatenation: true })).toBe(
      '"a" + "b"'
    );
    expect(CBOR.format("'a' + 'b'", { preserveConcatenation: true })).toBe(
      "'a' + 'b'"
    );
  });

  test('splits preserved concatenation across lines with indent', () => {
    expect(
      CBOR.format('{"k": "a" + "b"}', {
        indent: 2,
        preserveConcatenation: true,
      })
    ).toBe('{\n  "k": "a" +\n    "b"\n}');
  });

  test('preserves byte string concatenation when requested', () => {
    expect(CBOR.format("h'01' + h'02'", { preserveConcatenation: true })).toBe(
      "h'01' + h'02'"
    );
    // Each part is re-serialized with the normal rules (sqstr, bstrEncoding).
    expect(CBOR.format("h'68' + h'69'", { preserveConcatenation: true })).toBe(
      "'h' + 'i'"
    );
    expect(
      CBOR.format("h'68' + b64'aQ'", {
        preserveConcatenation: true,
        sqstr: 'none',
      })
    ).toBe("h'68' + h'69'");
  });

  test('preserves byte string part spelling with preserveByteString', () => {
    expect(
      CBOR.format("h'68' + b64'aQ'", {
        preserveConcatenation: true,
        preserveByteString: true,
      })
    ).toBe("h'68' + b64'aQ'");
  });

  test('normalizes byte string parts in preserved text concatenation', () => {
    expect(CBOR.format('"a" + h\'62\'', { preserveConcatenation: true })).toBe(
      '"a" + "b"'
    );
  });

  test('keeps encoding indicator at the end of a preserved chain', () => {
    expect(CBOR.format('"a" + "b"_3', { preserveConcatenation: true })).toBe(
      '"a" + "b"_3'
    );
  });

  test('splitNewline combines with preserved concatenation', () => {
    expect(
      CBOR.format('"a\\n" + "b\\nc"', {
        indent: 2,
        preserveConcatenation: true,
        splitNewline: true,
      })
    ).toBe('"a\\n" +\n  "b\\n" +\n  "c"');
  });

  test('preserved concatenation ignores splitNewline without newlines', () => {
    expect(
      CBOR.format('"ab" + "cd"', {
        indent: 2,
        preserveConcatenation: true,
        splitNewline: true,
      })
    ).toBe('"ab" +\n  "cd"');
  });

  test('splitCdn takes precedence over preserved concatenation', () => {
    expect(
      CBOR.format('{"json": "{" + "\\"key\\": \\"value\\"" + "}"}', {
        indent: 2,
        preserveConcatenation: true,
        splitCdn: true,
      })
    ).toBe('{\n  "json": "{" +\n      "\\"key\\": \\"value\\"" +\n    "}"\n}');
  });

  test('splitCdn falls back to preserved concatenation for non-CDN strings', () => {
    expect(
      CBOR.format('"hello " + "world!"', {
        indent: 2,
        preserveConcatenation: true,
        splitCdn: true,
      })
    ).toBe('"hello " +\n  "world!"');
  });

  test('preserved concatenation round-trips through format', () => {
    const options = { indent: 2, preserveConcatenation: true } as const;
    const once = CBOR.format('{"k": "a" + "b" + "c"}', options);
    expect(CBOR.format(once, options)).toBe(once);
  });

  test('splitCdn formatting round-trips with preserveConcatenation', () => {
    const options = {
      indent: 2,
      preserveConcatenation: true,
      splitCdn: true,
    } as const;
    const once = CBOR.format('{"json": "{\\"key\\": \\"value\\"}"}', options);
    expect(once).toBe(
      '{\n  "json": "{" +\n      "\\"key\\": \\"value\\"" +\n    "}"\n}'
    );
    expect(CBOR.format(once, options)).toBe(once);
  });

  test('splitCdn / splitNewline replace deprecated textStringFormat', () => {
    expect(
      CBOR.format('{"text": "line1\\nline2"}', {
        indent: 2,
        splitNewline: true,
      })
    ).toBe('{\n  "text": "line1\\n" +\n    "line2"\n}');
    expect(
      CBOR.format('{"edn": "[\\n1,2\\n]"}', {
        indent: 2,
        splitCdn: true,
        splitNewline: true,
      })
    ).toBe('{\n  "edn": "[\\n" +\n      "1," +\n      "2\\n" +\n    "]"\n}');
  });

  test('splitCdn / splitNewline take precedence over textStringFormat', () => {
    expect(
      CBOR.format('{"text": "line1\\nline2"}', {
        indent: 2,
        splitNewline: false,
        textStringFormat: ['newline'],
      })
    ).toBe('{\n  "text": "line1\\nline2"\n}');
    expect(
      CBOR.format('{"text": "line1\\nline2"}', {
        indent: 2,
        splitCdn: false,
        textStringFormat: ['newline'],
      })
    ).toBe('{\n  "text": "line1\\n" +\n    "line2"\n}');
  });

  test('strips comments unless preserveComments is enabled', () => {
    expect(CBOR.format('[# a\n1, 2 # b\n]', { indent: 2 })).toBe(
      '[\n  1,\n  2\n]'
    );
  });

  test('preserves comments on the root item', () => {
    expect(CBOR.format('42 # end', { preserveComments: true })).toBe(
      '42 # end'
    );
    expect(CBOR.format('# start\n42 # end', { preserveComments: true })).toBe(
      '# start\n42 # end'
    );
  });

  test('root leading comments do not force compact containers to multiline', () => {
    expect(CBOR.format('# before\n[1, 2]', { preserveComments: true })).toBe(
      '# before\n[1,2]'
    );
    expect(CBOR.format('# before\n{1: 2}', { preserveComments: true })).toBe(
      '# before\n{1:2}'
    );
  });

  test('preserves array comments when requested', () => {
    expect(
      CBOR.format('[# first\n1, 2 # second\n]', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('[\n  # first\n  1,\n  2 # second\n]');
  });

  test('places dangling array comments before the closing bracket', () => {
    expect(
      CBOR.format('[1, 2\n# dangling\n]', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('[\n  1,\n  2\n  # dangling\n]');

    expect(
      CBOR.format('[# only\n]', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('[\n  # only\n]');
  });

  test('keeps nested array dangling comments inside the array', () => {
    expect(
      CBOR.format('{ "c": [1, 2\n# dangling\n], }', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('{\n  "c": [\n    1,\n    2\n    # dangling\n  ]\n}');

    expect(
      CBOR.format('{"c": [1, 2# dangling1\n# dangling2\n], "d": 3}', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe(
      '{\n  "c": [\n    1,\n    2 # dangling1\n    # dangling2\n  ],\n  "d": 3\n}'
    );
  });

  test('preserves map comments when requested', () => {
    expect(
      CBOR.format('{"a": # value\n1, # done\n"b": 2}', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('{\n  "a": 1, # value # done\n  "b": 2\n}');
  });

  test('preserves trailing comment after final map entry comma', () => {
    expect(
      CBOR.format('{ "key": "value",  # trailing comment\n}', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('{\n  "key": "value" # trailing comment\n}');
  });

  test('preserves trailing comments on map keys', () => {
    expect(
      CBOR.format('{"a" # key comment\n: 1}', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('{\n  "a": 1 # key comment\n}');

    expect(
      CBOR.format('{"a" / key comment / : 1}', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('{\n  "a": 1 / key comment /\n}');
  });

  test('moves comments between map key and value to the entry end', () => {
    expect(
      CBOR.format('{ "key": // comment\n"value" }', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('{\n  "key": "value" // comment\n}');

    expect(
      CBOR.format('{\n"a" # comment1 \n : 1, // comment2\n}', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('{\n  "a": 1 # comment1 // comment2\n}');
  });

  test('places dangling map comments before the closing brace', () => {
    expect(
      CBOR.format('{"a": 1\n# dangling\n}', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('{\n  "a": 1\n  # dangling\n}');

    expect(
      CBOR.format('{# only\n}', {
        indent: 2,
        preserveComments: true,
      })
    ).toBe('{\n  # only\n}');
  });

  test('round-trips: format of already-formatted text is idempotent', () => {
    const input = '[1,2,3]';
    expect(CBOR.format(CBOR.format(input))).toBe(CBOR.format(input));
  });
});

// ─── Lossless round-trip: encode → decode ────────────────────────────────────

describe('CBOR.encode → decode round-trip', () => {
  function rt(value: unknown): void {
    const decoded = CBOR.decode(CBOR.encode(value));
    expect(decoded).toEqual(value);
  }

  test('null', () => rt(null));
  test('true / false', () => {
    rt(true);
    rt(false);
  });
  test('integer 0', () => rt(0));
  test('integer 255', () => rt(255));
  test('negative -1', () => rt(-1));
  test('float 1.5', () => rt(1.5));
  test('string "hello"', () => rt('hello'));
  test('empty string', () => rt(''));
  test('array [1, 2, 3]', () => rt([1, 2, 3]));
  test('nested array', () => rt([1, [2, 3], [4, [5]]]));
  test('object { a: 1 }', () => rt({ a: 1 }));
  test('nested object', () => rt({ x: [1, 2], y: { z: 'hi' } }));
  test('Uint8Array', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(CBOR.decode(CBOR.encode(bytes))).toEqual(bytes);
  });
});

// ─── Byte-exact lossless round-trip: fromCBOR → toCBOR ───────────────────────

describe('CBOR.fromCBOR → toCBOR byte-exact round-trip (RFC 8949 Appendix A)', () => {
  const vectors = [
    '00',
    '01',
    '0a',
    '17',
    '1818',
    '1864',
    '1903e8',
    '20',
    '29',
    '3863',
    '3903e7',
    'f90000',
    'f98000',
    'f93c00',
    'f93e00',
    'fa47c35000',
    'fb3ff199999999999a',
    'f97c00',
    'f97e00',
    'f9fc00',
    '40',
    '4401020304',
    '60',
    '6161',
    '6449455446',
    '80',
    '83010203',
    '8301820203820405',
    'a0',
    'a201020304',
    'c074323031332d30332d32315432303a30343a30305a',
    'f4',
    'f5',
    'f6',
    'f7',
    'f0',
    'f8ff',
    '5f42010243030405ff',
    '7f657374726561646d696e67ff',
    '9fff',
    '9f01820203820405ff',
    'bf61610161629f0203ffff',
    // NaN payloads (preserved via CborFloat.rawBits)
    'f97ef0',
    'f9fe00',
    'fa7fc00001',
    'fa7f800001',
    'fb7ff8000000000001',
    'fb7ff0000000000001',
  ];

  for (const h of vectors) {
    test(`round-trip 0x${h.slice(0, 16)}${h.length > 16 ? '…' : ''}`, () => {
      const original = hex(h);
      expect(toHex(CBOR.fromCBOR(original).toCBOR())).toBe(h);
    });
  }

  test('NaN payload appears in toHexDump output', () => {
    expect(CBOR.fromCBOR(hex('f97ef0')).toHexDump()).toContain('F9 7E F0');
  });

  test('canonical NaN still encodes canonically from CDN', () => {
    expect(toHex(CBOR.fromCDN('NaN').toCBOR())).toBe('f97e00');
  });

  test('rawBits is ignored when value is not NaN', () => {
    const f = new CborFloat(1.5, {
      precision: 'half',
      rawBits: new Uint8Array([0x7e, 0x01]),
    });
    expect(toHex(f.toCBOR())).toBe('f93e00');
  });

  test('rawBits with mismatched length falls back to canonical encoding', () => {
    // half-precision rawBits left over after precision is changed to double
    const f = CBOR.fromCBOR(hex('f97ef0')) as CborFloat;
    f.precision = 'double';
    expect(toHex(f.toCBOR())).toBe('fb7ff8000000000000');
  });
});

// ─── Complete 4-way round-trip: fromCDN → toCBOR → fromCBOR → toCDN ──────────

describe('4-way round-trip: fromCDN → toCBOR → fromCBOR → toCDN', () => {
  const cases: [string, string][] = [
    ['42', '42'],
    ['-5', '-5'],
    ['1.5', '1.5'],
    ['NaN', 'NaN'],
    ['true', 'true'],
    ['false', 'false'],
    ['null', 'null'],
    ['"hello"', '"hello"'],
    ["h'0102'", "h'0102'"],
    ['[1, 2, 3]', '[1,2,3]'],
    ['{}', '{}'],
    ['{"a": 1}', '{"a":1}'],
    ['0("2013-03-21T20:04:00Z")', '0("2013-03-21T20:04:00Z")'],
  ];

  for (const [edn, expectedEDN] of cases) {
    test(edn, () => {
      const ast = CBOR.fromCDN(edn);
      const cbor = ast.toCBOR();
      const reparsed = CBOR.fromCBOR(cbor);
      expect(reparsed.toCDN()).toBe(expectedEDN);
    });
  }
});
