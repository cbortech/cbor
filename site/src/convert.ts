/**
 * The conversion pipeline: CDN text → CDN AST → CBOR bytes → binary AST,
 * plus the derived row model and position map the views consume.
 */
import { CBOR, type ParseWarning } from '@cbortech/cbor';
import type { CborItem } from '@cbortech/cbor/ast';
import { buildRangeMap, type NodeRange } from './mapping/lockstep';
import { buildRows, type HexRow } from './hexview/build-rows';
import { SITE_EXTENSIONS } from './extensions';

export interface ConversionOk {
  ok: true;
  empty: false;
  bytes: Uint8Array;
  cdnAst: CborItem;
  binAst: CborItem;
  rows: HexRow[];
  ranges: NodeRange[];
  warnings: ParseWarning[];
}

export interface ConversionEmpty {
  ok: true;
  empty: true;
}

export interface ConversionErr {
  ok: false;
  error: unknown;
}

export type Conversion = ConversionOk | ConversionEmpty | ConversionErr;

export function convertCdn(text: string): Conversion {
  if (text.trim() === '') return { ok: true, empty: true };
  try {
    const warnings: ParseWarning[] = [];
    const cdnAst = CBOR.fromCDN(text, {
      strict: false,
      onWarning: (w) => warnings.push(w),
      extensions: SITE_EXTENSIONS,
    });
    const bytes = cdnAst.toCBOR();
    const binAst = CBOR.fromCBOR(bytes, {
      extensions: SITE_EXTENSIONS,
      strict: false,
      onWarning: (w) => warnings.push(w),
    });
    return {
      ok: true,
      empty: false,
      bytes,
      cdnAst,
      binAst,
      rows: buildRows(binAst, bytes),
      ranges: buildRangeMap(cdnAst, binAst),
      warnings,
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Parse pasted bytes (plain hex or an annotated hex dump) back to CDN text.
 * Throws on invalid input.
 */
export function bytesToCdnText(hexDumpText: string): string {
  const item = CBOR.fromHexDump(hexDumpText, { extensions: SITE_EXTENSIONS });
  return item.toCDN({ indent: 2 });
}

export function bytesToHexString(bytes: Uint8Array): string {
  const pairs = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += 16)
    lines.push(pairs.slice(i, i + 16).join(' '));
  return lines.join('\n');
}
