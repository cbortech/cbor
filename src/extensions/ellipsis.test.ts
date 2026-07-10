/**
 * Tests for the core CPA888 ellipsis decode extension:
 *  - tag 888 reconstruction to CborEllipsis during fromCBOR / integer-tag EDN,
 *  - compile → decompile round-trip of `...` notation,
 *  - appStrings: false fallback to raw 888(…) tag notation,
 *  - malformed 888 shapes left as plain CborTag.
 */

import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { CborEllipsis } from '../ast/CborEllipsis';
import { CborTag } from '../ast/CborTag';

describe('ellipsis — fromCBOR reconstruction', () => {
  test('888(null) binary decodes to CborEllipsis', () => {
    const bin = CBOR.compile('...');
    const v = CBOR.fromCBOR(bin);
    expect(v).toBeInstanceOf(CborEllipsis);
  });

  test('888([frag, 888(null), frag]) binary decodes to CborEllipsis', () => {
    const bin = CBOR.compile('"He" + ... + "ob"');
    const v = CBOR.fromCBOR(bin);
    expect(v).toBeInstanceOf(CborEllipsis);
  });

  test('integer-tag EDN 888(null) parses to CborEllipsis', () => {
    const v = CBOR.fromCDN('888(null)');
    expect(v).toBeInstanceOf(CborEllipsis);
    expect(v.toCDN()).toBe('...');
  });
});

describe('ellipsis — compile/decompile round-trip', () => {
  test('subtree elision as map key and value', () => {
    const bin = CBOR.compile('{...:...}');
    expect(CBOR.decompile(bin)).toBe('{...:...}');
  });

  test('text string elision', () => {
    const bin = CBOR.compile('"He" + ... + "ob"');
    expect(CBOR.decompile(bin)).toBe('"He" + ... + "ob"');
  });

  test('byte string elision', () => {
    const bin = CBOR.compile("h'4711' + ... + h'0815'");
    expect(CBOR.decompile(bin)).toBe("h'4711' + ... + h'0815'");
  });

  test("fully elided byte string h'...' (single-item 888 array)", () => {
    const bin = CBOR.compile("h'...'");
    expect(CBOR.decompile(bin)).toBe('...');
  });

  test('elision inside array', () => {
    const bin = CBOR.compile('[1, ..., 3]');
    expect(CBOR.decompile(bin)).toBe('[1,...,3]');
  });
});

describe('ellipsis — appStrings: false falls back to tag notation', () => {
  test('subtree elision → 888(null)', () => {
    const bin = CBOR.compile('{...:...}');
    expect(CBOR.decompile(bin, { appStrings: false })).toBe(
      '{888(null):888(null)}'
    );
  });

  test('string elision → 888([...]) with nested 888(null)', () => {
    const bin = CBOR.compile('"He" + ... + "ob"');
    expect(CBOR.decompile(bin, { appStrings: false })).toBe(
      '888(["He",888(null),"ob"])'
    );
  });

  test('parsed `...` also honours appStrings: false', () => {
    expect(CBOR.fromCDN('...').toCDN({ appStrings: false })).toBe('888(null)');
  });
});

describe('ellipsis — invalid 888 shapes stay plain CborTag', () => {
  test.each([
    ['non-elision content', '888(42)'],
    ['empty array', '888([])'],
    ['fragments without ellipsis', '888(["a", "b"])'],
    ['adjacent ellipses', '888([888(null), 888(null)])'],
    ['adjacent fragments', '888(["a", "b", 888(null)])'],
    ['mixed text and byte fragments', `888(["a", 888(null), h'ff'])`],
    ['non-string fragment', '888([1, 888(null)])'],
  ])('%s: %s', (_name, edn) => {
    const bin = CBOR.compile(edn);
    const v = CBOR.fromCBOR(bin);
    expect(v).toBeInstanceOf(CborTag);
    expect(v).not.toBeInstanceOf(CborEllipsis);
    expect((v as CborTag).tag).toBe(888n);
  });
});
