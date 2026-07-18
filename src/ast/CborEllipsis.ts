/**
 * §4.2 of draft-ietf-cbor-edn-literals-25 — Ellipsis (Elision) tag.
 *
 * Two forms:
 *   888(null)          — subtree elision:    a whole data item replaced by ...
 *   888([frag, 888(null), frag, ...])
 *                      — string/bytes elision: fragments alternating with ellipses
 *
 * Note: CPA888 is a provisional tag number.
 */

import type { ToCDNOptions } from '../types';
import { CborTag } from './CborTag';
import { CborArray } from './CborArray';
import { CborSimple } from './CborSimple';
import type { CborItem } from './CborItem';
import { joinConcatParts, resolveIndent } from '../cdn/serialize-utils';

export const CPA888_TAG = 888n;

export class CborEllipsis extends CborTag {
  /** Subtree elision: 888(null) */
  constructor();
  /** String/bytes elision: 888([items...]) */
  constructor(items: CborItem[]);
  constructor(items?: CborItem[]) {
    if (items === undefined) {
      super(CPA888_TAG, CborSimple.NULL);
    } else {
      super(CPA888_TAG, new CborArray(items));
    }
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, depth);
    if (this.content instanceof CborSimple) {
      // Subtree elision → "..."
      return '...';
    }
    if (this.content instanceof CborArray) {
      // String/bytes elision → frag + ... + frag
      const parts = this.content.items.map((item) =>
        item._toCDN(options, depth)
      );
      if (parts.length === 0) return '';
      return joinConcatParts(parts, resolveIndent(options), depth);
    }
    return super._toCDN(options, depth);
  }
}
