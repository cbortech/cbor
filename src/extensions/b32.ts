import type { CborExtension } from './types';
import { CborByteString } from '../ast/CborByteString';
import { stripComments } from '../utils/strip-comments';

const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const H32_ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUV';

function stripBase32Padding(str: string): string {
  let end = str.length;
  while (end > 0 && str.charCodeAt(end - 1) === 0x3d) end--;
  return str.slice(0, end);
}

function base32Decode(
  str: string,
  alpha: string,
  onError?: (msg: string) => void
): Uint8Array {
  // Padding is optional; strip it before decoding.
  const s = stripBase32Padding(str).toUpperCase();
  // RFC 4648 §6: valid unpadded lengths mod 8 are 0, 2, 4, 5, 7.
  // Lengths 1, 3, 6 can never result from any valid byte sequence.
  const rem = s.length % 8;
  if (rem === 1 || rem === 3 || rem === 6)
    throw new SyntaxError(`invalid base32 length: ${s.length} characters`);
  const lookup = new Uint8Array(128).fill(0xff);
  for (let i = 0; i < alpha.length; i++) lookup[alpha.charCodeAt(i)] = i;
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let buf = 0,
    bufBits = 0,
    outIdx = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    const val = code < 128 ? lookup[code] : 0xff;
    if (val === 0xff)
      throw new SyntaxError(
        `invalid character in byte string: ${JSON.stringify(ch)}`
      );
    buf = (buf << 5) | val;
    bufBits += 5;
    if (bufBits >= 8) {
      bufBits -= 8;
      out[outIdx++] = (buf >> bufBits) & 0xff;
    }
  }
  // RFC 4648 §3.5: trailing bits in the final quantum must be zero.
  if (bufBits > 0 && (buf & ((1 << bufBits) - 1)) !== 0) {
    const msg = 'non-zero trailing bits in base32 input';
    if (onError) onError(msg);
    else throw new SyntaxError(msg);
  }
  return out;
}

/** RFC 4648 §6 Base32 (A–Z 2–7) app-string extension. */
export const b32: CborExtension = {
  appStringPrefixes: ['b32'],
  parseAppString(_prefix, content, onError) {
    return new CborByteString(
      base32Decode(stripComments(content), B32_ALPHA, onError),
      {
        ednEncoding: 'base32',
      }
    );
  },
};

/** RFC 4648 §7 Base32Hex (0–9 A–V) app-string extension. */
export const h32: CborExtension = {
  appStringPrefixes: ['h32'],
  parseAppString(_prefix, content, onError) {
    return new CborByteString(
      base32Decode(stripComments(content), H32_ALPHA, onError),
      {
        ednEncoding: 'base32hex',
      }
    );
  },
};
