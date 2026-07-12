import { describe, expect, test } from 'vitest';
import { CDDL, parseCDDL } from './index';

/** Deep-copy an AST value with `start`/`end` offsets removed. */
const stripPositions = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'start' || k === 'end') continue;
      out[k] = stripPositions(v);
    }
    return out;
  }
  return value;
};

/** parse → format → parse must reproduce the same AST (modulo offsets). */
const roundtrips = (text: string): string => {
  const first = parseCDDL(text).rules;
  const formatted = CDDL.compile(text, { strict: false }).format();
  const second = parseCDDL(formatted).rules;
  expect(stripPositions(second)).toEqual(stripPositions(first));
  return formatted;
};

describe('CDDL formatter', () => {
  test('normalizes spacing', () => {
    expect(roundtrips('a=int\nb   =   { x :  tstr }')).toBe(
      'a = int\nb = {x: tstr}\n'
    );
  });

  test('keeps literal values verbatim (bases, escapes, qualifiers)', () => {
    const formatted = roundtrips(
      `t = 0x1F / 0b101 / -5 / 1.5e-3 / 0x1.8p+1 / "a\\nb" / h'BEEF' / b64'Zm9v' / 'raw'`
    );
    for (const lit of [
      '0x1F',
      '0b101',
      '-5',
      '1.5e-3',
      '0x1.8p+1',
      '"a\\nb"',
      "h'BEEF'",
      "b64'Zm9v'",
      "'raw'",
    ])
      expect(formatted).toContain(lit);
  });

  test('formats the whole construct zoo', () => {
    expect(
      roundtrips(
        `msg<t> = { type: t, ? id: uint, * tstr => any, k ^ => int }
choice = (int / tstr // 1*2 (a: 1))
arr = [+ item, (b // c)]
item = ~base
base = &(x: 1, y: 2)
tags = #6.<num>(any) / #6.37(bstr) / #7.25 / #0.3 / #
num = 100..200
sized = tstr .size (1...5)
socketed = { $$ext }
`
      )
    ).toBe(`msg<t> = {type: t, ? id: uint, * tstr => any, k ^ => int}
choice = (int / tstr // 1*2 (a: 1))
arr = [+ item, (b // c)]
item = ~base
base = &(x: 1, y: 2)
tags = #6.<num>(any) / #6.37(bstr) / #7.25 / #0.3 / #
num = 100..200
sized = tstr .size (1...5)
socketed = {$$ext}
`);
  });

  test('tag and major-type head-numbers keep their source spelling', () => {
    expect(roundtrips('a = #6.0x10(tstr)\nb = #7.0b11001\nc = #0.0x3')).toBe(
      'a = #6.0x10(tstr)\nb = #7.0b11001\nc = #0.0x3\n'
    );
  });

  test('occurrence forms', () => {
    expect(roundtrips('a = [? x, + y, * z, 2*3 w, 1* v, *4 u]')).toBe(
      'a = [? x, + y, * z, 2*3 w, 1* v, *4 u]\n'
    );
  });

  test('rule-level group entries and extensions', () => {
    expect(roundtrips('g //= (a: 1 // b: 2)\nh /= int')).toBe(
      'g //= (a: 1 // b: 2)\nh /= int\n'
    );
  });

  test('trailing commas survive formatting (they mark groups)', () => {
    expect(
      roundtrips('start = int\ng = (a: 1,)\nm = {x: int,}\narr = [1, 2,]')
    ).toBe('start = int\ng = (a: 1,)\nm = {x: int,}\narr = [1, 2,]\n');
  });

  test('empty containers', () => {
    expect(roundtrips('a = {}\nb = []\nc = ()')).toBe(
      'a = {}\nb = []\nc = ()\n'
    );
  });
});

describe('CDDL formatter: fixed points', () => {
  test('formatting is idempotent', () => {
    const once = CDDL.compile('person = {name: tstr, ? age: uint / nil}\n', {
      strict: false,
    }).format();
    const twice = CDDL.compile(once, { strict: false }).format();
    expect(twice).toBe(once);
  });
});
