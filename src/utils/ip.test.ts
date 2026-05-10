import { describe, test, expect } from 'vitest';
import { parseIPv4, parseIPv6, formatIPv4, formatIPv6 } from './ip';

// ─── parseIPv4 ────────────────────────────────────────────────────────────────

describe('parseIPv4', () => {
  test('192.0.2.42 → [0xc0, 0x00, 0x02, 0x2a]', () => {
    expect(parseIPv4('192.0.2.42')).toEqual(
      new Uint8Array([0xc0, 0x00, 0x02, 0x2a])
    );
  });

  test('0.0.0.0 → 4 zero bytes', () => {
    expect(parseIPv4('0.0.0.0')).toEqual(new Uint8Array(4));
  });

  test('255.255.255.255 → 4 bytes 0xff', () => {
    expect(parseIPv4('255.255.255.255')).toEqual(
      new Uint8Array([0xff, 0xff, 0xff, 0xff])
    );
  });

  test('10.0.0.1 → [10, 0, 0, 1]', () => {
    expect(parseIPv4('10.0.0.1')).toEqual(new Uint8Array([10, 0, 0, 1]));
  });

  test('throws on fewer than 4 octets', () => {
    expect(() => parseIPv4('192.0.2')).toThrow(SyntaxError);
    expect(() => parseIPv4('1')).toThrow(SyntaxError);
  });

  test('throws on more than 4 octets', () => {
    expect(() => parseIPv4('1.2.3.4.5')).toThrow(SyntaxError);
  });

  test('throws on non-numeric octet', () => {
    expect(() => parseIPv4('192.0.2.x')).toThrow(SyntaxError);
    expect(() => parseIPv4('192.0.2.')).toThrow(SyntaxError);
  });

  test('throws on leading zero in octet', () => {
    expect(() => parseIPv4('192.0.02.1')).toThrow(SyntaxError);
    expect(() => parseIPv4('00.0.0.0')).toThrow(SyntaxError);
  });

  test('throws on octet out of range (> 255)', () => {
    expect(() => parseIPv4('256.0.0.0')).toThrow(SyntaxError);
    expect(() => parseIPv4('192.0.2.256')).toThrow(SyntaxError);
  });
});

// ─── parseIPv6 ────────────────────────────────────────────────────────────────

describe('parseIPv6', () => {
  test(':: → 16 zero bytes', () => {
    expect(parseIPv6('::')).toEqual(new Uint8Array(16));
  });

  test('::1 → loopback (last byte = 1)', () => {
    const expected = new Uint8Array(16);
    expected[15] = 1;
    expect(parseIPv6('::1')).toEqual(expected);
  });

  test('full address: 2001:0db8:0000:0000:0000:0000:0000:0001', () => {
    expect(parseIPv6('2001:0db8:0000:0000:0000:0000:0000:0001')).toEqual(
      new Uint8Array([
        0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
      ])
    );
  });

  test('2001:db8::42', () => {
    expect(parseIPv6('2001:db8::42')).toEqual(
      new Uint8Array([
        0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x42,
      ])
    );
  });

  test('fe80::1 → link-local', () => {
    const expected = new Uint8Array(16);
    expected[0] = 0xfe;
    expected[1] = 0x80;
    expected[15] = 0x01;
    expect(parseIPv6('fe80::1')).toEqual(expected);
  });

  test('ffff:: → first group set', () => {
    const expected = new Uint8Array(16);
    expected[0] = 0xff;
    expected[1] = 0xff;
    expect(parseIPv6('ffff::')).toEqual(expected);
  });

  test('::ffff → last group set', () => {
    const expected = new Uint8Array(16);
    expected[14] = 0xff;
    expected[15] = 0xff;
    expect(parseIPv6('::ffff')).toEqual(expected);
  });

  test('IPv4-mapped: ::ffff:192.0.2.1', () => {
    expect(parseIPv6('::ffff:192.0.2.1')).toEqual(
      new Uint8Array([
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xc0, 0x00, 0x02, 0x01,
      ])
    );
  });

  test('case-insensitive hex groups: 2001:DB8::1', () => {
    expect(parseIPv6('2001:DB8::1')).toEqual(parseIPv6('2001:db8::1'));
  });

  test('throws on too many groups (no ::)', () => {
    expect(() => parseIPv6('1:2:3:4:5:6:7:8:9')).toThrow(SyntaxError);
  });

  test('throws on multiple :: separators', () => {
    expect(() => parseIPv6('1::2::3')).toThrow(SyntaxError);
  });

  test('throws on invalid hex group', () => {
    expect(() => parseIPv6('gggg::1')).toThrow(SyntaxError);
    expect(() => parseIPv6('12345::1')).toThrow(SyntaxError);
  });

  test('throws on :: with too many groups', () => {
    // leftParts(8) + rightParts(1) = 9 > totalGroups(8)
    expect(() => parseIPv6('1:2:3:4:5:6:7:8::9')).toThrow(SyntaxError);
  });
});

// ─── formatIPv4 ───────────────────────────────────────────────────────────────

describe('formatIPv4', () => {
  test('[192, 0, 2, 42] → "192.0.2.42"', () => {
    expect(formatIPv4(new Uint8Array([192, 0, 2, 42]))).toBe('192.0.2.42');
  });

  test('[0, 0, 0, 0] → "0.0.0.0"', () => {
    expect(formatIPv4(new Uint8Array(4))).toBe('0.0.0.0');
  });

  test('[255, 255, 255, 255] → "255.255.255.255"', () => {
    expect(formatIPv4(new Uint8Array([255, 255, 255, 255]))).toBe(
      '255.255.255.255'
    );
  });

  test('[10, 0, 0, 1] → "10.0.0.1"', () => {
    expect(formatIPv4(new Uint8Array([10, 0, 0, 1]))).toBe('10.0.0.1');
  });
});

// ─── formatIPv6 ───────────────────────────────────────────────────────────────

describe('formatIPv6', () => {
  test('all-zero bytes → "::"', () => {
    expect(formatIPv6(new Uint8Array(16))).toBe('::');
  });

  test('loopback → "::1"', () => {
    const bytes = new Uint8Array(16);
    bytes[15] = 1;
    expect(formatIPv6(bytes)).toBe('::1');
  });

  test('2001:db8::42', () => {
    const bytes = new Uint8Array([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x42,
    ]);
    expect(formatIPv6(bytes)).toBe('2001:db8::42');
  });

  test('fe80::1 (link-local)', () => {
    const bytes = new Uint8Array(16);
    bytes[0] = 0xfe;
    bytes[1] = 0x80;
    bytes[15] = 0x01;
    expect(formatIPv6(bytes)).toBe('fe80::1');
  });

  test('no zero run — no :: compression', () => {
    // 0101:0202:0303:0404:0505:0606:0707:0808
    const bytes = new Uint8Array([
      0x01, 0x01, 0x02, 0x02, 0x03, 0x03, 0x04, 0x04, 0x05, 0x05, 0x06, 0x06,
      0x07, 0x07, 0x08, 0x08,
    ]);
    expect(formatIPv6(bytes)).toBe('101:202:303:404:505:606:707:808');
  });

  test('single zero group — no :: compression (run length < 2)', () => {
    // 2001:db8:0:1::1
    const bytes = new Uint8Array([
      0x20, 0x01, 0x0d, 0xb8, 0x00, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0x01,
    ]);
    // zero groups: position 2 (0x0000) = length 1, positions 4-6 (0x0000...) = length 3
    // RFC 5952: compress longest run (positions 4-6); single zero at position 2 stays
    expect(formatIPv6(bytes)).toBe('2001:db8:0:1::1');
  });

  test('two equal-length zero runs — first run wins (RFC 5952 §4.2.3)', () => {
    // 2001:0:0:1:2:0:0:1 — two runs of 2 zeros
    const bytes = new Uint8Array([
      0x20, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x01,
    ]);
    expect(formatIPv6(bytes)).toBe('2001::1:2:0:0:1');
  });

  test('IPv4-mapped ::ffff:192.0.2.1 — RFC 5952 §5 dotted suffix', () => {
    const bytes = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xc0, 0x00, 0x02, 0x01,
    ]);
    expect(formatIPv6(bytes)).toBe('::ffff:192.0.2.1');
  });

  test('::ffff:0.0.0.0 — all-zero IPv4 suffix', () => {
    const bytes = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0,
    ]);
    expect(formatIPv6(bytes)).toBe('::ffff:0.0.0.0');
  });

  test('::1 is NOT treated as IPv4-mapped (bytes 10-11 are not 0xffff)', () => {
    const bytes = new Uint8Array(16);
    bytes[15] = 1;
    expect(formatIPv6(bytes)).toBe('::1');
    expect(formatIPv6(bytes)).not.toContain('.');
  });
});

// ─── parseIPv4 / formatIPv4 round-trip ───────────────────────────────────────

describe('parseIPv4 / formatIPv4 round-trip', () => {
  const cases = [
    '0.0.0.0',
    '255.255.255.255',
    '192.0.2.42',
    '10.0.0.1',
    '172.16.0.1',
  ];
  for (const addr of cases) {
    test(addr, () => {
      expect(formatIPv4(parseIPv4(addr))).toBe(addr);
    });
  }
});

// ─── parseIPv6 / formatIPv6 round-trip ───────────────────────────────────────

describe('parseIPv6 / formatIPv6 round-trip', () => {
  // Pairs of [input, canonical output per RFC 5952]
  const cases: [string, string][] = [
    ['::', '::'],
    ['::1', '::1'],
    ['::ffff', '::ffff'],
    ['ffff::', 'ffff::'],
    ['2001:db8::42', '2001:db8::42'],
    ['2001:db8::1', '2001:db8::1'],
    ['fe80::1', 'fe80::1'],
    // Input with leading zeros; output is canonical
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['::ffff:192.0.2.1', '::ffff:192.0.2.1'],
  ];
  for (const [input, canonical] of cases) {
    test(`${input} → "${canonical}"`, () => {
      expect(formatIPv6(parseIPv6(input))).toBe(canonical);
    });
  }
});
