/**
 * Pure utility functions for EDN serialization.
 * No AST imports — safe to import from any AST class.
 */

import type { CborComment, CborComments, ToCDNOptions } from '../types';
import type { EncodingWidth } from '../cbor/encode';
import type { AppSeqEncodingEdit, AppSeqSourceFeatures } from '../ast/CborItem';
import { bytesToHex as toHex, hexToBytes } from '../utils/hex';
import { base64ToBytes } from '../utils/base64';
import { Tokenizer, type Token, type SqstrToken } from './tokenizer';

/**
 * Append every element of `source` onto `target` in place.
 *
 * Not `target.push(...source)`: spreading a large array as call arguments
 * can exceed the engine's argument-count limit (observed with hex-dump
 * lines for a deeply nested large array/map, and with CDN reflow
 * breakpoints for a large embedded array — RangeError: Maximum call stack
 * size exceeded).
 */
export function pushAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) target.push(item);
}

// ─── Indent helpers ───────────────────────────────────────────────────────────

/** Resolve indent option to a string, or null for single-line output. */
export function resolveIndent(
  options: ToCDNOptions | undefined
): string | null {
  const indent = options?.indent;
  if (indent === undefined) return null;
  const indentStr = typeof indent === 'number' ? ' '.repeat(indent) : indent;
  // `0` / `''` disable pretty-printing entirely (like `JSON.stringify`).
  return indentStr === '' ? null : indentStr;
}

/** Build the indent prefix for a given depth. */
export function indentOf(indentStr: string, depth: number): string {
  return indentStr.repeat(depth);
}

/**
 * Join pre-serialized string-concatenation part literals with `+`.
 *
 * Single-line (` + `) when indent is disabled; otherwise each continuation
 * part starts on its own line, indented one level deeper than the owner.
 *
 * `midComments`, when given, holds already-converted comment lines for each
 * gap between two consecutive parts (`midComments[i]` sits between
 * `literals[i]` and `literals[i + 1]`) — e.g. a comment between two
 * `+`-joined byte-string literals, which has nowhere else to attach since
 * there is no per-part AST node. Ignored in single-line mode, matching every
 * other comment kind.
 */
export function joinConcatParts(
  literals: readonly string[],
  indentStr: string | null,
  depth: number,
  midComments?: readonly (readonly string[])[]
): string {
  if (indentStr === null) return literals.join(' + ');
  const indent = indentOf(indentStr, depth + 1);
  let out = literals[0]!;
  for (let i = 1; i < literals.length; i++) {
    out += ' +\n';
    for (const comment of midComments?.[i - 1] ?? []) {
      out += `${indent}${comment}\n`;
    }
    out += indent + literals[i];
  }
  return out;
}

/**
 * Serialize string parts as a `t1<<...>>` / `b1<<...>>` app-sequence
 * (draft-ietf-cbor-edn-literals-27 §3.5) — the `modernConcat` replacement
 * for `joinConcatParts`'s `+`-joining. Unlike a `+` chain, this
 * notation has its own closing delimiter, so (matching how `<<...>>`/
 * `CborEmbeddedCBOR` places its own encoding-width indicator, and unlike
 * `emitParts`, which has nowhere else to put it) `suffix` is appended after
 * `>>` rather than onto the last literal — it describes the one merged value
 * `t1<<...>>` denotes as a whole, not any individual argument.
 *
 * Always single-line (an app-sequence is loose/collapsible, like
 * every other `<<...>>` form), except when there's a mid-chain comment to
 * preserve — nothing else forces it multi-line, since (unlike a real `+`
 * chain) there's no risk of an unbounded single line growing unreadable that
 * this format was ever meant to solve; a comment is the one thing a single
 * line genuinely cannot hold, mirroring `joinConcatParts`'s own reason for
 * going multi-line.
 */
export function joinAppSeqParts(
  prefix: 't1' | 'b1',
  literals: readonly string[],
  suffix: string,
  indentStr: string | null,
  depth: number,
  midComments?: readonly (readonly string[])[]
): string {
  const hasMidComments = midComments?.some((c) => c.length > 0) ?? false;
  if (indentStr === null || !hasMidComments) {
    return `${prefix}<<${literals.join(', ')}>>${suffix}`;
  }
  const indent = indentOf(indentStr, depth + 1);
  const closeIndent = indentOf(indentStr, depth);
  const lines: string[] = [];
  for (let i = 0; i < literals.length; i++) {
    const sep = i < literals.length - 1 ? ',' : '';
    lines.push(`${indent}${literals[i]}${sep}`);
    for (const comment of midComments?.[i] ?? []) {
      lines.push(`${indent}${comment}`);
    }
  }
  return `${prefix}<<\n${lines.join('\n')}\n${closeIndent}>>${suffix}`;
}

// ─── Comment helpers ─────────────────────────────────────────────────────────

export interface Commented {
  comments?: CborComments;
  blankLineBefore?: boolean;
}

export function hasPreservedComments(item: Commented): boolean {
  return Boolean(
    item.comments?.leading?.length ||
    item.comments?.trailing?.length ||
    item.comments?.dangling?.length
  );
}

export function hasContainerLayoutComments(item: Commented): boolean {
  // Only dangling comments force the container itself onto multiple lines —
  // they live inside the brackets on their own line. A trailing comment on
  // the container is appended after the closing bracket by the caller (root
  // `toCDN()` or the parent's `entryTrailing`), so it never needs the body
  // to break, and single/flat rendering stays available.
  return Boolean(item.comments?.dangling?.length);
}

/**
 * Convert a single comment's text to the requested marker style.
 *
 * Conversion table:
 *   c-style  : `#` → `//`, `/ … /` → `/* … *\/`
 *   cdn-style: `//` → `#`, `/* … *\/` → `/ … /`
 *
 * Special case for cdn-style: when the inner content of `/* … *\/` starts
 * with `*` or `/` the result would look like `/*…` or `//…` — a different
 * comment form.  A single space is inserted after the opening `/` to prevent
 * this (e.g. `/**…*\/` → `/ *…/`).
 */
export function convertCommentText(
  comment: CborComment,
  style: 'c-style' | 'cdn-style' | undefined
): string {
  if (!style) return comment.text;
  const { marker, text } = comment;

  if (style === 'c-style') {
    if (marker === '#') return '//' + text.slice(1);
    if (marker === '/') return '/*' + text.slice(1, -1) + '*/';
    return text; // already // or /*...*/
  }

  // cdn-style
  if (marker === '//') return '#' + text.slice(2);
  if (marker === '/*') {
    const inner = text.slice(2, -2);
    // / … / comments have no escape mechanism for '/', so if the content
    // contains one we must keep the /* … */ form to avoid corrupting output.
    if (inner.includes('/')) return text;
    const safeInner =
      inner.startsWith('*') || inner.startsWith('/') ? ' ' + inner : inner;
    return '/' + safeInner + '/';
  }
  return text; // already # or /.../
}

/**
 * Bucket a flat, source-ordered list of comments (typically a node's own
 * `comments.dangling`) by which gap between two consecutive `parts` each
 * one's offset falls into — `result[i]` sits between `parts[i]` and
 * `parts[i + 1]`, already converted to the requested marker style.
 *
 * Used for a comment that sits between two `+`-joined fragments merged into
 * a single value with no per-fragment AST node of its own to attach to (a
 * concatenated `CborByteString`'s own `ednParts`, or — inside a bytes
 * elision — a `CborEllipsis` item's `ednParts`): `attachComments` can only
 * land such a comment on the merged node as a whole, as `dangling`, so this
 * re-derives which specific gap it belongs in from each part's own
 * `start`/`end` span. A comment is dropped (as it already was before this
 * function existed) when either neighbouring part lacks a known span — a
 * part merged from a single elided literal's own internal segments, which
 * cannot have a comment between them anyway (see `_elidedHexAtoms`).
 *
 * Returns `undefined` (rather than an all-empty array) when nothing landed
 * in any gap, so callers can cheaply skip the mid-comment rendering path
 * entirely in the common case.
 */
export function danglingCommentsByGap(
  dangling: readonly CborComment[] | undefined,
  parts: readonly { start?: number; end?: number }[] | undefined,
  style: 'c-style' | 'cdn-style' | undefined
): string[][] | undefined {
  if (!dangling || dangling.length === 0 || !parts || parts.length < 2)
    return undefined;
  const gaps: string[][] = parts.slice(1).map(() => []);
  let anyFound = false;
  for (const comment of dangling) {
    for (let i = 0; i < parts.length - 1; i++) {
      const prevEnd = parts[i]!.end;
      const nextStart = parts[i + 1]!.start;
      if (
        prevEnd !== undefined &&
        nextStart !== undefined &&
        comment.start >= prevEnd &&
        comment.end <= nextStart
      ) {
        gaps[i]!.push(convertCommentText(comment, style));
        anyFound = true;
        break;
      }
    }
  }
  return anyFound ? gaps : undefined;
}

/**
 * Split an item's leading comments into ones that get their own line above
 * it, and a trailing run of comments the parser found on the same source
 * line as the item itself (`CborComment.sameLine`) — e.g.
 * `/ protected / << ... >>,` in an RFC 9052-style annotated array. Since
 * comments and the item they lead up to appear in strictly increasing
 * source order, `sameLine` comments always form a contiguous run at the end
 * of the list (nothing can sit between a same-line comment and the item
 * without itself being on that same line).
 *
 * `ownLines` renders like `formatLeadingComments` used to; `inlinePrefix` is
 * meant to be prepended directly to the item's own rendered line (already
 * includes a trailing space per comment, or `''` when there is none).
 */
export function splitLeadingComments(
  item: Commented,
  indent: string,
  style?: 'c-style' | 'cdn-style' | undefined
): { ownLines: string[]; inlinePrefix: string } {
  const leading = item.comments?.leading ?? [];
  let splitAt = leading.length;
  while (splitAt > 0 && leading[splitAt - 1]!.sameLine) splitAt--;
  return {
    ownLines: leading
      .slice(0, splitAt)
      .map((comment) => indent + convertCommentText(comment, style)),
    inlinePrefix: leading
      .slice(splitAt)
      .map((comment) => convertCommentText(comment, style) + ' ')
      .join(''),
  };
}

export function formatTrailingComments(
  item: Commented,
  style?: 'c-style' | 'cdn-style' | undefined
): string {
  const comments = item.comments?.trailing ?? [];
  if (comments.length === 0) return '';
  return (
    ' ' +
    comments.map((comment) => convertCommentText(comment, style)).join(' ')
  );
}

export function formatDanglingComments(
  item: Commented,
  indent: string,
  style?: 'c-style' | 'cdn-style' | undefined
): string[] {
  return (item.comments?.dangling ?? []).map(
    (comment) => indent + convertCommentText(comment, style)
  );
}

// ─── Comma / separator helpers ────────────────────────────────────────────────

/**
 * Resolve separator options into concrete strings.
 *
 * @param compact - When `true` (no `indent` option), omit spaces around
 *   separators to produce compact single-line output (like `JSON.stringify`).
 *
 * @returns
 *   - `inlineSep`    – between items on a single line
 *   - `multilineSep` – appended after each non-last line in multi-line mode
 *   - `trailSep`     – appended after the last item (empty string or `,`)
 *   - `colSep`       – between map key and value (`': '` or `':'`)
 */
export function resolveSeparators(
  options: ToCDNOptions | undefined,
  compact = false
): {
  inlineSep: string;
  multilineSep: string;
  trailSep: string;
  colSep: string;
} {
  const commas = options?.commas ?? 'comma';
  const useCommas = commas !== 'none';
  const trailing = commas === 'trailing';
  return {
    inlineSep: useCommas ? (compact ? ',' : ', ') : ' ',
    multilineSep: useCommas ? ',' : '',
    trailSep: trailing ? ',' : '',
    colSep: compact ? ':' : ': ',
  };
}

// ─── Container serialization ─────────────────────────────────────────────────

/**
 * Shared CDN serialization for bracketed containers (CborArray / CborMap /
 * indefinite-length string chunks `(_ ...)`):
 * encoding-indicator / `_` prefix resolution, single-line vs multi-line
 * selection, separators, and per-entry leading/trailing plus container
 * dangling comments. Single-line output (no `indent`) always strips
 * comments — line comments can only be terminated by a newline.
 *
 * Entries are accessed through per-index callbacks (not materialised entry
 * objects) so the common no-comments/no-blank-line path allocates nothing
 * per entry. `hasEntryComments` and `entryTrailing` are consulted only when
 * `preserveComments` is set; `entryLeadingNode` is also consulted when
 * `preserveBlankLines` is set, independently of `preserveComments`, to read
 * its `blankLineBefore` flag. `renderEntry` receives the resolved `colSep`
 * (': ' or ':' depending on compact mode) for rendering map pairs.
 */
export function serializeContainer(p: {
  node: Commented;
  options: ToCDNOptions | undefined;
  depth: number;
  openChar: string;
  closeChar: string;
  count: number;
  indefiniteLength: boolean;
  /**
   * Whether an indefinite-length container shows the `_` marker
   * (`(_ "a", "b")`) before its content. Defaults to `true`; set `false` for
   * a container that denotes an indefinite-length value through some other
   * notation entirely (e.g. `ilts<<"a", "b">>`) rather than through the
   * `_`-marked legacy streamstring form — the value is still genuinely
   * indefinite-length (so `indefiniteLength: true` still correctly
   * suppresses any encoding-width suffix, which has no meaning for it), but
   * that other notation has no `_` marker of its own to show.
   */
  indefiniteMarker?: boolean;
  encodingWidth: EncodingWidth | undefined;
  /**
   * Where the resolved encoding-indicator suffix is placed.
   * - `'open'` (default): right after `openChar`, before the content
   *   (`[_2 1,2,3]`) — the head this indicator describes encodes entry count.
   * - `'close'`: right after `closeChar`, with no separating space
   *   (`<<1,2>>_1`) — for `CborEmbeddedCBOR`, whose byte-string head encodes
   *   content byte length, not entry count.
   */
  eiPosition?: 'open' | 'close';
  /**
   * Basis for canonical-encoding-width detection (`encodingIndicators:
   * 'auto'`/`'always'` with no explicit `encodingWidth`). Defaults to
   * `count`, matching the CBOR array/map head. `CborEmbeddedCBOR` overrides
   * this to its encoded content's byte length instead.
   */
  canonicalCount?: () => bigint;
  hasEntryComments: () => boolean;
  /** Render entry `i` at child depth (`item` or `key: value`). */
  renderEntry: (i: number, colSep: string) => string;
  /**
   * Whether entry `i` contains no nested array/map, so it may stay on the
   * container's line under `inlineLeafContainers` (or always, when
   * `alwaysInlineLeaf` is set). Omitted = always a leaf (used by
   * `CborEmbeddedCBOR`, where an entry that is itself a container still
   * inlines as long as its own rendering fits on one line).
   */
  entryIsLeaf?: (i: number) => boolean;
  /**
   * Whether entry `i` is, or wraps, a text string or byte string with two or
   * more words (`isMultiWordText` / `isMultiWordByteString`). When true,
   * disqualifies the container from staying on one line under
   * `inlineLeafContainers` (or `alwaysInlineLeaf`) even though the entry has
   * no nested array/map — a multi-word string reads better with a line of
   * its own. This does *not* also cover a prefixed literal like `h'...'`
   * (which has no word count to check at all, but still disqualifies under
   * the strict rule) — that's covered separately, generically, by
   * `isPrefixedLiteralText` (checked against the rendered entry `s` below)
   * or, for a `CborTag`, `isMultiWordRenderedLiteral`. Omitted = never
   * disqualifies.
   */
  entryIsMultiWordText?: (i: number) => boolean;
  /**
   * Always run the one-line collapse probe, regardless of
   * `options.inlineLeafContainers`. Set only by `CborEmbeddedCBOR`
   * (`<<...>>`): unlike `CborArray`/`CborMap`, where spreading entries one
   * per line is a deliberate structural default that `inlineLeafContainers`
   * opts out of, a flat sequence of encoded items has no such structure to
   * display — there's nothing gained by always breaking it, so it
   * collapses onto one line whenever it fits independent of the option.
   * Indefinite-length string groups (`(_ "a", "b")`) do *not* get this
   * treatment — they follow CborArray/CborMap's option-gated default
   * instead, providing `entryIsLeaf` the same way (see `strict` below),
   * despite also being a "loose rule" container in the
   * `_containsCdnContainer`/`entryHasContainer` sense (a chunk can never
   * actually be an array/map, so that distinction is moot for them in
   * practice). This flag and the loose/strict distinction are genuinely
   * independent concerns, not the same thing.
   */
  alwaysInlineLeaf?: boolean;
  /** Node whose leading comments are emitted above entry `i` (item / map key). */
  entryLeadingNode: (i: number) => Commented;
  /** Pre-formatted trailing comment text for entry `i` (starts with ' ', or ''). */
  entryTrailing: (
    i: number,
    style: 'c-style' | 'cdn-style' | undefined
  ) => string;
}): string {
  const { options, depth, openChar, closeChar, count } = p;
  const indentStr = resolveIndent(options);
  const preserveComments = options?.preserveComments;
  const commentStyle =
    typeof preserveComments === 'string' ? preserveComments : undefined;
  const hasComments =
    indentStr !== null &&
    preserveComments &&
    (hasContainerLayoutComments(p.node) || p.hasEntryComments());
  const preserveBlankLines =
    indentStr !== null && !!options?.preserveBlankLines;
  let hasBlankLines = false;
  if (preserveBlankLines) {
    for (let i = 0; i < count; i++) {
      if (p.entryLeadingNode(i).blankLineBefore) {
        hasBlankLines = true;
        break;
      }
    }
  }
  const { inlineSep, multilineSep, trailSep, colSep } = resolveSeparators(
    options,
    indentStr === null
  );
  const eiPosition = p.eiPosition ?? 'open';
  const eiRaw = p.indefiniteLength
    ? ''
    : resolveEiSuffix(options, p.encodingWidth, () =>
        canonicalEncodingWidth(
          p.canonicalCount ? p.canonicalCount() : BigInt(count)
        )
      );
  const eiSuffix = eiPosition === 'open' && eiRaw ? eiRaw + ' ' : '';
  const closeSuffix = eiPosition === 'close' ? eiRaw : '';
  const showIndef =
    p.indefiniteLength &&
    (p.indefiniteMarker ?? true) &&
    (options?.encodingIndicators ?? 'auto') !== 'never';

  const singleLine = (inner: string): string => {
    if (p.indefiniteLength) {
      return showIndef
        ? count === 0
          ? `${openChar}_ ${closeChar}`
          : `${openChar}_ ${inner}${closeChar}`
        : `${openChar}${inner}${closeChar}`;
    }
    return `${openChar}${eiSuffix}${inner}${closeChar}${closeSuffix}`;
  };

  if (indentStr === null || (count === 0 && !hasComments)) {
    // single-line
    let inner = '';
    for (let i = 0; i < count; i++) {
      if (i > 0) inner += inlineSep;
      inner += p.renderEntry(i, colSep);
    }
    return singleLine(inner);
  }

  // inlineLeafContainers: keep the container on one line when no entry holds
  // a nested array/map, no entry is a multi-word string, and every entry
  // renders without a line break. `alwaysInlineLeaf` runs the same probe
  // unconditionally (see its doc) — the container-specific option value
  // doesn't otherwise change what the probe checks.
  // Entries rendered here via `renderEntry` are reused below if the probe
  // fails, so *this* function never calls `renderEntry` more than once per
  // entry per parent render. This doesn't extend to what `entryIsLeaf`/
  // `entryIsMultiWordText` do internally, though: `CborTag`'s
  // `_isMultiWordText` deliberately renders `this.content` once here (via
  // its prefixed-literal fallback) and `renderEntry` renders it again for
  // real — an accepted double-render, not an oversight (see CborTag.ts for
  // why an instance-level cache to avoid it turned out to be unsafe).
  let probed: string[] | null = null;
  if (
    (options?.inlineLeafContainers || p.alwaysInlineLeaf) &&
    count > 0 &&
    !hasComments &&
    !hasBlankLines
  ) {
    // `entryIsLeaf`'s presence doubles as the strict/loose signal here:
    // CborArray/CborMap and the indefinite-length string groups (the
    // strict rule) all provide it — only CborEmbeddedCBOR (the one
    // container whose collapse isn't gated behind `inlineLeafContainers`
    // at all) omits it. Reused below to gate `isPrefixedLiteralText`
    // (and, for a `CborTag`, `isMultiWordRenderedLiteral`'s equivalent
    // gating): a prefixed literal like `h'...'` disqualifies under the
    // strict rule but is an ordinary leaf under the loose one — e.g.
    // `<<h'00'>>` stays inline, but `(_ h'00')`/`[h'00']` still disqualify.
    const strict = !!p.entryIsLeaf;
    const rendered: string[] = [];
    let flat = true;
    for (let i = 0; i < count; i++) {
      if (p.entryIsLeaf && !p.entryIsLeaf(i)) {
        flat = false;
        break;
      }
      if (p.entryIsMultiWordText?.(i)) {
        flat = false;
        break;
      }
      const s = p.renderEntry(i, colSep);
      rendered.push(s);
      if (s.includes('\n')) {
        flat = false;
        break;
      }
      if (strict && isPrefixedLiteralText(s)) {
        flat = false;
        break;
      }
    }
    if (flat) return singleLine(rendered.join(inlineSep));
    probed = rendered;
  }

  // multi-line
  const childIndent = indentOf(indentStr, depth + 1);
  const closeIndent = indentOf(indentStr, depth);
  const open = p.indefiniteLength
    ? showIndef
      ? `${openChar}_ `
      : openChar
    : `${openChar}${eiSuffix}`;
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    if (preserveBlankLines && p.entryLeadingNode(i).blankLineBefore) {
      lines.push('');
    }
    let inlinePrefix = '';
    if (preserveComments) {
      const { ownLines, inlinePrefix: prefix } = splitLeadingComments(
        p.entryLeadingNode(i),
        childIndent,
        commentStyle
      );
      pushAll(lines, ownLines);
      inlinePrefix = prefix;
    }
    const sep = i < count - 1 ? multilineSep : trailSep;
    const entry = probed?.[i] ?? p.renderEntry(i, colSep);
    lines.push(
      `${childIndent}${inlinePrefix}${entry}${sep}${preserveComments ? p.entryTrailing(i, commentStyle) : ''}`
    );
  }
  if (preserveComments)
    pushAll(lines, formatDanglingComments(p.node, childIndent, commentStyle));
  const body = lines.join('\n');
  return `${open}\n${body}\n${closeIndent}${closeChar}${closeSuffix}`;
}

/**
 * Single-child counterpart to `serializeContainer`, for a wrapper that
 * holds exactly one child inside `openChar`/`closeChar` (currently just
 * `CborTag`'s `(content)`) rather than a comma-separated list of entries.
 *
 * Emits the child's own leading/trailing comments, and the wrapper node's
 * `dangling` comments (a comment positioned after the child but still
 * inside the brackets, with nothing following it to attach to as leading —
 * mirroring how `serializeContainer` handles a container's own dangling
 * comments). Falls back to the plain single-line `(content)` form — the
 * common, zero-allocation-beyond-string-concat path — when comments aren't
 * requested/applicable (no indent, no `preserveComments`, or neither the
 * child nor the wrapper has any).
 *
 * `renderChild` is called with the child's depth exactly once, resolved
 * *before* calling it: `depth + 1` when comments force multi-line
 * rendering, `depth` otherwise (matching a plain value's existing
 * "transparent" nesting — `tag(content)` doesn't indent `content` an extra
 * level when there's nothing to justify going multi-line for).
 */
export function renderSingleChildWithComments(
  child: Commented,
  wrapper: Commented,
  options: ToCDNOptions | undefined,
  depth: number,
  renderChild: (childDepth: number) => string,
  openChar: '(',
  closeChar: ')'
): string {
  const indentStr = resolveIndent(options);
  const preserveComments = options?.preserveComments;
  const hasComments =
    indentStr !== null &&
    !!preserveComments &&
    (hasPreservedComments(child) || hasContainerLayoutComments(wrapper));
  if (!hasComments) return `${openChar}${renderChild(depth)}${closeChar}`;
  const commentStyle =
    typeof preserveComments === 'string' ? preserveComments : undefined;
  const childIndent = indentOf(indentStr!, depth + 1);
  const closeIndent = indentOf(indentStr!, depth);
  const { ownLines, inlinePrefix } = splitLeadingComments(
    child,
    childIndent,
    commentStyle
  );
  const lines = [
    ...ownLines,
    `${childIndent}${inlinePrefix}${renderChild(depth + 1)}${formatTrailingComments(child, commentStyle)}`,
    ...formatDanglingComments(wrapper, childIndent, commentStyle),
  ];
  return `${openChar}\n${lines.join('\n')}\n${closeIndent}${closeChar}`;
}

// ─── Byte string encoding ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _hasNativeToBase64 =
  typeof (new Uint8Array(0) as any).toBase64 === 'function';

function toBase64(bytes: Uint8Array): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (_hasNativeToBase64) return (bytes as any).toBase64({ omitPadding: true });
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, '');
}

function toBase64Url(bytes: Uint8Array): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (_hasNativeToBase64)
    return (bytes as any).toBase64({
      alphabet: 'base64url',
      omitPadding: true,
    });
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const H32_ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUV';

function base32Encode(bytes: Uint8Array, alpha: string): string {
  let result = '';
  let buf = 0,
    bufBits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bufBits += 8;
    while (bufBits >= 5) {
      bufBits -= 5;
      result += alpha[(buf >> bufBits) & 0x1f];
    }
  }
  if (bufBits > 0) result += alpha[(buf << (5 - bufBits)) & 0x1f];
  return result;
}

/**
 * Returns true if the string contains any C0 control character (U+0000–U+001F)
 * or DEL (U+007F).
 */
function _hasNonPrintable(s: string): boolean {
  for (const char of s) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) return true;
  }
  return false;
}

/**
 * The decoded text `bytes` would render as under a bare sqstr literal
 * (`'...'`) for the given `sqstr` option, or `null` when it would instead
 * render as a prefixed literal (`h'...'`, `b64'...'`, ...). Shared by
 * `serializeBytes` (the actual rendering decision) and `isMultiWordByteString`
 * (which needs to know the same thing without rendering).
 */
function _sqstrTextOrNull(
  bytes: Uint8Array,
  sqstr?: 'printable-string' | 'string' | 'none'
): string | null {
  if (sqstr === 'string') {
    const s = _tryDecodeUtf8(bytes);
    if (s != null) return s;
  }
  if (sqstr === 'printable-string' || sqstr === undefined) {
    const s = _tryDecodeUtf8(bytes);
    if (s != null && !_hasNonPrintable(s)) return s;
  }
  return null;
}

export function serializeBytes(
  bytes: Uint8Array,
  encoding?: 'hex' | 'base64' | 'base64url' | 'base32' | 'base32hex',
  sqstr?: 'printable-string' | 'string' | 'none'
): string {
  const sqstrText = _sqstrTextOrNull(bytes, sqstr);
  if (sqstrText !== null) return _escapeSingleQuoted(sqstrText);
  switch (encoding) {
    case 'base64':
      return `b64'${toBase64(bytes)}'`;
    case 'base64url':
      return `b64'${toBase64Url(bytes)}'`;
    case 'base32':
      return `b32'${base32Encode(bytes, B32_ALPHA)}'`;
    case 'base32hex':
      return `h32'${base32Encode(bytes, H32_ALPHA)}'`;
    case 'hex':
    default:
      return `h'${toHex(bytes)}'`;
  }
}

/**
 * True when `bytes` would render as a bare sqstr literal (`'...'`) under
 * `sqstr` *and* its decoded text has two or more words — same rule as a
 * plain text string's own word count. Otherwise (it would render as a
 * prefixed literal like `h'...'`/`b64'...'`, or as something else entirely
 * via a subclass overriding `_toCDN()`) this returns `false`: a prefixed
 * literal has no natural word boundary to predict from raw bytes alone,
 * and — unlike this function, which never renders anything — the actual
 * "does the real output look like a disqualifying prefixed literal, tag
 * wrapping, or app-sequence spelling" question is answered generically
 * from the *rendered* text instead, by `isPrefixedLiteralText` (for a bare
 * entry) or `isMultiWordRenderedLiteral` (for a `CborTag`, which needs to
 * see through its own digits/parens onto whatever they wrap).
 */
export function isMultiWordByteString(
  bytes: Uint8Array,
  sqstr?: 'printable-string' | 'string' | 'none'
): boolean {
  const text = _sqstrTextOrNull(bytes, sqstr);
  return text !== null && isMultiWordText(text);
}

/** An identifier immediately followed by `'` or a backtick — see `isPrefixedLiteralText`. */
const PREFIXED_LITERAL_RE = /^[A-Za-z][A-Za-z0-9-]*['`]/;

/**
 * True when `rendered` — a single entry's own CDN rendering — is shaped
 * like a prefixed literal: an identifier immediately followed by `'` or a
 * backtick (`h'...'`, `b64'...'`, `ip'...'`, `dt'...'`, or any other
 * app-string extension's own spelling, built-in or user-defined). These
 * have no natural word boundary to check, so — like a byte string's own
 * prefixed-literal case in `isMultiWordByteString` — the strict
 * `inlineLeafContainers` rule (`CborArray`/`CborMap`, and the
 * indefinite-length string groups) always disqualifies a container from
 * collapsing onto one line when an entry looks like this; the loose rule
 * (only `CborEmbeddedCBOR`/`<<...>>`) treats it as an ordinary leaf
 * instead.
 *
 * This is a generic, rendering-based catch-all — unlike `isMultiWordByteString`,
 * it doesn't need per-extension-class support, so it also covers any
 * app-string extension (registered under `CborExtension.appStringPrefixes`)
 * without that extension's own `CborItem` subclass needing to know about
 * `inlineLeafContainers` at all. It only sees a *bare* prefixed literal
 * (nothing else in `rendered`); `CborTag` uses `isMultiWordRenderedLiteral`
 * instead to see through its own tag digits/parens onto whatever they wrap.
 */
export function isPrefixedLiteralText(rendered: string): boolean {
  return PREFIXED_LITERAL_RE.test(rendered);
}

const textDecoderForRenderedLiteral = new TextDecoder();

/**
 * True when `rendered` — a leaf entry's own, already-rendered CDN text —
 * counts as multi-word for `inlineLeafContainers`'s purposes, determined by
 * tokenizing `rendered` itself rather than predicting from whichever
 * `CborItem` subclass produced it. This makes it exact regardless of *how*
 * the text came to look the way it does — a `CborTag` subclass
 * (`CborTaggedIpExt`) overriding `_toCDN()` to render `IP<<'...'>>` instead
 * of generic `52(...)` tag notation, a preserved `preserveByteString`
 * spelling, `encodingIndicators: 'always'` adding an explicit `_N`/`_i`
 * suffix everywhere, or anything else — since it never assumes a rendering
 * path, only reads the result.
 *
 * Recognizes these shapes. Any of them may be followed by one trailing
 * `ENCODING_INDICATOR` token (`_0`.._3`/`_i`) — stripped *before* any shape
 * is recognized (not just for a bare literal), since it can trail a tag or
 * an app-sequence wrapper too and never changes a value's own shape or
 * word count:
 * - A bare quoted literal (`"..."`, `` `...` ``, or a bare `'...'` sqstr):
 *   always counts if its *decoded* content has two or more words,
 *   regardless of `strict` — matching a text string's own word count.
 * - A prefixed literal (`h'...'`, `b64'...'`, `ip'...'`, `dt'...'`, ...):
 *   has no natural word boundary to check, so it counts only when `strict`.
 * - A generic tag wrapper (`tagNum[_EI](...)`) spanning the *entire* input:
 *   peels off just that one layer and recurses on what's inside (handling
 *   nested tags one layer at a time) — this is what lets a plain `CborTag`
 *   whose content is one of the shapes above still count, e.g.
 *   `100(dt'...')`, `100("two words")`, or (with `encodingIndicators:
 *   'always'`) `100_0("two words"_i)`.
 * - An app-sequence wrapper (`prefix<<item item ...>>`, tokenized as one
 *   `APP_SEQUENCE` opener and a plain `GT_GT` closer) spanning the *entire*
 *   input: unlike a tag, its own `<<...>>` is never peeled away — reading
 *   fine inline is the whole point of that notation, not a transparent
 *   single-value rewrap — but each top-level item inside (items may be
 *   separated by a comma, by whitespace alone, or both, per CDN's own
 *   grammar — `consumeOneItem` finds each one's extent structurally rather
 *   than only splitting at commas) is checked under the *loose* rule
 *   (`strict: false`, matching `<<...>>` itself) regardless of the
 *   `strict` this function was called with, so a multi-word text item
 *   (`ilts<<"two words">>`, or `ilts<<"two words" "x">>` with no comma at
 *   all) still always counts, while a prefixed-literal item
 *   (`ilbs<<h'00'>>`) — unlike the same literal bare or tag-wrapped —
 *   does not.
 * - Anything else (a number, `true`/`false`, multiple top-level tokens that
 *   aren't one of the wrappers above, ...) never counts.
 *
 * Tokenizing can throw on malformed input; since `rendered` is always this
 * library's own output, that should never happen, but a failure is treated
 * as "not multi-word" rather than propagating.
 */
export function isMultiWordRenderedLiteral(
  rendered: string,
  strict: boolean
): boolean {
  let tokens: Token[];
  try {
    tokens = tokenizeAll(rendered);
  } catch {
    return false;
  }
  return isMultiWordTokenRange(tokens, 0, tokens.length, strict);
}

function tokenizeAll(source: string): Token[] {
  const tokenizer = new Tokenizer(source);
  const tokens: Token[] = [];
  for (;;) {
    const token = tokenizer.consume();
    if (token.type === 'EOF') return tokens;
    tokens.push(token);
  }
}

// Token types that open/close a bracket-like span. A single, type-agnostic
// depth counter is safe for matching (no need to verify e.g. RPAREN closes
// specifically an LPAREN) because `rendered` is always this library's own,
// already-well-formed output — bracket families never interleave in valid
// CDN, so a generic opener/closer never has to disambiguate which family
// it belongs to.
const BRACKET_OPENERS = new Set([
  'LPAREN',
  'LBRACKET',
  'LBRACE',
  'LT_LT',
  'APP_SEQUENCE',
]);
const BRACKET_CLOSERS = new Set(['RPAREN', 'RBRACKET', 'RBRACE', 'GT_GT']);

// Token types that can appear as any part — the chain's own first value,
// or any later one joined by `+` — of a `+`-concatenation chain: a
// text-string/byte-string literal (draft-25 §5.1), or `ELLIPSIS` (`...`), CDN's
// elision-chain notation (src/cdn/parser.ts's own `+`-chain grammar
// accepts it both as the chain's *own* first value — `... + "b"`, an
// unknown prefix concatenated with a known suffix — and as any later
// continuation — `"a" + ...` — building a tag-888-wrapped value instead of
// a plain joined string) for a part deliberately omitted. Never numbers,
// tags, containers, or app-strings.
const CHAIN_ATOM_TYPES = new Set([
  'TSTR',
  'RAWSTRING',
  'SQSTR',
  'BYTES_HEX',
  'BYTES_HEX_ELIDED',
  'BYTES_B64',
  'ELLIPSIS',
]);

/**
 * Index of the token that closes the bracket opened at `openIdx`, scanning
 * up to (excluding) `end`. Returns `null` if unmatched in range.
 */
function findMatchingClose(
  tokens: Token[],
  openIdx: number,
  end: number
): number | null {
  let depth = 1;
  for (let j = openIdx + 1; j < end; j++) {
    const t = tokens[j].type;
    if (BRACKET_OPENERS.has(t)) depth++;
    else if (BRACKET_CLOSERS.has(t)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return null;
}

/**
 * Index one past the end of the single CDN value starting at `start`
 * (scanning up to, exclusive, `end`), or `null` if `start` isn't the start
 * of a recognizable value at all (`end <= start`). This mirrors CDN's
 * value grammar shape closely enough to find an item's own extent without
 * knowing its specific semantic type — needed because app-sequence (and
 * array/map) items may be separated by a comma *or* by nothing but
 * whitespace (which leaves no token of its own), so finding the next
 * item's start means first walking to the end of the current one:
 * - `INTEGER [ENCODING_INDICATOR] LPAREN ... RPAREN` (a tag) — consumes
 *   the whole bracketed span.
 * - Any other bracket opener (`(`, `[`, `{`, `<<`, an app-sequence) —
 *   consumes its whole matching span, then one trailing
 *   `ENCODING_INDICATOR` if present (e.g. `[1, 2]_1`, `<<1, 2>>_1`).
 * - Anything else — a single atom token (`TSTR`, `BYTES_HEX`, `SIMPLE`,
 *   `FLOAT`, ...), then one trailing `ENCODING_INDICATOR` if present. If
 *   that atom is a `CHAIN_ATOM_TYPES` member (a string/byte-string literal,
 *   or an elision-chain `ELLIPSIS`) and is followed by `PLUS`, the whole
 *   `+`-concatenation chain (`"a" + "b" + h'63'`, `"a" + ...`, `... + "b"`,
 *   ...) is consumed as this one item — a chain never continues past any
 *   other atom. **Except**: when the chain's own first atom is `ELLIPSIS`,
 *   `src/cdn/parser.ts`'s grammar reads each `+`-joined continuation via
 *   its *general* value parser (`parseValue()`), not the restricted
 *   string/byte-literal-only rule that governs every other chain — so
 *   `... + (_ "a")`, `... + [1, 2]`, `... + 100(2)`, even `... + ...`, are
 *   all valid, and each continuation's extent is found by recursing into
 *   this same function instead of checking `CHAIN_ATOM_TYPES` membership.
 */
function consumeOneItem(
  tokens: Token[],
  start: number,
  end: number
): number | null {
  if (start >= end) return null;
  if (tokens[start].type === 'INTEGER') {
    let p = start + 1;
    if (p < end && tokens[p].type === 'ENCODING_INDICATOR') p++;
    if (p < end && tokens[p].type === 'LPAREN') {
      const close = findMatchingClose(tokens, p, end);
      return close !== null ? close + 1 : null;
    }
    return p;
  }
  if (BRACKET_OPENERS.has(tokens[start].type)) {
    const close = findMatchingClose(tokens, start, end);
    if (close === null) return null;
    let p = close + 1;
    if (p < end && tokens[p].type === 'ENCODING_INDICATOR') p++;
    return p;
  }
  let p = start + 1;
  if (p < end && tokens[p].type === 'ENCODING_INDICATOR') p++;

  if (tokens[start].type === 'ELLIPSIS') {
    // An elision-chain start: each continuation after a `+` may be *any*
    // value shape (a tag, container, indefinite-length string group,
    // app-sequence, a nested ellipsis chain, ...), not just a string/byte
    // literal — so find its extent generically by recursing, rather than
    // checking `CHAIN_ATOM_TYPES` membership the way every other chain
    // shape does below.
    while (p < end && tokens[p].type === 'PLUS') {
      const nextEnd = consumeOneItem(tokens, p + 1, end);
      if (nextEnd === null) return null;
      p = nextEnd;
    }
    return p;
  }

  const isChainable = CHAIN_ATOM_TYPES.has(tokens[start].type);
  while (isChainable && p < end && tokens[p].type === 'PLUS') {
    const nextStart = p + 1;
    if (nextStart >= end || !CHAIN_ATOM_TYPES.has(tokens[nextStart].type)) {
      return null; // trailing `+` with nothing after, or a malformed chain
    }
    p = nextStart + 1;
    if (p < end && tokens[p].type === 'ENCODING_INDICATOR') p++;
  }
  return p;
}

/**
 * Splits `tokens[start:end)` into top-level item ranges — items may be
 * separated by a comma, by whitespace alone (no token at all), or both
 * (a comma with incidental whitespace around it, which the tokenizer
 * already discards) — per CDN's own array/app-sequence grammar. Returns
 * `[]` if any item's own extent can't be determined (`consumeOneItem`
 * failed to find a bracket's matching close within range), rather than
 * guess at wrong boundaries.
 */
function splitTopLevelItems(
  tokens: Token[],
  start: number,
  end: number
): [number, number][] {
  const items: [number, number][] = [];
  let p = start;
  while (p < end) {
    const itemEnd = consumeOneItem(tokens, p, end);
    if (itemEnd === null) return [];
    items.push([p, itemEnd]);
    p = itemEnd;
    if (p < end && tokens[p].type === 'COMMA') p++;
  }
  return items;
}

function isMultiWordTokenRange(
  tokens: Token[],
  start: number,
  end: number,
  strict: boolean
): boolean {
  if (end <= start) return false;

  // Strip a trailing encoding indicator up front, before checking for any
  // wrapper shape below — it can trail a bare literal, a tag wrapper
  // (`100(2)_1`, hypothetically), or an app-sequence wrapper
  // (`same<<"two words">>_i` is valid CDN: `same` resolves to a plain
  // TSTR, so its own EI can trail the `>>`) — and never changes any of
  // their shape or word count either way.
  let contentEnd = end;
  if (tokens[contentEnd - 1].type === 'ENCODING_INDICATOR') contentEnd--;

  // Tag wrapper: INTEGER [ENCODING_INDICATOR] LPAREN ... RPAREN spanning
  // the whole range — peel it and recurse on what's inside.
  if (tokens[start].type === 'INTEGER') {
    let i = start + 1;
    if (i < contentEnd && tokens[i].type === 'ENCODING_INDICATOR') i++;
    if (i < contentEnd && tokens[i].type === 'LPAREN') {
      const close = findMatchingClose(tokens, i, contentEnd);
      if (close !== null && close + 1 === contentEnd) {
        return isMultiWordTokenRange(tokens, i + 1, close, strict);
      }
    }
  }

  // App-sequence wrapper: prefix<< item item ... >> spanning the whole
  // range. Its own <<...>> is never peeled away (see doc above), but each
  // top-level item inside — separated by a comma, whitespace, or both — is
  // checked under the loose rule, matching how `<<...>>` itself always
  // treats its entries.
  if (tokens[start].type === 'APP_SEQUENCE') {
    const close = findMatchingClose(tokens, start, contentEnd);
    if (close !== null && close + 1 === contentEnd) {
      for (const [itemStart, itemEnd] of splitTopLevelItems(
        tokens,
        start + 1,
        close
      )) {
        if (isMultiWordTokenRange(tokens, itemStart, itemEnd, false)) {
          return true;
        }
      }
      return false;
    }
  }

  // `+`-concatenation chain spanning the whole range (`"a" + "b"`,
  // `h'00' + "x"`, `... + "b"`, ...) — CDN concatenation preserves each
  // part's own spelling rather than merging into one literal, so it's
  // never caught by the single-literal check below; it has to be
  // recognized as its own shape. A chain's *element type* is fixed by its
  // first part (draft-25 §5.1): a text-leading chain (`TSTR`/`RAWSTRING`/bare
  // `SQSTR` first — the same three types the single-literal switch below
  // checks by decoded word count rather than always-strict) decodes and
  // merges every part — including any prefixed byte-string-shaped parts,
  // which get UTF-8-decoded in per the same rule that lets `"a" + h'62'`
  // denote text `"ab"` — into one string, then checks *that* for word
  // count, matching what a single merged text literal would report. An
  // elision chain (`ELLIPSIS` first — `... + "b"`, an unknown prefix
  // concatenated with a known suffix) is handled the *same* way: the
  // merge-and-decode attempt fails immediately (an `ELLIPSIS` part always
  // decodes to `null`), so the combined word count always comes back
  // "unknown" — correctly indeterminate regardless of what visible parts
  // follow it, matching how a *continuation* `ELLIPSIS` already makes the
  // whole chain indeterminate (round 8). A byte-leading chain (first part
  // a prefixed `h'...'`/`b64'...'`) denotes a byte string; concatenation
  // never re-spells it as one bare `sqstr`, so rather than guess at the
  // combined bytes' printability it's treated like any other prefixed byte
  // literal — disqualifying only under the strict rule, same as a lone
  // `h'...'`/`b64'...'`.
  if (contentEnd - start > 1 && isPlusChainRange(tokens, start, contentEnd)) {
    if (
      tokens[start].type === 'TSTR' ||
      tokens[start].type === 'RAWSTRING' ||
      tokens[start].type === 'SQSTR' ||
      tokens[start].type === 'ELLIPSIS'
    ) {
      const merged = decodePlusChainText(tokens, start, contentEnd);
      return merged !== null && isMultiWordText(merged);
    }
    return strict;
  }

  // A single literal token (the encoding indicator, if any, was already
  // stripped above).
  if (contentEnd - start !== 1) return false;
  const token = tokens[start];
  switch (token.type) {
    case 'TSTR':
    case 'RAWSTRING':
      return isMultiWordText(token.value);
    case 'SQSTR': {
      const bytes = (token as SqstrToken)._sqstrBytes;
      return bytes !== undefined
        ? isMultiWordText(textDecoderForRenderedLiteral.decode(bytes))
        : false;
    }
    case 'BYTES_HEX':
    case 'BYTES_HEX_ELIDED':
    case 'BYTES_B64':
    case 'APP_STRING':
      return strict;
    default:
      return false;
  }
}

/**
 * Whether `tokens[start:end)` is exactly one `+`-concatenation chain (or a
 * single stringish literal) with nothing left over — reuses
 * `consumeOneItem`'s own chain-walking so the shape recognized here can
 * never drift from the shape it actually consumes as one item elsewhere.
 */
function isPlusChainRange(
  tokens: Token[],
  start: number,
  end: number
): boolean {
  return (
    CHAIN_ATOM_TYPES.has(tokens[start].type) &&
    consumeOneItem(tokens, start, end) === end
  );
}

/**
 * Decodes and concatenates every part of a `+`-concatenation chain spanning
 * `tokens[start:end)` into the single string it denotes, or `null` if any
 * part can't be decoded — `ELLIPSIS` (an elision-chain link with no content
 * of its own) and `BYTES_HEX_ELIDED` (missing data by construction) always
 * make the combined result unknowable; a malformed hex/base64 part
 * shouldn't happen in this library's own output but isn't assumed either.
 */
function decodePlusChainText(
  tokens: Token[],
  start: number,
  end: number
): string | null {
  let result = '';
  let i = start;
  for (;;) {
    const part = decodeStringishTokenText(tokens[i]);
    if (part === null) return null;
    result += part;
    i++;
    if (i < end && tokens[i].type === 'ENCODING_INDICATOR') i++;
    if (i < end && tokens[i].type === 'PLUS') {
      i++;
      continue;
    }
    break;
  }
  return i === end ? result : null;
}

/** Decodes a single stringish token to the text it denotes, or `null`. */
function decodeStringishTokenText(token: Token): string | null {
  switch (token.type) {
    case 'TSTR':
    case 'RAWSTRING':
      return token.value;
    case 'SQSTR': {
      const bytes = (token as SqstrToken)._sqstrBytes;
      return bytes !== undefined
        ? textDecoderForRenderedLiteral.decode(bytes)
        : null;
    }
    case 'BYTES_HEX':
      try {
        return textDecoderForRenderedLiteral.decode(hexToBytes(token.value));
      } catch {
        return null;
      }
    case 'BYTES_B64':
      try {
        return textDecoderForRenderedLiteral.decode(base64ToBytes(token.value));
      } catch {
        return null;
      }
    case 'BYTES_HEX_ELIDED':
      // Ellipsis-elided hex is missing data by construction — the full
      // byte content (and thus decoded text) can't be recovered.
      return null;
    case 'ELLIPSIS':
      // An elision-chain link (`"a" + ...`) stands for a deliberately
      // omitted part — there's no content to decode at all, so the whole
      // chain's combined word count is unknowable, not just this part's.
      return null;
    default:
      return null;
  }
}

/**
 * Which comment syntax a byte-string literal's raw source recognizes —
 * `undefined` when it has none at all (its content is data, not a comment
 * host). Set once, at parse time, by whoever actually knows the literal's
 * real origin (the tokenizer for `h'...'`/`b64'...'`/bare sqstr, or the
 * parser comparing the resolved extension against the specific built-in
 * `b32`/`h32` objects by reference — never guessed later from the prefix
 * string, since a user extension can register under any prefix, including
 * one a built-in also uses; see `CborByteString.ednCommentSyntax`).
 *   - `'full'`: `#`, `//`, `/* *\/`, and `/ /` (§6.2.1/§6.3.3) — `h'...'`
 *     and its backtick form, and the built-in `b32'...'`/`h32'...'`
 *     extensions, which share hex's comment syntax (`utils/strip-comments.ts`).
 *   - `'hash-only'`: only `#` line comments — standard base64 (`b64'...'`),
 *     where `/` is valid data (e.g. `//8=` decodes to 0xFFFF), never a
 *     comment marker (see Tokenizer._readByteContent, §6.2.2).
 */
export type ByteCommentSyntax = 'full' | 'hash-only';

/**
 * Strip comments from inside a preserved byte-string literal's raw source,
 * keeping everything else — case, whitespace, `...` — untouched. Used when
 * `preserveByteString` is set but `preserveComments` is not: the preserved
 * spelling should still drop comments, the same as an unpreserved literal
 * re-derived from its decoded value would. `syntax` selects the comment
 * rules to apply (see `ByteCommentSyntax`); the caller is responsible for
 * knowing which one is correct — this function does not guess from `raw`.
 *
 * Only scans the quote-delimited content (not the prefix or a trailing
 * encoding-indicator suffix), and mirrors the tokenizer's own
 * comment-recognition closely enough for realistic input; a comment
 * containing a literal copy of the delimiter quote character is not
 * specially handled (the input is already known-valid, so at worst this
 * shifts where the content/comment boundary is drawn, never produces
 * unparseable output).
 */
export function stripByteLiteralComments(
  raw: string,
  syntax: ByteCommentSyntax
): string {
  let open = 0;
  while (open < raw.length && raw[open] !== "'" && raw[open] !== '`') open++;
  if (open >= raw.length) return raw;
  const quote = raw[open];
  const close = raw.lastIndexOf(quote);
  if (close <= open) return raw;
  const content = raw.slice(open + 1, close);
  const stripped =
    syntax === 'hash-only'
      ? _stripHashOnlyComments(content)
      : _stripFullByteCommentSyntax(content);
  return raw.slice(0, open + 1) + stripped + raw.slice(close);
}

/** `#` line comments only — used by standard base64 (`b64'...'`). */
function _stripHashOnlyComments(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (content[i] === '#') {
      while (i < content.length && content[i] !== '\n') {
        i += content[i] === '\\' && i + 1 < content.length ? 2 : 1;
      }
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

/**
 * `#`, `//`, `/* *\/`, and `/ /` comments — used by `h'...'`/backtick raw hex
 * and extension-defined byte literals sharing that syntax (b32, h32, ...).
 */
function _stripFullByteCommentSyntax(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '#' || (ch === '/' && next === '/')) {
      i += ch === '#' ? 1 : 2;
      while (i < content.length && content[i] !== '\n') {
        i += content[i] === '\\' && i + 1 < content.length ? 2 : 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < content.length && content[j] !== '/') {
        j += content[j] === '\\' && j + 1 < content.length ? 2 : 1;
      }
      i = j < content.length ? j + 1 : content.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const _utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** Decode bytes as UTF-8; returns null if the bytes are not valid UTF-8. */
function _tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return _utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

// ─── Text string escaping ─────────────────────────────────────────────────────

/**
 * Core EDN string escaper.
 *
 * Produces a quoted literal delimited by `quote` (`"` or `'`).
 * Iterates by Unicode code point so characters above U+FFFF are emitted as a
 * single character rather than two surrogate `\uXXXX` escapes.
 *
 * Always escapes:
 *   - the delimiter character itself
 *   - `\` (backslash)
 *   - `\n`, `\r`, `\t`
 *   - U+0000–U+001F (C0 controls), U+007F (DEL)
 *   - U+2028 / U+2029 (JS line terminators)
 *   - U+200B–U+200D (zero-width characters), U+FEFF (BOM)
 */
/**
 * Returns true if `s` contains any character that {@link _escapeQuoted}
 * would escape: the quote, backslash, C0 controls, DEL, U+2028/U+2029,
 * U+200B–U+200D, or U+FEFF.  charCodeAt is safe here — every escaped
 * character is a single UTF-16 unit, and surrogate halves never match.
 */
function _needsEscape(s: string, quoteCode: number): boolean {
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (cc === quoteCode || cc === 0x5c || cc < 0x20 || cc === 0x7f)
      return true;
    if (cc >= 0x2000) {
      if (
        cc === 0x2028 ||
        cc === 0x2029 ||
        (cc >= 0x200b && cc <= 0x200d) ||
        cc === 0xfeff
      )
        return true;
    }
  }
  return false;
}

function _escapeQuoted(s: string, quote: string): string {
  const quoteCP = quote.codePointAt(0)!;
  // Fast path: nothing to escape (the common case) — a single concatenation.
  if (!_needsEscape(s, quoteCP)) return quote + s + quote;
  let result = quote;
  for (const char of s) {
    const cp = char.codePointAt(0)!;
    switch (cp) {
      case quoteCP:
        result += `\\${quote}`;
        break;
      case 0x5c: // \
        result += '\\\\';
        break;
      case 0x0a: // \n
        result += '\\n';
        break;
      case 0x0d: // \r
        result += '\\r';
        break;
      case 0x09: // \t
        result += '\\t';
        break;
      default:
        if (
          cp < 0x20 ||
          cp === 0x7f ||
          cp === 0x2028 ||
          cp === 0x2029 ||
          cp === 0x200b ||
          cp === 0x200c ||
          cp === 0x200d ||
          cp === 0xfeff
        )
          result += `\\u${cp.toString(16).padStart(4, '0')}`;
        else result += char;
    }
  }
  return result + quote;
}

/** Produce a single-quoted EDN byte string literal `'...'` from a string value. */
function _escapeSingleQuoted(s: string): string {
  return _escapeQuoted(s, "'");
}

/**
 * Produce a single-quoted EDN app-string content `'...'` from a string value.
 * Exported for use by app-extension `_toCDN` implementations.
 */
export function escapeAppString(s: string): string {
  return _escapeQuoted(s, "'");
}

/**
 * Produce an EDN double-quoted string literal `"..."` from a string value.
 */
export function escapeString(s: string): string {
  return _escapeQuoted(s, '"');
}

// Locale pinned (rather than left to the host's default) so output is
// deterministic across environments regardless of system locale — the word
// dictionary for script-based languages (Japanese, Chinese, Thai, ...) is
// selected by the text's own script either way, not by this locale tag.
const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

/**
 * True when `value` contains two or more "words" per `Intl.Segmenter`'s
 * word-boundary rules (UAX #29): e.g. `"Hello, World!"` is two words (a
 * comma breaks them), `"3.14"` is one (a decimal point between digits
 * doesn't), and space-less scripts like Japanese/Chinese still split on
 * their own dictionary-based word boundaries. Used by `inlineLeafContainers`
 * to keep a multi-word string entry off the container's shared line even
 * when it would otherwise qualify as a leaf.
 */
export function isMultiWordText(value: string): boolean {
  let count = 0;
  for (const { isWordLike } of wordSegmenter.segment(value)) {
    if (!isWordLike) continue;
    count++;
    if (count >= 2) return true;
  }
  return false;
}

// ─── Float formatting ─────────────────────────────────────────────────────────

/** Produce the numeric string for a float value (with decimal point if needed). */
export function floatValueToString(value: number): string {
  if (isNaN(value)) return 'NaN';
  if (!isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  if (Object.is(value, -0)) return '-0.0';
  const s = value.toString();
  // Ensure a decimal point is present to distinguish from CBOR integer types
  return s.includes('.') || s.includes('e') ? s : s + '.0';
}

/**
 * EDN encoding-indicator suffix for a float precision.
 * Returns '' when the auto-selected precision matches (no suffix needed) in auto mode.
 */
export function floatSuffix(
  _value: number,
  precision: 'half' | 'single' | 'double' | undefined,
  autoSelected: 'half' | 'single' | 'double',
  mode?: 'always' | 'auto' | 'never'
): string {
  if (mode === 'never') return '';
  const actual = precision ?? autoSelected;
  if (mode === 'always')
    return actual === 'half' ? '_1' : actual === 'single' ? '_2' : '_3';
  // 'auto' (default)
  if (precision === undefined || precision === autoSelected) return '';
  return precision === 'half' ? '_1' : precision === 'single' ? '_2' : '_3';
}

/** Compute the canonical (minimum) CBOR encoding width for a non-negative integer argument. */
export function canonicalEncodingWidth(n: bigint): EncodingWidth {
  if (n <= 23n) return 'i';
  if (n <= 0xffn) return 0;
  if (n <= 0xffffn) return 1;
  if (n <= 0xffff_ffffn) return 2;
  return 3;
}

/**
 * Resolve the encoding-indicator suffix string (`''` or `'_N'`) based on
 * `options.encodingIndicators` and the item's recorded encoding width.
 *
 * @param options       - toCDN options (may be undefined)
 * @param encodingWidth - width stored on the item (undefined = canonical)
 * @param getCanonical  - lazily compute the canonical width (only called in 'always' mode)
 */
export function resolveEiSuffix(
  options: ToCDNOptions | undefined,
  encodingWidth: EncodingWidth | undefined,
  getCanonical: () => EncodingWidth
): string {
  const mode = options?.encodingIndicators ?? 'auto';
  if (mode === 'never') return '';
  if (mode === 'always') return `_${encodingWidth ?? getCanonical()}`;
  return encodingWidth !== undefined ? `_${encodingWidth}` : '';
}

/** How a node should render under `preserveAppSequence`. */
export type AppSeqRenderDecision =
  'verbatim' | 'adjusted' | 'source' | 'structural' | 'normal';

/**
 * Decide how an extension result node — from a `prefix'...'` /
 * `` prefix`...` `` / `prefix<<...>>` source, or (for a tag-wrapper node
 * that also has a generic `CborTag` fallback to delegate to) a raw tag
 * literal `N(...)` — should render under `ToCDNOptions.preserveAppSequence`.
 *
 * A raw-tag source is recognised by `ednSource !== undefined`: the parser
 * only ever sets a tag-wrapper's `ednSource` (the tag *number's* digit
 * spelling) when it was reached via `N(...)`, never via one of the
 * app-string/-sequence forms. Leaf (non-tag-wrapper) nodes have no raw-tag
 * form at all — always pass `undefined` for `ednSource` there.
 *
 * Returns:
 * - `'verbatim'`: re-emit `appSeqSource` as-is. Only reachable for a
 *   raw-tag source: its encoding-indicator suffixes are nested at two
 *   independent positions (tag number and inner content), so this is only
 *   safe in `'auto'` mode with no relevant sibling option overridden.
 * - `'source'`: keep a raw-tag source structurally verbatim, applying
 *   comment and encoding-indicator changes by their captured source spans.
 *   This avoids changing unrelated literal spelling or layout.
 * - `'adjusted'`: for an app-string/-sequence source, strip whatever
 *   *outer* indicator suffix is already at the end of `appSeqSource` (or,
 *   under `'never'`, also an *inner* one immediately before `<<...>>`'s
 *   closing `>>` — the app-sequence's sole item's own indicator) and let
 *   the caller append one recomputed via `resolveEiSuffix`/`floatSuffix`
 *   for the current mode via `adjustAppSeqIndicator` — correct in every
 *   mode, without losing the source's notation family. (An inner indicator
 *   can only be *stripped*, not *recomputed*: the item's own encoding
 *   width isn't tracked once resolved to a plain date/address string, so
 *   `'always'` cannot add a missing one — it is left absent.)
 * - `'structural'`: keep the raw-tag notation *family* (as opposed to
 *   upgrading to `prefix'...'`) but re-derive it structurally — via the
 *   node's own `CborTag` rendering — instead of using `appSeqSource`
 *   verbatim. Needed whenever verbatim text would ignore a sibling option
 *   that must apply per nested node: an explicit `preserveNumberFormat` /
 *   `preserveByteString` / `preserveTextString` / `preserveRawString` /
 *   `preserveConcatenation` override.
 *   Verbatim raw-tag text inherently contains the nested literal spelling.
 * - `'normal'`: fall through to the class's own notation regeneration
 *   (`prefix'...'`), unaffected by `preserveAppSequence`. For `<<...>>`,
 *   this is also used when replaying its sole inner item would defeat an
 *   explicitly disabled, relevant literal-preservation option.
 *
 * `editsComplete` (from `CborItem.appSeqEncodingEditsComplete`, raw-tag
 * sources only) is `false` when the tag's content contains a node type
 * `collectContentEncodingEdits` doesn't cover (e.g. a `CborMap` nested in an
 * `ip` array's raw-tag content). `'source'` relies on those edits to apply
 * `encodingIndicators: 'always'`/`'never'`, so incomplete coverage would
 * silently leave the uncovered node's own indicator unchanged; `'structural'`
 * is used instead, since it re-derives every nested indicator recursively.
 */
export function decideTaggedAppSeqRendering(
  options: ToCDNOptions | undefined,
  appSeqSource: string | undefined,
  ednSource: string | undefined,
  sourceFeatures?: AppSeqSourceFeatures,
  editsComplete?: boolean
): AppSeqRenderDecision {
  if (!options?.preserveAppSequence || appSeqSource === undefined)
    return 'normal';
  if (resolveIndent(options) === null && /[\r\n]/.test(appSeqSource))
    return 'normal';
  const isRawTagSource = ednSource !== undefined;
  // App-string/-sequence sources carry relative comment spans, so their
  // spelling can stay intact while adjustAppSeqIndicator converts or removes
  // comments. Raw tags instead have a structural CborTag fallback that
  // applies comment formatting together with all other nested-node options.
  if (!isRawTagSource) {
    const innerSourceOverridden =
      (sourceFeatures?.byteString && options?.preserveByteString === false) ||
      (sourceFeatures?.textString && options?.preserveTextString === false) ||
      (sourceFeatures?.rawString && options?.preserveRawString === false) ||
      (sourceFeatures?.concatenation &&
        options?.preserveConcatenation === false);
    return innerSourceOverridden ? 'normal' : 'adjusted';
  }
  const commentsNeedEditing =
    options?.preserveComments === false ||
    typeof options?.preserveComments === 'string' ||
    (options?.preserveComments === true && resolveIndent(options) === null);
  const mode = options?.encodingIndicators ?? 'auto';
  const siblingOverridden =
    options?.preserveNumberFormat === false ||
    (sourceFeatures?.byteString && options?.preserveByteString === false) ||
    (sourceFeatures?.textString && options?.preserveTextString === false) ||
    (sourceFeatures?.rawString && options?.preserveRawString === false) ||
    (sourceFeatures?.concatenation && options?.preserveConcatenation === false);
  if (siblingOverridden) return 'structural';
  if (mode !== 'auto' && editsComplete === false) return 'structural';
  return mode !== 'auto' || commentsNeedEditing ? 'source' : 'verbatim';
}

/**
 * Replacement text for a comment being stripped entirely (not converted):
 * empty, unless removing it would fuse two otherwise-separate tokens
 * together — e.g. "24/x/h'...'" would become "24h'...'", which the parser
 * rejects as two array items with no separator between them. A single
 * space keeps the tokens apart in that case, the same concern
 * `sourceSuffixEdit`'s own separator handles for an inserted indicator.
 *
 * The two neighbouring characters are checked generically (any non-space,
 * non-comma character needs a separator), not just "word" characters —
 * `24/x/'abc'` needs the same space as `24/x/h'...'` even though `'` isn't
 * itself part of a token that could lexically fuse with `24`: the parser's
 * "array items must be separated" check is purely positional (are the two
 * tokens flush against each other), not about what those tokens are. A
 * comma on either side never needs a separator of its own, since it's
 * already a valid separator by itself.
 *
 * `text`/`start`/`end` share one coordinate space (the source being edited
 * and the comment's offsets within it).
 */
function stripCommentReplacement(
  text: string,
  start: number,
  end: number
): string {
  const before = start > 0 ? text[start - 1]! : '';
  const after = end < text.length ? text[end]! : '';
  const needsSeparator = (ch: string) => ch !== '' && !/[\s,]/.test(ch);
  return needsSeparator(before) && needsSeparator(after) ? ' ' : '';
}

function rewriteAppSeqComments(
  appSeqSource: string,
  options: ToCDNOptions | undefined,
  comments: readonly CborComment[] | undefined,
  removedAt?: number
): string {
  const preserveComments = options?.preserveComments;
  if (preserveComments === undefined || !comments?.length) return appSeqSource;
  const stripComments =
    preserveComments === false || resolveIndent(options) === null;
  const style =
    typeof preserveComments === 'string' ? preserveComments : undefined;
  let text = appSeqSource;
  // Apply replacements from right to left so an earlier comment's offsets
  // are unaffected by a later replacement. Account for characters already
  // removed before a following comment.
  const ordered = [...comments].sort((a, b) => b.start - a.start);
  for (const comment of ordered) {
    const shift =
      removedAt !== undefined && comment.start >= removedAt ? -2 : 0;
    const start = comment.start + shift;
    const end = comment.end + shift;
    const replacement = stripComments
      ? stripCommentReplacement(text, start, end)
      : convertCommentText(comment, style);
    text = text.slice(0, start) + replacement + text.slice(end);
  }
  return text;
}

/** Apply comment/EI options directly to a preserved raw-tag source. */
export function adjustRawAppSeqSource(
  appSeqSource: string,
  options: ToCDNOptions | undefined,
  comments: readonly CborComment[] | undefined,
  encodingEdits: readonly AppSeqEncodingEdit[] | undefined
): string {
  const replacements: {
    start: number;
    end: number;
    replacement: string;
  }[] = [];
  const preserveComments = options?.preserveComments;
  if (preserveComments !== undefined && comments?.length) {
    const stripComments =
      preserveComments === false || resolveIndent(options) === null;
    const style =
      typeof preserveComments === 'string' ? preserveComments : undefined;
    for (const comment of comments)
      replacements.push({
        start: comment.start,
        end: comment.end,
        replacement: stripComments
          ? stripCommentReplacement(appSeqSource, comment.start, comment.end)
          : convertCommentText(comment, style),
      });
  }
  const mode = options?.encodingIndicators ?? 'auto';
  if (mode !== 'auto' && encodingEdits)
    for (const edit of encodingEdits)
      replacements.push({
        start: edit.start,
        end: edit.end,
        replacement: mode === 'always' ? edit.always : edit.never,
      });

  // Right-to-left edits keep every stored source offset valid. At the same
  // offset, replace a non-empty span before performing a zero-width insert.
  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let text = appSeqSource;
  for (const edit of replacements)
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  return text;
}

/**
 * Adjust an `'adjusted'` app-string/-sequence source: apply requested comment
 * conversion/removal by captured source span, strip the existing
 * encoding-indicator suffix(es), then append `newSuffix` (the outer/wrapper
 * indicator recomputed for the current mode) — see
 * `decideTaggedAppSeqRendering`.
 *
 * Under `encodingIndicators: 'never'`, an inner (item-level) indicator is
 * also stripped, using
 * `innerItemEnd` (see `CborItem.appSeqInnerEnd`) to find it by its actual
 * parsed position rather than by pattern-matching text near the closing
 * `>>` — whitespace, a trailing comma, and/or a comment can all separate
 * the two, in any combination, so a position-based cut is the only fully
 * reliable way to locate it.
 */
export function adjustAppSeqIndicator(
  appSeqSource: string,
  newSuffix: string,
  options: ToCDNOptions | undefined,
  innerItemEnd: number | undefined,
  comments: readonly CborComment[] | undefined
): string {
  let text = appSeqSource;
  let removedInnerAt: number | undefined;
  if (
    (options?.encodingIndicators ?? 'auto') === 'never' &&
    innerItemEnd !== undefined
  ) {
    const beforeInner = text.slice(0, innerItemEnd);
    if (/_[0-3i]$/.test(beforeInner)) {
      removedInnerAt = innerItemEnd - 2;
      text = beforeInner.slice(0, -2) + text.slice(innerItemEnd);
    }
  }

  text = rewriteAppSeqComments(text, options, comments, removedInnerAt);
  return text.replace(/_[0-3i]$/, '') + newSuffix;
}
