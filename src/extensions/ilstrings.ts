/**
 * `ilbs'...'` / `ilbs<<...>>` and `ilts'...'` / `ilts<<...>>` app-extensions
 * (§3.5 of draft-ietf-cbor-edn-literals-26) — build indefinite-length
 * encoded strings.
 *
 * Semantically identical to `b1` / `t1` at the data model level, but instead
 * of concatenating the arguments into a single string, one chunk is created
 * per argument:
 *   - `ilbs` produces an indefinite-length byte string (byte chunks),
 *   - `ilts` produces an indefinite-length text string (text chunks).
 *
 * Encoding indicators on individual arguments are honored — the chunk keeps
 * the same encoding (e.g. `ilbs<<'Hello '_0, 'world'>>` → `5f 5806 ... ff`).
 * An indefinite-length string argument (e.g. a legacy `(_ ...)` streamstring)
 * is a string at the data model level and contributes one chunk with its
 * merged value.  Ellipses cannot be used: there is no way to include an
 * elision in an indefinite-length string.
 *
 * These extensions replace the now-deprecated `(_ chunk, ...)` streamstring
 * syntax for new CDN documents (§2.5.5); this library keeps accepting the
 * legacy syntax on input.
 */

import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import type { EncodingWidth } from '../cbor/encode';
import { CborTextString } from '../ast/CborTextString';
import { CborByteString } from '../ast/CborByteString';
import { CborIndefiniteTextString } from '../ast/CborIndefiniteTextString';
import { CborIndefiniteByteString } from '../ast/CborIndefiniteByteString';
import { CborEllipsis } from '../ast/CborEllipsis';
import { CborAppSeqResult } from '../ast/CborAppSeqResult';
import { escapeAppString } from '../cdn/serialize-utils';

const textEncoder = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Lenient = new TextDecoder('utf-8', { fatal: false });

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

function buildIndefinite(
  prefix: string,
  items: CborItem[],
  onError?: (msg: string) => void
): CborItem {
  const isText = prefix === 'ilts';
  const byteChunks: CborByteString[] = [];
  const textChunks: CborTextString[] = [];

  for (let item of items) {
    if (item instanceof CborAppSeqResult) item = item.inner;
    if (item instanceof CborEllipsis)
      throw new SyntaxError(
        `${prefix}<<...>> cannot contain ellipses; there is no way to include an elision in an indefinite-length string`
      );

    // Normalize the argument to its data-model string value.  Indefinite-
    // length string arguments (e.g. a legacy `(_ ...)` streamstring) are
    // strings at the data model level; their merged value becomes one chunk.
    let argText: string | undefined;
    let argBytes: Uint8Array | undefined;
    // Encoding indicators are only carried by definite-length arguments.
    let ew: EncodingWidth | undefined;
    if (item instanceof CborTextString) {
      argText = item.value;
      ew = item.encodingWidth;
    } else if (item instanceof CborByteString) {
      argBytes = item.value;
      ew = item.encodingWidth;
    } else if (item instanceof CborIndefiniteTextString) {
      argText = item.chunks.map((c) => c.value).join('');
    } else if (item instanceof CborIndefiniteByteString) {
      argBytes = concatBytes(item.chunks.map((c) => c.value));
    } else {
      throw new SyntaxError(
        `${prefix}<<...>> arguments must be (text or byte) strings`
      );
    }

    // One chunk per argument, keeping the argument's encoding indicator.
    if (isText) {
      let text: string;
      if (argText !== undefined) {
        text = argText;
      } else {
        try {
          text = utf8Strict.decode(argBytes!);
        } catch {
          // RFC 8949 §3.2.3: each text-string chunk must itself be valid UTF-8.
          const msg = `ilts chunk is not valid UTF-8`;
          if (onError) onError(msg);
          else throw new SyntaxError(msg);
          text = utf8Lenient.decode(argBytes!);
        }
      }
      textChunks.push(
        new CborTextString(
          text,
          ew !== undefined ? { encodingWidth: ew } : undefined
        )
      );
    } else {
      const bytes = argBytes ?? textEncoder.encode(argText!);
      byteChunks.push(
        new CborByteString(
          bytes,
          ew !== undefined ? { encodingWidth: ew } : undefined
        )
      );
    }
  }

  return isText
    ? new CborIndefiniteTextString(textChunks)
    : new CborIndefiniteByteString(byteChunks);
}

function makeExtension(prefix: 'ilbs' | 'ilts'): CborExtension {
  return {
    appStringPrefixes: [prefix],
    preserveAppSeqSource: true,

    // prefix'...' / prefix`...` is shorthand for a sequence with exactly
    // that one text string (§2.1) — the result has a single chunk.
    // The result is wrapped so that toCDN() round-trips an app-string form
    // instead of normalizing to the deprecated `(_ ...)` streamstring
    // syntax.  The source is reconstructed from the content, so the raw
    // string form prefix`...` normalizes to the single-quoted form.
    parseAppString(_prefix, content, onError) {
      const result = buildIndefinite(
        prefix,
        [new CborTextString(content)],
        onError
      );
      return new CborAppSeqResult(
        result,
        `${prefix}${escapeAppString(content)}`
      );
    },

    parseAppSequence(_prefix, items, onError) {
      return buildIndefinite(prefix, items, onError);
    },
  };
}

/** Extension object for `ilbs<<...>>` (indefinite-length byte string). */
export const ilbs: CborExtension = makeExtension('ilbs');

/** Extension object for `ilts<<...>>` (indefinite-length text string). */
export const ilts: CborExtension = makeExtension('ilts');
