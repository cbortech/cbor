/**
 * `same<<expr, expr, ...>>` app-sequence extension.
 *
 * Evaluates every item in the sequence to CBOR bytes and asserts that all
 * produce identical bytes.  Returns the first item if all match.
 *
 * In strict mode a mismatch throws a `SyntaxError`.  In lenient mode
 * (`strict: false`) a mismatch emits a `ParseWarning` and returns the first
 * item so parsing can continue.
 *
 * `same<<x>>` (single item) is a no-op assertion that always passes.
 *
 * The parsed result is wrapped in `CborAppSeqResult` so that `toCDN()` round-trips
 * the original `same<<...>>` notation.  `toCBOR()` and `toJS()` delegate
 * transparently to the inner item; `appStrings: false` produces the resolved value.
 * The result is not directly `instanceof` the inner item's class.
 *
 * This extension is a testing/validation construct from the cabo/edn-abnf
 * corpus and is NOT part of draft-ietf-cbor-edn-literals.  It is not included
 * in the default extension set.  Add it explicitly:
 *
 * @example
 * import { same } from '@cbortech/cbor';
 * parseCDN("same<<b64'AA',h'00'>>", { extensions: [same] }); // h'00'
 */

import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Extension object for `same<<...>>`.
 * Pass to `parseCDN(..., { extensions: [same] })`.
 */
export const same: CborExtension = {
  appStringPrefixes: ['same'],
  preserveAppSeqSource: true,

  parseAppSequence(
    _prefix: string,
    items: CborItem[],
    onError?: (msg: string) => void
  ): CborItem {
    if (items.length === 0)
      throw new SyntaxError(`same<<...>> requires at least one item`);
    const first = items[0]!;
    const firstCbor = first.toCBOR();
    for (let i = 1; i < items.length; i++) {
      const otherCbor = items[i]!.toCBOR();
      if (!bytesEqual(firstCbor, otherCbor)) {
        const msg = `same<<...>>: item ${i} produces different CBOR bytes than item 0`;
        if (onError)
          onError(msg); // lenient: warn + return first item
        else throw new SyntaxError(msg);
      }
    }
    return first;
  },
};

export default same;
