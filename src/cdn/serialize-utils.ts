/**
 * Pure utility functions for EDN serialization.
 * No AST imports — safe to import from any AST class.
 */

import type { CborComment, CborComments, ToCDNOptions } from '../types';
import type { EncodingWidth } from '../cbor/encode';
import { bytesToHex as toHex } from '../utils/hex';

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
 */
export function joinConcatParts(
  literals: readonly string[],
  indentStr: string | null,
  depth: number
): string {
  if (indentStr === null) return literals.join(' + ');
  return literals.join(` +\n${indentOf(indentStr, depth + 1)}`);
}

// ─── Comment helpers ─────────────────────────────────────────────────────────

export interface Commented {
  comments?: CborComments;
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

export function formatLeadingComments(
  item: Commented,
  indent: string,
  style?: 'c-style' | 'cdn-style' | undefined
): string[] {
  return (item.comments?.leading ?? []).map(
    (comment) => indent + convertCommentText(comment, style)
  );
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
 * objects) so the common no-comments path allocates nothing per entry.
 * `hasEntryComments`, `entryLeadingNode`, and `entryTrailing` are consulted
 * only when `preserveComments` is set.  `renderEntry` receives the resolved
 * `colSep` (': ' or ':' depending on compact mode) for rendering map pairs.
 */
export function serializeContainer(p: {
  node: Commented;
  options: ToCDNOptions | undefined;
  depth: number;
  openChar: '[' | '{' | '(';
  closeChar: ']' | '}' | ')';
  count: number;
  indefiniteLength: boolean;
  encodingWidth: EncodingWidth | undefined;
  hasEntryComments: () => boolean;
  /** Render entry `i` at child depth (`item` or `key: value`). */
  renderEntry: (i: number, colSep: string) => string;
  /**
   * Whether entry `i` contains no nested array/map, so it may stay on the
   * container's line under `inlineLeafContainers`. Omitted = always a leaf.
   */
  entryIsLeaf?: (i: number) => boolean;
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
  const { inlineSep, multilineSep, trailSep, colSep } = resolveSeparators(
    options,
    indentStr === null
  );
  const eiRaw = p.indefiniteLength
    ? ''
    : resolveEiSuffix(options, p.encodingWidth, () =>
        canonicalEncodingWidth(BigInt(count))
      );
  const eiSuffix = eiRaw ? eiRaw + ' ' : '';
  const showIndef =
    p.indefiniteLength && (options?.encodingIndicators ?? 'auto') !== 'never';

  const singleLine = (inner: string): string => {
    if (p.indefiniteLength) {
      return showIndef
        ? count === 0
          ? `${openChar}_ ${closeChar}`
          : `${openChar}_ ${inner}${closeChar}`
        : `${openChar}${inner}${closeChar}`;
    }
    return `${openChar}${eiSuffix}${inner}${closeChar}`;
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
  // a nested array/map and every entry renders without a line break.
  // Entries rendered while probing are reused below if the probe fails, so a
  // node is never serialized more than once per parent render.
  let probed: string[] | null = null;
  if (options?.inlineLeafContainers && count > 0 && !hasComments) {
    const rendered: string[] = [];
    let flat = true;
    for (let i = 0; i < count; i++) {
      if (p.entryIsLeaf && !p.entryIsLeaf(i)) {
        flat = false;
        break;
      }
      const s = p.renderEntry(i, colSep);
      rendered.push(s);
      if (s.includes('\n')) {
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
    if (preserveComments) {
      lines.push(
        ...formatLeadingComments(
          p.entryLeadingNode(i),
          childIndent,
          commentStyle
        )
      );
    }
    const sep = i < count - 1 ? multilineSep : trailSep;
    const entry = probed?.[i] ?? p.renderEntry(i, colSep);
    lines.push(
      `${childIndent}${entry}${sep}${preserveComments ? p.entryTrailing(i, commentStyle) : ''}`
    );
  }
  if (preserveComments)
    lines.push(...formatDanglingComments(p.node, childIndent, commentStyle));
  const body = lines.join('\n');
  return `${open}\n${body}\n${closeIndent}${closeChar}`;
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
  const lines = [
    ...formatLeadingComments(child, childIndent, commentStyle),
    `${childIndent}${renderChild(depth + 1)}${formatTrailingComments(child, commentStyle)}`,
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

export function serializeBytes(
  bytes: Uint8Array,
  encoding?: 'hex' | 'base64' | 'base64url' | 'base32' | 'base32hex',
  sqstr?: 'printable-string' | 'string' | 'none'
): string {
  if (sqstr === 'string') {
    const s = _tryDecodeUtf8(bytes);
    if (s != null) return _escapeSingleQuoted(s);
  }
  if (sqstr === 'printable-string' || sqstr === undefined) {
    const s = _tryDecodeUtf8(bytes);
    if (s != null && !_hasNonPrintable(s)) return _escapeSingleQuoted(s);
  }
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

interface AppSeqSourceFeatures {
  byteString?: boolean;
  textString?: boolean;
  rawString?: boolean;
  concatenation?: boolean;
}

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
  encodingEdits:
    | readonly {
        start: number;
        end: number;
        always: string;
        never: string;
      }[]
    | undefined
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
