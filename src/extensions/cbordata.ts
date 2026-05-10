/**
 * Built-in embedded CBOR extension (RFC 8949 §3.4.5.1).
 *
 * Intercepts tag 24 during fromCBOR() so that the byte string content is
 * decoded as a CBOR data item and represented as CborEmbeddedCBOR.  This
 * allows toEDN() to render the value as 24(<<item>>) instead of 24(h'...').
 *
 * If the byte string is not valid CBOR (or has trailing bytes), the extension
 * returns undefined and falls back to the plain CborTag representation.
 */

import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborByteString } from '../ast/CborByteString';
import { CborEmbeddedCBOR } from '../ast/CborEmbeddedCBOR';
import { CborTag } from '../ast/CborTag';
import { decodeCBOR } from '../cbor/decoder';

export const TAG_CBOR_DATA = 24n;

const cbordata: CborExtension = {
  tagNumbers: [TAG_CBOR_DATA],

  parseTag(tag: bigint, value: CborItem): CborItem | undefined {
    if (tag !== TAG_CBOR_DATA) return undefined;
    if (!(value instanceof CborByteString)) return undefined;
    try {
      const decoded = decodeCBOR(value.value);
      return new CborTag(TAG_CBOR_DATA, new CborEmbeddedCBOR([decoded]));
    } catch {
      return undefined;
    }
  },
};

export default cbordata;
