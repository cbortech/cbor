import { describe, test, expect } from 'vitest';
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

// ─── Leaf nodes ───────────────────────────────────────────────────────────────

describe('toHexDump — leaf nodes', () => {
  // Single-line output: "{hex}  -- {comment}" (2 spaces, padded to maxPrefixLen+2)

  test('uint 1', () => {
    expect(new CborUint(1n).toHexDump()).toBe('01  -- 1');
  });

  test('uint 255', () => {
    expect(new CborUint(255n).toHexDump()).toBe('18 FF  -- 255');
  });

  test('nint -1', () => {
    expect(new CborNint(-1n).toHexDump()).toBe('20  -- -1');
  });

  test('text string', () => {
    expect(new CborTextString('hi').toHexDump()).toBe('62 68 69  -- "hi"');
  });

  test('empty byte string', () => {
    expect(new CborByteString(new Uint8Array()).toHexDump()).toBe("40  -- ''");
  });

  test('byte string h"0102"', () => {
    expect(new CborByteString(new Uint8Array([0x01, 0x02])).toHexDump()).toBe(
      "42 01 02  -- h'0102'"
    );
  });

  test('true', () => {
    expect(CborSimple.TRUE.toHexDump()).toBe('F5  -- true');
  });

  test('false', () => {
    expect(CborSimple.FALSE.toHexDump()).toBe('F4  -- false');
  });

  test('null', () => {
    expect(CborSimple.NULL.toHexDump()).toBe('F6  -- null');
  });

  test('float 1.5 (half precision)', () => {
    const f = new CborFloat(1.5, { precision: 'half' });
    expect(f.toHexDump()).toBe('F9 3E 00  -- 1.5');
  });
});

// ─── Array ────────────────────────────────────────────────────────────────────

describe('toHexDump — CborArray', () => {
  test('definite [1, 2]', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)]);
    const lines = node.toHexDump().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^82\s+-- Array of length 2$/);
    expect(lines[1]).toMatch(/^\s+01\s+-- 1$/);
    expect(lines[2]).toMatch(/^\s+02\s+-- 2$/);
  });

  test('empty array []', () => {
    const node = new CborArray([]);
    expect(node.toHexDump()).toMatch(/^80\s+-- Array of length 0$/);
  });

  test('indefinite [_ 1, 2]', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)], {
      indefiniteLength: true,
    });
    const lines = node.toHexDump().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^9F\s+-- Start indefinite-length array$/);
    expect(lines[3]).toMatch(/^FF\s+-- "break"$/);
  });

  test('nested array [1, [2, 3]]', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborArray([new CborUint(2n), new CborUint(3n)]),
    ]);
    const lines = node.toHexDump().split('\n');
    // outer array header + 1 + inner array header + 2 + 3 = 5 lines
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^82\s+-- Array of length 2$/);
  });
});

// ─── Map ──────────────────────────────────────────────────────────────────────

describe('toHexDump — CborMap', () => {
  test('definite {1: 2}', () => {
    const node = new CborMap([[new CborUint(1n), new CborUint(2n)]]);
    const lines = node.toHexDump().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^A1\s+-- Map of length 1$/);
    expect(lines[1]).toMatch(/^\s+01\s+-- 1$/);
    expect(lines[2]).toMatch(/^\s+02\s+-- 2$/);
  });

  test('empty map {}', () => {
    const node = new CborMap([]);
    expect(node.toHexDump()).toMatch(/^A0\s+-- Map of length 0$/);
  });

  test('indefinite {_ "a": 1}', () => {
    const node = new CborMap([[new CborTextString('a'), new CborUint(1n)]], {
      indefiniteLength: true,
    });
    const lines = node.toHexDump().split('\n');
    expect(lines[0]).toMatch(/^BF\s+-- Start indefinite-length map$/);
    expect(lines[lines.length - 1]).toMatch(/^FF\s+-- "break"$/);
  });
});

// ─── Tag ──────────────────────────────────────────────────────────────────────

describe('toHexDump — CborTag', () => {
  test('1(42)', () => {
    const node = new CborTag(1n, new CborUint(42n));
    const lines = node.toHexDump().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^C1\s+-- Tag 1/);
    expect(lines[1]).toMatch(/^\s+18 2A\s+-- 42$/);
  });
});

// ─── Indefinite byte/text strings ────────────────────────────────────────────

describe('toHexDump — indefinite byte string', () => {
  test("(_ h'01', h'02')", () => {
    const node = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([0x01])),
      new CborByteString(new Uint8Array([0x02])),
    ]);
    const lines = node.toHexDump().split('\n');
    expect(lines[0]).toMatch(/^5F\s+-- Start indefinite-length byte string$/);
    expect(lines[lines.length - 1]).toMatch(/^FF\s+-- "break"$/);
    expect(lines).toHaveLength(4); // open + 2 chunks + break
  });
});

describe('toHexDump — indefinite text string', () => {
  test('(_ "foo", "bar")', () => {
    const node = new CborIndefiniteTextString([
      new CborTextString('foo'),
      new CborTextString('bar'),
    ]);
    const lines = node.toHexDump().split('\n');
    expect(lines[0]).toMatch(/^7F\s+-- Start indefinite-length text string$/);
    expect(lines[lines.length - 1]).toMatch(/^FF\s+-- "break"$/);
  });
});

// ─── indent option ────────────────────────────────────────────────────────────

describe('toHexDump — indent option', () => {
  test('default indent=3 produces 3-space child indent', () => {
    const node = new CborArray([new CborUint(1n)]);
    const lines = node.toHexDump().split('\n');
    // child line starts with 3 spaces
    expect(lines[1]).toMatch(/^ {3}/);
  });

  test('indent=2 produces 2-space child indent', () => {
    const node = new CborArray([new CborUint(1n)]);
    const lines = node.toHexDump({ indent: 2 }).split('\n');
    expect(lines[1]).toMatch(/^ {2}/);
    expect(lines[1]).not.toMatch(/^ {3}/);
  });

  test('indent=1 produces 1-space child indent', () => {
    const node = new CborArray([new CborUint(1n)]);
    const lines = node.toHexDump({ indent: 1 }).split('\n');
    expect(lines[1]).toMatch(/^ \S/);
  });
});
