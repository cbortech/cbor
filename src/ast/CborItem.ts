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
  ItemContext,
  ReadonlyToJSNodeOptions,
  CdnItemContext,
  ReadonlyToCDNOptions,
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
 * Resolve deprecated `ToCDNOptions` aliases within an `itemOptions` override
 * *in isolation*, before it is merged onto the ambient effective options.
 *
 * `resolveDeprecatedAppPrefixAliases` only fills in a canonical name when
 * that name is itself left `undefined` on the object it's given. An override
 * like `{ appStrings: false }` must be resolved against *itself* — where
 * `appPrefix` is absent — not against the already-merged effective options,
 * where an ancestor's resolved `appPrefix: true` would already occupy
 * that slot and win, silently discarding the child's own alias-based
 * override (this is `_resolveCdnOptions`'s exact bug this guards against).
 *
 * Because `resolveDeprecatedAppPrefixAliases` unconditionally assigns
 * `preserveAppPrefix`/`appPrefix` (via `??`) whenever either deprecated name
 * is set, resolving against the override alone can introduce a literal
 * `undefined` for a canonical key the override never mentioned (e.g.
 * `preserveAppPrefix: undefined` from an override that only ever touched
 * `appStrings`). Copying that back verbatim would overwrite an inherited
 * value with `undefined` instead of leaving it untouched, so only a
 * genuinely resolved (non-`undefined`) key is copied into the result.
 */
function normalizeCdnOverride(
  override: Partial<ToCDNOptions>
): Partial<ToCDNOptions> {
  if (
    override.preserveAppSequence === undefined &&
    override.appStrings === undefined
  )
    return override;
  const resolved = resolveDeprecatedAppPrefixAliases(override as ToCDNOptions);
  const result: Partial<ToCDNOptions> = { ...override };
  if (resolved.preserveAppPrefix !== undefined)
    result.preserveAppPrefix = resolved.preserveAppPrefix;
  if (resolved.appPrefix !== undefined) result.appPrefix = resolved.appPrefix;
  return result;
}

/**
 * @internal
 * Shared, frozen empty path passed as the default `path` argument to
 * `_toJS()`/`_toJSChild()` so that not using `itemOptions` never allocates a
 * path array.
 */
const EMPTY_PATH: readonly unknown[] = Object.freeze([]);

/**
 * @internal
 * Cheap upfront check for whether per-node option/extension resolution is
 * needed at all for a given `toJS()` options object. Container nodes use
 * this to choose between the plain `child._toJS(options)` recursion (when
 * `false`, identical cost to before `itemOptions`/`extensions` existed) and
 * `child._toJSChild(options, path, ctx)` (when `true`).
 */
export function needsItemDispatch(options: ToJSOptions | undefined): boolean {
  return !!(options?.itemOptions || options?.extensions?.length);
}

/**
 * @internal
 * Options for a reviver-driven container's "raw" structural pre-population
 * pass (see `CborArray`/`CborMap.toObject`) — `reviver` removed, everything
 * else (including `itemOptions`/`extensions`) left as-is.
 *
 * This pass's output is never returned to the caller as the final result —
 * every position it computes is unconditionally overwritten by the *real*
 * (revived) pass's own result before `toJS()` returns — but it is not
 * write-only scaffolding either: a `reviver` reads it directly, as `this[j]`
 * for a not-yet-processed sibling `j`, while deciding how to revive an
 * *earlier* sibling (matching `JSON.parse`'s own reviver contract, which
 * this replicates). That value must reflect `itemOptions`/`extensions`
 * exactly as the real pass would — e.g. an `integerAs: 'bigint'` override
 * for position `j` — or a reviver reading `this[j]` would see the wrong
 * type. So `itemOptions`/`extensions` stay active here, unlike `reviver`
 * itself.
 *
 * Running dispatch during this pass is safe only because callers building
 * a child's occurrence for it — `CborArray`/`CborMap.toObject` — insert
 * `RAW_PASS_MARKER` into that occurrence (see `Occurrence`), so its
 * resolutions are filed under a different `DispatchCache` key than the
 * real pass's and can never be reused *by* the real pass, however many
 * ancestor levels apart the two passes are. That distinction matters for
 * more than consistency — a composite (non-scalar) map key is itself
 * revived differently between the two passes (this pass leaves its own
 * nested content entirely unrevived, matching `this[j]`'s contract above;
 * the real pass revives it normally), so a value node whose
 * `ItemContext.path` is built from that key's converted JS value would
 * otherwise see a stale, pre-revival path if the real pass reused this
 * pass's cached decision.
 */
export function withoutReviver(
  options: ToJSOptions | undefined
): ToJSOptions | undefined {
  if (!options) return options;
  return { ...options, reviver: undefined };
}

/**
 * @internal
 * Build the `reviver`-free, `extensions`-copied view of `options` handed
 * to code that must not be able to mutate options actually in effect
 * elsewhere in the tree — `ItemContext.options` and the `options`
 * parameter of `CborExtension.toJS()` — see `ReadonlyToJSNodeOptions`.
 *
 * A plain `{ ...options, reviver: undefined }` spread (as `withoutReviver`
 * does) is not enough here: `extensions`, if present, would still be the
 * *same array* `options.extensions` is, so `.push()`/`.splice()`/etc. on
 * the copy would still mutate the original in place — corrupting it for
 * this node's own later use, its siblings, and the caller. `extensions` is
 * the only field on `ToJSOptions` that's an ordinary mutable container, so
 * it's the only one that needs its own copy here.
 */
export function toReadonlyNodeOptions(
  options: ToJSOptions
): ReadonlyToJSNodeOptions {
  const { reviver: _reviver, extensions, ...rest } = options;
  return extensions ? { ...rest, extensions: [...extensions] } : rest;
}

/**
 * @internal
 * Symbol-keyed slot, stashed on the top-level `toJS()` options object,
 * holding the per-call dispatch cache (see `DispatchCache` below). Reading
 * and writing through this indirection (rather than a typed field on
 * `ToJSOptions`) keeps the cache out of the public option surface while
 * still surviving every `{ ...options, ...override }` copy made while
 * resolving `itemOptions` overrides — object spread carries own-enumerable
 * symbol-keyed properties along with string-keyed ones — so the *same*
 * cache reaches every node touched by one `toJS()` call, however deep.
 */
const kDispatchCache = Symbol('cbor.itemOptions.dispatchCache');

/**
 * @internal
 * A node's resolved `itemOptions`/`extensions` outcome at one occurrence,
 * cached across the duplicate visits that occurrence can receive within
 * one `toJS()` call (see `DispatchCache`).
 *
 * - `'value'`: an extension's `toJS()` hook matched and fully resolved this
 *   occurrence — reused verbatim on a later visit to the same occurrence,
 *   since the hook never even sees `reviver` itself (see `_toJSChild`'s
 *   stripped `hookOptions`) and so cannot have produced a result that
 *   depends on it; only the container holding the *returned* value still
 *   applies reviver to it, once per visit, as usual.
 * - `'override'`: `options.itemOptions()` ran (and no extension matched);
 *   `override` is its raw return value, applied at use time as
 *   `{ ...options, ...override }` rather than stored pre-merged.
 */
type DispatchOutcome =
  | { kind: 'value'; value: unknown }
  | { kind: 'override'; override: Partial<ToJSOptions> | undefined };

/**
 * @internal
 * Stable, allocation-light identifier for "this occurrence of a node" —
 * used only to key `DispatchCache` lookups, never exposed via
 * `ItemContext`. Built exactly the way `ItemContext.path` is (accumulated
 * from the root, one element per container level, unchanged through a
 * tag/app-sequence wrapper), but from *structural* container positions —
 * an array index, or a map entry's ordinal paired with a `'k'`/`'v'` role
 * tag (see `CborArray`/`CborMap`) — rather than from the JS values `path`
 * is built from.
 *
 * That distinction matters in two ways `path` alone (or even `path` plus
 * only the *immediate* container's identity) does not cover:
 *
 * - A composite (non-scalar) map key re-converts to a *new* array/object
 *   every time its JS value is asked for, so two visits to the very same
 *   logical position produce `path`s that are structurally equal but not
 *   reference-equal at that segment — unusable for matching.
 * - Two different positions can legitimately produce the very same `path`,
 *   when duplicate map entries carry equal keys (e.g. two `"a"` entries).
 * - A *container* (not just a leaf) can itself be a shared node instance
 *   reused at two positions (e.g. the same `CborArray` placed at two
 *   different indices of an outer array). Matching only on `{immediate
 *   parent identity, local slot}` — as an earlier version of this type
 *   did — correctly distinguishes the *container's own* two occurrences,
 *   but not its *descendants'*: each of the shared container's children
 *   would resolve `{parent: <the shared container>, slot: <local index>}`
 *   identically regardless of which of the container's own two
 *   occurrences was being converted, silently conflating them. Chaining
 *   the full occurrence from the root — rather than just one level —
 *   avoids this: the shared container's own two occurrences differ
 *   earlier in the chain, so appending the same local slot to each still
 *   yields two different full chains for its children.
 *
 * A local slot only needs to be unique among its own container's direct
 * children — `CborArray` uses the element index (`number`) directly;
 * `CborMap` prefixes a map entry's ordinal with `'k'`/`'v'`
 * (`` `k${i}` ``/`` `v${i}` ``) so a key and its own value, which share an
 * ordinal, don't collide.
 *
 * `RAW_PASS_MARKER` (see below) is the one non-structural element this
 * chain can contain: `CborArray`/`CborMap.toObject` insert it — once,
 * immediately before that level's own local slot — only when building a
 * child's occurrence for their raw structural pre-population pass (see
 * `withoutReviver`), never for the real, revived pass. That's what lets
 * `_toJSChild`'s cache correctly tell apart the *distinct* raw-pass
 * resolutions a single occurrence can otherwise receive when more than one
 * ancestor level forks — e.g. the very same value node visited once
 * through an outer container's own raw pass (before *any* ancestor has
 * revived anything) and once more through a different, inner container's
 * own raw pass nested inside the outer's real pass (after some ancestor,
 * such as a composite map key, *has* already been revived) — two visits
 * that share every structural coordinate yet must not share a cached
 * decision, since what a reviver-sensitive value like that key converts to
 * differs between them (see `DispatchCacheEntry`). A container that isn't
 * itself forking (no `reviver` in its own options, so it takes the plain,
 * unsplit path) never inserts the marker — it simply passes the
 * occurrence chain it was given through unchanged before extending it with
 * its own children's local slots, the same way it always did.
 */
export type Occurrence = readonly unknown[];

/**
 * @internal
 * Sentinel inserted into an `Occurrence` chain by `CborArray`/
 * `CborMap.toObject` when building a child's occurrence for their own raw
 * structural pre-population pass — see `Occurrence`'s own note. A
 * dedicated symbol rather than a string/number so it can never collide
 * with an ordinary local slot value (an array index or a `` `k${i}` ``/
 * `` `v${i}` `` map-entry tag).
 */
export const RAW_PASS_MARKER: unique symbol = Symbol(
  'cbor.itemOptions.rawPass'
);

/**
 * @internal
 * The root value's occurrence, for `toJS()`'s own top-level `_toJSChild()`
 * call — empty, the same way `ItemContext.path` is empty at the root. Also
 * used by `CborTag`/`CborAppSeqResult` as a defensive fallback if `_toJS()`
 * is ever invoked without an `occurrence` (only possible via a direct,
 * non-`toJS()` call to `_toJS()`, which the dispatch cache never sees).
 */
export const ROOT_OCCURRENCE: Occurrence = Object.freeze([]);

/**
 * @internal
 * One resolved occurrence of a node, cached under that node in
 * `DispatchCache`. `occurrence` identifies *which* occurrence this is — a
 * single `CborItem` instance can legitimately appear at more than one
 * occurrence in a hand-built tree (e.g. the same shared node reused at two
 * array indices, or as the value of two entries sharing a duplicate map
 * key — or, transitively, as a descendant of such a shared node), and a
 * reviver-driven container's raw structural pre-population pass (see
 * `withoutReviver`) produces yet more distinct occurrences of its own for
 * the very same node, via `RAW_PASS_MARKER` — see `Occurrence`. A later
 * visit only reuses `outcome` once `occurrence` matches elementwise —
 * seeing this node again at a *different* occurrence (a distinct
 * `DispatchCacheEntry` in the same node's list, see `DispatchCache`)
 * resolves fresh instead, exactly as if no caching were happening for that
 * occurrence yet.
 *
 * The raw pass's own resolutions are never reused by the real, revived
 * pass (or vice versa) purely because their occurrences differ by
 * `RAW_PASS_MARKER` — not because of any separate bookkeeping — so
 * `itemOptions`/an extension's `toJS()` hook can run more than once for
 * what looks like "the same node" from the outside: once for each
 * distinct raw pass it's reachable through (there can be more than one,
 * nested — see `Occurrence`), plus once more for the real pass. That is
 * the accepted cost of a raw pass's placeholder value being observable
 * (`this[j]` for a not-yet-processed sibling `j`, inside an *earlier*
 * sibling's own reviver call) and therefore needing to reflect
 * `itemOptions`/`extensions` accurately rather than being computed as if
 * neither were configured.
 */
interface DispatchCacheEntry {
  occurrence: Occurrence;
  outcome: DispatchOutcome;
}

/**
 * @internal
 * One `toJS()` call's dispatch cache, keyed by node identity, each node
 * mapped to the list of occurrences resolved for it so far (almost always
 * exactly one — see `DispatchCacheEntry`). Exists because `CborArray`/
 * `CborMap` (with a `reviver`) and any nesting through `CborTag`/
 * `CborAppSeqResult` wrappers each visit the *same* occurrence more than
 * once — see `DispatchOutcome` — and `itemOptions`/an extension's `toJS()`
 * hook must still each run exactly once per occurrence, since either may be
 * stateful or otherwise have observable side effects.
 */
type DispatchCache = WeakMap<CborItem, DispatchCacheEntry[]>;

function getDispatchCache(
  options: ToJSOptions | undefined
): DispatchCache | undefined {
  return (options as Record<symbol, unknown> | undefined)?.[kDispatchCache] as
    DispatchCache | undefined;
}

/**
 * @internal
 * Attach a fresh dispatch cache to a top-level `toJS()` call's merged
 * options. Called once per `toJS()` invocation (never by internal
 * recursion), so unrelated calls never share a cache.
 */
function withDispatchCache(options: ToJSOptions): ToJSOptions {
  const cache: DispatchCache = new WeakMap();
  return Object.assign({}, options, { [kDispatchCache]: cache });
}

function sameOccurrence(a: Occurrence, b: Occurrence): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @internal
 * Find the cached entry (if any) for the exact occurrence among a node's
 * previously-resolved occurrences.
 */
function findOccurrence(
  entries: DispatchCacheEntry[] | undefined,
  occurrence: Occurrence
): DispatchCacheEntry | undefined {
  return entries?.find((e) => sameOccurrence(e.occurrence, occurrence));
}

/**
 * @internal
 * Record a newly-resolved occurrence, appending to (rather than replacing)
 * whatever occurrences of this node were already recorded — see
 * `DispatchCacheEntry`.
 */
function recordOccurrence(
  cache: DispatchCache,
  node: CborItem,
  entry: DispatchCacheEntry
): void {
  const existing = cache.get(node);
  if (existing) existing.push(entry);
  else cache.set(node, [entry]);
}

// ─── toCDN() per-item dispatch ──────────────────────────────────────────────
//
// Much simpler than toJS()'s: there is no reviver, so no scenario ever
// needs a node's itemOptions decision to be tied to *which* of two
// differently-revived contexts produced it — the one thing DispatchCache's
// whole occurrence/RAW_PASS_MARKER design exists for. toCDN() already has
// its own, unrelated reason a node can be rendered more than once per
// parent render (see `CdnItemContext`'s own doc), and the existing code's
// own answer to that (see `serializeContainer` in cdn/serialize-utils.ts)
// is to accept it rather than cache around it — a real, resolved
// instance-level cache having already turned out unsafe there (see
// `CborTag._isMultiWordText`). So `itemOptions` here just resolves fresh
// on every call, with no cache at all.

/**
 * @internal
 * Cheap upfront check for whether per-node option resolution is needed at
 * all for a given `toCDN()` options object — the `toCDN()` analogue of
 * `needsItemDispatch`.
 */
export function needsCdnItemDispatch(
  options: ToCDNOptions | undefined
): boolean {
  return !!options?.itemOptions;
}

/**
 * @internal
 * Build the copied-`textStringFormat` view of `options` handed to
 * `CdnItemContext.options` — the `toCDN()` analogue of
 * `toReadonlyNodeOptions`; see `ReadonlyToCDNOptions`. Also strips
 * `CDN_OVERRIDE_TRACKER` (see there) — `ctx.options` is documented as
 * reflecting the current *effective options*, so it should never expose an
 * internal, out-of-band bookkeeping key that isn't part of `ToCDNOptions` at
 * all, even though it isn't otherwise observable through any named field.
 */
export function toReadonlyCdnOptions(
  options: ToCDNOptions
): ReadonlyToCDNOptions {
  const { textStringFormat, ...rest } = options as ToCDNOptions & {
    [CDN_OVERRIDE_TRACKER]?: CdnOverrideTrackerBox;
  };
  delete rest[CDN_OVERRIDE_TRACKER];
  return textStringFormat
    ? { ...rest, textStringFormat: [...textStringFormat] }
    : rest;
}

/**
 * @internal
 * Out-of-band symbol key that lets a caller (currently only
 * `CborAppSeqResult._toCDN`) track, across an entire `_resolveCdnOptions()`
 * subtree, whether `itemOptions` ever actually returned an override —
 * without touching `options.itemOptions` itself.
 *
 * `CborAppSeqResult` needs to know whether its preserved verbatim source is
 * still exactly right after offering `itemOptions` a chance to override one
 * of its descendants (see its own doc). Wrapping `options.itemOptions` in a
 * tracking function was tried first, but that function becomes
 * `ctx.options.itemOptions` for every descendant (`_resolveCdnOptions`
 * builds `ctx.options` from the very `options` it was given) — a pure
 * `itemOptions` callback could tell it apart from the caller's own function
 * by identity, observing a difference between an ordinary subtree and one
 * reached through an app-sequence wrapper that `ctx.options`'s "current
 * effective options" contract never promises.
 *
 * A symbol-keyed property on `options` instead survives every
 * `{...options, ...override}` merge `_resolveCdnOptions` performs exactly
 * the same way `itemOptions` itself does (object spread copies symbol keys
 * too, and by reference — the same tracker box is shared, never cloned, by
 * every node in the subtree), while never being part of the public
 * `ToCDNOptions` shape or observable through any named field — see
 * `toReadonlyCdnOptions`, which explicitly strips it before building
 * `ctx.options`.
 */
export const CDN_OVERRIDE_TRACKER: unique symbol = Symbol('cdnOverrideTracker');

/** @internal Mutable box referenced (never copied) via `CDN_OVERRIDE_TRACKER`. */
export interface CdnOverrideTrackerBox {
  applied: boolean;
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
   *
   * `path` is this entry's own full path (see `CdnItemContext.path`),
   * passed down by the same caller for the same reason `renderEntry`
   * receives it: `CborTag`/`CborAppSeqResult` re-render `this` here (see
   * their own overrides) purely to answer this method's question, and that
   * re-render must resolve any of *its own* descendants' `itemOptions`
   * against the entry's real path — not an empty one — or a descendant
   * several levels inside a tag-wrapped entry could see a different
   * `ctx.path` here than the real render further down gives it. Only
   * `CborTag`/`CborAppSeqResult` consult it; every other override ignores
   * it, the same as `strict`.
   */
  _isMultiWordText(
    _options: ToCDNOptions | undefined,
    _strict = true,
    _path?: readonly unknown[]
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
    const eff = this._resolveCdnOptions(merged, EMPTY_PATH, {});
    const body = this._toCDN(eff, 0, EMPTY_PATH);
    // Single-line output strips comments: `#`/`//` comments need a newline
    // to terminate, so they cannot be emitted without breaking the guarantee
    // that single-line output contains no newlines.
    if (!shouldEmitComments(eff) || resolveIndent(eff) === null) return body;
    const style = resolveCommentStyle(eff);
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
    const result = needsItemDispatch(merged)
      ? this._toJSChild(
          withDispatchCache(merged!),
          EMPTY_PATH,
          ROOT_OCCURRENCE,
          {}
        )
      : this._toJS(merged);
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
   * Container nodes use `depth` for indentation and, when recursing, must
   * resolve each child's options via `child._resolveCdnOptions()` first
   * (rather than passing `options` straight through) so `itemOptions` is
   * honored for every node, not just the root — see `_resolveCdnOptions`.
   * `path` is this node's own full path from the root (see
   * `CdnItemContext.path`); only meaningful when `needsCdnItemDispatch()`
   * is `true` for the options in effect — leaf implementations that don't
   * recurse can ignore it, as can any implementation when dispatch isn't
   * in play.
   */
  abstract _toCDN(
    options: ToCDNOptions | undefined,
    depth: number,
    path?: readonly unknown[]
  ): string;

  /**
   * @internal
   * Resolve `options.itemOptions` for this node (if any), returning the
   * options a caller should use for both this node's own `_toCDN()` call
   * and (via `_isMultiWordText()`) any layout probe of it — see
   * `CdnItemContext`. Unlike `toJS()`'s `_toJSChild()`, this never caches:
   * see the "toCDN() per-item dispatch" note above `needsCdnItemDispatch`
   * for why that's both unnecessary and, per this codebase's own prior
   * experience with `CborTag._isMultiWordText`, unsafe here specifically.
   *
   * `ctx` follows the same "no `key`, derived from `path`'s last element"
   * convention `_toJSChild()` uses (see there) — a caller passes
   * `parent`/`keyNode`/`isMapKey` only; `key` is filled in here.
   */
  _resolveCdnOptions(
    options: ToCDNOptions | undefined,
    path: readonly unknown[],
    ctx: Omit<CdnItemContext, 'path' | 'key' | 'options'>
  ): ToCDNOptions | undefined {
    if (!needsCdnItemDispatch(options)) return options;
    const key =
      ctx.isMapKey || path.length === 0 ? undefined : path[path.length - 1];
    const override = options!.itemOptions!(this, {
      ...ctx,
      key,
      path,
      options: toReadonlyCdnOptions(options!),
    });
    if (!override) return options;
    const tracker = (
      options as ToCDNOptions & {
        [CDN_OVERRIDE_TRACKER]?: CdnOverrideTrackerBox;
      }
    )[CDN_OVERRIDE_TRACKER];
    if (tracker) tracker.applied = true;
    // Normalize the override's own deprecated aliases *before* merging: see
    // `normalizeCdnOverride` for why resolving them after merging would let
    // an already-resolved, inherited canonical value silently outrank the
    // child's own alias-based override.
    let eff: ToCDNOptions = { ...options, ...normalizeCdnOverride(override) };
    if (eff.preserveAll) eff = expandPreserveAll(eff);
    return eff;
  }

  /**
   * @internal
   * Core conversion logic implemented by each subclass.
   * Container nodes apply `options.reviver` to their direct children, and
   * must recurse via `child._toJSChild()` (never `child._toJS()` directly)
   * so that `options.itemOptions`/`options.extensions` are honored for
   * every node, not just the root — see `_toJSChild`.
   * `path` is this node's own full path from the root (see `ItemContext.path`);
   * only meaningful, and only ever non-empty, when `needsItemDispatch()` is
   * `true` for the options in effect — leaf implementations that don't
   * recurse can ignore it. `occurrence` is this node's own cache-matching
   * identity (see `Occurrence`) — `CborArray`/`CborMap` build on it to
   * derive their children's own occurrences, and `CborTag`/`CborAppSeqResult`
   * pass it through unchanged to their content's `_toJSChild()` call; leaf
   * implementations that don't recurse can ignore it.
   * Do not call this directly — use `toJS()` instead.
   */
  abstract _toJS(
    options?: ToJSOptions,
    path?: readonly unknown[],
    occurrence?: Occurrence
  ): unknown;

  /**
   * @internal
   * Entry point container nodes must use when recursing into a child during
   * `toJS()`, instead of calling `child._toJS(options)` directly, so that
   * `options.itemOptions` and `options.extensions` (toJS hooks) are honored
   * for every node in the tree, not just the root.
   *
   * Guarded by `needsItemDispatch()` at each call site rather than
   * internally, so that containers can skip straight to the cheap
   * `child._toJS(options)` call — matching pre-`itemOptions` behavior
   * exactly, with no extra allocation — whenever neither option is in play
   * for the whole conversion.
   *
   * `path` is this child's own full path from the root, already computed by
   * the caller: `[...parentPath, key]` for an array element or map
   * entry/key, or the parent's own `path` unchanged for a transparent
   * wrapper's content (`CborTag`, `CborAppSeqResult`) — see
   * `ItemContext.path`. `ctx.key` is *not* supplied by the caller — it's
   * derived here from `path`'s own last element (or left `undefined` for
   * the root and for `isMapKey` visits), which is what keeps a wrapper's
   * content correctly reporting its outer key: since `CborTag`/
   * `CborAppSeqResult` pass their own unmodified `path` straight through,
   * that derivation naturally recovers the tag's own key for its content
   * too, matching `ItemContext.key`'s documented invariant of always
   * equalling `path`'s last element outside those two exceptions.
   *
   * `occurrence` identifies this child's position for cache-matching
   * purposes only (see `Occurrence`) — deliberately separate from `path`,
   * which is built from *converted JS values* and so is unreliable for
   * that: matching on `path` alone either double-resolves the same position
   * (a composite map key converts to a fresh, non-`===` array/object every
   * time) or wrongly conflates two different positions that happen to
   * convert to equal `path`s (duplicate map entries with equal keys).
   * `occurrence` avoids both by construction — see `Occurrence`.
   *
   * A single node can be visited more than once *at the same occurrence* in
   * one `toJS()` call — a `reviver`-driven `CborArray`/`CborMap` converts
   * each child once to pre-populate an unrevived holder and once more to
   * compute the revived value (see their own `_toJS()`), and either pass
   * may itself recurse through a `CborTag`/`CborAppSeqResult` wrapper that
   * adds no occurrence of its own (content shares the wrapper's). The raw
   * pre-population pass's own occurrence for a child is distinguished from
   * the real pass's by `RAW_PASS_MARKER` (see `Occurrence`), so that even
   * distinct, *nested* raw passes reaching the same node — one from an
   * outer container's own split, one from a different, inner container's
   * own split nested inside the outer's real pass — resolve independently
   * rather than colliding with each other. Neither `options.itemOptions`
   * nor an `extensions` `toJS()` hook may run more than once for the same
   * occurrence despite all that, since either may be stateful — so the
   * *decision* (not the reviver-dependent application of an `itemOptions`
   * override — see `DispatchOutcome`) is cached in `options`'s dispatch
   * cache, when one is present, and reused on a later visit to that exact
   * occurrence. A node *reused* at more than one occurrence (the same
   * `CborItem` instance placed at two positions in a hand-built tree)
   * still resolves once per occurrence, never conflating two different
   * ones.
   */
  _toJSChild(
    options: ToJSOptions | undefined,
    path: readonly unknown[],
    occurrence: Occurrence,
    ctx: Omit<ItemContext, 'path' | 'key' | 'options'>
  ): unknown {
    const cache = getDispatchCache(options);
    const cached = findOccurrence(cache?.get(this), occurrence);
    if (cached) {
      if (cached.outcome.kind === 'value') return cached.outcome.value;
      const eff = cached.outcome.override
        ? { ...options, ...cached.outcome.override }
        : options;
      return this._toJS(eff, path, occurrence);
    }

    const key =
      ctx.isMapKey || path.length === 0 ? undefined : path[path.length - 1];
    let eff = options;
    let override: Partial<ToJSOptions> | undefined;
    if (options?.itemOptions) {
      // `ctx.options` is `options` itself, read-only and with `extensions`
      // (if any) copied — see `toReadonlyNodeOptions` — so the callback
      // can't corrupt what this node, its siblings, or the caller see by
      // mutating what it read. Computed fresh here (never cached) so it
      // always reflects exactly what's in effect for *this* call, not a
      // stale snapshot from an earlier resolution of the same occurrence.
      override = options.itemOptions(this, {
        ...ctx,
        key,
        path,
        options: toReadonlyNodeOptions(options),
      });
      if (override) eff = { ...options, ...override };
    }
    if (eff?.extensions?.length) {
      // Hooks never see `reviver` (see `ReadonlyToJSNodeOptions`) — not
      // merely by convention, but because its type omits the field — so
      // their result can never itself depend on it, which is what makes
      // caching that result across a reviver-driven container's repeat
      // visits sound. `extensions` is likewise copied — freshly for *each*
      // hook, not once and shared across the loop — so one hook mutating
      // it in place (bypassing the readonly type) can't leak into what a
      // later hook in the same loop sees.
      for (const ext of eff.extensions) {
        const hooked = ext.toJS?.(this, toReadonlyNodeOptions(eff));
        if (hooked) {
          if (cache)
            recordOccurrence(cache, this, {
              occurrence,
              outcome: { kind: 'value', value: hooked.value },
            });
          return hooked.value;
        }
      }
    }
    if (cache)
      recordOccurrence(cache, this, {
        occurrence,
        outcome: { kind: 'override', override },
      });
    return this._toJS(eff, path, occurrence);
  }

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
