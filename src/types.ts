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

/**
 * A CBOR validity violation detected during decoding.
 */
export interface DecodeWarning {
  /** Human-readable description of the violation. */
  message: string;
  /** Byte offset within the decoded input where the violation was detected. */
  offset: number;
}

/**
 * A CDN/EDN validity violation detected during parsing.
 */
export interface ParseWarning {
  /** Human-readable description of the violation. */
  message: string;
  /** Character offset within the input text where the violation was detected. */
  offset?: number;
  /** Line number (1-based) where the violation was detected. */
  line?: number;
  /** Column number (1-based) where the violation was detected. */
  column?: number;
  /**
   * Character offset just past the end of the offending range, when the
   * violation is attributable to a specific token. Lets tooling underline
   * the exact range instead of a single position.
   */
  endOffset?: number;
  /**
   * `true` when the violation is a hard syntax error that stopped parsing
   * (emitted by non-strict sequence parsing, which reports the failure as a
   * warning and abandons the rest of the input). Tooling should present
   * fatal warnings as errors.
   */
  fatal?: boolean;

  /**
   * `true` when this entry is an informational hint (e.g. an app-string
   * prefix matches a known optional extension that isn't registered) rather
   * than a validity violation. Parsing is unaffected either way, but tooling
   * that treats `onWarning` calls as failures (see `CBOR.validate()`) should
   * not count these against validity.
   */
  hint?: boolean;

  /**
   * For a `fatal` warning built from a caught syntax error (see
   * `CdnSyntaxError`), the original error object with its position fields
   * intact. `CBOR.validate()` promotes this into `ValidateResult.error`.
   */
  cause?: Error;
}

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
   * input, preserving the historical single-item behaviour. With `strict: false`
   * a trailing byte becomes a recoverable warning rather than an error, but
   * truly malformed trailing data (e.g. truncated items) still throws. Set this
   * to `true` when using `CborItem.end` to continue decoding a CBOR Sequence.
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

  /**
   * Override the default set of bundled application-oriented extensions
   * (`dt`, `ip`, `cri`, `t1`, `b1`, `ilbs`, `ilts`, `float`).
   *
   * - omitted (default): use the standard bundled set.
   * - array: replace the bundled set with exactly these extensions.
   * - `false`: disable all of them.
   *
   * `bignum` (tags 2/3) and embedded-CBOR (tag 24) support are core RFC 8949
   * representation features, not application-oriented extensions, and are
   * always active regardless of this option.
   *
   * `dt`, `ip`, `t1`, and `b1` are mandatory-to-implement per §2.1 of
   * draft-ietf-cbor-edn-literals-26; disabling them produces a decoder that
   * no longer conforms to that recommendation. This is intended for
   * allowlisting scenarios (see §7 Security considerations of the same
   * draft) where an application wants explicit control over which
   * extensions it accepts.
   */
  builtinExtensions?: CborExtension[] | false;

  /**
   * Controls how CBOR validity violations are handled.
   *
   * - `true` (default): violations call `onWarning` and then throw, stopping
   *   decoding immediately.
   * - `false`: recoverable violations call `onWarning` and decoding continues
   *   with a best-effort interpretation of the data.
   *
   * Truly malformed data (e.g. truncated input, reserved AI values) always
   * throws regardless of this setting. Trailing bytes after a successfully
   * decoded item are a recoverable violation and are therefore controlled by
   * this flag.
   *
   * @default true
   */
  strict?: boolean;

  /**
   * Callback invoked when a CBOR validity violation is detected.
   *
   * In strict mode (the default), this is called before the error is thrown.
   * In non-strict mode (`strict: false`), this is called and decoding
   * continues.
   *
   * If not supplied and `silent` is not `true`, violations are reported via
   * `console.warn`.
   */
  onWarning?: (warning: DecodeWarning) => void;

  /**
   * When `true`, suppresses the default `console.warn` output for validity
   * violations.  An explicit `onWarning` callback is still invoked even when
   * `silent` is `true`.
   *
   * @default false
   */
  silent?: boolean;
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

  /**
   * Override the default set of bundled application-oriented extensions.
   * Mirrors `FromCBOROptions.builtinExtensions`.
   */
  builtinExtensions?: CborExtension[] | false;

  /**
   * Controls how CBOR validity violations are handled during hex-dump decoding.
   * Mirrors `FromCBOROptions.strict`. With `strict: false`, trailing bytes after
   * the first decoded item (i.e. a CBOR Sequence) emit a warning instead of
   * throwing, allowing the first item to be returned.
   *
   * @default true
   */
  strict?: boolean;

  /**
   * Callback invoked when a CBOR validity violation is detected.
   * Mirrors `FromCBOROptions.onWarning`.
   */
  onWarning?: (warning: DecodeWarning) => void;

  /**
   * When `true`, suppresses the default `console.warn` output for violations.
   * Mirrors `FromCBOROptions.silent`.
   *
   * @default false
   */
  silent?: boolean;
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
   * input, preserving the historical single-item behaviour. With `strict: false`
   * a trailing token becomes a recoverable warning rather than an error, but
   * hard lexer errors in the trailing content (e.g. unterminated strings) still
   * throw. Set this to `true` when using `CborItem.end` to continue parsing a
   * CDN sequence.
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
   * Override the default set of bundled application-oriented extensions
   * (`dt`, `ip`, `cri`, `t1`, `b1`, `ilbs`, `ilts`, `float`).
   *
   * - omitted (default): use the standard bundled set.
   * - array: replace the bundled set with exactly these extensions.
   * - `false`: disable all of them; app-string literals using their
   *   prefixes then fall through to `unresolvedExtension` handling.
   *
   * `dt`, `ip`, `t1`, and `b1` are mandatory-to-implement per §2.1 of
   * draft-ietf-cbor-edn-literals-26; disabling them produces a parser that
   * no longer conforms to that recommendation. This is intended for
   * allowlisting scenarios (see §7 Security considerations of the same
   * draft) where an application wants explicit control over which
   * extensions it accepts from untrusted CDN input.
   *
   * @example
   * // Only accept dt/DT — everything else becomes an Unresolved (tag 999) node.
   * import { CBOR, dt } from '@cbortech/cbor';
   * CBOR.fromCDN(text, { builtinExtensions: [dt] });
   */
  builtinExtensions?: CborExtension[] | false;

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
   * The string values `'c-style'` and `'cdn-style'` are treated as `true`
   * for parsing purposes; they become meaningful when passed to `toCDN()`.
   *
   * @default false
   */
  preserveComments?: boolean | 'c-style' | 'cdn-style';

  /**
   * Controls how CDN/EDN validity violations are handled.
   *
   * - `true` (default): recoverable violations call `onWarning` and then throw.
   * - `false`: recoverable violations call `onWarning` and parsing continues
   *   with a best-effort interpretation of the input.
   *
   * Hard syntax errors (e.g. unterminated strings, unexpected tokens that
   * prevent parsing a value) always throw regardless of this setting.
   * A trailing token after a successfully-parsed value is a recoverable
   * violation and is therefore controlled by this flag.
   *
   * @default true
   */
  strict?: boolean;

  /**
   * Callback invoked when a CDN/EDN validity violation is detected.
   *
   * In strict mode (the default), this is called before the error is thrown.
   * In non-strict mode (`strict: false`), this is called and parsing continues.
   *
   * If not supplied and `silent` is not `true`, violations are reported via
   * `console.warn`.
   */
  onWarning?: (warning: ParseWarning) => void;

  /**
   * When `true`, suppresses the default `console.warn` output for validity
   * violations.  An explicit `onWarning` callback is still invoked even when
   * `silent` is `true`.
   *
   * @default false
   */
  silent?: boolean;
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
   * Override the default set of bundled application-oriented extensions.
   * Mirrors `FromCDNOptions.builtinExtensions`. Only affects builtins that
   * implement `fromJS()` / `parseTag()` (none of the bundled application
   * extensions implement `fromJS()` by default — use `dt_as_Date` via
   * `extensions` for `Date` round-tripping).
   */
  builtinExtensions?: CborExtension[] | false;

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
   * - `true`: emit comments with their original markers.
   * - `'c-style'`: emit comments, normalising line comments to `//` and block
   *   comments to `/* … *\/`.
   * - `'cdn-style'`: emit comments, normalising line comments to `#` and block
   *   comments to `/ … /`. When a `/* … *\/` comment's content contains `/`
   *   (which cannot be represented inside `/ … /`), the `/* … *\/` form is
   *   kept as-is.
   * - `false` / omitted: strip all comments from the output.
   *
   * When enabled for containers, comment-bearing arrays/maps are emitted in
   * multi-line form even if `indent` is omitted.
   *
   * @default false
   */
  preserveComments?: boolean | 'c-style' | 'cdn-style';

  /**
   * Re-emit byte string literals parsed from CDN using their original source
   * text when available.
   *
   * This preserves the spelling and interior layout of non-concatenated
   * `h'...'`, `b64'...'`, `b32'...'`, `h32'...'`, raw-backtick byte strings,
   * and single-quoted byte strings, including comments inside those literals.
   * Byte strings produced by `+` concatenation are normalised as usual;
   * combine with `preserveConcatenation` to keep both the part boundaries
   * and each part's spelling.
   *
   * When enabled, this takes precedence over `bstrEncoding` and `sqstr` for
   * byte strings that carry original EDN source text.
   *
   * @default false
   */
  preserveByteString?: boolean;

  /**
   * Re-emit text strings written as raw backtick literals (`` `...` ``,
   * ``` ``...`` ```, …) using their original source text instead of
   * converting them to double-quoted form.
   *
   * Applies to non-concatenated raw string literals; combine with
   * `preserveConcatenation` to also keep the spelling of raw string parts
   * inside a `+` chain. Preserved raw strings are emitted verbatim: they are
   * never re-escaped, re-indented, or split by `splitCdn` / `splitNewline`.
   *
   * Raw byte string forms (e.g. `` h`...` ``) are covered by
   * `preserveByteString`, not this option.
   *
   * @default false
   */
  preserveRawString?: boolean;

  /**
   * Whether to emit commas between array/map elements.
   * - `'comma'`: emit commas (`[1, 2, 3]`)
   * - `'none'`: omit commas, use spaces only (`[1 2 3]`)
   * - `'trailing'`: emit commas including a trailing comma after the last element
   * @default 'comma'
   */
  commas?: 'comma' | 'none' | 'trailing';

  /**
   * Fallback binary encoding for byte string literals when sqstr is not applicable.
   * - `'hex'`: `h'...'`
   * - `'base64'`: `b64'...'`
   * - `'base64url'`: `b64'...'` (base64url alphabet)
   * @default 'hex'
   */
  bstrEncoding?: 'hex' | 'base64' | 'base64url';

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
   *
   * @deprecated Use `splitCdn` / `splitNewline` instead. When one of those
   *   is specified, it takes precedence over the corresponding array entry.
   */
  textStringFormat?: TextStringFormat[];

  /**
   * Format text strings whose content is parseable as CDN (a JSON superset)
   * by splitting them with CDN string concatenation (`"{" + "1:2" + "}"`)
   * and structure-aware indentation, the same way the surrounding CDN is
   * formatted. Only effective when `indent` is specified.
   *
   * When the string content parses as CDN, this takes precedence over
   * `preserveConcatenation`; when it does not, the original concatenation
   * is preserved as usual.
   *
   * Replaces the deprecated `textStringFormat: ['cdn']`.
   *
   * @default false
   */
  splitCdn?: boolean;

  /**
   * Split text strings at newline characters using CDN string concatenation
   * (`"line1\n" + "line2"`). Only effective when `indent` is specified.
   *
   * Combines with `preserveConcatenation`: preserved concatenation parts
   * are further split at the newline characters they contain.
   *
   * Replaces the deprecated `textStringFormat: ['newline']`.
   *
   * @default false
   */
  splitNewline?: boolean;

  /**
   * Preserve `+` string concatenation from the parsed CDN source.
   *
   * When a text string or byte string was parsed from a CDN concatenation
   * chain (e.g. `"a" + "b"` or `h'01' + h'02'`), re-emit it as a
   * concatenation with the original part boundaries instead of joining the
   * parts into a single literal. Each part is re-serialized with the normal
   * rules (`bstrEncoding` / `sqstr` for byte strings); combine with
   * `preserveByteString` to also keep the original spelling of byte string
   * parts.
   *
   * Interaction with the split options: `splitCdn` takes precedence for
   * text strings whose content parses as CDN, while `splitNewline` combines
   * with this option by further splitting the preserved parts at newline
   * characters. Has no effect on values that did not originate from a CDN
   * concatenation.
   *
   * @default false
   */
  preserveConcatenation?: boolean;

  /**
   * When pretty-printing with `indent`, keep a container on a single line
   * when none of its entries contains an array or map (even wrapped in a
   * tag) and every entry serializes without a line break (e.g. `[1, 2, 3]`,
   * `{"a": 1}`, `(_ "a", "b")`). Nested leaf containers still collapse
   * individually: `[[1, 2], [3, 4]]` renders with one inner array per line.
   *
   * Containers with preserved comments are always emitted in multi-line
   * form. Has no effect when `indent` is omitted.
   *
   * @default false
   */
  inlineLeafContainers?: boolean;

  /**
   * Control whether CBOR encoding-width indicators (`_N`) are appended to CDN output.
   *
   * - `'always'`: always emit the encoding indicator, even for canonical encodings
   *   (e.g. `1_i`, `"hello"_i`, `[_i 1, 2]`)
   * - `'auto'`: emit indicators only when the CBOR encoding is non-canonical —
   *   i.e. more bytes were used than necessary (e.g. `1_3` for a uint encoded with 8 bytes)
   * - `'never'`: never emit encoding indicators
   *
   * @default 'auto'
   */
  encodingIndicators?: 'always' | 'auto' | 'never';
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
 * Options for `CBOR.validate()`.
 */
export interface ValidateOptions {
  /**
   * Input format.
   * - `'cbor'`: binary CBOR, decoded as a CBOR Sequence (RFC 8742).
   * - `'cdn'`: CDN text, parsed as a CDN Sequence.
   * - `'hex'`: annotated hex dump text, decoded as a CBOR Sequence.
   * @default 'cbor'
   */
  type?: 'cbor' | 'cdn' | 'hex';

  /**
   * Extension plugins used while decoding/parsing.
   * Mirrors `FromCBOROptions.extensions` / `FromCDNOptions.extensions`.
   */
  extensions?: CborExtension[];

  /**
   * Override the default set of bundled application-oriented extensions.
   * Mirrors `FromCBOROptions.builtinExtensions`.
   */
  builtinExtensions?: CborExtension[] | false;

  /**
   * How to handle unrecognised application-extension identifiers.
   * Only applies when `type` is `'cdn'`; mirrors `FromCDNOptions.unresolvedExtension`.
   * @default 'cpa999'
   */
  unresolvedExtension?: 'cpa999' | 'error';
}

/**
 * Result of `CBOR.validate()`.
 */
export interface ValidateResult {
  /**
   * `true` when every item decoded/parsed without error and without any
   * warnings. `false` when the input was malformed (see `error`) or
   * well-formed but in violation of a validity constraint (see `warnings`).
   */
  valid: boolean;

  /** Number of items successfully decoded/parsed before any error. */
  count: number;

  /**
   * Validity violations encountered while decoding/parsing in non-strict
   * mode (recoverable — decoding continued after each one). Excludes
   * informational hints (see `hints`) and the fatal CDN warning that
   * `error` is built from, if any.
   */
  warnings: (DecodeWarning | ParseWarning)[];

  /**
   * Informational hints (`ParseWarning.hint`) encountered while parsing,
   * e.g. an app-string prefix that matches a known optional extension which
   * isn't registered. Hints never affect `valid`; they are collected here so
   * tooling can still surface them.
   */
  hints: ParseWarning[];

  /**
   * Set when decoding/parsing failed outright: either it threw (e.g.
   * truncated CBOR data), or — for CDN input — `fromCDNSeq()` abandoned the
   * rest of the sequence after a hard syntax error (reported internally as a
   * `fatal` warning, which `validate()` promotes to `error` rather than
   * including in `warnings`). For a CDN syntax error this is the original
   * `CdnSyntaxError`, position fields intact.
   */
  error?: Error;
}

/** `fromCBORSeq()` の options（`offset`/`allowTrailing` はジェネレータが管理するため除外）。 */
export type FromCBORSeqOptions = Omit<
  FromCBOROptions,
  'offset' | 'allowTrailing'
>;

/** `fromCDNSeq()` の options（`offset`/`allowTrailing` はジェネレータが管理するため除外）。 */
export type FromCDNSeqOptions = Omit<
  FromCDNOptions,
  'offset' | 'allowTrailing'
>;

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
