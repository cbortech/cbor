import type { ToEDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_TEXT } from '../cbor/constants';
import { writeHead, concat, type EncodingWidth } from '../cbor/encode';
import { parseEDN } from '../edn/parser';
// Internal lexer reuse: parseEDN() validates embedded CBOR-EDN first; this pass
// only needs token offsets so string formatting can split without changing text.
import { Tokenizer, type TokenType } from '../edn/tokenizer';
import { escapeString, indentOf, resolveIndent } from '../edn/serialize-utils';

const textEncoder = new TextEncoder();

/** CBOR Major Type 3 — definite-length UTF-8 text string. */
export class CborTextString extends CborItem {
  readonly indefiniteLength = false as const;
  readonly value: string;
  readonly encodingWidth: EncodingWidth | undefined;

  constructor(value: string, options?: { encodingWidth?: EncodingWidth }) {
    super();
    this.value = value;
    this.encodingWidth = options?.encodingWidth;
  }

  _toCBOR(_options?: ToCBOROptions): Uint8Array {
    const encoded = textEncoder.encode(this.value);
    return concat([
      writeHead(MT_TEXT, BigInt(encoded.length), this.encodingWidth),
      encoded,
    ]);
  }

  _toEDN(options: ToEDNOptions | undefined, depth: number): string {
    const suffix =
      this.encodingWidth !== undefined ? `_${this.encodingWidth}` : '';
    return formatTextString(this.value, suffix, options, depth);
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this.value;
  }
}

function formatTextString(
  value: string,
  suffix: string,
  options: ToEDNOptions | undefined,
  depth: number
): string {
  const formats = options?.textStringFormat ?? [];
  const indentStr = resolveIndent(options);
  if (formats.length === 0 || indentStr === null) {
    return escapeString(value) + suffix;
  }

  const breakpoints = new Map<number, number>();
  if (formats.includes('cboredn')) {
    const cborednBreakpoints = collectCborEdnBreakpoints(value);
    if (cborednBreakpoints !== null) {
      for (const { point, contentDepth } of cborednBreakpoints) {
        breakpoints.set(point, contentDepth);
      }
    }
  }
  if (formats.includes('newline') && breakpoints.size === 0) {
    for (const { point, contentDepth } of collectNewlineBreakpoints(value, 0)) {
      breakpoints.set(point, contentDepth);
    }
  }

  const parts = splitAtBreakpoints(value, breakpoints);
  if (parts.length <= 1) return escapeString(value) + suffix;

  const literals = parts.map(({ text }, i) => {
    const literal = escapeString(text);
    return i === parts.length - 1 ? literal + suffix : literal;
  });
  let result = literals[0]!;
  for (let i = 1; i < literals.length; i++) {
    const continuationIndent = indentOf(
      indentStr,
      depth + 1 + parts[i]!.contentDepth
    );
    result += ` +\n${continuationIndent}${literals[i]}`;
  }
  return result;
}

interface StringBreakpoint {
  point: number;
  contentDepth: number;
}

interface StringPart {
  text: string;
  contentDepth: number;
}

function collectNewlineBreakpoints(
  value: string,
  contentDepth: number
): StringBreakpoint[] {
  const points: StringBreakpoint[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\r') {
      if (value[i + 1] === '\n') {
        points.push({ point: i + 2, contentDepth });
        i++;
      } else {
        points.push({ point: i + 1, contentDepth });
      }
    } else if (ch === '\n') {
      points.push({ point: i + 1, contentDepth });
    }
  }
  return points;
}

function collectCborEdnBreakpoints(value: string): StringBreakpoint[] | null {
  try {
    parseEDN(value);
  } catch {
    return null;
  }

  // The parse above validates structure. This second tokenizer pass only
  // collects original-source offsets and nesting depth for non-mutating splits.
  const points: StringBreakpoint[] = [];
  const tokenizer = new Tokenizer(value);
  let nesting = 0;
  let pending: { point: number; contentDepth: number } | null = null;
  let sawToken = false;
  let lastTokenEnd = 0;
  for (;;) {
    const token = tokenizer.consume();
    if (token.type === 'EOF') break;
    let skipClosePoint = false;

    if (!sawToken) {
      sawToken = true;
      if (
        token.offset > 0 &&
        hasCommentBetween(tokenizer.comments, 0, token.offset)
      ) {
        points.push({ point: token.offset, contentDepth: nesting });
      }
    }

    // After an opener/comma, split before the next token so intervening layout
    // whitespace stays at the end of the previous chunk.
    if (pending !== null) {
      if (CLOSE_TOKENS.has(token.type) && token.offset === pending.point) {
        skipClosePoint = true;
      } else {
        points.push({
          point: token.offset,
          contentDepth: pending.contentDepth,
        });
      }
      pending = null;
    }

    if (OPEN_TOKENS.has(token.type)) {
      nesting++;
      pending = { point: token.endOffset, contentDepth: nesting };
    } else if (CLOSE_TOKENS.has(token.type)) {
      nesting = Math.max(0, nesting - 1);
      if (!skipClosePoint) {
        points.push({ point: token.offset, contentDepth: nesting });
      }
    } else if (token.type === 'COMMA') {
      pending = { point: token.endOffset, contentDepth: nesting };
    }
    lastTokenEnd = token.endOffset;
  }

  const trailingComment = tokenizer.comments.find(
    (comment) => comment.start >= lastTokenEnd
  );
  if (trailingComment !== undefined) {
    points.push({ point: trailingComment.start, contentDepth: nesting });
  }
  return points;
}

const OPEN_TOKENS = new Set<TokenType>([
  'LBRACKET',
  'LBRACE',
  'LPAREN',
  'LT_LT',
]);

const CLOSE_TOKENS = new Set<TokenType>([
  'RBRACKET',
  'RBRACE',
  'RPAREN',
  'GT_GT',
]);

function hasCommentBetween(
  comments: readonly { start: number; end: number }[],
  start: number,
  end: number
): boolean {
  // Comments use half-open source ranges; this checks for comments wholly
  // contained in [start, end), including one that ends exactly at `end`.
  return comments.some(
    (comment) => comment.start >= start && comment.end <= end
  );
}

function splitAtBreakpoints(
  value: string,
  breakpoints: Map<number, number>
): StringPart[] {
  const points = [...breakpoints]
    .filter(([point]) => point > 0 && point < value.length)
    .sort(([a], [b]) => a - b);
  if (points.length === 0) return [{ text: value, contentDepth: 0 }];

  const parts: StringPart[] = [];
  let start = 0;
  let contentDepth = 0;
  for (const [point, nextContentDepth] of points) {
    if (point === start) continue;
    parts.push({ text: value.slice(start, point), contentDepth });
    start = point;
    contentDepth = nextContentDepth;
  }
  if (start < value.length) {
    parts.push({ text: value.slice(start), contentDepth });
  }
  return parts;
}
