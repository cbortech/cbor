/**
 * Shared option types and plugin interfaces.
 */

// ─── Omit sentinel ───────────────────────────────────────────────────────────

/**
 * Sentinel returned from a replacer or reviver to omit the key/element from
 * the output.  Use this instead of returning `undefined` when `undefinedOmits`
 * is `false` (the default) and you need to drop a specific entry.
 *
 * Accessible as `CBOR.OMIT` on the main class.
 */
export const CBOR_OMIT: unique symbol = Symbol('cbor.omit');

// ─── Extension plugin ─────────────────────────────────────────────────────────
// Defined in extensions/types.ts and re-exported here for convenience.
export type { CborExtension } from './extensions/types';
import type { CborExtension } from './extensions/types';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ToHexDumpOptions {
  /**
   * Indentation per nesting level.
   * - `number`: number of spaces (e.g. `3` → `"   "`)
   * - `string`: literal indent string (e.g. `'\t'`)
   * @default 3
   */
  indent?: number | string;
  /** Comment marker used in the hex dump. Default: `'--'` */
  commentStyle?: '--' | '#';
}

export interface ToJSOptions {
  /**
   * How to represent CBOR integer values (major type 0 / 1) in JavaScript.
   * - `'auto'`: `number` when the value is within the safe integer range
   *   (±`Number.MAX_SAFE_INTEGER`), `bigint` otherwise.
   * - `'number'`: always `number` (precision may be lost for large values).
   * - `'bigint'`: always `bigint`.
   * @default 'auto'
   */
  integerAs?: 'auto' | 'number' | 'bigint';

  /**
   * How to represent CBOR map values when converting to JavaScript.
   * - `'auto'`: text-string-only keys → `Record<string, unknown>`,
   *   other key types → `Map<unknown, unknown>`.
   *   Duplicate keys are silently overwritten (last value wins).
   * - `'object'`: always `Record<string, unknown>` — non-string keys are
   *   converted via `String()`. Duplicate keys are overwritten (last wins).
   * - `'entries'`: always `MapEntries` (a typed `Array` subclass) — preserves all
   *   entries including duplicate keys (§2.6.3 of draft-ietf-cbor-edn-literals-25).
   *   `fromJS()` recognises `MapEntries` instances and converts them back to `CborMap`.
   * @default 'auto'
   */
  mapAs?: 'auto' | 'object' | 'entries';

  /**
   * When `true`, CBOR tag annotations are omitted from the JavaScript value.
   *
   * By default, generic tags are preserved using `CBOR.Tag` so that
   * `toJS()` → `fromJS()` can round-trip CBOR tags. Enable this option when
   * you only need the tagged content as a plain JavaScript value.
   *
   * @default false
   */
  stripTags?: boolean;

  /**
   * Post-conversion reviver function, applied bottom-up after the CBOR value
   * has been converted to JavaScript.
   *
   * Called for every key/value pair — including map entries with non-string
   * keys — and finally for the root value with key `''`.
   * Return `CBOR.OMIT` to remove the entry from its parent container.
   * When `undefinedOmits` is `true`, returning `undefined` also removes the
   * entry (matching `JSON.parse` behavior).
   *
   * Note: this option is honoured by `CborItem.toJS()` and the `CBOR.*`
   * shortcut methods.  Calling `_toJS()` directly bypasses it.
   */
  reviver?: (this: unknown, key: unknown, value: unknown) => unknown;

  /**
   * When `true`, a reviver returning `undefined` removes the entry from its
   * parent container, matching `JSON.parse` behavior.
   * When `false` (default), only `CBOR.OMIT` removes an entry; returning
   * `undefined` keeps the entry as CBOR `undefined` (simple 23).
   * @default false
   */
  undefinedOmits?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ToCBOROptions {}

export interface FromCBOROptions {
  /**
   * Byte offset within the supplied input at which CBOR decoding starts.
   * Useful for reading one item from a CBOR Sequence.
   *
   * @default 0
   */
  offset?: number;

  /**
   * Allow bytes after the decoded item.
   *
   * When `false`, decoding still requires the item to consume the remaining
   * input, preserving the historical single-item behaviour. Set this to `true`
   * when using `CborItem.end` to continue decoding a CBOR Sequence.
   *
   * @example
   * // Read two items from a CBOR Sequence, validating that the second is last.
   * const first = CBOR.fromCBOR(bytes, { allowTrailing: true });
   * const second = CBOR.fromCBOR(bytes, { offset: first.end });
   *
   * @default false
   */
  allowTrailing?: boolean;

  /**
   * Extension plugins applied during CBOR decoding.
   * Extensions with `parseTag()` are invoked when a tagged item is
   * encountered; returning a non-`undefined` value replaces the default
   * `CborTag` node.
   */
  extensions?: CborExtension[];
}

/**
 * Options for parsing an annotated hex dump.
 */
export interface FromHexDumpOptions {
  /**
   * Extension plugins applied during CBOR decoding.
   * Extensions with `parseTag()` are invoked when a tagged item is encountered;
   * returning a non-`undefined` value replaces the default `CborTag` node.
   */
  extensions?: CborExtension[];
}

export interface FromCDNOptions {
  /**
   * Character offset within the supplied text at which CDN parsing starts.
   * Leading whitespace/comments at or after this offset are skipped as usual.
   *
   * @default 0
   */
  offset?: number;

  /**
   * Allow tokens after the parsed item.
   *
   * When `false`, parsing still requires the item to consume the remaining
   * input, preserving the historical single-item behaviour. Set this to `true`
   * when using `CborItem.end` to continue parsing a CDN sequence.
   * Top-level comma separators are not skipped by `fromCDN()` itself; handle
   * them in sequence-level code before passing the next `offset`. For example,
   * after parsing `1, 2`, the first item's `end` points just before the comma;
   * advance past that comma before parsing the next item.
   *
   * @example
   * // Read two whitespace-separated items, validating that the second is last.
   * const first = CBOR.fromCDN(text, { allowTrailing: true });
   * const second = CBOR.fromCDN(text, { offset: first.end });
   *
   * @default false
   */
  allowTrailing?: boolean;

  /**
   * Extension plugins for CDN parsing.
   * Each extension declares which app-string prefixes (and, in future, tag
   * numbers) it handles via `appStringPrefixes` / `tagNumbers`, and provides
   * callback methods that return `CborItem`-subclassed objects controlling
   * subsequent serialisation.
   *
   * User-supplied extensions take priority over the built-in `dt`/`DT`
   * extension for the same prefix.
   */
  extensions?: CborExtension[];

  /**
   * How to handle unrecognised application-extension identifiers
   * (§4.1 of draft-ietf-cbor-edn-literals-25).
   *
   * - `'cpa999'`: wrap the literal in a `CPA999` tag
   *   (`CborUnresolvedAppExt`) instead of failing. The resulting node
   *   round-trips through `toCDN()` back to the original notation.
   * - `'error'`: throw `SyntaxError` for unknown prefixes.
   * @default 'cpa999'
   */
  unresolvedExtension?: 'cpa999' | 'error';

  /**
   * When `true`, byte-string chunks in text string concatenation
   * (`"a" + h'...'`) that are not valid UTF-8 are decoded with the Unicode
   * replacement character (U+FFFD) instead of throwing a `SyntaxError`.
   *
   * The CBOR text string type (RFC 8949 §3.1) requires valid UTF-8;
   * enabling this option produces non-conformant output and should only be
   * used when interoperating with lenient producers.
   *
   * @default false
   */
  allowInvalidUtf8?: boolean;

  /**
   * Preserve comments found between CDN values and attach them to the AST.
   *
   * Comments are metadata only: they are ignored by CBOR binary encoding and
   * JavaScript conversion. Use together with `ToCDNOptions.preserveComments`
   * to include them when formatting back to CDN.
   *
   * @default false
   */
  preserveComments?: boolean;
}

/**
 * Options for parsing Concise Diagnostic Notation (CDN).
 *
 * @deprecated Use `FromCDNOptions` instead.
 */
export type FromEDNOptions = FromCDNOptions;

export interface FromJSOptions {
  /**
   * Extension plugins applied during `fromJS()`.
   * Extensions with `fromJS()` are given first chance to convert each value.
   */
  extensions?: CborExtension[];

  /**
   * How to encode integer-valued JS `number`s.
   * - `'int'`: encode as CborUint / CborNint
   * - `'float'`: always encode as CborFloat
   * @default 'int'
   */
  encodeIntegerAs?: 'int' | 'float';

  /**
   * How to encode `Uint8Array` values.
   * - `'bytes'`: encode as CborByteString
   * - `'array'`: encode as CborArray of CborUint
   * @default 'bytes'
   */
  uint8ArrayAs?: 'bytes' | 'array';

  /**
   * Pre-encoding replacer function or key allowlist, applied before the
   * JavaScript value is converted to a CBOR AST node.
   *
   * - Function: called for every key/value pair (including `MapEntries`
   *   entries with non-string keys).  Return `CBOR.OMIT` to remove the entry.
   *   When `undefinedOmits` is `true`, returning `undefined` also removes it.
   * - Array of strings/numbers: allowlist of object keys to include.
   *   `MapEntries` entries retain all entries; their values are recursively
   *   filtered.
   *
   * Note: this option is honoured by `fromJS()` and the `CBOR.*` shortcut
   * methods.
   */
  replacer?:
    | ((this: unknown, key: unknown, value: unknown) => unknown)
    | (string | number)[];

  /**
   * When `true`, a replacer returning `undefined` removes the entry from the
   * output, matching `JSON.stringify` behavior.
   * When `false` (default), only `CBOR.OMIT` removes an entry; returning
   * `undefined` keeps the entry as CBOR `undefined` (simple 23).
   * @default false
   */
  undefinedOmits?: boolean;
}

export interface ToCDNOptions {
  /**
   * Indentation for pretty-printing.
   * - `number`: number of spaces
   * - `string`: literal indent string (e.g. `'\t'`)
   * - omit for single-line output
   */
  indent?: number | string;

  /**
   * Emit comments previously captured by `FromCDNOptions.preserveComments`.
   *
   * When enabled for containers, comment-bearing arrays/maps are emitted in
   * multi-line form even if `indent` is omitted.
   *
   * @default false
   */
  preserveComments?: boolean;

  /**
   * Re-emit byte string literals parsed from CDN using their original source
   * text when available.
   *
   * This preserves the spelling and interior layout of non-concatenated
   * `h'...'`, `b64'...'`, `b32'...'`, `h32'...'`, raw-backtick byte strings,
   * and single-quoted byte strings, including comments inside those literals.
   * Byte strings produced by `+` concatenation are normalised as usual.
   *
   * When enabled, this takes precedence over `bstrEncoding` and `sqstr` for
   * byte strings that carry original EDN source text.
   *
   * @default false
   */
  preserveByteString?: boolean;

  /**
   * Whether to emit commas between array/map elements.
   * - `'comma'`: emit commas (`[1, 2, 3]`)
   * - `'none'`: omit commas, use spaces only (`[1 2 3]`)
   * - `'trailing'`: emit commas including a trailing comma after the last element
   * @default 'comma'
   */
  commas?: 'comma' | 'none' | 'trailing';

  /**
  /**
   * Fallback binary encoding for byte string literals when sqstr is not applicable.
   * - `'hex'`: `h'...'`
   * - `'base64'`: `b64'...'`
   * - `'base64url'`: `b64'...'` (base64url alphabet)
   * - `'base32'`: `b32'...'`
   * - `'base32hex'`: `h32'...'`
   * @default 'hex'
   */
  bstrEncoding?: 'hex' | 'base64' | 'base64url' | 'base32' | 'base32hex';

  /**
   * Whether to prefer single-quoted string form (`sqstr`) for byte strings.
   * - `'printable-string'`: emit `'...'` when the bytes are valid UTF-8 and
   *   contain no control characters; fall back to `bstrEncoding` otherwise.
   * - `'string'`: emit `'...'` when the bytes are valid UTF-8;
   *   fall back to `bstrEncoding` otherwise.
   * - `'none'`: never emit sqstr; always use `bstrEncoding`.
   * @default 'printable-string'
   */
  sqstr?: 'printable-string' | 'string' | 'none';

  /**
   * Whether to use application-string / app-sequence notation for built-in
   * extensions (e.g. `dt'...'`, `DT'...'`, `ip'...'`, `IP'...'`).
   * - `true`: emit extension notation (`DT'2023-01-01T12:00:00Z'`)
   * - `false`: emit raw CBOR notation (`1(-14159024)`, `52(h'c000022a')`)
   * @default true
   */
  appStrings?: boolean;

  /**
   * Numeric format for integer values in CDN output.
   * - `'decimal'`: standard decimal notation (e.g. `42`, `-14159024`)
   * - `'hex'`: hexadecimal notation (e.g. `0x2a`, `-0xd83130`)
   * - `'octal'`: octal notation (e.g. `0o52`, `-0o67061560`)
   * - `'binary'`: binary notation (e.g. `0b101010`, `-0b110110000011000100110000`)
   * @default 'decimal'
   */
  intFormat?: 'decimal' | 'hex' | 'octal' | 'binary';

  /**
   * Numeric format for floating-point values in CDN output.
   * - `'decimal'`: standard decimal notation (e.g. `1.5`, `145544.0_3`)
   * - `'hex'`: C99-style hex float notation (e.g. `0x1.8p+0`, `0x1.1c54p+17_3`)
   * @default 'decimal'
   */
  floatFormat?: 'decimal' | 'hex';

  /**
   * Split long text strings using CDN string concatenation syntax (`"a" + "b"`).
   * Only effective when `indent` is specified.
   *
   * - `'newline'`: split at newline characters
   * - `'cdn'`: split according to CDN structure when the string content
   *                is parseable as CDN (JSON superset)
   * - `'cboredn'`: deprecated alias for `'cdn'`
   *
   * When both are specified, CDN structure split points are combined with
   * newline split points.
   */
  textStringFormat?: TextStringFormat[];
}

export type TextStringFormat = 'newline' | 'cdn' | DeprecatedTextStringFormat;

/** @deprecated Use `'cdn'` instead. */
export type DeprecatedTextStringFormat = 'cboredn';

/**
 * Options for serializing Concise Diagnostic Notation (CDN).
 *
 * @deprecated Use `ToCDNOptions` instead.
 */
export type ToEDNOptions = ToCDNOptions;

export interface CborComment {
  kind: 'line' | 'block';
  marker: '#' | '//' | '/*' | '/';
  text: string;
  start: number;
  end: number;
  line: number;
  col: number;
}

export interface CborComments {
  leading?: CborComment[];
  trailing?: CborComment[];
  dangling?: CborComment[];
}

/**
 * Combined options for the `CBOR` constructor.
 *
 * These defaults are applied to every subsequent method call on the instance.
 * Per-call options always take precedence over these defaults.
 *
 * Note: `encodeIntegerAs` (from {@link FromJSOptions}) and `integerAs` (from
 * {@link ToJSOptions}) are distinct fields and do not conflict.
 */
export type CBOROptions = FromCDNOptions &
  FromJSOptions &
  ToCBOROptions &
  ToCDNOptions &
  ToJSOptions &
  ToHexDumpOptions;
