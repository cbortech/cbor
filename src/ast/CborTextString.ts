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
import { Tokenizer, type TokenType, type SqstrToken } from '../cdn/tokenizer';
import {
  escapeString,
  indentOf,
  resolveIndent,
  resolveEiSuffix,
  canonicalEncodingWidth,
  danglingCommentsByGap,
  isMultiWordText,
  joinAppSeqParts,
  pushAll,
  shouldEmitComments,
  resolveCommentStyle,
} from '../cdn/serialize-utils';
import { hexToBytes } from '../utils/hex';
import { base64ToBytes } from '../utils/base64';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
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
   * (decoded as UTF-8 and merged in per draft-25 §5.1) rather than a double-quoted
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

  override _isMultiWordText(
    _options: ToCDNOptions | undefined,
    _strict = true
  ): boolean {
    return isMultiWordText(this.value);
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
    const gapComments = shouldEmitComments(options)
      ? danglingCommentsByGap(
          dangling,
          ednPartSpans,
          resolveCommentStyle(options)
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
    if (options?.modernConcat && options?.appPrefix !== false) {
      const literals = parts.map(
        ({ text, source }) => source ?? escapeString(text)
      );
      const midComments = parts.map((p) => p.commentsAfter ?? []);
      return joinAppSeqParts(
        't1',
        literals,
        suffix,
        indentStr,
        depth,
        midComments
      );
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
  //   loose rule — the *only* frames whose own suppression is unconditional
  //   (`isLooseFrame`, independent of `inlineLeafContainers`): an entry only
  //   has to render without a break of its own (`entryForcedBreak`),
  //   regardless of what it contains — matching CborEmbeddedCBOR's
  //   `entryIsLeaf`-less, `alwaysInlineLeaf` probe. Resolved app-sequence
  //   extensions vary in how they render, but this is the closest
  //   approximation without invoking the parser's extension resolution.
  // - LPAREN as an indefinite-length string group (`(_ ...)` /
  //   `CborIndefiniteTextString`/`ByteString`) uses the *strict* rule
  //   instead, same as LBRACKET/LBRACE (and gated behind
  //   `inlineLeafContainers` the same way, unlike LT_LT/APP_SEQUENCE) — a
  //   chunk can never actually contain a nested array/map, so this only
  //   differs from the loose rule in practice for a prefixed-literal byte
  //   chunk (`h'...'`), which disqualifies here but not inside `<<...>>`.
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
    // `true` for the one frame pushed immediately after `pushChainSuspend`
    // — the outermost bracket/tag of an ellipsis-led chain's own
    // continuation value (`... + (_ "a")`, `... + 100("a")`, ...). Used
    // only to decide, when *this exact* frame closes and is a tag-paren,
    // whether a purely semantic multi-word signal from its content may
    // propagate outward — see `entryForcedBreakStructural` and the
    // `CLOSE_TOKENS` handling below.
    isChainContinuationRoot: boolean;
    openOffset: number;
    ownCandidates: StringBreakpoint[];
    childCandidates: StringBreakpoint[];
    entryHasContainer: boolean;
    entryForcedBreak: boolean;
    anyForcedBreak: boolean;
    // Mirrors `entryForcedBreak`/`anyForcedBreak`, but only for a
    // *structural* reason (a real embedded newline, or an actual forwarded
    // breakpoint from a nested container that genuinely expanded) — never
    // for the purely semantic "this content is multi-word" reason. A tag
    // never collapses/expands based on its content's word count the way a
    // real container does, and `CborEllipsis`'s own rendering never
    // delegates to a fragment's semantic multi-word-ness either (it only
    // ever joins each fragment's *actual* rendered text) — so when an
    // `isChainContinuationRoot` tag-paren closes, only this structural
    // signal (not the ordinary one) may propagate to the chain state it's
    // about to restore.
    entryForcedBreakStructural: boolean;
    anyForcedBreakStructural: boolean;
    allOk: boolean;
  }
  const stack: CdnFrame[] = [];

  const emit = (point: number, contentDepth: number): void => {
    const top = stack[stack.length - 1];
    if (top) top.ownCandidates.push({ point, contentDepth });
    else points.push({ point, contentDepth });
  };

  // Only <<...>>/app-sequence are "loose" in the sense of always collapsing
  // regardless of inlineLeafContainers (mirrors CborEmbeddedCBOR's
  // `alwaysInlineLeaf`). An indefinite-length string group (non-tag-paren
  // LPAREN) follows the same strict rule as CborArray/CborMap instead,
  // gated behind inlineLeafContainers like everything else — see
  // `suppressible` below.
  const isLooseFrame = (frame: CdnFrame): boolean =>
    frame.kind === 'LT_LT' || frame.kind === 'APP_SEQUENCE';

  // A tag-paren frame is transparent for the strict/loose decision — like
  // real CborTag, which just forwards whatever `strict` it was given to its
  // content rather than deciding independently — so a prefixed byte-string
  // literal's forced-break check (see the BYTES_HEX branch below) must walk
  // up past any enclosing tag-paren frames to find the frame whose own
  // strict/loose rule actually governs it (e.g. `<<100(h'00')>>` stays
  // inline: the tag is transparent, and the governing frame is the loose
  // `<<...>>`, not the tag's own parens).
  const nearestRuleFrame = (): CdnFrame | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i];
      if (frame.kind === 'LPAREN' && frame.isTagParen) continue;
      return frame;
    }
    return undefined;
  };

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
    frame.anyForcedBreakStructural =
      frame.anyForcedBreakStructural || frame.entryForcedBreakStructural;
    frame.entryHasContainer = false;
    frame.entryForcedBreak = false;
    frame.entryForcedBreakStructural = false;
  };

  // Chain-aware multi-word tracking for `+`-concatenation, mirroring
  // isMultiWordTokenRange's chain handling in serialize-utils.ts:
  // `"one " + "word"` denotes one 2-word text string, not two 1-word ones,
  // so checking each TSTR individually (as every other token type in this
  // scan is checked, immediately, in isolation) under-counts. `chainKind`
  // tracks *which* chain (if any) is in progress — not just whether one is,
  // since a byte-leading chain (first part a prefixed `h'...'`/`b64'...'`)
  // must stay marked as such through every continuation part, even a bare
  // `SQSTR` one that would look text-leading in isolation: that
  // continuation is still part of the *byte* string the chain denotes
  // (concatenation never re-spells a byte-leading chain as one bare
  // `sqstr`), so it must not start its own independent text-leading
  // sub-chain — a byte-leading chain already forces a break unconditionally
  // via the existing BYTES_HEX/etc branch (on its first token, regardless
  // of continuation), independent of chain length, so `finalizeChain` never
  // needs to check anything for one. Only a text-leading chain (first part
  // TSTR/RAWSTRING/bare SQSTR — the same types the branches below check by
  // decoded word count rather than always-strict) accumulates into
  // `chainTexts`. `chainBroken` marks a part that couldn't be decoded
  // (elided hex, an elision-chain `...` link, or a malformed part that
  // shouldn't occur in this library's own output but isn't assumed) so a
  // text-leading chain is never falsely flagged from incomplete data.
  let chainKind: 'none' | 'text' | 'byte' = 'none';
  let chainTexts: string[] = [];
  let chainBroken = false;
  // Whether the chain currently in progress has seen at least one
  // `ELLIPSIS` link and at least one real `+` — i.e. it's a genuine elision
  // *chain* (`"a" + ...`, `... + h'00'`, `... + (_ "a")`, ...), not a bare
  // standalone `...` with nothing to concatenate at all. See `finalizeChain`
  // for why that distinction matters.
  let chainHasEllipsis = false;
  let chainSawPlus = false;
  // `true` right after an `INTEGER` was seen as an ellipsis-led chain's
  // continuation start — `parseValue()` accepts a bare integer *or* a tag
  // (`INTEGER [ENCODING_INDICATOR] LPAREN ... RPAREN`) there, and the two
  // aren't distinguishable until the token right after the integer (and its
  // own possible encoding indicator) is seen: `LPAREN` means it's a tag
  // (pushes into bracket tracking, same as any other bracketed
  // continuation, below); anything else means it was just a bare integer,
  // and that token is re-resolved as an ordinary chain-continuation check
  // instead.
  let chainAwaitingTagCheck = false;

  interface SavedChainState {
    depth: number;
    kind: 'none' | 'text' | 'byte';
    texts: string[];
    broken: boolean;
    hasEllipsis: boolean;
    sawPlus: boolean;
    awaitingTagCheck: boolean;
  }
  // A stack of *saved* (outer) chain states, one per bracketed value
  // currently being scanned as a continuation of an ellipsis-led chain
  // (`... + (_ "a")`, `... + [1, 2]`, ...) — only an ellipsis-led chain's
  // continuations can be arbitrary value shapes at all (the restricted
  // string/byte-literal-led grammar never allows one), matching
  // consumeOneItem's recursive handling in serialize-utils.ts. Pushing
  // saves the outer chain exactly as it was and resets the live
  // `chainKind`/etc. variables to a *fresh*, empty chain — the bracket's own
  // content is scanned completely normally against that fresh chain (its
  // own entries need their own, ordinary multi-word tracking; suspending
  // that entirely, an earlier version of this fix's bug, silently dropped
  // e.g. `["two words"]`'s own multi-word check). Each entry's `depth` is
  // the `nesting` level from *before* that bracket opened, so its own
  // matching close (nesting back down to this value) can be recognized
  // regardless of further brackets nested inside it — popping then restores
  // the outer chain exactly as it was, so a further `+` after the bracket
  // resumes the *same* chain rather than starting a new one.
  const chainSuspendStack: SavedChainState[] = [];
  // One-shot: set by `pushChainSuspend`, consumed by the very next
  // `OPEN_TOKENS` push (which is always the bracket/tag that triggered the
  // suspend, in the same iteration) to mark that frame
  // `isChainContinuationRoot`.
  let nextFrameIsChainContinuationRoot = false;

  const pushChainSuspend = (depth: number): void => {
    chainSuspendStack.push({
      depth,
      kind: chainKind,
      texts: chainTexts,
      broken: chainBroken,
      hasEllipsis: chainHasEllipsis,
      sawPlus: chainSawPlus,
      awaitingTagCheck: chainAwaitingTagCheck,
    });
    chainKind = 'none';
    chainTexts = [];
    chainBroken = false;
    chainHasEllipsis = false;
    chainSawPlus = false;
    chainAwaitingTagCheck = false;
    nextFrameIsChainContinuationRoot = true;
  };

  const popChainSuspendIfDepthMatches = (): void => {
    const saved = chainSuspendStack[chainSuspendStack.length - 1];
    if (saved !== undefined && nesting === saved.depth) {
      chainSuspendStack.pop();
      chainKind = saved.kind;
      chainTexts = saved.texts;
      chainBroken = saved.broken;
      chainHasEllipsis = saved.hasEllipsis;
      chainSawPlus = saved.sawPlus;
      chainAwaitingTagCheck = saved.awaitingTagCheck;
    }
  };

  const finalizeChain = (): void => {
    if (chainHasEllipsis && chainSawPlus) {
      // An elision chain resolves, in the real AST, to a `CborEllipsis`
      // wrapping a `CborArray` of fragments (see `src/cdn/parser.ts`'s
      // `concatenate()`) — a *container*-shaped node per
      // `CborArray._containsCdnContainer` (always `true`) and
      // `CborTag._containsCdnContainer` (delegates to its content) — even
      // though its own written source has no literal `[`/`{` of its own.
      // So it disqualifies a strict array/map's inlining the same way an
      // actual nested `[...]`/`{...}` would (mirrors the `LBRACKET`/
      // `LBRACE` handling below: propagated to *every* open frame, since a
      // nested container disqualifies every ancestor's current entry no
      // matter how deep it sits), regardless of what the word-count check
      // above concludes. A loose frame (`<<...>>`/app-sequence) ignores
      // `entryHasContainer` entirely in its own `foldEntry` check, so
      // setting it unconditionally here is safe — it only has an effect
      // where the strict rule already looks at it. A truly standalone bare
      // `...` (no `+` at all, `chainSawPlus` stays `false`) does *not* get
      // this: it resolves to `CborEllipsis(CborSimple.NULL)` — no array, no
      // container.
      for (const frame of stack) frame.entryHasContainer = true;
    }
    if (chainKind === 'text' && !chainBroken && chainTexts.length > 0) {
      if (isMultiWordText(chainTexts.join(''))) {
        const top = stack[stack.length - 1];
        if (top) top.entryForcedBreak = true;
      }
    }
    chainKind = 'none';
    chainTexts = [];
    chainBroken = false;
    chainHasEllipsis = false;
    chainSawPlus = false;
    chainAwaitingTagCheck = false;
  };

  for (;;) {
    const token = tokenizer.consume();
    if (token.type === 'EOF') {
      finalizeChain();
      break;
    }
    let skipClosePoint = false;

    // A chain can still be waiting to continue past `PLUS`, an
    // `ENCODING_INDICATOR` trailing an individual part, straight into the
    // next chained literal or elision-chain `...` link, or (for an
    // ellipsis-led chain specifically, whose continuations aren't
    // restricted to string/byte literals at all — `parseValue()` in
    // src/cdn/parser.ts accepts *any* value there) into a bracketed value,
    // a tag, or a bare atom — anything else means it's over, and must be
    // resolved before this token's own handling (e.g. a closing bracket
    // popping the frame the chain's break belongs on). This always
    // operates on whatever the *current* chain is — the outer one, or (see
    // `chainSuspendStack`) a bracketed continuation's own fresh one, once
    // pushed — never anything that needs its own suspension.
    let chainContinuationResolved = false;
    if (chainAwaitingTagCheck) {
      if (token.type === 'ENCODING_INDICATOR') {
        // Still deciding — this is the integer's own encoding indicator;
        // wait for what follows it.
        chainContinuationResolved = true;
      } else if (token.type === 'LPAREN') {
        // It's a tag after all (`100(...)`, `100_1(...)`): push into the
        // same bracket tracking as any other bracketed continuation —
        // `nesting` is incremented for this same `LPAREN` by the ordinary
        // `OPEN_TOKENS` handling below, in this same iteration.
        chainAwaitingTagCheck = false;
        pushChainSuspend(nesting);
        chainContinuationResolved = true;
      } else {
        // Just a bare integer after all — fall through to the ordinary
        // check below for this same token, as if nothing special had
        // intervened (mirrors consumeOneItem's own "not a tag, return
        // p" — the integer's own extent already ended).
        chainAwaitingTagCheck = false;
      }
    }
    if (!chainContinuationResolved) {
      const chainCanContinueHere =
        token.type === 'PLUS' ||
        token.type === 'ENCODING_INDICATOR' ||
        (prevType === 'PLUS' &&
          (STRINGISH_CHAIN_TYPES.has(token.type) || token.type === 'ELLIPSIS'));
      if (chainKind !== 'none' && !chainCanContinueHere) {
        if (prevType === 'PLUS' && chainHasEllipsis) {
          if (OPEN_TOKENS.has(token.type)) {
            // An ellipsis-led chain's continuation may itself be an
            // arbitrary bracketed value (`... + (_ "a")`, `... + [1, 2]`,
            // ...) — push a fresh chain for this bracket's own content
            // (handled entirely normally below, on its own frame, exactly
            // like a standalone entry — it needs its *own* ordinary
            // multi-word tracking, e.g. `["two words"]`'s own entry, not a
            // suspension that would silently skip it) rather than
            // finalizing the outer one.
            pushChainSuspend(nesting);
          } else if (token.type === 'INTEGER') {
            // Could be a bare integer continuation, or the start of a tag
            // (`100(...)`) — not distinguishable yet; resolved on the next
            // token, above.
            chainAwaitingTagCheck = true;
          }
          // Any other bare atom (a float, a simple value, ...): the
          // continuation is exactly this one token (plus an optional
          // trailing encoding indicator, already deferred by the
          // unconditional `ENCODING_INDICATOR` clause above) — nothing to
          // track, since none of the chain-state-mutating branches below
          // match any of these token types anyway; just don't finalize
          // here, and let the *next* token's own check (this token's type
          // becomes the new `prevType`, not `PLUS`) decide normally
          // whether the chain continues (`+`) or ends.
        } else {
          finalizeChain();
        }
      }
      if (token.type === 'PLUS' && chainKind !== 'none') {
        chainSawPlus = true;
      }
    }

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
        isChainContinuationRoot: nextFrameIsChainContinuationRoot,
        openOffset: token.offset,
        ownCandidates: [],
        childCandidates: [],
        entryHasContainer: false,
        entryForcedBreak: false,
        anyForcedBreak: false,
        entryForcedBreakStructural: false,
        anyForcedBreakStructural: false,
        allOk: true,
      });
      nextFrameIsChainContinuationRoot = false;
    } else if (CLOSE_TOKENS.has(token.type)) {
      nesting = Math.max(0, nesting - 1);
      // If this closes the bracket that pushed a fresh chain for an
      // ellipsis-led chain's continuation, restore the outer chain exactly
      // as it was before that (matching brackets nested inside it, if any,
      // already came and went via their own push/pop) — the very next
      // iteration's `chainCanContinueHere` check then decides, from that
      // restored state, whether a further `+` continues it or it's time to
      // finalize. The fresh chain this bracket's own content was using (if
      // any) was already finalized against *this* frame by the top-of-loop
      // check earlier in this same iteration, before it's popped below.
      popChainSuspendIfDepthMatches();
      if (!skipClosePoint) {
        emit(token.offset, nesting);
      }
      const frame = stack.pop();
      if (frame) {
        foldEntry(frame);
        const isTag = frame.kind === 'LPAREN' && frame.isTagParen;
        // A loose frame (LT_LT/APP_SEQUENCE) collapses onto one line
        // whenever it fits regardless of inlineLeafContainers — mirrors
        // serializeContainer's `alwaysInlineLeaf`, since there's no
        // structural reason to ever spread a flat encoded-item sequence one
        // item per line if it fits. Everything else — array/map brackets,
        // tag parens, *and* an indefinite-length string group's parens
        // (LPAREN, tag or not) — stays gated behind inlineLeafContainers.
        const suppressible = isLooseFrame(frame)
          ? true
          : inlineLeafContainers &&
            (frame.kind === 'LBRACKET' ||
              frame.kind === 'LBRACE' ||
              frame.kind === 'LPAREN');
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
          // happened and still needs to reach the parent — *unless* this
          // frame is the outermost bracket/tag of an ellipsis-led chain's
          // continuation (`isChainContinuationRoot`) and a tag-paren
          // specifically: closing it is about to restore the chain state
          // it was pushed to protect, and only a *structural* reason (a
          // real newline, or an actual forwarded breakpoint) should reach
          // that restored chain — a purely semantic "my content is
          // multi-word" signal has no real analogue there (see
          // `entryForcedBreakStructural`'s doc; `CborEllipsis`'s own
          // rendering never delegates to a fragment's semantic
          // multi-word-ness, only its actual rendered text).
          const hasStructuralBreak =
            forwarded.length > 0 || frame.anyForcedBreakStructural;
          const shouldPropagate =
            frame.isChainContinuationRoot && frame.isTagParen
              ? hasStructuralBreak
              : forwarded.length > 0 || frame.anyForcedBreak;
          if (shouldPropagate) {
            parent.entryForcedBreak = true;
          }
          if (hasStructuralBreak) {
            parent.entryForcedBreakStructural = true;
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
    } else if (token.type === 'TSTR' || token.type === 'RAWSTRING') {
      // A literal/escaped newline inside this token will itself become a
      // breakpoint once `splitNewline` runs (merged in by the caller,
      // outside this function) — that forces this entry's own rendering
      // to contain a line break, exactly like a child bracket that
      // couldn't be suppressed. Mirrors serializeContainer's `s.includes
      // ('\n')` check on a rendered entry.
      const tokenText = value.slice(token.offset, token.endOffset);
      const hasNewline =
        newline &&
        (token.type === 'TSTR'
          ? collectTstrNewlineBreakpoints(tokenText).length > 0
          : collectNewlineBreakpoints(tokenText, 0).length > 0);
      // A literal/escaped newline always forces a break immediately,
      // independent of concatenation. Not gated on `inlineLeafContainers`
      // here — setting `entryForcedBreak` is a no-op whenever the
      // enclosing frame isn't suppressible anyway (see `suppressible`
      // above), so this stays correct for a loose frame's unconditional
      // collapse too, without needing to know which case applies at this
      // point in the scan.
      if (hasNewline) {
        const top = stack[stack.length - 1];
        if (top) {
          top.entryForcedBreak = true;
          // A real, literal newline — unlike the multi-word check just
          // below — is a genuinely structural fact that would show up in
          // the actual rendered text regardless of what wraps it; see
          // `entryForcedBreakStructural`'s doc.
          top.entryForcedBreakStructural = true;
        }
      }
      // Multi-word-ness (mirrors serializeContainer's `entryIsMultiWordText`
      // probe) is chain-aware: append to an in-progress text-leading chain
      // continuation, or start a new (possibly single-part) one — resolved
      // by `finalizeChain` once the chain is known to be over (see above).
      // Always operates on whichever chain is *current* (see
      // `chainSuspendStack`) — a bracketed continuation's own fresh chain
      // needs this exact same tracking for its own entries (e.g. a plain
      // `"two words"` inside `... + ["two words"]`), not a suspension that
      // would silently skip it.
      if (prevType === 'PLUS' && chainKind === 'text') {
        chainTexts.push(token.value);
      } else {
        chainKind = 'text';
        chainTexts = [token.value];
        chainBroken = false;
      }
    } else if (token.type === 'SQSTR') {
      // A bare sqstr byte-string literal (`'...'`) is printable text by
      // construction — mirrors CborByteString._isMultiWordText's sqstr
      // branch. `.value` holds hex bytes for SQSTR (byte-string convention),
      // so the decoded UTF-8 payload comes from `_sqstrBytes` instead. As a
      // *continuation* of an already-byte-leading chain (`h'' + 'two
      // words'`), though, it must NOT start its own independent
      // text-leading chain — see the `chainKind` block comment above; it's
      // still just a further byte span of that same byte string, already
      // exempted from the multi-word check by the byte-leading chain's own
      // start (the BYTES_HEX/etc branch below). Always operates on
      // whichever chain is *current*, same as the TSTR/RAWSTRING branch
      // above.
      if (prevType === 'PLUS' && chainKind === 'byte') {
        // no-op: part of an already-exempt byte-leading chain
      } else {
        const bytes = (token as SqstrToken)._sqstrBytes;
        const decoded = bytes ? textDecoder.decode(bytes) : null;
        if (prevType === 'PLUS' && chainKind === 'text') {
          if (decoded === null) chainBroken = true;
          else chainTexts.push(decoded);
        } else {
          chainKind = 'text';
          chainTexts = decoded !== null ? [decoded] : [];
          chainBroken = decoded === null;
        }
      }
    } else if (
      token.type === 'BYTES_HEX' ||
      token.type === 'BYTES_HEX_ELIDED' ||
      token.type === 'BYTES_B64' ||
      token.type === 'APP_STRING'
    ) {
      if (prevType === 'PLUS' && chainKind === 'text') {
        // A continuation of a *text*-leading chain (`"a" + h'62'`) is
        // decoded and merged into the accumulated text instead — the
        // unconditional "always strict" rule below only applies when *this*
        // token is what fixes the chain's element type (byte-leading, or
        // standalone); a byte-shaped *continuation* of an already
        // text-leading chain doesn't get its own independent say — the
        // combined word count, computed once the chain ends, is what
        // decides it, exactly like isMultiWordTokenRange's chain decoding
        // in serialize-utils.ts (`"a" + h'62'` merges to `"ab"`, one word,
        // and must not be disqualified just because one part happened to
        // be spelled as `h'62'`). APP_STRING never participates in
        // concatenation (draft-25 §5.1), so it never continues one; `BYTES_HEX_ELIDED`'s
        // missing data can't be decoded, so it always breaks the chain
        // instead of silently under-counting.
        let decoded: string | null = null;
        try {
          if (token.type === 'BYTES_HEX') {
            decoded = textDecoder.decode(hexToBytes(token.value));
          } else if (token.type === 'BYTES_B64') {
            decoded = textDecoder.decode(base64ToBytes(token.value));
          }
        } catch {
          decoded = null;
        }
        if (decoded === null) chainBroken = true;
        else chainTexts.push(decoded);
      } else {
        // Mirrors CborByteString._isMultiWordText's prefixed-literal branch
        // (and, via APP_STRING, `isPrefixedLiteralText`'s generic catch-all
        // for other app-string extensions like `ip'...'`/`dt'...'`): none of
        // these have natural word boundaries to check, so they always count
        // as multi-word under the strict rule (array/map, and — unlike a
        // multi-word text entry — an indefinite-length string group too) —
        // but the *only* loose frame (`<<...>>`/app-sequence) treats it as
        // an ordinary leaf instead, e.g. `<<h'00'>>`/`<<ip'...'>>` stay
        // inline while `(_ h'00')` still breaks. The governing frame is
        // found by `nearestRuleFrame`, not just `top`, since an enclosing
        // tag paren is transparent to this decision. This unconditional
        // check applies whether this literal starts a byte-leading chain or
        // stands alone — a byte-leading chain is never re-spelled as one
        // bare `sqstr`, so it disqualifies the same way a lone prefixed
        // literal already does, independent of chain length (see
        // serialize-utils.ts's isMultiWordTokenRange for the same
        // reasoning) — but *not* when it's really a continuation of a
        // text-leading chain, handled above instead.
        const top = stack[stack.length - 1];
        const ruleFrame = nearestRuleFrame();
        if (top && (!ruleFrame || !isLooseFrame(ruleFrame))) {
          top.entryForcedBreak = true;
        }
        if (prevType !== 'PLUS' || chainKind === 'none') {
          // Not a continuation — this token starts a fresh, byte-leading
          // chain (or stands alone, which is the same thing as a one-part
          // chain). Recorded so a *following* continuation part (including
          // a bare SQSTR, which would otherwise look text-leading in
          // isolation) is correctly recognized as still belonging to this
          // byte-leading chain rather than starting an independent one.
          chainKind = 'byte';
        }
      }
    } else if (token.type === 'ELLIPSIS') {
      // An elision-chain link (`"a" + ...`, or leading — `... + "b"`, an
      // unknown prefix concatenated with a known suffix — CDN's notation
      // for a value with a part deliberately omitted; see
      // serialize-utils.ts's `CHAIN_ATOM_TYPES` for the same grammar,
      // accepted both as a chain's own first value and as any later
      // continuation). Either way its missing content makes the *combined*
      // word count of the whole chain unknowable, never just this part's —
      // so as a *continuation* of a text-leading chain, it poisons that
      // chain (without ending it — more parts may still follow) rather
      // than silently under-counting from only the visible parts; as a
      // *fresh start* (nothing to continue), it begins one already
      // poisoned, so a *later* continuation part (including a bare SQSTR,
      // which would otherwise look like its own fresh text-leading start)
      // is still recognized as belonging to this now-indeterminate chain
      // instead of starting an independent one. A byte-leading chain
      // doesn't track decoded text at all, so there's nothing to poison
      // there. Set unconditionally, regardless of which case below applies
      // (including a continuation of a *byte*-kind chain, e.g. `h'00' +
      // ...`, which none of those cases otherwise touch) — see
      // `finalizeChain`'s `chainHasEllipsis`/`chainSawPlus` check for why a
      // truly standalone `...` (this flag set, but `chainSawPlus` never
      // becomes true) is harmless. Always operates on whichever chain is
      // *current* — an `ELLIPSIS` inside an ellipsis-led chain's own
      // bracketed continuation, if that's even reachable, correctly poisons
      // *that* (fresh, pushed) chain rather than the outer one.
      chainHasEllipsis = true;
      if (prevType === 'PLUS' && chainKind === 'text') {
        chainBroken = true;
      } else if (prevType !== 'PLUS' || chainKind === 'none') {
        chainKind = 'text';
        chainTexts = [];
        chainBroken = true;
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

// Token types that can appear as one part of a `+`-concatenation chain
// (draft-25 §5.1) — mirrors `STRINGISH_TYPES` in serialize-utils.ts.
const STRINGISH_CHAIN_TYPES = new Set<TokenType>([
  'TSTR',
  'RAWSTRING',
  'SQSTR',
  'BYTES_HEX',
  'BYTES_HEX_ELIDED',
  'BYTES_B64',
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
