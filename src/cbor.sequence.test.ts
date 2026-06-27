import { describe, test, expect } from 'vitest';
import { CBOR } from './cbor';
import { CborUint } from './ast/CborUint';
import { CborMap } from './ast/CborMap';

/** Convert a hex string (spaces allowed) to Uint8Array. */
function hex(s: string): Uint8Array {
  s = s.replace(/\s+/g, '');
  const result = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2)
    result[i / 2] = parseInt(s.slice(i, i + 2), 16);
  return result;
}

// ─── fromCBORSeq ─────────────────────────────────────────────────────────

describe('CBOR.fromCBORSeq', () => {
  test('empty input yields no items', () => {
    const items = [...CBOR.fromCBORSeq(new Uint8Array([]))];
    expect(items).toHaveLength(0);
  });

  test('single item yields one item matching fromCBOR', () => {
    const bytes = hex('01'); // uint 1
    const [item, ...rest] = [...CBOR.fromCBORSeq(bytes)];
    expect(rest).toHaveLength(0);
    expect(item).toBeInstanceOf(CborUint);
    expect((item as CborUint).value).toBe(1n);
  });

  test('two concatenated items are yielded in order', () => {
    // uint 1 (0x01) followed by uint 2 (0x02)
    const bytes = hex('01 02');
    const items = [...CBOR.fromCBORSeq(bytes)];
    expect(items).toHaveLength(2);
    expect((items[0] as CborUint).value).toBe(1n);
    expect((items[1] as CborUint).value).toBe(2n);
  });

  test('three items: start/end offsets are correct', () => {
    // uint 1 (0x01), uint 2 (0x02), uint 3 (0x03)
    const bytes = hex('01 02 03');
    const items = [...CBOR.fromCBORSeq(bytes)];
    expect(items).toHaveLength(3);
    expect(items[0]!.start).toBe(0);
    expect(items[0]!.end).toBe(1);
    expect(items[1]!.start).toBe(1);
    expect(items[1]!.end).toBe(2);
    expect(items[2]!.start).toBe(2);
    expect(items[2]!.end).toBe(3);
  });

  test('complex items (maps) are decoded correctly', () => {
    // {"a": 1} encoded as CBOR, twice concatenated
    const single = CBOR.fromJS({ a: 1 }).toCBOR();
    const seq = new Uint8Array([...single, ...single]);
    const items = [...CBOR.fromCBORSeq(seq)];
    expect(items).toHaveLength(2);
    expect(items[0]).toBeInstanceOf(CborMap);
    expect(items[1]).toBeInstanceOf(CborMap);
    expect(items[0]!.toJS()).toEqual({ a: 1 });
    expect(items[1]!.toJS()).toEqual({ a: 1 });
  });

  test('accepts ArrayBuffer', () => {
    const bytes = hex('01 02');
    const buf = bytes.buffer;
    const items = [...CBOR.fromCBORSeq(buf)];
    expect(items).toHaveLength(2);
  });

  test('options are forwarded to each item decode', () => {
    const bytes = hex('01 02');
    const warnings: unknown[] = [];
    const items = [...CBOR.fromCBORSeq(bytes, {
      onWarning: (w) => warnings.push(w),
      silent: true,
    })];
    expect(items).toHaveLength(2);
  });
});

// ─── fromCDNSeq ─────────────────────────────────────────────────────────

describe('CBOR.fromCDNSeq', () => {
  test('empty string yields no items', () => {
    expect([...CBOR.fromCDNSeq('')]).toHaveLength(0);
  });

  test('whitespace-only string yields no items', () => {
    expect([...CBOR.fromCDNSeq('   \n  ')]).toHaveLength(0);
  });

  test('single item yields one item', () => {
    const items = [...CBOR.fromCDNSeq('42')];
    expect(items).toHaveLength(1);
    expect(items[0]!.toJS()).toBe(42);
  });

  test('comma-separated items', () => {
    const items = [...CBOR.fromCDNSeq('1, 2, 3')];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.toJS())).toEqual([1, 2, 3]);
  });

  test('whitespace-separated items (no comma)', () => {
    const items = [...CBOR.fromCDNSeq('1 2 3')];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.toJS())).toEqual([1, 2, 3]);
  });

  test('newline-separated items (JSONL style)', () => {
    const text = '{"a": 1}\n{"b": 2}\n{"c": 3}';
    const items = [...CBOR.fromCDNSeq(text)];
    expect(items).toHaveLength(3);
    expect(items[0]!.toJS()).toEqual({ a: 1 });
    expect(items[1]!.toJS()).toEqual({ b: 2 });
    expect(items[2]!.toJS()).toEqual({ c: 3 });
  });

  test('leading and trailing whitespace is ignored', () => {
    const items = [...CBOR.fromCDNSeq('  1, 2  ')];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.toJS())).toEqual([1, 2]);
  });

  test('# line comment between items', () => {
    const text = '1 # first\n, 2 # second\n, 3';
    const items = [...CBOR.fromCDNSeq(text)];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.toJS())).toEqual([1, 2, 3]);
  });

  test('// line comment between items', () => {
    const text = '1 // first\n2 // second\n3';
    const items = [...CBOR.fromCDNSeq(text)];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.toJS())).toEqual([1, 2, 3]);
  });

  test('/* */ block comment between items', () => {
    const text = '1 /* between */ 2';
    const items = [...CBOR.fromCDNSeq(text)];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.toJS())).toEqual([1, 2]);
  });

  test('complex CDN items (maps, arrays)', () => {
    const text = '{"x": 1}, [1, 2, 3], "hello"';
    const items = [...CBOR.fromCDNSeq(text)];
    expect(items).toHaveLength(3);
    expect(items[0]!.toJS()).toEqual({ x: 1 });
    expect(items[1]!.toJS()).toEqual([1, 2, 3]);
    expect(items[2]!.toJS()).toBe('hello');
  });

  test('RFC 7464 JSON Sequence: RS (0x1E) as separator', () => {
    const text = '\x1e{"a":1}\n\x1e{"b":2}\n\x1e{"c":3}\n';
    const items = [...CBOR.fromCDNSeq(text)];
    expect(items).toHaveLength(3);
    expect(items[0]!.toJS()).toEqual({ a: 1 });
    expect(items[1]!.toJS()).toEqual({ b: 2 });
    expect(items[2]!.toJS()).toEqual({ c: 3 });
  });

  test('comma is optional — no double-comma consumed', () => {
    // Two commas in a row would be a syntax error (second comma is not a separator)
    // Verify that a single comma between items works correctly
    const items = [...CBOR.fromCDNSeq('1,2')];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.toJS())).toEqual([1, 2]);
  });

  test('toCBOR() on yielded items works', () => {
    const items = [...CBOR.fromCDNSeq('1, 2')];
    const seq = new Uint8Array([...items[0]!.toCBOR(), ...items[1]!.toCBOR()]);
    const back = [...CBOR.fromCBORSeq(seq)];
    expect(back.map((i) => i.toJS())).toEqual([1, 2]);
  });

  // ── MSC (separator) requirement ────────────────────────────────────────────

  test('adjacent items without separator throw in strict mode', () => {
    expect(() => [...CBOR.fromCDNSeq('1true')]).toThrow(SyntaxError);
    expect(() => [...CBOR.fromCDNSeq('1[]')]).toThrow(SyntaxError);
    expect(() => [...CBOR.fromCDNSeq('{}[]')]).toThrow(SyntaxError);
  });

  test('adjacent items without separator warn in non-strict mode', () => {
    const warnings: string[] = [];
    const items = [...CBOR.fromCDNSeq('1true', {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
      silent: true,
    })];
    expect(items).toHaveLength(2);
    expect(items[0]!.toJS()).toBe(1);
    expect(items[1]!.toJS()).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('separated');
  });

  // ── Unterminated comments ──────────────────────────────────────────────────

  test('unterminated /* comment after item throws in strict mode', () => {
    expect(() => [...CBOR.fromCDNSeq('1 /* unterminated')]).toThrow(SyntaxError);
  });

  test('unterminated / comment after item throws in strict mode', () => {
    expect(() => [...CBOR.fromCDNSeq('1 / unterminated')]).toThrow(SyntaxError);
  });

  test('unterminated /* between items throws in strict mode', () => {
    // comment is in separator position (after comma), detected by skipCDNSeparator
    expect(() => [...CBOR.fromCDNSeq('1, /* unterminated')]).toThrow(SyntaxError);
  });

  test('unterminated /* comment warns and stops in non-strict mode', () => {
    // Unterminated comment immediately after item: parseCDN throws during
    // encoding-indicator peek; we catch it, warn, and stop — no items after the error.
    const warnings: string[] = [];
    const items = [...CBOR.fromCDNSeq('1 /* unterminated', {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
      silent: true,
    })];
    expect(items).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unterminated');
  });

  test('unterminated /* in separator warns, items before it are yielded', () => {
    // Comment is in separator position: skipCDNSeparator detects it.
    // Items successfully parsed before the separator are yielded.
    const warnings: string[] = [];
    const items = [...CBOR.fromCDNSeq('1, /* unterminated', {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
      silent: true,
    })];
    expect(items).toHaveLength(1);
    expect(items[0]!.toJS()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unterminated');
  });

  test('unterminated / comment warns and stops in non-strict mode', () => {
    const warnings: string[] = [];
    const items = [...CBOR.fromCDNSeq('1 / unterminated', {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
      silent: true,
    })];
    expect(items).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unterminated');
  });

  // ── Leading / trailing comma (ABNF: seq = S [item *(MSC item) SOC]) ──────────
  // SOC = S ["," S]  →  trailing comma is VALID per spec

  test('trailing comma is valid (SOC)', () => {
    // {} + SOC(",") — all valid
    expect([...CBOR.fromCDNSeq('1,')].map((i) => i.toJS())).toEqual([1]);
    expect([...CBOR.fromCDNSeq('1, ')].map((i) => i.toJS())).toEqual([1]);
    expect([...CBOR.fromCDNSeq('1, 2, 3,')].map((i) => i.toJS())).toEqual([1, 2, 3]);
  });

  test('leading comma throws in strict mode', () => {
    expect(() => [...CBOR.fromCDNSeq(',1')]).toThrow(SyntaxError);
    expect(() => [...CBOR.fromCDNSeq(', 1')]).toThrow(SyntaxError);
  });

  test('comma-only input throws in strict mode (leading comma)', () => {
    expect(() => [...CBOR.fromCDNSeq(',')]).toThrow(SyntaxError);
  });

  test('leading comma warns and still yields items in non-strict mode', () => {
    const warnings: string[] = [];
    const items = [...CBOR.fromCDNSeq(',1', {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
      silent: true,
    })];
    expect(items).toHaveLength(1);
    expect(items[0]!.toJS()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('leading comma');
  });

  // ── RS (0x1E) not corrupting string contents ───────────────────────────────

  test('RS inside string content is NOT silently converted to space', () => {
    // "a\x1eb" is not valid CDN (unescaped control character in text string)
    // With the old global-replace approach it became "a b" (silently valid).
    // With the new per-token approach the tokenizer rejects it.
    expect(() => [...CBOR.fromCDNSeq('"a\x1eb"')]).toThrow();
  });

  test('RS as separator between items still works', () => {
    const text = '\x1e1\x1e2\x1e3';
    const items = [...CBOR.fromCDNSeq(text)];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.toJS())).toEqual([1, 2, 3]);
  });
});

// ─── fromHexDumpSeq ───────────────────────────────────────────────────────────

describe('CBOR.fromHexDumpSeq', () => {
  test('empty hex dump yields no items', () => {
    expect([...CBOR.fromHexDumpSeq('')]).toHaveLength(0);
  });

  test('single item from hex dump', () => {
    const items = [...CBOR.fromHexDumpSeq('01')];
    expect(items).toHaveLength(1);
    expect(items[0]!.toJS()).toBe(1);
  });

  test('two concatenated items from hex dump', () => {
    const items = [...CBOR.fromHexDumpSeq('01 02')];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.toJS())).toEqual([1, 2]);
  });

  test('strips -- comments', () => {
    const dump = '01 -- uint 1\n02 -- uint 2';
    const items = [...CBOR.fromHexDumpSeq(dump)];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.toJS())).toEqual([1, 2]);
  });

  test('strips # comments', () => {
    const dump = '01 # uint 1\n02 # uint 2';
    const items = [...CBOR.fromHexDumpSeq(dump)];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.toJS())).toEqual([1, 2]);
  });

  test('strips // comments', () => {
    const dump = '01 // uint 1\n02 // uint 2';
    const items = [...CBOR.fromHexDumpSeq(dump)];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.toJS())).toEqual([1, 2]);
  });

  test('longer tokens (multi-byte items)', () => {
    // {"a":1} in CBOR = a1 61 61 01
    const single = CBOR.fromJS({ a: 1 }).toCBOR();
    const hexStr = Array.from(single).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const dump = `${hexStr}\n${hexStr}`;
    const items = [...CBOR.fromHexDumpSeq(dump)];
    expect(items).toHaveLength(2);
    expect(items[0]!.toJS()).toEqual({ a: 1 });
    expect(items[1]!.toJS()).toEqual({ a: 1 });
  });

  test('instance fromHexDumpSeq propagates _defaults', () => {
    const cbor = new CBOR({ silent: true });
    const items = [...cbor.fromHexDumpSeq('01 02')];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item._defaults).toMatchObject({ silent: true });
    }
  });
});

// ─── Instance API ─────────────────────────────────────────────────────────────

describe('CBOR instance fromCBORSeq / fromCDNSeq', () => {
  test('instance fromCBORSeq propagates _defaults', () => {
    const cbor = new CBOR({ silent: true });
    const bytes = hex('01 02');
    const items = [...cbor.fromCBORSeq(bytes)];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item._defaults).toMatchObject({ silent: true });
    }
  });

  test('instance fromCDNSeq propagates _defaults', () => {
    const cbor = new CBOR({ silent: true });
    const items = [...cbor.fromCDNSeq('1, 2')];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item._defaults).toMatchObject({ silent: true });
    }
  });

  test('instance fromCDNSeq applies instance extensions', () => {
    const cbor = new CBOR({ extensions: [CBOR.dt_as_Date] });
    const items = [...cbor.fromCDNSeq("DT'2024-01-01T00:00:00Z', 42")];
    expect(items).toHaveLength(2);
    expect(items[0]!.toJS()).toBeInstanceOf(Date);
    expect(items[1]!.toJS()).toBe(42);
  });
});
