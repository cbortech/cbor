import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import type { CborTextString } from './CborTextString';
import { MT_TEXT, AI_INDEFINITE, BREAK_CODE } from '../cbor/constants';
import type { CborWriter } from '../cbor/encode';

/** CBOR Major Type 3 — indefinite-length UTF-8 text string (chunked). */
export class CborIndefiniteTextString extends CborItem {
  readonly indefiniteLength = true as const;
  readonly chunks: CborTextString[];

  constructor(chunks: CborTextString[]) {
    super();
    this.chunks = chunks;
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    writer.writeByte((MT_TEXT << 5) | AI_INDEFINITE);
    for (const chunk of this.chunks) chunk._encode(writer, options);
    writer.writeByte(BREAK_CODE);
  }

  _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    if (this.chunks.length === 0) return '""_';
    const chunkStrs = this.chunks.map((c) => c._toCDN(options, 0));
    return `(_ ${chunkStrs.join(', ')})`;
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const byteHex = (b: number) =>
      b.toString(16).toUpperCase().padStart(2, '0');
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: byteHex((MT_TEXT << 5) | AI_INDEFINITE),
        comment: 'Start indefinite-length text string',
      },
    ];
    for (const chunk of this.chunks)
      lines.push(...chunk._toHexDump(depth + 1, options));
    lines.push({ depth, hex: byteHex(BREAK_CODE), comment: '"break"' });
    return lines;
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this.chunks.map((c) => c.value).join('');
  }
}
