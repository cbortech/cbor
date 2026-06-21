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
  return typeof indent === 'number' ? ' '.repeat(indent) : indent;
}

/** Build the indent prefix for a given depth. */
export function indentOf(indentStr: string, depth: number): string {
  return indentStr.repeat(depth);
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
  return Boolean(
    item.comments?.trailing?.length || item.comments?.dangling?.length
  );
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
