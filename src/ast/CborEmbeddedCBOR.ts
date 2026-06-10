import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import { MT_BYTES } from '../cbor/constants';
import { writeHead, writeHeadTo, CborWriter } from '../cbor/encode';
import {
  resolveIndent,
  indentOf,
  resolveSeparators,
} from '../cdn/serialize-utils';

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

  constructor(items: CborItem[]) {
    super();
    this.items = items;
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
    writeHeadTo(writer, MT_BYTES, content.length);
    writer.writeBytes(content);
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (this.items.length === 0) return '<<>>';

    const indentStr = resolveIndent(options);
    const { inlineSep, multilineSep, trailSep } = resolveSeparators(
      options,
      indentStr === null
    );

    if (indentStr === null) {
      // single-line
      const inner = this.items
        .map((item) => item._toCDN(options, depth + 1))
        .join(inlineSep);
      return `<<${inner}>>`;
    }

    // multi-line
    const childIndent = indentOf(indentStr, depth + 1);
    const closeIndent = indentOf(indentStr, depth);
    const lines = this.items.map(
      (item) => `${childIndent}${item._toCDN(options, depth + 1)}`
    );
    const lastIdx = lines.length - 1;
    const body = lines
      .map((line, i) =>
        i < lastIdx ? `${line}${multilineSep}` : `${line}${trailSep}`
      )
      .join('\n');
    return `<<\n${body}\n${closeIndent}>>`;
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const toHex = (bytes: Uint8Array) =>
      Array.from(bytes, (b) =>
        b.toString(16).toUpperCase().padStart(2, '0')
      ).join(' ');

    const content = this._content();
    const n = content.length;
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: toHex(writeHead(MT_BYTES, BigInt(n))),
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
