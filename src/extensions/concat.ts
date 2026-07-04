/**
 * `t1'...'` / `t1<<...>>` and `b1'...'` / `b1<<...>>` string-concatenation
 * app-extensions (§3.4 of draft-ietf-cbor-edn-literals-26).
 *
 * Builds a single (text or byte) string by joining the bytes of the (text or
 * byte) string arguments from left to right:
 *   - `t1` produces a text string; the joined bytes must be valid UTF-8.
 *   - `b1` produces a byte string.
 * Text and byte strings can mix within one concatenation.
 *
 * Arguments may include ellipses (`...`); the result is then an ellipsis
 * data item — tag CPA888 wrapping an array of joined string spans
 * alternating with `888(null)` markers (§4.2).  Adjacent ellipses collapse
 * into one, and nested ellipsis arguments are flattened.
 *
 * `t1` and `b1` are mandatory-to-implement in draft-26 and are included in
 * the default extension set.
 *
 * NOTE: the identifiers "t1" and "b1" are explicitly provisional in
 * draft-26 (§3.4) and may be renamed by the CBOR WG.
 */

import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborTextString } from '../ast/CborTextString';
import { CborByteString } from '../ast/CborByteString';
import { CborIndefiniteTextString } from '../ast/CborIndefiniteTextString';
import { CborIndefiniteByteString } from '../ast/CborIndefiniteByteString';
import { CborEllipsis } from '../ast/CborEllipsis';
import { CborAppSeqResult } from '../ast/CborAppSeqResult';
import { CborArray } from '../ast/CborArray';

const textEncoder = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Lenient = new TextDecoder('utf-8', { fatal: false });

/** Marker for an elision within the flattened argument list. */
const ELLIPSIS = Symbol('ellipsis');
type Part = Uint8Array | typeof ELLIPSIS;

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Flatten one argument into byte spans and ellipsis markers.
 * Nested ellipsis items (e.g. from `h'aa...bb'` arguments) are expanded so
 * that the equivalences of §3.4 hold.
 */
function flattenArg(prefix: string, item: CborItem, parts: Part[]): void {
  if (item instanceof CborAppSeqResult) {
    flattenArg(prefix, item.inner, parts);
    return;
  }
  if (item instanceof CborEllipsis) {
    if (item.content instanceof CborArray) {
      for (const inner of item.content.items) flattenArg(prefix, inner, parts);
    } else {
      parts.push(ELLIPSIS);
    }
    return;
  }
  if (item instanceof CborTextString) {
    parts.push(textEncoder.encode(item.value));
    return;
  }
  if (item instanceof CborByteString) {
    parts.push(item.value);
    return;
  }
  if (item instanceof CborIndefiniteTextString) {
    parts.push(textEncoder.encode(item.chunks.map((c) => c.value).join('')));
    return;
  }
  if (item instanceof CborIndefiniteByteString) {
    parts.push(concatBytes(item.chunks.map((c) => c.value)));
    return;
  }
  throw new SyntaxError(
    `${prefix}<<...>> arguments must be (text or byte) strings or ellipses`
  );
}

/** Decode joined bytes as UTF-8; recoverable violation when invalid. */
function decodeText(
  bytes: Uint8Array,
  onError: ((msg: string) => void) | undefined
): string {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    const msg = `t1 concatenation result is not valid UTF-8`;
    if (onError) onError(msg);
    else throw new SyntaxError(msg);
    return utf8Lenient.decode(bytes);
  }
}

function concatenate(
  prefix: string,
  items: CborItem[],
  onError?: (msg: string) => void
): CborItem {
  const parts: Part[] = [];
  for (const item of items) flattenArg(prefix, item, parts);

  const isText = prefix === 't1';

  // Consolidate adjacent byte spans; collapse adjacent ellipses (§3.4).
  const fragments: CborItem[] = [];
  let hasEllipsis = false;
  const pending: Uint8Array[] = [];
  const flushPending = () => {
    if (pending.length === 0) return;
    const bytes = concatBytes(pending);
    pending.length = 0;
    if (bytes.length === 0) return; // empty spans add nothing to the 888 array
    fragments.push(
      isText
        ? new CborTextString(decodeText(bytes, onError))
        : new CborByteString(bytes)
    );
  };
  for (const part of parts) {
    if (part === ELLIPSIS) {
      flushPending();
      if (!(fragments[fragments.length - 1] instanceof CborEllipsis)) {
        fragments.push(new CborEllipsis());
        hasEllipsis = true;
      }
    } else {
      pending.push(part);
    }
  }

  if (!hasEllipsis) {
    const bytes = concatBytes(pending);
    return isText
      ? new CborTextString(decodeText(bytes, onError))
      : new CborByteString(bytes);
  }
  flushPending();

  // A lone ellipsis argument list is equivalent to a single ellipsis.
  if (fragments.length === 1) return new CborEllipsis();
  return new CborEllipsis(fragments);
}

function makeExtension(prefix: 't1' | 'b1'): CborExtension {
  return {
    appStringPrefixes: [prefix],
    preserveAppSeqSource: true,

    // prefix'...' / prefix`...` is shorthand for a sequence with exactly
    // that one text string (§2.1).
    parseAppString(_prefix, content, onError) {
      return concatenate(prefix, [new CborTextString(content)], onError);
    },

    parseAppSequence(_prefix, items, onError) {
      return concatenate(prefix, items, onError);
    },
  };
}

/** Extension object for `t1'...'` / `t1<<...>>` (text-string concatenation). */
export const t1: CborExtension = makeExtension('t1');

/** Extension object for `b1'...'` / `b1<<...>>` (byte-string concatenation). */
export const b1: CborExtension = makeExtension('b1');
