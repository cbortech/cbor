/**
 * The conversion pipeline: CDN text → CDN AST → CBOR bytes → binary AST,
 * plus the derived row model and position map the views consume.
 *
 * Both single-item CDN and multi-item CDN Sequences (draft-ietf-cbor-edn-literals
 * §2) are supported.  CBOR Sequence output (RFC 8742) is produced automatically
 * when the input contains more than one item.
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
  /** First (or only) CDN AST item — kept for backward compatibility. */
  cdnAst: CborItem;
  /** First (or only) binary AST item — kept for backward compatibility. */
  binAst: CborItem;
  /** All binary AST items (length === seqLength). */
  binAsts: CborItem[];
  rows: HexRow[];
  ranges: NodeRange[];
  warnings: ParseWarning[];
  /** Number of sequence items (1 for a single-item input). */
  seqLength: number;
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
    const seqOpts = {
      strict: false,
      onWarning: (w: ParseWarning) => warnings.push(w),
      extensions: SITE_EXTENSIONS,
    };

    const cdnAsts = [...CBOR.fromCDNSeq(text, seqOpts)];
    if (cdnAsts.length === 0) {
      // Non-empty text that produced no items means parse failed before the
      // first yield (e.g. unterminated comment).  Surface the warning as an
      // error so the status bar shows it instead of clearing the bytes pane.
      if (warnings.length > 0)
        return { ok: false, error: new SyntaxError(warnings[0]!.message) };
      return { ok: true, empty: true };
    }

    // Encode each item and concatenate into a CBOR Sequence.
    const byteArrays = cdnAsts.map((ast) => ast.toCBOR());
    const totalLength = byteArrays.reduce((s, b) => s + b.length, 0);
    const bytes = new Uint8Array(totalLength);
    let byteOff = 0;
    for (const b of byteArrays) {
      bytes.set(b, byteOff);
      byteOff += b.length;
    }

    // Decode from the concatenated bytes — each binAst carries offsets relative
    // to the full byte array, which is exactly what buildRows / buildRangeMap need.
    const binAsts = [
      ...CBOR.fromCBORSeq(bytes, {
        extensions: SITE_EXTENSIONS,
        strict: false,
        onWarning: (w) => warnings.push(w),
      }),
    ];

    // Build rows and ranges for every CDN ↔ binary item pair.
    const rows: HexRow[] = [];
    const ranges: NodeRange[] = [];
    const pairCount = Math.min(cdnAsts.length, binAsts.length);
    for (let i = 0; i < pairCount; i++) {
      rows.push(...buildRows(binAsts[i]!, bytes));
      ranges.push(...buildRangeMap(cdnAsts[i]!, binAsts[i]!));
    }

    return {
      ok: true,
      empty: false,
      bytes,
      cdnAst: cdnAsts[0]!,
      binAst: binAsts[0]!,
      binAsts,
      rows,
      ranges,
      warnings,
      seqLength: cdnAsts.length,
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Parse pasted bytes (plain hex or an annotated hex dump) back to CDN text.
 * Handles CBOR Sequences: each item is converted to CDN on its own line.
 */
export function bytesToCdnText(hexDumpText: string): {
  cdn: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const items = [
    ...CBOR.fromHexDumpSeq(hexDumpText, {
      extensions: SITE_EXTENSIONS,
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    }),
  ];
  if (items.length === 0) return { cdn: '', warnings };
  const cdn = items.map((item) => item.toCDN({ indent: 2 })).join('\n');
  return { cdn, warnings };
}

export function bytesToHexString(bytes: Uint8Array): string {
  const pairs = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += 16)
    lines.push(pairs.slice(i, i + 16).join(' '));
  return lines.join('\n');
}
