import {
  Tokenizer,
  type EdnComment,
  type Token,
  type TokenType,
} from './tokenizer';
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
import type { EncodingWidth } from '../cbor/encode';
import { parseHexFloat } from '../utils/hexfloat';
import { float64ToFloat16Bits, float16BitsToFloat64 } from '../utils/float16';
import { BUILTIN_EXTENSIONS } from '../extensions/builtins';
import { CborUnresolvedAppExt } from '../ast/CborUnresolvedAppExt';
import { CborEllipsis } from '../ast/CborEllipsis';
import { CborBigUint, CborBigNint } from '../ast/CborBignum';

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Parse a CDN text string into a CborItem AST node.
 * Throws SyntaxError on invalid input.
 */
export function parseCDN(text: string, options?: FromCDNOptions): CborItem {
  const tokenizer = new Tokenizer(text, { offset: options?.offset });
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

function hexToBytes(hex: string): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (Uint8Array as any).fromHex === 'function')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Uint8Array as any).fromHex(hex);
  if (hex.length % 2 !== 0)
    throw new SyntaxError(`hex string has odd length: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const H32_ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUV';

function base32Decode(
  str: string,
  alpha: string,
  onRecoverableError?: (msg: string) => void
): Uint8Array {
  // Padding is optional per the ABNF (§5.2.2 analogue for base32); strip it.
  const s = str.replace(/=+$/, '').toUpperCase();
  // RFC 4648 §6: valid unpadded lengths mod 8 are 0, 2, 4, 5, 7.
  // Lengths 1, 3, 6 mod 8 cannot arise from any valid byte sequence.
  const rem = s.length % 8;
  if (rem === 1 || rem === 3 || rem === 6)
    throw new SyntaxError(`invalid base32 length: ${s.length} characters`);
  const lookup = new Uint8Array(128).fill(0xff);
  for (let i = 0; i < alpha.length; i++) lookup[alpha.charCodeAt(i)] = i;
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let buf = 0,
    bufBits = 0,
    outIdx = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    const val = code < 128 ? lookup[code] : 0xff;
    if (val === 0xff)
      throw new SyntaxError(
        `invalid character in byte string: ${JSON.stringify(ch)}`
      );
    buf = (buf << 5) | val;
    bufBits += 5;
    if (bufBits >= 8) {
      bufBits -= 8;
      out[outIdx++] = (buf >> bufBits) & 0xff;
    }
  }
  // RFC 4648 §3.5: trailing bits in the last quantum must be zero.
  if (bufBits > 0 && (buf & ((1 << bufBits) - 1)) !== 0) {
    const msg = 'non-zero trailing bits in base32 input';
    if (onRecoverableError) {
      onRecoverableError(msg); // warn and ignore the trailing bits
    } else {
      throw new SyntaxError(msg);
    }
  }
  return out;
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

  for (const raw of comments) {
    const comment: CborComment = { ...raw };
    const prev = [...nodes]
      .filter((n) => n.end <= raw.start)
      .sort((a, b) => b.end - a.end || b.start - a.start)[0];
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

    const container = [...nodes]
      .filter((n) => n.start < raw.start && raw.end < n.end)
      .sort((a, b) => b.start - a.start || a.end - b.end)[0];
    const next = [...nodes]
      .filter((n) => n.start >= raw.end)
      .sort((a, b) => a.start - b.start || b.end - a.end)[0];
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

// ─── Parser ───────────────────────────────────────────────────────────────────

class CDNParser {
  /** Lookup from app-prefix → extension (user extensions override built-ins). */
  private readonly extByPrefix: Map<string, CborExtension>;
  /** Lookup from tag number → extension. */
  private readonly extByTag: Map<bigint, CborExtension>;

  private readonly unresolvedExtension: 'cpa999' | 'error';

  /** Warnings accumulated during the current parseValue() call. */
  private _pendingWarnings: ParseWarning[] = [];

  constructor(
    private readonly t: Tokenizer,
    private readonly _options: FromCDNOptions
  ) {
    this.extByPrefix = new Map();
    this.extByTag = new Map();
    this.unresolvedExtension = _options.unresolvedExtension ?? 'cpa999';
    for (const ext of [...BUILTIN_EXTENSIONS, ...(_options.extensions ?? [])]) {
      for (const prefix of ext.appStringPrefixes ?? [])
        this.extByPrefix.set(prefix, ext);
      for (const tag of ext.tagNumbers ?? []) this.extByTag.set(tag, ext);
    }
    this.t.onEscapeWarning = (msg, offset, line, col) => {
      const w: ParseWarning = { message: msg, offset, line, column: col };
      this._pendingWarnings.push(w);
      if (this._options.onWarning) this._options.onWarning(w);
      else if (!this._options.silent)
        console.warn(
          `CDN strict violation at line ${line}, column ${col}: ${msg}`
        );
      if (this._options.strict !== false)
        throw new SyntaxError(
          `EDN parse error at line ${line}, column ${col}: ${msg}`
        );
    };
  }

  parse(): CborItem {
    const value = this.parseValue();
    if (this._options.allowTrailing) return value;
    const next = this.t.peek();
    if (next.type !== 'EOF') {
      this._fail(
        `unexpected token after value: ${JSON.stringify(next.value)}`,
        next
      );
    }
    return value;
  }

  parseValue(): CborItem {
    const start = this.t.peek().offset;
    const node = this._parseValueNode();
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
      case 'BYTES_B64':
      case 'BYTES_B32':
      case 'BYTES_H32': {
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
        return CborSimple.TRUE;
      case 'FALSE':
        this.t.consume();
        return CborSimple.FALSE;
      case 'NULL':
        this.t.consume();
        return CborSimple.NULL;
      case 'UNDEFINED':
        this.t.consume();
        return CborSimple.UNDEFINED;
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
        const ext = this.extByPrefix.get(tok.appPrefix!);
        if (!ext?.parseAppString) {
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
            return ext.parseAppString(
              tok.appPrefix!,
              tok.value,
              this._extOnError(tok)
            );
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
          if (items.length > 0 && this.t.peek().type === 'COMMA') {
            this.t.consume();
            if (this.t.peek().type === 'GT_GT') break; // trailing comma
          }
          items.push(this.parseValue());
        }
        this.expect('GT_GT');
        const seqExt = this.extByPrefix.get(tok.appPrefix!);
        if (!seqExt) {
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
            return seqExt.parseAppSequence(
              tok.appPrefix!,
              items,
              this._extOnError(tok)
            );
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
    const onRecoverableError = (msg: string) => {
      this._warn(msg, tok);
      if (this._options.strict !== false) this._fail(msg, tok);
    };
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
      const byteLen = BigInt(new TextEncoder().encode(tok.value).length);
      const ew = this.consumeEncodingIndicator(byteLen);
      return new CborTextString(
        tok.value,
        ew !== undefined ? { encodingWidth: ew } : undefined
      );
    }

    // Concatenation chain — may include ellipsis, producing CborEllipsis
    let hasEllipsis = false;
    const parts: Array<{ text: string } | { ellipsis: true }> = [
      { text: tok.value },
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
        parts.push({ text: next.value });
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
      // No ellipsis — join all text fragments into a single CborTextString
      const joined = parts.map((p) => ('text' in p ? p.text : '')).join('');
      const byteLen = BigInt(new TextEncoder().encode(joined).length);
      const ew = this.consumeEncodingIndicator(byteLen);
      return new CborTextString(
        joined,
        ew !== undefined ? { encodingWidth: ew } : undefined
      );
    }

    // Build 888([...]) with consolidated adjacent text fragments
    const items: CborItem[] = [];
    let currentText = '';
    for (const part of parts) {
      if ('ellipsis' in part) {
        if (currentText !== '') {
          items.push(new CborTextString(currentText));
          currentText = '';
        }
        items.push(new CborEllipsis());
      } else {
        currentText += part.text;
      }
    }
    if (currentText !== '') items.push(new CborTextString(currentText));

    return new CborEllipsis(items);
  }

  private _isBytesToken(type: string): boolean {
    return (
      type === 'BYTES_HEX' ||
      type === 'SQSTR' ||
      type === 'BYTES_B64' ||
      type === 'BYTES_B32' ||
      type === 'BYTES_H32'
    );
  }

  private _decodeBytesToken(tok: Token): Uint8Array {
    const onRecoverableError = (msg: string) => {
      this._warn(msg, tok);
      if (this._options.strict !== false) this._fail(msg, tok);
    };
    switch (tok.type) {
      case 'BYTES_HEX':
      case 'SQSTR':
        return hexToBytes(tok.value);
      case 'BYTES_B64':
        return base64ToBytes(tok.value, onRecoverableError);
      case 'BYTES_B32':
        return base32Decode(tok.value, B32_ALPHA, onRecoverableError);
      case 'BYTES_H32':
        return base32Decode(tok.value, H32_ALPHA, onRecoverableError);
      default:
        this._fail(`expected byte string token`, tok);
    }
  }

  private _decodeUtf8(bytes: Uint8Array, tok: Token): string {
    if (this._options.allowInvalidUtf8)
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      const msg = 'byte string in text concatenation is not valid UTF-8';
      this._warn(msg, tok);
      if (this._options.strict !== false) this._fail(msg, tok);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  }

  private _tokenTypeToCdnEncoding(
    type: string
  ): 'hex' | 'base64' | 'base32' | 'base32hex' {
    switch (type) {
      case 'BYTES_B64':
        return 'base64';
      case 'BYTES_B32':
        return 'base32';
      case 'BYTES_H32':
        return 'base32hex';
      default:
        return 'hex';
    }
  }

  private _parseBytesConcat(
    first: Uint8Array,
    firstType: string,
    firstSource: string
  ): CborByteString | CborEllipsis {
    if (this.t.peek().type !== 'PLUS') {
      const ew = this.consumeEncodingIndicator(BigInt(first.length));
      const ednEncoding = this._tokenTypeToCdnEncoding(firstType);
      return new CborByteString(first, {
        ednEncoding,
        ednSource: firstSource,
        ...(ew !== undefined ? { encodingWidth: ew } : {}),
      });
    }

    // Concatenation chain — may include ellipsis
    let hasEllipsis = false;
    const parts: Array<{ bytes: Uint8Array } | { ellipsis: true }> = [
      { bytes: first },
    ];

    while (this.t.peek().type === 'PLUS') {
      this.t.consume(); // +
      const next = this.t.peek();
      if (next.type === 'ELLIPSIS') {
        this.t.consume();
        parts.push({ ellipsis: true });
        hasEllipsis = true;
      } else if (next.type === 'BYTES_HEX_ELIDED') {
        this.t.consume();
        const subItems = this._buildBytesElidedItems(next.value);
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
        parts.push({ bytes: this._decodeBytesToken(next) });
      } else if (next.type === 'TSTR' || next.type === 'RAWSTRING') {
        // §5.1: when a byte string leads, the right-hand side must also be a
        // byte string.  Text strings are only allowed on the right of a
        // text-leading concatenation.  In non-strict mode we UTF-8 encode
        // the text and continue; in strict mode this is a hard error.
        this.t.consume();
        const mixMsg =
          'text string in a byte-string concatenation is not allowed; ' +
          "use a byte string literal (h'...', b64'...', or '...') instead";
        this._warn(mixMsg, next);
        if (this._options.strict !== false) this._fail(mixMsg, next);
        parts.push({ bytes: new TextEncoder().encode(next.value) });
      } else {
        this._fail(
          `expected byte string after +, got ${JSON.stringify(next.value)}`,
          next
        );
      }
    }

    if (!hasEllipsis) {
      const allBytes = parts.map((p) =>
        'bytes' in p ? p.bytes : new Uint8Array(0)
      );
      const concat = this._concatBytes(allBytes);
      const ew = this.consumeEncodingIndicator(BigInt(concat.length));
      return new CborByteString(
        concat,
        ew !== undefined ? { encodingWidth: ew } : undefined
      );
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
    const items = this._buildBytesElidedItems(firstTok.value);

    while (this.t.peek().type === 'PLUS') {
      this.t.consume(); // +
      const next = this.t.peek();
      if (next.type === 'ELLIPSIS') {
        this.t.consume();
        items.push(new CborEllipsis());
      } else if (next.type === 'BYTES_HEX_ELIDED') {
        this.t.consume();
        const subItems = this._buildBytesElidedItems(next.value);
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

  private _buildBytesElidedItems(hexWithEllipsis: string): CborItem[] {
    const segments = hexWithEllipsis.split('...');
    const items: CborItem[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) items.push(new CborEllipsis());
      if (segments[i].length > 0) {
        items.push(new CborByteString(hexToBytes(segments[i])));
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
      if (items.length > 0 && this.t.peek().type === 'COMMA') {
        this.t.consume();
        if (this.t.peek().type === 'GT_GT') break; // trailing comma
      }
      items.push(this.parseValue());
    }
    this.expect('GT_GT');
    return new CborEmbeddedCBOR(items);
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
        this._warn(msg, eiTok);
        if (this._options.strict !== false) this._fail(msg, eiTok);
        eiTok = undefined;
      } else {
        encodingWidth = this._resolveEncodingWidth(eiTok.value, eiTok);
      }
    }
    // Rescue setup warnings before inner parseValue() calls drain them into child nodes.
    const setupWarnings = this._pendingWarnings.splice(0);
    const items: CborItem[] = [];
    while (this.t.peek().type !== 'RBRACKET') {
      if (items.length > 0 && this.t.peek().type === 'COMMA') {
        this.t.consume();
        if (this.t.peek().type === 'RBRACKET') break; // trailing comma
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
        this._warn(msg, eiTok);
        if (this._options.strict !== false) this._fail(msg, eiTok);
        eiTok = undefined;
      } else {
        encodingWidth = this._resolveEncodingWidth(eiTok.value, eiTok);
      }
    }
    // Rescue setup warnings before inner parseValue() calls drain them into child nodes.
    const setupWarnings = this._pendingWarnings.splice(0);
    const entries: [CborItem, CborItem][] = [];
    while (this.t.peek().type !== 'RBRACE') {
      if (entries.length > 0 && this.t.peek().type === 'COMMA') {
        this.t.consume();
        if (this.t.peek().type === 'RBRACE') break; // trailing comma
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
    | CborIndefiniteByteString
    | CborIndefiniteTextString {
    this.t.consume(); // (
    const next = this.t.peek();
    if (next.type === 'UNDERSCORE') {
      this.t.consume(); // _
    } else if (next.type === 'ENCODING_INDICATOR' && next.value === '7') {
      this.t.consume(); // _7 — alias for _, but non-standard
      const msg7 =
        'encoding indicator _7 is non-standard; use _ to indicate indefinite length';
      this._warn(msg7, next);
      if (this._options.strict !== false) this._fail(msg7, next);
    } else if (next.type === 'ENCODING_INDICATOR') {
      // _0–_6: not meaningful here; warn and drop, then parse chunks
      const tok = this.t.consume();
      const msg = `encoding indicator _${tok.value} is not valid in an indefinite string group; use _`;
      this._warn(msg, tok);
      if (this._options.strict !== false) this._fail(msg, tok);
    } else if (next.type !== 'RPAREN') {
      // No indicator at all — warn that _ is expected, then parse chunks
      const msg =
        'indefinite string group is missing _ after (; interpreting as (_ ...)';
      this._warn(msg, next);
      if (this._options.strict !== false) this._fail(msg, next);
      // Do not consume — the next token is the first chunk
    }

    // Rescue any warnings emitted above from _pendingWarnings before inner
    // parseValue() calls for each chunk drain them into the wrong node.
    const setupWarnings = this._pendingWarnings.splice(0);

    const chunks: CborItem[] = [];
    while (this.t.peek().type !== 'RPAREN') {
      if (chunks.length > 0 && this.t.peek().type === 'COMMA') {
        this.t.consume();
        if (this.t.peek().type === 'RPAREN') break; // trailing comma
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
   * Validates the indicator type (reserved/indefinite), and when `storedValue`
   * is supplied also checks that the value fits in the requested encoding width.
   */
  private consumeEncodingIndicator(
    storedValue?: bigint
  ): EncodingWidth | undefined {
    if (this.t.peek().type === 'ENCODING_INDICATOR') {
      const tok = this.t.consume();
      let ew = this._resolveEncodingWidth(tok.value, tok);
      if (ew !== undefined && storedValue !== undefined) {
        ew = this._validateEncodingFit(storedValue, ew, tok);
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
  private _validateEncodingFit(
    storedValue: bigint,
    ew: EncodingWidth,
    tok: Token
  ): EncodingWidth | undefined {
    const maxForWidth: Record<EncodingWidth, bigint> = {
      i: 23n,
      0: 0xffn,
      1: 0xffffn,
      2: 0xffff_ffffn,
      3: 0xffff_ffff_ffff_ffffn,
    };
    if (storedValue <= maxForWidth[ew]) return ew;
    const label =
      ew === 'i' ? '_i (max 23)' : `_${ew} (max ${maxForWidth[ew]})`;
    const msg = `value ${storedValue} does not fit in encoding indicator ${label}`;
    this._warn(msg, tok);
    if (this._options.strict !== false) this._fail(msg, tok);
    return undefined;
  }

  private _resolveEncodingWidth(
    raw: string,
    tok: Token
  ): EncodingWidth | undefined {
    if (raw === '4' || raw === '5' || raw === '6') {
      const ai = Number(raw) + 24; // 28, 29, or 30 — reserved in RFC 8949
      const msg = `encoding indicator _${raw} (AI ${ai}) is reserved and not valid`;
      this._warn(msg, tok);
      if (this._options.strict !== false) this._fail(msg, tok);
      return undefined;
    }
    if (raw === '7') {
      const msg =
        'indefinite-length encoding (_7) is not valid here; use [_ ...] or {_ ...} for indefinite collections';
      this._warn(msg, tok);
      if (this._options.strict !== false) this._fail(msg, tok);
      return undefined;
    }
    if (raw === 'i') return 'i';
    return Number(raw) as EncodingWidth; // '0'–'3' → 0–3
  }

  /** Builds the onError callback passed to extension parseAppString/parseAppSequence. */
  private _extOnError(tok: Token): (msg: string) => void {
    return (msg: string) => {
      this._warn(msg, tok);
      if (this._options.strict !== false) this._fail(msg, tok);
    };
  }

  private _warn(msg: string, tok?: Token): void {
    const warning: ParseWarning = { message: msg };
    if (tok !== undefined) {
      warning.offset = tok.offset;
      warning.line = tok.line;
      warning.column = tok.col;
    }
    this._pendingWarnings.push(warning);
    if (this._options.onWarning) {
      this._options.onWarning(warning);
    } else if (!this._options.silent) {
      const loc = tok ? ` at line ${tok.line}, column ${tok.col}` : '';
      console.warn(`CDN strict violation${loc}: ${msg}`);
    }
  }

  private _fail(msg: string, tok?: Token): never {
    const loc = tok ? ` at line ${tok.line}, column ${tok.col}` : '';
    throw new SyntaxError(`EDN parse error${loc}: ${msg}`);
  }
}
