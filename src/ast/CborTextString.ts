import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_TEXT } from '../cbor/constants';
import type { CborWriter, EncodingWidth } from '../cbor/encode';
import { parseCDN } from '../cdn/parser';
// Internal lexer reuse: parseCDN() validates embedded CDN first; this pass
// only needs token offsets so string formatting can split without changing text.
import { Tokenizer, type TokenType } from '../cdn/tokenizer';
import {
  escapeString,
  indentOf,
  resolveIndent,
  resolveEiSuffix,
  canonicalEncodingWidth,
} from '../cdn/serialize-utils';

const textEncoder = new TextEncoder();
let didWarnCborEdnTextStringFormat = false;

/** CBOR Major Type 3 — definite-length UTF-8 text string. */
export class CborTextString extends CborItem {
  readonly indefiniteLength = false as const;
  readonly value: string;
  encodingWidth: EncodingWidth | undefined;
  /** Part boundaries of the original `+` concatenation chain, if any. */
  readonly ednParts: readonly string[] | undefined;

  constructor(
    value: string,
    options?: {
      encodingWidth?: EncodingWidth;
      ednParts?: readonly string[];
    }
  ) {
    super();
    this.value = value;
    this.encodingWidth = options?.encodingWidth;
    this.ednParts = options?.ednParts;
  }

  override _encodeTo(writer: CborWriter, _options?: ToCBOROptions): void {
    writer.writeTextString(MT_TEXT, this.value, this.encodingWidth);
  }

  _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
      canonicalEncodingWidth(BigInt(textEncoder.encode(this.value).length))
    );
    return formatTextString(this.value, suffix, options, depth, this.ednParts);
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this.value;
  }
}

function formatTextString(
  value: string,
  suffix: string,
  options: ToCDNOptions | undefined,
  depth: number,
  ednParts: readonly string[] | undefined
): string {
  const { cdn, newline } = resolveTextStringSplits(options);
  const indentStr = resolveIndent(options);
  const preservedParts =
    options?.preserveConcatenation &&
    ednParts !== undefined &&
    ednParts.length > 1
      ? ednParts
      : undefined;

  if (indentStr === null) {
    if (preservedParts !== undefined) {
      return emitParts(
        preservedParts.map((text) => ({ text, contentDepth: 0 })),
        suffix,
        null,
        depth
      );
    }
    return escapeString(value) + suffix;
  }
  if (!cdn && !newline && preservedParts === undefined) {
    return escapeString(value) + suffix;
  }

  const cdnBreakpoints = cdn ? collectCdnBreakpoints(value) : null;

  // Preserved concatenation applies unless CDN reflow is applicable (the
  // string content parses as CDN — then structure-aware indentation wins).
  // `splitNewline` combines with it by further splitting the parts.
  if (cdnBreakpoints === null && preservedParts !== undefined) {
    const parts: StringPart[] = [];
    for (const text of preservedParts) {
      if (newline) {
        const partBreakpoints = new Map<number, number>();
        for (const { point, contentDepth } of collectNewlineBreakpoints(
          text,
          0
        )) {
          partBreakpoints.set(point, contentDepth);
        }
        parts.push(...splitAtBreakpoints(text, partBreakpoints));
      } else {
        parts.push({ text, contentDepth: 0 });
      }
    }
    return emitParts(parts, suffix, indentStr, depth);
  }

  const breakpoints = new Map<number, number>();
  if (cdnBreakpoints !== null) {
    for (const { point, contentDepth } of cdnBreakpoints) {
      breakpoints.set(point, contentDepth);
    }
  }
  if (newline) {
    const newlineBreakpoints =
      cdnBreakpoints !== null
        ? collectCdnNewlineBreakpoints(value)
        : collectNewlineBreakpoints(value, 0);
    for (const { point, contentDepth } of newlineBreakpoints) {
      if (!breakpoints.has(point)) {
        breakpoints.set(point, contentDepth);
      }
    }
  }

  const parts = splitAtBreakpoints(value, breakpoints);
  if (parts.length <= 1) return escapeString(value) + suffix;
  return emitParts(parts, suffix, indentStr, depth);
}

/**
 * Serialize string parts as a `+` concatenation chain: one line when indent
 * is disabled, otherwise one part per continuation line indented by
 * `depth + 1 + contentDepth`.  The EI suffix is appended to the last part.
 */
function emitParts(
  parts: readonly StringPart[],
  suffix: string,
  indentStr: string | null,
  depth: number
): string {
  const literals = parts.map(({ text }, i) => {
    const literal = escapeString(text);
    return i === parts.length - 1 ? literal + suffix : literal;
  });
  if (indentStr === null) return literals.join(' + ');
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

/**
 * Resolve the effective split strategies from `splitCdn` / `splitNewline`,
 * falling back per-field to the deprecated array-valued `textStringFormat`.
 */
function resolveTextStringSplits(options: ToCDNOptions | undefined): {
  cdn: boolean;
  newline: boolean;
} {
  const formats =
    options?.splitCdn === undefined || options?.splitNewline === undefined
      ? normalizeTextStringFormats(options?.textStringFormat ?? [])
      : [];
  return {
    cdn: options?.splitCdn ?? formats.includes('cdn'),
    newline: options?.splitNewline ?? formats.includes('newline'),
  };
}

function normalizeTextStringFormats(
  formats: NonNullable<ToCDNOptions['textStringFormat']>
): ('newline' | 'cdn')[] {
  return formats.map((format) => {
    if (format !== 'cboredn') return format;
    if (!didWarnCborEdnTextStringFormat) {
      didWarnCborEdnTextStringFormat = true;
      console.warn(
        "`textStringFormat: ['cboredn']` is deprecated; use `textStringFormat: ['cdn']` instead."
      );
    }
    return 'cdn';
  });
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

function collectCdnBreakpoints(value: string): StringBreakpoint[] | null {
  try {
    parseCDN(value);
  } catch {
    return null;
  }

  // The parse above validates structure. This second tokenizer pass only
  // collects original-source offsets and nesting depth for non-mutating splits.
  const points: StringBreakpoint[] = [];
  const tokenizer = new Tokenizer(value);
  let nesting = 0;
  let pending: {
    point: number;
    contentDepth: number;
    kind: 'opener' | 'comma';
  } | null = null;
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
      if (pending.kind === 'opener' && OPENER_MODIFIER_TOKENS.has(token.type)) {
        pending.point = token.endOffset;
        lastTokenEnd = token.endOffset;
        continue;
      } else if (
        pending.kind === 'opener' &&
        CLOSE_TOKENS.has(token.type) &&
        hasOnlyWhitespaceBetween(value, pending.point, token.offset)
      ) {
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
      pending = {
        point: token.endOffset,
        contentDepth: nesting,
        kind: 'opener',
      };
    } else if (CLOSE_TOKENS.has(token.type)) {
      nesting = Math.max(0, nesting - 1);
      if (!skipClosePoint) {
        points.push({ point: token.offset, contentDepth: nesting });
      }
    } else if (token.type === 'COMMA') {
      pending = {
        point: token.endOffset,
        contentDepth: nesting,
        kind: 'comma',
      };
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

function collectCdnNewlineBreakpoints(value: string): StringBreakpoint[] {
  const points: StringBreakpoint[] = [];
  const tokenizer = new Tokenizer(value);
  let nesting = 0;
  for (;;) {
    const token = tokenizer.consume();
    if (token.type === 'EOF') break;

    if (OPEN_TOKENS.has(token.type)) {
      nesting++;
    } else if (CLOSE_TOKENS.has(token.type)) {
      nesting = Math.max(0, nesting - 1);
    } else if (token.type === 'COMMA') {
      // Commas can create structural split points, but never contain newline
      // split points themselves.
    } else if (token.type === 'TSTR') {
      // TSTR uses escape sequences (\n, \r) for newlines in addition to
      // literal newline characters.
      const tokenText = value.slice(token.offset, token.endOffset);
      for (const point of collectTstrNewlineBreakpoints(tokenText)) {
        points.push({ point: token.offset + point, contentDepth: nesting + 1 });
      }
    } else if (token.type === 'RAWSTRING') {
      // RAWSTRING has no escape sequences; only literal newlines apply.
      const tokenText = value.slice(token.offset, token.endOffset);
      for (const { point } of collectNewlineBreakpoints(tokenText, 0)) {
        points.push({ point: token.offset + point, contentDepth: nesting + 1 });
      }
    }
  }
  return points;
}

// Scans the raw source of a CDN double-quoted string (TSTR) for newline
// escape sequences (\n, \r) and literal newline characters, returning the
// position within tokenText immediately after each such sequence.
function collectTstrNewlineBreakpoints(tokenText: string): number[] {
  const points: number[] = [];
  let i = 1; // skip opening "
  const end = tokenText.length - 1; // stop before closing "
  while (i < end) {
    const ch = tokenText[i];
    if (ch === '\\') {
      const next = tokenText[i + 1];
      if (next === 'n' || next === 'r') {
        points.push(i + 2);
        i += 2;
      } else if (next === 'u') {
        if (tokenText[i + 2] === '{') {
          const close = tokenText.indexOf('}', i + 3);
          i = close >= 0 ? close + 1 : i + 2;
        } else {
          i += 6; // \uXXXX
        }
      } else {
        i += 2; // \\, \", \t, etc.
      }
    } else if (ch === '\r') {
      if (tokenText[i + 1] === '\n') {
        points.push(i + 2);
        i += 2;
      } else {
        points.push(i + 1);
        i++;
      }
    } else if (ch === '\n') {
      points.push(i + 1);
      i++;
    } else {
      i++;
    }
  }
  return points;
}

const OPENER_MODIFIER_TOKENS = new Set<TokenType>([
  'ENCODING_INDICATOR',
  'UNDERSCORE',
]);

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

function hasOnlyWhitespaceBetween(
  value: string,
  start: number,
  end: number
): boolean {
  return /^[\t\n\r ]*$/.test(value.slice(start, end));
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
