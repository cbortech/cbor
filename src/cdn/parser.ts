import {
  Tokenizer,
  type EdnComment,
  type SqstrToken,
  type Token,
  type TokenType,
} from './tokenizer';
import { CdnSyntaxError } from './errors';
import type {
  AppSeqEncodingEdit,
  AppSeqSourceFeatures,
  CborItem,
} from '../ast/CborItem';
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
import {
  autoSelectFloatPrecision,
  maxForEncodingWidth,
  type EncodingWidth,
} from '../cbor/encode';
import {
  canonicalEncodingWidth,
  pushAll,
  type ByteCommentSyntax,
} from './serialize-utils';
import { b32, h32 } from '../extensions/b32';
import { parseHexFloat } from '../utils/hexfloat';
import { hexToBytes } from '../utils/hex';
import { base64ToBytes } from '../utils/base64';
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
  if (options?.preserveComments || options?.preserveAll) {
    attachComments(node, tokenizer.comments, text);
    promoteEllipsisTailComments(node);
  }
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

/**
 * `item`'s own literal-preservation features, combined with those of
 * whatever it structurally contains.
 *
 * A node can carry `appSeqSourceFeatures` on itself — set when it is *also*
 * the result of parsing a `prefix<<item>>` / `prefix'...'` source, recording
 * features of *that* inner item (see the `appSeqSourceFeatures` field on
 * `CborItem`) — independently of whatever `structuralAppSeqSourceFeatures`
 * finds by walking its children. Both must be combined: a nested extension
 * result (e.g. a `dt<<b64'...'>>` that resolved to a plain epoch number, so
 * `structuralAppSeqSourceFeatures` finds nothing byte-string-like in it
 * structurally) still carries its own inner byte-string literal's features
 * on itself, and an explicitly disabled sibling `preserve*` option must see
 * that when this node is nested inside an outer `preserveAppSequence`
 * raw-tag/`<<...>>` source (e.g. `ip`'s array content).
 */
function appSeqSourceFeatures(
  item: CborItem | undefined
): AppSeqSourceFeatures | undefined {
  if (item === undefined) return undefined;
  return combineAppSeqSourceFeatures([
    item.appSeqSourceFeatures,
    structuralAppSeqSourceFeatures(item),
  ]);
}

function structuralAppSeqSourceFeatures(
  item: CborItem
): AppSeqSourceFeatures | undefined {
  if (item instanceof CborByteString) {
    return {
      byteString: true,
      concatenation: item.ednParts !== undefined && item.ednParts.length > 1,
    };
  }
  if (item instanceof CborTextString) {
    const hasParts = item.ednParts !== undefined;
    const rawPartCount =
      item.ednPartSources?.filter((source) => source !== undefined).length ?? 0;
    // A part with no preserved raw source is ambiguous by itself — it could
    // be an unpreservable double-quoted literal (textString) or a
    // byte-string literal decoded to text per draft-25 §5.1 (byteString); only
    // ednPartIsByteString distinguishes them.
    const byteStringPartCount = hasParts
      ? item.ednParts!.reduce((count, _text, i) => {
          const hasSource = item.ednPartSources?.[i] !== undefined;
          const isByteString = item.ednPartIsByteString?.[i] ?? false;
          return hasSource || !isByteString ? count : count + 1;
        }, 0)
      : 0;
    const unpreservedTextPartCount =
      (hasParts ? item.ednParts!.length : 0) -
      rawPartCount -
      byteStringPartCount;
    return {
      byteString: byteStringPartCount > 0,
      textString:
        item.quotedEdnSource !== undefined || unpreservedTextPartCount > 0,
      rawString: item.ednSource !== undefined || rawPartCount > 0,
      concatenation: hasParts && item.ednParts!.length > 1,
    };
  }
  if (item instanceof CborArray) {
    return combineAppSeqSourceFeatures(item.items.map(appSeqSourceFeatures));
  }
  if (item instanceof CborMap) {
    // ip accepts an arbitrary CborArray as tag content, so a nested map's
    // own byte-string/text-string/concatenation literals must also be
    // detected — otherwise an explicitly disabled sibling `preserve*`
    // option silently has no effect on them (see collectContentEncodingEdits,
    // which has the analogous "unsupported nested node" concern for
    // encoding-indicator edits).
    return combineAppSeqSourceFeatures(
      item.entries.flatMap(([k, v]) => [
        appSeqSourceFeatures(k),
        appSeqSourceFeatures(v),
      ])
    );
  }
  if (item instanceof CborTag) return appSeqSourceFeatures(item.content);
  if (
    item instanceof CborIndefiniteByteString ||
    item instanceof CborIndefiniteTextString ||
    item instanceof CborEmbeddedCBOR
  ) {
    const children: CborItem[] =
      item instanceof CborEmbeddedCBOR ? item.items : item.chunks;
    return combineAppSeqSourceFeatures(children.map(appSeqSourceFeatures));
  }
  return undefined;
}

function combineAppSeqSourceFeatures(
  values: (AppSeqSourceFeatures | undefined)[]
): AppSeqSourceFeatures | undefined {
  const features = values.filter((value) => value !== undefined);
  if (features.length === 0) return undefined;
  return {
    byteString: features.some((value) => value.byteString),
    textString: features.some((value) => value.textString),
    rawString: features.some((value) => value.rawString),
    concatenation: features.some((value) => value.concatenation),
  };
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

// ─── Blank-line tracking ─────────────────────────────────────────────────────

/**
 * A blank line is a line containing only whitespace between two other lines
 * — i.e. two newlines with nothing but horizontal whitespace between them.
 * Applied to the raw gap between one container entry and the next
 * (comments and all), so a blank line is detected regardless of whether it
 * sits before, after, or inside a leading comment block.
 */
const BLANK_LINE_RE = /\r?\n[ \t]*\r?\n/;

function hasBlankLineBetween(
  text: string,
  start: number,
  end: number
): boolean {
  return BLANK_LINE_RE.test(text.slice(start, end));
}

// ─── Comment attachment ──────────────────────────────────────────────────────

interface NodeInfo {
  node: CborItem;
  start: number;
  end: number;
}

function relativeComments(
  comments: readonly EdnComment[],
  fromIndex: number,
  start: number,
  end: number
): CborComment[] {
  const result: CborComment[] = [];
  for (let i = fromIndex; i < comments.length; i++) {
    const comment = comments[i]!;
    if (comment.start >= end) break;
    if (comment.start >= start && comment.end <= end)
      result.push({
        ...comment,
        start: comment.start - start,
        end: comment.end - start,
      });
  }
  return result;
}

function sourceSuffixEdit(
  source: string,
  sourceStart: number,
  node: CborItem,
  always: string
): AppSeqEncodingEdit | undefined {
  if (node.end === undefined) return undefined;
  const hasIndicator = /_[0-7i]$/.test(
    source.slice(Math.max(0, node.end - 2), node.end)
  );
  const start = (hasIndicator ? node.end - 2 : node.end) - sourceStart;
  return {
    start,
    end: node.end - sourceStart,
    always,
    never: '',
  };
}

/**
 * Collect source-span edits for every encoding indicator nested inside a
 * raw-tag's content, for `adjustRawAppSeqSource`.
 *
 * Returns `undefined` — instead of a partial edit list — when `node` (or
 * anything nested inside it) is a type this function doesn't know how to
 * produce an edit for (e.g. `CborMap`, `CborTag`, `CborSimple`, an
 * indefinite-length string). A partial list would silently leave that
 * node's own indicator un-edited under `encodingIndicators: 'always'` /
 * `'never'`; the caller must fall back to structural re-serialization
 * instead so every nested indicator is actually applied. `ip` accepts an
 * arbitrary `CborArray` as tag content, so this bails out for any element
 * type beyond the ones explicitly handled below rather than assuming
 * coverage is complete.
 */
function collectContentEncodingEdits(
  source: string,
  sourceStart: number,
  node: CborItem
): AppSeqEncodingEdit[] | undefined {
  if (node instanceof CborUint) {
    const width = node.encodingWidth ?? canonicalEncodingWidth(node.value);
    const edit = sourceSuffixEdit(source, sourceStart, node, `_${width}`);
    return edit ? [edit] : [];
  }
  if (node instanceof CborNint) {
    const width = node.encodingWidth ?? canonicalEncodingWidth(node.argument);
    const edit = sourceSuffixEdit(source, sourceStart, node, `_${width}`);
    return edit ? [edit] : [];
  }
  if (node instanceof CborFloat) {
    const precision = node.precision ?? autoSelectFloatPrecision(node.value);
    const suffix =
      precision === 'half' ? '_1' : precision === 'single' ? '_2' : '_3';
    const edit = sourceSuffixEdit(source, sourceStart, node, suffix);
    return edit ? [edit] : [];
  }
  if (node instanceof CborByteString) {
    const width =
      node.encodingWidth ?? canonicalEncodingWidth(BigInt(node.value.length));
    const edit = sourceSuffixEdit(source, sourceStart, node, `_${width}`);
    return edit ? [edit] : [];
  }
  if (node instanceof CborTextString) {
    const width =
      node.encodingWidth ??
      canonicalEncodingWidth(BigInt(textEncoder.encode(node.value).length));
    const edit = sourceSuffixEdit(source, sourceStart, node, `_${width}`);
    return edit ? [edit] : [];
  }
  if (node instanceof CborArray) {
    const edits: AppSeqEncodingEdit[] = [];
    if (node.indefiniteLength) return undefined;
    if (node.start !== undefined) {
      const tokenizer = new Tokenizer(source, { offset: node.start });
      const open = tokenizer.consume();
      const next = tokenizer.peek();
      const hasIndicator = next.type === 'ENCODING_INDICATOR';
      const width =
        node.encodingWidth ?? canonicalEncodingWidth(BigInt(node.items.length));
      const suffix = `_${width}`;
      const nextSourceChar = source[open.endOffset] ?? '';
      const separator =
        !hasIndicator && /[+\-.0-9A-Z_a-z]/.test(nextSourceChar) ? ' ' : '';
      edits.push({
        start: (hasIndicator ? next.offset : open.endOffset) - sourceStart,
        end: (hasIndicator ? next.endOffset : open.endOffset) - sourceStart,
        // An inserted container indicator needs a separator before an
        // immediately-adjacent item (`[_i24]` lexes as one identifier).
        always: suffix + separator,
        never: '',
      });
    }
    for (const item of node.items) {
      const itemEdits = collectContentEncodingEdits(source, sourceStart, item);
      if (itemEdits === undefined) return undefined;
      pushAll(edits, itemEdits);
    }
    return edits;
  }
  return undefined;
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
        comment.sameLine = lineAt(raw.end) === lineAt(next.start);
        addComment(next.node, 'leading', comment);
        continue;
      }
    }

    // No enclosing node and no following node: the comment lies entirely
    // after `root.end` (a comment before `root.start` is always caught by
    // the `next`-leading branch above, since `root` is itself a collected
    // node). This happens when this parse is one item of a CDN Sequence
    // (`allowTrailing: true`) — the tokenizer's one-token lookahead reads
    // past this item's closing bracket into a comment that actually
    // belongs to whatever follows. Attaching it here would duplicate the
    // sequence-level leading-comment assignment `fromCDNSeq` already makes
    // for the next item, so it is dropped instead of defaulting to `root`.
    if (!container) continue;

    addComment(container.node, 'dangling', comment);
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

/**
 * A comment right after the very last fragment of a `+`/`...` chain ties,
 * in source position, with the enclosing `CborEllipsis`'s own end — there
 * is no closing delimiter after the last fragment (unlike an array's `]` or
 * a map's `}`) to give the chain a later end of its own — so
 * `attachComments`'s prev/next tie-break resolves it in favour of the more
 * specific, innermost node: the comment lands as `trailing` on the last
 * fragment itself, not on the `CborEllipsis`.
 *
 * Move it up onto the `CborEllipsis`'s own `comments.trailing` so the
 * ordinary `entryTrailing`/root-`toCDN()` machinery renders it after
 * whatever separator the parent adds (`,`, `:`, a closing bracket) instead
 * of `CborEllipsis._toCDN()` folding it into the chain's own body — which
 * would place a `#`/`//` line comment *before* that separator, swallowing
 * it into the comment on re-parse (e.g. `[h'aa' + ..., # next\n 1]` would
 * otherwise render the trailing `,` inside the comment text itself).
 */
function promoteEllipsisTailComments(node: CborItem): void {
  if (node instanceof CborEllipsis) {
    if (node.content instanceof CborArray) {
      const items = node.content.items;
      for (const item of items) promoteEllipsisTailComments(item);
      const last = items[items.length - 1];
      const lastTrailing = last?.comments?.trailing;
      if (
        lastTrailing !== undefined &&
        lastTrailing.length > 0 &&
        !node.comments?.trailing?.length
      ) {
        node.comments ??= {};
        node.comments.trailing = lastTrailing;
        last.comments!.trailing = undefined;
      }
    }
    return;
  }
  if (node instanceof CborArray || node instanceof CborEmbeddedCBOR) {
    for (const item of node.items) promoteEllipsisTailComments(item);
    return;
  }
  if (node instanceof CborMap) {
    for (const [key, value] of node.entries) {
      promoteEllipsisTailComments(key);
      promoteEllipsisTailComments(value);
    }
    return;
  }
  if (
    node instanceof CborIndefiniteByteString ||
    node instanceof CborIndefiniteTextString
  ) {
    for (const chunk of node.chunks) promoteEllipsisTailComments(chunk);
    return;
  }
  if (node instanceof CborTag) promoteEllipsisTailComments(node.content);
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

/**
 * One atom of a byte-string `+`/ellipsis chain: either a byte fragment or an
 * ellipsis marker, tagged with whether a genuine `+` from the source
 * precedes it (`real`) as opposed to sitting inside a single `h'xx...yy'`
 * literal's own `...` notation. An ellipsis atom also tracks whether it came
 * from such a literal at all (`fromByteLiteral`), regardless of its own
 * position within it (leading, trailing, or in the middle) — as opposed to a
 * bare standalone `...` token — and, when it did, that literal's own raw
 * source text (`literalSource`, e.g. `h'AB...CD'` verbatim, case/whitespace/
 * comments and all) for `preserveByteString` to round-trip. See
 * `CDNParser._consumeByteEllipsisChain`.
 */
type ByteEllipsisAtom =
  | {
      bytes: Uint8Array;
      source?: string;
      commentSyntax?: ByteCommentSyntax;
      real: boolean;
      /**
       * Source span this atom occupies — its own literal token's span for a
       * direct `+`-joined fragment, or the enclosing `h'xx...yy'` token's
       * whole span for an internal segment split out of it (see
       * `_elidedHexAtoms`: no comment can ever sit between two of that
       * token's own internal segments, so sharing the outer span is safe and
       * still lets an *outer* boundary comment resolve correctly against the
       * group as a whole). Lets `_buildFromByteAtoms` stamp `start`/`end` on
       * the `CborByteString`/`CborEllipsis` nodes it builds, so the generic
       * `attachComments` pass (and `CborByteString._toCDN`'s /
       * `CborEllipsis._renderPreservedBytesElision`'s own dangling-comment
       * lookups) can place a comment between two `+`-joined parts instead of
       * dropping it.
       */
      start?: number;
      end?: number;
    }
  | {
      ellipsis: true;
      real: boolean;
      fromByteLiteral: boolean;
      literalSource?: string;
      /** See the byte-atom variant's `start`/`end` doc above. */
      start?: number;
      end?: number;
    };

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
          tok.raw,
          tok.offset,
          tok.endOffset
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
            if (ext.preserveAppSeqSource === 'optional') {
              // Same rationale as the APP_SEQUENCE case below: tack the
              // source onto the same result node so preserveAppSequence can
              // round-trip prefix`...` (and non-canonical prefix'...')
              // spellings without changing the node's class/identity.
              result.appSeqSource = tok.raw + appStrEiRaw;
              return result;
            }
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
                // A prefix name alone can't say which comment syntax (if
                // any) this content actually uses: a user extension may be
                // registered under the same prefix as a built-in (`ext`
                // here is whichever one actually resolved — see the
                // registration order in the constructor). Only strip
                // comments from preserveByteString's spelling when `ext` is
                // provably the specific built-in b32/h32 object.
                ednCommentSyntax:
                  ext === b32 || ext === h32 ? 'full' : undefined,
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
        const commentStartIndex = this.t.comments.length;
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
            if (seqExt.preserveAppSeqSource === 'optional') {
              // Tack the source onto the same result node (preserving its
              // class/identity) rather than wrapping it; the node's own
              // _toCDN() decides whether to use it (see preserveAppSequence).
              result.appSeqSource = rawSource;
              result.appSeqComments = relativeComments(
                this.t.comments,
                commentStartIndex,
                tok.offset,
                this.t.lastEndOffset
              );
              // Exact split point for adjustAppSeqIndicator to strip the
              // sole inner item's own indicator by position rather than by
              // pattern-matching text near '>>' (which whitespace, a
              // trailing comma, or a comment between the item and '>>'
              // would defeat).
              if (items.length === 1) {
                if (items[0].end !== undefined)
                  result.appSeqInnerEnd = items[0].end - tok.offset;
                result.appSeqSourceFeatures = appSeqSourceFeatures(items[0]);
              }
            } else if (result instanceof CborFloat) {
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
        // Every item here came from an explicit `+` (this generic chain has
        // no notion of an elided-hex literal's internal `...`), so every
        // boundary is real.
        return new CborEllipsis(
          items,
          items.map(() => true)
        );
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
    const commentStartIndex = this.t.comments.length;
    const tok = this.t.consume(); // INTEGER
    const { numStr, rawSuffix } = parseIntegerRaw(tok.value);
    let tagIndicatorStart =
      rawSuffix !== undefined ? tok.endOffset - 2 : tok.endOffset;
    let tagIndicatorEnd = tok.endOffset;
    // Hex/octal/binary literals return before the suffix check in the tokenizer,
    // so their encoding indicator arrives as a separate ENCODING_INDICATOR token.
    let encodingWidth =
      rawSuffix !== undefined
        ? this._resolveEncodingWidth(rawSuffix, tok)
        : this.consumeEncodingIndicator(undefined, (eiTok) => {
            tagIndicatorStart = eiTok.offset;
            tagIndicatorEnd = eiTok.endOffset;
          });
    const n = parseBigInt(numStr);
    // tok.raw keeps a leading '+' that tok.value drops (e.g. "+42" → value
    // "42", raw "+42"); mirror the same suffix stripping applied to numStr
    // so the preserved spelling matches what the user actually wrote.
    const ednSource = rawSuffix !== undefined ? tok.raw.slice(0, -2) : tok.raw;

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
        ? new CborUint(n, { encodingWidth, ednSource })
        : new CborNint(n, { encodingWidth, ednSource });

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
          if (result instanceof CborTag) {
            if (
              encodingWidth !== undefined &&
              result.encodingWidth === undefined
            )
              result.encodingWidth = encodingWidth;
            if (result.ednSource === undefined) result.ednSource = ednSource;
            if (
              ext.preserveAppSeqSource === 'optional' &&
              result.appSeqSource === undefined
            ) {
              // Raw tag notation (e.g. 1(1749772800)) is itself a spelling
              // that preserveAppSequence should be able to keep instead of
              // upgrading it to regenerated DT'...' notation.
              result.appSeqSource = this.t.source.slice(
                tok.offset,
                this.t.lastEndOffset
              );
              result.appSeqComments = relativeComments(
                this.t.comments,
                commentStartIndex,
                tok.offset,
                this.t.lastEndOffset
              );
              const tagWidth =
                result.encodingWidth ?? canonicalEncodingWidth(result.tag);
              const contentEdits = collectContentEncodingEdits(
                this.t.source,
                tok.offset,
                result.content
              );
              result.appSeqEncodingEdits = [
                {
                  start: tagIndicatorStart - tok.offset,
                  end: tagIndicatorEnd - tok.offset,
                  always: `_${tagWidth}`,
                  never: '',
                },
                ...(contentEdits ?? []),
              ];
              if (contentEdits === undefined)
                result.appSeqEncodingEditsComplete = false;
              result.appSeqSourceFeatures = appSeqSourceFeatures(content);
            }
          }
          if (setupWarnings.length > 0) {
            result.warnings ??= [];
            result.warnings.push(...setupWarnings);
          }
          return result;
        }
      }
      const tagResult = new CborTag(tagNum, content, {
        encodingWidth,
        ednSource,
      });
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
    // tok.raw keeps a leading '+' that tok.value drops (e.g. "+1.5" → value
    // "1.5", raw "+1.5"; likewise "+Infinity" → value "Infinity").
    return new CborFloat(value, { precision, literalSource: tok.raw });
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
      return new CborTextString(tok.value, {
        quotedEdnSource: tok.raw,
        ...(ew !== undefined ? { encodingWidth: ew } : {}),
      });
    }

    // Concatenation chain — may include ellipsis, producing CborEllipsis
    let hasEllipsis = false;
    const parts: Array<
      | {
          text: string;
          source?: string;
          isByteString?: boolean;
          start: number;
          end: number;
        }
      | { ellipsis: true; start: number; end: number }
    > = [
      tok.type === 'RAWSTRING'
        ? {
            text: tok.value,
            source: tok.raw,
            start: tok.offset,
            end: tok.endOffset,
          }
        : { text: tok.value, start: tok.offset, end: tok.endOffset },
    ];

    while (this.t.peek().type === 'PLUS') {
      this.t.consume(); // +
      const next = this.t.peek();
      if (next.type === 'ELLIPSIS') {
        this.t.consume();
        parts.push({ ellipsis: true, start: next.offset, end: next.endOffset });
        hasEllipsis = true;
      } else if (next.type === 'TSTR' || next.type === 'RAWSTRING') {
        this.t.consume();
        parts.push(
          next.type === 'RAWSTRING'
            ? {
                text: next.value,
                source: next.raw,
                start: next.offset,
                end: next.endOffset,
              }
            : { text: next.value, start: next.offset, end: next.endOffset }
        );
      } else if (this._isBytesToken(next.type)) {
        this.t.consume();
        parts.push({
          text: this._decodeUtf8(this._decodeBytesToken(next), next),
          // draft-25 §5.1: this part is a byte-string literal decoded to text, not a
          // double-quoted literal — appSeqSourceFeatures must attribute it
          // to `byteString`, not the unpreservable `textString`, since both
          // leave `source` undefined here.
          isByteString: true,
          start: next.offset,
          end: next.endOffset,
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
      const isByteStringFlags = parts.map((p) =>
        'text' in p ? (p.isByteString ?? false) : false
      );
      const spans = parts.map((p) => ({ start: p.start, end: p.end }));
      const joined = texts.join('');
      const ew = this.consumeEncodingIndicator(() =>
        BigInt(textEncoder.encode(joined).length)
      );
      return new CborTextString(joined, {
        ednParts: texts,
        ednPartSpans: spans,
        ...(sources.some((s) => s !== undefined)
          ? { ednPartSources: sources }
          : {}),
        ...(isByteStringFlags.some((b) => b)
          ? { ednPartIsByteString: isByteStringFlags }
          : {}),
        ...(ew !== undefined ? { encodingWidth: ew } : {}),
      });
    }

    // Build 888([...]) with consolidated adjacent text fragments, retaining
    // the original boundaries and raw source spellings within each fragment.
    const items: CborItem[] = [];
    const currentParts: Array<{
      text: string;
      source?: string;
      isByteString?: boolean;
      start: number;
      end: number;
    }> = [];
    const flushCurrentParts = () => {
      const texts = currentParts.map((part) => part.text);
      const currentText = texts.join('');
      if (currentText !== '') {
        const sources = currentParts.map((part) => part.source);
        const isByteStringFlags = currentParts.map(
          (part) => part.isByteString ?? false
        );
        const spans = currentParts.map((part) => ({
          start: part.start,
          end: part.end,
        }));
        const node = new CborTextString(currentText, {
          ednParts: texts,
          ednPartSpans: spans,
          ...(sources.some((source) => source !== undefined)
            ? { ednPartSources: sources }
            : {}),
          ...(isByteStringFlags.some((b) => b)
            ? { ednPartIsByteString: isByteStringFlags }
            : {}),
        });
        // Stamp the generic start/end span so `attachComments` (run once,
        // after the whole tree is built) can attach a comment between this
        // item and its neighbour in `items` as `leading`/`trailing`, exactly
        // like any other array entry — see
        // `CborEllipsis._toCDN`'s text-elision rendering.
        node.start = currentParts[0]!.start;
        node.end = currentParts[currentParts.length - 1]!.end;
        items.push(node);
      }
      currentParts.length = 0;
    };
    for (const part of parts) {
      if ('ellipsis' in part) {
        flushCurrentParts();
        const ellipsisNode = new CborEllipsis();
        ellipsisNode.start = part.start;
        ellipsisNode.end = part.end;
        items.push(ellipsisNode);
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

  /**
   * Comment syntax (if any) for a *core* byte-string token type (never an
   * app-string extension's — those are resolved by extension identity, not
   * token type, since `_isBytesToken` excludes `APP_STRING` and extension
   * prefixes can never take part in `+`/ellipsis concatenation). `BYTES_HEX`
   * (and its elided form) uses the full syntax; `BYTES_B64` only `#`; `SQSTR`
   * none at all.
   */
  private _tokenTypeToCommentSyntax(
    type: string
  ): ByteCommentSyntax | undefined {
    if (type === 'BYTES_HEX') return 'full';
    if (type === 'BYTES_B64') return 'hash-only';
    return undefined;
  }

  private _parseBytesConcat(
    first: Uint8Array,
    firstType: string,
    firstSource: string,
    firstStart: number,
    firstEnd: number
  ): CborByteString | CborEllipsis {
    if (this.t.peek().type !== 'PLUS') {
      const ew = this.consumeEncodingIndicator(() => BigInt(first.length));
      const ednEncoding = this._tokenTypeToCdnEncoding(firstType);
      return new CborByteString(first, {
        ednEncoding,
        ednSource: firstSource,
        ednCommentSyntax: this._tokenTypeToCommentSyntax(firstType),
        ...(ew !== undefined ? { encodingWidth: ew } : {}),
      });
    }
    const initial: ByteEllipsisAtom[] = [
      {
        bytes: first,
        source: firstSource,
        commentSyntax: this._tokenTypeToCommentSyntax(firstType),
        real: false,
        start: firstStart,
        end: firstEnd,
      },
    ];
    const atoms = this._consumeByteEllipsisChain(initial);
    return this._buildFromByteAtoms(
      atoms,
      this._tokenTypeToCdnEncoding(firstType)
    );
  }

  /**
   * Parse a BYTES_HEX_ELIDED token (h'xx...yy') and any trailing + concatenation
   * into a CborEllipsis([h'xx', 888(null), h'yy', ...]).
   */
  private _parseHexElidedConcat(firstTok: Token): CborEllipsis {
    const atoms = this._consumeByteEllipsisChain(
      this._elidedHexAtoms(firstTok.value, firstTok)
    );
    // Always has at least one ellipsis atom — it came from an elided token.
    return this._buildFromByteAtoms(atoms, 'hex') as CborEllipsis;
  }

  /**
   * Consume a `+`-chain of byte-string / `...` / `h'xx...yy'` tokens
   * following an already-parsed first fragment, returning the flattened,
   * source-ordered atom list (`initial` plus everything the chain adds).
   *
   * Each atom carries `real`: whether a genuine `+` from the source
   * precedes it — as opposed to an ellipsis or byte segment that sits
   * *inside* a single `h'xx...yy'` literal's own notation. Two literal
   * tokens can only end up adjacent with no ellipsis between them by
   * sitting across a `+` (a single elided-hex token's internal segments are
   * always ellipsis-separated from each other), so every atom appended here
   * — the first one from each new token, and every atom of a plain
   * (non-elided) byte token — is real; only an elided token's *internal*
   * segments (beyond its first) are not.
   */
  private _consumeByteEllipsisChain(
    initial: ByteEllipsisAtom[]
  ): ByteEllipsisAtom[] {
    const atoms = initial;
    while (this.t.peek().type === 'PLUS') {
      this.t.consume(); // +
      const next = this.t.peek();
      if (next.type === 'ELLIPSIS') {
        this.t.consume();
        atoms.push({
          ellipsis: true,
          real: true,
          fromByteLiteral: false,
          start: next.offset,
          end: next.endOffset,
        });
      } else if (next.type === 'BYTES_HEX_ELIDED') {
        this.t.consume();
        const sub = this._elidedHexAtoms(next.value, next);
        if (sub.length > 0) sub[0]!.real = true;
        pushAll(atoms, sub);
      } else if (this._isBytesToken(next.type)) {
        this.t.consume();
        atoms.push({
          bytes: this._decodeBytesToken(next),
          source: next.raw,
          commentSyntax: this._tokenTypeToCommentSyntax(next.type),
          real: true,
          start: next.offset,
          end: next.endOffset,
        });
      } else if (next.type === 'TSTR' || next.type === 'RAWSTRING') {
        // draft-25 §5.1: when a byte string leads, the right-hand side must also be a
        // byte string.  Text strings are only allowed on the right of a
        // text-leading concatenation.  In non-strict mode we UTF-8 encode
        // the text and continue; in strict mode this is a hard error.
        this.t.consume();
        const mixMsg =
          'text string in a byte-string concatenation is not allowed; ' +
          "use a byte string literal (h'...', b64'...', or '...') instead";
        this._warnOrFail(mixMsg, next);
        atoms.push({
          bytes: textEncoder.encode(next.value),
          real: true,
          start: next.offset,
          end: next.endOffset,
        });
      } else {
        this._fail(
          `expected byte string after +, got ${JSON.stringify(next.value)}`,
          next
        );
      }
    }
    return atoms;
  }

  /** Flatten a single BYTES_HEX_ELIDED token's own `h'xx...yy...zz'` content
   *  into atoms, all marked non-`real`: none of its internal segments sit
   *  across an actual `+`. Every ellipsis atom is `fromByteLiteral: true` —
   *  it came from this literal's own notation, regardless of where within
   *  it (leading, trailing, or in the middle). The caller fixes up the very
   *  first atom's `real` flag if this token itself followed a `+`. */
  private _elidedHexAtoms(
    hexWithEllipsis: string,
    tok: Token
  ): ByteEllipsisAtom[] {
    const segments = hexWithEllipsis.split('...');
    const atoms: ByteEllipsisAtom[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (i > 0)
        atoms.push({
          ellipsis: true,
          real: false,
          fromByteLiteral: true,
          literalSource: tok.raw,
          start: tok.offset,
          end: tok.endOffset,
        });
      if (segments[i].length > 0) {
        atoms.push({
          bytes: this._hexToBytes(segments[i], tok),
          commentSyntax: 'full',
          real: false,
          start: tok.offset,
          end: tok.endOffset,
        });
      }
    }
    return atoms;
  }

  /**
   * Build the final `CborByteString` (no ellipsis anywhere) or `CborEllipsis`
   * from a flattened atom list, consolidating adjacent byte atoms with no
   * ellipsis between them into one `CborByteString` — retaining `ednParts`
   * for a fragment that merged multiple `real` (`+`-joined) atoms — and
   * building a `realBoundary` array parallel to the resulting `CborEllipsis`
   * items, so `preserveConcatenation` can tell real `+` boundaries apart
   * from a `h'xx...yy'` literal's own internal notation regardless of where
   * the `...` falls within it.
   */
  private _buildFromByteAtoms(
    atoms: ByteEllipsisAtom[],
    ednEncoding: 'hex' | 'base64'
  ): CborByteString | CborEllipsis {
    const hasEllipsis = atoms.some((a) => 'ellipsis' in a);
    if (!hasEllipsis) {
      const byteParts = atoms as Array<{
        bytes: Uint8Array;
        source?: string;
        commentSyntax?: ByteCommentSyntax;
        start?: number;
        end?: number;
      }>;
      const concat = this._concatBytes(byteParts.map((p) => p.bytes));
      const ew = this.consumeEncodingIndicator(() => BigInt(concat.length));
      return new CborByteString(concat, {
        ednEncoding,
        ednParts: byteParts,
        ...(ew !== undefined ? { encodingWidth: ew } : {}),
      });
    }

    const items: CborItem[] = [];
    const realBoundary: boolean[] = [];
    const pending: Array<{
      bytes: Uint8Array;
      source?: string;
      commentSyntax?: ByteCommentSyntax;
      real: boolean;
      start?: number;
      end?: number;
    }> = [];
    const flushPending = () => {
      if (pending.length > 0) {
        const node = new CborByteString(
          this._concatBytes(pending.map((p) => p.bytes)),
          {
            // A single fragment (no merge across a real `+`) still needs its
            // own source spelling preserved — e.g. the sole byte atom
            // adjacent to an ellipsis in `h'41' + ...` — so
            // `preserveByteString` has something to round-trip.
            ...(pending.length > 1
              ? {
                  ednParts: pending.map(
                    ({ bytes, source, commentSyntax, start, end }) => ({
                      bytes,
                      source,
                      commentSyntax,
                      start,
                      end,
                    })
                  ),
                }
              : {
                  ednSource: pending[0]!.source,
                  ednCommentSyntax: pending[0]!.commentSyntax,
                }),
          }
        );
        // Stamp the generic start/end span so `attachComments` (run once,
        // after the whole tree is built) can attach a comment between this
        // item and its neighbour in `items` as `leading`/`trailing`, exactly
        // like any other array entry — see `CborEllipsis._renderPreservedBytesElision`.
        node.start = pending[0]!.start;
        node.end = pending[pending.length - 1]!.end;
        items.push(node);
        realBoundary.push(pending[0]!.real);
        pending.length = 0;
      }
    };
    for (const atom of atoms) {
      if ('ellipsis' in atom) {
        flushPending();
        const ellipsisNode = new CborEllipsis(
          atom.fromByteLiteral,
          atom.literalSource
        );
        ellipsisNode.start = atom.start;
        ellipsisNode.end = atom.end;
        items.push(ellipsisNode);
        realBoundary.push(atom.real);
      } else {
        pending.push(atom);
      }
    }
    flushPending();

    return new CborEllipsis(items, realBoundary);
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
    return new CborSimple(n, { ednSource: numTok.raw });
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
    let blankLineBoundary = this.t.lastEndOffset;
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
      const item = this.parseValue();
      if (hasBlankLineBetween(this.t.source, blankLineBoundary, item.start!))
        item.blankLineBefore = true;
      blankLineBoundary = item.end!;
      items.push(item);
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
    let blankLineBoundary = this.t.lastEndOffset;
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
      if (hasBlankLineBetween(this.t.source, blankLineBoundary, key.start!))
        key.blankLineBefore = true;
      this.expect('COLON');
      const val = this.parseValue();
      blankLineBoundary = val.end!;
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
    let blankLineBoundary = this.t.lastEndOffset;
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
      const chunk = this.parseValue();
      if (hasBlankLineBetween(this.t.source, blankLineBoundary, chunk.start!))
        chunk.blankLineBefore = true;
      blankLineBoundary = chunk.end!;
      chunks.push(chunk);
    }
    this.expect('RPAREN');

    if (chunks.length === 0)
      this._fail(
        'empty indefinite group (_ ) is ambiguous; use \'\'_ for bytes or ""_ for text'
      );

    const first = chunks[0];
    // All chunks must be the same type — mixing byte and text strings is
    // a SyntaxError per draft §4.3.
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
    getStoredValue?: () => bigint,
    onToken?: (token: Token) => void
  ): EncodingWidth | undefined {
    if (this.t.peek().type === 'ENCODING_INDICATOR') {
      const tok = this.t.consume();
      onToken?.(tok);
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
      // Per draft-ietf-cbor-edn-literals-27 §4.1, the EI applies to
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
      this._options.onWarning({ message, ...tokenPosition(tok), hint: true });
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
