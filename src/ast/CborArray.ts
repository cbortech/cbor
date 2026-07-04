import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CBOR_OMIT } from '../types';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import { MT_ARRAY, AI_INDEFINITE, BREAK_CODE } from '../cbor/constants';
import {
  writeHead,
  writeHeadTo,
  type CborWriter,
  type EncodingWidth,
} from '../cbor/encode';
import {
  formatTrailingComments,
  hasPreservedComments,
  serializeContainer,
} from '../cdn/serialize-utils';

/** CBOR Major Type 4 — array (definite- or indefinite-length). */
export class CborArray extends CborItem {
  readonly items: CborItem[];
  readonly indefiniteLength: boolean;
  encodingWidth: EncodingWidth | undefined;

  constructor(
    items: CborItem[],
    options?: { indefiniteLength?: boolean; encodingWidth?: EncodingWidth }
  ) {
    super();
    this.items = items;
    this.indefiniteLength = options?.indefiniteLength ?? false;
    this.encodingWidth = options?.encodingWidth;
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    if (this.indefiniteLength) {
      writer.writeByte((MT_ARRAY << 5) | AI_INDEFINITE);
      for (const item of this.items) item._encode(writer, options);
      writer.writeByte(BREAK_CODE);
      return;
    }
    writeHeadTo(writer, MT_ARRAY, this.items.length, this.encodingWidth);
    for (const item of this.items) item._encode(writer, options);
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    return serializeContainer({
      node: this,
      options,
      depth,
      openChar: '[',
      closeChar: ']',
      count: this.items.length,
      indefiniteLength: this.indefiniteLength,
      encodingWidth: this.encodingWidth,
      hasEntryComments: () => this.items.some(hasPreservedComments),
      renderEntry: (i) => this.items[i]._toCDN(options, depth + 1),
      entryLeadingNode: (i) => this.items[i],
      entryTrailing: (i, style) => formatTrailingComments(this.items[i], style),
    });
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const byteHex = (b: number) =>
      b.toString(16).toUpperCase().padStart(2, '0');
    const toHex = (bytes: Uint8Array) =>
      Array.from(bytes, (b) =>
        b.toString(16).toUpperCase().padStart(2, '0')
      ).join(' ');

    if (this.indefiniteLength) {
      const lines: AnnotatedLine[] = [
        {
          depth,
          hex: byteHex((MT_ARRAY << 5) | AI_INDEFINITE),
          comment: 'Start indefinite-length array',
        },
      ];
      for (const item of this.items)
        lines.push(...item._toHexDump(depth + 1, options));
      lines.push({ depth, hex: byteHex(BREAK_CODE), comment: '"break"' });
      return lines;
    }
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: toHex(
          writeHead(MT_ARRAY, BigInt(this.items.length), this.encodingWidth)
        ),
        comment: `Array of length ${this.items.length}`,
      },
    ];
    for (const item of this.items)
      lines.push(...item._toHexDump(depth + 1, options));
    return lines;
  }

  _toJS(options?: ToJSOptions): unknown {
    const reviver = options?.reviver;
    if (!reviver) return this.items.map((item) => item._toJS(options));
    // First pass: pre-populate holder with unrevived values so later siblings
    // are still raw when earlier callbacks run (matches JSON.parse sibling timing).
    const optNoReviver = options
      ? { ...options, reviver: undefined }
      : undefined;
    const holder: unknown[] = this.items.map((item) =>
      item._toJS(optNoReviver)
    );
    // Second pass: revive each element depth-first, splice out undefined entries
    // immediately so `this` reflects the compacted in-progress array.
    // Original indices are used as reviver keys; undefined → omit (compact,
    // differs from JSON.parse which leaves holes).
    let deleted = 0;
    for (let i = 0; i < this.items.length; i++) {
      const hIdx = i - deleted;
      const val = this.items[i]._toJS(options);
      const rv = reviver.call(holder, String(i), val);
      const omit =
        rv === CBOR_OMIT || (options?.undefinedOmits && rv === undefined);
      if (omit) {
        holder.splice(hIdx, 1);
        deleted++;
      } else {
        holder[hIdx] = rv;
      }
    }
    return holder;
  }
}
