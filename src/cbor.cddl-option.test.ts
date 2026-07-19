import { describe, expect, test } from 'vitest';
import { CBOR, CddlMismatchError } from './index';
import { CDDL, CddlSyntaxError, CddlSemanticError } from './cddl/index';

const PERSON_CDDL = 'person = { name: tstr, ? age: uint }';
const person = CDDL.compile(PERSON_CDDL);

describe('cddl option', () => {
  describe('CBOR.validate()', () => {
    test('valid CBOR input yields empty cddlErrors', () => {
      const bytes = CBOR.encode({ name: 'kudo', age: 42 });
      const result = CBOR.validate(bytes, { cddl: person });
      expect(result.valid).toBe(true);
      expect(result.cddlErrors).toEqual([]);
      expect(result.cddlWarnings).toEqual([]);
    });

    test('mismatching CBOR input collects cddlErrors without throwing', () => {
      const bytes = CBOR.encode({ name: 42 });
      const result = CBOR.validate(bytes, { cddl: person });
      expect(result.valid).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.warnings).toEqual([]);
      expect(result.cddlErrors!.length).toBeGreaterThan(0);
    });

    test('CDN sequence input validates each item individually', () => {
      const result = CBOR.validate('{"name": "kudo"} {"name": 1}', {
        type: 'cdn',
        cddl: person,
      });
      expect(result.count).toBe(2);
      expect(result.valid).toBe(false);
      expect(result.cddlErrors!.length).toBeGreaterThan(0);
    });

    test('hex dump input is validated', () => {
      const hex = CBOR.toHex(CBOR.encode({ name: 'kudo' }));
      const result = CBOR.validate(hex, { type: 'hex', cddl: person });
      expect(result.valid).toBe(true);
      expect(result.cddlErrors).toEqual([]);
    });

    test('cddlErrors/cddlWarnings are absent without the cddl option', () => {
      const result = CBOR.validate(CBOR.encode({ name: 'kudo' }));
      expect('cddlErrors' in result).toBe(false);
      expect('cddlWarnings' in result).toBe(false);
    });

    test('cddl fields are present alongside a decode error', () => {
      const result = CBOR.validate('{"name": "kudo"} {', {
        type: 'cdn',
        cddl: person,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.cddlErrors).toEqual([]);
    });
  });

  describe('throwing entry points', () => {
    test('CBOR.parse() returns the value when the schema matches', () => {
      expect(CBOR.parse('{"name": "kudo"}', { cddl: person })).toEqual({
        name: 'kudo',
      });
    });

    test('CBOR.parse() throws CddlMismatchError on mismatch', () => {
      expect(() => CBOR.parse('{"name": 1}', { cddl: person })).toThrow(
        CddlMismatchError
      );
      try {
        CBOR.parse('{"name": 1}', { cddl: person });
        expect.unreachable();
      } catch (e) {
        const err = e as CddlMismatchError;
        expect(err.name).toBe('CddlMismatchError');
        expect(err.errors.length).toBeGreaterThan(0);
        expect(err.message).toContain('CDDL validation failed');
      }
    });

    test('CBOR.decode() throws on mismatch and passes on match', () => {
      const good = CBOR.encode({ name: 'kudo' });
      const bad = CBOR.encode({ name: 42 });
      expect(CBOR.decode(good, { cddl: person })).toEqual({ name: 'kudo' });
      expect(() => CBOR.decode(bad, { cddl: person })).toThrow(
        CddlMismatchError
      );
    });

    test('CBOR.fromCDN() / CBOR.fromHexDump() validate the decoded item', () => {
      expect(() => CBOR.fromCDN('[1, 2]', { cddl: person })).toThrow(
        CddlMismatchError
      );
      const hex = CBOR.toHex(CBOR.encode({ name: 'kudo' }));
      expect(CBOR.fromHexDump(hex, { cddl: person }).toCDN()).toBe(
        '{"name":"kudo"}'
      );
    });

    test('sequence generators throw at the mismatching item', () => {
      const values: unknown[] = [];
      const iterate = () => {
        for (const v of CBOR.parseSeq('{"name": "kudo"} {"name": 1}', {
          cddl: person,
        })) {
          values.push(v);
        }
      };
      expect(iterate).toThrow(CddlMismatchError);
      expect(values).toEqual([{ name: 'kudo' }]);
    });

    test('CBOR.encode() / CBOR.stringify() validate the constructed item', () => {
      expect(() => CBOR.encode({ name: 1 }, { cddl: person })).toThrow(
        CddlMismatchError
      );
      expect(CBOR.stringify({ name: 'kudo' }, { cddl: person })).toBe(
        '{"name":"kudo"}'
      );
      expect(() => CBOR.stringify({ name: 1 }, { cddl: person })).toThrow(
        CddlMismatchError
      );
    });
  });

  describe('cddlValidationOptions', () => {
    const gated = CDDL.compile('t = uint .feature "beta"');

    test('features are forwarded to the validator', () => {
      expect(() => CBOR.parse('1', { cddl: gated })).toThrow(CddlMismatchError);
      expect(
        CBOR.parse('1', {
          cddl: gated,
          cddlValidationOptions: { features: ['beta'] },
        })
      ).toBe(1);
    });

    test('validate() forwards the options as well', () => {
      const result = CBOR.validate('1', {
        type: 'cdn',
        cddl: gated,
        cddlValidationOptions: { features: ['beta'] },
      });
      expect(result.valid).toBe(true);
      expect(result.cddlErrors).toEqual([]);
    });

    test('sequence generators forward the options', () => {
      const values = [
        ...CBOR.parseSeq('1 2', {
          cddl: gated,
          cddlValidationOptions: { features: ['beta'] },
        }),
      ];
      expect(values).toEqual([1, 2]);
    });
  });

  describe('CDDL source text as the cddl option', () => {
    test('a string is compiled and used like a compiled schema', () => {
      expect(CBOR.parse('{"name": "kudo"}', { cddl: PERSON_CDDL })).toEqual({
        name: 'kudo',
      });
      expect(() => CBOR.parse('{"name": 1}', { cddl: PERSON_CDDL })).toThrow(
        CddlMismatchError
      );

      const result = CBOR.validate('{"name": 1}', {
        type: 'cdn',
        cddl: PERSON_CDDL,
      });
      expect(result.valid).toBe(false);
      expect(result.cddlErrors!.length).toBeGreaterThan(0);
    });

    test('repeated use of the same string reuses the compiled schema', () => {
      for (let i = 0; i < 3; i++) {
        expect(
          CBOR.validate('{"name": "kudo"}', { type: 'cdn', cddl: PERSON_CDDL })
            .valid
        ).toBe(true);
      }
    });

    test('invalid CDDL text throws at the call site, even from validate()', () => {
      expect(() => CBOR.parse('1', { cddl: 'person = {' })).toThrow(
        CddlSyntaxError
      );
      expect(() =>
        CBOR.validate('1', { type: 'cdn', cddl: 'person = undefined-name' })
      ).toThrow(CddlSemanticError);
    });

    test('invalid CDDL text throws even for an empty sequence', () => {
      expect(() => CBOR.compile('', { cddl: 'broken = {' })).toThrow(
        CddlSyntaxError
      );
      expect(() => [
        ...CBOR.fromCBORSeq(new Uint8Array(0), { cddl: 'broken = {' }),
      ]).toThrow(CddlSyntaxError);
      expect(() => [...CBOR.fromCDNSeq('', { cddl: 'broken = {' })]).toThrow(
        CddlSyntaxError
      );
    });

    test('a string works as an instance default', () => {
      const cbor = new CBOR({ cddl: PERSON_CDDL });
      expect(cbor.parse('{"name": "kudo"}')).toEqual({ name: 'kudo' });
      expect(() => cbor.parse('{"name": 1}')).toThrow(CddlMismatchError);
    });
  });

  describe('instance defaults', () => {
    test('a schema supplied to the constructor applies to every call', () => {
      const cbor = new CBOR({ cddl: person });
      expect(cbor.parse('{"name": "kudo"}')).toEqual({ name: 'kudo' });
      expect(() => cbor.parse('{"name": 1}')).toThrow(CddlMismatchError);
      const result = cbor.validate(CBOR.encode({ name: 42 }));
      expect(result.valid).toBe(false);
      expect(result.cddlErrors!.length).toBeGreaterThan(0);
    });

    test('per-call options override the instance default', () => {
      const cbor = new CBOR({ cddl: person });
      const anything = CDDL.compile('root = any');
      expect(cbor.parse('{"name": 1}', { cddl: anything })).toEqual({
        name: 1,
      });
    });
  });
});
