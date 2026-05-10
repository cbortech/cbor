/**
 * Built-in bignum extension (RFC 8949 §3.4.3).
 *
 * Intercepts tag 2 (unsigned bignum) and tag 3 (negative bignum) during
 * fromCBOR() and fromEDN() so that out-of-range values are decoded as
 * CborBigUint / CborBigNint rather than plain CborTag nodes.
 *
 * In-range values (those that fit in uint64 / nint64) are left as plain
 * CborTag so that non-canonical bignum encodings of small integers don't
 * silently change behaviour.
 */

import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborByteString } from '../ast/CborByteString';
import {
  CborBigUint,
  CborBigNint,
  bytesToBigint,
  BIGNUM_UINT_TAG,
  BIGNUM_NINT_TAG,
} from '../ast/CborBignum';

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const NINT64_MIN = -(UINT64_MAX + 1n);

export const bignum: CborExtension = {
  tagNumbers: [BIGNUM_UINT_TAG, BIGNUM_NINT_TAG],

  parseTag(tag: bigint, value: CborItem): CborItem | undefined {
    if (!(value instanceof CborByteString)) return undefined;

    if (tag === BIGNUM_UINT_TAG) {
      const n = bytesToBigint(value.value);
      if (n > UINT64_MAX) return new CborBigUint(n);
      return undefined; // fits in uint64 — leave as plain CborTag
    }

    if (tag === BIGNUM_NINT_TAG) {
      const n = -1n - bytesToBigint(value.value);
      if (n < NINT64_MIN) return new CborBigNint(n);
      return undefined; // fits in nint64 — leave as plain CborTag
    }

    return undefined;
  },
};

export default bignum;
