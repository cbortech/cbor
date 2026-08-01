import type {
  ToCDNOptions,
  ToJSOptions,
  ToCBOROptions,
  CborComment,
} from '../types';
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
  danglingCommentsByGap,
  pushAll,
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
  /** Original raw-string source text, when parsed from a single backtick literal. */
  readonly ednSource: string | undefined;
  /**
   * Original double-quoted source text (including its escape sequences),
   * when parsed from a single non-concatenated `"..."` literal. Used by
   * `_toCDN()` to round-trip the literal's exact spelling when
   * `preserveTextString` is set.
   */
  readonly quotedEdnSource: string | undefined;
  /**
   * Original source text per `ednParts` entry, aligned by index; `undefined`
   * for parts that were not raw backtick literals.
   */
  readonly ednPartSources: readonly (string | undefined)[] | undefined;
  /**
   * `true` at index `i`, aligned with `ednParts`, when that part came from a
   * byte-string literal on the right of a text-leading `+` concatenation
   * (decoded as UTF-8 and merged in per §5.1) rather than a double-quoted
   * `"..."` literal. Both cases leave `ednPartSources[i]` `undefined` (byte
   * strings have no preserved raw source here, same as an unpreserved
   * double-quoted literal), so this is what lets `appSeqSourceFeatures`
   * attribute the part to `byteString` instead of the unpreservable
   * `textString`.
   */
  readonly ednPartIsByteString: readonly boolean[] | undefined;
  /**
   * Source span of each `ednParts` entry's own literal token, aligned by
   * index — used to place a comment sitting between two `+`-joined parts at
   * the right gap instead of dropping it (there is no per-part AST node for
   * such a comment to attach to; it lands as `dangling` on this whole node
   * instead — see `CborByteString.ednParts`'s equivalent doc). `undefined`
   * for a node not parsed from a `+` chain at all.
   */
  readonly ednPartSpans: readonly { start: number; end: number }[] | undefined;

  constructor(
    value: string,
    options?: {
      encodingWidth?: EncodingWidth;
      ednParts?: readonly string[];
      ednSource?: string;
      quotedEdnSource?: string;
      ednPartSources?: readonly (string | undefined)[];
      ednPartIsByteString?: readonly boolean[];
      ednPartSpans?: readonly { start: number; end: number }[];
    }
  ) {
    super();
    this.value = value;
    this.encodingWidth = options?.encodingWidth;
    this.ednParts = options?.ednParts;
    this.ednSource = options?.ednSource;
    this.quotedEdnSource = options?.quotedEdnSource;
    this.ednPartSources = options?.ednPartSources;
    this.ednPartIsByteString = options?.ednPartIsByteString;
    this.ednPartSpans = options?.ednPartSpans;
  }

  override _encodeTo(writer: CborWriter, _options?: ToCBOROptions): void {
    writer.writeTextString(MT_TEXT, this.value, this.encodingWidth);
  }

  _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
      canonicalEncodingWidth(BigInt(textEncoder.encode(this.value).length))
    );
    return formatTextString(
      this.value,
      suffix,
      options,
      depth,
      this.ednParts,
      this.ednSource,
      this.quotedEdnSource,
      this.ednPartSources,
      this.ednPartSpans,
      this.comments?.dangling
    );
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
  ednParts: readonly string[] | undefined,
  ednSource: string | undefined,
  quotedEdnSource: string | undefined,
  ednPartSources: readonly (string | undefined)[] | undefined,
  ednPartSpans: readonly { start: number; end: number }[] | undefined,
  dangling: readonly CborComment[] | undefined
): string {
  const indentStr = resolveIndent(options);
  // A preserved raw backtick literal is emitted verbatim — re-escaping,
  // re-indenting, or splitting it would change its meaning or its
  // deliberately chosen form. In single-line mode a spelling that spans
  // multiple lines (raw strings are often written that way) cannot be
  // re-emitted, so it falls back to normal escaping instead.
  if (
    options?.preserveRawString &&
    ednSource !== undefined &&
    (indentStr !== null || !/[\r\n]/.test(ednSource))
  ) {
    return ednSource + suffix;
  }
  // Likewise for a preserved double-quoted literal: keep its original
  // escape-sequence spelling instead of re-escaping the decoded value.
  if (
    options?.preserveTextString &&
    quotedEdnSource !== undefined &&
    (indentStr !== null || !/[\r\n]/.test(quotedEdnSource))
  ) {
    return quotedEdnSource + suffix;
  }
  // Splits and preserved concatenation are layout features, disabled in
  // single-line mode: the string collapses to one literal.
  if (indentStr === null) {
    return escapeString(value) + suffix;
  }
  const partSources = options?.preserveRawString ? ednPartSources : undefined;
  const hasPreservedRawPart =
    partSources?.some((source) => source !== undefined) ?? false;
  const { cdn, newline } = resolveTextStringSplits(options);
  const preservedParts =
    options?.preserveConcatenation &&
    ednParts !== undefined &&
    (ednParts.length > 1 || hasPreservedRawPart)
      ? ednParts
      : undefined;

  if (!cdn && !newline && preservedParts === undefined) {
    return escapeString(value) + suffix;
  }

  const cdnBreakpoints = cdn
    ? collectCdnBreakpoints(value, !!options?.inlineLeafContainers, newline)
    : null;

  // Preserved concatenation applies unless CDN reflow is applicable (the
  // string content parses as CDN — then structure-aware indentation wins).
  // A preserved raw part takes precedence over CDN reflow because changing
  // its spelling would violate preserveRawString. `splitNewline` combines
  // with this path by further splitting only the non-raw parts.
  if (
    preservedParts !== undefined &&
    (cdnBreakpoints === null || hasPreservedRawPart)
  ) {
    // A comment between two `+`-joined parts has no per-part AST node of
    // its own to attach to — it lands as `dangling` on this whole node
    // instead (see `ednPartSpans`'s doc) — so re-derive which gap each one
    // belongs to from each part's own source span.
    const gapComments = options?.preserveComments
      ? danglingCommentsByGap(
          dangling,
          ednPartSpans,
          typeof options.preserveComments === 'string'
            ? options.preserveComments
            : undefined
        )
      : undefined;
    const parts: StringPart[] = [];
    for (const [i, text] of preservedParts.entries()) {
      const source = partSources?.[i];
      if (source !== undefined) {
        parts.push({ text, contentDepth: 0, source });
      } else if (newline) {
        const partBreakpoints = new Map<number, number>();
        for (const { point, contentDepth } of collectNewlineBreakpoints(
          text,
          0
        )) {
          partBreakpoints.set(point, contentDepth);
        }
        pushAll(parts, splitAtBreakpoints(text, partBreakpoints));
      } else {
        parts.push({ text, contentDepth: 0 });
      }
      // Whichever output part `text` ended up split into, the comment for
      // the gap right after it (if any) belongs on the last one — the true
      // `+` boundary to the next preserved part sits right there.
      const comments = gapComments?.[i];
      if (comments && comments.length > 0) {
        parts[parts.length - 1]!.commentsAfter = comments;
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
 * Serialize string parts as a `+` concatenation chain, one part per
 * continuation line indented by `depth + 1 + contentDepth`.  The EI suffix
 * is appended to the last part. Only reached in multi-line mode — preserved
 * concatenation is disabled in single-line output.
 */
function emitParts(
  parts: readonly StringPart[],
  suffix: string,
  indentStr: string,
  depth: number
): string {
  const literals = parts.map(({ text, source }, i) => {
    const literal = source ?? escapeString(text);
    return i === parts.length - 1 ? literal + suffix : literal;
  });
  let result = literals[0]!;
  for (let i = 1; i < literals.length; i++) {
    const continuationIndent = indentOf(
      indentStr,
      depth + 1 + parts[i]!.contentDepth
    );
    result += ' +\n';
    for (const comment of parts[i - 1]!.commentsAfter ?? []) {
      result += `${continuationIndent}${comment}\n`;
    }
    result += `${continuationIndent}${literals[i]}`;
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
  /** Preserved literal source; emitted verbatim instead of escaping `text`. */
  source?: string;
  /**
   * Already-converted comment text that sat right after this part in the
   * source — a genuine `+` boundary this part precedes, not a further split
   * of the same original preserved part — emitted by `emitParts` right
   * before the next part.
   */
  commentsAfter?: string[];
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

function collectCdnBreakpoints(
  value: string,
  inlineLeafContainers: boolean,
  newline: boolean
): StringBreakpoint[] | null {
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
  // The token immediately before the current one (ignoring the EOF/first
  // iteration), used only to tell an integer-tag's `(` (`100(2)`) apart
  // from an indefinite-length string group's `(` (`(_ "a", "b")`) — both
  // tokenize as a bare LPAREN.
  let prevType: TokenType | null = null;

  // Mirrors serializeContainer's `inlineLeafContainers` probe on the real
  // AST, but over token spans instead of rendered strings: a bracket's own
  // breakpoints are held in `ownCandidates` until it closes, then either
  // discarded (stays on one line) or merged into the parent frame (or
  // `points`, at depth 0). Breakpoints inherited from a child that itself
  // couldn't be fully suppressed live separately in `childCandidates` —
  // those are never discardable no matter what this frame decides for its
  // own brackets (see the tag-paren case below), so they always forward.
  //
  // - LBRACKET/LBRACE (array/map) use the strict rule — no entry may
  //   contain a nested array/map at any depth (`entryHasContainer`, set on
  //   every currently-open frame so it reaches ancestors through wrapper
  //   brackets), matching `_containsCdnContainer`.
  // - LT_LT (embedded CBOR) and APP_SEQUENCE (`prefix<<...>>`) use the
  //   loose rule: an entry only has to render without a break of its own
  //   (`entryForcedBreak`), regardless of what it contains — matching
  //   CborEmbeddedCBOR's `entryIsLeaf`-less probe. Resolved app-sequence
  //   extensions vary in how they render, but this is the closest
  //   approximation without invoking the parser's extension resolution.
  // - LPAREN as an indefinite-length string group (`(_ ...)` /
  //   `CborIndefiniteTextString`/`ByteString`) also uses the loose rule.
  // - LPAREN as tag content (`100(2)`) has its *own* `(`/`)` breakpoints
  //   unconditionally suppressed (once `inlineLeafContainers` is on)
  //   regardless of `allOk`: real `CborTag` wraps its content with bare
  //   parens (`renderSingleChildWithComments`) that never add their own
  //   line break, even when the content itself renders multi-line — only
  //   a comment forces it. But content that itself required real breaks
  //   (e.g. `100([[1, 2], [3, 4]])`) still needs those breaks to show up
  //   and to keep propagating outward — that's exactly what
  //   `childCandidates` carries regardless of this frame's own decision.
  //
  // `entryForcedBreak` is only ever set on the immediate parent frame (not
  // eagerly on every ancestor like `entryHasContainer`): forwarding a
  // frame's breakpoints (own, child-inherited, or both) always marks the
  // parent's current entry forced, which in turn forwards *its* parent's
  // entry when it closes — so it cascades upward one level at a time.
  // `anyForcedBreak` is the same signal, but never reset between entries —
  // needed because a tag-paren frame ignores `entryForcedBreak`/`allOk`
  // for its *own* suppression (its parens stay tight either way), yet
  // still must tell its parent a break happened somewhere inside, even
  // when that break produced no breakpoint of its own to carry the
  // signal (e.g. a `splitNewline` break inside a nested string — the
  // actual breakpoint for that is added by a separate pass entirely).
  interface CdnFrame {
    kind: TokenType;
    isTagParen: boolean;
    openOffset: number;
    ownCandidates: StringBreakpoint[];
    childCandidates: StringBreakpoint[];
    entryHasContainer: boolean;
    entryForcedBreak: boolean;
    anyForcedBreak: boolean;
    allOk: boolean;
  }
  const stack: CdnFrame[] = [];

  const emit = (point: number, contentDepth: number): void => {
    const top = stack[stack.length - 1];
    if (top) top.ownCandidates.push({ point, contentDepth });
    else points.push({ point, contentDepth });
  };

  const isLooseFrame = (frame: CdnFrame): boolean =>
    frame.kind === 'LT_LT' ||
    frame.kind === 'APP_SEQUENCE' ||
    (frame.kind === 'LPAREN' && !frame.isTagParen);

  // Folds the entry that just ended (at a comma, or at the closing
  // bracket) into the frame's running "can this stay on one line" verdict,
  // then resets the per-entry flags for the next entry. Tag-paren frames
  // never gate their own suppression on this — see the class comment
  // above — but `anyForcedBreak` still accumulates for them.
  const foldEntry = (frame: CdnFrame): void => {
    const ok = isLooseFrame(frame)
      ? !frame.entryForcedBreak
      : !frame.entryHasContainer && !frame.entryForcedBreak;
    frame.allOk = frame.allOk && ok;
    frame.anyForcedBreak = frame.anyForcedBreak || frame.entryForcedBreak;
    frame.entryHasContainer = false;
    frame.entryForcedBreak = false;
  };

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
        emit(token.offset, nesting);
      }
    }

    // After an opener/comma, split before the next token so intervening layout
    // whitespace stays at the end of the previous chunk.
    if (pending !== null) {
      if (pending.kind === 'opener' && OPENER_MODIFIER_TOKENS.has(token.type)) {
        pending.point = token.endOffset;
        prevType = token.type;
        lastTokenEnd = token.endOffset;
        continue;
      } else if (
        pending.kind === 'opener' &&
        CLOSE_TOKENS.has(token.type) &&
        hasOnlyWhitespaceBetween(value, pending.point, token.offset)
      ) {
        skipClosePoint = true;
      } else {
        emit(token.offset, pending.contentDepth);
      }
      pending = null;
    }

    if (OPEN_TOKENS.has(token.type)) {
      if (token.type === 'LBRACKET' || token.type === 'LBRACE') {
        // A nested array/map disqualifies every ancestor's current entry
        // from the strict leaf rule, no matter how deep it sits.
        for (const frame of stack) frame.entryHasContainer = true;
      }
      nesting++;
      pending = {
        point: token.endOffset,
        contentDepth: nesting,
        kind: 'opener',
      };
      stack.push({
        kind: token.type,
        isTagParen: token.type === 'LPAREN' && prevType === 'INTEGER',
        openOffset: token.offset,
        ownCandidates: [],
        childCandidates: [],
        entryHasContainer: false,
        entryForcedBreak: false,
        anyForcedBreak: false,
        allOk: true,
      });
    } else if (CLOSE_TOKENS.has(token.type)) {
      nesting = Math.max(0, nesting - 1);
      if (!skipClosePoint) {
        emit(token.offset, nesting);
      }
      const frame = stack.pop();
      if (frame) {
        foldEntry(frame);
        const isTag = frame.kind === 'LPAREN' && frame.isTagParen;
        const suppressible =
          inlineLeafContainers &&
          (isTag ||
            frame.kind === 'LBRACKET' ||
            frame.kind === 'LBRACE' ||
            isLooseFrame(frame));
        const suppressOwn =
          suppressible &&
          frame.ownCandidates.length > 0 &&
          (isTag || frame.allOk) &&
          !hasCommentBetween(
            tokenizer.comments,
            frame.openOffset,
            token.endOffset
          );
        // Child-inherited breakpoints always forward, regardless of what
        // this frame decided for its own brackets — they represent breaks
        // some descendant already determined were unavoidable.
        const forwarded = suppressOwn
          ? frame.childCandidates
          : [...frame.ownCandidates, ...frame.childCandidates];
        const parent = stack[stack.length - 1];
        // Looped rather than `push(...forwarded)`: spreading a huge array
        // as call arguments can exceed the engine's argument-count limit
        // (a ~130k-item CDN array reproduces a RangeError here).
        if (parent) {
          for (const candidate of forwarded) {
            parent.childCandidates.push(candidate);
          }
          // Even when nothing here produced a breakpoint of its own to
          // carry forward (a suppressed tag paren whose content still had
          // a forced break somewhere inside it), the break itself still
          // happened and still needs to reach the parent.
          if (forwarded.length > 0 || frame.anyForcedBreak) {
            parent.entryForcedBreak = true;
          }
        } else {
          for (const candidate of forwarded) {
            points.push(candidate);
          }
        }
      }
    } else if (token.type === 'COMMA') {
      const top = stack[stack.length - 1];
      if (top) foldEntry(top);
      pending = {
        point: token.endOffset,
        contentDepth: nesting,
        kind: 'comma',
      };
    } else if (
      newline &&
      (token.type === 'TSTR' || token.type === 'RAWSTRING')
    ) {
      // A literal/escaped newline inside this token will itself become a
      // breakpoint once `splitNewline` runs (merged in by the caller,
      // outside this function) — that forces this entry's own rendering
      // to contain a line break, exactly like a child bracket that
      // couldn't be suppressed. Mirrors serializeContainer's `s.includes
      // ('\n')` check on a rendered entry.
      const tokenText = value.slice(token.offset, token.endOffset);
      const hasNewline =
        token.type === 'TSTR'
          ? collectTstrNewlineBreakpoints(tokenText).length > 0
          : collectNewlineBreakpoints(tokenText, 0).length > 0;
      if (hasNewline) {
        const top = stack[stack.length - 1];
        if (top) top.entryForcedBreak = true;
      }
    }
    prevType = token.type;
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
  // `prefix<<` (app-sequence) is tokenized as one token, unlike a plain
  // `<<`; its close is still a separate GT_GT (in CLOSE_TOKENS), so it
  // must be tracked as an opener here too or nesting/frame bookkeeping
  // desyncs on the matching close.
  'APP_SEQUENCE',
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
