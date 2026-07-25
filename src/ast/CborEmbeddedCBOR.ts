import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import { MT_BYTES } from '../cbor/constants';
import {
  writeHead,
  writeHeadTo,
  CborWriter,
  type EncodingWidth,
} from '../cbor/encode';
import {
  formatTrailingComments,
  hasPreservedComments,
  serializeContainer,
} from '../cdn/serialize-utils';
import { bytesToSpacedHexUpper } from '../utils/hex';

/**
 * CBOR Sequence Literal (§2.5.6) — `<<item, item, ...>>`.
 *
 * Encodes as a definite-length byte string whose value is the concatenation
 * of the CBOR encodings of the contained items.
 *
 * @example
 * // <<1, 2>>  →  h'0102'
 * new CborEmbeddedCBOR([new CborUint(1n), new CborUint(2n)])
 */
export class CborEmbeddedCBOR extends CborItem {
  readonly items: CborItem[];
  encodingWidth: EncodingWidth | undefined;

  constructor(items: CborItem[], options?: { encodingWidth?: EncodingWidth }) {
    super();
    this.items = items;
    this.encodingWidth = options?.encodingWidth;
  }

  override get _containsCdnContainer(): boolean {
    return this.items.some((item) => item._containsCdnContainer);
  }

  /** The raw concatenated CBOR bytes of all contained items. */
  private _content(options?: ToCBOROptions): Uint8Array {
    const inner = new CborWriter();
    for (const item of this.items) item._encode(inner, options);
    return inner.finish();
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    // The head needs the content's byte length, so the items are encoded
    // into a separate buffer first.
    const content = this._content(options);
    writeHeadTo(writer, MT_BYTES, content.length, this.encodingWidth);
    writer.writeBytes(content);
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    return serializeContainer({
      node: this,
      options,
      depth,
      openChar: '<<',
      closeChar: '>>',
      count: this.items.length,
      indefiniteLength: false,
      encodingWidth: this.encodingWidth,
      eiPosition: 'close',
      canonicalCount: () => BigInt(this._content(options).length),
      hasEntryComments: () => this.items.some(hasPreservedComments),
      renderEntry: (i) => this.items[i]._toCDN(options, depth + 1),
      // entryIsLeaf is intentionally omitted (defaults to "always a leaf"):
      // unlike CborArray/CborMap, an item that is itself an array/map still
      // inlines here as long as its own rendering fits on one line — <<...>>
      // is a flat sequence of encoded items, not a nested-structure display.
      entryLeadingNode: (i) => this.items[i],
      entryTrailing: (i, style) => formatTrailingComments(this.items[i], style),
    });
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const content = this._content();
    const n = content.length;
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: bytesToSpacedHexUpper(
          writeHead(MT_BYTES, BigInt(n), this.encodingWidth)
        ),
        comment: `Embedded CBOR sequence, ${n} byte${n !== 1 ? 's' : ''}`,
      },
    ];
    for (const item of this.items) {
      lines.push(...item._toHexDump(depth + 1, options));
    }
    return lines;
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this._content();
  }
}
