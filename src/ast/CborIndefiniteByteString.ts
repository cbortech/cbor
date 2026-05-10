import type { ToEDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import type { CborByteString } from './CborByteString';
import { MT_BYTES, AI_INDEFINITE, BREAK_CODE } from '../cbor/constants';
import { concat } from '../cbor/encode';

/** CBOR Major Type 2 — indefinite-length byte string (chunked). */
export class CborIndefiniteByteString extends CborItem {
  readonly indefiniteLength = true as const;
  readonly chunks: CborByteString[];

  constructor(chunks: CborByteString[]) {
    super();
    this.chunks = chunks;
  }

  _toCBOR(options?: ToCBOROptions): Uint8Array {
    const parts: Uint8Array[] = [
      new Uint8Array([(MT_BYTES << 5) | AI_INDEFINITE]),
    ];
    for (const chunk of this.chunks) parts.push(chunk._toCBOR(options));
    parts.push(new Uint8Array([BREAK_CODE]));
    return concat(parts);
  }

  _toEDN(options: ToEDNOptions | undefined, _depth: number): string {
    if (this.chunks.length === 0) return "''_";
    const chunkStrs = this.chunks.map((c) => c._toEDN(options, 0));
    return `(_ ${chunkStrs.join(', ')})`;
  }

  override _toHexDump(depth: number, options?: ToEDNOptions): AnnotatedLine[] {
    const byteHex = (b: number) =>
      b.toString(16).toUpperCase().padStart(2, '0');
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: byteHex((MT_BYTES << 5) | AI_INDEFINITE),
        comment: 'Start indefinite-length byte string',
      },
    ];
    for (const chunk of this.chunks)
      lines.push(...chunk._toHexDump(depth + 1, options));
    lines.push({ depth, hex: byteHex(BREAK_CODE), comment: '"break"' });
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
