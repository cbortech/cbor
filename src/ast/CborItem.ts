import type {
  CBOROptions,
  ToCDNOptions,
  ToJSOptions,
  ToHexDumpOptions,
  ToCBOROptions,
  CborComment,
  CborComments,
  DecodeWarning,
  ParseWarning,
} from '../types';
import { CBOR_OMIT } from '../types';
import {
  convertCommentText,
  resolveIndent,
  splitLeadingComments,
  shouldEmitComments,
  resolveCommentStyle,
} from '../cdn/serialize-utils';
import { CborWriter } from '../cbor/encode';
import { bytesToSpacedHexUpper } from '../utils/hex';

/** @internal One line of an annotated hex dump. */
export interface AnnotatedLine {
  depth: number;
  hex: string;
  comment: string;
}

export interface AppSeqEncodingEdit {
  /** Start/end offsets within appSeqSource of an existing indicator. */
  start: number;
  end: number;
  /** Replacement used by encodingIndicators: 'always'. */
  always: string;
  /** Replacement used by encodingIndicators: 'never'. */
  never: string;
}

/**
 * Original literal features used by the sole item inside a preserved
 * `prefix<<item>>` source. They let serialization honour an explicitly
 * disabled sibling `preserve*` option instead of replaying that literal
 * verbatim through `preserveAppPrefix`.
 */
export interface AppSeqSourceFeatures {
  byteString?: boolean;
  textString?: boolean;
  rawString?: boolean;
  concatenation?: boolean;
}

/**
 * Fill in every `preserve*` option left `undefined` with `true`, for
 * `ToCDNOptions.preserveAll` — except the deprecated `preserveTextString`,
 * which no longer participates in `preserveAll`. An option the caller
 * explicitly set (including to `false`) is left untouched.
 *
 * `preserveComments` is only filled in with `true` (verbatim) when
 * `comments` is *also* left unset — an explicit `comments` with no
 * `preserveComments` should still normalize comments to that style under
 * `preserveAll`, not be overridden by the verbatim fill-in (see
 * `ToCDNOptions.preserveComments`).
 *
 * Assumes `preserveAppPrefix` has already been resolved from the
 * deprecated `preserveAppSequence` alias by the caller (see `toCDN()`); like
 * `preserveTextString`, the deprecated name itself no longer participates
 * directly. (`appStrings`/`appPrefix` aren't part of the `preserve*` family
 * and don't participate in `preserveAll` at all.)
 */
function expandPreserveAll(options: ToCDNOptions): ToCDNOptions {
  return {
    ...options,
    preserveComments:
      options.comments !== undefined
        ? options.preserveComments
        : (options.preserveComments ?? true),
    preserveByteString: options.preserveByteString ?? true,
    preserveRawString: options.preserveRawString ?? true,
    preserveConcatenation: options.preserveConcatenation ?? true,
    preserveNumberFormat: options.preserveNumberFormat ?? true,
    preserveAppPrefix: options.preserveAppPrefix ?? true,
    preserveBlankLines: options.preserveBlankLines ?? true,
  };
}

/**
 * Resolve deprecated `ToCDNOptions` aliases — `preserveAppSequence` into
 * `preserveAppPrefix`, and `appStrings` into `appPrefix` — for whichever
 * canonical name was left unset by the caller. Each canonical name always
 * wins over its deprecated alias when both are explicitly set.
 */
function resolveDeprecatedAppPrefixAliases(
  options: ToCDNOptions
): ToCDNOptions {
  if (
    options.preserveAppSequence === undefined &&
    options.appStrings === undefined
  )
    return options;
  return {
    ...options,
    preserveAppPrefix: options.preserveAppPrefix ?? options.preserveAppSequence,
    appPrefix: options.appPrefix ?? options.appStrings,
  };
}

/**
 * Abstract base class for all CBOR AST nodes.
 *
 * Every node can serialize itself to CBOR binary, CDN text, and a
 * plain JavaScript value.  Concrete implementations are provided in each
 * subclass (added in later phases).
 */
export abstract class CborItem {
  /**
   * Character offset of the first character of this item in the parsed source.
   * Set by parsers; undefined when the node was constructed directly.
   * For CBOR input this is a byte offset.
   */
  start?: number;

  /**
   * Character offset just past the last character of this item in the parsed source.
   * Set by parsers; undefined when the node was constructed directly.
   * For CBOR input this is a byte offset.
   */
  end?: number;

  /**
   * Comments captured from CDN source when `preserveComments` is enabled.
   * They do not affect CBOR bytes or JS conversion.
   */
  comments?: CborComments;

  /**
   * `true` when this node is an array/map entry (or indefinite-length
   * string chunk) immediately preceded by a blank line in the parsed CDN
   * source — set unconditionally by the parser, regardless of any
   * `preserve*` option, mirroring `start`/`end`. Only consulted by
   * `toCDN()` when `ToCDNOptions.preserveBlankLines` is set; otherwise
   * ignored. Left `undefined` for nodes not parsed as a container entry, or
   * with no blank line before them.
   */
  blankLineBefore?: boolean;

  /**
   * Original app-string/-sequence source text — `prefix'...'`,
   * `` prefix`...` ``, or `prefix<<...>>` — set by the parser when the
   * resolving extension declares `preserveAppSeqSource: 'optional'`. A
   * subclass's own `_toCDN()` override may check this (gated behind
   * `ToCDNOptions.preserveAppPrefix`) to round-trip the exact original
   * spelling instead of always regenerating `prefix'...'` notation from the
   * resolved value. Left `undefined` for nodes not parsed from one of these
   * forms.
   */
  appSeqSource?: string;

  /**
   * Comments contained within `appSeqSource`, with `start`/`end` offsets
   * relative to that string. These spans allow comment markers to be
   * converted (or comments to be removed) without regenerating and thereby
   * losing the original app-string/-sequence notation.
   */
  appSeqComments?: CborComment[];

  /**
   * Source edits for encoding indicators contained in a raw-tag
   * `appSeqSource`. Includes zero-width edits where an indicator was absent
   * so `encodingIndicators: 'always'` can insert one without regenerating
   * the surrounding source.
   */
  appSeqEncodingEdits?: AppSeqEncodingEdit[];

  /**
   * `false` when `appSeqEncodingEdits` does not cover every encoding
   * indicator nested inside a raw-tag `appSeqSource` — i.e. its content
   * contains a node type `collectContentEncodingEdits` doesn't know how to
   * edit (e.g. a `CborMap`, `CborTag`, or indefinite-length string inside an
   * `ip` array). Left `undefined` (treated as complete) when coverage is
   * exhaustive, which holds for every tag content type `dt` accepts and for
   * most content `ip` accepts. When `false`, `decideTaggedAppSeqRendering`
   * must not choose the `'source'` decision under `encodingIndicators !==
   * 'auto'`, since surgical span edits would silently leave the uncovered
   * node's indicator unchanged; it falls back to `'structural'` instead.
   */
  appSeqEncodingEditsComplete?: boolean;

  /**
   * For an `appSeqSource` parsed from `prefix<<item>>` notation: the offset
   * within `appSeqSource`, relative to its own start, where the sole inner
   * item's own consumption ends — i.e. right after its own encoding
   * indicator, if it had one. Lets `adjustAppSeqIndicator` locate and strip
   * that inner indicator exactly, regardless of what (whitespace, a
   * trailing comma, a comment) separates it from the closing `>>`, rather
   * than pattern-matching text near `>>`. `undefined` when `appSeqSource`
   * isn't `<<...>>` notation, or wasn't captured with a single inner item.
   */
  appSeqInnerEnd?: number;

  /**
   * Literal-preservation features present in the sole item of a captured
   * `prefix<<item>>` source. Used to resolve explicitly disabled
   * `preserve*` options without treating unrelated options as conflicts.
   */
  appSeqSourceFeatures?: AppSeqSourceFeatures;

  /**
   * Validity violations detected while decoding or parsing this node.
   * Populated when `strict: false` is set in `FromCBOROptions` or
   * `FromCDNOptions`.
   */
  warnings?: (DecodeWarning | ParseWarning)[];

  /**
   * Default options bound by a {@link CBOR} instance factory method.
   * Per-call options always take precedence.
   * @internal
   */
  _defaults?: CBOROptions;

  /**
   * @internal
   * True when this node is, or contains through wrapper nodes (tags,
   * app-sequence results), an array or map. `inlineLeafContainers` never
   * inlines a container whose entries contain another container, even one
   * that renders on a single line. `CborEmbeddedCBOR` (`<<...>>`) is the one
   * exception: it inlines its own entries based purely on whether they
   * render without a line break, regardless of this flag — see its
   * `_toCDN()`, which omits `entryIsLeaf` for that reason.
   */
  get _containsCdnContainer(): boolean {
    return false;
  }

  /**
   * @internal
   * True when this node's own text content (a text string, or a byte
   * string that would render as bare sqstr text) has two or more words —
   * `inlineLeafContainers` never collapses a container whose entries hold
   * such a string onto the container's own line, even though the entry
   * itself has no nested array/map, since a multi-word string reads better
   * with room of its own. See `isMultiWordText()`/`isMultiWordByteString()`
   * in `cdn/serialize-utils.ts`. Takes `options` because whether a byte
   * string even renders as text (`'...'`) rather than a prefixed literal
   * (`h'...'`, `b64'...'`, ...) depends on the `sqstr` option.
   *
   * This method deliberately does *not* also cover the "is this (or does
   * it wrap) a prefixed literal" question — a prefixed literal has no word
   * count to check, but still disqualifies under the strict rule (and, per
   * `strict`, is an ordinary leaf under the loose one). That's handled
   * generically elsewhere instead, from the *actual rendered text* rather
   * than predicted from this node's type: `isPrefixedLiteralText` for a
   * bare entry (`serializeContainer` checks it against the already
   * rendered `s`), or `isMultiWordRenderedLiteral` for `CborTag`, which
   * overrides this method entirely to tokenize its own `_toCDN()` output
   * instead of delegating here — necessary because a `CborTag` subclass
   * (`CborTaggedIpExt`, `CborTaggedEpochDtExt`, ...) may override `_toCDN()`
   * to render something that doesn't look like generic `tagNum(content)`
   * notation at all, which a semantic prediction from `this.content` alone
   * could never know about.
   *
   * `strict` (default `true`) is passed down by whichever container's own
   * `_toCDN` directly holds this entry: `true` for the strict rule
   * (`CborArray`/`CborMap`, and `CborIndefiniteTextString`/
   * `CborIndefiniteByteString` too — all four provide `entryIsLeaf`),
   * `false` only for `CborEmbeddedCBOR` (`<<...>>`), the one container
   * whose collapse isn't gated behind `inlineLeafContainers` at all and
   * the only one that omits `entryIsLeaf`. This base implementation and
   * `CborTextString`/`CborByteString`'s overrides ignore `strict` (a text
   * string's, or byte string's own sqstr-text, word count is unaffected by
   * it either way) — only `CborTag` (and, transitively, `CborAppSeqResult`
   * delegating to its inner value) actually consult it.
   */
  _isMultiWordText(
    _options: ToCDNOptions | undefined,
    _strict = true
  ): boolean {
    return false;
  }

  // ─── Public template methods ────────────────────────────────────────────────

  /** Serialize this node to CBOR binary. */
  toCBOR(options?: ToCBOROptions): Uint8Array {
    const merged = this._defaults ? { ...this._defaults, ...options } : options;
    const writer = new CborWriter();
    this._encode(writer, merged);
    return writer.finish();
  }

  /** Serialize this node to a CDN text string. */
  toCDN(options?: ToCDNOptions): string {
    let merged = this._defaults ? { ...this._defaults, ...options } : options;
    if (merged) merged = resolveDeprecatedAppPrefixAliases(merged);
    if (merged?.preserveAll) merged = expandPreserveAll(merged);
    const body = this._toCDN(merged, 0);
    // Single-line output strips comments: `#`/`//` comments need a newline
    // to terminate, so they cannot be emitted without breaking the guarantee
    // that single-line output contains no newlines.
    if (!shouldEmitComments(merged) || resolveIndent(merged) === null)
      return body;
    const style = resolveCommentStyle(merged);
    const { ownLines, inlinePrefix } = splitLeadingComments(this, '', style);
    const trailing = this.comments?.trailing ?? [];
    const bodyWithTrailing =
      trailing.length === 0
        ? body
        : `${body} ${trailing.map((c) => convertCommentText(c, style).trimEnd()).join(' ')}`;
    return [...ownLines, `${inlinePrefix}${bodyWithTrailing}`].join('\n');
  }

  /**
   * Serialize this node to a CDN text string.
   *
   * @deprecated Use `toCDN()` instead.
   */
  toEDN(options?: ToCDNOptions): string {
    return this.toCDN(options);
  }

  /**
   * Convert this CBOR AST node to a plain JavaScript value.
   *
   * If `options.reviver` is supplied it is called with key `''` on the root
   * result after the full tree has been converted (matching the semantics of
   * `JSON.parse`).  Container nodes call the reviver on each of their direct
   * children during conversion, so the walk is bottom-up.
   */
  toJS(options?: ToJSOptions): unknown {
    const merged = this._defaults ? { ...this._defaults, ...options } : options;
    const result = this._toJS(merged);
    if (!merged?.reviver) return result;
    const rv = merged.reviver.call({ '': result }, '', result);
    return rv === CBOR_OMIT ? undefined : rv;
  }

  /**
   * Generate an RFC 8949 §3 style annotated hex dump of this value.
   *
   * @example
   * const cbor = CBOR.fromCDN('[_ 1, [2, 3]]');
   * console.log(cbor.toHexDump());
   * // 9F        -- Start indefinite-length array
   * //    01     -- 1
   * //    82     -- Array of length 2
   * //       02  -- 2
   * //       03  -- 3
   * //    FF     -- "break"
   * // FF        -- "break"
   */
  toHexDump(options?: ToHexDumpOptions): string {
    let merged: (ToHexDumpOptions & ToCDNOptions) | undefined = this._defaults
      ? { ...this._defaults, ...options }
      : options;
    if (merged) merged = resolveDeprecatedAppPrefixAliases(merged);
    const raw = merged?.indent ?? 3;
    const indentStr = typeof raw === 'string' ? raw : ' '.repeat(raw);
    const marker = (merged?.commentStyle ?? '--') + ' ';
    const lines = this._toHexDump(0, merged);
    // A plain loop, not Math.max(...spread): spreading one argument per line
    // overflows the call stack for items with hundreds of thousands of lines.
    let maxPrefixLen = 0;
    for (const l of lines) {
      const prefixLen = l.depth * indentStr.length + l.hex.length;
      if (prefixLen > maxPrefixLen) maxPrefixLen = prefixLen;
    }
    const col = maxPrefixLen + 2;
    return lines
      .map((l) => {
        const prefix = indentStr.repeat(l.depth) + l.hex;
        return prefix.padEnd(col) + marker + l.comment;
      })
      .join('\n');
  }

  // ─── Internal abstract methods ───────────────────────────────────────────────

  /**
   * @internal
   * Encode this node into `writer`, honoring `_toCBOR()` overrides.
   *
   * This is the entry point used by `toCBOR()` and by container nodes when
   * recursing into children.  A subclass that overrides `_toCBOR()` (e.g. to
   * emit a pre-computed bit pattern) is authoritative even when one of its
   * built-in base classes implements `_encodeTo()`.
   */
  _encode(writer: CborWriter, options?: ToCBOROptions): void {
    if (this._toCBOR !== CborItem.prototype._toCBOR) {
      writer.writeBytes(this._toCBOR(options));
      return;
    }
    this._encodeTo(writer, options);
  }

  /**
   * @internal
   * Write this node's CBOR encoding into `writer`.
   *
   * Built-in nodes override this so that an entire encode pass shares one
   * growing buffer (no per-node Uint8Array allocations or re-copies).
   * Container implementations must recurse via `child._encode()`, never
   * `child._encodeTo()`, so that `_toCBOR()` overrides are honored.
   */
  _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    if (this._toCBOR === CborItem.prototype._toCBOR)
      throw new TypeError(
        'CborItem subclass must implement _encodeTo() or _toCBOR()'
      );
    writer.writeBytes(this._toCBOR(options));
  }

  /**
   * @internal
   * Subclass CBOR encoding implementation.
   * The default builds the bytes via `_encodeTo()`; subclasses may instead
   * override this method directly when producing a standalone byte array is
   * more natural (e.g. emitting a pre-computed bit pattern).
   */
  _toCBOR(options?: ToCBOROptions): Uint8Array {
    const writer = new CborWriter();
    this._encodeTo(writer, options);
    return writer.finish();
  }

  /**
   * @internal
   * Depth-aware CDN serialization.
   * Leaf nodes receive `depth` but may ignore it.
   * Container nodes use `depth` for indentation and call
   * `child._toCDN(options, depth + 1)` when recursing.
   */
  abstract _toCDN(options: ToCDNOptions | undefined, depth: number): string;

  /**
   * @internal
   * Core conversion logic implemented by each subclass.
   * Container nodes apply `options.reviver` to their direct children.
   * Do not call this directly — use `toJS()` instead.
   */
  abstract _toJS(options?: ToJSOptions): unknown;

  /**
   * @internal
   * Collect annotated-hex lines for this node.
   * Leaf nodes emit a single line; container nodes override to emit
   * open/close lines with recursively collected children.
   */
  _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const hex = bytesToSpacedHexUpper(this._toCBOR());
    return [{ depth, hex, comment: this._toCDN(options, 0) }];
  }
}
