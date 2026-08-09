/**
 * §5.2 of draft-ietf-cbor-edn-literals-27 — Ellipsis (Elision) tag.
 *
 * Two forms:
 *   888(null)          — subtree elision:    a whole data item replaced by ...
 *   888([frag, 888(null), frag, ...])
 *                      — string/bytes elision: fragments alternating with ellipses
 *
 * Note: CPA888 is a provisional tag number.
 */

import type { ToCDNOptions } from '../types';
import { CborTag } from './CborTag';
import { CborArray } from './CborArray';
import { CborByteString } from './CborByteString';
import { CborTextString } from './CborTextString';
import { CborSimple } from './CborSimple';
import type { CborItem } from './CborItem';
import { bytesToHex } from '../utils/hex';
import {
  escapeString,
  resolveIndent,
  serializeBytes,
  stripByteLiteralComments,
  convertCommentText,
  danglingCommentsByGap,
  joinConcatParts,
  joinAppSeqParts,
  shouldEmitComments,
  resolveCommentStyle,
  type ByteCommentSyntax,
} from '../cdn/serialize-utils';

export const CPA888_TAG = 888n;

/**
 * Comments between two top-level `items` entries (a real `+` the parser
 * never fused away — see `CborByteString.ednParts`/`CborTextString
 * .ednPartSpans` for the case where two literals *did* fuse into one node
 * with no per-part AST node of their own) land on one of them as ordinary
 * `leading`/`trailing`, exactly like any other array entry: `attachComments`
 * runs generically over the whole tree, and both entries are real
 * `CborItem`s once the parser stamps their `start`/`end`.
 */
function boundaryComments(
  prev: CborItem,
  next: CborItem,
  preserveComments: boolean,
  style: 'c-style' | 'cdn-style' | undefined
): string[] {
  if (!preserveComments) return [];
  return [
    ...(prev.comments?.trailing ?? []).map((c) => convertCommentText(c, style)),
    ...(next.comments?.leading ?? []).map((c) => convertCommentText(c, style)),
  ];
}

/**
 * Join elision fragments with `+`. Elision is compact/single-line by
 * default — an abbreviated, inherently short summary of the underlying
 * value, not something meant to be reflowed across lines — but reflows
 * across multiple lines, one fragment per line like a real `+`
 * concatenation, when `indent` is enabled *and* there's a *mid-chain*
 * comment to preserve: a single line has nowhere to put a `#`/`//` line
 * comment sitting between two fragments (it has no way to terminate before
 * the rest of the chain), and a block comment kept inline there would be
 * indistinguishable from one actually written that way. With nothing to
 * preserve, or with `indent` disabled (nothing can safely hold a newline),
 * the whole chain still collapses onto one line and any such comment is
 * dropped — matching every other comment kind in single-line output.
 *
 * A comment trailing the *whole* chain needs none of this: it's promoted
 * onto this `CborEllipsis`'s own `comments.trailing` by the parser (see
 * `promoteEllipsisTailComments`), so the ordinary `entryTrailing`/root-
 * `toCDN()` machinery appends it after the rendered body — on the same
 * line if the body stayed single-line, which is always safe since nothing
 * else follows it there.
 */
function joinElisionParts(
  rendered: readonly string[],
  gapComments: readonly (readonly string[])[],
  indentStr: string | null,
  depth: number
): string {
  if (indentStr === null || !gapComments.some((g) => g.length > 0)) {
    return rendered.join(' + ');
  }
  return joinConcatParts(rendered, indentStr, depth, gapComments);
}

/**
 * Resolve a preserved source spelling: strip any embedded comment unless
 * comments are requested (`preserveComments`/`comments`) — a preserved
 * spelling should still drop comments by default, the same as an
 * unpreserved literal re-derived from
 * its decoded value would — then, only when the (possibly stripped) result
 * is safe to re-emit verbatim, return it. It's safe when `indent` enables
 * multi-line output, or it doesn't actually contain a newline itself
 * (interior whitespace, or a surviving `#`/`//` line comment) — otherwise it
 * would break `ToCDNOptions.indent`'s single-line guarantee. Mirrors
 * `CborByteString`/`CborTextString`'s own preserved-source fallback check.
 * Returns `undefined` when `source` is `undefined`, or isn't usable.
 */
function preservedSource(
  source: string | undefined,
  options: ToCDNOptions | undefined,
  indentStr: string | null,
  commentSyntax: ByteCommentSyntax | undefined
): string | undefined {
  if (source === undefined) return undefined;
  const stripped =
    shouldEmitComments(options) || commentSyntax === undefined
      ? source
      : stripByteLiteralComments(source, commentSyntax);
  return isSafeForCurrentMode(stripped, indentStr) ? stripped : undefined;
}

/**
 * Like `preservedSource`, but for a text source (`CborTextString`'s
 * `ednPartSources`) — text literals have no embedded-comment notation to
 * strip (a `#`/`//` there is just literal text content), so this only
 * applies the single-line safety check.
 */
function usableTextSource(
  source: string | undefined,
  indentStr: string | null
): source is string {
  return source !== undefined && isSafeForCurrentMode(source, indentStr);
}

function isSafeForCurrentMode(
  source: string,
  indentStr: string | null
): boolean {
  return indentStr !== null || !/[\r\n]/.test(source);
}

export class CborEllipsis extends CborTag {
  /**
   * For the array (string/bytes elision) form: `realBoundary[i]` is `true`
   * when a genuine `+` from the source precedes `items[i]` — as opposed to
   * `items[i]` sitting *inside* a single `h'xx...yy'` literal's own `...`
   * notation (index 0's value is never consulted — there is nothing before
   * the first item). `preserveConcatenation` uses this to show only the
   * real boundaries and fuse everything else, exactly as each source
   * literal was spelled.
   *
   * `undefined` means no boundary information is available at all (e.g.
   * reconstructed from raw CBOR bytes, which carry no notion of "was there
   * a `+` here" to begin with) — `preserveConcatenation` then has no effect,
   * the same as for a value that didn't originate from CDN source.
   */
  readonly realBoundary: readonly boolean[] | undefined;

  /**
   * For a subtree-elision placeholder (`888(null)`, i.e. `content
   * instanceof CborSimple`) that sits *inside* another `CborEllipsis`'s
   * items: `true` when it came from a `h'xx...yy'`-family literal's own
   * `...` notation — even a fully-elided `h'...'` with no hex digits at all
   * — as opposed to a bare standalone `...` token. Only consulted when this
   * placeholder ends up isolated as its own preserved fragment (nothing to
   * fuse it with on either side), to pick the right spelling: `h'...'` vs
   * plain `...`.
   */
  readonly fromByteLiteral: boolean;

  /**
   * When `fromByteLiteral` is `true`: that `h'xx...yy'`-family literal's own
   * raw source text (e.g. `h'AB...CD'` verbatim — case, interior whitespace,
   * and any `/ ... /`/`# ...` comments included), for `preserveByteString`
   * to round-trip instead of re-emitting a freshly lower-cased, comment-free
   * `h'...'` literal. `undefined` when `fromByteLiteral` is `false`.
   */
  readonly literalSource: string | undefined;

  /** Subtree elision: 888(null) */
  constructor(fromByteLiteral?: boolean, literalSource?: string);
  /** String/bytes elision: 888([items...]) */
  constructor(items: CborItem[], realBoundary?: readonly boolean[]);
  constructor(
    itemsOrFromByteLiteral?: CborItem[] | boolean,
    realBoundaryOrLiteralSource?: readonly boolean[] | string
  ) {
    if (Array.isArray(itemsOrFromByteLiteral)) {
      super(CPA888_TAG, new CborArray(itemsOrFromByteLiteral));
      this.fromByteLiteral = false;
      this.literalSource = undefined;
      this.realBoundary = realBoundaryOrLiteralSource as
        readonly boolean[] | undefined;
    } else {
      super(CPA888_TAG, CborSimple.NULL);
      this.fromByteLiteral = itemsOrFromByteLiteral ?? false;
      this.literalSource = realBoundaryOrLiteralSource as string | undefined;
      this.realBoundary = undefined;
    }
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (options?.appPrefix === false) return super._toCDN(options, depth);
    if (this.content instanceof CborSimple) {
      // Subtree elision → "..."
      return '...';
    }
    if (this.content instanceof CborArray) {
      const preserveConcat = !!options?.preserveConcatenation;
      if (
        preserveConcat ||
        (options?.preserveByteString && !this._hasRealConcatenation())
      ) {
        // Show only the real `+` boundaries, fusing everything else exactly
        // as each source literal (e.g. a `h'xx...yy'`, however its own
        // `...` is positioned) was spelled — see `realBoundary`. With no
        // real boundary at all, this is just the one literal's own spelling.
        const preserved = this._renderPreservedBytesElision(options, depth);
        if (preserved !== undefined) return preserved;
      }
      if (!preserveConcat || this.realBoundary === undefined) {
        // Bytes elision where every fragment is a plain byte string: re-emit
        // the compact `h'xx...yy'` literal — the actual CDN grammar for this
        // (§5.2) — instead of expanding it into `h'xx' + ... + h'yy'`. Always
        // hex, regardless of `bstrEncoding`/`sqstr`: `h'...'` is the only
        // elidable literal form: there is no elided base64 or sqstr spelling.
        // Also the fallback when `preserveConcatenation` is set but there is
        // no boundary information to preserve in the first place.
        const compactHex = this._compactHexElided();
        if (compactHex !== undefined) return compactHex;
      }
      // Otherwise (text elision, or bytes elision mixed with something
      // else): frag + ... + frag, single-line unless a comment needs the
      // extra room — see `joinElisionParts`. Under `modernConcat`, the same
      // fragments become one flat `t1<<frag, ..., frag>>` / `b1<<...>>`
      // argument list instead (`...` renders as the literal ellipsis
      // argument concat.ts's own grammar accepts) — unlike the plain
      // (non-elision) concatenation case, this isn't gated on
      // `preserveConcatenation`: an elision chain has no "collapsed single
      // literal" state to fall back to in the first place (the `...` denotes
      // genuinely unknown content, so it always renders as multiple parts —
      // see `preserveConcat` only ever affecting *how much* of a fragment's
      // own internal boundary is shown, e.g. `_renderFragment` vs a fused
      // fragment's own plain `_toCDN()`, never *whether* the top-level chain
      // itself is shown as multiple parts).
      const items = this.content.items;
      const parts = items.map((item) =>
        preserveConcat
          ? this._renderFragment(item, options, depth)
          : item._toCDN(options, depth)
      );
      const preserveComments = shouldEmitComments(options);
      const style = resolveCommentStyle(options);
      const gapComments = items
        .slice(1)
        .map((item, i) =>
          boundaryComments(items[i]!, item, preserveComments, style)
        );
      if (options?.modernConcat) {
        // A group already collapsed to the compact `h'xx...yy'` form (via
        // `_compactHexElided`) never reaches here — only a byte fragment
        // that survives *uncollapsed* (mixed with a text fragment, or with
        // an ellipsis this function doesn't know is byte-typed) counts
        // toward "every real fragment is byte-typed" for prefix selection.
        const isByteOnly = items.every(
          (item) =>
            item instanceof CborByteString ||
            (item instanceof CborEllipsis && item.content instanceof CborSimple)
        );
        return joinAppSeqParts(
          isByteOnly ? 'b1' : 't1',
          parts,
          '',
          resolveIndent(options),
          depth,
          gapComments
        );
      }
      return joinElisionParts(
        parts,
        gapComments,
        resolveIndent(options),
        depth
      );
    }
    return super._toCDN(options, depth);
  }

  /**
   * `true` when this bytes elision has at least one real `+` boundary
   * somewhere — as opposed to being a single `h'xx...yy'` literal's own
   * `...` notation, which is not "produced by + concatenation" (see
   * `preserveByteString`'s own docs) and so has its spelling preserved by
   * `preserveByteString` alone, the same as a non-elided `h'...'` literal.
   *
   * A real boundary can hide two ways: as `realBoundary[i]` (`i > 0`) on the
   * items array itself, or *inside* a merged `CborByteString` whose
   * `ednParts.length > 1` — two `+`-joined literals that sat next to each
   * other with no ellipsis between them (e.g. `h'AB' + h'CD...EF'`) merge
   * into one item during parsing, so their boundary doesn't show up in
   * `realBoundary` at that item's own index.
   */
  private _hasRealConcatenation(): boolean {
    if (this.realBoundary?.some((real, i) => i > 0 && real)) return true;
    const items = (this.content as CborArray).items;
    return items.some(
      (item) =>
        item instanceof CborByteString &&
        item.ednParts !== undefined &&
        item.ednParts.length > 1
    );
  }

  /**
   * Render one elision fragment as it should appear under
   * `preserveConcatenation`: a merged multi-part `CborTextString` (see the
   * parser's `currentParts` consolidation) is expanded back into its
   * original `+`-joined literals, single-line, honoring `preserveRawString`
   * per part. Anything else (a single-part fragment, or a nested
   * `CborEllipsis`) renders normally.
   *
   * Only reached for text elision (or anything not shaped like a pure bytes
   * elision, or a bytes elision with no `realBoundary` information) —
   * `_renderPreservedBytesElision` handles the bytes case that has that
   * information, since it needs to see all the fragments together to know
   * which `...`s are real `+`-joined ellipses and which are internal to one
   * `h'...'` literal.
   */
  private _renderFragment(
    item: CborItem,
    options: ToCDNOptions | undefined,
    depth: number
  ): string {
    const indentStr = resolveIndent(options);
    const preserveComments = shouldEmitComments(options);
    const style = resolveCommentStyle(options);
    // `options?.appPrefix === false` already returned via `super._toCDN`
    // before any caller reaches `_renderFragment` — see this class's own
    // `_toCDN` — so `modernConcat` alone is sufficient here.
    const useT1B1 = !!options?.modernConcat;
    if (
      item instanceof CborByteString &&
      item.ednParts !== undefined &&
      item.ednParts.length > 1
    ) {
      const encoding =
        options?.appPrefix === false
          ? 'hex'
          : (options?.bstrEncoding ?? item.ednEncoding);
      const literals = item.ednParts.map((part) => {
        const source = options?.preserveByteString
          ? preservedSource(part.source, options, indentStr, part.commentSyntax)
          : undefined;
        return source !== undefined
          ? source
          : serializeBytes(part.bytes, encoding, options?.sqstr);
      });
      // These parts merged into one `CborByteString` with no per-part AST
      // node of their own — see `_renderPreservedBytesElision`'s equivalent
      // comment — so a comment between two of them landed as `dangling` on
      // `item` as a whole instead.
      const internalGaps = preserveComments
        ? (danglingCommentsByGap(
            item.comments?.dangling,
            item.ednParts,
            style
          ) ?? [])
        : [];
      // Rendered directly here (rather than delegating to `item._toCDN()`,
      // which already knows how to expand its own `ednParts` under
      // `modernConcat` — see `CborByteString.ts`) because that expansion is
      // gated behind multi-line `indent` there, while an elision fragment's
      // own part boundaries must show regardless of indent, same as the
      // legacy `+` case just below.
      return useT1B1
        ? joinAppSeqParts('b1', literals, '', indentStr, depth, internalGaps)
        : joinElisionParts(literals, internalGaps, indentStr, depth);
    }
    if (
      item instanceof CborTextString &&
      item.ednParts !== undefined &&
      item.ednParts.length > 1
    ) {
      const partSources = options?.preserveRawString
        ? item.ednPartSources
        : undefined;
      const literals = item.ednParts.map((text, i) => {
        const source = partSources?.[i];
        return usableTextSource(source, indentStr)
          ? source
          : escapeString(text);
      });
      const internalGaps = preserveComments
        ? (danglingCommentsByGap(
            item.comments?.dangling,
            item.ednPartSpans,
            style
          ) ?? [])
        : [];
      return useT1B1
        ? joinAppSeqParts('t1', literals, '', indentStr, depth, internalGaps)
        : joinElisionParts(literals, internalGaps, indentStr, depth);
    }
    return item._toCDN(options, depth);
  }

  /**
   * Re-emit a `888([...])` bytes elision as a single `h'xx...yy'` literal
   * when every item is either a plain `CborByteString` fragment or a
   * subtree-elision placeholder (`888(null)`) — i.e. exactly what
   * `h'xx...yy'` parses into. Returns `undefined` when the items don't
   * match that shape (e.g. text-string elision, or a fragment that isn't a
   * plain byte string), so the caller falls back to the `frag + ... + frag`
   * form.
   */
  private _compactHexElided(): string | undefined {
    const items = (this.content as CborArray).items;
    let hex = '';
    let hasByteFragment = false;
    for (const item of items) {
      if (item instanceof CborByteString) {
        hex += bytesToHex(item.value);
        hasByteFragment = true;
      } else if (
        item instanceof CborEllipsis &&
        item.content instanceof CborSimple
      ) {
        hex += '...';
      } else {
        return undefined;
      }
    }
    // Without an actual byte fragment (e.g. the single-item `888([888(null)])`
    // form), there's nothing bytes-specific to show; fall back to the plain
    // `frag + ... + frag` path, which collapses a lone item to just `...`.
    if (!hasByteFragment) return undefined;
    return `h'${hex}'`;
  }

  /**
   * `preserveConcatenation` rendering for a bytes elision. Groups the
   * fragments at every *real* boundary (`realBoundary[i]`) and renders each
   * group as one unit — fusing together whatever sits between real
   * boundaries, including any `h'xx...yy'` literal's own internal `...`
   * (wherever it's positioned — leading, trailing, or in the middle) and
   * the fragments on either side of it, exactly as that literal was
   * written. Within a group, a `CborByteString` that itself merged several
   * `+`-joined literals (`ednParts.length > 1`, always a real boundary
   * internally — see the parser) is further split at each of those parts.
   *
   * Returns `undefined` when there's no `realBoundary` to work from, or an
   * item isn't a plain `CborByteString` or subtree-elision placeholder
   * (e.g. text elision), so the caller falls back to the compact literal or
   * the simpler per-fragment `frag + ... + frag` rendering.
   */
  private _renderPreservedBytesElision(
    options: ToCDNOptions | undefined,
    depth: number
  ): string | undefined {
    if (this.realBoundary === undefined) return undefined;
    const boundary = this.realBoundary;
    const items = (this.content as CborArray).items;

    type Segment =
      | {
          bytes: Uint8Array;
          source?: string;
          commentSyntax?: ByteCommentSyntax;
        }
      | { ellipsis: true; fromByteLiteral: boolean; literalSource?: string };
    const groups: Segment[][] = [];
    // `gapComments[i]` holds already-converted comment text that sat
    // between `groups[i]` and `groups[i + 1]` in the source. Every
    // `flush(comments)` call happens exactly at such a gap — `current`
    // (about to become `groups[gapComments.length]`) is whatever came
    // *before* the gap, and whatever gets pushed to `current` right after
    // this call is what comes *after* it — so each call always records one
    // entry, except the final, argument-less flush at the very end of the
    // method (nothing follows the last group).
    const gapComments: string[][] = [];
    let current: Segment[] = [];
    const flush = (comments?: string[]) => {
      if (current.length > 0) {
        groups.push(current);
        gapComments.push(comments ?? []);
        current = [];
      }
    };

    const preserveComments = shouldEmitComments(options);
    const style = resolveCommentStyle(options);

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (i > 0 && boundary[i])
        flush(boundaryComments(items[i - 1]!, item, preserveComments, style));
      if (item instanceof CborEllipsis && item.content instanceof CborSimple) {
        current.push({
          ellipsis: true,
          fromByteLiteral: item.fromByteLiteral,
          literalSource: item.literalSource,
        });
      } else if (item instanceof CborByteString) {
        if (item.ednParts !== undefined && item.ednParts.length > 1) {
          const [firstPart, ...restParts] = item.ednParts;
          current.push({
            bytes: firstPart.bytes,
            source: firstPart.source,
            commentSyntax: firstPart.commentSyntax,
          });
          // These parts merged into one `CborByteString` with no per-part
          // AST node of their own (no ellipsis sat between them — see
          // `CborEllipsis._hasRealConcatenation`'s doc), so a comment
          // between two of them landed as `dangling` on `item` as a whole
          // instead; re-derive which internal gap each one belongs to.
          const internalGaps = preserveComments
            ? danglingCommentsByGap(
                item.comments?.dangling,
                item.ednParts,
                style
              )
            : undefined;
          restParts.forEach((part, j) => {
            flush(internalGaps?.[j]);
            current.push({
              bytes: part.bytes,
              source: part.source,
              commentSyntax: part.commentSyntax,
            });
          });
        } else {
          current.push({
            bytes: item.value,
            source: item.ednSource,
            commentSyntax: item.ednCommentSyntax,
          });
        }
      } else {
        return undefined;
      }
    }
    // The closing flush has no gap after it, so it bypasses `flush()`'s own
    // comment recording — pushing directly keeps `gapComments.length` at
    // exactly `groups.length - 1`.
    if (current.length > 0) groups.push(current);
    if (groups.length === 0) return undefined;

    const encoding =
      options?.appPrefix === false ? 'hex' : (options?.bstrEncoding ?? 'hex');
    // A preserved source spelling can itself contain embedded newlines
    // (interior whitespace, or a surviving `#`/`//` line comment) — those
    // are only safe to re-emit verbatim when `indent` enables multi-line
    // output; see `preservedSource`. Otherwise fall back to freshly
    // re-serializing the bytes.
    const indentStr = resolveIndent(options);
    const rendered = groups.map((group) => {
      // A group with more than one segment, or a single ellipsis-only
      // group, always came from exactly one `h'xx...yy'` literal (see the
      // parser: nothing but that literal's own atoms ever ends up fused
      // together) — so any ellipsis segment's `literalSource` is that
      // whole group's original spelling.
      if (options?.preserveByteString) {
        for (const s of group) {
          if (!('ellipsis' in s)) continue;
          // Always came from a BYTES_HEX_ELIDED token (see `_elidedHexAtoms`),
          // so its comment syntax is unconditionally hex's full syntax.
          const literalSource = preservedSource(
            s.literalSource,
            options,
            indentStr,
            'full'
          );
          if (literalSource !== undefined) return literalSource;
        }
      }
      const byteSegments = group.filter(
        (
          s
        ): s is {
          bytes: Uint8Array;
          source?: string;
          commentSyntax?: ByteCommentSyntax;
        } => !('ellipsis' in s)
      );
      if (byteSegments.length === 0) {
        // Isolated ellipsis-only group with no preserved source: bare
        // `...` for a genuine standalone ellipsis token, `h'...'` when it
        // came from an elided-hex literal (even an entirely-elided one)
        // to keep its byte-typed spelling.
        const fromByteLiteral = group.some(
          (s) => 'ellipsis' in s && s.fromByteLiteral
        );
        return fromByteLiteral ? "h'...'" : '...';
      }
      if (group.length === 1) {
        const segment = byteSegments[0];
        const source = options?.preserveByteString
          ? preservedSource(
              segment.source,
              options,
              indentStr,
              segment.commentSyntax
            )
          : undefined;
        return source !== undefined
          ? source
          : serializeBytes(segment.bytes, encoding, options?.sqstr);
      }
      const hex = group
        .map((s) => ('ellipsis' in s ? '...' : bytesToHex(s.bytes)))
        .join('');
      return `h'${hex}'`;
    });
    // `groups.length === 1` (nothing to concatenate — this method can also
    // be reached via `preserveByteString` alone, with no real `+` boundary
    // at all) has nothing for `modernConcat` to change: both branches
    // collapse to the one rendered literal, so only switch notation when
    // there's an actual boundary to show.
    if (
      options?.preserveConcatenation &&
      options?.modernConcat &&
      rendered.length > 1
    ) {
      return joinAppSeqParts('b1', rendered, '', indentStr, depth, gapComments);
    }
    return joinElisionParts(rendered, gapComments, indentStr, depth);
  }
}
