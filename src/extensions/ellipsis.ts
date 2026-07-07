/**
 * Core decode support for the CPA888 ellipsis (elision) tag (§4.2 of
 * draft-ietf-cbor-edn-literals-26).
 *
 * Intercepts tag 888 during fromCBOR() and integer-tagged EDN parsing so
 * that elided items decode back to CborEllipsis and round-trip as `...`
 * notation instead of `888(null)` / `888([...])`.
 *
 * Ellipsis is core EDN syntax (the CDN parser handles `...` directly, not
 * via an app-string extension), so this lives in CORE_EXTENSIONS and is not
 * affected by the `builtinExtensions` option.
 */

import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborEllipsis, CPA888_TAG } from '../ast/CborEllipsis';
import { CborArray } from '../ast/CborArray';
import { CborSimple } from '../ast/CborSimple';
import { CborTextString } from '../ast/CborTextString';
import { CborByteString } from '../ast/CborByteString';

/** Subtree elision marker: 888(null), already reconstructed bottom-up. */
function isSubtreeEllipsis(item: CborItem): boolean {
  return item instanceof CborEllipsis && !(item.content instanceof CborArray);
}

/**
 * A well-formed string-elision array: string fragments of a single kind
 * (all text or all byte) strictly alternating with at least one subtree
 * ellipsis (`h'...'` yields the single-item form `888([888(null)])`).
 * Any other shape stays a plain CborTag — a lenient reconstruction (e.g. of
 * adjacent fragments or adjacent ellipses) would not re-parse to the same
 * data item.
 */
function isElisionArray(items: readonly CborItem[]): boolean {
  let text = false;
  let byte = false;
  let sawEllipsis = false;
  let prevWasEllipsis: boolean | undefined;
  for (const item of items) {
    let isEllipsis: boolean;
    if (isSubtreeEllipsis(item)) {
      isEllipsis = true;
      sawEllipsis = true;
    } else if (item instanceof CborTextString) {
      isEllipsis = false;
      text = true;
    } else if (item instanceof CborByteString) {
      isEllipsis = false;
      byte = true;
    } else {
      return false;
    }
    if (isEllipsis === prevWasEllipsis) return false; // no strict alternation
    prevWasEllipsis = isEllipsis;
  }
  return sawEllipsis && !(text && byte); // fragments must be homogeneous
}

export const ellipsis: CborExtension = {
  tagNumbers: [CPA888_TAG],

  parseTag(tag: bigint, value: CborItem): CborItem | undefined {
    if (tag !== CPA888_TAG) return undefined;
    if (value instanceof CborSimple && value.value === 22)
      return new CborEllipsis();
    if (value instanceof CborArray && isElisionArray(value.items))
      return new CborEllipsis(value.items);
    return undefined;
  },
};

export default ellipsis;
