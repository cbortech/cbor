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
import type { FromCBOROptions, FromJSOptions } from '../types';
import type { EncodingWidth } from '../cbor/encode';

/**
 * Plugin that extends EDN parsing, CBOR decoding, and `fromJS()` for specific
 * application-string prefixes or CBOR tag numbers.
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
   * When `true`, the CDN parser wraps the result of `parseAppSequence` in a
   * `CborAppSeqResult` so that `toCDN()` round-trips the original
   * `prefix<<...>>` notation when `appStrings !== false`.
   *
   * Extensions whose result is already a subclass that handles source
   * preservation itself (e.g. `CborFloat` via its `ednSource` property) should
   * leave this unset.
   */
  readonly preserveAppSeqSource?: boolean;

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
}
