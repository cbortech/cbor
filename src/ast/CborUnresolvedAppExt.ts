/**
 * §4.1 draft-ietf-cbor-edn-literals-20 — Stand-in for unknown app-extensions.
 *
 * When the EDN parser encounters an unrecognised application-extension
 * identifier (the default `unresolvedExtension: 'cpa999'` behaviour), it wraps
 * the literal in a CPA999 tag instead of throwing a SyntaxError.
 *
 * Structure:
 *   CPA999([<prefix>, [<content-items...>]])
 *
 * Examples:
 *   cri'https://example.com'   → CPA999(["cri", ["https://example.com"]])
 *   hash<<"data", -44>>        → CPA999(["hash", ["data", -44]])
 *
 * toCDN() reconstructs the original app-string / app-sequence notation:
 *   CPA999(["cri", ["https://example.com"]]) → cri'https://example.com'
 *   CPA999(["hash", ["data", -44]])           → hash<<"data", -44>>
 *
 * Note: CPA999 is a provisional tag number (CPA = Code Point Allocation).
 * It will be replaced by an IANA-assigned tag number upon RFC publication.
 */

import type { ToCDNOptions } from '../types';
import { CborTag } from './CborTag';
import { CborArray } from './CborArray';
import { CborTextString } from './CborTextString';
import type { CborItem } from './CborItem';
import { escapeAppString } from '../edn/serialize-utils';

/** Provisional tag number for the Unresolved Application-Extension stand-in. */
export const CPA999_TAG = 999n;

/**
 * Stand-in for an unrecognised EDN application-extension literal.
 *
 * Structure:
 *   App-string:  CPA999([prefix, text])
 *   App-sequence: CPA999([prefix, [items...]])
 */
export class CborUnresolvedAppExt extends CborTag {
  constructor(prefix: string, items: CborItem[]) {
    // App-string: single text item → tag(999, [prefix, text])
    // App-sequence: otherwise → tag(999, [prefix, [items...]])
    const content =
      items.length === 1 && items[0] instanceof CborTextString
        ? items[0]
        : new CborArray(items);
    super(CPA999_TAG, new CborArray([new CborTextString(prefix), content]));
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    const arr = this.content as CborArray;
    const prefix = (arr.items[0] as CborTextString).value;
    const contentItem = arr.items[1];

    // Text string → reconstruct app-string form: prefix'content'
    if (contentItem instanceof CborTextString) {
      return `${prefix}${escapeAppString(contentItem.value)}`;
    }

    // Array → reconstruct app-sequence form: prefix<<item, item, ...>>
    const contentArr = contentItem as CborArray;
    const inner = contentArr.items
      .map((item) => item._toCDN(options, depth))
      .join(', ');
    return `${prefix}<<${inner}>>`;
  }
}
