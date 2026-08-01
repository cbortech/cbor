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
  pushAll,
  renderSingleChildWithComments,
} from '../cdn/serialize-utils';
import { bytesToSpacedHexUpper } from '../utils/hex';

/** CBOR Major Type 6 — tagged data item. */
export class CborTag extends CborItem {
  readonly tag: bigint;
  readonly content: CborItem;
  encodingWidth: EncodingWidth | undefined;
  /**
   * Original CDN digit spelling of the tag number (base + digits, without
   * the encoding-indicator suffix), set by the parser when this tag came
   * from CDN text. Used by `_toCDN()` to round-trip the tag number's base
   * (`0x3e7`, decimal, …) when `preserveNumberFormat` is set.
   */
  ednSource?: string;

  constructor(
    tag: number | bigint,
    content: CborItem,
    options?: { encodingWidth?: EncodingWidth; ednSource?: string }
  ) {
    super();
    this.tag = BigInt(tag);
    if (this.tag < 0n)
      throw new RangeError('CborTag tag number must be non-negative');
    this.content = content;
    this.encodingWidth = options?.encodingWidth;
    this.ednSource = options?.ednSource;
  }

  override get _containsCdnContainer(): boolean {
    return this.content._containsCdnContainer;
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    writeHeadTo(writer, MT_TAG, this.tag, this.encodingWidth);
    this.content._encode(writer, options);
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
      canonicalEncodingWidth(this.tag)
    );
    const tagStr =
      options?.preserveNumberFormat && this.ednSource !== undefined
        ? this.ednSource
        : this.tag.toString();
    const wrapped = renderSingleChildWithComments(
      this.content,
      this,
      options,
      depth,
      (childDepth) => this.content._toCDN(options, childDepth),
      '(',
      ')'
    );
    return `${tagStr}${suffix}${wrapped}`;
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: bytesToSpacedHexUpper(
          writeHead(MT_TAG, this.tag, this.encodingWidth)
        ),
        comment: `Tag ${this.tag}`,
      },
    ];
    pushAll(
      lines,
      this.content._toHexDump(depth + 1, { ...options, appStrings: false })
    );
    return lines;
  }

  _toJS(options?: ToJSOptions): unknown {
    const value = this.content._toJS(options);
    return options?.stripTags ? value : Tag.set(value, this.tag);
  }
}
