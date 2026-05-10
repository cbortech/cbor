import {
  Tokenizer,
  type EdnComment,
  type Token,
  type TokenType,
} from './tokenizer';
import type { CborItem } from '../ast/CborItem';
import type { CborComment, FromEDNOptions, CborExtension } from '../types';
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
import { BUILTIN_EXTENSIONS } from '../extensions/builtins';
import { CborUnresolvedAppExt } from '../ast/CborUnresolvedAppExt';
import { CborEllipsis } from '../ast/CborEllipsis';
import { CborBigUint, CborBigNint } from '../ast/CborBignum';

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Parse a CBOR-EDN diagnostic notation string into a CborItem AST node.
 * Throws SyntaxError on invalid input.
 */
export function parseEDN(text: string, options?: FromEDNOptions): CborItem {
  const tokenizer = new Tokenizer(text, { offset: options?.offset });
  const parser = new EDNParser(
    tokenizer,
    options?.extensions,
    options?.unresolvedExtension,
    options?.allowInvalidUtf8,
    options?.allowTrailing
  );
  const node = parser.parse();
  if (options?.preserveComments) attachComments(node, tokenizer.comments, text);
  return node;
}

// ─── Value helpers ────────────────────────────────────────────────────────────

/** Strip an optional _0/_1/_2/_3/_i encoding-indicator suffix from a raw
 *  integer token value and return both the numeric string and the width. */
function parseIntegerRaw(raw: string): {
  numStr: string;
  encodingWidth: EncodingWidth | undefined;
} {
  let numStr = raw;
  let encodingWidth: EncodingWidth | undefined;
  if (/[_][0-3i]$/.test(raw)) {
    const suffix = raw[raw.length - 1]!;
    encodingWidth = suffix === 'i' ? 'i' : (Number(suffix) as EncodingWidth);
    numStr = raw.slice(0, -2);
  }
  return { numStr, encodingWidth };
}

function parseBigInt(raw: string): bigint {
  if (raw.startsWith('-')) return -BigInt(raw.slice(1));
  return BigInt(raw);
}

function parseFloatToken(raw: string): {
  value: number;
  precision: FloatPrecision | undefined;
} {
  if (raw === 'NaN') return { value: NaN, precision: undefined };
  if (raw === 'Infinity') return { value: Infinity, precision: undefined };
  if (raw === '-Infinity') return { value: -Infinity, precision: undefined };

  // _0 and _i are not valid encoding indicators for floating-point values
  // (floats use _1=half, _2=single, _3=double; _0 is 1-byte integer arg, _i is immediate)
  if (raw.endsWith('_i') || raw.endsWith('_0'))
    throw new SyntaxError(
      `EDN parse error: _0 and _i encoding indicators are not valid for floating-point values`
    );

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

function base32Decode(str: string, alpha: string): Uint8Array {
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
  if (bufBits > 0 && (buf & ((1 << bufBits) - 1)) !== 0)
    throw new SyntaxError('non-zero trailing bits in base32 input');
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  // Padding is optional but accepted per §5.2.2 ABNF
  // ("accommodates, but does not require base64 padding").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (Uint8Array as any).fromBase64 === 'function') {
    // Detect alphabet from content: base64url uses - or _
    const alphabet = /[-_]/.test(b64) ? 'base64url' : 'base64';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Uint8Array as any).fromBase64(b64, {
      alphabet,
      lastChunkHandling: 'loose',
    });
  }
  // Accept both base64 (+/) and base64url (-_) alphabets.
  // Add padding internally as needed for atob().
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
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

class EDNParser {
  /** Lookup from app-prefix → extension (user extensions override built-ins). */
  private readonly extByPrefix: Map<string, CborExtension>;
  /** Lookup from tag number → extension. */
  private readonly extByTag: Map<bigint, CborExtension>;

  private readonly unresolvedExtension: 'cpa999' | 'error';

  constructor(
    private readonly t: Tokenizer,
    userExtensions?: CborExtension[],
    unresolvedExtension?: 'cpa999' | 'error',
    private readonly allowInvalidUtf8?: boolean,
    private readonly allowTrailing?: boolean
  ) {
    this.extByPrefix = new Map();
    this.extByTag = new Map();
    this.unresolvedExtension = unresolvedExtension ?? 'cpa999';
    for (const ext of [...BUILTIN_EXTENSIONS, ...(userExtensions ?? [])]) {
      for (const prefix of ext.appStringPrefixes ?? [])
        this.extByPrefix.set(prefix, ext);
      for (const tag of ext.tagNumbers ?? []) this.extByTag.set(tag, ext);
    }
  }

  parse(): CborItem {
    const value = this.parseValue();
    if (this.allowTrailing) return value;
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
        return ext.parseAppString(tok.appPrefix!, tok.value);
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
        return seqExt.parseAppSequence(tok.appPrefix!, items);
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
    const { numStr, encodingWidth: embeddedEW } = parseIntegerRaw(tok.value);
    // Hex/octal/binary literals return before the suffix check in the tokenizer,
    // so their encoding indicator arrives as a separate ENCODING_INDICATOR token.
    const encodingWidth =
      embeddedEW !== undefined ? embeddedEW : this.consumeEncodingIndicator();
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
      const content = this.parseValue();
      this.expect('RPAREN');
      const tagNum = intNode.value;
      const ext = this.extByTag.get(tagNum);
      if (ext?.parseTag) {
        const result = ext.parseTag(tagNum, content);
        if (result !== undefined) return result;
      }
      return new CborTag(
        tagNum,
        content,
        encodingWidth !== undefined ? { encodingWidth } : undefined
      );
    }
    return intNode;
  }

  private parseFloat(): CborItem {
    const tok = this.t.consume(); // FLOAT
    const { value, precision } = parseFloatToken(tok.value);
    return new CborFloat(
      value,
      precision !== undefined ? { precision } : undefined
    );
  }

  private parseString(): CborItem {
    const tok = this.t.consume(); // STRING

    // Fast path: no concatenation
    if (this.t.peek().type !== 'PLUS') {
      const ew = this.consumeEncodingIndicator();
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
      const ew = this.consumeEncodingIndicator();
      return new CborTextString(
        parts.map((p) => ('text' in p ? p.text : '')).join(''),
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
    switch (tok.type) {
      case 'BYTES_HEX':
      case 'SQSTR':
        return hexToBytes(tok.value);
      case 'BYTES_B64':
        return base64ToBytes(tok.value);
      case 'BYTES_B32':
        return base32Decode(tok.value, B32_ALPHA);
      case 'BYTES_H32':
        return base32Decode(tok.value, H32_ALPHA);
      default:
        this._fail(`expected byte string token`, tok);
    }
  }

  private _decodeUtf8(bytes: Uint8Array, tok: Token): string {
    if (this.allowInvalidUtf8)
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      this._fail('byte string in text concatenation is not valid UTF-8', tok);
    }
  }

  private _tokenTypeToEdnEncoding(
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
      const ew = this.consumeEncodingIndicator();
      const ednEncoding = this._tokenTypeToEdnEncoding(firstType);
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
        // Text strings in a byte-leading concat are UTF-8 encoded (same as
        // single-quoted strings and text chunks in indefinite byte strings).
        this.t.consume();
        parts.push({ bytes: new TextEncoder().encode(next.value) });
      } else {
        this._fail(
          `expected byte string after +, got ${JSON.stringify(next.value)}`,
          next
        );
      }
    }

    if (!hasEllipsis) {
      const ew = this.consumeEncodingIndicator();
      const allBytes = parts.map((p) =>
        'bytes' in p ? p.bytes : new Uint8Array(0)
      );
      return new CborByteString(
        this._concatBytes(allBytes),
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
    if (this.t.peek().type === 'UNDERSCORE') {
      this.t.consume();
      indefiniteLength = true;
    } else if (this.t.peek().type === 'ENCODING_INDICATOR') {
      const v = this.t.consume().value;
      encodingWidth = v === 'i' ? 'i' : (Number(v) as EncodingWidth);
    }
    const items: CborItem[] = [];
    while (this.t.peek().type !== 'RBRACKET') {
      if (items.length > 0 && this.t.peek().type === 'COMMA') {
        this.t.consume();
        if (this.t.peek().type === 'RBRACKET') break; // trailing comma
      }
      items.push(this.parseValue());
    }
    this.expect('RBRACKET');
    return new CborArray(items, { indefiniteLength, encodingWidth });
  }

  private parseMap(): CborMap {
    this.t.consume(); // {
    let indefiniteLength = false;
    let encodingWidth: EncodingWidth | undefined;
    if (this.t.peek().type === 'UNDERSCORE') {
      this.t.consume();
      indefiniteLength = true;
    } else if (this.t.peek().type === 'ENCODING_INDICATOR') {
      const v = this.t.consume().value;
      encodingWidth = v === 'i' ? 'i' : (Number(v) as EncodingWidth);
    }
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
    return new CborMap(entries, { indefiniteLength, encodingWidth });
  }

  /** Parses `(_ chunk, chunk, ...)` — indefinite byte or text string. */
  private parseIndefGroup():
    | CborIndefiniteByteString
    | CborIndefiniteTextString {
    this.t.consume(); // (
    const us = this.t.peek();
    if (us.type !== 'UNDERSCORE')
      this._fail(`expected _ after (, got ${JSON.stringify(us.value)}`, us);
    this.t.consume(); // _

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
      return new CborIndefiniteByteString(byteChunks);
    }
    if (first instanceof CborTextString) {
      const textChunks = chunks.map((c, i) => {
        if (c instanceof CborTextString) return c;
        this._fail(
          `indefinite text string chunk ${i} must be a text string, not a byte string`
        );
      });
      return new CborIndefiniteTextString(textChunks);
    }
    this._fail('indefinite group chunks must be byte strings or text strings');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Consume an ENCODING_INDICATOR token if present, returning the width. */
  private consumeEncodingIndicator(): EncodingWidth | undefined {
    if (this.t.peek().type === 'ENCODING_INDICATOR') {
      const v = this.t.consume().value;
      return v === 'i' ? 'i' : (Number(v) as EncodingWidth);
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

  private _fail(msg: string, tok?: Token): never {
    const loc = tok ? ` at line ${tok.line}, column ${tok.col}` : '';
    throw new SyntaxError(`EDN parse error${loc}: ${msg}`);
  }
}
