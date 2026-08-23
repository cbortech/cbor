/**
 * CborExtension interface — the public plugin contract for extending CBOR
 * parsing and serialisation.
 *
 * Defined here (src/extensions/types.ts) rather than in src/types.ts to keep
 * the extension API co-located with its built-in implementations.
 * src/types.ts re-exports this interface so callers can import it from either
 * location.
 */

// Type-only import avoids a runtime circular chain while giving API Extractor
// the real CborItem type: extensions/types → ast/CborItem → types → extensions/types.
import type { CborItem } from '../ast/CborItem';
import type {
  FromCBOROptions,
  FromJSOptions,
  ReadonlyToJSNodeOptions,
} from '../types';
import type { EncodingWidth } from '../cbor/encode';

/**
 * Plugin that extends EDN parsing, CBOR decoding, and `fromJS()` for specific
 * app-string prefixes or CBOR tag numbers.
 *
 * Pass instances via `FromCDNOptions.extensions`, `FromCBOROptions.extensions`,
 * or `FromJSOptions.extensions`.
 *
 * @example
 * // Custom "ip" extension: ip'192.0.2.1' → CborByteString of 4 bytes
 * const ipExtension: CborExtension = {
 *   appStringPrefixes: ['ip'],
 *   parseAppString(_prefix, content) {
 *     return new CborByteString(parseIPv4(content));
 *   },
 * };
 * parseCDN("ip'192.0.2.1'", { extensions: [ipExtension] });
 */
export interface CborExtension {
  /**
   * App-string prefixes this extension handles (e.g. `['dt', 'DT']`).
   * The tokenizer recognises these as `APP_STRING` / `APP_SEQUENCE` tokens.
   */
  readonly appStringPrefixes?: readonly string[];

  /**
   * CBOR tag numbers this extension handles (e.g. `[0n, 1n]`).
   * Extensions with `parseTag()` are invoked for these tag numbers during
   * `fromCBOR()` and integer-tagged EDN items (`1(…)`) in `fromCDN()`.
   */
  readonly tagNumbers?: readonly bigint[];

  /**
   * Parse an app-string literal: `prefix'content'` or `prefix"content"`.
   * Receives the matched `prefix` and the decoded string `content`.
   * Throw `SyntaxError` to report invalid content.
   *
   * The CDN parser always passes an `onError` callback.  Extensions may call
   * `onError(msg)` instead of throwing to emit a recoverable violation; the
   * callback emits a warning and, in strict mode, also throws.  Extensions
   * that ignore `onError` and throw directly always hard-fail regardless of
   * the `strict` setting.
   */
  parseAppString?(
    prefix: string,
    content: string,
    onError?: (msg: string) => void,
    options?: { encodingWidth?: EncodingWidth }
  ): CborItem;

  /**
   * Parse an app-sequence literal: `prefix<<item, ...>>`.
   * Receives the matched `prefix` and the array of parsed CBOR values.
   * If omitted, the `<<...>>` form is rejected with a `SyntaxError`.
   * The `onError` callback follows the same contract as in `parseAppString`.
   */
  parseAppSequence?(
    prefix: string,
    items: CborItem[],
    onError?: (msg: string) => void
  ): CborItem;

  /**
   * Controls how the CDN parser preserves the original app-string
   * / -sequence / raw-tag source text — `prefix'...'`, `` prefix`...` ``,
   * `prefix<<...>>`, or a raw tag literal `N(...)` resolved via `parseTag`
   * — for round-tripping through `toCDN()`.
   *
   * - `true`: the parser wraps the result of `parseAppSequence` (only —
   *   `parseAppString` and `parseTag` results are unaffected) in a
   *   `CborAppSeqResult`, which round-trips the original `<<...>>` notation
   *   unconditionally whenever `appPrefix !== false` (no extra option
   *   needed). Use this when the result has no dedicated subclass whose
   *   identity callers rely on (e.g. `instanceof` checks) — the wrapper
   *   changes the returned node's type.
   * - `'optional'`: for `parseAppString`, `parseAppSequence`, and `parseTag`
   *   results alike, the parser instead sets `appSeqSource` directly on the
   *   *same* result node (preserving its class/identity) and leaves it to
   *   the node's own `_toCDN()` override to decide whether to use it — by
   *   convention, only when `ToCDNOptions.preserveAppPrefix` is set, so
   *   the default output keeps regenerating `prefix'...'` form from the
   *   resolved value. This covers a `` prefix`...` `` (backtick) source, a
   *   non-canonically-spelled `prefix'...'` source, and a raw tag literal
   *   (e.g. `1(1749772800)`) that would otherwise be upgraded to
   *   `prefix'...'` notation — not just `<<...>>`. Use this when the result
   *   is a dedicated subclass whose default behavior is to regenerate its
   *   notation from the resolved value on every call.
   * - `undefined` (default): neither happens. Extensions whose result
   *   already handles source preservation itself (e.g. `CborFloat` via its
   *   own `ednSource` property) should leave this unset.
   *
   * In single-line output (no `indent`), a source spelling that spans
   * multiple lines always falls back to serializing the resolved item,
   * regardless of mode.
   */
  readonly preserveAppSeqSource?: boolean | 'optional';

  /**
   * Called when a `CborTag` is encountered during CBOR decode (`fromCBOR`)
   * or EDN integer-tag parsing (`fromCDN`).
   * Return `undefined` to fall back to the default `CborTag` representation.
   *
   * `options` is supplied only from the binary CBOR decoder; it is `undefined`
   * when called from the CDN parser.  Extensions that perform nested CBOR
   * decoding (e.g. tag 24) should forward these options to propagate
   * `strict`, `onWarning`, and `silent` into the inner decode.
   */
  parseTag?(
    tag: bigint,
    value: CborItem,
    options?: FromCBOROptions
  ): CborItem | undefined;

  /**
   * Called during `fromJS()` for every value before the default conversion
   * logic.  Return `undefined` to fall through to the default behaviour.
   * Typical uses: intercept `Date` instances, or CBOR-tagged plain objects
   * that carry a `Symbol.for('cbor.tag')` key for a registered tag number.
   */
  fromJS?(value: unknown, options: FromJSOptions): CborItem | undefined;

  /**
   * Returns `true` if the given JS value is of a type that this extension's
   * `fromJS()` converts.  When `true`, the replacer pipeline passes the value
   * through as-is instead of decomposing it with `Object.keys()` traversal.
   *
   * Implement this alongside `fromJS` for any class instance type (e.g.
   * `Date`) that must survive the replacer pipeline intact so that `fromJS`
   * can convert it correctly.
   *
   * Implementations may narrow the return type to a type predicate
   * (e.g. `value is Date`) for better static type inference at the call site.
   */
  isJSType?(value: unknown): boolean;

  /**
   * Called during `toJS()` for every node, before that node's own default
   * conversion, when this extension is listed in `ToJSOptions.extensions`.
   * Return `undefined` to fall through to the next extension (then, if none
   * claim the node, its own default conversion). Typically checks the
   * node's class/shape (e.g. `item instanceof CborTaggedEpochDtExt`) rather
   * than a tag number, since app-string forms without a wrapping tag (e.g.
   * `dt'...'`) never reach `parseTag`-style tag-number dispatch either.
   *
   * The result is wrapped in `{ value }` — rather than returned directly —
   * so a legitimate conversion result of `undefined` (CBOR `undefined`,
   * simple 23) can be distinguished from "this extension doesn't handle
   * this node".
   *
   * `options` never carries a `reviver` — its type is
   * `ReadonlyToJSNodeOptions`, not `ToJSOptions` — so this hook has no way
   * to make its result depend on whether one is present. That matters
   * because `CborArray`/`CborMap.toObject`, when a `reviver` *is* present
   * elsewhere in the call, convert each child more than once: once (with
   * `reviver` itself stripped, though `itemOptions`/`extensions` stay
   * active) to pre-populate a holder visible to an *earlier* sibling's own
   * reviver call as `this[j]`, and once more, for real, to compute the
   * value the container actually keeps. This hook is offered each of those
   * conversions independently — once per visit, not deduplicated across
   * them — precisely so that a `this[j]` observation reflects this hook's
   * conversion (e.g. a `Date`) rather than the node's un-converted default.
   * `options.extensions`, if present, is likewise a fresh copy each call —
   * mutating it in place has no effect elsewhere.
   * A deeply nested structure can multiply this further: a container
   * several levels down may run its own such pre-population pass while
   * itself sitting inside an *outer* container's pre-population pass, so
   * the same node can in principle be offered to this hook more than
   * twice. Whatever this hook returns for one visit only ever affects that
   * visit's own value; reviving of the value a *container* holds still
   * happens afterwards, exactly once per visit, in that container itself.
   */
  toJS?(
    item: CborItem,
    options: ReadonlyToJSNodeOptions
  ): { value: unknown } | undefined;
}
