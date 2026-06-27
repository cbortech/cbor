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
    const items = [
      ...CBOR.fromCBORSeq(bytes, {
        onWarning: (w) => warnings.push(w),
        silent: true,
      }),
    ];
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
    const items = [
      ...CBOR.fromCDNSeq('1true', {
        strict: false,
        onWarning: (w) => warnings.push(w.message),
        silent: true,
      }),
    ];
    expect(items).toHaveLength(2);
    expect(items[0]!.toJS()).toBe(1);
    expect(items[1]!.toJS()).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('separated');
  });

  // ── Unterminated comments ──────────────────────────────────────────────────

  test('unterminated /* comment after item throws in strict mode', () => {
    expect(() => [...CBOR.fromCDNSeq('1 /* unterminated')]).toThrow(
      SyntaxError
    );
  });

  test('unterminated / comment after item throws in strict mode', () => {
    expect(() => [...CBOR.fromCDNSeq('1 / unterminated')]).toThrow(SyntaxError);
  });

  test('unterminated /* between items throws in strict mode', () => {
    // comment is in separator position (after comma), detected by skipCDNSeparator
    expect(() => [...CBOR.fromCDNSeq('1, /* unterminated')]).toThrow(
      SyntaxError
    );
  });

  test('unterminated /* comment warns and stops in non-strict mode', () => {
    // Unterminated comment immediately after item: parseCDN throws during
    // encoding-indicator peek; we catch it, warn, and stop — no items after the error.
    const warnings: string[] = [];
    const items = [
      ...CBOR.fromCDNSeq('1 /* unterminated', {
        strict: false,
        onWarning: (w) => warnings.push(w.message),
        silent: true,
      }),
    ];
    expect(items).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unterminated');
  });

  test('unterminated /* in separator warns, items before it are yielded', () => {
    // Comment is in separator position: skipCDNSeparator detects it.
    // Items successfully parsed before the separator are yielded.
    const warnings: string[] = [];
    const items = [
      ...CBOR.fromCDNSeq('1, /* unterminated', {
        strict: false,
        onWarning: (w) => warnings.push(w.message),
        silent: true,
      }),
    ];
    expect(items).toHaveLength(1);
    expect(items[0]!.toJS()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unterminated');
  });

  test('unterminated / comment warns and stops in non-strict mode', () => {
    const warnings: string[] = [];
    const items = [
      ...CBOR.fromCDNSeq('1 / unterminated', {
        strict: false,
        onWarning: (w) => warnings.push(w.message),
        silent: true,
      }),
    ];
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
    expect([...CBOR.fromCDNSeq('1, 2, 3,')].map((i) => i.toJS())).toEqual([
      1, 2, 3,
    ]);
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
    const items = [
      ...CBOR.fromCDNSeq(',1', {
        strict: false,
        onWarning: (w) => warnings.push(w.message),
        silent: true,
      }),
    ];
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
    const hexStr = Array.from(single)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
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

describe('CBOR.decodeSeq', () => {
  test('empty input yields no values', () => {
    expect([...CBOR.decodeSeq(new Uint8Array())]).toEqual([]);
  });

  test('single item yields one JS value', () => {
    const bytes = CBOR.encode(42);
    expect([...CBOR.decodeSeq(bytes)]).toEqual([42]);
  });

  test('multiple concatenated items yield JS values in order', () => {
    const a = CBOR.encode({ x: 1 });
    const b = CBOR.encode([2, 3]);
    const c = CBOR.encode('hello');
    const seq = new Uint8Array([...a, ...b, ...c]);
    expect([...CBOR.decodeSeq(seq)]).toEqual([{ x: 1 }, [2, 3], 'hello']);
  });

  test('ToJSOptions are forwarded', () => {
    const bytes = CBOR.encode(42n);
    const [val] = [...CBOR.decodeSeq(bytes, { integerAs: 'number' })];
    expect(val).toBe(42);
  });

  test('instance decodeSeq merges defaults', () => {
    const cbor = new CBOR({ integerAs: 'number' });
    const bytes = CBOR.encode(99n);
    const [val] = [...cbor.decodeSeq(bytes)];
    expect(val).toBe(99);
  });

  test('reviver is called once at root per sequence item', () => {
    const a = CBOR.encode({ x: 1 });
    const b = CBOR.encode({ x: 2 });
    const c = CBOR.encode({ x: 3 });
    const roots: unknown[] = [];
    const values = [
      ...CBOR.decodeSeq(new Uint8Array([...a, ...b, ...c]), {
        reviver(key, value) {
          if (key === '') roots.push(value);
          return value;
        },
      }),
    ];
    expect(values).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
    expect(roots).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });
});

describe('CBOR.parseSeq', () => {
  test('empty string yields no values', () => {
    expect([...CBOR.parseSeq('')]).toEqual([]);
    expect([...CBOR.parseSeq('  ')]).toEqual([]);
  });

  test('single item yields one JS value', () => {
    expect([...CBOR.parseSeq('42')]).toEqual([42]);
  });

  test('comma-separated items yield JS values in order', () => {
    expect([...CBOR.parseSeq('1, "two", [3]')]).toEqual([1, 'two', [3]]);
  });

  test('newline-separated items (JSONL style)', () => {
    const text = '{"a":1}\n{"b":2}\n{"c":3}';
    expect([...CBOR.parseSeq(text)]).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test('ToJSOptions are forwarded', () => {
    const cbor = new CBOR({ extensions: [CBOR.dt_as_Date] });
    const [val] = [...cbor.parseSeq("DT'2024-01-01T00:00:00Z'")];
    expect(val).toBeInstanceOf(Date);
  });

  test('instance parseSeq merges defaults', () => {
    const cbor = new CBOR({ extensions: [CBOR.dt_as_Date] });
    const values = [...cbor.parseSeq("DT'2024-01-01T00:00:00Z', 42")];
    expect(values).toHaveLength(2);
    expect(values[0]).toBeInstanceOf(Date);
    expect(values[1]).toBe(42);
  });

  test('reviver is called once at root per sequence item', () => {
    const roots: unknown[] = [];
    const values = [
      ...CBOR.parseSeq('{"x":1}, {"x":2}, {"x":3}', {
        reviver(key, value) {
          if (key === '') roots.push(value);
          return value;
        },
      }),
    ];
    expect(values).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
    expect(roots).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });
});

describe('CBOR.compile', () => {
  test('empty string returns empty Uint8Array', () => {
    expect(CBOR.compile('')).toEqual(new Uint8Array());
    expect(CBOR.compile('  ')).toEqual(new Uint8Array());
  });

  test('single item produces the same bytes as encode', () => {
    expect(CBOR.compile('[1, 2, 3]')).toEqual(CBOR.encode([1, 2, 3]));
  });

  test('CDN Sequence produces concatenated CBOR Sequence bytes', () => {
    const result = CBOR.compile('1, "two", [3]');
    const expected = new Uint8Array([
      ...CBOR.encode(1),
      ...CBOR.encode('two'),
      ...CBOR.encode([3]),
    ]);
    expect(result).toEqual(expected);
  });

  test('output round-trips through decodeSeq', () => {
    const bytes = CBOR.compile('{"a":1}\n{"b":2}\n{"c":3}');
    expect([...CBOR.decodeSeq(bytes)]).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test('strict:false and onWarning are forwarded', () => {
    const warnings: string[] = [];
    const bytes = CBOR.compile('1true', {
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('separated');
    expect(bytes).toEqual(
      new Uint8Array([...CBOR.encode(1), ...CBOR.encode(true)])
    );
  });

  test('instance compile merges defaults', () => {
    const cbor = new CBOR({ extensions: [CBOR.dt_as_Date] });
    const bytes = cbor.compile("DT'2024-01-01T00:00:00Z'");
    expect(bytes).toEqual(
      CBOR.fromCDN("DT'2024-01-01T00:00:00Z'", {
        extensions: [CBOR.dt_as_Date],
      }).toCBOR()
    );
  });
});

describe('CBOR.decompile', () => {
  test('empty input returns empty string', () => {
    expect(CBOR.decompile(new Uint8Array())).toBe('');
  });

  test('single item produces the same CDN as fromCBOR().toCDN()', () => {
    const bytes = CBOR.encode([1, 2, 3]);
    expect(CBOR.decompile(bytes)).toBe(CBOR.fromCBOR(bytes).toCDN());
  });

  test('CBOR Sequence produces newline-joined CDN items', () => {
    const seq = new Uint8Array([
      ...CBOR.encode(1),
      ...CBOR.encode('two'),
      ...CBOR.encode([3]),
    ]);
    expect(CBOR.decompile(seq)).toBe('1\n"two"\n[3]');
  });

  test('output round-trips through compile', () => {
    const original = new Uint8Array([
      ...CBOR.encode({ a: 1 }),
      ...CBOR.encode({ b: 2 }),
    ]);
    const cdn = CBOR.decompile(original);
    expect(CBOR.compile(cdn)).toEqual(original);
  });

  test('toCDN options are forwarded', () => {
    const bytes = CBOR.encode({ x: 1 });
    const result = CBOR.decompile(bytes, { indent: 2 });
    expect(result).toContain('\n');
  });

  test('instance decompile merges defaults', () => {
    const cbor = new CBOR({ indent: 2 });
    const bytes = CBOR.encode({ x: 1 });
    expect(cbor.decompile(bytes)).toContain('\n');
  });
});

describe('CBOR.toHex', () => {
  test('empty input returns empty string', () => {
    expect(CBOR.toHex(new Uint8Array())).toBe('');
  });

  test('single item produces same output as fromCBOR().toHexDump()', () => {
    const bytes = CBOR.encode([1, 2, 3]);
    expect(CBOR.toHex(bytes)).toBe(CBOR.fromCBOR(bytes).toHexDump());
  });

  test('CBOR Sequence produces newline-joined hex dumps', () => {
    const seq = new Uint8Array([...CBOR.encode(1), ...CBOR.encode(2)]);
    const result = CBOR.toHex(seq);
    const parts = result.split('\n');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('01');
    expect(parts[1]).toContain('02');
  });

  test('ToHexDumpOptions are forwarded', () => {
    const bytes = CBOR.encode(1);
    const withHash = CBOR.toHex(bytes, { commentStyle: '#' });
    expect(withHash).toContain('#');
  });

  test('instance toHex merges defaults', () => {
    const cbor = new CBOR({ commentStyle: '#' });
    const bytes = CBOR.encode(1);
    expect(cbor.toHex(bytes)).toContain('#');
  });
});

describe('CBOR.fromHex', () => {
  test('empty string returns empty Uint8Array', () => {
    expect(CBOR.fromHex('')).toEqual(new Uint8Array());
  });

  test('single item round-trips through toHex', () => {
    const original = CBOR.encode([1, 2, 3]);
    expect(CBOR.fromHex(CBOR.toHex(original))).toEqual(original);
  });

  test('CBOR Sequence dump round-trips through toHex', () => {
    const original = new Uint8Array([...CBOR.encode(1), ...CBOR.encode('two')]);
    expect(CBOR.fromHex(CBOR.toHex(original))).toEqual(original);
  });

  test('output round-trips through decodeSeq', () => {
    const dump = CBOR.toHex(
      new Uint8Array([...CBOR.encode({ a: 1 }), ...CBOR.encode({ b: 2 })])
    );
    const bytes = CBOR.fromHex(dump);
    expect([...CBOR.decodeSeq(bytes)]).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('instance fromHex merges defaults', () => {
    const cbor = new CBOR({ extensions: [CBOR.dt_as_Date] });
    const bytes = CBOR.fromCDN("DT'2024-01-01T00:00:00Z'", {
      extensions: [CBOR.dt_as_Date],
    }).toCBOR();
    const dump = CBOR.toHex(bytes);
    expect(CBOR.fromHex(dump)).toEqual(bytes);
    expect(cbor.fromHex(dump)).toEqual(bytes);
  });
});
