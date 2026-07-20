/**
 * Structural equality and value-access helpers over CBOR AST nodes,
 * used by the CDDL validator for literal matching, map-key comparison,
 * enumerations, and the .eq/.ne control operators.
 *
 * Equality is CDDL value equality, not byte equality: encoding widths and
 * definite/indefinite length are ignored (an indefinite-length "a", "b"
 * equals the definite "ab"), but CBOR type classes stay distinct — an
 * integer never equals a float, and a bignum (tag 2/3) never equals a
 * plain integer.
 */

import { CborItem } from '../ast/CborItem';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborFloat } from '../ast/CborFloat';
import { CborSimple } from '../ast/CborSimple';
import { CborTextString } from '../ast/CborTextString';
import { CborIndefiniteTextString } from '../ast/CborIndefiniteTextString';
import { CborByteString } from '../ast/CborByteString';
import { CborIndefiniteByteString } from '../ast/CborIndefiniteByteString';
import { CborEmbeddedCBOR } from '../ast/CborEmbeddedCBOR';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborTag } from '../ast/CborTag';
import { CborBigUint, CborBigNint } from '../ast/CborBignum';

/**
 * The integer value of a node, including bignums (tags 2/3): CDDL *values*
 * are abstract numbers, so literals, ranges, and comparison operators must
 * see 2^64 the same way whether it arrived as a basic int or as a bignum.
 * (Type matching stays structural: a bignum is a tagged item, not #0/#1.)
 */
export function intValueOf(item: CborItem): bigint | undefined {
  if (item instanceof CborUint || item instanceof CborNint) return item.value;
  if (item instanceof CborBigUint || item instanceof CborBigNint)
    return item.bigValue;
  return undefined;
}

/** The text value of a (possibly indefinite-length) text string node. */
export function textValue(item: CborItem): string | undefined {
  if (item instanceof CborTextString) return item.value;
  if (item instanceof CborIndefiniteTextString)
    return item.chunks.map((c) => c.value).join('');
  return undefined;
}

/**
 * The byte content of a byte-string-like node: a (possibly
 * indefinite-length) byte string, or an `<<…>>` embedded-CBOR literal
 * (whose value is the encoding of its items).
 */
export function byteValue(item: CborItem): Uint8Array | undefined {
  if (item instanceof CborByteString) return item.value;
  if (item instanceof CborIndefiniteByteString) {
    const parts = item.chunks.map((c) => c.value);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
  if (item instanceof CborEmbeddedCBOR) {
    const parts = item.items.map((i) => i.toCBOR());
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
  return undefined;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** CDDL value equality of two CBOR AST nodes (see module doc). */
export function equalItems(a: CborItem, b: CborItem): boolean {
  if (a === b) return true;

  if (a instanceof CborUint)
    return b instanceof CborUint && a.value === b.value;
  if (a instanceof CborNint)
    return b instanceof CborNint && a.value === b.value;
  if (a instanceof CborFloat)
    return (
      b instanceof CborFloat &&
      (a.value === b.value || (Number.isNaN(a.value) && Number.isNaN(b.value)))
    );
  if (a instanceof CborSimple)
    return b instanceof CborSimple && a.value === b.value;

  const aText = textValue(a);
  if (aText !== undefined) {
    const bText = textValue(b);
    return bText !== undefined && aText === bText;
  }
  const aBytes = byteValue(a);
  if (aBytes !== undefined) {
    const bBytes = byteValue(b);
    return bBytes !== undefined && bytesEqual(aBytes, bBytes);
  }

  if (a instanceof CborArray)
    return (
      b instanceof CborArray &&
      a.items.length === b.items.length &&
      a.items.every((item, i) => equalItems(item, b.items[i]!))
    );

  if (a instanceof CborMap) {
    if (!(b instanceof CborMap) || a.entries.length !== b.entries.length)
      return false;
    // Order-insensitive with one-to-one consumption.
    const used = new Array<boolean>(b.entries.length).fill(false);
    for (const [ak, av] of a.entries) {
      let found = false;
      for (let i = 0; i < b.entries.length; i++) {
        if (used[i]) continue;
        const [bk, bv] = b.entries[i]!;
        if (equalItems(ak, bk) && equalItems(av, bv)) {
          used[i] = true;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  // Tags last: bignums, embedded app extensions, etc. are CborTag subclasses.
  if (a instanceof CborTag)
    return (
      b instanceof CborTag &&
      a.tag === b.tag &&
      equalItems(a.content, b.content)
    );

  return false;
}
