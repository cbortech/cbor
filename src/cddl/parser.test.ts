import { describe, expect, test } from 'vitest';
import { parseCDDL, CddlSyntaxError } from './index';
import type { CddlEntryValue, CddlRule } from './index';

/** Parse a single rule and return it. */
const rule1 = (text: string): CddlRule => {
  const { rules } = parseCDDL(text);
  expect(rules).toHaveLength(1);
  return rules[0]!;
};

/** The body of a rule as a plain (no occur/memberkey) type entry. */
const bodyType = (text: string) => {
  const body = rule1(text).body;
  expect(body.kind).toBe('entry');
  const entry = body as CddlEntryValue;
  expect(entry.occur).toBeUndefined();
  expect(entry.memberKey).toBeUndefined();
  return entry.value;
};

/** The single type1 of a single-alternative type. */
const type1Of = (text: string) => {
  const type = bodyType(text);
  expect(type.alternatives).toHaveLength(1);
  return type.alternatives[0]!;
};

describe('CDDL parser: rules', () => {
  test('simple type rule with offsets', () => {
    const rule = rule1('age = uint');
    expect(rule).toMatchObject({
      kind: 'rule',
      name: 'age',
      assign: '=',
      start: 0,
      end: 10,
    });
    expect(type1Of('age = uint').target).toMatchObject({
      kind: 'ref',
      name: 'uint',
      start: 6,
      end: 10,
    });
  });

  test('empty input parses to zero rules (RFC 9682 §3.1)', () => {
    expect(parseCDDL('').rules).toEqual([]);
    expect(parseCDDL('; only a comment\n').rules).toEqual([]);
  });

  test('multiple rules, /= and //= extensions', () => {
    const { rules } = parseCDDL('a = int\n$sock /= tstr\n$$gsock //= (k: 1)\n');
    expect(rules.map((r) => [r.name, r.assign])).toEqual([
      ['a', '='],
      ['$sock', '/='],
      ['$$gsock', '//='],
    ]);
  });

  test('generic parameters', () => {
    const rule = rule1('message<t, v> = {type: t, value: v}');
    expect(rule.generics).toEqual(['t', 'v']);
  });

  test('generic arguments', () => {
    const t1 = type1Of('x = message<"reboot", "now">');
    expect(t1.target).toMatchObject({ kind: 'ref', name: 'message' });
    const ref = t1.target as { genericArgs?: unknown[] };
    expect(ref.genericArgs).toHaveLength(2);
  });

  test('rule body may be a bare group entry with a member key', () => {
    const body = rule1('g = a: 1').body as CddlEntryValue;
    expect(body.memberKey).toMatchObject({ kind: 'bareword', key: 'a' });
  });

  test('/= is assignt: its right-hand side must be a plain type', () => {
    // Group syntax on the right of /= is invalid (RFC 9682 Appendix A:
    // assignt takes a type; only //= takes a grpent).
    expect(() => parseCDDL('x /= a: uint')).toThrow(CddlSyntaxError);
    expect(() => parseCDDL('x /= (a: 1)')).toThrow(CddlSyntaxError);
    expect(() => parseCDDL('x /= 2*3 int')).toThrow(CddlSyntaxError);
    // //= (assigng) takes a grpent, so the same bodies are fine there.
    const { rules } = parseCDDL('x //= a: uint');
    expect((rules[0]!.body as CddlEntryValue).memberKey).toMatchObject({
      kind: 'bareword',
      key: 'a',
    });
  });
});

describe('CDDL parser: types', () => {
  test('type choices with /', () => {
    const type = bodyType('t = int / tstr / #6.32(tstr)');
    expect(type.alternatives).toHaveLength(3);
  });

  test('inclusive and exclusive ranges', () => {
    expect(type1Of('t = 0..10').op).toEqual({ kind: 'range', inclusive: true });
    expect(type1Of('t = 0...10').op).toEqual({
      kind: 'range',
      inclusive: false,
    });
    expect(type1Of('t = 1.5..2.5').target).toMatchObject({
      kind: 'value',
      type: 'float',
      value: 1.5,
    });
  });

  test('control operators are parsed generically', () => {
    const t1 = type1Of('t = tstr .size 5');
    expect(t1.op).toEqual({ kind: 'ctl', name: 'size' });
    expect(t1.controller).toMatchObject({ kind: 'value', value: 5 });
  });

  test('values: bigint above the safe range, hexfloat, bytes', () => {
    expect(type1Of('t = 18446744073709551615').target).toMatchObject({
      type: 'int',
      value: 18446744073709551615n,
    });
    expect(type1Of('t = 0x1.8p+1').target).toMatchObject({
      type: 'float',
      value: 3,
    });
    expect(type1Of("t = h'BEEF'").target).toMatchObject({
      type: 'bytes',
      qualifier: 'h',
      value: new Uint8Array([0xbe, 0xef]),
    });
  });

  test('unwrap and enum', () => {
    expect(type1Of('t = ~header').target).toMatchObject({
      kind: 'unwrap',
      ref: { name: 'header' },
    });
    expect(type1Of('t = &(a: 1, b: 2)').target).toMatchObject({
      kind: 'enum',
      group: { kind: 'group' },
    });
    expect(type1Of('t = &colors').target).toMatchObject({
      kind: 'enum',
      group: { kind: 'ref', name: 'colors' },
    });
  });

  test('# forms', () => {
    expect(type1Of('t = #').target).toMatchObject({ kind: 'any' });
    expect(type1Of('t = #0.3').target).toMatchObject({
      kind: 'major',
      major: 0,
      ai: 3n,
    });
    expect(type1Of('t = #7.25').target).toMatchObject({
      kind: 'major',
      major: 7,
      ai: 25n,
    });
    expect(type1Of('t = #6.32(tstr)').target).toMatchObject({
      kind: 'tagged',
      tag: 32n,
    });
    expect(type1Of('t = #6(any)').target).toMatchObject({ kind: 'tagged' });
  });

  test('RFC 9682 §3.2: <type> head-numbers', () => {
    const tagged = type1Of('t = #6.<ct-tag-number>(content)').target;
    expect(tagged.kind).toBe('tagged');
    expect((tagged as { tag: unknown }).tag).toMatchObject({ kind: 'type' });
    const major = type1Of('t = #7.<25>').target;
    expect(major).toMatchObject({ kind: 'major', major: 7 });
    expect((major as { ai: unknown }).ai).toMatchObject({ kind: 'type' });
  });

  test('#6.<…> requires a parenthesized item type', () => {
    expect(() => parseCDDL('t = #6.<x>')).toThrow(CddlSyntaxError);
  });
});

describe('CDDL parser: groups', () => {
  test('map with bareword, value, and type1 member keys', () => {
    const map = type1Of(
      't = {name: tstr, 1: int, "q": bool, tstr => any, k ^ => int}'
    ).target;
    expect(map.kind).toBe('map');
    const entries = (map as { group: { choices: CddlEntryValue[][] } }).group
      .choices[0]!;
    expect(entries.map((e) => e.memberKey?.kind)).toEqual([
      'bareword',
      'value',
      'value',
      'type1',
      'type1',
    ]);
    expect(entries.map((e) => e.memberKey?.cut)).toEqual([
      true,
      true,
      true,
      false,
      true,
    ]);
  });

  test('commas between entries are optional', () => {
    const a = type1Of('t = [int tstr bool]').target;
    const b = type1Of('t = [int, tstr, bool]').target;
    expect(a.kind).toBe('array');
    expect(
      (a as { group: { choices: unknown[][] } }).group.choices[0]
    ).toHaveLength(3);
    // Same shape modulo offsets.
    expect(JSON.stringify(a) === JSON.stringify(b)).toBe(false);
  });

  test('group choices with //', () => {
    const arr = type1Of('t = [a // b, c // ]').target;
    const choices = (arr as { group: { choices: unknown[][] } }).group.choices;
    expect(choices.map((c) => c.length)).toEqual([1, 2, 0]);
  });

  test('occurrence indicators', () => {
    const entries = (
      type1Of('t = [? a, + b, * c, 2*3 d, 1* e, *4 f]').target as {
        group: { choices: CddlEntryValue[][] };
      }
    ).group.choices[0]!;
    expect(entries.map((e) => e.occur)).toMatchObject([
      { marker: '?' },
      { marker: '+' },
      { marker: '*' },
      { marker: '*', min: 2, max: 3 },
      { marker: '*', min: 1 },
      { marker: '*', max: 4 },
    ]);
  });

  test('occur components must be adjacent: `1 *2 x` is a value then *2', () => {
    const entries = (
      type1Of('t = [1 *2 x]').target as {
        group: { choices: CddlEntryValue[][] };
      }
    ).group.choices[0]!;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.occur).toBeUndefined();
    expect(entries[0]!.value.alternatives[0]!.target).toMatchObject({
      kind: 'value',
      value: 1,
    });
    expect(entries[1]!.occur).toMatchObject({ marker: '*', max: 2 });
  });

  test('`* 5` is zero-or-more of the value 5', () => {
    const entries = (
      type1Of('t = [* 5]').target as { group: { choices: CddlEntryValue[][] } }
    ).group.choices[0]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.occur).toMatchObject({ marker: '*' });
    expect(entries[0]!.occur).not.toHaveProperty('max');
    expect(entries[0]!.value.alternatives[0]!.target).toMatchObject({
      kind: 'value',
      value: 5,
    });
  });

  test('nested parenthesized groups as entries', () => {
    const body = rule1('g = ( a: 1, (b: 2 // c: 3) )').body;
    expect(body.kind).toBe('entry-group');
  });

  test('a parenthesized expression followed by an operator is a type', () => {
    const t1 = type1Of('t = ("a" / "b") .size 1');
    expect(t1.target.kind).toBe('paren');
    expect(t1.op).toEqual({ kind: 'ctl', name: 'size' });
  });

  test('a trailing comma is recorded and marks the expression as a group', () => {
    const body = rule1('a = (int,)').body;
    expect(body.kind).toBe('entry-group');
    expect(
      (body as { group: { trailingComma?: boolean } }).group
    ).toMatchObject({ trailingComma: true });
    // Commas between entries stay cosmetic — no flag without a final comma.
    const noComma = rule1('a = (int, tstr)').body;
    expect(
      (noComma as { group: { trailingComma?: boolean } }).group.trailingComma
    ).toBeUndefined();
    // `("a",)` is a group, so it cannot take a type operator.
    expect(() => parseCDDL('t = ("a",) .size 1')).toThrow(CddlSyntaxError);
  });

  test('group syntax inside an operator-adjacent paren is rejected', () => {
    expect(() => parseCDDL('t = (a: 1) .size 2')).toThrow(CddlSyntaxError);
  });

  test('member value types may contain choices', () => {
    const entries = (
      type1Of('t = {a: int / tstr}').target as {
        group: { choices: CddlEntryValue[][] };
      }
    ).group.choices[0]!;
    expect(entries[0]!.value.alternatives).toHaveLength(2);
  });
});

describe('CDDL parser: RFC 8610 examples', () => {
  test('§2.1 person/address example parses', () => {
    const text = `
person = {
  identity,               ; an identity
  employer: tstr,         ; some employer
}

identity = (
  name: tstr,
  address: tstr,
)
`;
    const { rules } = parseCDDL(text);
    expect(rules.map((r) => r.name)).toEqual(['person', 'identity']);
  });

  test('§3.1 comment example parses', () => {
    const text = `
; This is a comment
person = { g }

g = (
  "name": tstr,
  age: int,  ; "age" is a bareword
)
`;
    const { rules, comments } = parseCDDL(text);
    expect(rules.map((r) => r.name)).toEqual(['person', 'g']);
    expect(comments).toHaveLength(2);
  });

  test('RFC 9682 §3.2 tag-range example parses', () => {
    const text = `
ct-tag<content> = #6.<ct-tag-number>(content)
ct-tag-number = 1668546817..1668612095
`;
    const { rules } = parseCDDL(text);
    expect(rules[0]!.generics).toEqual(['content']);
  });

  test('errors carry positions', () => {
    try {
      parseCDDL('a = {b: }');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CddlSyntaxError);
      const err = e as CddlSyntaxError;
      expect(err.offset).toBe(8);
      expect(err.line).toBe(1);
      expect(err.column).toBe(9);
    }
  });
});
