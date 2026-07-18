import { describe, expect, test } from 'vitest';
import DefaultCBOR, { CBOR } from './index';

describe('README examples', () => {
  test('default import exposes the CBOR facade', () => {
    expect(DefaultCBOR).toBe(CBOR);
    expect(DefaultCBOR.stringify({ a: 1 })).toBe('{"a":1}');
  });

  test('JavaScript to CBOR bytes', () => {
    const bytes = CBOR.encode({ hello: 'world', n: 42 });

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(CBOR.decode(bytes)).toEqual({ hello: 'world', n: 42 });
  });

  test('CBOR bytes to JavaScript', () => {
    const value = CBOR.decode(
      new Uint8Array([
        0xa2, 0x65, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x65, 0x77, 0x6f, 0x72, 0x6c,
        0x64, 0x61, 0x6e, 0x18, 0x2a,
      ])
    );

    expect(value).toEqual({ hello: 'world', n: 42 });
  });

  test('CBOR bytes to CDN', () => {
    const text = CBOR.fromCBOR(
      new Uint8Array([0x83, 0x01, 0x02, 0x03])
    ).toCDN();

    expect(text).toBe('[1,2,3]');
  });

  test('CDN to CBOR bytes', () => {
    const bytes = CBOR.fromCDN('[1, 2, 3]').toCBOR();

    expect(bytes).toEqual(new Uint8Array([0x83, 0x01, 0x02, 0x03]));
  });

  test('JavaScript to CDN', () => {
    const text = CBOR.stringify({ a: 1, b: true, c: null });

    expect(text).toBe('{"a":1,"b":true,"c":null}');
  });

  test('pretty CDN', () => {
    const text = CBOR.stringify({ items: [1, 2, 3], ok: true }, { indent: 2 });

    expect(text).toBe(
      '{\n' +
        '  "items": [\n' +
        '    1,\n' +
        '    2,\n' +
        '    3\n' +
        '  ],\n' +
        '  "ok": true\n' +
        '}'
    );
  });

  test('CDN to JavaScript', () => {
    const value = CBOR.parse("[1, h'deadbeef', true, null]");

    expect(value).toEqual([
      1,
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      true,
      null,
    ]);
  });

  test('normalize CDN', () => {
    const text = CBOR.format('{ "b" : [ 1,2 ], "a" : true }', {
      indent: 2,
    });

    expect(text).toBe(
      '{\n' +
        '  "b": [\n' +
        '    1,\n' +
        '    2\n' +
        '  ],\n' +
        '  "a": true\n' +
        '}'
    );
  });

  test('inlineLeafContainers keeps leaf containers on one line', () => {
    const text = CBOR.format('{"m": [[1,2],[3,4]], "s": (_ "a", "b")}', {
      indent: 2,
      inlineLeafContainers: true,
    });

    expect(text).toBe(
      '{\n' +
        '  "m": [\n' +
        '    [1, 2],\n' +
        '    [3, 4]\n' +
        '  ],\n' +
        '  "s": (_ "a", "b")\n' +
        '}'
    );
  });

  test('splitNewline splits text strings at newlines', () => {
    const text = CBOR.format('{"text": "line1\\nline2\\nline3"}', {
      indent: 2,
      splitNewline: true,
    });

    expect(text).toBe(
      '{\n' +
        '  "text": "line1\\n" +\n' +
        '    "line2\\n" +\n' +
        '    "line3"\n' +
        '}'
    );
  });

  test('splitCdn splits text strings containing CDN', () => {
    const text = CBOR.format('{"cdn": "[1,2,3]"}', {
      indent: 2,
      splitCdn: true,
    });

    expect(text).toBe(
      '{\n' +
        '  "cdn": "[" +\n' +
        '      "1," +\n' +
        '      "2," +\n' +
        '      "3" +\n' +
        '    "]"\n' +
        '}'
    );
  });

  test('preserveConcatenation keeps + string concatenation', () => {
    expect(CBOR.format('"a" + "b"')).toBe('"ab"');
    expect(CBOR.format('"a" + "b"', { preserveConcatenation: true })).toBe(
      '"a" + "b"'
    );
    expect(
      CBOR.format("h'68' + b64'aQ'", {
        preserveConcatenation: true,
        preserveByteString: true,
      })
    ).toBe("h'68' + b64'aQ'");
  });

  test('AST item methods', () => {
    const item = CBOR.fromCDN('{ "x": 1 }');

    expect(item.toCBOR()).toBeInstanceOf(Uint8Array);
    expect(item.toCDN()).toBe('{"x":1}');
    expect(item.toJS()).toEqual({ x: 1 });
  });

  test('parse to AST, then serialize', () => {
    const item = CBOR.fromCDN('[_ 1, 2, 3]');

    expect(item.toCDN()).toBe('[_ 1,2,3]');
    expect(item.toCBOR()).toBeInstanceOf(Uint8Array);
  });

  test('decode to AST, then inspect as CDN', () => {
    const item = CBOR.fromCBOR(new Uint8Array([0x83, 0x01, 0x02, 0x03]));

    expect(item.toCDN()).toBe('[1,2,3]');
    expect(item.toJS()).toEqual([1, 2, 3]);
  });

  test('reviver', () => {
    const value = CBOR.parse(
      '{"createdAt": "2026-05-06T00:00:00Z"}',
      (key, value) => {
        if (key === 'createdAt') return new Date(value as string);
        return value;
      }
    ) as { createdAt: Date };

    expect(value.createdAt).toBeInstanceOf(Date);
    expect(value.createdAt.toISOString()).toBe('2026-05-06T00:00:00.000Z');
  });

  test('replacer function', () => {
    const text = CBOR.stringify({ id: 1, password: 'secret' }, (key, value) =>
      key === 'password' ? CBOR.OMIT : value
    );

    expect(text).toBe('{"id":1}');
  });

  test('replacer key list', () => {
    const text = CBOR.stringify(
      { id: 1, name: 'Alice', password: 'secret' },
      ['id', 'name'],
      2
    );

    expect(text).toBe('{\n  "id": 1,\n  "name": "Alice"\n}');
  });

  test('default options', () => {
    const cbor = new CBOR({
      extensions: [CBOR.dt_as_Date],
      indent: 2,
    });

    const value = cbor.parse("DT'2026-05-06T00:00:00Z'");

    expect(value).toBeInstanceOf(Date);
    expect(cbor.stringify({ value })).toBe(
      '{\n  "value": DT\'2026-05-06T00:00:00Z\'\n}'
    );
  });

  test('dates parse with dt_as_Date', () => {
    const value = CBOR.parse("DT'2026-05-06T00:00:00Z'", {
      extensions: [CBOR.dt_as_Date],
    });

    expect(value).toBeInstanceOf(Date);
  });

  test('dates stringify with dt_as_Date', () => {
    const text = CBOR.stringify(new Date('2026-05-06T00:00:00Z'), {
      extensions: [CBOR.dt_as_Date],
    });

    expect(text).toBe("DT'2026-05-06T00:00:00Z'");
  });

  test('Tag.set() values stringify as CBOR tags', () => {
    const tagged = CBOR.Tag.set('hello', 42n);
    const text = CBOR.stringify(tagged);

    expect(text).toBe('42("hello")');
  });

  test('parsed CBOR tags can be inspected with Tag', () => {
    const value = CBOR.parse('42("hello")');

    expect(CBOR.Tag.get(value)).toBe(42n);
    expect(CBOR.Tag.getValue(value)).toBe('hello');
  });

  test('stripTags removes parsed CBOR tag annotations', () => {
    const value = CBOR.parse('42("hello")', { stripTags: true });

    expect(value).toBe('hello');
    expect(CBOR.Tag.get(value)).toBeUndefined();
  });

  test('Simple values stringify', () => {
    const text = CBOR.stringify(new CBOR.Simple(16));

    expect(text).toBe('simple(16)');
  });

  test('parsed Simple values remain Simple instances', () => {
    const value = CBOR.parse('simple(16)');

    expect(value).toBeInstanceOf(CBOR.Simple);
    expect((value as InstanceType<typeof CBOR.Simple>).value).toBe(16);
  });

  test('maps with text keys become objects by default', () => {
    const value = CBOR.parse('{"a": 1, "b": 2}');

    expect(value).toEqual({ a: 1, b: 2 });
  });

  test("mapAs: 'entries' preserves duplicate keys", () => {
    const entries = CBOR.parse('{1: "one", 1: "uno"}', {
      mapAs: 'entries',
    });

    expect(entries).toBeInstanceOf(CBOR.MapEntries);
    expect(entries).toEqual([
      [1, 'one'],
      [1, 'uno'],
    ]);
  });

  test('MapEntries can be stringified', () => {
    const entries = new CBOR.MapEntries([1, 'one'], [1, 'uno']);

    expect(CBOR.stringify(entries)).toBe('{1:"one",1:"uno"}');
  });

  test('hex dumps can be produced', () => {
    const item = CBOR.fromCDN('[_ 1, [2, 3]]');
    const dump = item.toHexDump();

    expect(dump).toContain('9F        -- Start indefinite-length array');
  });

  test('hex dumps can be parsed', () => {
    const item = CBOR.fromHexDump(`
83        -- Array of length 3
   01     -- 1
   02     -- 2
   03     -- 3
`);

    expect(item.toCDN()).toBe('[1,2,3]');
  });
});
