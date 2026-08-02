import { describe, test, expect, vi } from 'vitest';
import { CBOR } from './cbor';
import { b32, h32 } from './extensions/b32';
import { same } from './extensions/same';
import { t1 } from './extensions/concat';
import { CborUint } from './ast/CborUint';
import { CborNint } from './ast/CborNint';
import { CborTextString } from './ast/CborTextString';
import { CborByteString } from './ast/CborByteString';
import { CborArray } from './ast/CborArray';
import { CborMap } from './ast/CborMap';
import { CborFloat } from './ast/CborFloat';
import { CborSimple } from './ast/CborSimple';
import type { CborExtension } from './types';

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

  test('preserves blank lines between array/map entries when requested', () => {
    const src = '[\n  1,\n  2,\n\n  3,\n  4\n]';
    expect(CBOR.format(src, { indent: 2 })).toBe('[\n  1,\n  2,\n  3,\n  4\n]');
    expect(CBOR.format(src, { indent: 2, preserveBlankLines: true })).toBe(src);

    const mapSrc = '{\n  "a": 1,\n\n  "b": 2\n}';
    expect(CBOR.format(mapSrc, { indent: 2, preserveBlankLines: true })).toBe(
      mapSrc
    );
  });

  test('preserveBlankLines collapses multiple blank lines to one, including before the first entry', () => {
    expect(
      CBOR.format('[\n\n1,\n\n\n2\n]', { indent: 2, preserveBlankLines: true })
    ).toBe('[\n\n  1,\n\n  2\n]');
    expect(
      CBOR.format('[1,\n2]', { indent: 2, preserveBlankLines: true })
    ).toBe('[\n  1,\n  2\n]');
  });

  test('preserveBlankLines has no effect on single-line output or without the option', () => {
    const src = '[\n1,\n\n2\n]';
    expect(CBOR.format(src, { preserveBlankLines: true })).toBe('[1,2]');
    expect(CBOR.format(src, { indent: 2 })).toBe('[\n  1,\n  2\n]');
  });

  test('preserveAll includes preserveBlankLines', () => {
    const src = '[\n  1,\n\n  2\n]';
    expect(CBOR.format(src, { indent: 2, preserveAll: true })).toBe(src);
    expect(
      CBOR.format(src, {
        indent: 2,
        preserveAll: true,
        preserveBlankLines: false,
      })
    ).toBe('[\n  1,\n  2\n]');
  });

  test('preserves non-concatenated byte string literals when requested', () => {
    expect(CBOR.format("h'6869'", { preserveByteString: true })).toBe(
      "h'6869'"
    );
    // preserveByteString alone strips a comment inside the literal (the
    // remaining interior line break survives, since it's a real line break,
    // not part of the comment) — combine with preserveComments to keep it.
    expect(
      CBOR.format("h'01 # first\n 02'", {
        indent: 2,
        preserveByteString: true,
      })
    ).toBe("h'01 \n 02'");
    expect(
      CBOR.format("h'01 # first\n 02'", {
        indent: 2,
        preserveByteString: true,
        preserveComments: true,
      })
    ).toBe("h'01 # first\n 02'");
    expect(
      CBOR.format("b64' aGk # greeting\n '", {
        indent: 2,
        preserveByteString: true,
      })
    ).toBe("b64' aGk \n '");
    expect(
      CBOR.format("b32' NBUQ # b32\n '", {
        indent: 2,
        preserveByteString: true,
        extensions: [b32],
      })
    ).toBe("b32' NBUQ \n '");
    expect(
      CBOR.format("h32' D1KG # h32\n '", {
        indent: 2,
        preserveByteString: true,
        extensions: [h32],
      })
    ).toBe("h32' D1KG \n '");
    expect(CBOR.format("'hi'", { preserveByteString: true })).toBe("'hi'");
  });

  test('multi-line byte string spellings fall back in single-line mode', () => {
    expect(
      CBOR.format("h'01 # first\n 02'", { preserveByteString: true })
    ).toBe("h'0102'");
    // A single-line spelling still has its interior comment stripped, same
    // as the multi-line case — preserveByteString alone never keeps
    // comments, regardless of indent/single-line-ness.
    expect(CBOR.format("h'01 / mid / 02'", { preserveByteString: true })).toBe(
      "h'01  02'"
    );
    expect(
      CBOR.format("h'01 / mid / 02'", {
        preserveByteString: true,
        preserveComments: true,
      })
    ).toBe("h'01 / mid / 02'");
  });

  test('preserves raw byte string literals when requested', () => {
    expect(
      CBOR.format('h`01 # first\n 02`', {
        indent: 2,
        preserveByteString: true,
      })
    ).toBe('h`01 \n 02`');
    expect(
      CBOR.format('h`01 # first\n 02`', {
        indent: 2,
        preserveByteString: true,
        preserveComments: true,
      })
    ).toBe('h`01 # first\n 02`');
  });

  test("comment stripping respects each literal family's own comment syntax", () => {
    // Standard base64 (b64'...') only recognizes `#` as a comment — `/` is
    // valid base64 data (e.g. "//8=" decodes to 0xFFFF), never a comment
    // marker. Stripping must not corrupt it by treating `/`/`//` as comments.
    expect(CBOR.format("b64'//8='", { preserveByteString: true })).toBe(
      "b64'//8='"
    );
    expect(CBOR.fromCDN("b64'//8='").toCBOR()).toEqual(
      new Uint8Array([0x42, 0xff, 0xff])
    );
    // A real `#` comment in b64 is still stripped.
    expect(
      CBOR.format("b64' aGk # greeting\n '", {
        indent: 2,
        preserveByteString: true,
      })
    ).toBe("b64' aGk \n '");

    // A bare single-quoted byte string ('...', sqstr) has no comment syntax
    // at all — its content is the literal UTF-8-encoded payload, so `#` and
    // `/` inside it are data, not comments.
    expect(CBOR.format("'a#b'", { preserveByteString: true })).toBe("'a#b'");
    expect(CBOR.format("'a/b'", { preserveByteString: true })).toBe("'a/b'");
  });

  test('comment stripping never touches an unrecognized app-string prefix', () => {
    // The parser propagates ednSource to *any* extension whose
    // parseAppString returns a plain CborByteString (see parser.ts),
    // regardless of what that extension's own content syntax is. A `#`/`/`
    // there could be the extension's own ordinary data — stripping must not
    // guess at comment syntax for a prefix it doesn't specifically know.
    const textEncoder = new TextEncoder();
    const xExtension: CborExtension = {
      appStringPrefixes: ['x'],
      parseAppString: (_prefix, content) =>
        new CborByteString(textEncoder.encode(content)),
    };
    const opts = { extensions: [xExtension], preserveByteString: true };
    expect(CBOR.format("x'a#b'", opts)).toBe("x'a#b'");
    expect(
      CBOR.fromCDN("x'a#b'", { extensions: [xExtension] }).toCBOR()
    ).toEqual(new Uint8Array([0x43, 0x61, 0x23, 0x62]));
    expect(CBOR.format("x'a/b'", opts)).toBe("x'a/b'");
  });

  test('comment stripping is not fooled by a user extension overriding a built-in prefix', () => {
    // A user extension registered under the same prefix as a built-in
    // (`b32`) overrides it (see parser.ts's extension registration) — the
    // resolved extension is this custom one, not the real b32, so its
    // content must not be treated as hex/b32 comment syntax.
    const textEncoder = new TextEncoder();
    const customB32: CborExtension = {
      appStringPrefixes: ['b32'],
      parseAppString: (_prefix, content) =>
        new CborByteString(textEncoder.encode(content)),
    };
    const opts = { extensions: [customB32], preserveByteString: true };
    expect(CBOR.format("b32'a#b'", opts)).toBe("b32'a#b'");
    expect(
      CBOR.fromCDN("b32'a#b'", { extensions: [customB32] }).toCBOR()
    ).toEqual(new Uint8Array([0x43, 0x61, 0x23, 0x62]));
  });

  test('does not preserve byte string literals across concatenation', () => {
    expect(
      CBOR.format("h'68' + h'69'", {
        preserveByteString: true,
      })
    ).toBe("'hi'");
  });

  test('preserves integer literal base and spelling when requested', () => {
    expect(CBOR.format('0xff', { preserveNumberFormat: true })).toBe('0xff');
    expect(CBOR.format('0XFF', { preserveNumberFormat: true })).toBe('0XFF');
    expect(CBOR.format('0o377', { preserveNumberFormat: true })).toBe('0o377');
    expect(CBOR.format('0b101', { preserveNumberFormat: true })).toBe('0b101');
    expect(CBOR.format('-0x1f', { preserveNumberFormat: true })).toBe('-0x1f');
    // Default output normalises to decimal.
    expect(CBOR.format('0xff')).toBe('255');
    expect(CBOR.format('0o377')).toBe('255');
  });

  test('preserves integer encoding-indicator suffix when requested', () => {
    expect(CBOR.format('5_i', { preserveNumberFormat: true })).toBe('5_i');
    expect(CBOR.format('0x2a_1', { preserveNumberFormat: true })).toBe(
      '0x2a_1'
    );
    // encodingIndicators: 'never' still strips the suffix.
    expect(
      CBOR.format('5_i', {
        preserveNumberFormat: true,
        encodingIndicators: 'never',
      })
    ).toBe('5');
  });

  test('preserves float literal spelling and indicator when requested', () => {
    expect(CBOR.format('1.50', { preserveNumberFormat: true })).toBe('1.50');
    expect(CBOR.format('1.5_1', { preserveNumberFormat: true })).toBe('1.5_1');
    expect(CBOR.format('0x1.8p+0_1', { preserveNumberFormat: true })).toBe(
      '0x1.8p+0_1'
    );
    // Default output drops the redundant indicator and trailing zero.
    expect(CBOR.format('1.5_1')).toBe('1.5');
    expect(CBOR.format('1.50')).toBe('1.5');
    // encodingIndicators: 'never' still strips the suffix.
    expect(
      CBOR.format('1.5_1', {
        preserveNumberFormat: true,
        encodingIndicators: 'never',
      })
    ).toBe('1.5');
  });

  test('preserveNumberFormat has no effect on values without CDN source', () => {
    expect(CBOR.stringify(255, { preserveNumberFormat: true })).toBe('255');
    expect(CBOR.stringify(1.5, { preserveNumberFormat: true })).toBe('1.5');
  });

  test('preserves numbers nested in containers under indent', () => {
    expect(
      CBOR.format('{"a": 0xff, "b": [1.50, 0o17]}', {
        indent: 2,
        preserveNumberFormat: true,
      })
    ).toBe('{\n  "a": 0xff,\n  "b": [\n    1.50,\n    0o17\n  ]\n}');
  });

  test('preserves a leading + sign on numbers when requested', () => {
    expect(CBOR.format('+42', { preserveNumberFormat: true })).toBe('+42');
    expect(CBOR.format('+0xff', { preserveNumberFormat: true })).toBe('+0xff');
    expect(CBOR.format('+1.50', { preserveNumberFormat: true })).toBe('+1.50');
    expect(CBOR.format('+Infinity', { preserveNumberFormat: true })).toBe(
      '+Infinity'
    );
    // Default output drops the redundant explicit sign.
    expect(CBOR.format('+42')).toBe('42');
    expect(CBOR.format('+1.50')).toBe('1.5');
    expect(CBOR.format('+Infinity')).toBe('Infinity');
  });

  test('encodingIndicators: always forces a suffix onto a plain float literal', () => {
    expect(
      CBOR.format('1.5', {
        preserveNumberFormat: true,
        encodingIndicators: 'always',
      })
    ).toBe('1.5_1');
    // A literal that already carries a suffix is left untouched.
    expect(
      CBOR.format('1.5_1', {
        preserveNumberFormat: true,
        encodingIndicators: 'always',
      })
    ).toBe('1.5_1');
  });

  test('encodingIndicators: never strips an invalid suffix parsed leniently', () => {
    let warned = false;
    expect(
      CBOR.format('1.5_7', {
        preserveNumberFormat: true,
        encodingIndicators: 'never',
        strict: false,
        onWarning: () => {
          warned = true;
        },
      })
    ).toBe('1.5');
    expect(warned).toBe(true);
  });

  test('preserves tag number base when requested', () => {
    expect(CBOR.format('0x3e7(2)', { preserveNumberFormat: true })).toBe(
      '0x3e7(2)'
    );
    // Default output normalises the tag number to decimal.
    expect(CBOR.format('0x3e7(2)')).toBe('999(2)');
  });

  test('preserves simple() argument base when requested', () => {
    expect(CBOR.format('simple(0x10)', { preserveNumberFormat: true })).toBe(
      'simple(0x10)'
    );
    // Default output normalises the argument to decimal.
    expect(CBOR.format('simple(0x10)')).toBe('simple(16)');
  });

  test('preserves simple(20..23) notation instead of collapsing to keywords', () => {
    // simple(0x14) and simple(+20) both denote the same value as `false`
    // (simple value 20), but preserveNumberFormat must keep the simple(...)
    // spelling the user actually wrote rather than the false/true/null/
    // undefined keyword shortcuts, which only apply to values that were
    // never written via simple(...) in the first place.
    expect(CBOR.format('simple(0x14)', { preserveNumberFormat: true })).toBe(
      'simple(0x14)'
    );
    expect(CBOR.format('simple(+20)', { preserveNumberFormat: true })).toBe(
      'simple(+20)'
    );
    // Default output still collapses to the keyword.
    expect(CBOR.format('simple(0x14)')).toBe('false');
    // A literal `false` keyword (no simple(...) source) is unaffected.
    expect(CBOR.format('false', { preserveNumberFormat: true })).toBe('false');
  });

  test('bignum literals are unaffected by preserveNumberFormat', () => {
    expect(
      CBOR.format('0x10000000000000000', { preserveNumberFormat: true })
    ).toBe('18446744073709551616');
  });

  test('preserves raw text string literals when requested', () => {
    expect(CBOR.format('`hi there`', { preserveRawString: true })).toBe(
      '`hi there`'
    );
    expect(CBOR.format('``a`b``', { preserveRawString: true })).toBe('``a`b``');
    expect(CBOR.format('`hi`_3', { preserveRawString: true })).toBe('`hi`_3');
    // Default output stays double-quoted.
    expect(CBOR.format('`hi there`')).toBe('"hi there"');
    expect(CBOR.format('``a`b``')).toBe('"a`b"');
  });

  test('emits preserved raw strings verbatim under indent', () => {
    expect(
      CBOR.format('{"k": `line1\nline2`}', {
        indent: 2,
        preserveRawString: true,
      })
    ).toBe('{\n  "k": `line1\nline2`\n}');
  });

  test('preserves double-quoted string escape spelling when requested', () => {
    expect(CBOR.format('"caf\\u00e9"', { preserveTextString: true })).toBe(
      '"caf\\u00e9"'
    );
    expect(
      CBOR.format('"caf\\u00e9"', { preserveTextString: true, indent: 2 })
    ).toBe('"caf\\u00e9"');
    // Default output decodes the escape into the literal character.
    expect(CBOR.format('"caf\\u00e9"')).toBe('"café"');
  });

  test('preserveTextString does not affect raw backtick literals', () => {
    // preserveRawString (not preserveTextString) governs backtick spelling;
    // without it, a backtick literal still normalises to double-quoted form.
    expect(CBOR.format('`\\d+`', { preserveTextString: true })).toBe(
      '"\\\\d+"'
    );
  });

  test('preserveTextString has no effect on concatenated string parts', () => {
    // Documented limitation: only non-concatenated double-quoted literals
    // are covered; a `+` chain still normalises each part's escapes.
    expect(
      CBOR.format('"caf\\u00e9" + "x"', {
        preserveTextString: true,
        preserveConcatenation: true,
        indent: 2,
      })
    ).toBe('"café" +\n  "x"');
  });

  test('preserveRawString takes precedence over split options', () => {
    expect(
      CBOR.format('`[1, 2]`', {
        indent: 2,
        splitCdn: true,
        preserveRawString: true,
      })
    ).toBe('`[1, 2]`');
    expect(
      CBOR.format('`a\nb`', {
        indent: 2,
        splitNewline: true,
        preserveRawString: true,
      })
    ).toBe('`a\nb`');
  });

  test('preserves raw string part spelling with preserveRawString', () => {
    expect(
      CBOR.format('`a` + "b"', {
        indent: 2,
        preserveConcatenation: true,
        preserveRawString: true,
      })
    ).toBe('`a` +\n  "b"');
    // Without preserveConcatenation the chain is joined and normalised.
    expect(CBOR.format('`a` + "b"', { preserveRawString: true })).toBe('"ab"');
    // Without preserveRawString raw parts are normalised.
    expect(
      CBOR.format('`a` + "b"', { indent: 2, preserveConcatenation: true })
    ).toBe('"a" +\n  "b"');
    // Single-line output always joins, regardless of either option.
    expect(
      CBOR.format('`a` + "b"', {
        preserveConcatenation: true,
        preserveRawString: true,
      })
    ).toBe('"ab"');
  });

  test('splitNewline does not split preserved raw string parts', () => {
    expect(
      CBOR.format('`a\nb` + "c\nd"', {
        indent: 2,
        preserveConcatenation: true,
        preserveRawString: true,
        splitNewline: true,
      })
    ).toBe('`a\nb` +\n  "c\\n" +\n  "d"');
  });

  test('preserved raw string parts take precedence over splitCdn', () => {
    expect(
      CBOR.format('`[1,2]` + ""', {
        indent: 2,
        preserveConcatenation: true,
        preserveRawString: true,
        splitCdn: true,
      })
    ).toBe('`[1,2]` +\n  ""');
  });

  test('preserves raw string parts around ellipsis, always single-line', () => {
    // Every `+`-joined fragment stays on its original boundary — including
    // "b" and "c", which aren't raw strings and so have no source spelling
    // of their own, but still sit on the correct side of the ellipsis and
    // don't get merged into their raw-string neighbor. Unlike a real (non-
    // elision) `+` concatenation, this is indent-independent: `indent` only
    // changes whether the *value* is pretty-printed at all, not whether
    // these boundaries are shown.
    const expected = '`a` + "b" + ... + "c" + ``d`e``';
    expect(
      CBOR.format('`a` + "b" + ... + "c" + ``d`e``', {
        indent: 2,
        preserveConcatenation: true,
        preserveRawString: true,
      })
    ).toBe(expected);
    expect(
      CBOR.format('`a` + "b" + ... + "c" + ``d`e``', {
        preserveConcatenation: true,
        preserveRawString: true,
      })
    ).toBe(expected);
  });

  test('without preserveConcatenation, adjacent fragments around an ellipsis still merge', () => {
    expect(CBOR.format('`a` + "b" + ... + "c" + ``d`e``')).toBe(
      '"ab" + ... + "cd`e"'
    );
  });

  test('joins text string concatenation by default', () => {
    expect(CBOR.format('"a" + "b"')).toBe('"ab"');
  });

  test('preserves text string concatenation when requested', () => {
    expect(
      CBOR.format('"a" + "b"', { indent: 2, preserveConcatenation: true })
    ).toBe('"a" +\n  "b"');
    expect(
      CBOR.format("'a' + 'b'", { indent: 2, preserveConcatenation: true })
    ).toBe("'a' +\n  'b'");
  });

  test('single-line output joins preserved concatenation', () => {
    expect(CBOR.format('"a" + "b"', { preserveConcatenation: true })).toBe(
      '"ab"'
    );
    expect(CBOR.format("'a' + 'b'", { preserveConcatenation: true })).toBe(
      "'ab'"
    );
  });

  test('modernConcat: true renders preserved concatenation as t1<<>>/b1<<>>', () => {
    expect(
      CBOR.format('"a" + "b"', {
        indent: 2,
        preserveConcatenation: true,
        modernConcat: true,
      })
    ).toBe('t1<<"a", "b">>');
    expect(
      CBOR.format("h'01' + h'02'", {
        indent: 2,
        preserveConcatenation: true,
        modernConcat: true,
      })
    ).toBe("b1<<h'01', h'02'>>");
  });

  test('modernConcat: true falls back to + when appStrings is false', () => {
    expect(
      CBOR.format('"a" + "b"', {
        indent: 2,
        preserveConcatenation: true,
        modernConcat: true,
        appStrings: false,
      })
    ).toBe('"a" +\n  "b"');
  });

  test('modernConcat: true has no effect without preserveConcatenation', () => {
    expect(
      CBOR.format('"a" + "b"', { indent: 2, modernConcat: true })
    ).toBe('"ab"');
  });

  test('modernConcat: true round-trips through the parser', () => {
    const rendered = CBOR.format('"a" + "b"', {
      indent: 2,
      preserveConcatenation: true,
      modernConcat: true,
    });
    expect(CBOR.fromCDN(rendered).toJS()).toBe('ab');
  });

  test('preserves a comment between concatenated text string parts', () => {
    expect(
      CBOR.format('"a" + /* c */ "b"', {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      })
    ).toBe('"a" +\n  /* c */\n  "b"');
  });

  test('preserves a # comment between text parts without swallowing the next literal', () => {
    expect(
      CBOR.format('"a" + # note\n  "b"', {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      })
    ).toBe('"a" +\n  # note\n  "b"');
  });

  test('preserves comments in each gap of a 3-part text string chain', () => {
    expect(
      CBOR.format('"a" + /* one */ "b" + /* two */ "c"', {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      })
    ).toBe('"a" +\n  /* one */\n  "b" +\n  /* two */\n  "c"');
  });

  test('single-line mode still strips a mid-chain text string comment', () => {
    expect(
      CBOR.format('"a" + /* c */ "b"', {
        preserveConcatenation: true,
        preserveComments: true,
      })
    ).toBe('"ab"');
  });

  test('without preserveComments a mid-chain text comment is dropped, not crashing', () => {
    expect(
      CBOR.format('"a" + /* c */ "b"', {
        indent: 2,
        preserveConcatenation: true,
      })
    ).toBe('"a" +\n  "b"');
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
    expect(
      CBOR.format("h'01' + h'02'", { indent: 2, preserveConcatenation: true })
    ).toBe("h'01' +\n  h'02'");
    // Each part is re-serialized with the normal rules (sqstr, bstrEncoding).
    expect(
      CBOR.format("h'68' + h'69'", { indent: 2, preserveConcatenation: true })
    ).toBe("'h' +\n  'i'");
    expect(
      CBOR.format("h'68' + b64'aQ'", {
        indent: 2,
        preserveConcatenation: true,
        sqstr: 'none',
      })
    ).toBe("h'68' +\n  h'69'");
  });

  test('preserves byte string part spelling with preserveByteString', () => {
    expect(
      CBOR.format("h'68' + b64'aQ'", {
        indent: 2,
        preserveConcatenation: true,
        preserveByteString: true,
      })
    ).toBe("h'68' +\n  b64'aQ'");
  });

  test('preserves a comment between concatenated byte string parts', () => {
    expect(
      CBOR.format("h'aa' + /* test */ h'aa'", {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      })
    ).toBe("h'aa' +\n  /* test */\n  h'aa'");
  });

  test('preserves a # comment between parts without swallowing the next literal', () => {
    expect(
      CBOR.format("h'aa' + # note\n  h'bb'", {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      })
    ).toBe("h'aa' +\n  # note\n  h'bb'");
  });

  test('preserves comments in each gap of a 3-part byte string chain', () => {
    expect(
      CBOR.format("h'aa' + /* one */ h'bb' + /* two */ h'cc'", {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      })
    ).toBe("h'aa' +\n  /* one */\n  h'bb' +\n  /* two */\n  h'cc'");
  });

  test('single-line mode still strips a mid-chain byte string comment', () => {
    expect(
      CBOR.format("h'aa' + /* test */ h'aa'", {
        preserveConcatenation: true,
        preserveComments: true,
      })
    ).toBe("h'aaaa'");
  });

  test('normalizes byte string parts in preserved text concatenation', () => {
    expect(
      CBOR.format('"a" + h\'62\'', { indent: 2, preserveConcatenation: true })
    ).toBe('"a" +\n  "b"');
  });

  test('keeps encoding indicator at the end of a preserved chain', () => {
    expect(
      CBOR.format('"a" + "b"_3', { indent: 2, preserveConcatenation: true })
    ).toBe('"a" +\n  "b"_3');
  });

  test('single-line output joins preserved byte string concatenation', () => {
    expect(CBOR.format("h'01' + h'02'", { preserveConcatenation: true })).toBe(
      "h'0102'"
    );
    expect(
      CBOR.format("h'68' + b64'aQ'", {
        preserveConcatenation: true,
        preserveByteString: true,
      })
    ).toBe("'hi'");
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

  test('splitCdn respects inlineLeafContainers for the embedded CDN structure', () => {
    // Same rule as the real AST: a leaf array/map stays on one line, but a
    // container whose entries are themselves arrays/maps still breaks.
    expect(
      CBOR.format('"[1, 2, 3]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[1, 2, 3]"');
    expect(CBOR.format('"[1, 2, 3]"', { indent: 2, splitCdn: true })).toBe(
      '"[" +\n    "1, " +\n    "2, " +\n    "3" +\n  "]"'
    );
    expect(
      CBOR.format('"[[1, 2], [3, 4]]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "[1, 2], " +\n    "[3, 4]" +\n  "]"');
    expect(
      CBOR.format('"<<1, 2>>"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"<<1, 2>>"');
  });

  test('splitCdn + inlineLeafContainers: a multi-word string entry still forces a break', () => {
    // Same rule as the real AST's entryIsMultiWordText: a single-word
    // string entry stays inline, but two or more words disqualifies the
    // enclosing frame from collapsing, even though it has no nested
    // array/map of its own.
    expect(
      CBOR.format('"[\\"hello\\", \\"world\\"]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[\\"hello\\", \\"world\\"]"');
    expect(
      CBOR.format('"[\\"Hello, World!\\", \\"This is the CBOR library.\\"]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe(
      '"[" +\n    "\\"Hello, World!\\", " +\n    "\\"This is the CBOR library.\\"" +\n  "]"'
    );
    // A multi-word object key/value disqualifies the object too.
    expect(
      CBOR.format('"{\\"two words\\": 1}"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"{" +\n    "\\"two words\\": 1" +\n  "}"');
    // A tag wrapping a multi-word string still disqualifies its parent —
    // the tag's own parens stay tight, but the array around it breaks.
    expect(
      CBOR.format('"[100(\\"two words\\")]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "100(\\"two words\\")" +\n  "]"');
  });

  test('splitCdn + inlineLeafContainers: a `+`-concatenation chain inside the embedded CDN is checked by its combined content', () => {
    // Mirrors the real-AST test above (`ilts<<"one " + "word">>`): the
    // token-scan mirror used for splitCdn checked each TSTR in a
    // concatenation chain individually too, missing a case like this where
    // "one " and "word" are each one word alone but two words combined.
    expect(
      CBOR.format('"[\\"one \\" + \\"word\\"]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "\\"one \\" + \\"word\\"" +\n  "]"');
    // Combines into one word, stays inline.
    expect(
      CBOR.format('"[\\"a\\" + \\"b\\"]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[\\"a\\" + \\"b\\"]"');
  });

  test('inlineLeafContainers: any app-string extension literal counts as a prefixed literal', () => {
    // Not just h'...'/b64'...' — any app-string extension's own rendering
    // (ip'...', dt'...', ...) has no natural word boundary either, so it
    // disqualifies a strict array/map from collapsing just the same,
    // without ip.ts/dt.ts needing any inlineLeafContainers-specific code of
    // their own (see isPrefixedLiteralText).
    expect(
      CBOR.format("[ip'192.0.2.42']", { indent: 2, inlineLeafContainers: true })
    ).toBe("[\n  ip'192.0.2.42'\n]");
    expect(
      CBOR.format("[dt'1969-07-21T02:56:16Z']", {
        indent: 2,
        inlineLeafContainers: true,
      })
    ).toBe("[\n  dt'1969-07-21T02:56:16Z'\n]");
    // The loose rule (<<...>>) still treats it as an ordinary leaf, same as
    // a prefixed byte-string literal.
    expect(
      CBOR.format("<<dt'1969-07-21T02:56:16Z'>>", {
        indent: 2,
        inlineLeafContainers: true,
      })
    ).toBe("<<dt'1969-07-21T02:56:16Z'>>");
    // A map value (not just an array entry, and not just the first/key
    // position) is checked too.
    expect(
      CBOR.format('{"a": ip\'192.0.2.42\'}', {
        indent: 2,
        inlineLeafContainers: true,
      })
    ).toBe('{\n  "a": ip\'192.0.2.42\'\n}');
    // The same rule applies inside a splitCdn-reflowed embedded CDN string.
    expect(
      CBOR.format('"[ip\'192.0.2.42\']"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "ip\'192.0.2.42\'" +\n  "]"');
    expect(
      CBOR.format('"<<dt\'1969-07-21T02:56:16Z\'>>"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"<<dt\'1969-07-21T02:56:16Z\'>>"');
  });

  test('inlineLeafContainers: a prefixed literal disqualifies even wrapped in an unrelated tag', () => {
    // CborTag's own rendering ("100(dt'...')") no longer starts with a
    // letter, so isPrefixedLiteralText alone can't see the prefix through
    // the tag's digits/parens — CborTag._isMultiWordText instead tokenizes
    // its own _toCDN() output (isMultiWordRenderedLiteral), peeling the
    // generic tagNum(...) wrapping to see what's inside.
    expect(
      CBOR.format("[100(dt'1969-07-21T02:56:16Z')]", {
        indent: 2,
        inlineLeafContainers: true,
      })
    ).toBe("[\n  100(dt'1969-07-21T02:56:16Z')\n]");
    // A byte string whose *preserved* source spelling is a prefixed literal
    // even though its raw bytes would decode as printable, single-word
    // sqstr text (0x68 = "h") — tokenizing the actual rendered output finds
    // the real h'68' spelling directly, unaffected by what the bytes alone
    // would have predicted.
    const node = CBOR.fromCDN("[100(h'68')]");
    expect(
      node.toCDN({
        indent: 2,
        inlineLeafContainers: true,
        preserveByteString: true,
      })
    ).toBe("[\n  100(h'68')\n]");
    // The loose rule (<<...>>) still exempts it, tag or not.
    expect(
      CBOR.format("<<100(dt'1969-07-21T02:56:16Z')>>", {
        indent: 2,
        inlineLeafContainers: true,
      })
    ).toBe("<<100(dt'1969-07-21T02:56:16Z')>>");
  });

  test('inlineLeafContainers: a preserved app-sequence spelling is judged by its actual rendering, not the resolved value', () => {
    // ip's own extension declares preserveAppSeqSource: 'optional', so
    // `ip<<'192.0.2.42'>>` never wraps in CborAppSeqResult at all — it sets
    // appSeqSource directly on the resolved CborIpExt (a CborByteString
    // subclass) and CborIpExt._toCDN() renders the preserved spelling
    // verbatim when preserveAppSequence is set. CborByteString's
    // _isMultiWordText only checks whether the raw bytes would render as
    // multi-word bare sqstr *text* — it makes no prediction at all about
    // prefixed-literal shapes, so it can't be "wrong" about the (irrelevant)
    // raw address bytes here; the actual output "ip<<'192.0.2.42'>>" simply
    // isn't a shape any check disqualifies on (`<<` follows the prefix, not
    // a quote).
    expect(
      CBOR.format("[ip<<'192.0.2.42'>>]", {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe("[ip<<'192.0.2.42'>>]");
    // IP (uppercase, tagged) is a CborTag subclass (CborTaggedIpExt) that
    // overrides _toCDN() to render "IP<<'...'>>" instead of generic
    // tagNum(content) notation — CborTag._isMultiWordText tokenizes this
    // node's *own* output rather than looking at its tag content (which
    // would be the address bytes, irrelevantly shaped like h'...'), so it
    // correctly sees the app-sequence shape and doesn't disqualify.
    expect(
      CBOR.format("[IP<<'192.0.2.42'>>]", {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe("[IP<<'192.0.2.42'>>]");
    expect(
      CBOR.format("[DT<<b64'MTk2OS0wNy0yMVQwMjo1NjoxNlo='>>]", {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe("[DT<<b64'MTk2OS0wNy0yMVQwMjo1NjoxNlo='>>]");
    // ilts/ilbs's preserveAppSeqSource is `true`, so `ilts<<...>>`/
    // `ilbs<<...>>` *do* wrap in CborAppSeqResult — but it tokenizes its
    // own rendered output directly (isMultiWordRenderedLiteral), same as
    // CborTag, rather than delegating to `this.inner._isMultiWordText()`.
    // Peeling the app-sequence wrapper and checking each item under the
    // loose rule (matching `<<...>>` itself) gets both directions right:
    // a multi-word text item still always counts...
    expect(
      CBOR.format('[ilts<<"two words">>]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe('[\n  ilts<<"two words">>\n]');
    // A single-word chunk stays inline, same as any other leaf.
    expect(
      CBOR.format('[ilts<<"word">>]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe('[ilts<<"word">>]');
    // ...while a prefixed-literal (hex) item never counts under the loose
    // rule, even one whose bytes happen to *decode* to printable multi-word
    // text ("hello world") — delegating to `this.inner` (a
    // CborIndefiniteByteString wrapping a CborByteString chunk) would get
    // this backwards: the chunk's raw bytes decode to "hello world", so a
    // semantic check on `this.inner` reports it as multi-word, but the
    // actual rendering is the hex literal inside the preserved
    // `ilbs<<...>>` spelling, never decoded text — h'00' alone doesn't
    // expose this divergence, since 0x00 isn't valid UTF-8 either way.
    expect(
      CBOR.format("[ilbs<<h'00'>>]", {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe("[ilbs<<h'00'>>]");
    expect(
      CBOR.format("[ilbs<<h'68656c6c6f20776f726c64'>>]", {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe("[ilbs<<h'68656c6c6f20776f726c64'>>]");
  });

  test('inlineLeafContainers: a trailing encoding indicator on the inner literal is ignored, not mistaken for extra content', () => {
    // encodingIndicators: 'always' adds an explicit _N/_i suffix to every
    // value, including the tag's own content — so the tokenized range
    // isMultiWordRenderedLiteral recurses into after peeling a tag's parens
    // is "TSTR ENCODING_INDICATOR" (two tokens), not a bare TSTR. Without
    // stripping a trailing ENCODING_INDICATOR before checking "is this a
    // single literal", that would wrongly look like more-than-one-token
    // content and never match any recognized shape.
    expect(
      CBOR.format('[100("two words")]', {
        indent: 2,
        inlineLeafContainers: true,
        encodingIndicators: 'always',
      })
    ).toBe('[_i \n  100_0("two words"_i)\n]');
    expect(
      CBOR.format("[100(h'00')]", {
        indent: 2,
        inlineLeafContainers: true,
        encodingIndicators: 'always',
      })
    ).toBe("[_i \n  100_0(h'00'_i)\n]");
  });

  test('inlineLeafContainers: app-sequence items may be separated by whitespace alone, not just a comma', () => {
    // CDN allows app-sequence items to be separated by a comma, by
    // whitespace alone, or both — splitTopLevelItems must find each item's
    // own extent structurally (consumeOneItem), not just split at commas,
    // or two whitespace-separated items collapse into one unrecognized,
    // multi-token range that never gets checked at all.
    expect(
      CBOR.format('[ilts<<"two words" "x">>]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe('[\n  ilts<<"two words" "x">>\n]');
    // Two single-word, whitespace-separated items stay inline.
    expect(
      CBOR.format('[ilts<<"a" "b">>]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe('[ilts<<"a" "b">>]');
  });

  test('inlineLeafContainers: a trailing encoding indicator on an app-sequence wrapper itself is stripped before wrapper detection', () => {
    // `same<<"two words">>_i` is valid CDN — same<<...>> resolves to (and
    // round-trips as) its inner item, here a plain TSTR, so it can carry
    // its own encoding indicator after the closing `>>`. Stripping a
    // trailing ENCODING_INDICATOR must happen *before* checking whether
    // the range is an app-sequence (or tag) wrapper, not only before the
    // single-literal check — otherwise the wrapper's own closing `>>`
    // is no longer the last token in range, "spans the whole range" fails,
    // and the wrapper is never peeled at all.
    expect(
      CBOR.format('[same<<"two words">>_i]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
        extensions: [same],
      })
    ).toBe('[\n  same<<"two words">>_i\n]');
    expect(
      CBOR.format('[same<<"word">>_i]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
        extensions: [same],
      })
    ).toBe('[same<<"word">>_i]');
  });

  test('inlineLeafContainers: a `+`-concatenation chain is one item, checked by its combined decoded content', () => {
    // `"one " + "word"` decodes to a single 2-word text string, but
    // consumeOneItem only used to consume the first TSTR, splitting the
    // chain into three bogus top-level items (TSTR, PLUS, TSTR) — each
    // checked (and found single-word, or not a literal at all) in
    // isolation, so the disqualification was missed entirely. The chain
    // must be consumed and decoded as one value.
    expect(
      CBOR.format('[ilts<<"one " + "word">>]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe('[\n  ilts<<"one " + "word">>\n]');
    // Two parts that are each one word, but combine into one word, stay
    // inline — the check is on the *merged* content, not per-part.
    expect(
      CBOR.format('[ilts<<"a" + "b">>]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe('[ilts<<"a" + "b">>]');
    // A chain as one of several app-sequence items: the chain is still
    // recognized as a single item (not split across the following comma),
    // and its own multi-word combined content still disqualifies.
    expect(
      CBOR.format('[ilts<<"one " + "word", "x">>]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe('[\n  ilts<<"one " + "word", "x">>\n]');
  });

  test('inlineLeafContainers: an elision chain (`+ ...`) item is consumed but judged indeterminate, without aborting later items', () => {
    // consumeOneItem's chain-continuation check only accepted
    // STRINGISH_TYPES parts, so `"a" + ...` (an elision chain — CDN's own
    // `+`-chain grammar accepts a trailing `...` for a deliberately omitted
    // part, building a tag-888 value instead of a plain string) failed to
    // find its item's own extent at all, returning null — which made
    // splitTopLevelItems give up on the *entire* app-sequence, so the
    // second item's own multi-word content was never even reached.
    expect(
      CBOR.format('<<t1<<"a" + ..., "two words">>>>', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
        extensions: [t1],
      })
    ).toBe('<<\n  t1<<"a" + ..., "two words">>\n>>');
  });

  test('splitCdn: a byte-leading `+`-chain keeps its chain kind through a bare-sqstr continuation', () => {
    // The chain-state tracking only recorded *whether* a chain was active,
    // not *which kind* — so a byte-leading chain (`h'' + ...`) left no
    // record of itself, and a following bare SQSTR continuation (which
    // looks text-leading in isolation) wrongly started its own independent
    // text-leading chain, checking its content for word count even though
    // the whole chain — being byte-leading — should be exempt from that
    // check entirely under the loose `<<...>>` rule (same as a lone
    // `h'...'`).
    expect(
      CBOR.format("\" <<h'' + 'two words'>> \"".trim(), {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe("\" <<h'' + 'two words'>> \"");
    // The same byte-leading chain under the strict rule (a plain array,
    // not `<<...>>`) still disqualifies — unaffected by this fix, since
    // that check fires unconditionally on the chain's first token.
    expect(
      CBOR.format("\"[h'' + 'two words']\"", {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "h\'\' + \'two words\'" +\n  "]"');
    // A *text*-leading chain with a byte-literal continuation still merges
    // and checks combined word count correctly (unaffected by the
    // byte-leading fix above).
    expect(
      CBOR.format("\"<<'two ' + h'776f726473'>>\"", {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"<<" +\n    "\'two \' + h\'776f726473\'" +\n  ">>"');
  });

  test('inlineLeafContainers: an elision chain may also *start* with `...`, not just continue with it', () => {
    // consumeOneItem's chain-continuation check (round 8) accepted ELLIPSIS
    // only as the token *after* a `+` — but src/cdn/parser.ts's own
    // `+`-chain grammar also lets a value *start* with ELLIPSIS
    // (`... + "b"`, an unknown prefix concatenated with a known suffix).
    // Previously, the leading `...` was treated as its own independent
    // 1-token item, and the following `"two words"` was judged as a *new*,
    // ordinary text item — reporting the visible suffix's own word count
    // instead of "indeterminate," even though the true combined value
    // (prefix + suffix) can't be known.
    expect(
      CBOR.format('<<t1<<... + "two words">>>>', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
        extensions: [t1],
      })
    ).toBe('<<t1<<... + "two words">>>>');
  });

  test('splitCdn: an elision chain starting with `...` starts an indeterminate chain state, not a fresh text chain from what follows', () => {
    // Same bug as above, in the collectCdnBreakpoints mirror: a leading
    // ELLIPSIS didn't record any chain state at all, so the following
    // `"two words"` looked like a fresh, ordinary text-leading chain start
    // and got checked (and flagged) on its own.
    expect(
      CBOR.format('"<<... + \\"two words\\">>"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"<<... + \\"two words\\">>"');
  });

  test('splitCdn: a byte-shaped continuation of a text-leading chain is judged by the merged content, not disqualified on its own', () => {
    // Found while verifying the elision-chain fix above: the byte-literal
    // branch's "always strict, no natural word boundary" check fired
    // unconditionally for *any* BYTES_HEX/etc token, even one that's really
    // just a continuation of an already-merging text-leading chain — so
    // `"a" + h'62'` (merges to "ab", one word) was wrongly disqualified
    // under the strict rule despite serialize-utils.ts's isMultiWordTokenRange
    // correctly reporting it as not multi-word. The unconditional check now
    // only applies when this token actually fixes the chain's element type
    // (byte-leading, or standalone) — not when it's a continuation of a
    // text-leading merge, which is judged solely by the combined content.
    expect(
      CBOR.format('"[\\"a\\" + h\'62\']"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[\\"a\\" + h\'62\']"');
    // The same fix also makes a leading-ellipsis chain with a byte
    // continuation correctly indeterminate *by word count* under the
    // strict rule too, matching serialize-utils.ts — but it still
    // disqualifies here, for the unrelated "elision chain is secretly a
    // nested container" reason a later round adds (see the elision-chain
    // container test below), so this still ends up multi-line overall.
    expect(
      CBOR.format('"[... + h\'00\']"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "... + h\'00\'" +\n  "]"');
    // A pure byte-leading chain (no text-leading merge involved) still
    // disqualifies under strict — unaffected by this fix.
    expect(
      CBOR.format("\"[h'' + 'two words']\"", {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "h\'\' + \'two words\'" +\n  "]"');
  });

  test("inlineLeafContainers: an elision chain's continuation may be any value shape, not just a string/byte literal", () => {
    // consumeOneItem's ELLIPSIS-start handling (added in the previous round)
    // still used the string/byte-literal-only CHAIN_ATOM_TYPES rule for
    // each continuation after `+` — but src/cdn/parser.ts's own grammar
    // reads an elision chain's continuations with the *general* value
    // parser (parseValue()), so any value shape is valid there: a tag, a
    // container, an indefinite-length string group, an app-sequence, even
    // a nested ellipsis chain. `... + (_ "a")` (an indefinite-length text
    // string group as the continuation) previously made consumeOneItem
    // return null (LPAREN isn't in CHAIN_ATOM_TYPES), which made
    // splitTopLevelItems give up on the *entire* app-sequence item list —
    // so the second, clearly multi-word item was never reached.
    expect(
      CBOR.format('<<t1<<... + (_ "a"), "two words">>>>', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
        extensions: [t1],
      })
    ).toBe('<<\n  t1<<... + (_ "a"), "two words">>\n>>');
    // A plain string-leading chain keeps the restricted rule as-is —
    // unaffected by this fix (only an ELLIPSIS-led chain gets the general
    // value-shape continuation rule).
    expect(
      CBOR.format('[ilts<<"one " + "word">>]', {
        indent: 2,
        inlineLeafContainers: true,
        preserveAppSequence: true,
      })
    ).toBe('[\n  ilts<<"one " + "word">>\n]');
  });

  test("splitCdn: an elision chain's continuation may be any value shape (collectCdnBreakpoints already handles this via its bracket-frame stack)", () => {
    // Unlike serialize-utils.ts's flat, index-based consumeOneItem (which
    // needed an explicit recursive fix above), collectCdnBreakpoints scans
    // token-by-token with its own bracket-frame stack, so a nested value
    // like `(_ "a")` is already handled as its own independent
    // sub-structure regardless of chain state — no code change was needed
    // here, but this locks in that it stays correct.
    expect(
      CBOR.format('"t1<<... + (_ \\"a\\"), \\"two words\\">>"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe(
      '"t1<<" +\n    "... + (_ \\"a\\"), " +\n    "\\"two words\\"" +\n  ">>"'
    );
  });

  test('splitCdn: an elision chain is a synthetic nested container, disqualifying a strict array/map regardless of word count', () => {
    // `"a" + ...` resolves, in the real AST, to a CborEllipsis wrapping a
    // CborArray of fragments (src/cdn/parser.ts's concatenate()) — a
    // *container*-shaped node per CborArray._containsCdnContainer (always
    // true) and CborTag._containsCdnContainer (delegates to its content) —
    // even though its own written source has no literal `[`/`{` at all.
    // collectCdnBreakpoints only tracked the chain's *word count*
    // (correctly indeterminate), never this structural fact, so
    // `["a" + ...]` disqualified via the real AST's `_containsCdnContainer`
    // check but stayed on one line via splitCdn — the two disagreed.
    const options = { indent: 2, inlineLeafContainers: true };
    expect(CBOR.format('["a" + ...]', options)).toBe('[\n  "a" + ...\n]');
    expect(
      CBOR.format('"[\\"a\\" + ...]"', { ...options, splitCdn: true })
    ).toBe('"[" +\n    "\\"a\\" + ..." +\n  "]"');
    // A truly standalone bare `...` (no `+` at all) is *not* a synthetic
    // container — it resolves to CborEllipsis(CborSimple.NULL), no array —
    // so it can still inline.
    expect(CBOR.format('[...]', options)).toBe('[...]');
    expect(CBOR.format('"[...]"', { ...options, splitCdn: true })).toBe(
      '"[...]"'
    );
    // The loose <<...>> rule still ignores this flag entirely, same as it
    // already ignores a literal nested `[...]`/`{...}` — unaffected.
    expect(
      CBOR.format('<<t1<<... + "two words">>>>', {
        ...options,
        preserveAppSequence: true,
        extensions: [t1],
      })
    ).toBe('<<t1<<... + "two words">>>>');
  });

  test("splitCdn: an ellipsis-led chain's poisoned state survives a bracketed continuation and resumes if a further `+` follows", () => {
    // `... + (_ "a") + "two words"` is one continuous elision chain — the
    // bracketed `(_ "a")` is just one continuation value among several, per
    // consumeOneItem's recursive handling in serialize-utils.ts. But
    // collectCdnBreakpoints's chainCanContinueHere didn't treat a bracket
    // opener as a valid way to keep the chain going, so it finalized right
    // before `(_ "a")` — losing the poisoned (indeterminate) state — and
    // then `+ "two words"` afterward looked like a brand-new, unpoisoned
    // chain, whose own multi-word content wrongly forced a break. Under a
    // strict parent this was masked by the round-12 synthetic-container
    // check (which disqualifies regardless), but a loose `<<...>>` — which
    // ignores that flag — exposed the disagreement directly.
    const options = { indent: 2, inlineLeafContainers: true };
    expect(CBOR.format('<<... + (_ "a") + "two words">>', options)).toBe(
      '<<... + (_ "a") + "two words">>'
    );
    expect(
      CBOR.format('"<<... + (_ \\"a\\") + \\"two words\\">>"', {
        ...options,
        splitCdn: true,
      })
    ).toBe('"<<... + (_ \\"a\\") + \\"two words\\">>"');
    // Independent checks still fire correctly on tokens *inside* the
    // suspended bracket — a prefixed byte literal there still disqualifies
    // its own strict frame (an indefinite-length group has no literal
    // brackets of its own, so this only works if the byte-literal's
    // unconditional check still ran despite the outer suspension).
    expect(
      CBOR.format('"[... + (_ h\'00\')]"', { ...options, splitCdn: true })
    ).toBe('"[" +\n    "... + (_ " +\n      "h\'00\'" +\n    ")" +\n  "]"');
  });

  test("splitCdn: an ellipsis-led chain's continuation may be a bare atom or a tag, not just a bracketed value", () => {
    // Round 13 only suspended chain tracking for OPEN_TOKENS (bracketed)
    // continuations — but parseValue() (what src/cdn/parser.ts actually
    // uses to parse an ellipsis-led chain's continuations) also accepts a
    // bare atom (a number, e.g.) or a tag (`INTEGER [EI] LPAREN ... RPAREN`
    // — which *starts* with an INTEGER token, not a bracket opener at all).
    // Neither was suspended, so the chain finalized (losing its
    // indeterminate state) right before the atom/tag, and the following
    // `+ "two words"` looked like a fresh, unpoisoned chain whose own
    // multi-word content wrongly forced a break.
    const options = { indent: 2, inlineLeafContainers: true };
    // Bare atom (integer) continuation.
    expect(CBOR.format('<<... + 1 + "two words">>', options)).toBe(
      '<<... + 1 + "two words">>'
    );
    expect(
      CBOR.format('"<<... + 1 + \\"two words\\">>"', {
        ...options,
        splitCdn: true,
      })
    ).toBe('"<<... + 1 + \\"two words\\">>"');
    // Tag continuation — distinguished from a bare integer only by the
    // token *after* it (`LPAREN` vs. anything else).
    expect(CBOR.format('<<... + 100("a") + "two words">>', options)).toBe(
      '<<... + 100("a") + "two words">>'
    );
    expect(
      CBOR.format('"<<... + 100(\\"a\\") + \\"two words\\">>"', {
        ...options,
        splitCdn: true,
      })
    ).toBe('"<<... + 100(\\"a\\") + \\"two words\\">>"');
    // A chain ending right after a bare atom/tag, with no further `+`,
    // still correctly finalizes (rather than getting stuck "awaiting").
    expect(CBOR.format('<<... + 1>>', options)).toBe('<<... + 1>>');
    expect(CBOR.format('<<... + 100("a")>>', options)).toBe(
      '<<... + 100("a")>>'
    );
  });

  test("splitCdn: a bracketed continuation's own content still gets its own, ordinary multi-word tracking", () => {
    // Rounds 13/14 suspended chain tracking entirely while inside a
    // bracketed/tag continuation of an ellipsis-led chain — correctly
    // freezing the *outer* chain, but as a side effect also skipping the
    // multi-word tracking that continuation's *own* content needs for
    // itself: `["two words"]`'s own entry never got checked, so the array
    // never picked up its own entryForcedBreak, and neither did the outer
    // `<<...>>` (whose own break depends on the entry's rendering
    // containing one). Fixed by pushing the outer chain onto a stack and
    // resetting to a *fresh* chain for the bracket's content — restored
    // when the bracket closes — rather than freezing tracking altogether.
    const options = { indent: 2, inlineLeafContainers: true };
    expect(CBOR.format('<<... + ["two words"]>>', options)).toBe(
      '<<\n  ... + [\n    "two words"\n  ]\n>>'
    );
    expect(
      CBOR.format('"<<... + [\\"two words\\"]>>"', {
        ...options,
        splitCdn: true,
      })
    ).toBe(
      '"<<" +\n    "... + [" +\n      "\\"two words\\"" +\n    "]" +\n  ">>"'
    );
    // A single-word entry inside the same shape stays inline — confirms
    // this is real word-count tracking, not just "always break".
    expect(CBOR.format('<<... + ["a"]>>', options)).toBe('<<... + ["a"]>>');
    expect(
      CBOR.format('"<<... + [\\"a\\"]>>"', { ...options, splitCdn: true })
    ).toBe('"<<... + [\\"a\\"]>>"');
    // A plain (non-ellipsis) `+`-chain inside the continuation array is
    // also tracked correctly on its own — merges to "one word", one word,
    // but a further check with two genuinely separate words confirms the
    // merge-then-check still runs inside the pushed context too.
    expect(
      CBOR.format('"<<... + [\\"one \\" + \\"word\\"]>>"', {
        ...options,
        splitCdn: true,
      })
    ).toBe(
      '"<<" +\n    "... + [" +\n      "\\"one \\" + \\"word\\"" +\n    "]" +\n  ">>"'
    );
  });

  test("splitCdn: a tag continuation's semantic multi-word content must not leak past the ellipsis it belongs to", () => {
    // Round 15's fix let a bracketed continuation's own content be tracked
    // normally against its own frame — correct for a container (array/map/
    // indefinite-length group), which genuinely collapses/expands based on
    // its entries' word count, producing a *real* newline that should
    // propagate. But a *tag* never collapses/expands based on content word
    // count at all (CborTag always renders `tagNum(content)` on one
    // physical line, deferring entirely to the content's own rendering),
    // and CborEllipsis's own rendering never delegates to a fragment's
    // semantic multi-word-ness either — it only ever joins each fragment's
    // *actual* rendered text. So `100("two words")`'s own semantic
    // multi-word-ness (which correctly disqualifies a *real* strict
    // parent, e.g. `[100("two words")]`) must not leak past the ellipsis
    // when the tag is itself one of its continuation values.
    const options = { indent: 2, inlineLeafContainers: true };
    expect(CBOR.format('<<... + 100("two words")>>', options)).toBe(
      '<<... + 100("two words")>>'
    );
    expect(
      CBOR.format('"<<... + 100(\\"two words\\")>>"', {
        ...options,
        splitCdn: true,
      })
    ).toBe('"<<... + 100(\\"two words\\")>>"');
    // A plain (non-ellipsis) tag with multi-word content is unaffected —
    // still correctly disqualifies a real strict array...
    expect(CBOR.format('[100("two words")]', options)).toBe(
      '[\n  100("two words")\n]'
    );
    expect(
      CBOR.format('"[100(\\"two words\\")]"', { ...options, splitCdn: true })
    ).toBe('"[" +\n    "100(\\"two words\\")" +\n  "]"');
    // ...and a plain (non-ellipsis) tag directly inside `<<...>>` — since
    // that check isn't gated on strict/loose either.
    expect(CBOR.format('<<100("two words")>>', options)).toBe(
      '<<\n  100("two words")\n>>'
    );
    expect(
      CBOR.format('"<<100(\\"two words\\")>>"', { ...options, splitCdn: true })
    ).toBe('"<<" +\n    "100(\\"two words\\")" +\n  ">>"');
    // A tag *nested inside* an ellipsis's array-continuation still
    // disqualifies that array normally (isChainContinuationRoot only ever
    // applies to the outermost bracket/tag of the continuation, not
    // anything nested deeper within it) — the array's own genuine
    // collapse/expand decision produces a real newline, which correctly
    // still propagates all the way out.
    expect(CBOR.format('<<... + [100("two words")]>>', options)).toBe(
      '<<\n  ... + [\n    100("two words")\n  ]\n>>'
    );
    expect(
      CBOR.format('"<<... + [100(\\"two words\\")]>>"', {
        ...options,
        splitCdn: true,
      })
    ).toBe(
      '"<<" +\n    "... + [" +\n      "100(\\"two words\\")" +\n    "]" +\n  ">>"'
    );
  });

  test('splitCdn: <<...>> collapses without inlineLeafContainers; indefinite-length string groups do not', () => {
    // <<...>>'s one-line collapse isn't gated behind inlineLeafContainers
    // at all — mirrors the real AST's `alwaysInlineLeaf` (serializeContainer).
    expect(CBOR.format('"<<h\'0000\'>>"', { indent: 2, splitCdn: true })).toBe(
      '"<<h\'0000\'>>"'
    );
    // A multi-word text entry still forces a break either way.
    expect(
      CBOR.format('"<<\\"two words\\">>"', { indent: 2, splitCdn: true })
    ).toBe('"<<" +\n    "\\"two words\\"" +\n  ">>"');
    // Contrast: an indefinite-length string group follows the same
    // option-gated strict rule as an array/map instead — still splits
    // unconditionally without inlineLeafContainers, same as before.
    expect(
      CBOR.format('"(_ \\"a\\", \\"b\\")"', { indent: 2, splitCdn: true })
    ).toBe('"(_ " +\n    "\\"a\\", " +\n    "\\"b\\"" +\n  ")"');
    // A strict array/map is unaffected either way.
    expect(CBOR.format('"[1, 2]"', { indent: 2, splitCdn: true })).toBe(
      '"[" +\n    "1, " +\n    "2" +\n  "]"'
    );
  });

  test('splitCdn + inlineLeafContainers: app-sequences do not corrupt the bracket stack', () => {
    // `prefix<<` tokenizes as one APP_SEQUENCE token (no separate opener),
    // while its `>>` close is a normal GT_GT — regression guard for a stack
    // desync that used to pop an unrelated ancestor frame here. `h'0000'` is
    // a prefixed byte-string literal inside a loose frame (the app-sequence
    // is loose, same as `<<...>>`), so it stays an ordinary leaf here even
    // though the same literal in a strict array/map would always disqualify
    // inlining (see `isPrefixedLiteralText`).
    expect(
      CBOR.format('"[float<<h\'0000\'>>]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[float<<h\'0000\'>>]"');
    // A nested array inside a sibling entry still forces the outer array
    // to break, same as the real AST.
    expect(
      CBOR.format('"[float<<h\'0000\'>>, [1, 2]]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "float<<h\'0000\'>>, " +\n    "[1, 2]" +\n  "]"');
  });

  test('splitCdn + inlineLeafContainers: tag content and indefinite-length string groups inline', () => {
    // A tag wrapping a primitive is a leaf, same as real CborTag — its own
    // parens never force a break, matching renderSingleChildWithComments.
    expect(
      CBOR.format('"[100(2), 100(3)]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[100(2), 100(3)]"');
    // A tag wrapping an array is not a leaf — the array inside still
    // disqualifies the outer array via entryHasContainer.
    expect(
      CBOR.format('"[100([1, 2]), 3]"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "100([1, 2]), " +\n    "3" +\n  "]"');
    // Indefinite-length string groups go through serializeContainer for
    // real and use the same strict, option-gated rule as an array/map —
    // unlike `<<...>>`, which is the only container using the loose rule.
    expect(
      CBOR.format('"(_ \\"a\\", \\"b\\")"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"(_ \\"a\\", \\"b\\")"');
    // Without inlineLeafContainers, both still split unconditionally as
    // before — the flag gates all of this, it isn't a baseline change.
    expect(
      CBOR.format('"[100(2), 100(3)]"', { indent: 2, splitCdn: true })
    ).toBe(
      '"[" +\n    "100(" +\n      "2" +\n    "), " +\n    "100(" +\n      "3" +\n    ")" +\n  "]"'
    );
  });

  test("splitCdn + inlineLeafContainers: suppressing a tag paren keeps its content's own real breaks", () => {
    // The tag's own `(`/`)` stay tight (unconditionally suppressed), but a
    // non-leaf array inside still needs its own breakpoints — those must
    // not be discarded along with the tag's parens.
    expect(
      CBOR.format('"100([[1, 2], [3, 4]])"', {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe('"100([" +\n      "[1, 2], " +\n      "[3, 4]" +\n    "])"');
    // A `splitNewline` break inside the tag's string content produces no
    // breakpoint of its own within the tag (that's added by a separate
    // pass) — the forced-break signal must still reach the outer array so
    // its own brackets aren't wrongly suppressed either.
    const node = CBOR.fromCBOR(CBOR.encode('[100("a\\nb")]'));
    const quoted = node.toCDN({ indent: 2 });
    expect(
      CBOR.format(quoted, {
        indent: 2,
        splitCdn: true,
        splitNewline: true,
        inlineLeafContainers: true,
      })
    ).toBe('"[" +\n    "100(\\"a\\\\n" +\n        "b\\")" +\n  "]"');
  });

  test('splitCdn handles a very large embedded CDN array without blowing the call stack', () => {
    // Forwarding breakpoints between frames must loop rather than spread a
    // whole array as call arguments (`push(...huge)`) — spreading hits the
    // engine's argument-count limit well before 130k elements.
    const source = `[${Array(130_000).fill('1').join(',')}]`;
    expect(() =>
      CBOR.format(JSON.stringify(source), {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: false,
      })
    ).not.toThrow();
    // A leaf array that size should still collapse to one inline literal
    // once inlineLeafContainers is on.
    expect(
      CBOR.format(JSON.stringify(source), {
        indent: 2,
        splitCdn: true,
        inlineLeafContainers: true,
      })
    ).toBe(JSON.stringify(source));
  });

  test('preserveConcatenation + splitNewline handles a part with many newlines without blowing the call stack', () => {
    // Regression: splitting a preserved concatenation part at its newline
    // breakpoints used `parts.push(...splitAtBreakpoints(...))` — spreading
    // the result as call arguments hits the engine's argument-count limit
    // well before 130k newlines in a single part.
    const source = `"${'\\n'.repeat(130_000)}" + "tail"`;
    expect(() =>
      CBOR.format(source, {
        indent: 2,
        preserveConcatenation: true,
        splitNewline: true,
      })
    ).not.toThrow();
  });

  test('splitCdn + splitNewline: an embedded newline forces the surrounding CDN structure to break too', () => {
    // The array's own breakpoints must not be suppressed just because its
    // single entry looked leaf at the bracket level — the entry's own
    // rendering will contain a line break once splitNewline splits it,
    // same as serializeContainer's `s.includes('\n')` check on a rendered
    // entry.
    const node = CBOR.fromCBOR(CBOR.encode('["a\\nb"]'));
    const quoted = node.toCDN({ indent: 2 });
    const result = CBOR.format(`[${quoted}]`, {
      indent: 2,
      splitCdn: true,
      splitNewline: true,
      inlineLeafContainers: true,
    });
    // The outer array's own `[`/`]` breakpoints survive alongside the
    // newline-forced split inside the string.
    expect(result).toContain('"[" +');
    expect(result).toContain('+\n    "]"');
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
    expect(CBOR.format('42 # end', { indent: 2, preserveComments: true })).toBe(
      '42 # end'
    );
    expect(
      CBOR.format('# start\n42 # end', { indent: 2, preserveComments: true })
    ).toBe('# start\n42 # end');
  });

  test('root leading comment on the same source line as the value stays inline', () => {
    // Same source line as the root value: stays inline instead of forcing a
    // line break above it.
    expect(
      CBOR.format('/ note / 1', { indent: 2, preserveComments: true })
    ).toBe('/ note / 1');
    // Own source line: still gets its own line above the value.
    expect(
      CBOR.format('/ note /\n1', { indent: 2, preserveComments: true })
    ).toBe('/ note /\n1');
    // Own-line comment followed by a same-line one: only the latter inlines.
    expect(
      CBOR.format('// a\n/ note / 1', { indent: 2, preserveComments: true })
    ).toBe('// a\n/ note / 1');
  });

  test('single-line output ignores preserveComments', () => {
    expect(CBOR.format('42 # end', { preserveComments: true })).toBe('42');
    expect(CBOR.format('# before\n[1, 2]', { preserveComments: true })).toBe(
      '[1,2]'
    );
    expect(CBOR.format('[# a\n1, 2 # b\n]', { preserveComments: true })).toBe(
      '[1,2]'
    );
    expect(
      CBOR.format('# before\n{1: 2}', { indent: 0, preserveComments: true })
    ).toBe('{1:2}');
  });

  test('indent 0 and the empty string mean single-line output', () => {
    expect(CBOR.format('[1, 2]', { indent: 0 })).toBe('[1,2]');
    expect(CBOR.format('[1, 2]', { indent: '' })).toBe('[1,2]');
    expect(CBOR.format('{1: [2, 3]}', { indent: 0 })).toBe('{1:[2,3]}');
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

  test('preserveAll turns on every preserve* option at once, except the deprecated preserveTextString', () => {
    const text =
      '{"a":0xff,"b":1.5_1,"c":b64\'aGk=\',"d":"caf\\u00e9","e":`raw`,"f":"x"+"y"}';
    expect(CBOR.format(text, { preserveAll: true, indent: 2 })).toBe(
      '{\n' +
        '  "a": 0xff,\n' +
        '  "b": 1.5_1,\n' +
        '  "c": b64\'aGk=\',\n' +
        '  "d": "café",\n' +
        '  "e": `raw`,\n' +
        '  "f": "x" +\n' +
        '    "y"\n' +
        '}'
    );
    // Explicitly opting into the deprecated option still works.
    expect(
      CBOR.format(text, {
        preserveAll: true,
        preserveTextString: true,
        indent: 2,
      })
    ).toBe(
      '{\n' +
        '  "a": 0xff,\n' +
        '  "b": 1.5_1,\n' +
        '  "c": b64\'aGk=\',\n' +
        '  "d": "caf\\u00e9",\n' +
        '  "e": `raw`,\n' +
        '  "f": "x" +\n' +
        '    "y"\n' +
        '}'
    );
    // Default output normalises everything.
    expect(CBOR.format(text, { indent: 2 })).toBe(
      '{\n' +
        '  "a": 255,\n' +
        '  "b": 1.5,\n' +
        '  "c": \'hi\',\n' +
        '  "d": "café",\n' +
        '  "e": "raw",\n' +
        '  "f": "xy"\n' +
        '}'
    );
  });

  test('preserveAll no longer blocks splitNewline for a non-concatenated string', () => {
    // Regression guard: before preserveTextString was dropped from
    // preserveAll, this string's verbatim spelling would win over
    // splitNewline and it would stay on one line.
    expect(
      CBOR.format('"line1\\nline2"', {
        preserveAll: true,
        splitNewline: true,
        indent: 2,
      })
    ).toBe('"line1\\n" +\n  "line2"');
  });

  test('preserveAll no longer blocks splitCdn for a non-concatenated string', () => {
    // Regression guard: before preserveTextString was dropped from
    // preserveAll, this string's verbatim spelling would win over
    // splitCdn and it would stay on one line.
    expect(
      CBOR.format('"[1, 2, 3]"', {
        preserveAll: true,
        splitCdn: true,
        indent: 2,
      })
    ).toBe('"[" +\n    "1, " +\n    "2, " +\n    "3" +\n  "]"');
  });

  test('preserveAll leaves an explicitly-set individual option alone', () => {
    expect(
      CBOR.format('0xff', { preserveAll: true, preserveNumberFormat: false })
    ).toBe('255');
  });

  test('preserveAll + explicit preserveNumberFormat: false also applies inside a preserved raw tag', () => {
    // preserveAll turns preserveAppSequence on too, but a raw-tag source's
    // verbatim text is itself number-literal spelling — the explicit
    // preserveNumberFormat: false must still win there, not just for
    // top-level literals.
    expect(
      CBOR.format('0x1(0xff)', {
        preserveAll: true,
        preserveNumberFormat: false,
      })
    ).toBe('1(255)');
  });

  test('preserveAll on toCDN() alone does not capture comments — needs FromCDNOptions too', () => {
    // CBOR.format() passes the same options object to both fromCDN() and
    // toCDN(), so preserveAll covers both there; a manual fromCDN()/toCDN()
    // split needs preserveAll (or preserveComments) on the fromCDN() call
    // too, since comments must be captured while parsing.
    const withoutCapture = CBOR.fromCDN('1 # hi');
    expect(withoutCapture.toCDN({ preserveAll: true, indent: 2 })).toBe('1');

    const withCapture = CBOR.fromCDN('1 # hi', { preserveAll: true });
    expect(withCapture.toCDN({ preserveAll: true, indent: 2 })).toBe('1 # hi');
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
