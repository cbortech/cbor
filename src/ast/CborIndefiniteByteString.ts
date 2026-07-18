import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import { CborByteString } from './CborByteString';
import { MT_BYTES, AI_INDEFINITE, BREAK_CODE } from '../cbor/constants';
import type { CborWriter } from '../cbor/encode';
import {
  formatTrailingComments,
  hasPreservedComments,
  serializeContainer,
} from '../cdn/serialize-utils';
import { byteToHexUpper } from '../utils/hex';

/** CBOR Major Type 2 — indefinite-length byte string (chunked). */
export class CborIndefiniteByteString extends CborItem {
  readonly indefiniteLength = true as const;
  readonly chunks: CborByteString[];

  constructor(chunks: CborByteString[]) {
    super();
    this.chunks = chunks;
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    writer.writeByte((MT_BYTES << 5) | AI_INDEFINITE);
    for (const chunk of this.chunks) chunk._encode(writer, options);
    writer.writeByte(BREAK_CODE);
  }

  _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if ((options?.encodingIndicators ?? 'auto') === 'never') {
      const totalLen = this.chunks.reduce((sum, c) => sum + c.value.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of this.chunks) {
        merged.set(chunk.value, offset);
        offset += chunk.value.length;
      }
      return new CborByteString(merged)._toCDN(options, depth);
    }
    if (this.chunks.length === 0) return "''_";
    return serializeContainer({
      node: this,
      options,
      depth,
      openChar: '(',
      closeChar: ')',
      count: this.chunks.length,
      indefiniteLength: true,
      encodingWidth: undefined,
      hasEntryComments: () => this.chunks.some(hasPreservedComments),
      renderEntry: (i) => this.chunks[i]._toCDN(options, depth + 1),
      entryLeadingNode: (i) => this.chunks[i],
      entryTrailing: (i, style) =>
        formatTrailingComments(this.chunks[i], style),
    });
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: byteToHexUpper((MT_BYTES << 5) | AI_INDEFINITE),
        comment: 'Start indefinite-length byte string',
      },
    ];
    for (const chunk of this.chunks)
      lines.push(...chunk._toHexDump(depth + 1, options));
    lines.push({ depth, hex: byteToHexUpper(BREAK_CODE), comment: '"break"' });
    return lines;
  }

  _toJS(_options?: ToJSOptions): unknown {
    const totalLen = this.chunks.reduce((sum, c) => sum + c.value.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk.value, offset);
      offset += chunk.value.length;
    }
    return result;
  }
}
