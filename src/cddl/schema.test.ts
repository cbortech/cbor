import { describe, expect, test } from 'vitest';
import {
  CDDL,
  CddlSemanticError,
  CddlSyntaxError,
  getPreludeRules,
  PRELUDE_CDDL,
} from './index';

describe('CDDL.compile', () => {
  test('compiles a model and exposes root and rules', () => {
    const schema = CDDL.compile(
      'person = { name: tstr, ? age: uint }\nname-list = [* tstr]\n'
    );
    expect(schema.root?.name).toBe('person');
    expect([...schema.rules.keys()]).toEqual(['person', 'name-list']);
    expect(schema.warnings).toBeUndefined();
  });

  test('grammar errors throw CddlSyntaxError', () => {
    expect(() => CDDL.compile('a = = int')).toThrow(CddlSyntaxError);
  });

  test('prelude names resolve without user definitions', () => {
    const schema = CDDL.compile(
      't = [uint, nint, bstr, tdate, biguint, float16-32, null]'
    );
    expect(schema.warnings).toBeUndefined();
  });

  test('undefined names throw in strict mode with positions', () => {
    try {
      CDDL.compile('a = missing-name');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CddlSemanticError);
      const err = e as CddlSemanticError;
      expect(err.warnings).toMatchObject([
        { code: 'undefined-name', start: 4, end: 16 },
      ]);
    }
  });

  test('strict: false collects warnings instead of throwing', () => {
    const schema = CDDL.compile('a = missing-name', { strict: false });
    expect(schema.warnings).toMatchObject([{ code: 'undefined-name' }]);
  });

  test('sockets ($ / $$) may be referenced and extended while undefined', () => {
    const schema = CDDL.compile('a = { x: $values, $$more }\n$values /= int\n');
    expect(schema.warnings).toBeUndefined();
    expect(schema.rules.get('$values')).toHaveLength(1);
  });

  test('duplicate = definitions are reported; /= //= extensions collect', () => {
    expect(() => CDDL.compile('a = int\na = tstr')).toThrow(CddlSemanticError);
    const schema = CDDL.compile('a = int\na /= tstr\na /= bool');
    expect(schema.rules.get('a')).toHaveLength(3);
  });

  test('generic arity is checked', () => {
    expect(() => CDDL.compile('m<t> = { v: t }\nuse = m<int, tstr>')).toThrow(
      CddlSemanticError
    );
    expect(() => CDDL.compile('m<t> = { v: t }\nuse = m')).toThrow(
      CddlSemanticError
    );
    const ok = CDDL.compile('m<t> = { v: t }\nuse = m<int>');
    expect(ok.warnings).toBeUndefined();
  });

  test('generic parameters are in scope only inside their own rule', () => {
    expect(() => CDDL.compile('m<t> = { v: t }\nother = t')).toThrow(
      CddlSemanticError
    );
  });

  test('empty models are rejected (semantic constraint, RFC 9682 §3.1)', () => {
    expect(() => CDDL.compile('; nothing\n')).toThrow(CddlSemanticError);
    const schema = CDDL.compile('', { strict: false });
    expect(schema.root).toBeUndefined();
    expect(schema.warnings).toMatchObject([{ code: 'no-rules' }]);
  });

  test('majors above 7 are rejected', () => {
    expect(() => CDDL.compile('t = #8')).toThrow(CddlSemanticError);
  });

  test('the root rule must define a type, not a group (RFC 8610 §2.2.4)', () => {
    for (const bad of [
      'root = a: uint\na = int', // member key
      'g = (a: 1, b: 2)', // group with member keys
      'g = (a // b)\na = 1\nb = 2', // group choice
      'r = 2*3 int', // occurrence
      'root = (int,)', // trailing comma makes it a group
    ]) {
      try {
        CDDL.compile(bad);
        expect.unreachable(bad);
      } catch (e) {
        expect(e, bad).toBeInstanceOf(CddlSemanticError);
        expect(
          (e as CddlSemanticError).warnings.some(
            (w) => w.code === 'invalid-root'
          ),
          bad
        ).toBe(true);
      }
    }
    // A parenthesized plain type is still a type; later rules may be groups.
    expect(CDDL.compile('p = (int)').warnings).toBeUndefined();
    expect(
      CDDL.compile('start = int\ng = (a: 1, b: 2)').warnings
    ).toBeUndefined();
  });

  test('user rules shadow prelude names silently', () => {
    const schema = CDDL.compile('text = tstr .size (1..100)\nuse = text');
    expect(schema.warnings).toBeUndefined();
  });
});

describe('standard prelude', () => {
  test('parses to the expected rule set', () => {
    const prelude = getPreludeRules();
    expect(prelude.size).toBe(40);
    for (const name of ['any', 'uint', 'tstr', 'float', 'bool', 'undefined'])
      expect(prelude.has(name), name).toBe(true);
  });

  test('prelude source itself compiles cleanly', () => {
    const schema = CDDL.compile(PRELUDE_CDDL);
    expect(schema.warnings).toBeUndefined();
    expect(schema.root?.name).toBe('any');
  });
});
