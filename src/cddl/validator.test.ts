import { describe, expect, test } from 'vitest';
import { CDDL } from './index';
import { CBOR } from '../index';

/** Compile-and-validate helper for CDN-text instances. */
const check = (cddl: string, instance: string): boolean =>
  CDDL.compile(cddl).validate(instance).valid;

const expectValid = (cddl: string, instances: string[]): void => {
  for (const i of instances) {
    const result = CDDL.compile(cddl).validate(i);
    expect(
      result.valid,
      `${i} should match\n${cddl}\n${result.errors[0]?.message ?? ''}`
    ).toBe(true);
  }
};

const expectInvalid = (cddl: string, instances: string[]): void => {
  for (const i of instances) {
    const result = CDDL.compile(cddl).validate(i);
    expect(result.valid, `${i} should NOT match\n${cddl}`).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  }
};

describe('validate: basic types and values', () => {
  test('prelude types', () => {
    expectValid('t = uint', ['0', '18446744073709551615']);
    expectInvalid('t = uint', ['-1', '1.0', '"x"', '[1]']);
    expectValid('t = tstr', ['""', '"hello"']);
    expectValid('t = bstr', ["h'BEEF'", "''", '<<1>>']);
    expectValid('t = bool', ['true', 'false']);
    expectInvalid('t = bool', ['null', '0']);
    expectValid('t = nil', ['null']);
    expectValid('t = any', ['{"a": [1, 2]}', 'null', "h''"]);
    expectValid('t = bigint', [
      '18446744073709551616',
      '-18446744073709551617',
    ]);
  });

  test('bignums are tagged items for types, numbers for values', () => {
    // #6.2(bstr)/#6.3(bstr) denote *tagged* data items (RFC 8610 §3.6):
    // an untagged integer never matches them.
    expectInvalid('t = biguint', ['1', '0']);
    expectInvalid('t = bignint', ['-1']);
    expectValid('t = biguint', ['18446744073709551616']);
    // Value comparison is numeric, including bignums — the only wire form
    // of 2^64 is its tag-2 representation.
    expectValid('t = 18446744073709551616', ['18446744073709551616']);
    expectInvalid('t = 18446744073709551616', ['18446744073709551617', '1']);
    expectValid('t = 18446744073709551616..18446744073709551620', [
      '18446744073709551616',
      '18446744073709551620',
    ]);
    expectInvalid('t = 18446744073709551616..18446744073709551620', [
      '18446744073709551621',
      '1',
    ]);
    expectValid('t = integer .gt 18446744073709551615', [
      '18446744073709551616',
    ]);
    expectInvalid('t = integer .gt 18446744073709551615', ['1', '-1']);
  });

  test('literal values are type-strict', () => {
    expectValid('t = 1', ['1']);
    expectInvalid('t = 1', ['1.0', '2', '"1"']);
    expectValid('t = 1.5', ['1.5']);
    expectInvalid('t = 1.5', ['1', '2.5']);
    expectValid('t = "ab"', ['"ab"', `(_ "a", "b")`]);
    expectValid("t = h'0102'", ["h'0102'"]);
    expectInvalid("t = h'0102'", ["h'0103'", '"0102"']);
    expectValid('t = -5', ['-5']);
  });

  test('type choices', () => {
    expectValid('t = int / tstr', ['-3', '"x"']);
    expectInvalid('t = int / tstr', ['1.5', "h''"]);
  });

  test('ranges', () => {
    expectValid('t = 1..10', ['1', '5', '10']);
    expectInvalid('t = 1..10', ['0', '11', '5.0', '"5"']);
    expectValid('t = 1...10', ['9']);
    expectInvalid('t = 1...10', ['10']);
    expectValid('t = -2..2', ['-2', '0']);
    expectValid('t = 0.0..1.0', ['0.5', '1.0']);
    expectInvalid('t = 0.0..1.0', ['1', '1.5']);
    // Named endpoints need spacing (min..max would be a single name).
    expectValid('t = lower .. upper\nlower = 1\nupper = 5', ['3']);
    expectInvalid('t = lower .. upper\nlower = 1\nupper = 5', ['6']);
  });
});

describe('validate: arrays', () => {
  test('fixed and optional elements', () => {
    expectValid('t = [int, tstr]', ['[1, "a"]']);
    expectInvalid('t = [int, tstr]', ['[1]', '[1, "a", 2]', '["a", 1]']);
    expectValid('t = [int, ? tstr]', ['[1]', '[1, "a"]']);
  });

  test('occurrence indicators', () => {
    expectValid('t = [* int]', ['[]', '[1, 2, 3]']);
    expectValid('t = [+ int]', ['[1]', '[1, 2]']);
    expectInvalid('t = [+ int]', ['[]', '["a"]']);
    expectValid('t = [1*3 int]', ['[1]', '[1, 2, 3]']);
    expectInvalid('t = [1*3 int]', ['[]', '[1, 2, 3, 4]']);
    expectValid('t = [* int, tstr]', ['["a"]', '[1, 2, "a"]']);
  });

  test('nested groups and group choices', () => {
    expectValid('t = [(int, tstr) // (tstr, int)]', ['[1, "a"]', '["a", 1]']);
    expectInvalid('t = [(int, tstr) // (tstr, int)]', ['[1, 1]']);
    expectValid('t = [* (int, tstr)]', ['[]', '[1, "a", 2, "b"]']);
    expectInvalid('t = [* (int, tstr)]', ['[1, "a", 2]']);
  });

  test('group rules splice into arrays', () => {
    const cddl = `
      t = [g, tstr]
      g = (int, int)
    `;
    expectValid(cddl, ['[1, 2, "a"]']);
    expectInvalid(cddl, ['[1, "a"]']);
  });

  test('unwrap (RFC 8610 §3.7)', () => {
    const cddl = `
      advanced-header = [~basic-header, field3: bstr]
      basic-header = [field1: int, field2: tstr]
    `;
    expectValid(cddl, [`[1, "a", h'00']`]);
    expectInvalid(cddl, [`[1, "a"]`, `[1, h'00']`]);
  });

  test('unwrapping a tag rule exposes the content type (§3.7)', () => {
    const cddl = 't = ~wrapped\nwrapped = #6.100(int)';
    expectValid(cddl, ['5', '-3']);
    expectInvalid(cddl, ['"x"', '100(5)']);
    // The canonical example: ~uri is the tstr inside tag 32.
    expectValid('t = ~uri', ['"http://example.com"']);
    expectInvalid('t = ~uri', ['32("http://example.com")']);
  });

  test('member keys in arrays are documentation only', () => {
    expectValid('t = [age: int, name: tstr]', ['[5, "x"]']);
  });
});

describe('validate: maps', () => {
  test('struct with optional members', () => {
    const cddl = 't = { name: tstr, ? age: uint }';
    expectValid(cddl, ['{"name": "kudo"}', '{"name": "kudo", "age": 42}']);
    expectInvalid(cddl, [
      '{}', // missing required
      '{"name": 1}', // wrong value type
      '{"name": "kudo", "extra": 1}', // entry not in the group
      '["name", "kudo"]', // not a map
    ]);
  });

  test('non-text keys', () => {
    const cddl = 't = { 1: tstr, ? -1: int }';
    expectValid(cddl, ['{1: "a"}', '{1: "a", -1: 5}']);
    expectInvalid(cddl, ['{2: "a"}', '{1: "a", -1: "b"}']);
  });

  test('tables with type1 member keys', () => {
    expectValid('t = { * tstr => int }', ['{}', '{"a": 1, "b": 2}']);
    expectInvalid('t = { * tstr => int }', ['{"a": "b"}', '{1: 1}']);
  });

  test('cut semantics (§3.5.4)', () => {
    // ':' implies a cut: once the key matches, the value must match,
    // even though the wildcard member would otherwise accept the entry.
    const withCut = 't = { ? "opt": int, * tstr => tstr }';
    expectInvalid(withCut, ['{"opt": "hi"}']);
    expectValid(withCut, ['{"opt": 1, "x": "y"}', '{"x": "y"}']);
    // '=>' without '^' has no cut: the entry can fall through.
    const noCut = 't = { ? "opt" => int, * tstr => tstr }';
    expectValid(noCut, ['{"opt": "hi"}']);
    // '^ =>' is an explicit cut.
    const explicit = 't = { ? "opt" ^ => int, * tstr => tstr }';
    expectInvalid(explicit, ['{"opt": "hi"}']);
  });

  test('group choices and nested groups in maps', () => {
    const cddl = 't = { (a: int // b: tstr), c: bool }';
    expectValid(cddl, ['{"a": 1, "c": true}', '{"b": "x", "c": false}']);
    expectInvalid(cddl, ['{"c": true}', '{"a": 1, "b": "x", "c": true}']);
  });

  test('map group rules and //= extensions', () => {
    const cddl = `
      t = { base }
      base = (kind: tstr)
      base //= (kind: tstr, extra: int)
    `;
    expectValid(cddl, ['{"kind": "a"}', '{"kind": "a", "extra": 1}']);
    expectInvalid(cddl, ['{"extra": 1}']);
  });
});

describe('validate: tags, majors, enums, sockets, generics', () => {
  test('tagged types', () => {
    expectValid('t = #6.32(tstr)', ['32("http://example.com")']);
    expectInvalid('t = #6.32(tstr)', ['33("x")', '32(1)', '"x"']);
    expectValid('t = #6(any)', ['0("2026-07-12T00:00:00Z")']);
    expectValid('t = tdate', ['0("2026-07-12T00:00:00Z")']);
    expectValid('t = #6.<tag-nr>(int)\ntag-nr = 100..200', ['150(5)']);
    expectInvalid('t = #6.<tag-nr>(int)\ntag-nr = 100..200', [
      '99(5)',
      '150("x")',
    ]);
  });

  test('major types', () => {
    expectValid('t = #', ['1', '"x"', '{1: 2}']);
    expectValid('t = #0', ['7']);
    expectInvalid('t = #0', ['-1', '1.5']);
    expectValid('t = #7.25', ["float'3C00'"]); // half-precision 1.0
    expectValid('t = float16', ["float'3C00'"]);
    expectInvalid('t = float16', ['1']);
    // A float without a recorded width is judged by the smallest width
    // that represents it losslessly (its preferred serialization).
    expectValid('t = #7.25', ['1.0', '1.5']);
    expectInvalid('t = #7.25', ['1.6']); // needs double precision
  });

  test('enums', () => {
    const cddl = 't = &( fin: 8, syn: 9 )';
    expectValid(cddl, ['8', '9']);
    expectInvalid(cddl, ['10', '"fin"']);
    expectValid('t = &colors\ncolors = (red: 0, green: 1)', ['0', '1']);
  });

  test('sockets', () => {
    // A type socket with no plugs matches nothing.
    expectInvalid('t = $val', ['1', 'null']);
    expectValid('t = $val\n$val /= int\n$val /= tstr', ['1', '"a"']);
    // A group socket is a choice of its plugs: with no plugs it matches
    // nothing, and bare use is required-once — hence the `* $$name` idiom
    // (behavior confirmed against the classic cddl gem).
    expectInvalid('t = { a: int, $$ext }', ['{"a": 1}']);
    expectValid('t = { a: int, * $$ext }', ['{"a": 1}']);
    expectInvalid('t = { a: int, $$ext }\n$$ext //= (b: tstr)', ['{"a": 1}']);
    expectValid('t = { a: int, * $$ext }\n$$ext //= (b: tstr)', [
      '{"a": 1}',
      '{"a": 1, "b": "x"}',
    ]);
  });

  test('generics', () => {
    const cddl = `
      t = message<"reboot", "now">
      message<t, v> = {type: t, value: v}
    `;
    expectValid(cddl, ['{"type": "reboot", "value": "now"}']);
    expectInvalid(cddl, ['{"type": "reboot", "value": "later"}']);
  });

  test('generic parameters bind per definition (extensions may rename)', () => {
    const cddl = 't = g<int>\ng<A> = A\ng<B> /= [B]';
    expectValid(cddl, ['1', '[1]']);
    expectInvalid(cddl, ['"x"', '["x"]']);
    const groups = 't = { g<int> }\ng<A> = (a: A)\ng<B> //= (b: [B])';
    expectValid(groups, ['{"a": 1}', '{"b": [1]}']);
    expectInvalid(groups, ['{"a": "x"}', '{"b": ["x"]}']);
  });
});

describe('validate: control operators', () => {
  test('.size', () => {
    expectValid('t = bstr .size 4', ["h'C0A80101'"]);
    expectInvalid('t = bstr .size 4', ["h'C0A801'"]);
    expectValid('t = tstr .size (1..3)', ['"a"', '"abc"']);
    expectInvalid('t = tstr .size (1..3)', ['""', '"abcd"']);
    expectValid('t = uint .size 2', ['0', '65535']);
    expectInvalid('t = uint .size 2', ['65536']);
    // .size N means 0 ≤ value < 256^N with no upper limit on N.
    expectValid('t = uint .size 20', ['1']);
    expectValid('t = uint .size 100', ['0', '18446744073709551615']);
  });

  test('.size with non-literal controllers intersects [minBytes, ∞)', () => {
    expectValid('t = uint .size (100..200)', ['1', '0']);
    expectValid('t = uint .size large\nlarge = 100..200', ['1']);
    expectValid('t = uint .size (int .ge 100)', ['1']);
    expectValid('t = uint .size (int .eq 1000)', ['1']);
    expectValid('t = uint .size (int .gt 1000)', ['1']);
    expectValid('t = uint .size (int .lt 100)', ['1']);
    expectInvalid('t = uint .size (int .le 0)', ['1']);
    expectValid('t = uint .size (int .ne 1)', ['1']);
    expectValid('t = uint .size ((100..200) .and int)', ['1']);
    expectValid('t = uint .size ((100..200) .within int)', ['1']);
    expectValid('t = uint .size (999 .plus 1)', ['1']);
    expectValid('t = uint .size (999 .plus 1.5)', ['1']);
    const featured = CDDL.compile('t = uint .size (1000 .feature "large")');
    expect(featured.validate('1', { features: ['large'] }).valid).toBe(true);
    expect(featured.validate('1').valid).toBe(false);
    const featuredWithDetail = CDDL.compile(
      't = uint .size (1000 .feature ["large", "detail"])'
    );
    expect(
      featuredWithDetail.validate('1', { features: ['large'] }).valid
    ).toBe(true);
    expectValid('t = uint .size (1024 .bits 10)', ['1']);
    expectValid('t = uint .size (uint .bits 10)', ['1']);
    expectValid('t = uint .size (1000 .size 2)', ['1']);
    expectValid('t = uint .size (uint .size 2)', ['1']);
    expectInvalid('t = uint .size (0..1)', ['65536']); // needs 3 bytes
    expectValid('t = uint .size (1 / 100)', ['65536']); // 100 ≥ 3
    expectValid('t = uint .size sizes\nsizes = &(a: 0, b: 8)', ['1', '0']);
    expectInvalid('t = uint .size sizes\nsizes = &(a: 0, b: 2)', [
      '4294967296',
    ]);
  });

  test('.bits (RFC 8610 §3.8.2 example)', () => {
    const cddl = 't = uint .bits rwx\nrwx = &(r: 2, w: 1, x: 0)';
    expectValid(cddl, ['0', '5', '7']);
    expectInvalid(cddl, ['8', '9']);
    const flags = `
      tcpflagbytes = bstr .bits flags
      flags = &(fin: 8, syn: 9, rst: 10, psh: 11, ack: 12, urg: 13, ece: 14, cwr: 15, ns: 0) / (4..7)
    `;
    expectValid(flags, ["h'906d'", "h'01fc'", "h''"]);
    expectInvalid(flags, ["h'02'"]); // bit 1 is not among the allowed bits
  });

  test('.regexp (RFC 8610 §3.8.3 example)', () => {
    const cddl = String.raw`nai = tstr .regexp "[A-Za-z0-9]+@[A-Za-z0-9]+(\\.[A-Za-z0-9]+)+"`;
    expectValid(cddl, ['"N1@CH57HF.4Znqe0.dYJRN.igjf"']);
    expectInvalid(cddl, ['"@@"', '"no-at-sign"']);
  });

  test('.cbor / .cborseq', () => {
    expectValid('t = bstr .cbor int', ['<<5>>', "h'05'"]);
    expectInvalid('t = bstr .cbor int', ['<<"x">>', "h'FF'"]);
    expectValid('t = bstr .cborseq [int, tstr]', ['<<1, "a">>']);
    expectInvalid('t = bstr .cborseq [int, tstr]', ['<<1>>']);
  });

  test('.within / .and', () => {
    expectValid('t = (0..10) .and int', ['5']);
    expectInvalid('t = (0..10) .and int', ['11']);
    expectValid('t = uint .within (0..100)', ['50']);
    expectInvalid('t = uint .within (0..100)', ['101']);
  });

  test('.lt .le .gt .ge .eq .ne .default', () => {
    expectValid('t = uint .lt 10', ['9']);
    expectInvalid('t = uint .lt 10', ['10']);
    expectValid('t = uint .ge 10', ['10']);
    expectValid('t = int .eq 5', ['5']);
    expectInvalid('t = int .eq 5', ['6']);
    expectValid('t = tstr .ne "x"', ['"y"']);
    expectInvalid('t = tstr .ne "x"', ['"x"']);
    // .default implies .ne: the default value is not sent over the wire
    // (RFC 8610 §3.8.6).
    expectValid('t = uint .default 7', ['0', '8']);
    expectInvalid('t = uint .default 7', ['7']);
  });

  test('.plus with generics (RFC 9165 §2.1)', () => {
    const cddl = `
      t = { interval<10> }
      interval<BASE> = ( BASE => int, (BASE .plus 1) => int )
    `;
    expectValid(cddl, ['{10: 1, 11: 2}']);
    expectInvalid(cddl, ['{10: 1, 12: 2}']);
  });

  test('.plus stays exact beyond 2^53 with a float controller', () => {
    // floor(int + x) = int + floor(x): the big integer part must not be
    // routed through double precision.
    const cddl = 't = 9007199254740993 .plus 1.0';
    expectValid(cddl, ['9007199254740994']);
    expectInvalid(cddl, ['9007199254740992', '9007199254740993']);
    expectValid('t = 9007199254740993 .plus 1', ['9007199254740994']);
    expectValid('t = 9007199254740993 .plus 1.5', ['9007199254740994']);
    expectValid('t = 9007199254740993 .plus -1.5', ['9007199254740991']);
  });

  test('.cat (RFC 9165 §2.2)', () => {
    expectValid('t = "foo" .cat "bar"', ['"foobar"']);
    expectInvalid('t = "foo" .cat "bar"', ['"foo"', '"barfoo"']);
    expectValid("t = h'01' .cat h'02'", ["h'0102'"]);
  });

  test('.feature (RFC 9165 §5)', () => {
    const schema = CDDL.compile('t = uint .feature "beta"');
    expect(schema.validate('1').valid).toBe(false);
    expect(schema.validate('1').warnings?.[0]?.message).toContain('beta');
    expect(schema.validate('1', { features: ['beta'] }).valid).toBe(true);
  });

  test('.feature accepts parenthesized array controllers', () => {
    // RFC 9165 §5: the controller may be [name, detail] — and either form
    // may be parenthesized.
    for (const cddl of [
      't = uint .feature (["x", "detail"])',
      't = uint .feature ["x", "detail"]',
      't = uint .feature ("x")',
    ]) {
      const schema = CDDL.compile(cddl);
      expect(schema.validate('1', { features: ['x'] }).valid, cddl).toBe(true);
      expect(schema.validate('1').valid, cddl).toBe(false);
      expect(schema.validate('1').errors[0]?.message, cddl).not.toContain(
        'unresolvable'
      );
    }
  });

  test('unsupported operators warn and match the target only', () => {
    const schema = CDDL.compile('t = tstr .abnf "rule = %x61"');
    const result = schema.validate('"anything"');
    expect(result.valid).toBe(true);
    expect(result.warnings?.[0]?.message).toContain('.abnf');
  });
});

describe('validate: inputs and elision', () => {
  test('accepts CborItem, CBOR bytes, and CDN text', () => {
    const schema = CDDL.compile('t = [1, tstr]');
    const item = CBOR.fromCDN('[1, "a"]');
    expect(schema.validate(item).valid).toBe(true);
    expect(schema.validate(item.toCBOR()).valid).toBe(true);
    expect(schema.validate('[1, "a"]').valid).toBe(true);
    expect(schema.validate(CBOR.fromJS([1, 'a']).toCBOR()).valid).toBe(true);
  });

  test('a CDN elision matches any single item or entry', () => {
    expect(check('t = [int, tstr]', '[1, ...]')).toBe(true);
    expect(check('t = [int, tstr]', '[...]')).toBe(false); // still 2 items
    expect(check('t = {a: int, b: tstr}', '{"a": 1, ...:...}')).toBe(true);
    expect(check('t = {a: int}', '{"a": 1, ...:...}')).toBe(true); // leftover elided
  });
});

describe('validate: rule option', () => {
  const schema = CDDL.compile(`
    p1 = { name: tstr, ? addr: tstr }
    p2 = { name: tstr, ? age: uint }
  `);

  test('defaults to the root (first) rule', () => {
    expect(schema.validate('{"name": "kudo", "addr": "home"}').valid).toBe(
      true
    );
    expect(schema.validate('{"name": "kudo", "age": 42}').valid).toBe(false);
  });

  test('{ rule } selects a different named rule', () => {
    const result = schema.validate('{"name": "kudo", "age": 42}', {
      rule: 'p2',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('a mismatch against the selected rule is reported normally', () => {
    const result = schema.validate('{"name": "kudo", "age": "x"}', {
      rule: 'p2',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.path).toBe('/age');
    expect(result.errors[0]!.ruleName).toBe('p2');
  });

  test('an unknown rule name fails validation instead of throwing', () => {
    const result = schema.validate('{"name": "kudo"}', { rule: 'missing' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toBe("'missing' is not defined");
  });

  test('a prelude name can be selected too', () => {
    expect(schema.validate('42', { rule: 'uint' }).valid).toBe(true);
    expect(schema.validate('"x"', { rule: 'uint' }).valid).toBe(false);
  });

  test('an empty string is treated as a (missing) rule name, not "no root"', () => {
    const result = schema.validate('{"name": "kudo"}', { rule: '' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toBe("'' is not defined");
  });

  test('a group-only rule cannot be selected directly', () => {
    const withGroup = CDDL.compile('t = { g }\ng = ( a: int, b: tstr )');
    const result = withGroup.validate('{"a": 1, "b": "x"}', { rule: 'g' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toBe(
      "group rule 'g' cannot be used as a type"
    );
  });

  test('a generic rule cannot be selected directly', () => {
    const generic = CDDL.compile('t = int\ng<A> = A');

    const result = generic.validate('1', { rule: 'g' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain("rule 'g' takes 1 generic");

    // A generic parameter that goes unused would otherwise validate
    // "successfully" without ever checking anything meaningful.
    const unused = CDDL.compile('t = int\ng<A> = int');
    expect(unused.validate('1', { rule: 'g' }).valid).toBe(false);
  });
});

describe('validate: error reporting', () => {
  test('reports path, instance offsets, and schema offsets', () => {
    const cddl = 'person = { name: tstr, ? age: uint }';
    const instance = '{"name": "kudo", "age": "x"}';
    const result = CDDL.compile(cddl).validate(instance);
    expect(result.valid).toBe(false);
    const err = result.errors[0]!;
    expect(err.path).toBe('/age');
    expect(err.ruleName).toBe('person');
    // Instance offsets point at the offending "x".
    expect(instance.slice(err.start!, err.end!)).toBe('"x"');
    // Schema offsets point into the CDDL source.
    expect(cddl.slice(err.schemaStart!, err.schemaEnd!)).toContain('uint');
  });

  test('CBOR input yields byte offsets', () => {
    const schema = CDDL.compile('t = [uint, tstr]');
    const bytes = CBOR.fromCDN('[1, 2]').toCBOR(); // 0x82 0x01 0x02
    const result = schema.validate(bytes);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.path).toBe('/1');
    expect(result.errors[0]!.start).toBe(2);
  });

  test('deepest failure wins over backtracked ones', () => {
    const result = CDDL.compile('t = { a: [int, int] }').validate(
      '{"a": [1, "x"]}'
    );
    expect(result.errors[0]!.path).toBe('/a/1');
  });

  test('at equal depth, the failure furthest into the instance wins', () => {
    // Matching -7 against `label` records a uint sub-failure before the
    // nint branch succeeds; the real error (42 is not a bstr) is later in
    // the instance and must win the report.
    const cddl = 't = [label, bstr]\nlabel = int / tstr';
    const instance = '[-7, 42]';
    const result = CDDL.compile(cddl).validate(instance);
    expect(result.errors[0]!.path).toBe('/1');
    expect(
      instance.slice(result.errors[0]!.start!, result.errors[0]!.end!)
    ).toBe('42');
  });

  test('errors inside prelude rules anchor to the referencing schema node', () => {
    const cddl = 't = [uint]';
    const result = CDDL.compile(cddl).validate('[-1]');
    const err = result.errors[0]!;
    expect(cddl.slice(err.schemaStart!, err.schemaEnd!)).toBe('uint');
  });

  test('.cbor content errors point at the carrying byte string', () => {
    // Offsets of items decoded out of an embedded byte string are relative
    // to the embedded bytes and are suppressed; the report anchors to the
    // byte string in the outer document instead.
    const instance = '<<["x"]>>';
    const result = CDDL.compile('t = bstr .cbor [int]').validate(instance);
    expect(result.valid).toBe(false);
    const err = result.errors[0]!;
    expect(err.message).toContain('embedded CBOR');
    expect(instance.slice(err.start!, err.end!)).toBe(instance);
  });

  test('step budget aborts pathological backtracking', () => {
    const schema = CDDL.compile('t = [* ((int) // (int, int))]');
    const good = schema.validate('[1, 2, 3, 4]');
    expect(good.valid).toBe(true);
    const result = schema.validate('[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, "x"]', {
      maxSteps: 50,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('step budget');
  });

  test('recursive schemas validate and terminate', () => {
    const cddl = 'tree = [* tree] / int';
    expect(check(cddl, '[[1, [2]], 3]')).toBe(true);
    expect(check(cddl, '[[1, ["x"]]]')).toBe(false);
  });
});
