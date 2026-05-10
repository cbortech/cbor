/**
 * Standard EDN "hash" application-extension (§3.3 draft-ietf-cbor-edn-literals-22).
 *
 * Computes a cryptographic hash of the input and returns it as a byte string.
 * The hash algorithm is identified by its COSE Algorithms registry entry.
 *
 * Syntax:
 *   hash'foo'                    → SHA-256 hash of UTF-8 "foo" (default: COSE -16)
 *   hash<<'foo'>>                → same
 *   hash<<'foo', -16>>           → explicit SHA-256 by COSE integer ID
 *   hash<<'foo', "SHA-256">>     → explicit SHA-256 by COSE name
 *   hash<<'foo', -44>>           → SHA-512 (COSE -44)
 *   hash<<'foo', -17>>           → SHA-512/256 (COSE -17)
 *   hash<<'foo', -18>>           → SHAKE128 256-bit (COSE -18)
 *   hash<<'foo', -45>>           → SHAKE256 512-bit (COSE -45)
 *   hash<<h'0102', -16>>         → SHA-256 of raw bytes h'0102'
 *
 * Note: No uppercase "HASH" variant exists (§3.3: "No uppercase variant prefix
 * is defined for the application-extension identifier 'hash'").
 */

import type { ToEDNOptions } from '../types';
import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborByteString } from '../ast/CborByteString';
import { CborTextString } from '../ast/CborTextString';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { escapeAppString, serializeBytes } from '../edn/serialize-utils';
import { sha256, sha384, sha512, sha512_256 } from '@noble/hashes/sha2.js';
import { shake128_32, shake256_64 } from '@noble/hashes/sha3.js';
import { sha1 } from '@noble/hashes/legacy.js';

// ─── COSE Algorithm table (RFC 9054) ─────────────────────────────────────────

type HashFn = (data: Uint8Array) => Uint8Array;

/** COSE algorithm ID → hash function (all 8 entries from RFC 9054) */
const COSE_HASH_FN = new Map<number, HashFn>([
  [-14, sha1],
  [-15, (data) => sha256(data).slice(0, 8)], // SHA-256/64: truncate to 64 bits
  [-16, sha256],
  [-17, sha512_256], // SHA-512/256
  [-18, shake128_32], // SHAKE128 256-bit output
  [-43, sha384],
  [-44, sha512],
  [-45, shake256_64], // SHAKE256 512-bit output
]);

/** COSE algorithm name → COSE ID */
const COSE_NAME_TO_ID = new Map<string, number>([
  ['SHA-1', -14],
  ['SHA-256/64', -15],
  ['SHA-256', -16],
  ['SHA-512/256', -17],
  ['SHAKE128', -18],
  ['SHA-384', -43],
  ['SHA-512', -44],
  ['SHAKE256', -45],
]);

/** COSE ID → algorithm name (reverse of COSE_NAME_TO_ID) */
const COSE_ID_TO_NAME = new Map<number, string>(
  [...COSE_NAME_TO_ID.entries()].map(([name, id]) => [id, name])
);

// ─── CborHashExt ──────────────────────────────────────────────────────────────

/**
 * A byte string produced by a hash'…' or hash<<…>> literal.
 * Remembers the original input and algorithm so toEDN() can reconstruct
 * the hash notation when appStrings is not false.
 */
export class CborHashExt extends CborByteString {
  private readonly _input: CborTextString | CborByteString;
  private readonly _algorithmId: number;

  constructor(
    output: Uint8Array,
    input: CborTextString | CborByteString,
    algorithmId: number
  ) {
    super(output);
    this._input = input;
    this._algorithmId = algorithmId;
  }

  override _toEDN(options: ToEDNOptions | undefined, _depth: number): string {
    if (options?.appStrings === false) return super._toEDN(options, _depth);

    const isDefault = this._algorithmId === -16;

    if (this._input instanceof CborTextString && isDefault) {
      return `hash${escapeAppString(this._input.value)}`;
    }

    const dataEdn =
      this._input instanceof CborTextString
        ? escapeAppString(this._input.value)
        : serializeBytes(
            this._input.value,
            options?.bstrEncoding ?? 'hex',
            options?.sqstr
          );

    if (isDefault) return `hash<<${dataEdn}>>`;

    const algoEdn = COSE_ID_TO_NAME.has(this._algorithmId)
      ? `"${COSE_ID_TO_NAME.get(this._algorithmId)}"`
      : String(this._algorithmId);
    return `hash<<${dataEdn}, ${algoEdn}>>`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveAlgorithmId(item: CborItem): number {
  if (item instanceof CborUint) return Number(item.value);
  if (item instanceof CborNint) return Number(item.value);
  if (item instanceof CborTextString) {
    const id = COSE_NAME_TO_ID.get(item.value);
    if (id === undefined)
      throw new SyntaxError(
        `hash: unknown algorithm name: ${JSON.stringify(item.value)}`
      );
    return id;
  }
  throw new SyntaxError('hash: algorithm must be an integer or text string');
}

function computeHash(
  input: CborTextString | CborByteString,
  algorithmId: number
): CborHashExt {
  const data =
    input instanceof CborTextString
      ? new TextEncoder().encode(input.value)
      : input.value;
  const fn = COSE_HASH_FN.get(algorithmId);
  if (!fn)
    throw new SyntaxError(`hash: unsupported COSE algorithm ID ${algorithmId}`);
  return new CborHashExt(fn(data), input, algorithmId);
}

// ─── Extension factory ────────────────────────────────────────────────────────

export const hash: CborExtension = {
  appStringPrefixes: ['hash'],

  parseAppString(_prefix, content) {
    return computeHash(new CborTextString(content), -16);
  },

  parseAppSequence(_prefix, items) {
    if (items.length === 0 || items.length > 2)
      throw new SyntaxError(
        `hash<<...>>: expected 1 or 2 items, got ${items.length}`
      );
    const input = items[0];
    if (
      !(input instanceof CborTextString) &&
      !(input instanceof CborByteString)
    )
      throw new SyntaxError(
        'hash: first argument must be a text or byte string'
      );
    const algorithmId = items.length === 2 ? resolveAlgorithmId(items[1]) : -16;
    return computeHash(input, algorithmId);
  },
};

export default hash;
