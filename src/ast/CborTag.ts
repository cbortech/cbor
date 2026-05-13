import type { ToEDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { Tag } from '../tag';
import type { AnnotatedLine } from './CborItem';
import { MT_TAG } from '../cbor/constants';
import { writeHead, concat, type EncodingWidth } from '../cbor/encode';

/** CBOR Major Type 6 — tagged data item. */
export class CborTag extends CborItem {
  readonly tag: bigint;
  readonly content: CborItem;
  readonly encodingWidth: EncodingWidth | undefined;

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

  _toCBOR(options?: ToCBOROptions): Uint8Array {
    return concat([
      writeHead(MT_TAG, this.tag, this.encodingWidth),
      this.content._toCBOR(options),
    ]);
  }

  override _toEDN(options: ToEDNOptions | undefined, depth: number): string {
    const suffix =
      this.encodingWidth !== undefined ? `_${this.encodingWidth}` : '';
    return `${this.tag}${suffix}(${this.content._toEDN(options, depth)})`;
  }

  override _toHexDump(depth: number, options?: ToEDNOptions): AnnotatedLine[] {
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
    lines.push(...this.content._toHexDump(depth + 1, options));
    return lines;
  }

  _toJS(options?: ToJSOptions): unknown {
    const value = this.content._toJS(options);
    return options?.stripTags ? value : Tag.set(value, this.tag);
  }
}
