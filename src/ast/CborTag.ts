import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { Tag } from '../tag';
import type { AnnotatedLine } from './CborItem';
import { MT_TAG } from '../cbor/constants';
import {
  writeHead,
  writeHeadTo,
  type CborWriter,
  type EncodingWidth,
} from '../cbor/encode';
import {
  resolveEiSuffix,
  canonicalEncodingWidth,
} from '../cdn/serialize-utils';

/** CBOR Major Type 6 — tagged data item. */
export class CborTag extends CborItem {
  readonly tag: bigint;
  readonly content: CborItem;
  encodingWidth: EncodingWidth | undefined;

  constructor(
    tag: number | bigint,
    content: CborItem,
    options?: { encodingWidth?: EncodingWidth }
  ) {
    super();
    this.tag = BigInt(tag);
    if (this.tag < 0n)
      throw new RangeError('CborTag tag number must be non-negative');
    this.content = content;
    this.encodingWidth = options?.encodingWidth;
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    writeHeadTo(writer, MT_TAG, this.tag, this.encodingWidth);
    this.content._encode(writer, options);
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
      canonicalEncodingWidth(this.tag)
    );
    return `${this.tag}${suffix}(${this.content._toCDN(options, depth)})`;
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const toHex = (bytes: Uint8Array) =>
      Array.from(bytes, (b) =>
        b.toString(16).toUpperCase().padStart(2, '0')
      ).join(' ');
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: toHex(writeHead(MT_TAG, this.tag, this.encodingWidth)),
        comment: `Tag ${this.tag}`,
      },
    ];
    lines.push(
      ...this.content._toHexDump(depth + 1, { ...options, appStrings: false })
    );
    return lines;
  }

  _toJS(options?: ToJSOptions): unknown {
    const value = this.content._toJS(options);
    return options?.stripTags ? value : Tag.set(value, this.tag);
  }
}
