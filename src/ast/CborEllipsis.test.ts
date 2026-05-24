import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { decodeCBOR } from '../cbor/decoder';
import { CborEllipsis, CPA888_TAG } from './CborEllipsis';
import { CborByteString } from './CborByteString';
import { CborTextString } from './CborTextString';
import { CborArray } from './CborArray';
import { CborTag } from './CborTag';
import { CborSimple } from './CborSimple';

// ─── Subtree elision: standalone ... ─────────────────────────────────────────

describe('CborEllipsis — subtree elision (888(null))', () => {
  test('... parses to CborEllipsis with CborSimple.NULL content', () => {
    const v = CBOR.fromCDN('...');
    expect(v).toBeInstanceOf(CborEllipsis);
    expect((v as CborEllipsis).tag).toBe(CPA888_TAG);
    expect((v as CborEllipsis).content).toBe(CborSimple.NULL);
  });

  test('... toCDN() round-trips to "..."', () => {
    const v = CBOR.fromCDN('...');
    expect(v.toCDN()).toBe('...');
  });

  test('... toCBOR() → tag(888, null)', () => {
    const v = CBOR.fromCDN('...');
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(888n);
    expect((decoded as CborTag).content).toBeInstanceOf(CborSimple);
    expect(((decoded as CborTag).content as CborSimple).value).toBe(22);
  });

  test('new CborEllipsis() constructs subtree elision', () => {
    const e = new CborEllipsis();
    expect(e.tag).toBe(888n);
    expect(e.content).toBe(CborSimple.NULL);
    expect(e.toCDN()).toBe('...');
  });

  test('... inside array', () => {
    const v = CBOR.fromCDN('[1, ..., 3]');
    expect(v).toBeInstanceOf(CborArray);
    const arr = v as CborArray;
    expect(arr.items[1]).toBeInstanceOf(CborEllipsis);
    expect(arr.items[1].toCDN()).toBe('...');
  });

  test('... inside map value', () => {
    const v = CBOR.fromCDN('{"key": ...}');
    expect(v.toCDN()).toContain('...');
  });
});

// ─── String elision: "prefix" + ... + "suffix" ───────────────────────────────

describe('CborEllipsis — text string elision (888([...]))', () => {
  test('"foo" + ... + "bar" → CborEllipsis with 3 items', () => {
    const v = CBOR.fromCDN('"foo" + ... + "bar"');
    expect(v).toBeInstanceOf(CborEllipsis);
    const e = v as CborEllipsis;
    expect(e.content).toBeInstanceOf(CborArray);
    const items = (e.content as CborArray).items;
    expect(items).toHaveLength(3);
    expect(items[0]).toBeInstanceOf(CborTextString);
    expect((items[0] as CborTextString).value).toBe('foo');
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect(items[2]).toBeInstanceOf(CborTextString);
    expect((items[2] as CborTextString).value).toBe('bar');
  });

  test('"foo" + ... + "bar" toCDN() → "foo" + ... + "bar"', () => {
    const v = CBOR.fromCDN('"foo" + ... + "bar"');
    expect(v.toCDN()).toBe('"foo" + ... + "bar"');
  });

  test('"foo" + ... → elision at end', () => {
    const v = CBOR.fromCDN('"foo" + ...');
    expect(v).toBeInstanceOf(CborEllipsis);
    expect(v.toCDN()).toBe('"foo" + ...');
  });

  test('... is a standalone subtree elision value', () => {
    // ... on its own parses as subtree elision, not a concat chain
    const v = CBOR.fromCDN('...');
    expect(v).toBeInstanceOf(CborEllipsis);
    expect((v as CborEllipsis).content).toBe(CborSimple.NULL);
  });

  test('"a" + "b" + ... + "c" → adjacent string fragments merged', () => {
    const v = CBOR.fromCDN('"a" + "b" + ... + "c"');
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    // "a" + "b" should merge into "ab"
    expect(items[0]).toBeInstanceOf(CborTextString);
    expect((items[0] as CborTextString).value).toBe('ab');
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect(items[2]).toBeInstanceOf(CborTextString);
    expect((items[2] as CborTextString).value).toBe('c');
  });

  test('"a" + ... + "b" + ... + "c" → multiple ellipsis', () => {
    const v = CBOR.fromCDN('"a" + ... + "b" + ... + "c"');
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(5);
    expect((items[0] as CborTextString).value).toBe('a');
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect((items[2] as CborTextString).value).toBe('b');
    expect(items[3]).toBeInstanceOf(CborEllipsis);
    expect((items[4] as CborTextString).value).toBe('c');
  });

  test('"foo" + ... + "bar" toCBOR() → tag(888, ["foo", 888(null), "bar"])', () => {
    const v = CBOR.fromCDN('"foo" + ... + "bar"');
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(888n);
    const arr = (decoded as CborTag).content as CborArray;
    expect(arr).toBeInstanceOf(CborArray);
    expect(arr.items).toHaveLength(3);
  });

  test('new CborEllipsis([items]) constructs string/bytes elision', () => {
    const items = [
      new CborTextString('foo'),
      new CborEllipsis(),
      new CborTextString('bar'),
    ];
    const e = new CborEllipsis(items);
    expect(e.tag).toBe(888n);
    expect(e.content).toBeInstanceOf(CborArray);
    expect(e.toCDN()).toBe('"foo" + ... + "bar"');
  });
});

// ─── Bytes elision: h'xx' + ... + h'yy' ──────────────────────────────────────

describe('CborEllipsis — byte string elision (888([...]))', () => {
  test("h'4711' + ... + h'0815' → CborEllipsis", () => {
    const v = CBOR.fromCDN("h'4711' + ... + h'0815'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(3);
    expect(items[0]).toBeInstanceOf(CborByteString);
    expect((items[0] as CborByteString).value).toEqual(
      new Uint8Array([0x47, 0x11])
    );
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect(items[2]).toBeInstanceOf(CborByteString);
    expect((items[2] as CborByteString).value).toEqual(
      new Uint8Array([0x08, 0x15])
    );
  });

  test("h'4711' + ... + h'0815' toCDN() round-trips", () => {
    const v = CBOR.fromCDN("h'4711' + ... + h'0815'");
    expect(v.toCDN()).toBe("h'4711' + ... + h'0815'");
  });

  test("h'4711...0815' — inline ellipsis in hex literal", () => {
    const v = CBOR.fromCDN("h'4711...0815'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(3);
    expect((items[0] as CborByteString).value).toEqual(
      new Uint8Array([0x47, 0x11])
    );
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect((items[2] as CborByteString).value).toEqual(
      new Uint8Array([0x08, 0x15])
    );
  });

  test("h'4711...0815' toCDN() round-trips to h'4711' + ... + h'0815'", () => {
    const v = CBOR.fromCDN("h'4711...0815'");
    expect(v.toCDN()).toBe("h'4711' + ... + h'0815'");
  });

  test("h'...ff' — leading ellipsis in hex literal", () => {
    const v = CBOR.fromCDN("h'...ff'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(2);
    expect(items[0]).toBeInstanceOf(CborEllipsis);
    expect((items[1] as CborByteString).value).toEqual(new Uint8Array([0xff]));
  });

  test("h'ff...' — trailing ellipsis in hex literal", () => {
    const v = CBOR.fromCDN("h'ff...'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(2);
    expect((items[0] as CborByteString).value).toEqual(new Uint8Array([0xff]));
    expect(items[1]).toBeInstanceOf(CborEllipsis);
  });

  test("h'...' — pure ellipsis hex literal", () => {
    const v = CBOR.fromCDN("h'...'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(CborEllipsis);
  });

  test("h'aa' + ... — bytes then standalone ellipsis", () => {
    const v = CBOR.fromCDN("h'aa' + ...");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(2);
    expect((items[0] as CborByteString).value).toEqual(new Uint8Array([0xaa]));
    expect(items[1]).toBeInstanceOf(CborEllipsis);
  });

  test("h'aa' + h'bb' + ... + h'cc' — adjacent bytes merged", () => {
    const v = CBOR.fromCDN("h'aa' + h'bb' + ... + h'cc'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(3);
    expect((items[0] as CborByteString).value).toEqual(
      new Uint8Array([0xaa, 0xbb])
    );
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect((items[2] as CborByteString).value).toEqual(new Uint8Array([0xcc]));
  });
});

// ─── CborEllipsis in EDN output via toCDN ────────────────────────────────────

describe('CborEllipsis — toCDN', () => {
  test('subtree elision → "..."', () => {
    expect(new CborEllipsis().toCDN()).toBe('...');
  });

  test('string elision → fragments joined with " + "', () => {
    const e = new CborEllipsis([
      new CborTextString('hello'),
      new CborEllipsis(),
      new CborTextString('world'),
    ]);
    expect(e.toCDN()).toBe('"hello" + ... + "world"');
  });

  test('bytes elision → h fragments joined with " + "', () => {
    const e = new CborEllipsis([
      new CborByteString(new Uint8Array([0x47, 0x11])),
      new CborEllipsis(),
      new CborByteString(new Uint8Array([0x08, 0x15])),
    ]);
    expect(e.toCDN()).toBe("h'4711' + ... + h'0815'");
  });
});
