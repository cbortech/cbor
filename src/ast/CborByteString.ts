import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_BYTES } from '../cbor/constants';
import {
  writeHeadTo,
  type CborWriter,
  type EncodingWidth,
} from '../cbor/encode';
import {
  serializeBytes,
  resolveEiSuffix,
  resolveIndent,
  joinConcatParts,
  canonicalEncodingWidth,
} from '../cdn/serialize-utils';

/** One part of a byte string parsed from a CDN `+` concatenation chain. */
export interface CborByteStringPart {
  bytes: Uint8Array;
  /** Original literal source text, when the part came from a byte string token. */
  source?: string;
}

/** CBOR Major Type 2 — definite-length byte string. */
export class CborByteString extends CborItem {
  readonly indefiniteLength = false as const;
  readonly value: Uint8Array;
  /** Preferred EDN encoding for this byte string. */
  readonly ednEncoding: 'hex' | 'base64' | 'base64url' | 'base32' | 'base32hex';
  encodingWidth: EncodingWidth | undefined;
  readonly ednSource: string | undefined;
  /** Part boundaries of the original `+` concatenation chain, if any. */
  readonly ednParts: readonly CborByteStringPart[] | undefined;

  constructor(
    value: Uint8Array,
    options?: {
      ednEncoding?: 'hex' | 'base64' | 'base64url' | 'base32' | 'base32hex';
      encodingWidth?: EncodingWidth;
      ednSource?: string;
      ednParts?: readonly CborByteStringPart[];
    }
  ) {
    super();
    this.value = value;
    this.ednEncoding = options?.ednEncoding ?? 'hex';
    this.encodingWidth = options?.encodingWidth;
    this.ednSource = options?.ednSource;
    this.ednParts = options?.ednParts;
  }

  override _encodeTo(writer: CborWriter, _options?: ToCBOROptions): void {
    writeHeadTo(writer, MT_BYTES, this.value.length, this.encodingWidth);
    writer.writeBytes(this.value);
  }

  _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    const indentStr = resolveIndent(options);
    if (
      options?.preserveConcatenation &&
      // Preserved concatenation is a layout feature; single-line mode joins
      // the parts into one literal instead.
      indentStr !== null &&
      this.ednParts !== undefined &&
      this.ednParts.length > 1
    ) {
      const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
        canonicalEncodingWidth(BigInt(this.value.length))
      );
      let encoding = options?.bstrEncoding ?? this.ednEncoding;
      if (options?.appStrings === false && encoding !== 'hex') encoding = 'hex';
      const literals = this.ednParts.map((part) =>
        options?.preserveByteString && part.source !== undefined
          ? part.source
          : serializeBytes(part.bytes, encoding, options?.sqstr)
      );
      literals[literals.length - 1] += suffix;
      return joinConcatParts(literals, indentStr, _depth);
    }
    if (
      options?.preserveByteString &&
      this.ednSource !== undefined &&
      // In single-line mode an original spelling that spans multiple lines
      // (e.g. a byte string with interior line comments) cannot be re-emitted.
      (indentStr !== null || !/[\r\n]/.test(this.ednSource))
    ) {
      // App-string byte strings (e.g. b32'...'_1) embed the EI inside ednSource.
      // Regular byte strings (h'...', b64'...') store EI separately in encodingWidth.
      if (/_[0-3i]$/.test(this.ednSource)) {
        const mode = options?.encodingIndicators ?? 'auto';
        if (mode === 'never') return this.ednSource.replace(/_[0-3i]$/, '');
        return this.ednSource; // 'auto' or 'always': EI already present
      }
      const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
        canonicalEncodingWidth(BigInt(this.value.length))
      );
      return this.ednSource + suffix;
    }
    const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
      canonicalEncodingWidth(BigInt(this.value.length))
    );
    let encoding = options?.bstrEncoding ?? this.ednEncoding;
    if (options?.appStrings === false && encoding !== 'hex') encoding = 'hex';
    return serializeBytes(this.value, encoding, options?.sqstr) + suffix;
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this.value;
  }
}
