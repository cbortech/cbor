import { describe, expect, test } from 'vitest';
import { CBOR, type CborExtension, type ToCDNOptions } from './index';
import { CborByteString, CborItem } from './ast/index';

class CborUuidExt extends CborByteString {
  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, depth);
    const hex = Array.from(this.value, (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    return `uuid'${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}'`;
  }
}

function parseUuid(input: string): Uint8Array {
  const hex = input.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new SyntaxError(`uuid: invalid UUID: ${JSON.stringify(input)}`);
  }
  return new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
}

describe('public API', () => {
  test('exposes CDN names while keeping EDN names as aliases', () => {
    const cbor = new CBOR();
    const fromStatic = CBOR.fromCDN('[1, 2, 3]');
    const fromInstance = cbor.fromCDN('[1, 2, 3]');

    expect(fromStatic.toCDN()).toBe('[1,2,3]');
    expect(fromInstance.toCDN()).toBe('[1,2,3]');
    expect(CBOR.fromEDN('[1, 2, 3]').toEDN()).toBe(fromStatic.toCDN());
    expect(cbor.fromEDN('[1, 2, 3]').toEDN()).toBe(fromInstance.toCDN());
    expect(CBOR.cdnToCbor('[1, 2, 3]')).toEqual(
      CBOR.cborEdnToCbor('[1, 2, 3]')
    );
    expect(CBOR.cborToCdn(new Uint8Array([0x83, 0x01, 0x02, 0x03]))).toBe(
      '[1,2,3]'
    );
  });

  test('exports AST classes needed by extensions from the AST entrypoint', () => {
    const uuid: CborExtension = {
      appStringPrefixes: ['uuid'],
      parseAppString: (_prefix, content) => new CborUuidExt(parseUuid(content)),
    };

    const cbor = new CBOR({ extensions: [uuid] });
    const item = cbor.fromCDN("uuid'550e8400-e29b-41d4-a716-446655440000'");

    expect(item).toBeInstanceOf(CborItem);
    expect(item).toBeInstanceOf(CborByteString);
    expect(item).toBeInstanceOf(CborUuidExt);
    expect(item.toCDN()).toBe("uuid'550e8400-e29b-41d4-a716-446655440000'");
    expect(cbor.parse("uuid'550e8400-e29b-41d4-a716-446655440000'")).toEqual(
      new Uint8Array([
        0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66,
        0x55, 0x44, 0x00, 0x00,
      ])
    );
  });
});
