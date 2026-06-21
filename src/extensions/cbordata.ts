/**
 * Built-in embedded CBOR extension (RFC 8949 §3.4.5.1).
 *
 * Intercepts tag 24 during fromCBOR() so that the byte string content is
 * decoded as a CBOR data item and represented as CborEmbeddedCBOR.  This
 * allows toCDN() to render the value as 24(<<item>>) instead of 24(h'...').
 *
 * If the byte string is not valid CBOR (or has trailing bytes), the extension
 * returns undefined and falls back to the plain CborTag representation.
 */

import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import type { FromCBOROptions } from '../types';
import { CborByteString } from '../ast/CborByteString';
import { CborEmbeddedCBOR } from '../ast/CborEmbeddedCBOR';
import { CborTag } from '../ast/CborTag';
import { decodeCBOR } from '../cbor/decoder';

export const TAG_CBOR_DATA = 24n;

const cbordata: CborExtension = {
  tagNumbers: [TAG_CBOR_DATA],

  parseTag(
    tag: bigint,
    value: CborItem,
    options?: FromCBOROptions
  ): CborItem | undefined {
    if (tag !== TAG_CBOR_DATA) return undefined;
    if (!(value instanceof CborByteString)) return undefined;
    // Forward strict/onWarning/silent into the inner decode, but reset
    // offset and allowTrailing since the embedded bytes start at 0.
    const innerOptions: FromCBOROptions | undefined = options
      ? {
          extensions: options.extensions,
          strict: options.strict,
          onWarning: options.onWarning,
          silent: options.silent,
        }
      : undefined;
    try {
      const decoded = decodeCBOR(value.value, innerOptions);
      return new CborTag(
        TAG_CBOR_DATA,
        new CborEmbeddedCBOR([decoded], { encodingWidth: value.encodingWidth })
      );
    } catch (e) {
      if (innerOptions?.strict !== false) {
        // In strict mode, propagate inner violations to the outer decode.
        throw e;
      }
      // In non-strict mode, fall back to a plain CborTag.
      return undefined;
    }
  },
};

export default cbordata;
