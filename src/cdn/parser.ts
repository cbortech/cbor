import {
  Tokenizer,
  type EdnComment,
  type SqstrToken,
  type Token,
  type TokenType,
} from './tokenizer';
import { CdnSyntaxError } from './errors';
import type { CborItem } from '../ast/CborItem';
import type {
  CborComment,
  FromCDNOptions,
  CborExtension,
  ParseWarning,
} from '../types';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborByteString } from '../ast/CborByteString';
import { CborIndefiniteByteString } from '../ast/CborIndefiniteByteString';
import { CborTextString } from '../ast/CborTextString';
import { CborIndefiniteTextString } from '../ast/CborIndefiniteTextString';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborTag } from '../ast/CborTag';
import { CborFloat, type FloatPrecision } from '../ast/CborFloat';
import { CborSimple } from '../ast/CborSimple';
import { CborEmbeddedCBOR } from '../ast/CborEmbeddedCBOR';
import { maxForEncodingWidth, type EncodingWidth } from '../cbor/encode';
import { parseHexFloat } from '../utils/hexfloat';
import { hexToBytes } from '../utils/hex';
import { float64ToFloat16Bits, float16BitsToFloat64 } from '../utils/float16';
import { resolveBuiltinExtensions } from '../extensions/builtins';
import { CborUnresolvedAppExt } from '../ast/CborUnresolvedAppExt';
import { CborAppSeqResult } from '../ast/CborAppSeqResult';
import { CborEllipsis } from '../ast/CborEllipsis';
import { CborBigUint, CborBigNint } from '../ast/CborBignum';

// Shared codec instances — constructing TextEncoder/TextDecoder per call is
// measurably expensive in hot parsing paths.
const textEncoder = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Lenient = new TextDecoder('utf-8', { fatal: false });

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Parse a CDN text string into a CborItem AST node.
 * Throws SyntaxError on invalid input.
 */
export function parseCDN(text: string, options?: FromCDNOptions): CborItem {
  const tokenizer = new Tokenizer(text, {
    offset: options?.offset,
    skipRS: (options as (FromCDNOptions & { _skipRS?: boolean }) | undefined)
      ?._skipRS,
  });
  const parser = new CDNParser(tokenizer, options ?? {});
  const node = parser.parse();
  if (options?.preserveComments) attachComments(node, tokenizer.comments, text);
  return node;
}

// ─── Value helpers ────────────────────────────────────────────────────────────

/** Strip an optional _0/_1/_2/_3/_i encoding-indicator suffix from a raw
 *  integer token value and return both the numeric string and the width. */
function parseIntegerRaw(raw: string): {
  numStr: string;
  rawSuffix: string | undefined;
} {
  let numStr = raw;
  let rawSuffix: string | undefined;
  if (/[_][0-7i]$/.test(raw)) {
    rawSuffix = raw[raw.length - 1]!;
    numStr = raw.slice(0, -2);
  }
  return { numStr, rawSuffix };
}

function parseBigInt(raw: string): bigint {
  if (raw.startsWith('-')) return -BigInt(raw.slice(1));
  return BigInt(raw);
}

function parseFloatToken(
  raw: string,
  onRecoverableError?: (msg: string) => void
): {
  value: number;
  precision: FloatPrecision | undefined;
} {
  // Strip any invalid encoding indicator first, before NaN/Infinity checks,
  // so that e.g. "NaN_7" still resolves to NaN after the suffix is removed.
  if (raw.endsWith('_i') || raw.endsWith('_0')) {
    const msg =
      '_0 and _i encoding indicators are not valid for floating-point values';
    if (onRecoverableError) {
      onRecoverableError(msg);
      raw = raw.slice(0, -2);
    } else {
      throw new SyntaxError(`EDN parse error: ${msg}`);
    }
  } else if (/[_][4567]$/.test(raw)) {
    const suffix = raw[raw.length - 1]!;
    const msg =
      suffix === '7'
        ? 'indefinite-length encoding (_7) is not valid for floating-point values'
        : `encoding indicator _${suffix} (AI ${Number(suffix) + 24}) is reserved and not valid`;
    if (onRecoverableError) {
      onRecoverableError(msg);
      raw = raw.slice(0, -2);
    } else {
      throw new SyntaxError(`EDN parse error: ${msg}`);
    }
  }

  if (raw === 'NaN') return { value: NaN, precision: undefined };
  if (raw === 'Infinity') return { value: Infinity, precision: undefined };
  if (raw === '-Infinity') return { value: -Infinity, precision: undefined };

  let numStr = raw;
  let precision: FloatPrecision | undefined;
  if (raw.endsWith('_1')) {
    precision = 'half';
    numStr = raw.slice(0, -2);
  } else if (raw.endsWith('_2')) {
    precision = 'single';
    numStr = raw.slice(0, -2);
  } else if (raw.endsWith('_3')) {
    precision = 'double';
    numStr = raw.slice(0, -2);
  }

  // Hex float literal: 0x[hex]p[exp] or -0x[hex]p[exp]
  if (/^-?0[xX]/.test(numStr))
    return { value: parseHexFloat(numStr), precision };

  return { value: parseFloat(numStr), precision };
}

function base64ToBytes(
  b64: string,
  onRecoverableError?: (msg: string) => void
): Uint8Array {
  // Separate data characters from trailing '=' padding.
  const eqIdx = b64.indexOf('=');
  const data = eqIdx >= 0 ? b64.slice(0, eqIdx) : b64;
  const pad = eqIdx >= 0 ? b64.slice(eqIdx) : '';

  // draft-25 b64dig = ALPHA / DIGIT / "-" / "_" / "+" / "/"
  // Classic (+/) and URL-safe (-_) position-62/63 chars are both valid in the
  // same literal. Reject anything outside this set as a hard error.
  if (/[^A-Za-z0-9+/\-_]/.test(data)) {
    const bad = [...data].find((c) => !/[A-Za-z0-9+/\-_]/.test(c)) ?? '';
    throw new SyntaxError(
      `invalid character ${JSON.stringify(bad)} in base64 data`
    );
  }
  if (pad && !/^=+$/.test(pad))
    throw new SyntaxError(`invalid character after base64 '=' padding`);

  const rem = data.length % 4;

  // rem === 1 cannot arise from any valid byte sequence (always invalid).
  if (rem === 1)
    throw new SyntaxError(
      `invalid base64 length: ${data.length} data characters (length mod 4 = 1 is never valid)`
    );

  // Expected number of '=' characters for this data length.
  const expectedPad = rem === 0 ? 0 : 4 - rem;

  if (pad.length > expectedPad) {
    const msg = `base64 has ${pad.length} '=' character${pad.length > 1 ? 's' : ''} but the data length (${data.length}) requires at most ${expectedPad}`;
    if (onRecoverableError) onRecoverableError(msg);
    else throw new SyntaxError(msg);
  }

  // Partial padding: some '=' present but fewer than the full required amount.
  // draft-25 accommodates NO padding; any '=' present must be the full set.
  if (pad.length > 0 && pad.length < expectedPad) {
    const msg = `base64 has ${pad.length} '=' character${pad.length > 1 ? 's' : ''} but needs exactly ${expectedPad} — use full padding or no padding at all`;
    if (onRecoverableError) onRecoverableError(msg);
    else throw new SyntaxError(msg);
  }
  // Zero '=': draft-25 allows omitting padding entirely — always accepted.

  // Non-zero trailing bits in the last data character (RFC 4648 §3.5).
  // Normalize URL-safe chars first so the lookup is against the classic table.
  // rem=2 (1-byte quantum): bottom 4 bits of the final char must be zero.
  // rem=3 (2-byte quantum): bottom 2 bits of the final char must be zero.
  if (rem !== 0 && data.length > 0) {
    const ALPHA =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lastChar = data[data.length - 1]!.replace('-', '+').replace('_', '/');
    const lastVal = ALPHA.indexOf(lastChar);
    if (lastVal >= 0) {
      const mask = rem === 2 ? 0x0f : 0x03;
      if ((lastVal & mask) !== 0) {
        const msg = `base64 has non-zero trailing bits in the final quantum (RFC 4648 §3.5)`;
        if (onRecoverableError) onRecoverableError(msg);
        else throw new SyntaxError(msg);
      }
    }
  }

  // Normalize URL-safe chars to classic and add any missing padding so the
  // underlying decoder accepts the input regardless of what was originally used.
  const normalized =
    data.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(expectedPad);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (Uint8Array as any).fromBase64 === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Uint8Array as any).fromBase64(normalized, {
      alphabet: 'base64',
      lastChunkHandling: 'loose',
    });
  }
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── Comment attachment ──────────────────────────────────────────────────────

interface NodeInfo {
  node: CborItem;
  start: number;
  end: number;
}

function attachComments(
  root: CborItem,
  comments: EdnComment[],
  source: string
): void {
  if (comments.length === 0) return;
  const nodes = collectNodes(root);
  const lineAt = buildLineAt(source);

  // Two sorted views over the pre-order node list, so each comment resolves
  // its neighbours in O(log N) instead of re-filtering and re-sorting the
  // whole list per comment.  Both sorts are stable, so nodes with equal keys
  // keep their pre-order (parent before child) relative order.
  const byStart = [...nodes].sort((a, b) => a.start - b.start || b.end - a.end);
  const byEnd = [...nodes].sort((a, b) => a.end - b.end || a.start - b.start);

  // The tokenizer appends comments in source order; sort defensively so the
  // container sweep below stays correct for out-of-order callers.
  const ordered = [...comments].sort((a, b) => a.start - b.start);

  // Container-sweep state shared across comments (comments are processed in
  // ascending start order, so pushes and pops are monotone).
  const enclosing: NodeInfo[] = [];
  let nextToPush = 0;

  for (const raw of ordered) {
    const comment: CborComment = { ...raw };

    // prev: node with the largest end <= comment start (ties: largest start).
    // byEnd is (end asc, start asc), so this is the last index with
    // end <= raw.start, found by upper-bound binary search.
    let lo = 0;
    let hi = byEnd.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byEnd[mid].end <= raw.start) lo = mid + 1;
      else hi = mid;
    }
    const prev = lo > 0 ? byEnd[lo - 1] : undefined;

    const separatorBeforeComment = prev
      ? source.slice(prev.end, raw.start)
      : '';
    if (
      prev &&
      lineAt(prev.end) === raw.line &&
      !separatorBeforeComment.includes(':')
    ) {
      addComment(prev.node, 'trailing', comment);
      continue;
    }

    // container: innermost node with start < comment start and comment end
    // < node end.  Node spans nest properly and a comment never straddles a
    // node boundary (it is whitespace between tokens), so an interval-stack
    // sweep over byStart works: push nodes starting before the comment,
    // pop nodes that ended before it — the stack top is the container.
    while (
      nextToPush < byStart.length &&
      byStart[nextToPush].start < raw.start
    ) {
      const n = byStart[nextToPush++];
      while (
        enclosing.length > 0 &&
        enclosing[enclosing.length - 1].end <= n.start
      )
        enclosing.pop();
      enclosing.push(n);
    }
    while (
      enclosing.length > 0 &&
      enclosing[enclosing.length - 1].end <= raw.start
    )
      enclosing.pop();
    const container =
      enclosing.length > 0 ? enclosing[enclosing.length - 1] : undefined;

    // next: node with the smallest start >= comment end (ties: largest end).
    // byStart is (start asc, end desc), so this is the first index with
    // start >= raw.end, found by lower-bound binary search.
    lo = 0;
    hi = byStart.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byStart[mid].start < raw.end) lo = mid + 1;
      else hi = mid;
    }
    const next = lo < byStart.length ? byStart[lo] : undefined;

    if (!container || (next && next.end <= container.end)) {
      if (next) {
        addComment(next.node, 'leading', comment);
        continue;
      }
    }

    addComment(container?.node ?? root, 'dangling', comment);
  }
}

function collectNodes(root: CborItem): NodeInfo[] {
  const out: NodeInfo[] = [];
  const visit = (node: CborItem) => {
    if (node.start !== undefined && node.end !== undefined)
      out.push({ node, start: node.start, end: node.end });
    if (node instanceof CborArray || node instanceof CborEmbeddedCBOR) {
      for (const item of node.items) visit(item);
      return;
    }
    if (node instanceof CborMap) {
      for (const [key, value] of node.entries) {
        visit(key);
        visit(value);
      }
      return;
    }
    if (
      node instanceof CborIndefiniteByteString ||
      node instanceof CborIndefiniteTextString
    ) {
      for (const chunk of node.chunks) visit(chunk);
      return;
    }
    if (node instanceof CborTag) visit(node.content);
  };
  visit(root);
  return out;
}

function addComment(
  node: CborItem,
  placement: 'leading' | 'trailing' | 'dangling',
  comment: CborComment
): void {
  node.comments ??= {};
  node.comments[placement] ??= [];
  node.comments[placement].push(comment);
}

function buildLineAt(source: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return (offset: number): number => {
    let target = Math.max(0, Math.min(source.length, offset));
    if (target > 0 && target === source.length) target--;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= target) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi + 1;
  };
}

// ─── Missing-extension hints ──────────────────────────────────────────────────

const bundledExtensionHint = (name: string): string =>
  `import { ${name} } from '@cbortech/cbor' and pass it via the 'extensions' option (extensions: [${name}])`;
const externalExtensionHint = (name: string, pkg: string): string =>
  `install ${pkg}, import { ${name} } from '${pkg}', and pass it via the 'extensions' option (extensions: [${name}])`;
const builtinDisabledHint = (name: string): string =>
  `'${name}' is a default built-in extension that was excluded via the 'builtinExtensions' option; add it back to that array (or omit 'builtinExtensions' to use the default set)`;

/**
 * App-string prefixes handled by known opt-in extensions or by default
 * built-ins that can be excluded via `builtinExtensions`, mapped to guidance
 * on how to (re-)enable them. Used to emit a non-fatal hint when such a
 * prefix is encountered without the corresponding extension registered.
 */
const MISSING_EXTENSION_HINTS: ReadonlyMap<string, string> = new Map([
  ['b32', bundledExtensionHint('b32')],
  ['h32', bundledExtensionHint('h32')],
  ['same', bundledExtensionHint('same')],
  ['hash', externalExtensionHint('hash', '@cbortech/hash-extension')],
  ['uuid', externalExtensionHint('uuid', '@cbortech/uuid-extension')],
  ['UUID', externalExtensionHint('uuid', '@cbortech/uuid-extension')],
  // Only reachable via a non-default `builtinExtensions` override — these
  // are otherwise always present in the default bundled set.
  ['dt', builtinDisabledHint('dt')],
  ['DT', builtinDisabledHint('dt')],
  ['ip', builtinDisabledHint('ip')],
  ['IP', builtinDisabledHint('ip')],
  ['cri', builtinDisabledHint('cri')],
  ['CRI', builtinDisabledHint('cri')],
  ['t1', builtinDisabledHint('t1')],
  ['b1', builtinDisabledHint('b1')],
  ['ilbs', builtinDisabledHint('ilbs')],
  ['ilts', builtinDisabledHint('ilts')],
  ['float', builtinDisabledHint('float')],
]);

// ─── Parser ───────────────────────────────────────────────────────────────────

class CDNParser {
  /** Lookup from app-prefix → extension (user extensions override built-ins). */
  private readonly extByPrefix: Map<string, CborExtension>;
  /** Lookup from tag number → extension. */
  private readonly extByTag: Map<bigint, CborExtension>;

  private readonly unresolvedExtension: 'cpa999' | 'error';

  /** Warnings accumulated during the current parseValue() call. */
  private _pendingWarnings: ParseWarning[] = [];

  /** Prefixes for which a missing-extension hint has already been emitted. */
  private readonly _hintedPrefixes = new Set<string>();

  constructor(
    private readonly t: Tokenizer,
    private readonly _options: FromCDNOptions
  ) {
    this.extByPrefix = new Map();
    this.extByTag = new Map();
    this.unresolvedExtension = _options.unresolvedExtension ?? 'cpa999';
    const builtins = resolveBuiltinExtensions(_options.builtinExtensions);
    for (const ext of [...builtins, ...(_options.extensions ?? [])]) {
      for (const prefix of ext.appStringPrefixes ?? [])
        this.extByPrefix.set(prefix, ext);
      for (const tag of ext.tagNumbers ?? []) this.extByTag.set(tag, ext);
    }
    this.t.onEscapeWarning = (msg, offset, line, col, endOffset) => {
      const w: ParseWarning = {
        message: msg,
        offset,
        line,
        column: col,
        endOffset,
      };
      this._pendingWarnings.push(w);
      if (this._options.onWarning) this._options.onWarning(w);
      else if (!this._options.silent)
        console.warn(
          `CDN strict violation at line ${line}, column ${col}: ${msg}`
        );
      if (this._options.strict !== false)
        throw new CdnSyntaxError(msg, { offset, line, column: col, endOffset });
    };
  }

  parse(): CborItem {
    const value = this.parseValue();
    if (this._options.allowTrailing) return value;
    const next = this.t.peek();
    if (next.type !== 'EOF') {
      this._warnOrFail(
        `unexpected token after value: ${JSON.stringify(next.value)}`,
        next
      );
      // Reached only in non-strict mode (_warnOrFail throws in strict mode).
      // Drain the pending warning into the returned value's AST node so it
      // is visible to callers that inspect node.warnings directly.
      if (this._pendingWarnings.length > 0) {
        value.warnings ??= [];
        value.warnings.push(...this._pendingWarnings);
        this._pendingWarnings = [];
      }
      // Scan the rest of the input so that hard lexer errors in the trailing
      // content (e.g. unterminated strings) still throw regardless of the
      // strict setting.
      while (this.t.peek().type !== 'EOF') this.t.consume();
    }
    return value;
  }

  parseValue(): CborItem {
    const start = this.t.peek().offset;
    const node = this._parseValueNode();
    if (this.t.peek().type === 'UNDERSCORE') {
      const tok = this.t.consume();
      this._warnOrFail(
        'bare _ is not a valid encoding indicator; use _0, _1, _2, _3, or _i',
        tok
      );
    }
    if (this._pendingWarnings.length > 0) {
      node.warnings ??= [];
      for (const w of this._pendingWarnings) node.warnings.push(w);
      this._pendingWarnings = [];
    }
    node.start = start;
    node.end = this.t.lastEndOffset;
    return node;
  }

  private _parseValueNode(): CborItem {
    const tok = this.t.peek();
    switch (tok.type) {
      case 'INTEGER':
        return this.parseIntegerOrTag();
      case 'FLOAT':
        return this.parseFloat();
      case 'TSTR':
      case 'RAWSTRING':
        return this.parseString();
      case 'BYTES_HEX':
      case 'SQSTR':
      case 'BYTES_B64': {
        this.t.consume();
        return this._parseBytesConcat(
          this._decodeBytesToken(tok),
          tok.type,
          tok.raw
        );
      }
      case 'EMPTY_INDEF_BYTES':
        this.t.consume();
        return new CborIndefiniteByteString([]);
      case 'EMPTY_INDEF_TEXT':
        this.t.consume();
        return new CborIndefiniteTextString([]);
      case 'TRUE':
        this.t.consume();
        return new CborSimple(21);
      case 'FALSE':
        this.t.consume();
        return new CborSimple(20);
      case 'NULL':
        this.t.consume();
        return new CborSimple(22);
      case 'UNDEFINED':
        this.t.consume();
        return new CborSimple(23);
      case 'SIMPLE':
        return this.parseSimple();
      case 'LBRACKET':
        return this.parseArray();
      case 'LBRACE':
        return this.parseMap();
      case 'LPAREN':
        return this.parseIndefGroup();
      case 'LT_LT':
        return this.parseEmbeddedCBOR();
      case 'APP_STRING': {
        this.t.consume();
        // Consume optional encoding indicator (e.g. float'fe00'_2).
        let appStrEw: EncodingWidth | undefined;
        let appStrEiRaw = '';
        if (this.t.peek().type === 'ENCODING_INDICATOR') {
          const eiTok = this.t.consume();
          appStrEw = this._resolveEncodingWidth(eiTok.value, eiTok);
          appStrEiRaw = eiTok.raw;
        }
        const ext = this.extByPrefix.get(tok.appPrefix!);
        if (!ext?.parseAppString) {
          if (!ext) this._hintMissingExtension(tok.appPrefix!, tok);
          if (this.unresolvedExtension === 'cpa999')
            return new CborUnresolvedAppExt(tok.appPrefix!, [
              new CborTextString(tok.value),
            ]);
          this._fail(
            `unknown app-string extension: ${JSON.stringify(tok.appPrefix)}`,
            tok
          );
        }
        {
          const warnsBefore = this._pendingWarnings.length;
          try {
            const result = ext.parseAppString(
              tok.appPrefix!,
              tok.value,
              this._extOnError(tok),
              appStrEw !== undefined ? { encodingWidth: appStrEw } : undefined
            );
            // Generic EI post-processing: apply encoding indicator when the
            // extension didn't handle it itself (e.g. dt'...'_2).
            if (appStrEw !== undefined)
              this._applyEiToResult(result, appStrEw, tok);
            // Propagate ednSource so preserveByteString / appStrings round-trips correctly.
            // instanceof narrows the type; getPrototypeOf excludes subclasses like CborIpExt.
            if (
              result instanceof CborByteString &&
              Object.getPrototypeOf(result) === CborByteString.prototype &&
              result.ednSource === undefined
            )
              return new CborByteString(result.value, {
                ednEncoding: result.ednEncoding,
                encodingWidth: result.encodingWidth,
                ednSource: tok.raw + appStrEiRaw,
              });
            if (result instanceof CborFloat && result.ednSource === undefined)
              result.ednSource = tok.raw + appStrEiRaw;
            return result;
          } catch (e) {
            if (this._options.strict !== false) throw e;
            if (this._pendingWarnings.length === warnsBefore)
              this._warn(e instanceof Error ? e.message : String(e), tok);
            return new CborUnresolvedAppExt(tok.appPrefix!, [
              new CborTextString(tok.value),
            ]);
          }
        }
      }
      case 'APP_SEQUENCE': {
        this.t.consume();
        const items: CborItem[] = [];
        while (this.t.peek().type !== 'GT_GT') {
          if (this.t.peek().type === 'EOF')
            this._fail(`unterminated ${tok.appPrefix!}<<...>>`, tok);
          if (items.length > 0) {
            if (this.t.peek().type === 'COMMA') {
              this.t.consume();
              if (this.t.peek().type === 'GT_GT') break; // trailing comma
            } else if (this.t.peek().offset === this.t.lastEndOffset) {
              this._warnOrFail(
                '<<...>> items must be separated by "," or whitespace',
                this.t.peek()
              );
            }
          }
          items.push(this.parseValue());
        }
        this.expect('GT_GT');
        let seqEw: EncodingWidth | undefined;
        let seqEiTok: Token | undefined;
        if (this.t.peek().type === 'ENCODING_INDICATOR') {
          seqEiTok = this.t.consume();
          seqEw = this._resolveEncodingWidth(seqEiTok.value, seqEiTok);
        }
        const seqExt = this.extByPrefix.get(tok.appPrefix!);
        if (!seqExt) {
          this._hintMissingExtension(tok.appPrefix!, tok);
          if (this.unresolvedExtension === 'cpa999')
            return new CborUnresolvedAppExt(tok.appPrefix!, items);
          this._fail(
            `unknown app-string extension: ${JSON.stringify(tok.appPrefix)}`,
            tok
          );
        }
        if (!seqExt.parseAppSequence)
          this._fail(
            `app-string extension ${JSON.stringify(tok.appPrefix)} does not support <<...>> form`,
            tok
          );
        {
          const warnsBefore = this._pendingWarnings.length;
          try {
            const result = seqExt.parseAppSequence(
              tok.appPrefix!,
              items,
              this._extOnError(tok)
            );
            if (seqEw !== undefined)
              this._applyEiToResult(result, seqEw, seqEiTok ?? tok);
            const rawSource = this.t.source.slice(
              tok.offset,
              this.t.lastEndOffset
            );
            if (result instanceof CborFloat) {
              if (result.ednSource === undefined) result.ednSource = rawSource;
            } else if (seqExt.preserveAppSeqSource) {
              return new CborAppSeqResult(result, rawSource);
            }
            return result;
          } catch (e) {
            if (this._options.strict !== false) throw e;
            if (this._pendingWarnings.length === warnsBefore)
              this._warn(e instanceof Error ? e.message : String(e), tok);
            return new CborUnresolvedAppExt(tok.appPrefix!, items);
          }
        }
      }
      case 'ELLIPSIS': {
        this.t.consume();
        if (this.t.peek().type !== 'PLUS') return new CborEllipsis();
        const items: CborItem[] = [new CborEllipsis()];
        while (this.t.peek().type === 'PLUS') {
          this.t.consume();
          items.push(this.parseValue());
        }
        return new CborEllipsis(items);
      }
      case 'BYTES_HEX_ELIDED': {
        this.t.consume();
        return this._parseHexElidedConcat(tok);
      }
      default:
        this._fail(`unexpected token: ${JSON.stringify(tok.value)}`, tok);
    }
  }

  private parseIntegerOrTag(): CborItem {
    const tok = this.t.consume(); // INTEGER
    const { numStr, rawSuffix } = parseIntegerRaw(tok.value);
    // Hex/octal/binary literals return before the suffix check in the tokenizer,
    // so their encoding indicator arrives as a separate ENCODING_INDICATOR token.
    let encodingWidth =
      rawSuffix !== undefined
        ? this._resolveEncodingWidth(rawSuffix, tok)
        : this.consumeEncodingIndicator();
    const n = parseBigInt(numStr);

    // Out-of-range integers become bignum tags per RFC 8949 §3.4.3.
    // Tag numbers must fit in uint64, so a value > UINT64_MAX before '(' is an error.
    if (n > 0xffff_ffff_ffff_ffffn) {
      if (this.t.peek().type === 'LPAREN')
        this._fail('tag number exceeds maximum uint64', tok);
      return new CborBigUint(n);
    }
    if (n < -(0xffff_ffff_ffff_ffffn + 1n)) {
      return new CborBigNint(n);
    }

    // Validate that the value fits in the requested encoding width.
    // For nint, the CBOR argument is abs(n)−1 (e.g. -1 → 0, -24 → 23).
    if (encodingWidth !== undefined) {
      const storedValue = n >= 0n ? n : -(n + 1n);
      encodingWidth = this._validateEncodingFit(
        storedValue,
        encodingWidth,
        tok
      );
    }

    const intNode =
      n >= 0n
        ? new CborUint(
            n,
            encodingWidth !== undefined ? { encodingWidth } : undefined
          )
        : new CborNint(
            n,
            encodingWidth !== undefined ? { encodingWidth } : undefined
          );

    // integer followed by '(' → tagged data item
    if (this.t.peek().type === 'LPAREN') {
      if (!(intNode instanceof CborUint))
        this._fail('tag number must be non-negative', tok);
      this.t.consume(); // (
      // Rescue setup warnings before content's parseValue() drains them into the content node.
      const setupWarnings = this._pendingWarnings.splice(0);
      const content = this.parseValue();
      this.expect('RPAREN');
      const tagNum = intNode.value;
      const ext = this.extByTag.get(tagNum);
      if (ext?.parseTag) {
        const result = ext.parseTag(tagNum, content);
        if (result !== undefined) {
          if (
            result instanceof CborTag &&
            encodingWidth !== undefined &&
            result.encodingWidth === undefined
          )
            result.encodingWidth = encodingWidth;
          if (setupWarnings.length > 0) {
            result.warnings ??= [];
            result.warnings.push(...setupWarnings);
          }
          return result;
        }
      }
      const tagResult = new CborTag(
        tagNum,
        content,
        encodingWidth !== undefined ? { encodingWidth } : undefined
      );
      if (setupWarnings.length > 0) {
        tagResult.warnings ??= [];
        tagResult.warnings.push(...setupWarnings);
      }
      return tagResult;
    }
    return intNode;
  }

  private parseFloat(): CborItem {
    const tok = this.t.consume(); // FLOAT
    const onRecoverableError = (msg: string) => this._warnOrFail(msg, tok);
    const { value, precision } = parseFloatToken(tok.value, onRecoverableError);
    if (precision === 'half' || precision === 'single') {
      const roundTripped =
        precision === 'half'
          ? float16BitsToFloat64(float64ToFloat16Bits(value))
          : Math.fround(value);
      const lossless =
        Object.is(value, roundTripped) || (isNaN(value) && isNaN(roundTripped));
      if (!lossless)
        onRecoverableError(
          `${value} cannot be exactly represented as ${precision === 'half' ? 'f16 (_1)' : 'f32 (_2)'}; use _3 or remove the indicator`
        );
    }
    return new CborFloat(
      value,
      precision !== undefined ? { precision } : undefined
    );
  }

  private parseString(): CborItem {
    const tok = this.t.consume(); // STRING

    // Fast path: no concatenation
    if (this.t.peek().type !== 'PLUS') {
      const ew = this.consumeEncodingIndicator(() =>
        BigInt(textEncoder.encode(tok.value).length)
      );
      if (tok.type === 'RAWSTRING')
        return new CborTextString(tok.value, {
          ednSource: tok.raw,
          ...(ew !== undefined ? { encodingWidth: ew } : {}),
        });
      return new CborTextString(
        tok.value,
        ew !== undefined ? { encodingWidth: ew } : undefined
      );
    }

    // Concatenation chain — may include ellipsis, producing CborEllipsis
    let hasEllipsis = false;
    const parts: Array<{ text: string; source?: string } | { ellipsis: true }> =
      [
        tok.type === 'RAWSTRING'
          ? { text: tok.value, source: tok.raw }
          : { text: tok.value },
      ];

    while (this.t.peek().type === 'PLUS') {
      this.t.consume(); // +
      const next = this.t.peek();
      if (next.type === 'ELLIPSIS') {
        this.t.consume();
        parts.push({ ellipsis: true });
        hasEllipsis = true;
      } else if (next.type === 'TSTR' || next.type === 'RAWSTRING') {
        this.t.consume();
        parts.push(
          next.type === 'RAWSTRING'
            ? { text: next.value, source: next.raw }
            : { text: next.value }
        );
      } else if (this._isBytesToken(next.type)) {
        this.t.consume();
        parts.push({
          text: this._decodeUtf8(this._decodeBytesToken(next), next),
        });
      } else {
        this._fail(
          `expected string or byte string after +, got ${JSON.stringify(next.value)}`,
          next
        );
      }
    }

    if (!hasEllipsis) {
      // No ellipsis — join all text fragments into a single CborTextString,
      // keeping the part boundaries for `preserveConcatenation`.
      const texts = parts.map((p) => ('text' in p ? p.text : ''));
      const sources = parts.map((p) => ('text' in p ? p.source : undefined));
      const joined = texts.join('');
      const ew = this.consumeEncodingIndicator(() =>
        BigInt(textEncoder.encode(joined).length)
      );
      return new CborTextString(joined, {
        ednParts: texts,
        ...(sources.some((s) => s !== undefined)
          ? { ednPartSources: sources }
          : {}),
        ...(ew !== undefined ? { encodingWidth: ew } : {}),
      });
    }

    // Build 888([...]) with consolidated adjacent text fragments, retaining
    // the original boundaries and raw source spellings within each fragment.
    const items: CborItem[] = [];
    const currentParts: Array<{ text: string; source?: string }> = [];
    const flushCurrentParts = () => {
      const texts = currentParts.map((part) => part.text);
      const currentText = texts.join('');
      if (currentText !== '') {
        const sources = currentParts.map((part) => part.source);
        items.push(
          new CborTextString(currentText, {
            ednParts: texts,
            ...(sources.some((source) => source !== undefined)
              ? { ednPartSources: sources }
              : {}),
          })
        );
      }
      currentParts.length = 0;
    };
    for (const part of parts) {
      if ('ellipsis' in part) {
        flushCurrentParts();
        items.push(new CborEllipsis());
      } else {
        currentParts.push(part);
      }
    }
    flushCurrentParts();

    return new CborEllipsis(items);
  }

  private _isBytesToken(type: string): boolean {
    return type === 'BYTES_HEX' || type === 'SQSTR' || type === 'BYTES_B64';
  }

  /**
   * Decode a hex payload, converting the codec's plain SyntaxError (e.g. odd
   * length) into a CdnSyntaxError carrying the token's position.
   */
  private _hexToBytes(hex: string, tok: Token): Uint8Array {
    try {
      return hexToBytes(hex);
    } catch (e) {
      if (e instanceof CdnSyntaxError || !(e instanceof SyntaxError)) throw e;
      this._fail(e.message, tok);
    }
  }

  private _decodeBytesToken(tok: Token): Uint8Array {
    const onRecoverableError = (msg: string) => this._warnOrFail(msg, tok);
    switch (tok.type) {
      case 'SQSTR': {
        // The tokenizer attaches the UTF-8 payload it already encoded;
        // decoding the hex `value` again would just rebuild the same bytes.
        const bytes = (tok as SqstrToken)._sqstrBytes;
        if (bytes !== undefined) return bytes;
        return this._hexToBytes(tok.value, tok);
      }
      case 'BYTES_HEX':
        return this._hexToBytes(tok.value, tok);
      case 'BYTES_B64':
        try {
          return base64ToBytes(tok.value, onRecoverableError);
        } catch (e) {
          if (e instanceof CdnSyntaxError || !(e instanceof SyntaxError))
            throw e;
          this._fail(e.message, tok);
        }
      default:
        this._fail(`expected byte string token`, tok);
    }
  }

  private _decodeUtf8(bytes: Uint8Array, tok: Token): string {
    if (this._options.allowInvalidUtf8) return utf8Lenient.decode(bytes);
    try {
      return utf8Strict.decode(bytes);
    } catch {
      const msg = 'byte string in text concatenation is not valid UTF-8';
      this._warnOrFail(msg, tok);
      return utf8Lenient.decode(bytes);
    }
  }

  private _tokenTypeToCdnEncoding(type: string): 'hex' | 'base64' {
    return type === 'BYTES_B64' ? 'base64' : 'hex';
  }

  private _parseBytesConcat(
    first: Uint8Array,
    firstType: string,
    firstSource: string
  ): CborByteString | CborEllipsis {
    if (this.t.peek().type !== 'PLUS') {
      const ew = this.consumeEncodingIndicator(() => BigInt(first.length));
      const ednEncoding = this._tokenTypeToCdnEncoding(firstType);
      return new CborByteString(first, {
        ednEncoding,
        ednSource: firstSource,
        ...(ew !== undefined ? { encodingWidth: ew } : {}),
      });
    }

    // Concatenation chain — may include ellipsis
    let hasEllipsis = false;
    const parts: Array<
      { bytes: Uint8Array; source?: string } | { ellipsis: true }
    > = [{ bytes: first, source: firstSource }];

    while (this.t.peek().type === 'PLUS') {
      this.t.consume(); // +
      const next = this.t.peek();
      if (next.type === 'ELLIPSIS') {
        this.t.consume();
        parts.push({ ellipsis: true });
        hasEllipsis = true;
      } else if (next.type === 'BYTES_HEX_ELIDED') {
        this.t.consume();
        const subItems = this._buildBytesElidedItems(next.value, next);
        for (const item of subItems) {
          if (item instanceof CborEllipsis) {
            parts.push({ ellipsis: true });
            hasEllipsis = true;
          } else if (item instanceof CborByteString) {
            parts.push({ bytes: item.value });
          }
        }
      } else if (this._isBytesToken(next.type)) {
        this.t.consume();
        parts.push({ bytes: this._decodeBytesToken(next), source: next.raw });
      } else if (next.type === 'TSTR' || next.type === 'RAWSTRING') {
        // §5.1: when a byte string leads, the right-hand side must also be a
        // byte string.  Text strings are only allowed on the right of a
        // text-leading concatenation.  In non-strict mode we UTF-8 encode
        // the text and continue; in strict mode this is a hard error.
        this.t.consume();
        const mixMsg =
          'text string in a byte-string concatenation is not allowed; ' +
          "use a byte string literal (h'...', b64'...', or '...') instead";
        this._warnOrFail(mixMsg, next);
        parts.push({ bytes: textEncoder.encode(next.value) });
      } else {
        this._fail(
          `expected byte string after +, got ${JSON.stringify(next.value)}`,
          next
        );
      }
    }

    if (!hasEllipsis) {
      const byteParts = parts.map((p) =>
        'bytes' in p ? p : { bytes: new Uint8Array(0) }
      );
      const concat = this._concatBytes(byteParts.map((p) => p.bytes));
      const ew = this.consumeEncodingIndicator(() => BigInt(concat.length));
      return new CborByteString(concat, {
        ednEncoding: this._tokenTypeToCdnEncoding(firstType),
        ednParts: byteParts,
        ...(ew !== undefined ? { encodingWidth: ew } : {}),
      });
    }

    // Build 888([...]) with consolidated adjacent byte fragments
    const items: CborItem[] = [];
    const pending: Uint8Array[] = [];
    const flushPending = () => {
      if (pending.length > 0) {
        items.push(new CborByteString(this._concatBytes([...pending])));
        pending.length = 0;
      }
    };
    for (const part of parts) {
      if ('ellipsis' in part) {
        flushPending();
        items.push(new CborEllipsis());
      } else {
        pending.push(part.bytes);
      }
    }
    flushPending();

    return new CborEllipsis(items);
  }

  /**
   * Parse a BYTES_HEX_ELIDED token (h'xx...yy') and any trailing + concatenation
   * into a CborEllipsis([h'xx', 888(null), h'yy', ...]).
   */
  private _parseHexElidedConcat(firstTok: Token): CborEllipsis {
    const items = this._buildBytesElidedItems(firstTok.value, firstTok);

    while (this.t.peek().type === 'PLUS') {
      this.t.consume(); // +
      const next = this.t.peek();
      if (next.type === 'ELLIPSIS') {
        this.t.consume();
        items.push(new CborEllipsis());
      } else if (next.type === 'BYTES_HEX_ELIDED') {
        this.t.consume();
        const subItems = this._buildBytesElidedItems(next.value, next);
        this._mergeFirstBytesItem(items, subItems);
      } else if (this._isBytesToken(next.type)) {
        this.t.consume();
        const bytes = this._decodeBytesToken(next);
        // Append to the last item if it's a CborByteString
        const last = items[items.length - 1];
        if (last instanceof CborByteString) {
          items[items.length - 1] = new CborByteString(
            this._concatBytes([last.value, bytes])
          );
        } else {
          items.push(new CborByteString(bytes));
        }
      } else {
        this._fail(
          `expected byte string after +, got ${JSON.stringify(next.value)}`,
          next
        );
      }
    }
    return new CborEllipsis(items);
  }

  private _buildBytesElidedItems(
    hexWithEllipsis: string,
    tok: Token
  ): CborItem[] {
    const segments = hexWithEllipsis.split('...');
    const items: CborItem[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) items.push(new CborEllipsis());
      if (segments[i].length > 0) {
        items.push(new CborByteString(this._hexToBytes(segments[i], tok)));
      }
    }
    return items;
  }

  private _mergeFirstBytesItem(target: CborItem[], source: CborItem[]): void {
    if (source.length === 0) return;
    const lastTarget = target[target.length - 1];
    const firstSource = source[0];
    if (
      lastTarget instanceof CborByteString &&
      firstSource instanceof CborByteString
    ) {
      target[target.length - 1] = new CborByteString(
        this._concatBytes([lastTarget.value, firstSource.value])
      );
      target.push(...source.slice(1));
    } else {
      target.push(...source);
    }
  }

  private _concatBytes(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }

  private parseSimple(): CborSimple {
    this.t.consume(); // 'simple'
    this.expect('LPAREN');
    const numTok = this.t.peek();
    if (numTok.type !== 'INTEGER')
      this._fail(
        `expected integer inside simple(), got ${JSON.stringify(numTok.value)}`,
        numTok
      );
    this.t.consume();
    const { numStr } = parseIntegerRaw(numTok.value);
    const n = Number(parseBigInt(numStr));
    this.expect('RPAREN');
    return new CborSimple(n);
  }

  private parseEmbeddedCBOR(): CborEmbeddedCBOR {
    this.t.consume(); // <<
    const items: CborItem[] = [];
    while (this.t.peek().type !== 'GT_GT') {
      if (items.length > 0) {
        if (this.t.peek().type === 'COMMA') {
          this.t.consume();
          if (this.t.peek().type === 'GT_GT') break; // trailing comma
        } else if (this.t.peek().offset === this.t.lastEndOffset) {
          this._warnOrFail(
            '<<...>> items must be separated by "," or whitespace',
            this.t.peek()
          );
        }
      }
      items.push(this.parseValue());
    }
    this.expect('GT_GT');
    let encodingWidth: EncodingWidth | undefined;
    if (this.t.peek().type === 'ENCODING_INDICATOR') {
      const eiTok = this.t.consume();
      encodingWidth = this._resolveEncodingWidth(eiTok.value, eiTok);
    }
    return new CborEmbeddedCBOR(items, { encodingWidth });
  }

  private parseArray(): CborArray {
    this.t.consume(); // [
    let indefiniteLength = false;
    let encodingWidth: EncodingWidth | undefined;
    let eiTok: Token | undefined;
    if (this.t.peek().type === 'UNDERSCORE') {
      this.t.consume();
      indefiniteLength = true;
    } else if (this.t.peek().type === 'ENCODING_INDICATOR') {
      eiTok = this.t.consume();
      if (eiTok.value === '7') {
        indefiniteLength = true;
        const msg =
          'encoding indicator _7 is non-standard; use _ to indicate indefinite length';
        this._warnOrFail(msg, eiTok);
        eiTok = undefined;
      } else {
        encodingWidth = this._resolveEncodingWidth(eiTok.value, eiTok);
      }
    }
    // Rescue setup warnings before inner parseValue() calls drain them into child nodes.
    const setupWarnings = this._pendingWarnings.splice(0);
    const items: CborItem[] = [];
    while (this.t.peek().type !== 'RBRACKET') {
      if (items.length > 0) {
        if (this.t.peek().type === 'COMMA') {
          this.t.consume();
          if (this.t.peek().type === 'RBRACKET') break; // trailing comma
        } else if (this.t.peek().offset === this.t.lastEndOffset) {
          this._warnOrFail(
            'array items must be separated by "," or whitespace',
            this.t.peek()
          );
        }
      }
      items.push(this.parseValue());
    }
    this.expect('RBRACKET');
    if (encodingWidth !== undefined && eiTok !== undefined) {
      encodingWidth = this._validateEncodingFit(
        BigInt(items.length),
        encodingWidth,
        eiTok
      );
      // _validateEncodingFit may add to _pendingWarnings; outer parseValue() flushes those.
    }
    const arrayResult = new CborArray(items, {
      indefiniteLength,
      encodingWidth,
    });
    if (setupWarnings.length > 0) {
      arrayResult.warnings ??= [];
      arrayResult.warnings.push(...setupWarnings);
    }
    return arrayResult;
  }

  private parseMap(): CborMap {
    this.t.consume(); // {
    let indefiniteLength = false;
    let encodingWidth: EncodingWidth | undefined;
    let eiTok: Token | undefined;
    if (this.t.peek().type === 'UNDERSCORE') {
      this.t.consume();
      indefiniteLength = true;
    } else if (this.t.peek().type === 'ENCODING_INDICATOR') {
      eiTok = this.t.consume();
      if (eiTok.value === '7') {
        indefiniteLength = true;
        const msg =
          'encoding indicator _7 is non-standard; use _ to indicate indefinite length';
        this._warnOrFail(msg, eiTok);
        eiTok = undefined;
      } else {
        encodingWidth = this._resolveEncodingWidth(eiTok.value, eiTok);
      }
    }
    // Rescue setup warnings before inner parseValue() calls drain them into child nodes.
    const setupWarnings = this._pendingWarnings.splice(0);
    const entries: [CborItem, CborItem][] = [];
    while (this.t.peek().type !== 'RBRACE') {
      if (entries.length > 0) {
        if (this.t.peek().type === 'COMMA') {
          this.t.consume();
          if (this.t.peek().type === 'RBRACE') break; // trailing comma
        } else if (this.t.peek().offset === this.t.lastEndOffset) {
          this._warnOrFail(
            'map entries must be separated by "," or whitespace',
            this.t.peek()
          );
        }
      }
      const key = this.parseValue();
      this.expect('COLON');
      const val = this.parseValue();
      entries.push([key, val]);
    }
    this.expect('RBRACE');
    if (encodingWidth !== undefined && eiTok !== undefined) {
      encodingWidth = this._validateEncodingFit(
        BigInt(entries.length),
        encodingWidth,
        eiTok
      );
    }
    const mapResult = new CborMap(entries, { indefiniteLength, encodingWidth });
    if (setupWarnings.length > 0) {
      mapResult.warnings ??= [];
      mapResult.warnings.push(...setupWarnings);
    }
    return mapResult;
  }

  /** Parses `(_ chunk, chunk, ...)` — indefinite byte or text string. */
  private parseIndefGroup():
    CborIndefiniteByteString | CborIndefiniteTextString {
    this.t.consume(); // (
    const next = this.t.peek();
    if (next.type === 'UNDERSCORE') {
      this.t.consume(); // _
    } else if (next.type === 'ENCODING_INDICATOR' && next.value === '7') {
      this.t.consume(); // _7 — alias for _, but non-standard
      const msg7 =
        'encoding indicator _7 is non-standard; use _ to indicate indefinite length';
      this._warnOrFail(msg7, next);
    } else if (next.type === 'ENCODING_INDICATOR') {
      // _0–_6: not meaningful here; warn and drop, then parse chunks
      const tok = this.t.consume();
      const msg = `encoding indicator _${tok.value} is not valid in an indefinite string group; use _`;
      this._warnOrFail(msg, tok);
    } else if (next.type !== 'RPAREN') {
      // No indicator at all — warn that _ is expected, then parse chunks
      const msg =
        'indefinite string group is missing _ after (; interpreting as (_ ...)';
      this._warnOrFail(msg, next);
      // Do not consume — the next token is the first chunk
    }

    // Rescue any warnings emitted above from _pendingWarnings before inner
    // parseValue() calls for each chunk drain them into the wrong node.
    const setupWarnings = this._pendingWarnings.splice(0);

    const chunks: CborItem[] = [];
    while (this.t.peek().type !== 'RPAREN') {
      if (chunks.length > 0) {
        if (this.t.peek().type === 'COMMA') {
          this.t.consume();
          if (this.t.peek().type === 'RPAREN') break; // trailing comma
        } else if (this.t.peek().offset === this.t.lastEndOffset) {
          this._warnOrFail(
            'indefinite string chunks must be separated by "," or whitespace',
            this.t.peek()
          );
        }
      }
      chunks.push(this.parseValue());
    }
    this.expect('RPAREN');

    if (chunks.length === 0)
      this._fail(
        'empty indefinite group (_ ) is ambiguous; use \'\'_ for bytes or ""_ for text'
      );

    const first = chunks[0];
    // All chunks must be the same type — mixing byte and text strings is
    // a SyntaxError per draft §2.5.4.
    if (first instanceof CborByteString) {
      const byteChunks = chunks.map((c, i) => {
        if (c instanceof CborByteString) return c;
        this._fail(
          `indefinite byte string chunk ${i} must be a byte string, not a text string`
        );
      });
      const result = new CborIndefiniteByteString(byteChunks);
      if (setupWarnings.length > 0) result.warnings = setupWarnings;
      return result;
    }
    if (first instanceof CborTextString) {
      const textChunks = chunks.map((c, i) => {
        if (c instanceof CborTextString) return c;
        this._fail(
          `indefinite text string chunk ${i} must be a text string, not a byte string`
        );
      });
      const result = new CborIndefiniteTextString(textChunks);
      if (setupWarnings.length > 0) result.warnings = setupWarnings;
      return result;
    }
    this._fail('indefinite group chunks must be byte strings or text strings');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Consume an ENCODING_INDICATOR token if present.
   * Validates the indicator type (reserved/indefinite), and when
   * `getStoredValue` is supplied also checks that the value fits in the
   * requested encoding width.  The stored value is computed lazily — only
   * when an indicator is actually present — so callers can pass e.g. a
   * UTF-8 byte-length computation without paying for it on every string.
   */
  private consumeEncodingIndicator(
    getStoredValue?: () => bigint
  ): EncodingWidth | undefined {
    if (this.t.peek().type === 'ENCODING_INDICATOR') {
      const tok = this.t.consume();
      let ew = this._resolveEncodingWidth(tok.value, tok);
      if (ew !== undefined && getStoredValue !== undefined) {
        ew = this._validateEncodingFit(getStoredValue(), ew, tok);
      }
      return ew;
    }
    return undefined;
  }

  private expect(type: TokenType): Token {
    const tok = this.t.consume();
    if (tok.type !== type)
      this._fail(
        `expected ${type}, got ${tok.type} (${JSON.stringify(tok.value)})`,
        tok
      );
    return tok;
  }

  /**
   * Validate that `storedValue` fits in the given encoding width.
   * Returns `ew` if valid; warns and returns `undefined` if not (throws in strict mode).
   * `storedValue` is the CBOR argument: the integer itself for uint/tag, `abs(n)−1` for nint,
   * the byte-length for strings, or the item count for arrays/maps.
   */
  /** Apply an encoding indicator to a parsed app-string / app-sequence result. */
  private _applyEiToResult(
    result: CborItem,
    ew: EncodingWidth,
    tok: Token
  ): void {
    if (result instanceof CborFloat) {
      const targetPrec: FloatPrecision | undefined =
        ew === 1
          ? 'half'
          : ew === 2
            ? 'single'
            : ew === 3
              ? 'double'
              : undefined;
      if (targetPrec === undefined) {
        this._warnOrFail(
          `encoding indicator _${ew} is not valid for a float; use _1, _2, or _3`,
          tok
        );
      } else if (result.precision !== targetPrec) {
        if (targetPrec !== 'double') {
          const rt =
            targetPrec === 'half'
              ? float16BitsToFloat64(float64ToFloat16Bits(result.value))
              : Math.fround(result.value);
          if (!Object.is(rt, result.value) && !isNaN(result.value))
            this._warnOrFail(
              `${result.value} cannot be exactly represented as ${targetPrec === 'half' ? 'float16 (_1)' : 'float32 (_2)'}`,
              tok
            );
        }
        result.precision = targetPrec;
      }
    } else if (result instanceof CborUint) {
      if (result.encodingWidth === undefined) {
        const ewv = this._validateEncodingFit(result.value, ew, tok);
        if (ewv !== undefined) result.encodingWidth = ewv;
      }
    } else if (result instanceof CborNint) {
      if (result.encodingWidth === undefined) {
        const ewv = this._validateEncodingFit(result.argument, ew, tok);
        if (ewv !== undefined) result.encodingWidth = ewv;
      }
    } else if (result instanceof CborByteString) {
      if (result.encodingWidth === undefined) {
        const ewv = this._validateEncodingFit(
          BigInt(result.value.length),
          ew,
          tok
        );
        if (ewv !== undefined) result.encodingWidth = ewv;
      }
    } else if (result instanceof CborTextString) {
      if (result.encodingWidth === undefined) {
        const ewv = this._validateEncodingFit(
          BigInt(textEncoder.encode(result.value).length),
          ew,
          tok
        );
        if (ewv !== undefined) result.encodingWidth = ewv;
      }
    } else if (result instanceof CborArray) {
      if (result.encodingWidth === undefined) {
        const ewv = this._validateEncodingFit(
          BigInt(result.items.length),
          ew,
          tok
        );
        if (ewv !== undefined) result.encodingWidth = ewv;
      }
    } else if (result instanceof CborMap) {
      if (result.encodingWidth === undefined) {
        const ewv = this._validateEncodingFit(
          BigInt(result.entries.length),
          ew,
          tok
        );
        if (ewv !== undefined) result.encodingWidth = ewv;
      }
    } else if (result instanceof CborTag) {
      // Per draft-ietf-cbor-edn-literals-25 §2.3.1, the EI applies to
      // the tag number, not to the content (e.g. 1_1(4711) → 2-byte tag).
      if (result.encodingWidth === undefined) {
        const ewv = this._validateEncodingFit(result.tag, ew, tok);
        if (ewv !== undefined) result.encodingWidth = ewv;
      }
    } else {
      this._warnOrFail(
        `encoding indicator _${ew} is not applicable to this app-string result type`,
        tok
      );
    }
  }

  private _validateEncodingFit(
    storedValue: bigint,
    ew: EncodingWidth,
    tok: Token
  ): EncodingWidth | undefined {
    const max = maxForEncodingWidth(ew);
    if (storedValue <= max) return ew;
    const label = ew === 'i' ? '_i (max 23)' : `_${ew} (max ${max})`;
    const msg = `value ${storedValue} does not fit in encoding indicator ${label}`;
    this._warnOrFail(msg, tok);
    return undefined;
  }

  private _resolveEncodingWidth(
    raw: string,
    tok: Token
  ): EncodingWidth | undefined {
    if (raw === '4' || raw === '5' || raw === '6') {
      const ai = Number(raw) + 24; // 28, 29, or 30 — reserved in RFC 8949
      const msg = `encoding indicator _${raw} (AI ${ai}) is reserved and not valid`;
      this._warnOrFail(msg, tok);
      return undefined;
    }
    if (raw === '7') {
      const msg =
        'indefinite-length encoding (_7) is not valid here; use [_ ...] or {_ ...} for indefinite collections';
      this._warnOrFail(msg, tok);
      return undefined;
    }
    if (raw === 'i') return 'i';
    return Number(raw) as EncodingWidth; // '0'–'3' → 0–3
  }

  /** Builds the onError callback passed to extension parseAppString/parseAppSequence. */
  private _extOnError(tok: Token): (msg: string) => void {
    return (msg: string) => this._warnOrFail(msg, tok);
  }

  /**
   * Record a strict violation: always emits a ParseWarning, and in strict
   * mode (the default) also throws a SyntaxError at the token's location.
   */
  private _warnOrFail(msg: string, tok?: Token): void {
    this._warn(msg, tok);
    if (this._options.strict !== false) this._fail(msg, tok);
  }

  /**
   * Emit a one-time, non-fatal hint when a known opt-in extension prefix
   * (b32, h32, float, same, hash, uuid) is used without the corresponding
   * extension registered. Never throws and does not attach node warnings;
   * parsing continues with the usual unresolved-extension handling.
   */
  private _hintMissingExtension(prefix: string, tok: Token): void {
    const hint = MISSING_EXTENSION_HINTS.get(prefix);
    if (hint === undefined || this._hintedPrefixes.has(prefix)) return;
    this._hintedPrefixes.add(prefix);
    const message = `app-string prefix '${prefix}' requires an extension that is not enabled; ${hint}`;
    if (this._options.onWarning) {
      this._options.onWarning({ message, ...tokenPosition(tok) });
    } else if (!this._options.silent) {
      console.warn(`CDN: ${message}`);
    }
  }

  private _warn(msg: string, tok?: Token): void {
    const warning: ParseWarning = { message: msg };
    if (tok !== undefined) Object.assign(warning, tokenPosition(tok));
    this._pendingWarnings.push(warning);
    if (this._options.onWarning) {
      this._options.onWarning(warning);
    } else if (!this._options.silent) {
      const loc = tok ? ` at line ${tok.line}, column ${tok.col}` : '';
      console.warn(`CDN strict violation${loc}: ${msg}`);
    }
  }

  private _fail(msg: string, tok?: Token): never {
    throw new CdnSyntaxError(msg, tok ? tokenPosition(tok) : undefined);
  }
}

/** A token's source position in the shape shared by ParseWarning and CdnSyntaxError. */
function tokenPosition(tok: Token): {
  offset: number;
  line: number;
  column: number;
  endOffset: number;
} {
  return {
    offset: tok.offset,
    line: tok.line,
    column: tok.col,
    endOffset: tok.endOffset,
  };
}
