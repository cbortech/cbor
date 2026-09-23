/**
 * The conversion pipeline: CDN text → CDN AST → CBOR bytes → binary AST,
 * plus the derived row model and position map the views consume.
 *
 * Both single-item CDN and multi-item CDN Sequences (draft-ietf-cbor-edn-literals
 * §2) are supported.  CBOR Sequence output (RFC 8742) is produced automatically
 * when the input contains more than one item.
 */
import {
  CBOR,
  createERefExtension,
  annotateERefKeys,
  CddlMismatchError,
  type FromCDNOptions,
  type ParseWarning,
  type ToCDNOptions,
} from '@cbortech/cbor';
import type { CborItem } from '@cbortech/cbor/ast';
import type { CddlSchema } from '@cbortech/cbor/cddl';
import { buildRangeMap, type NodeRange } from './mapping/lockstep';
import { buildRows, type HexRow } from './hexview/build-rows';
import { getEnabledExtensions, isERefEnabled } from './ui/toolbar';

/**
 * `e'...'` annotation for input that was decoded/parsed *without* the
 * library's own `cddl` option (every entry point below — like
 * `convertCdn()`, see its own doc — deliberately avoids it, since it both
 * validates *and* throws on a mismatch, and this pipeline must keep
 * converting input that doesn't match the open schema rather than erroring
 * out entirely). Soft equivalent: validates separately (never throwing) and
 * only annotates `item` in place — upgrading an integer map key the schema
 * names via `&(name: value)` to `e'name'` notation — when it actually
 * matches. A no-op without a schema, when validation fails, or when the
 * `e'...'` checkbox in the Extensions popover is unchecked
 * (`isERefEnabled()`).
 */
export function annotateIfValid(
  item: CborItem,
  cddlSchema: CddlSchema | null | undefined
): void {
  if (!cddlSchema || !isERefEnabled()) return;
  if (!cddlSchema.validate(item).valid) return;
  annotateERefKeys(item, cddlSchema);
}

export interface ConversionOk {
  ok: true;
  empty: false;
  bytes: Uint8Array;
  /** First (or only) CDN AST item — kept for backward compatibility. */
  cdnAst: CborItem;
  /** All CDN AST items (length === seqLength), with source char offsets. */
  cdnAsts: CborItem[];
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

/**
 * Append every element of `source` onto `target` in place.
 *
 * Not `target.push(...source)`: spreading a large array as call arguments
 * can exceed the engine's argument-count limit. `buildRows`/`buildRangeMap`
 * return one entry per byte/node of a whole document, so a large pasted
 * CBOR document can make this happen.
 */
function pushAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) target.push(item);
}

/**
 * `cddlSchema`, when given, registers the `e'...'` external-reference
 * app-extension (draft-ietf-cbor-edn-e-ref) — so `e'name'` resolves to
 * whatever integer the schema names it — for CDN parsing only, and only
 * while the `e'...'` checkbox in the Extensions popover is also checked
 * (`isERefEnabled()`). Deliberately *not* passed as the library's own
 * `cddl` option (which would also validate and throw `CddlMismatchError` on
 * a mismatch): this pipeline must keep converting arbitrary CDN even when
 * it doesn't match the schema open in the CDDL pane, exactly as it already
 * does without a schema at all — see `main.ts`'s `update()`, which is the
 * one place that decides whether a schema is currently active
 * (`cddlPane.isOpen()`).
 */
export function convertCdn(
  text: string,
  cddlSchema?: CddlSchema | null
): Conversion {
  if (text.trim() === '') return { ok: true, empty: true };
  try {
    const warnings: ParseWarning[] = [];
    const { extensions, builtinExtensions } = getEnabledExtensions();
    const seqOpts = {
      strict: false,
      onWarning: (w: ParseWarning) => warnings.push(w),
      extensions:
        cddlSchema && isERefEnabled()
          ? [createERefExtension(cddlSchema), ...extensions]
          : extensions,
      builtinExtensions,
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
        extensions,
        builtinExtensions,
        strict: false,
        onWarning: (w) => warnings.push(w),
      }),
    ];

    // Annotate each binAst the same way bytesToCdnText() annotates its own
    // items — the JS pane renders `binAst`/`binAsts` directly (see
    // `main.ts`'s `update()`), and without this, a plain integer map key
    // decoded straight from bytes never becomes a `CborERefUint`/
    // `CborERefNint`, so `toJS()` has no name to use and 'auto' falls back
    // to `MapEntries` even though the CDN source spelled `e'title'`
    // explicitly. `annotateIfValid()` is a no-op without a schema, or when
    // the item doesn't actually validate against it.
    for (const item of binAsts) annotateIfValid(item, cddlSchema);

    // Build rows and ranges for every CDN ↔ binary item pair.
    const rows: HexRow[] = [];
    const ranges: NodeRange[] = [];
    const pairCount = Math.min(cdnAsts.length, binAsts.length);
    for (let i = 0; i < pairCount; i++) {
      pushAll(rows, buildRows(binAsts[i]!, bytes));
      pushAll(ranges, buildRangeMap(cdnAsts[i]!, binAsts[i]!));
    }

    return {
      ok: true,
      empty: false,
      bytes,
      cdnAst: cdnAsts[0]!,
      cdnAsts,
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

const BLANK_LINE_RE = /\r?\n[ \t]*\r?\n/;

/**
 * Whether `indent` turns on pretty-printing, mirroring the library's own
 * `resolveIndent()` (unexported): `undefined`, `0`, and `''` all mean
 * compact/single-line output.
 */
function hasPrettyIndent(indent: ToCDNOptions['indent']): boolean {
  if (indent === undefined) return false;
  return (typeof indent === 'number' ? ' '.repeat(indent) : indent) !== '';
}

/**
 * Reformat CDN text (a single item or a CBOR Sequence per draft-ietf-cbor-edn-literals
 * §2). Each item is re-serialized independently; when `preserveBlankLines` is
 * set *and* pretty-printing is active, a blank line between two items in the
 * source is kept in the output (plain `.join('\n')` would otherwise collapse
 * it, since blank lines between sequence items are outside any single item's
 * own AST). In compact mode `preserveBlankLines` has no effect, matching how
 * the option behaves for blank lines inside a single item's containers.
 *
 * `cddlSchema`, when given, validates each item as it's parsed and throws
 * `CddlMismatchError` on the first mismatch (same fail-fast behavior the
 * library's own `cddl` option gives `fromCDNSeq` directly) — unlike
 * `convertCdn()`/`bytesToCdnText()`'s own soft handling, Format is a
 * deliberate, one-shot action a reader expects to fail loudly on invalid
 * input, not keep converting best-effort while they type. Registers the
 * `e'...'` extension and annotates each valid item the same way those two
 * do — gated by `isERefEnabled()` — rather than actually using the
 * library's own `cddl` option, which would do both unconditionally; see
 * `annotateIfValid()`'s own doc for why every entry point in this file
 * avoids it.
 */
export function formatCdnText(
  text: string,
  options: FromCDNOptions & ToCDNOptions,
  cddlSchema?: CddlSchema | null
): string {
  const preserveBlankLines =
    !!options.preserveBlankLines && hasPrettyIndent(options.indent);
  const parseOptions: FromCDNOptions = {
    ...options,
    extensions:
      cddlSchema && isERefEnabled()
        ? [createERefExtension(cddlSchema), ...(options.extensions ?? [])]
        : options.extensions,
  };
  const items: CborItem[] = [];
  for (const item of CBOR.fromCDNSeq(text, parseOptions)) {
    if (cddlSchema) {
      const result = cddlSchema.validate(item, options.cddlValidationOptions);
      if (!result.valid) {
        throw new CddlMismatchError(result.errors, result.warnings);
      }
      if (isERefEnabled())
        annotateERefKeys(item, cddlSchema, options.cddlValidationOptions);
    }
    items.push(item);
  }
  let cdn = '';
  let prevEnd: number | null = null;
  for (const item of items) {
    if (prevEnd !== null) {
      const between = text.slice(prevEnd, item.start!);
      cdn += preserveBlankLines && BLANK_LINE_RE.test(between) ? '\n\n' : '\n';
    }
    cdn += item.toCDN(options);
    prevEnd = item.end!;
  }
  return cdn;
}

/**
 * Parse pasted bytes (plain hex or an annotated hex dump) back to CDN text.
 * Handles CBOR Sequences: each item is converted to CDN on its own line.
 */
export function bytesToCdnText(
  hexDumpText: string,
  formatOptions?: ToCDNOptions,
  cddlSchema?: CddlSchema | null
): {
  cdn: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const { extensions, builtinExtensions } = getEnabledExtensions();
  const items = [
    ...CBOR.fromHexDumpSeq(hexDumpText, {
      extensions,
      builtinExtensions,
      strict: false,
      onWarning: (w) => warnings.push(w.message),
    }),
  ];
  if (items.length === 0) return { cdn: '', warnings };
  for (const item of items) annotateIfValid(item, cddlSchema);
  const opts: ToCDNOptions = formatOptions ?? { indent: 2 };
  const cdn = items.map((item) => item.toCDN(opts)).join('\n');
  return { cdn, warnings };
}

export function bytesToHexString(bytes: Uint8Array): string {
  const pairs = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += 16)
    lines.push(pairs.slice(i, i + 16).join(' '));
  return lines.join('\n');
}
