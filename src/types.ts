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

// ─── CDDL ─────────────────────────────────────────────────────────────────────
// Type-only imports; note however that supporting CDDL source text as the
// `cddl` option makes the facade (cbor.ts) import the compiler at runtime,
// so the main entry loads the CDDL chunks as well. Accepting only compiled
// schemas would keep the compiler exclusive to the `/cddl` subpath.
import type { CddlSchema } from './cddl/schema';
import type { ValidateOptions as CddlValidateOptions } from './cddl/validator';
import type { CddlValidationError, CddlValidationWarning } from './cddl/errors';

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
   *   entries including duplicate keys (§2.4.2 of draft-ietf-cbor-edn-literals-27).
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
   * Override the default set of bundled app-extensions
   * (`dt`, `ip`, `cri`, `t1`, `b1`, `ilbs`, `ilts`, `float`).
   *
   * - omitted (default): use the standard bundled set.
   * - array: replace the bundled set with exactly these extensions.
   * - `false`: disable all of them.
   *
   * `bignum` (tags 2/3) and embedded-CBOR (tag 24) support are core RFC 8949
   * representation features, not app-extensions, and are always active
   * regardless of this option.
   *
   * `dt`, `ip`, `t1`, and `b1` are mandatory-to-implement per §3 of
   * draft-ietf-cbor-edn-literals-27; disabling them produces a decoder that
   * no longer conforms to that recommendation. This is intended for
   * allowlisting scenarios (see §8 Security considerations of the same
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

  /**
   * CDDL schema to validate decoded items against: either a compiled schema
   * (`CDDL.compile()` from `@cbortech/cbor/cddl`) or CDDL source text.
   * Source text is compiled on first use with default compile options and
   * cached, so passing the same string repeatedly does not recompile; pass a
   * compiled schema to control `CompileOptions` yourself. Invalid CDDL text
   * throws `CddlSyntaxError` / `CddlSemanticError` at the call site.
   *
   * Each decoded item is validated after decoding, against the schema's
   * root rule by default (or `cddlValidationOptions.rule`, if set); a
   * mismatch throws {@link CddlMismatchError}. Sequence entry points
   * (`fromCBORSeq`, `decodeSeq`, …) validate each item of the sequence
   * individually against that same rule. `CBOR.validate()` collects
   * mismatches into `ValidateResult.cddlErrors` instead of throwing.
   */
  cddl?: CddlSchema | string;

  /**
   * Options forwarded to the CDDL validator when `cddl` is supplied
   * (`features` for the `.feature` control operator, `maxDepth`,
   * `maxSteps`, and `rule` to validate against a rule other than the
   * schema's root). Ignored without `cddl`.
   */
  cddlValidationOptions?: CddlValidateOptions;
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
   * Override the default set of bundled app-extensions.
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

  /**
   * Compiled CDDL schema to validate decoded items against.
   * Mirrors `FromCBOROptions.cddl`.
   */
  cddl?: CddlSchema | string;

  /**
   * Options forwarded to the CDDL validator.
   * Mirrors `FromCBOROptions.cddlValidationOptions`.
   */
  cddlValidationOptions?: CddlValidateOptions;
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
   * Override the default set of bundled app-extensions
   * (`dt`, `ip`, `cri`, `t1`, `b1`, `ilbs`, `ilts`, `float`).
   *
   * - omitted (default): use the standard bundled set.
   * - array: replace the bundled set with exactly these extensions.
   * - `false`: disable all of them; app-string literals using their
   *   prefixes then fall through to `unresolvedExtension` handling.
   *
   * `dt`, `ip`, `t1`, and `b1` are mandatory-to-implement per §3 of
   * draft-ietf-cbor-edn-literals-27; disabling them produces a parser that
   * no longer conforms to that recommendation. This is intended for
   * allowlisting scenarios (see §8 Security considerations of the same
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
   * How to handle unrecognised app-extension identifiers
   * (§5.1 of draft-ietf-cbor-edn-literals-27).
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
   * (or `comments`) to include them when formatting back to CDN.
   *
   * Passing `'c-style'`/`'cdn-style'` directly is a deprecated shorthand for
   * `true` plus the equivalent `comments` — still accepted, but prefer
   * `comments` for the output style going forward.
   *
   * @default false
   */
  preserveComments?: boolean | 'c-style' | 'cdn-style';

  /**
   * Companion to `preserveComments` for a single options object shared with
   * `toCDN()` (as `CBOR.format()` does internally) — see
   * `ToCDNOptions.comments` for what each value means there. On the
   * parse side, only *whether* a style other than `'strip'` was requested
   * matters: comments are captured when `preserveComments` is `true`, or
   * when `comments` is set to anything other than `'strip'`. Left
   * unset alongside an unset/`false` `preserveComments`, nothing is
   * captured.
   *
   * @default undefined
   */
  comments?: 'strip' | 'c-style' | 'cdn-style';

  /**
   * Shorthand for `ToCDNOptions.preserveAll`, so a single option enables
   * round-tripping through both `fromCDN()` and `toCDN()` (as
   * `CBOR.format()` does internally). On the parse side, this only implies
   * `preserveComments: true` (comments must be captured while parsing to be
   * re-emittable); the other `preserve*` behaviors are always captured by
   * the parser and only need to be turned on for `toCDN()`.
   *
   * @default false
   */
  preserveAll?: boolean;

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

  /**
   * Compiled CDDL schema to validate parsed items against.
   * Mirrors `FromCBOROptions.cddl`.
   */
  cddl?: CddlSchema | string;

  /**
   * Options forwarded to the CDDL validator.
   * Mirrors `FromCBOROptions.cddlValidationOptions`.
   */
  cddlValidationOptions?: CddlValidateOptions;
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
   * Override the default set of bundled app-extensions.
   * Mirrors `FromCDNOptions.builtinExtensions`. Only affects builtins that
   * implement `fromJS()` / `parseTag()` (none of the bundled app-extensions
   * implement `fromJS()` by default — use `dt_as_Date` via
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

  /**
   * Compiled CDDL schema to validate the constructed item against, before
   * encoding/serialization. Mirrors `FromCBOROptions.cddl`.
   */
  cddl?: CddlSchema | string;

  /**
   * Options forwarded to the CDDL validator.
   * Mirrors `FromCBOROptions.cddlValidationOptions`.
   */
  cddlValidationOptions?: CddlValidateOptions;
}

export interface ToCDNOptions {
  /**
   * Indentation for pretty-printing.
   * - `number`: number of spaces
   * - `string`: literal indent string (e.g. `'\t'`)
   * - omit for single-line output
   *
   * Like `JSON.stringify`, `0` and `''` are equivalent to omitting the
   * option: the output is a single line. Single-line output is guaranteed
   * to contain no newlines; layout-dependent options (`preserveComments`,
   * `preserveBlankLines`, `splitCdn`, `splitNewline`, `preserveConcatenation`)
   * are ignored.
   */
  indent?: number | string;

  /**
   * Master switch that turns on every `preserve*` option below at once,
   * except the deprecated `preserveTextString` — `preserveComments`,
   * `preserveByteString`, `preserveRawString`, `preserveConcatenation`,
   * `preserveNumberFormat`, `preserveAppPrefix`, and
   * `preserveBlankLines` — for reformatting CDN text (e.g. on save in an
   * editor) with minimal changes: only whitespace/indentation, plus
   * anything an explicitly-set individual option overrides.
   *
   * An option explicitly set to a value (including `false`) is left as-is;
   * `preserveAll` only fills in the ones left `undefined`. So
   * `{ preserveAll: true, preserveNumberFormat: false }` preserves
   * everything except number literal spelling. `preserveComments` is filled
   * in with `true` only when `comments` is *also* left unset — an
   * explicit `comments` with no `preserveComments` still normalizes
   * comments to that style under `preserveAll`, instead of being overridden
   * by the verbatim fill-in.
   *
   * When parsing via `CBOR.fromCDN()` separately from `toCDN()` (rather
   * than through `CBOR.format()`, which passes the same options to both),
   * also pass `preserveAll` (or `preserveComments`) to `FromCDNOptions` so
   * comments are captured in the first place — see
   * `FromCDNOptions.preserveAll`. Bignums are unaffected by
   * `preserveNumberFormat` even under `preserveAll`; see that option.
   *
   * @default false
   */
  preserveAll?: boolean;

  /**
   * Emit comments previously captured by `FromCDNOptions.preserveComments`,
   * with their original markers kept as-is (no normalization) — takes
   * precedence over `comments` when `true`.
   *
   * - `true`: emit comments verbatim, with whichever marker each one was
   *   originally written with.
   * - `false` / omitted: defer to `comments` (see below) — `'strip'` (the
   *   default when that's also unset) or unset means no comments are
   *   emitted.
   * - `'c-style'` / `'cdn-style'`: deprecated shorthand for `false` plus the
   *   equivalent `comments`; still accepted, but prefer setting
   *   `comments` directly.
   *
   * Only effective when `indent` enables pretty-printing: single-line
   * output strips all comments regardless, since line comments (`#`, `//`)
   * can only be terminated by a newline.
   *
   * @default false
   */
  preserveComments?: boolean | 'c-style' | 'cdn-style';

  /**
   * Style to normalize comment markers to when emitting comments previously
   * captured by `FromCDNOptions.preserveComments` — only consulted when
   * `preserveComments` is not `true` (see there).
   *
   * - `'strip'` / omitted: don't emit comments at all.
   * - `'c-style'`: emit comments, normalising line comments to `//` and block
   *   comments to `/* … *\/`.
   * - `'cdn-style'`: emit comments, normalising line comments to `#` and block
   *   comments to `/ … /`. When a `/* … *\/` comment's content contains `/`
   *   (which cannot be represented inside `/ … /`), the `/* … *\/` form is
   *   kept as-is.
   *
   * Only effective when `indent` enables pretty-printing; see
   * `preserveComments`.
   *
   * @default 'strip'
   */
  comments?: 'strip' | 'c-style' | 'cdn-style';

  /**
   * Re-emit a blank line above an array/map entry (or indefinite-length
   * string chunk) that had one before it anywhere in the parsed CDN source,
   * so paragraph-like groupings of entries survive a reformat. At most one
   * blank line is ever emitted per gap, regardless of how many blank lines
   * were originally there.
   *
   * Detection is based purely on entry source positions — it does not
   * require `preserveComments` and is unaffected by whether comments are
   * emitted.
   *
   * Only effective when `indent` enables pretty-printing. A container with
   * a preserved blank line is always emitted one-entry-per-line, the same
   * as a container with preserved comments (see `inlineLeafContainers`).
   *
   * @default false
   */
  preserveBlankLines?: boolean;

  /**
   * Re-emit byte string literals parsed from CDN using their original source
   * text when available.
   *
   * This preserves the spelling and interior layout of non-concatenated
   * `h'...'`, `b64'...'`, `b32'...'`, `h32'...'`, raw-backtick byte strings,
   * and single-quoted byte strings — including a `h'xx...yy'`-family elided
   * literal (§5.2), whose spelling is kept independently of
   * `preserveConcatenation` when it has no `+` of its own (see that
   * option). Byte strings produced by `+` concatenation are normalised as
   * usual; combine with `preserveConcatenation` to keep both the part
   * boundaries and each part's spelling.
   *
   * A comment inside the literal is stripped unless `preserveComments` is
   * also set — `preserveByteString` alone preserves everything about the
   * literal's spelling *except* its comments, the same as an unpreserved
   * literal (re-derived from the decoded value) never has comments either.
   *
   * When enabled, this takes precedence over `bstrEncoding` and `sqstr` for
   * byte strings that carry original EDN source text.
   *
   * In single-line output (no `indent`), an original spelling that spans
   * multiple lines — after any comment is stripped — falls back to normal
   * serialization; single-line spellings are kept.
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
   * In single-line output (no `indent`), a spelling that spans multiple
   * lines falls back to normal escaping; single-line spellings are kept.
   *
   * @default false
   */
  preserveRawString?: boolean;

  /**
   * Re-emit double-quoted text strings (`"..."`) using their original CDN
   * source spelling — escape sequences (`é` vs. the literal character),
   * quoting choices, etc. — instead of re-escaping them from the decoded
   * string value.
   *
   * Applies to non-concatenated double-quoted literals only; a string
   * reached via `+` concatenation is normalised as usual regardless of this
   * option. Preserved strings are emitted verbatim: they are never
   * re-indented or split by `splitCdn` / `splitNewline`.
   *
   * Raw backtick literals (`` `...` ``) are covered by `preserveRawString`,
   * not this option.
   *
   * In single-line output (no `indent`), a spelling that spans multiple
   * lines falls back to normal escaping; single-line spellings are kept.
   *
   * @deprecated Verbatim spelling and `splitCdn` / `splitNewline` reflow
   *   are mutually exclusive for a given literal — enabling this option
   *   silently defeats both for any non-concatenated double-quoted string.
   *   It still works when set explicitly, but no longer participates in
   *   `preserveAll` and has been removed from the playground's preserve
   *   options.
   *
   * @default false
   */
  preserveTextString?: boolean;

  /**
   * Re-emit integer and floating-point literals using their original CDN
   * source spelling — base (`0xff` / `0o377` / `0b101` / decimal), digit
   * spelling, decimal point / exponent form, and encoding-indicator suffix
   * (e.g. `1.5_1`) — instead of normalising them via `intFormat` /
   * `floatFormat` and recomputed encoding indicators.
   *
   * Takes precedence over `intFormat` and `floatFormat` for literals parsed
   * from CDN text. Values that did not originate from CDN text (e.g. built
   * via `CBOR.from()` or decoded from CBOR bytes) always fall back to normal
   * formatting, since there is no original spelling to preserve. Bignums
   * (integers outside the uint64/int64 range) are unaffected and always
   * render as plain decimal.
   *
   * Combine with `preserveByteString`, `preserveRawString`,
   * `preserveConcatenation`, and `preserveComments` to reformat CDN text
   * (e.g. whitespace/indentation only) with minimal changes to the rest of
   * the source.
   *
   * @default false
   */
  preserveNumberFormat?: boolean;

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
   * Whether to use app-prefix notation — app-string (`dt'...'`, `` dt`...` ``)
   * or app-sequence (`dt<<...>>`) — for built-in extensions.
   * - `true`: emit extension notation (`DT'2023-01-01T12:00:00Z'`)
   * - `false`: emit raw CBOR notation (`1(-14159024)`, `52(h'c000022a')`)
   *
   * Named after `app-prefix` (§6.1 of draft-ietf-cbor-edn-literals-27), the
   * identifier both notations are built from — not just the app-string form,
   * despite the old `appStrings` name (`false` also falls back to raw tag
   * notation for a preserved app-sequence spelling; see `preserveAppPrefix`).
   *
   * @default true
   */
  appPrefix?: boolean;

  /**
   * @deprecated Renamed to `appPrefix` — the old name only described the
   *   app-string form even though this option also gates app-sequence
   *   (`<<...>>`) notation. Still honoured when `appPrefix` is left unset,
   *   but `appPrefix` wins if both are set.
   */
  appStrings?: boolean;

  /**
   * For built-in extensions that support app-string notation
   * (`prefix'...'` or `` prefix`...` ``), app-sequence notation
   * (`prefix<<...>>`), and/or a raw tag literal (`N(...)`), re-emit a value
   * using its exact original spelling instead of normalizing it to the
   * regenerated `prefix'...'` form.
   *
   * By default, an extension like `dt`/`DT` or `ip`/`IP` regenerates its
   * notation from the resolved value on every call — so
   * `` DT`1969-07-21T02:56:16Z` ``, `DT<<'1969-07-21T02:56:16Z'>>`, and even
   * the raw tag form `1(1749772800)` all become
   * `DT'2025-06-13T00:00:00Z'`-style `prefix'...'` notation, even though all
   * of these denote the same value. `preserveAppPrefix` keeps the
   * original spelling instead — whichever quoting (`'...'` vs `` `...` ``),
   * bracketing (`<<...>>`), or raw tag form was used. Has no effect when
   * `appPrefix` is `false` (raw tag notation is used either way regardless
   * of the original spelling), or on values not parsed from one of these
   * forms.
   *
   * In single-line output (no `indent`), a spelling that spans multiple
   * lines falls back to normal (regenerated) notation; single-line
   * spellings are kept.
   *
   * An explicit `preserveComments`/`comments` setting is still applied
   * to comments inside a preserved app-sequence spelling: marker styles are
   * normalised without changing the notation family, and stripping comments
   * (`preserveComments: false` with `comments` unset or `'strip'`)
   * removes them while retaining the surrounding source spelling. Leaving
   * *both* unset keeps the spelling's comments exactly as originally
   * written, since nothing was explicitly requested.
   *
   * Named after `app-prefix` (§6.1 of draft-ietf-cbor-edn-literals-27; e.g.
   * `dt`, `DT`, `ip`, `IP`), the identifier that `app-string`/`app-sequence`
   * notation is built from. The raw tag literal case is still covered: it's
   * the source spelling that used *no* app-prefix at all, and this option
   * preserves that choice too, not just spellings that did use one.
   * `preserveAppSequence` was the old, narrower name for this same option,
   * since it also preserves app-string and raw-tag spellings, not just
   * `<<...>>` sequences.
   *
   * @default false
   */
  preserveAppPrefix?: boolean;

  /**
   * @deprecated Renamed to `preserveAppPrefix` — the old name only
   *   described the `<<...>>` form even though this option also preserves
   *   `prefix'...'` / `` prefix`...` `` and raw tag (`N(...)`) spellings.
   *   Still honoured when `preserveAppPrefix` is left unset, but
   *   `preserveAppPrefix` wins if both are set, and it no longer
   *   participates in `preserveAll` (use `preserveAppPrefix` for that).
   */
  preserveAppSequence?: boolean;

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
   * Only effective when `indent` enables pretty-printing.
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
   * `inlineLeafContainers` applies to the embedded CDN structure too: an
   * array/map/`<<...>>` in the string content that would stay on one line
   * as a real value keeps its split points collapsed here as well (e.g.
   * `"[1, 2, 3]"` stays a single literal instead of splitting per element).
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
   * concatenation, and only takes effect when `indent` enables
   * pretty-printing (single-line output joins the parts into one literal).
   *
   * Also applies within an elision (`...`, §5.2 of
   * draft-ietf-cbor-edn-literals-27): a `+`-joined fragment on either side of
   * an ellipsis keeps its own part boundaries too (e.g. `'test' +
   * h'1234...abcd' + ...` stays exactly as written instead of merging
   * `'test'` into the byte fragment before it), and byte-string elision
   * keeps the `h'xx' + ... + h'yy'` spelling instead of the default compact
   * `h'xx...yy'` literal. Unlike the text/byte-string case above, this
   * applies regardless of `indent`, and the parts stay on one line even
   * under `indent` (elision is always single-line): a `+` boundary inside an
   * ellipsis is never a lossless merge — the elided middle can't be "joined
   * in" — so there's no indent-dependent fallback to prefer, and no reason
   * to reflow it.
   *
   * @default false
   */
  preserveConcatenation?: boolean;

  /**
   * Render preserved `+` string concatenation (see `preserveConcatenation`)
   * or an elision chain (`...`, §5.2) using `t1<<...>>` / `b1<<...>>`
   * app-sequence notation (draft-ietf-cbor-edn-literals-27 §3.5)
   * instead of the legacy `+` operator.
   *
   * - `false` (default): `"a" + "b"` / `'test' + h'1234...abcd' + ...`.
   * - `true`: `t1<<"a", "b">>` / `b1<<h'1234', h'..abcd'>>`. Falls back to
   *   `false`'s rendering when `appPrefix` is `false`, since this notation
   *   is itself an app-string form.
   *
   * For a plain (non-elision) concatenation, only changes the spelling used
   * where `preserveConcatenation` already causes multi-part rendering; has
   * no effect when concatenation collapses into a single merged literal
   * (e.g. `preserveConcatenation` unset, or a text string whose content is
   * reflowed by `splitCdn` instead). An elision chain is different: `...`
   * denotes genuinely unknown content, so it always renders as multiple
   * parts regardless of `preserveConcatenation` — `modernConcat` therefore
   * also applies to it unconditionally (`preserveConcatenation` there only
   * controls how much of a fragment's *own* internal boundary is shown, not
   * whether the chain itself is shown as multiple parts).
   *
   * Has no effect on a value that was itself parsed from `t1<<...>>` /
   * `b1<<...>>` source: when `appPrefix` is not `false`, `encodingIndicators`
   * is `'auto'` (both defaults), and the source is either single-line or
   * being rendered with `indent` enabled, that spelling is kept verbatim
   * regardless of `modernConcat` (see `t1`/`b1` in
   * [String Concatenation and Indefinite-Length Strings](../README.md#string-concatenation-and-indefinite-length-strings)).
   * A multi-line source falls back to normalized (collapsed) output in
   * single-line mode, since that layout can't be reproduced without
   * `indent`. `modernConcat` only affects values reconstructed from a `+`
   * chain.
   *
   * @default false
   */
  modernConcat?: boolean;

  /**
   * Render an indefinite-length string using `ilts<<...>>` / `ilbs<<...>>`
   * app-sequence notation (draft-ietf-cbor-edn-literals-27 §3.6)
   * instead of the legacy `(_ "a", "b")` streamstring form.
   *
   * - `false` (default): `(_ "a", "b")`.
   * - `true`: `ilts<<"a", "b">>` / `ilbs<<h'..', h'..'>>`. Falls back to
   *   `false`'s rendering when `appPrefix` is `false`, since this notation
   *   is itself an app-string form.
   *
   * Applies whenever an indefinite-length string is rendered as chunks;
   * unaffected by `encodingIndicators: 'never'`, which merges the chunks
   * into a single definite-length literal regardless of this option.
   *
   * Has no effect on a value that was itself parsed from `ilts<<...>>` /
   * `ilbs<<...>>` source: when `appPrefix` is not `false`, `encodingIndicators`
   * is `'auto'` (both defaults), and the source is either single-line or
   * being rendered with `indent` enabled, that spelling is kept verbatim
   * regardless of `modernStreamSyntax`. A multi-line source falls back to
   * normalized (collapsed) output in single-line mode, since that layout
   * can't be reproduced without `indent`. `modernStreamSyntax` only affects
   * values reconstructed from a legacy `(_ ...)` chunk list.
   *
   * @default false
   */
  modernStreamSyntax?: boolean;

  /**
   * When pretty-printing with `indent`, keep an array, map, or
   * indefinite-length string group (`(_ "a", "b")`) on a single line when
   * none of its entries contains an array or map (even wrapped in a tag),
   * none of its entries is a text string with two or more words (also even
   * wrapped in a tag), and every entry serializes without a line break
   * (e.g. `[1, 2, 3]`, `{"a": 1}`, `(_ "a", "b")`). Word boundaries follow
   * `Intl.Segmenter`'s word-break rules, so `["hello", "world"]` still
   * collapses to one line (each entry is a single word) while `["Hello,
   * World!", "This is the CBOR library."]` renders one entry per line (each
   * has two or more) — space-less scripts (Japanese, Chinese, ...) are still
   * split on their own dictionary-based word boundaries. Nested leaf
   * containers still collapse individually: `[[1, 2], [3, 4]]` renders with
   * one inner array per line.
   *
   * `<<...>>` (CBOR Sequence Literal / embedded CBOR) is not governed by
   * this option at all: its own parens never require an additional line
   * break by themselves, regardless of `inlineLeafContainers`'s value,
   * since (unlike an array, map, or indefinite-length string group) it has
   * no nested-structure display of its own to spread out — it's a flat
   * sequence of encoded items. Instead it stays on one line exactly when
   * every entry's own actual rendering already does — an entry that is
   * itself an array/map is not disqualified just for being one, unlike in
   * an outer array/map. Concretely: `<<{1: -7}>>` renders as `<<{1: -7}>>`
   * when `inlineLeafContainers` lets the inner map collapse to one line,
   * but as `<<\n  {\n    1: -7\n  }\n>>` when it doesn't (the map itself
   * still spreads one entry per line without the option, same as it would
   * anywhere else — `<<...>>` just doesn't add a break of its own on top
   * of that). `[{1: -7}]`, by contrast, always spreads its `{1: -7}` entry
   * onto its own line regardless of whether the map itself collapses,
   * since a nested array/map always disqualifies an outer array/map's
   * entry. A two-or-more-word text entry still forces a break inside
   * `<<...>>` either way, irrespective of `inlineLeafContainers`.
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
  /**
   * `true` when this is a `leading` comment that ends on the same source
   * line as the node it's attached to — e.g. `/ protected / << ... >>` in an
   * RFC 9052-style annotated array, as opposed to a comment on its own line
   * above the value. `toCDN()` renders these as an inline prefix on the
   * value's own line instead of a separate line above it. `undefined` for
   * `trailing`/`dangling` comments, where it doesn't apply.
   */
  sameLine?: boolean;
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
   * Override the default set of bundled app-extensions.
   * Mirrors `FromCBOROptions.builtinExtensions`.
   */
  builtinExtensions?: CborExtension[] | false;

  /**
   * How to handle unrecognised app-extension identifiers.
   * Only applies when `type` is `'cdn'`; mirrors `FromCDNOptions.unresolvedExtension`.
   * @default 'cpa999'
   */
  unresolvedExtension?: 'cpa999' | 'error';

  /**
   * CDDL schema to validate each decoded/parsed item against: either a
   * compiled schema (`CDDL.compile()` from `@cbortech/cbor/cddl`) or CDDL
   * source text (compiled on first use and cached; mirrors
   * `FromCBOROptions.cddl`).
   *
   * Unlike the throwing entry points, `CBOR.validate()` does not throw on a
   * mismatch: failures are collected into `ValidateResult.cddlErrors` (and
   * validator observations into `ValidateResult.cddlWarnings`), and any
   * mismatch makes `valid` `false`. Each item of a sequence is validated
   * individually against the schema's root rule by default (or
   * `cddlValidationOptions.rule`, if set). Note that invalid CDDL source
   * text itself still throws (`CddlSyntaxError` / `CddlSemanticError`): the
   * schema is part of the call, not the data being validated.
   */
  cddl?: CddlSchema | string;

  /**
   * Options forwarded to the CDDL validator.
   * Mirrors `FromCBOROptions.cddlValidationOptions`.
   */
  cddlValidationOptions?: CddlValidateOptions;
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

  /**
   * CDDL validation failures, collected per decoded item. Only present when
   * `ValidateOptions.cddl` was supplied (empty array when every item
   * matched). Any entry makes `valid` `false`.
   */
  cddlErrors?: CddlValidationError[];

  /**
   * Non-fatal CDDL validator observations (e.g. unsupported control
   * operators whose constraints were skipped). Only present when
   * `ValidateOptions.cddl` was supplied. Never affects `valid`.
   */
  cddlWarnings?: CddlValidationWarning[];
}

/** Options for `fromCBORSeq()` (`offset`/`allowTrailing` are excluded — the generator manages them). */
export type FromCBORSeqOptions = Omit<
  FromCBOROptions,
  'offset' | 'allowTrailing'
>;

/** Options for `fromCDNSeq()` (`offset`/`allowTrailing` are excluded — the generator manages them). */
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
