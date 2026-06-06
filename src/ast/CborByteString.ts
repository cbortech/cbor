import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_BYTES } from '../cbor/constants';
import { writeHead, concat, type EncodingWidth } from '../cbor/encode';
import { serializeBytes } from '../cdn/serialize-utils';

/** CBOR Major Type 2 — definite-length byte string. */
export class CborByteString extends CborItem {
  readonly indefiniteLength = false as const;
  readonly value: Uint8Array;
  /** Preferred EDN encoding for this byte string. */
  readonly ednEncoding: 'hex' | 'base64' | 'base64url' | 'base32' | 'base32hex';
  readonly encodingWidth: EncodingWidth | undefined;
  readonly ednSource: string | undefined;

  constructor(
    value: Uint8Array,
    options?: {
      ednEncoding?: 'hex' | 'base64' | 'base64url' | 'base32' | 'base32hex';
      encodingWidth?: EncodingWidth;
      ednSource?: string;
    }
  ) {
    super();
    this.value = value;
    this.ednEncoding = options?.ednEncoding ?? 'hex';
    this.encodingWidth = options?.encodingWidth;
    this.ednSource = options?.ednSource;
  }

  _toCBOR(_options?: ToCBOROptions): Uint8Array {
    return concat([
      writeHead(MT_BYTES, BigInt(this.value.length), this.encodingWidth),
      this.value,
    ]);
  }

  _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    const suffix =
      this.encodingWidth !== undefined ? `_${this.encodingWidth}` : '';
    if (options?.preserveByteString && this.ednSource !== undefined)
      return this.ednSource + suffix;
    let encoding = options?.bstrEncoding ?? this.ednEncoding;
    if (options?.appStrings === false && encoding !== 'hex') encoding = 'hex';
    return serializeBytes(this.value, encoding, options?.sqstr) + suffix;
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this.value;
  }
}
