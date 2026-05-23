/**
 * CBOR bignum tags (RFC 8949 §3.4.3).
 *
 *   Tag 2 — unsigned bignum: tag(2, bstr) where bstr is the big-endian
 *            encoding of a non-negative integer.
 *   Tag 3 — negative bignum: tag(3, bstr) where the value = -1 - unsigned(bstr).
 *
 * These classes are used for integers that fall outside the uint64 / nint64
 * range of CBOR major types 0 and 1:
 *   CborBigUint  — value ≥ 2^64
 *   CborBigNint  — value ≤ -(2^64 + 1)
 *
 * toCDN() emits the plain decimal form (e.g. "18446744073709551616") so that
 * round-trips through EDN text are human-readable.
 */

import type { ToCDNOptions, ToJSOptions } from '../types';
import { CborTag } from './CborTag';
import { CborByteString } from './CborByteString';

export const BIGNUM_UINT_TAG = 2n;
export const BIGNUM_NINT_TAG = 3n;

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const NINT64_MIN = -(UINT64_MAX + 1n); // -18446744073709551616n

// ─── Bigint ↔ bytes helpers ───────────────────────────────────────────────────

/**
 * Encode a non-negative bigint as a minimal big-endian byte string.
 * Zero is encoded as the empty byte string per RFC 8949 §3.4.3.
 */
export function bigintToBytes(n: bigint): Uint8Array {
  if (n < 0n)
    throw new RangeError('bigintToBytes requires a non-negative value');
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Decode a big-endian byte string to a non-negative bigint.
 * Empty bytes → 0n.
 */
export function bytesToBigint(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

// ─── AST nodes ────────────────────────────────────────────────────────────────

/**
 * Unsigned bignum — integers ≥ 2^64.
 * Wire format: tag(2, big-endian byte string).
 * toCDN() emits the plain decimal integer.
 */
export class CborBigUint extends CborTag {
  readonly bigValue: bigint;

  constructor(value: bigint) {
    if (value <= UINT64_MAX)
      throw new RangeError(
        `CborBigUint value ${value} fits in CborUint; use CborUint instead`
      );
    super(BIGNUM_UINT_TAG, new CborByteString(bigintToBytes(value)));
    this.bigValue = value;
  }

  override _toCDN(_options: ToCDNOptions | undefined, _depth: number): string {
    return this.bigValue.toString();
  }

  override _toJS(_options?: ToJSOptions): bigint {
    return this.bigValue;
  }
}

/**
 * Negative bignum — integers ≤ -(2^64 + 1).
 * Wire format: tag(3, big-endian byte string of (-1 - value)).
 * toCDN() emits the plain decimal integer.
 */
export class CborBigNint extends CborTag {
  readonly bigValue: bigint;

  constructor(value: bigint) {
    if (value >= NINT64_MIN)
      throw new RangeError(
        `CborBigNint value ${value} fits in CborNint; use CborNint instead`
      );
    super(BIGNUM_NINT_TAG, new CborByteString(bigintToBytes(-1n - value)));
    this.bigValue = value;
  }

  override _toCDN(_options: ToCDNOptions | undefined, _depth: number): string {
    return this.bigValue.toString();
  }

  override _toJS(_options?: ToJSOptions): bigint {
    return this.bigValue;
  }
}
