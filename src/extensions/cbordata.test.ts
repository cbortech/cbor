import { describe, test, expect } from 'vitest';
import { decodeCBOR } from '../cbor/decoder';
import { CborTag } from '../ast/CborTag';
import { CborEmbeddedCBOR } from '../ast/CborEmbeddedCBOR';
import { CborTextString } from '../ast/CborTextString';
import { CborByteString } from '../ast/CborByteString';

/** Convert a hex string (spaces allowed) to Uint8Array. */
function hex(s: string): Uint8Array {
  s = s.replace(/\s+/g, '');
  const result = new Uint8Array(s.length / 2);
  for (let i = 0; i < s.length; i += 2) {
    result[i / 2] = parseInt(s.slice(i, i + 2), 16);
  }
  return result;
}

describe('tag 24: embedded CBOR (RFC 8949 §3.4.5.1)', () => {
  test('d818456449455446 → CborTag(24, <<"IETF">>)', () => {
    // Tag 24: byte string h'6449455446' is valid CBOR for text string "IETF"
    const r = decodeCBOR(hex('d818456449455446')) as CborTag;
    expect(r.tag).toBe(24n);
    expect(r.content).toBeInstanceOf(CborEmbeddedCBOR);
    expect((r.content as CborEmbeddedCBOR).items[0]).toBeInstanceOf(
      CborTextString
    );
    expect(
      ((r.content as CborEmbeddedCBOR).items[0] as CborTextString).value
    ).toBe('IETF');
    expect(r.toCDN()).toBe('24(<<"IETF">>)');
  });

  test('round-trip: 24(<<{"key":"value"}>>) via toCBOR/fromCBOR', () => {
    // Encode the map {"key":"value"} as CBOR bytes: a1 63 6b 65 79 65 76 61 6c 75 65
    // Tag 24 wrapping those bytes: d8 18 4b a1 63 6b 65 79 65 76 61 6c 75 65
    const encoded = hex('d8184ba1636b65796576616c7565');
    const r = decodeCBOR(encoded) as CborTag;
    expect(r.tag).toBe(24n);
    expect(r.content).toBeInstanceOf(CborEmbeddedCBOR);
    expect(r.toCDN()).toBe('24(<<{"key":"value"}>>)');
  });

  test('strict mode (default): invalid inner CBOR throws', () => {
    // Tag 24 wrapping h'ff' — 0xff is a break code, not a valid CBOR item start.
    // In strict mode the extension re-throws so the outer decode also throws.
    expect(() => decodeCBOR(hex('d81841ff'))).toThrow();
  });

  test('strict: false: invalid inner CBOR falls back to CborByteString', () => {
    // d8 18 41 ff: tag(24, byte-string len 1) with payload 0xff at outer
    // offset 3 — a break code, not a valid CBOR item start. In non-strict
    // mode the extension catches the inner error and returns a plain CborTag
    // wrapping the raw bytes, but still reports the violation via onWarning
    // so it isn't silently lost. The offset must point at the payload's
    // position in the *outer* input (3), not the byte-string header (2) or
    // the inner-buffer-relative position (0).
    const warnings: { message: string; offset: number }[] = [];
    const r = decodeCBOR(hex('d81841ff'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborTag;
    expect(r.tag).toBe(24n);
    expect(r.content).toBeInstanceOf(CborByteString);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('tag 24');
    expect(warnings[0]!.offset).toBe(3);
  });

  test('strict: false: an inner recoverable warning is forwarded with its outer offset', () => {
    // d8 18 42 61 ff: tag(24, byte-string len 2) with payload [0x61, 0xff].
    // The inner decode succeeds (text string of length 1) but the payload
    // byte 0xff is invalid UTF-8 at outer offset 4 (inner offset 1, plus the
    // payload's outer start at 3). The extension must translate that inner
    // offset back to the outer position before forwarding to onWarning.
    const warnings: { message: string; offset: number }[] = [];
    const r = decodeCBOR(hex('d8184261ff'), {
      strict: false,
      onWarning: (w) => warnings.push(w),
    }) as CborTag;
    expect(r.tag).toBe(24n);
    expect(r.content).toBeInstanceOf(CborEmbeddedCBOR);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe('invalid UTF-8 sequence in text string');
    expect(warnings[0]!.offset).toBe(4);
  });

  test('tag(24, byte-string with 2-byte length for 1-byte content) → 24(<<1>>_1)', () => {
    // d8 18 = tag(24, 1-byte number)
    // 59 0001 = byte-string with 2-byte length=1 (non-canonical; canonical is 41)
    // 01 = inner CBOR: uint(1)
    // The CborEmbeddedCBOR must carry the outer byte-string's encodingWidth.
    const r = decodeCBOR(hex('d8 18 59 0001 01')) as CborTag;
    expect(r.tag).toBe(24n);
    expect(r.content).toBeInstanceOf(CborEmbeddedCBOR);
    expect((r.content as CborEmbeddedCBOR).encodingWidth).toBe(1);
    expect(r.toCDN()).toBe('24(<<1>>_1)');
  });
});
