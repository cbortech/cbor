/**
 * Hex codec helpers shared by the CDN serializer, parser, and extensions.
 *
 * Native `Uint8Array.prototype.toHex` is the fastest option at every size, so
 * it is used whenever available. Native `Uint8Array.fromHex` carries a fixed
 * ~300–400 ns argument-validation overhead per call (measured on Node 25/26),
 * which makes a lookup-table loop 5–6× faster for small payloads such as
 * UUIDs; native only wins from ~128 bytes up. `hexToBytes` therefore switches
 * implementations on input length.
 */

const HEX_DIGITS = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0')
);

// Maps hex char codes (both cases) to their value; -1 marks invalid chars so
// the decode loop can detect them with a single sign check per byte.
const HEX_VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < 16; i++) {
  HEX_VALUES['0123456789abcdef'.charCodeAt(i)] = i;
  HEX_VALUES['0123456789ABCDEF'.charCodeAt(i)] = i;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _hasNativeToHex =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof (Uint8Array.prototype as any).toHex === 'function';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _hasNativeFromHex =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof (Uint8Array as any).fromHex === 'function';

// Below this many hex digits the LUT loop beats native fromHex.
const NATIVE_FROM_HEX_MIN_DIGITS = 256;

/** Encode bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (_hasNativeToHex) return (bytes as any).toHex();
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX_DIGITS[bytes[i]!];
  return out;
}

// Uppercase table for the annotated hex-dump format (RFC 8949 §3 style).
const HEX_DIGITS_UPPER = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).toUpperCase().padStart(2, '0')
);

/** Encode one byte as two uppercase hex digits (e.g. 10 → "0A"). */
export function byteToHexUpper(b: number): string {
  return HEX_DIGITS_UPPER[b]!;
}

/** Encode bytes as space-separated uppercase hex (e.g. "0A FF"), the
 *  per-line format used by `toHexDump()`. */
export function bytesToSpacedHexUpper(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0) out += ' ';
    out += HEX_DIGITS_UPPER[bytes[i]!];
  }
  return out;
}

/**
 * Decode a hex string to bytes.
 *
 * Throws SyntaxError on odd-length input or non-hex characters (the native
 * fromHex path throws its own SyntaxError with a different message).
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0)
    throw new SyntaxError(`hex string has odd length: ${hex.length}`);
  if (_hasNativeFromHex && hex.length >= NATIVE_FROM_HEX_MIN_DIGITS)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Uint8Array as any).fromHex(hex) as Uint8Array;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0, j = 0; i < hex.length; i += 2, j++) {
    const c1 = hex.charCodeAt(i);
    const c2 = hex.charCodeAt(i + 1);
    const hi = c1 < 128 ? HEX_VALUES[c1]! : -1;
    const lo = c2 < 128 ? HEX_VALUES[c2]! : -1;
    if ((hi | lo) < 0) {
      const bad = hi < 0 ? hex[i]! : hex[i + 1]!;
      throw new SyntaxError(
        `invalid character ${JSON.stringify(bad)} in hex string`
      );
    }
    out[j] = (hi << 4) | lo;
  }
  return out;
}
