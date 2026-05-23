import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { decodeCBOR } from '../cbor/decoder';
import { fromJS } from '../js/fromJS';
import { CborIpExt, CborIpPrefixExt, CborTaggedIpExt } from './ip';
import { CborByteString } from '../ast/CborByteString';
import { CborTag } from '../ast/CborTag';
import { CborArray } from '../ast/CborArray';
import { CborUint } from '../ast/CborUint';

// ─── ip'…' — bare byte string ─────────────────────────────────────────────────

describe("ip — ip'…' (lowercase, untagged)", () => {
  test("ip'192.0.2.42' → CborIpExt, 4 bytes, h'c000022a'", () => {
    const v = CBOR.fromCDN("ip'192.0.2.42'");
    expect(v).toBeInstanceOf(CborIpExt);
    expect((v as CborIpExt).value).toEqual(
      new Uint8Array([0xc0, 0x00, 0x02, 0x2a])
    );
    expect(v.toCDN()).toBe("ip'192.0.2.42'");
  });

  test("ip'0.0.0.0' → 4 zero bytes", () => {
    const v = CBOR.fromCDN("ip'0.0.0.0'");
    expect((v as CborIpExt).value).toEqual(new Uint8Array(4));
    expect(v.toCDN()).toBe("ip'0.0.0.0'");
  });

  test("ip'255.255.255.255' → 4 bytes 0xff", () => {
    const v = CBOR.fromCDN("ip'255.255.255.255'");
    expect((v as CborIpExt).value).toEqual(
      new Uint8Array([0xff, 0xff, 0xff, 0xff])
    );
    expect(v.toCDN()).toBe("ip'255.255.255.255'");
  });

  test("ip'::1' → CborIpExt, 16 bytes (loopback)", () => {
    const v = CBOR.fromCDN("ip'::1'");
    expect(v).toBeInstanceOf(CborIpExt);
    const expected = new Uint8Array(16);
    expected[15] = 1;
    expect((v as CborIpExt).value).toEqual(expected);
    expect(v.toCDN()).toBe("ip'::1'");
  });

  test("ip'2001:db8::42' → 16 bytes", () => {
    const v = CBOR.fromCDN("ip'2001:db8::42'");
    expect(v).toBeInstanceOf(CborIpExt);
    const expected = new Uint8Array([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x42,
    ]);
    expect((v as CborIpExt).value).toEqual(expected);
    expect(v.toCDN()).toBe("ip'2001:db8::42'");
  });

  test("ip'::' → 16 zero bytes", () => {
    const v = CBOR.fromCDN("ip'::'");
    expect((v as CborIpExt).value).toEqual(new Uint8Array(16));
    expect(v.toCDN()).toBe("ip'::'");
  });

  test("ip'fe80::1' → toCDN round-trips", () => {
    const v = CBOR.fromCDN("ip'fe80::1'");
    expect(v.toCDN()).toBe("ip'fe80::1'");
  });

  test("ip'::ffff:192.0.2.1' → IPv4-mapped, toCDN preserves dotted notation", () => {
    const v = CBOR.fromCDN("ip'::ffff:192.0.2.1'");
    expect(v).toBeInstanceOf(CborIpExt);
    const expected = new Uint8Array([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xc0, 0x00, 0x02, 0x01,
    ]);
    expect((v as CborIpExt).value).toEqual(expected);
    expect(v.toCDN()).toBe("ip'::ffff:192.0.2.1'");
  });

  test("ip'::ffff:0:0' → IPv4-mapped, formats as dotted '::ffff:0.0.0.0'", () => {
    const v = CBOR.fromCDN("ip'::ffff:0:0'");
    expect(v.toCDN()).toBe("ip'::ffff:0.0.0.0'");
  });

  test("ip'::1' (loopback) is NOT formatted with IPv4 suffix", () => {
    const v = CBOR.fromCDN("ip'::1'");
    expect(v.toCDN()).toBe("ip'::1'");
  });

  test("ip'192.0.2.0/24' → CborIpPrefixExt (bare [24, h'c00002'])", () => {
    const v = CBOR.fromCDN("ip'192.0.2.0/24'");
    expect(v).toBeInstanceOf(CborIpPrefixExt);
    expect(v).not.toBeInstanceOf(CborTag);
    expect(v.toCDN()).toBe("ip'192.0.2.0/24'");
  });

  test("ip'2001:db8::/32' → CborIpPrefixExt (bare [32, h'20010db8'])", () => {
    const v = CBOR.fromCDN("ip'2001:db8::/32'");
    expect(v).toBeInstanceOf(CborIpPrefixExt);
    expect(v).not.toBeInstanceOf(CborTag);
    expect(v.toCDN()).toBe("ip'2001:db8::/32'");
  });

  test("ip'192.0.2.0/24' toCBOR() produces bare array (no tag)", () => {
    const v = CBOR.fromCDN("ip'192.0.2.0/24'");
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborArray);
    expect(decoded).not.toBeInstanceOf(CborTag);
    expect((decoded as CborArray).items[0]).toBeInstanceOf(CborUint);
    expect((decoded as CborArray).items[1]).toBeInstanceOf(CborByteString);
  });

  test("ip'0.0.0.0/0' → bare [0, h'']", () => {
    const v = CBOR.fromCDN("ip'0.0.0.0/0'");
    expect(v).toBeInstanceOf(CborIpPrefixExt);
    expect(v.toCDN()).toBe("ip'0.0.0.0/0'");
  });

  test("ip'…/prefix' falls back to plain array notation", () => {
    const v = CBOR.fromCDN("ip'192.0.2.0/24'");
    expect(v.toCDN({ appStrings: false })).toBe("[24,h'c00002']");
  });

  test("ip'...' toCBOR() produces bare byte string (no tag)", () => {
    const v = CBOR.fromCDN("ip'192.0.2.42'");
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborByteString);
    expect(decoded).not.toBeInstanceOf(CborTag);
  });
});

// ─── ip<<…>> — app-sequence form ──────────────────────────────────────────────

describe('ip — ip<<…>> / IP<<…>> (app-sequence form)', () => {
  test("ip<<'192.0.2.42'>> → same as ip'192.0.2.42' (byte-string item)", () => {
    const v = CBOR.fromCDN("ip<<'192.0.2.42'>>");
    expect(v).toBeInstanceOf(CborIpExt);
    expect((v as CborIpExt).value).toEqual(
      new Uint8Array([0xc0, 0x00, 0x02, 0x2a])
    );
  });

  test('ip<<"192.0.2.42">> → same as ip\'192.0.2.42\' (text-string item)', () => {
    const v = CBOR.fromCDN('ip<<"192.0.2.42">>');
    expect(v).toBeInstanceOf(CborIpExt);
    expect((v as CborIpExt).value).toEqual(
      new Uint8Array([0xc0, 0x00, 0x02, 0x2a])
    );
  });

  test("IP<<'192.0.2.42'>> → same as IP'192.0.2.42'", () => {
    const v = CBOR.fromCDN("IP<<'192.0.2.42'>>");
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect((v as CborTaggedIpExt).tag).toBe(52n);
    expect(v.toCDN()).toBe("IP'192.0.2.42'");
  });

  test("IP<<'2001:db8::42'>> → same as IP'2001:db8::42'", () => {
    const v = CBOR.fromCDN("IP<<'2001:db8::42'>>");
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect((v as CborTaggedIpExt).tag).toBe(54n);
  });
});

// ─── IP'…' — tagged ───────────────────────────────────────────────────────────

describe("ip — IP'…' (uppercase, tagged)", () => {
  test("IP'192.0.2.42' → CborTaggedIpExt, tag 52", () => {
    const v = CBOR.fromCDN("IP'192.0.2.42'");
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect((v as CborTaggedIpExt).tag).toBe(52n);
    expect(v.toCDN()).toBe("IP'192.0.2.42'");
  });

  test("IP'2001:db8::42' → CborTaggedIpExt, tag 54", () => {
    const v = CBOR.fromCDN("IP'2001:db8::42'");
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect((v as CborTaggedIpExt).tag).toBe(54n);
    expect(v.toCDN()).toBe("IP'2001:db8::42'");
  });

  test("IP'192.0.2.42' toCBOR() → tag(52, h'c000022a')", () => {
    const v = CBOR.fromCDN("IP'192.0.2.42'");
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(52n);
    expect(((decoded as CborTag).content as CborByteString).value).toEqual(
      new Uint8Array([0xc0, 0x00, 0x02, 0x2a])
    );
  });

  test("IP'2001:db8::42' toCBOR() → tag(54, h'...')", () => {
    const v = CBOR.fromCDN("IP'2001:db8::42'");
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(54n);
    const bytes = ((decoded as CborTag).content as CborByteString).value;
    expect(bytes).toEqual(
      new Uint8Array([
        0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x42,
      ])
    );
  });
});

// ─── IP'…/prefix' — CIDR ─────────────────────────────────────────────────────

describe("ip — IP'…/prefix' (CIDR)", () => {
  test("IP'192.0.2.0/24' → tag(52, [24, h'c00002'])", () => {
    const v = CBOR.fromCDN("IP'192.0.2.0/24'");
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect((v as CborTaggedIpExt).tag).toBe(52n);
    expect(v.toCDN()).toBe("IP'192.0.2.0/24'");

    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(52n);
    const arr = (decoded as CborTag).content as CborArray;
    expect((arr.items[0] as CborUint).value).toBe(24n);
    expect((arr.items[1] as CborByteString).value).toEqual(
      new Uint8Array([0xc0, 0x00, 0x02])
    );
  });

  test("IP'2001:db8::/32' → tag(54, [32, h'20010db8'])", () => {
    const v = CBOR.fromCDN("IP'2001:db8::/32'");
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect(v.toCDN()).toBe("IP'2001:db8::/32'");

    const decoded = decodeCBOR(v.toCBOR());
    const arr = (decoded as CborTag).content as CborArray;
    expect((arr.items[0] as CborUint).value).toBe(32n);
    expect((arr.items[1] as CborByteString).value).toEqual(
      new Uint8Array([0x20, 0x01, 0x0d, 0xb8])
    );
  });

  test("IP'2001:db8::/64' → tag(54, [64, h'20010db8']) — trailing zeros stripped", () => {
    // RFC 9164 §2.3: after truncation to 8 bytes, trailing zero bytes are removed.
    // 2001:db8::  truncated to 64 bits = 20 01 0d b8 00 00 00 00 → strip → 20 01 0d b8
    const v = CBOR.fromCDN("IP'2001:db8::/64'");
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect(v.toCDN()).toBe("IP'2001:db8::/64'");

    const decoded = decodeCBOR(v.toCBOR());
    const arr = (decoded as CborTag).content as CborArray;
    expect((arr.items[0] as CborUint).value).toBe(64n);
    expect((arr.items[1] as CborByteString).value).toEqual(
      new Uint8Array([0x20, 0x01, 0x0d, 0xb8])
    );
  });

  test("IP'10.0.0.0/8' → 1 byte truncation", () => {
    const v = CBOR.fromCDN("IP'10.0.0.0/8'");
    expect(v.toCDN()).toBe("IP'10.0.0.0/8'");
    const decoded = decodeCBOR(v.toCBOR());
    const arr = (decoded as CborTag).content as CborArray;
    expect((arr.items[1] as CborByteString).value).toEqual(
      new Uint8Array([0x0a])
    );
  });

  test("IP'0.0.0.0/0' → 0 bytes, prefix 0", () => {
    const v = CBOR.fromCDN("IP'0.0.0.0/0'");
    expect(v.toCDN()).toBe("IP'0.0.0.0/0'");
    const decoded = decodeCBOR(v.toCBOR());
    const arr = (decoded as CborTag).content as CborArray;
    expect((arr.items[0] as CborUint).value).toBe(0n);
    expect((arr.items[1] as CborByteString).value).toEqual(new Uint8Array(0));
  });

  test("IP'192.168.0.0/16' → 2-byte truncation", () => {
    const v = CBOR.fromCDN("IP'192.168.0.0/16'");
    expect(v.toCDN()).toBe("IP'192.168.0.0/16'");
  });

  test('prefix length exceeding max throws SyntaxError', () => {
    expect(() => CBOR.fromCDN("IP'192.0.2.0/33'")).toThrow(SyntaxError);
    expect(() => CBOR.fromCDN("IP'2001:db8::/129'")).toThrow(SyntaxError);
  });
});

// ─── fromCBOR with IP_EXT ─────────────────────────────────────────────────────

describe('ip — fromCBOR', () => {
  test('tag(52, 4-byte string) → CborTaggedIpExt, toCDN round-trips', () => {
    const cbor = new CborTag(
      52n,
      new CborByteString(new Uint8Array([192, 0, 2, 42]))
    ).toCBOR();
    const v = decodeCBOR(cbor);
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect(v.toCDN()).toBe("IP'192.0.2.42'");
  });

  test('tag(54, 16-byte string) → CborTaggedIpExt, toCDN round-trips', () => {
    const bytes = new Uint8Array(16);
    bytes[15] = 1;
    const cbor = new CborTag(54n, new CborByteString(bytes)).toCBOR();
    const v = decodeCBOR(cbor);
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect(v.toCDN()).toBe("IP'::1'");
  });

  test("tag(52, [24, h'c00002']) → CborTaggedIpExt (CIDR), toCDN round-trips", () => {
    const cbor = new CborTag(
      52n,
      new CborArray([
        new CborUint(24n),
        new CborByteString(new Uint8Array([0xc0, 0x00, 0x02])),
      ])
    ).toCBOR();
    const v = decodeCBOR(cbor);
    expect(v).toBeInstanceOf(CborTaggedIpExt);
    expect(v.toCDN()).toBe("IP'192.0.2.0/24'");
  });

  test('tag(5, …) is not intercepted by IP_EXT', () => {
    const cbor = new CborTag(5n, new CborUint(42n)).toCBOR();
    const v = decodeCBOR(cbor);
    expect(v).toBeInstanceOf(CborTag);
    expect(v).not.toBeInstanceOf(CborTaggedIpExt);
  });
});

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe('ip — round-trip', () => {
  test("ip'192.0.2.42' EDN → CBOR → fromCBOR → plain CborByteString", () => {
    const v = CBOR.fromCDN("ip'192.0.2.42'");
    const cbor = v.toCBOR();
    const decoded = decodeCBOR(cbor); // bare byte string, no tag
    expect(decoded).toBeInstanceOf(CborByteString);
  });

  test("IP'192.0.2.0/24' EDN → CBOR → fromCBOR → CborTaggedIpExt, toCBOR stable", () => {
    const original = CBOR.fromCDN("IP'192.0.2.0/24'");
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborTaggedIpExt);
    expect(original.toCBOR()).toEqual(decoded.toCBOR());
  });

  test("IP'2001:db8::42' EDN → CBOR → fromCBOR → CborTaggedIpExt, toCDN round-trips", () => {
    const original = CBOR.fromCDN("IP'2001:db8::42'");
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborTaggedIpExt);
    expect(decoded.toCDN()).toBe("IP'2001:db8::42'");
  });
});

// ─── fromJS round-trip ────────────────────────────────────────────────────────

describe('ip — fromJS round-trip', () => {
  test("IP'192.0.2.42' → toJS → fromJS → toCDN round-trips", () => {
    const original = CBOR.fromCDN("IP'192.0.2.42'");
    const restored = fromJS(original.toJS());
    expect(restored).toBeInstanceOf(CborTaggedIpExt);
    expect(restored.toCDN()).toBe("IP'192.0.2.42'");
  });

  test("IP'2001:db8::42' → toJS → fromJS → toCDN round-trips", () => {
    const original = CBOR.fromCDN("IP'2001:db8::42'");
    const restored = fromJS(original.toJS());
    expect(restored).toBeInstanceOf(CborTaggedIpExt);
    expect(restored.toCDN()).toBe("IP'2001:db8::42'");
  });

  test("IP'192.0.2.0/24' → toJS → fromJS → toCDN round-trips", () => {
    const original = CBOR.fromCDN("IP'192.0.2.0/24'");
    const restored = fromJS(original.toJS());
    expect(restored).toBeInstanceOf(CborTaggedIpExt);
    expect(restored.toCDN()).toBe("IP'192.0.2.0/24'");
  });

  test("IP'2001:db8::/32' → toJS → fromJS → toCDN round-trips", () => {
    const original = CBOR.fromCDN("IP'2001:db8::/32'");
    const restored = fromJS(original.toJS());
    expect(restored).toBeInstanceOf(CborTaggedIpExt);
    expect(restored.toCDN()).toBe("IP'2001:db8::/32'");
  });
});

// ─── appStrings: false ────────────────────────────────────────────────────────

describe('ip — appStrings: false', () => {
  test("ip'…' falls back to plain byte string notation", () => {
    const v = CBOR.fromCDN("ip'192.0.2.42'");
    expect(v.toCDN({ appStrings: false })).toBe("h'c000022a'");
  });

  test("IP'…' falls back to tag notation", () => {
    const v = CBOR.fromCDN("IP'192.0.2.42'");
    expect(v.toCDN({ appStrings: false })).toBe("52(h'c000022a')");
  });

  test("IP'…/prefix' (CIDR) falls back to tag notation", () => {
    const v = CBOR.fromCDN("IP'192.0.2.0/24'");
    expect(v.toCDN({ appStrings: false })).toBe("52([24,h'c00002'])");
  });

  test("IP'…' IPv6 falls back to tag notation", () => {
    const v = CBOR.fromCDN("IP'2001:db8::42'");
    expect(v.toCDN({ appStrings: false })).toBe(
      "54(h'20010db8000000000000000000000042')"
    );
  });
});
