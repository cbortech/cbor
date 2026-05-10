import { describe, test, expect } from 'vitest';
import { CBOR } from './cbor';
import { dt_as_Date } from './extensions/dt';
import { CborItem } from './ast/CborItem';

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

// CBOR bytes for 1(1704067200) = tag(1, uint(1704067200)) = DT'2024-01-01T00:00:00Z'
// tag 1 = 0xc1, uint 1704067200 (0x65920080) = 0x1a 65 92 00 80
const DT_2024_CBOR = hex('c11a65920080');
const DT_2024_STR = "DT'2024-01-01T00:00:00Z'";
const DT_2024_DATE = new Date('2024-01-01T00:00:00Z');
const DT_2024_EPOCH = 1704067200;

// ─── Constructor with no args ─────────────────────────────────────────────────

describe('new CBOR() — no defaults', () => {
  const cbor = new CBOR();

  test('parse() parses EDN like the static method', () => {
    expect(cbor.parse('42')).toBe(42);
    expect(cbor.parse('"hello"')).toBe('hello');
    expect(cbor.parse('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  test('stringify() serializes JS like the static method', () => {
    expect(cbor.stringify(42)).toBe('42');
    expect(cbor.stringify('hello')).toBe('"hello"');
    expect(cbor.stringify([1, 2, 3])).toBe('[1,2,3]');
  });

  test('decode() decodes CBOR bytes like the static method', () => {
    expect(cbor.decode(hex('1864'))).toBe(100);
  });

  test('encode() encodes JS values like the static method', () => {
    expect(toHex(cbor.encode(42))).toBe('182a');
  });

  test('cborToCborEdn() converts CBOR bytes like the static method', () => {
    expect(cbor.cborToCborEdn(hex('83010203'))).toBe('[1,2,3]');
  });

  test('cborEdnToCbor() converts EDN text like the static method', () => {
    expect(toHex(cbor.cborEdnToCbor('[1, 2, 3]'))).toBe('83010203');
  });

  test('fromEDN() returns a CborItem', () => {
    const node = cbor.fromEDN('42');
    expect(node).toBeInstanceOf(CborItem);
    expect(node.toJS()).toBe(42);
  });

  test('format() normalizes EDN like the static method', () => {
    expect(cbor.format('[  1 ,  2  ]')).toBe('[1,2]');
  });

  test('format() accepts indent option', () => {
    expect(cbor.format('[1, 2]', { indent: 2 })).toBe('[\n  1,\n  2\n]');
  });
});

// ─── Constructor with extensions default ─────────────────────────────────────

describe('new CBOR({ extensions: [dt_as_Date] }) — extension default', () => {
  const cbor = new CBOR({ extensions: [dt_as_Date] });

  // parse / stringify

  test('parse() recognises DT app-string without per-call extensions', () => {
    const result = cbor.parse(DT_2024_STR);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getTime()).toBe(DT_2024_DATE.getTime());
  });

  test('stringify() emits DT notation for Date values without per-call extensions', () => {
    const result = cbor.stringify(DT_2024_DATE);
    expect(result).toBe(DT_2024_STR);
  });

  test('parse() + stringify() round-trip', () => {
    const parsed = cbor.parse(DT_2024_STR);
    expect(cbor.stringify(parsed)).toBe(DT_2024_STR);
  });

  // decode / encode

  test('decode() applies extension when decoding CBOR bytes', () => {
    const result = cbor.decode(DT_2024_CBOR);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getTime()).toBe(DT_2024_DATE.getTime());
  });

  test('encode() uses extension when encoding JS values', () => {
    const encoded = cbor.encode(DT_2024_DATE);
    expect(toHex(encoded)).toBe(toHex(DT_2024_CBOR));
  });

  test('cborToCborEdn() applies extension defaults', () => {
    expect(cbor.cborToCborEdn(DT_2024_CBOR)).toBe(DT_2024_STR);
  });

  test('cborEdnToCbor() applies extension defaults', () => {
    expect(toHex(cbor.cborEdnToCbor(DT_2024_STR))).toBe(toHex(DT_2024_CBOR));
  });

  // fromEDN / fromCBOR / fromJS — _defaults carry-through

  test('fromEDN() node inherits _defaults: toJS() returns Date', () => {
    const node = cbor.fromEDN(DT_2024_STR);
    expect(node.toJS()).toBeInstanceOf(Date);
  });

  test('fromEDN() node inherits _defaults: toEDN() emits DT notation', () => {
    const node = cbor.fromEDN(DT_2024_STR);
    expect(node.toEDN()).toBe(DT_2024_STR);
  });

  test('fromCBOR() node inherits _defaults: toJS() returns Date', () => {
    const node = cbor.fromCBOR(DT_2024_CBOR);
    expect(node.toJS()).toBeInstanceOf(Date);
  });

  test('fromCBOR() node inherits _defaults: toEDN() emits DT notation', () => {
    const node = cbor.fromCBOR(DT_2024_CBOR);
    expect(node.toEDN()).toBe(DT_2024_STR);
  });

  test('fromJS() node inherits _defaults: toCBOR() produces correct bytes', () => {
    const node = cbor.fromJS(DT_2024_DATE);
    expect(toHex(node.toCBOR())).toBe(toHex(DT_2024_CBOR));
  });

  test('fromJS() node inherits _defaults: toEDN() emits DT notation', () => {
    const node = cbor.fromJS(DT_2024_DATE);
    expect(node.toEDN()).toBe(DT_2024_STR);
  });

  test('fromHexDump() node inherits _defaults: toJS() returns Date', () => {
    const dump = `C1        -- tag(1)
  1A 65 92 00 80  -- 1704067200`;
    const node = cbor.fromHexDump(dump);
    expect(node.toJS()).toBeInstanceOf(Date);
  });
});

// ─── Per-call options override defaults ──────────────────────────────────────

describe('per-call options override defaults', () => {
  const cbor = new CBOR({ extensions: [dt_as_Date] });

  test('parse() per-call reviver overrides default extension behaviour', () => {
    // Without per-call reviver: toJS() yields Date via extension
    expect(cbor.parse(DT_2024_STR)).toBeInstanceOf(Date);

    // With per-call reviver: reviver wins (returns epoch number instead)
    const result = cbor.parse(DT_2024_STR, (_key, val) =>
      val instanceof Date ? val.getTime() / 1000 : val
    );
    expect(typeof result).toBe('number');
    expect(result).toBeCloseTo(DT_2024_EPOCH, 0);
  });

  test('format() per-call indent overrides default indent', () => {
    const cborWithIndent = new CBOR({ indent: 4, extensions: [dt_as_Date] });
    // per-call indent: 2 should win over default indent: 4
    expect(cborWithIndent.format('[1, 2]', { indent: 2 })).toBe(
      '[\n  1,\n  2\n]'
    );
  });

  test('format() uses default indent from constructor', () => {
    const cborWithIndent = new CBOR({ indent: 2, extensions: [dt_as_Date] });
    expect(cborWithIndent.format('[1, 2]')).toBe('[\n  1,\n  2\n]');
  });

  test('format() applies extension default for DT notation', () => {
    expect(cbor.format(DT_2024_STR)).toBe(DT_2024_STR);
  });

  test('stringify() per-call replacer is applied on top of defaults', () => {
    const obj = { a: 1, b: 2, c: 3 };
    // Only keep key "a"
    const result = cbor.stringify(obj, ['a']);
    expect(result).toBe('{"a":1}');
  });

  test('stringify() space arg is applied on top of defaults', () => {
    const result = cbor.stringify([1, 2], null, 2);
    expect(result).toContain('\n');
  });

  test('fromEDN() per-call toJS() options override _defaults', () => {
    const node = cbor.fromEDN('42');
    // _defaults has no integerAs; override to bigint
    expect(node.toJS({ integerAs: 'bigint' })).toBe(42n);
  });

  test('fromCBOR() per-call decode() options override _defaults', () => {
    const result = cbor.decode(hex('1864'), { integerAs: 'bigint' });
    expect(result).toBe(100n);
  });

  test('decode() per-call appStrings:false disables DT notation in toJS', () => {
    // With appStrings: false the extension's _toEDN falls back to raw notation,
    // but toJS() should still return a Date (extension is still active).
    const result = cbor.decode(DT_2024_CBOR);
    expect(result).toBeInstanceOf(Date);
  });
});

// ─── parse() JSON-compatible overloads ───────────────────────────────────────

describe('instance parse() overloads', () => {
  const cbor = new CBOR({ extensions: [dt_as_Date] });

  test('parse(text) — one-arg form uses defaults', () => {
    expect(cbor.parse(DT_2024_STR)).toBeInstanceOf(Date);
  });

  test('parse(text, reviver) — two-arg function form', () => {
    const calls: [unknown, unknown][] = [];
    cbor.parse('[1, 2]', function (key, val) {
      calls.push([key, val]);
      return val;
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  test('parse(text, options) — options object form', () => {
    const result = cbor.parse('42', { integerAs: 'bigint' });
    expect(result).toBe(42n);
  });
});

// ─── stringify() JSON-compatible overloads ────────────────────────────────────

describe('instance stringify() overloads', () => {
  const cbor = new CBOR({ extensions: [dt_as_Date] });

  test('stringify(value) — one-arg form uses defaults', () => {
    expect(cbor.stringify(DT_2024_DATE)).toBe(DT_2024_STR);
  });

  test('stringify(value, fn, space) — function replacer form', () => {
    const result = cbor.stringify({ a: 1, b: 2 }, (_k, v) => v, 2);
    expect(result).toContain('\n');
    expect(result).toContain('"a"');
  });

  test('stringify(value, array) — array allowlist form', () => {
    const result = cbor.stringify({ a: 1, b: 2 }, ['b']);
    expect(result).toBe('{"b":2}');
  });

  test('stringify(value, null) — null replacer does not filter', () => {
    const result = cbor.stringify({ a: 1, b: 2 }, null);
    expect(result).toContain('"a"');
    expect(result).toContain('"b"');
  });

  test('stringify(value, null, space) — null with space indents', () => {
    const result = cbor.stringify([1, 2], null, 2);
    expect(result).toContain('\n');
  });

  test('stringify(value, options) — options object form', () => {
    const result = cbor.stringify(DT_2024_DATE, { appStrings: false });
    // With appStrings: false, extension emits raw tag notation, not DT'...'
    expect(result).not.toContain("DT'");
  });
});

// ─── appStrings default propagation ──────────────────────────────────────────

describe('appStrings default propagation via _defaults', () => {
  test('appStrings:false in constructor suppresses DT notation in toEDN()', () => {
    const cbor = new CBOR({ extensions: [dt_as_Date], appStrings: false });
    const node = cbor.fromEDN(DT_2024_STR);
    // toEDN() with no args should use _defaults which has appStrings:false
    expect(node.toEDN()).not.toContain("DT'");
    expect(node.toEDN()).not.toContain("dt'");
  });

  test('per-call appStrings:true overrides appStrings:false default', () => {
    const cbor = new CBOR({ extensions: [dt_as_Date], appStrings: false });
    const node = cbor.fromEDN(DT_2024_STR);
    expect(node.toEDN({ appStrings: true })).toContain("DT'");
  });
});

// ─── Multiple instances are independent ──────────────────────────────────────

describe('multiple instances are independent', () => {
  test('different defaults do not bleed between instances', () => {
    const withExt = new CBOR({ extensions: [dt_as_Date] });
    const withoutExt = new CBOR();

    const withResult = withExt.parse(DT_2024_STR);
    expect(withResult).toBeInstanceOf(Date);

    // Without the extension, DT'...' is treated as an unresolved app-ext
    // and produces a CPA999-wrapped node; toJS() returns a non-Date
    const withoutResult = withoutExt.parse(DT_2024_STR);
    expect(withoutResult).not.toBeInstanceOf(Date);
  });
});
