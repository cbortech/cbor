import type { CborItem } from './ast/CborItem';
import type {
  CBOROptions,
  FromCBOROptions,
  FromCBORSeqOptions,
  FromCDNOptions,
  FromCDNSeqOptions,
  FromHexDumpOptions,
  FromJSOptions,
  ParseWarning,
  ToCBOROptions,
  ToCDNOptions,
  ToHexDumpOptions,
  ToJSOptions,
} from './types';
import { CBOR_OMIT } from './types';
import { decodeCBOR } from './cbor/decoder';
import { parseCDN } from './cdn/parser';
import { dt_as_Date as _dt_as_Date } from './extensions/dt';
import { fromJS as _fromJS, _applyReplacer } from './js/fromJS';
import { MapEntries as _MapEntries } from './mapEntries';
import { Simple as _Simple } from './simple';
import { CBOR_TAG, Tag as _Tag } from './tag';

/**
 * Main facade class.
 *
 * Provides factory methods for constructing AST nodes from the three
 * supported input formats, and shortcut methods that mirror the
 * `JSON.parse` / `JSON.stringify` API.
 *
 * @example
 * // CBOR binary → AST → CBOR binary
 * const ast = CBOR.fromCBOR(bytes);
 * const reencoded = ast.toCBOR();
 *
 * @example
 * // JS value → CBOR binary (shortcut)
 * const bytes = CBOR.encode({ hello: 'world' });
 *
 * @example
 * // CBOR binary → JS value (shortcut)
 * const value = CBOR.decode(bytes);
 */
export class CBOR {
  /**
   * Sentinel returned from a replacer or reviver to omit the key/element from
   * the output.  Use this instead of `undefined` when `undefinedOmits` is
   * `false` (the default) and you need to drop a specific entry.
   */
  static readonly OMIT: typeof CBOR_OMIT = CBOR_OMIT;

  /** Unique symbol used to attach a CBOR tag number to a JS value. */
  static readonly TAG: typeof CBOR_TAG = CBOR_TAG;

  /** Namespace for CBOR tag annotation utilities. */
  static readonly Tag: typeof _Tag = _Tag;

  /** Wrapper for CBOR simple values other than false/true/null/undefined. */
  static readonly Simple: typeof _Simple = _Simple;

  /** Array subclass used to preserve CBOR map entries, including duplicates. */
  static readonly MapEntries: typeof _MapEntries = _MapEntries;

  /** Extension that maps CDN dt/DT values to JavaScript Date objects. */
  static readonly dt_as_Date: typeof _dt_as_Date = _dt_as_Date;

  // ─── Instance API ───────────────────────────────────────────────────────────

  readonly #defaults: CBOROptions;

  /**
   * Create a reusable instance with default options applied to every method call.
   * Per-call options always override these defaults.
   *
   * @example
   * const cbor = new CBOR({ extensions: [CBOR.dt_as_Date] });
   * const obj  = cbor.parse('{ "dt": DT\'2024-01-01T00:00:00Z\' }');
   * const text = cbor.stringify(obj);
   */
  constructor(defaults?: CBOROptions) {
    this.#defaults = defaults ?? {};
  }

  #merge<T extends object>(perCall?: T): CBOROptions & T {
    return { ...this.#defaults, ...(perCall ?? {}) } as CBOROptions & T;
  }

  fromCBOR(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions
  ): CborItem {
    const node = CBOR.fromCBOR(input, this.#merge(options));
    node._defaults = this.#defaults;
    return node;
  }

  fromCDN(text: string, options?: FromCDNOptions): CborItem {
    const node = CBOR.fromCDN(text, this.#merge(options));
    node._defaults = this.#defaults;
    return node;
  }

  /** @deprecated Use `fromCDN()` instead. */
  fromEDN(text: string, options?: FromCDNOptions): CborItem {
    return this.fromCDN(text, options);
  }

  fromJS(value: unknown, options?: FromJSOptions): CborItem {
    const node = CBOR.fromJS(value, this.#merge(options));
    node._defaults = this.#defaults;
    return node;
  }

  fromHexDump(text: string, options?: FromHexDumpOptions): CborItem {
    const node = CBOR.fromHexDump(text, this.#merge(options));
    node._defaults = this.#defaults;
    return node;
  }

  *fromCBORSeq(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBORSeqOptions
  ): Generator<CborItem> {
    for (const item of CBOR.fromCBORSeq(input, this.#merge(options))) {
      item._defaults = this.#defaults;
      yield item;
    }
  }

  *fromCDNSeq(text: string, options?: FromCDNSeqOptions): Generator<CborItem> {
    for (const item of CBOR.fromCDNSeq(text, this.#merge(options))) {
      item._defaults = this.#defaults;
      yield item;
    }
  }

  *fromHexDumpSeq(
    text: string,
    options?: FromHexDumpOptions
  ): Generator<CborItem> {
    for (const item of CBOR.fromHexDumpSeq(text, this.#merge(options))) {
      item._defaults = this.#defaults;
      yield item;
    }
  }

  decode(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions & ToJSOptions
  ): unknown {
    return CBOR.decode(input, this.#merge(options));
  }

  *decodeSeq(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBORSeqOptions & ToJSOptions
  ): Generator<unknown> {
    yield* CBOR.decodeSeq(input, this.#merge(options));
  }

  *parseSeq(
    text: string,
    options?: FromCDNSeqOptions & ToJSOptions
  ): Generator<unknown> {
    yield* CBOR.parseSeq(text, this.#merge(options));
  }

  encode(value: unknown, options?: FromJSOptions & ToCBOROptions): Uint8Array {
    return CBOR.encode(value, this.#merge(options));
  }

  compile(
    text: string,
    options?: FromCDNSeqOptions & ToCBOROptions
  ): Uint8Array {
    return CBOR.compile(text, this.#merge(options));
  }

  decompile(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBORSeqOptions & ToCDNOptions
  ): string {
    return CBOR.decompile(input, this.#merge(options));
  }

  toHex(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBORSeqOptions & ToHexDumpOptions
  ): string {
    return CBOR.toHex(input, this.#merge(options));
  }

  fromHex(
    text: string,
    options?: FromHexDumpOptions & ToCBOROptions
  ): Uint8Array {
    return CBOR.fromHex(text, this.#merge(options));
  }

  /** @deprecated Use `decompile()` instead. */
  cborToCborEdn(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions & ToCDNOptions
  ): string {
    return this.cborToCdn(input, options);
  }

  /** @deprecated Use `decompile()` instead. */
  cborToCdn(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions & ToCDNOptions
  ): string {
    const merged = this.#merge(options);
    const node = CBOR.fromCBOR(input, merged);
    node._defaults = this.#defaults;
    return node.toCDN(merged);
  }

  /** @deprecated Use `compile()` instead. */
  cborEdnToCbor(
    text: string,
    options?: FromCDNOptions & ToCBOROptions
  ): Uint8Array {
    return this.cdnToCbor(text, options);
  }

  /** @deprecated Use `compile()` instead. */
  cdnToCbor(
    text: string,
    options?: FromCDNOptions & ToCBOROptions
  ): Uint8Array {
    const merged = this.#merge(options);
    return CBOR.fromCDN(text, merged).toCBOR(merged);
  }

  parse(text: string): unknown;
  parse(
    text: string,
    reviver: (this: unknown, key: unknown, value: unknown) => unknown
  ): unknown;
  parse(text: string, options: FromCDNOptions & ToJSOptions): unknown;
  parse(
    text: string,
    arg2?:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (FromCDNOptions & ToJSOptions)
  ): unknown {
    if (typeof arg2 === 'function') {
      const merged = this.#merge<ToJSOptions>({ reviver: arg2 });
      return CBOR.fromCDN(text, merged).toJS(merged);
    }
    const merged = this.#merge(arg2);
    return CBOR.fromCDN(text, merged).toJS(merged);
  }

  stringify(value: unknown): string;
  stringify(
    value: unknown,
    replacer:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (string | number)[]
      | null,
    space?: string | number
  ): string;
  stringify(value: unknown, options: FromJSOptions & ToCDNOptions): string;
  stringify(
    value: unknown,
    arg2?:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (string | number)[]
      | null
      | (FromJSOptions & ToCDNOptions),
    arg3?: string | number
  ): string {
    if (
      typeof arg2 === 'function' ||
      Array.isArray(arg2) ||
      arg2 === null ||
      (arg2 === undefined && arg3 !== undefined)
    ) {
      const opts: FromJSOptions & ToCDNOptions = {
        ...(this.#defaults as FromJSOptions & ToCDNOptions),
      };
      if (arg2 === null) {
        opts.replacer = undefined;
      } else if (typeof arg2 === 'function' || Array.isArray(arg2)) {
        opts.replacer = arg2;
      }
      if (arg3 !== undefined) opts.indent = resolveSpace(arg3);
      return CBOR.stringify(value, opts);
    }
    return CBOR.stringify(value, this.#merge(arg2 ?? undefined));
  }

  format(text: string, options?: FromCDNOptions & ToCDNOptions): string {
    return CBOR.format(text, this.#merge(options));
  }

  // ─── Factory methods ────────────────────────────────────────────────────────

  /** Decode CBOR binary data into an AST node. */
  static fromCBOR(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions
  ): CborItem {
    return decodeCBOR(input, options);
  }

  /** Parse a CDN text string into an AST node. */
  static fromCDN(text: string, options?: FromCDNOptions): CborItem {
    return parseCDN(text, options);
  }

  /**
   * Parse a CDN text string into an AST node.
   *
   * @deprecated Use `fromCDN()` instead.
   */
  static fromEDN(text: string, options?: FromCDNOptions): CborItem {
    return CBOR.fromCDN(text, options);
  }

  /** アノテーション付き hex dump テキストから CBOR Sequence を item ごとにデコードするジェネレータ。 */
  static *fromHexDumpSeq(
    text: string,
    options?: FromHexDumpOptions
  ): Generator<CborItem> {
    const bytes: number[] = [];
    const uncommented = stripHexDumpComments(text);
    const tokens = uncommented.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (/^[0-9A-Fa-f]{2}$/.test(token)) {
        bytes.push(parseInt(token, 16));
      } else if (/^[0-9A-Fa-f]+$/.test(token) && token.length % 2 === 0) {
        for (let i = 0; i < token.length; i += 2)
          bytes.push(parseInt(token.slice(i, i + 2), 16));
      } else {
        throw new SyntaxError(
          `Invalid hex token in dump: ${JSON.stringify(token)}`
        );
      }
    }
    yield* CBOR.fromCBORSeq(new Uint8Array(bytes), options);
  }

  /** CBOR Sequence (RFC 8742) を item ごとにデコードするジェネレータ。 */
  static *fromCBORSeq(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBORSeqOptions
  ): Generator<CborItem> {
    const bytes =
      input instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' &&
        input instanceof SharedArrayBuffer)
        ? new Uint8Array(input)
        : new Uint8Array(
            (input as ArrayBufferView).buffer,
            (input as ArrayBufferView).byteOffset,
            (input as ArrayBufferView).byteLength
          );
    let offset = 0;
    while (offset < bytes.byteLength) {
      const item = decodeCBOR(bytes, {
        ...options,
        offset,
        allowTrailing: true,
      });
      yield item;
      offset = item.end!;
    }
  }

  /**
   * CDN テキストの複数 item を 1 つずつパースするジェネレータ。
   *
   * `preserveComments` が有効な場合、item 間のコメントは次の item の
   * leading コメントとして、item と同じ行にあるコメントはその item の
   * trailing コメントとして付与される。最後の item の後の行にだけ
   * コメントが残る場合、そのコメントはどの item にも属さず破棄される。
   */
  static *fromCDNSeq(
    text: string,
    options?: FromCDNSeqOptions
  ): Generator<CborItem> {
    const preserve = !!options?.preserveComments;
    let offset = 0;
    let isFirst = true;
    while (true) {
      const {
        offset: next,
        hadSeparator,
        commaOffset,
      } = skipCDNSeparator(
        text,
        offset,
        options,
        preserve ? (isFirst ? 'all' : 'after-newline') : 'none'
      );
      // Leading comma: comma before the first item (including comma-only input).
      // Checked before the EOF break so that "," alone is also caught.
      // Trailing comma is valid per ABNF SOC = S ["," S] and is silently accepted.
      if (isFirst && commaOffset >= 0) {
        const msg = 'leading comma in CDN sequence';
        if (options?.strict !== false) throw new SyntaxError(msg);
        emitCDNSeqWarning(msg, commaOffset, options);
      }
      if (next >= text.length) break;
      // Stopped at a comment that should lead the next item: make sure an
      // item actually follows. If only comments remain, we are done (the
      // remaining comments belong to no item and are dropped, matching the
      // behaviour of `preserveComments: false`).
      if (preserve && isCDNCommentStart(text, next)) {
        const lookahead = skipCDNSeparator(text, next, options);
        if (lookahead.offset >= text.length) break;
      }
      if (!isFirst && !hadSeparator) {
        const msg =
          'CDN sequence items must be separated by whitespace, comma, or comment';
        if (options?.strict !== false) throw new SyntaxError(msg);
        emitCDNSeqWarning(msg, next, options);
      }
      offset = next;
      let item: CborItem;
      try {
        // _skipRS: true causes the tokenizer to treat RS (U+001E, RFC 7464) as
        // whitespace, preventing it from corrupting string-literal contents via
        // a global text replacement.
        item = parseCDN(text, {
          ...options,
          offset,
          allowTrailing: true,
          _skipRS: true,
        } as FromCDNOptions);
      } catch (e) {
        if (options?.strict !== false) throw e;
        emitCDNSeqWarning(
          e instanceof Error ? e.message : String(e),
          offset,
          options
        );
        break;
      }
      yield item;
      offset = item.end!;
      isFirst = false;
    }
  }

  /** Convert a JavaScript value into an AST node. */
  static fromJS(value: unknown, options?: FromJSOptions): CborItem {
    return _fromJS(value, options);
  }

  /**
   * Parse an annotated hex dump (as produced by {@link CborItem#toHexDump})
   * into an AST node.
   *
   * Each line is expected to have the form:
   *   `[whitespace] HH [HH …]  -- comment`
   *   `[whitespace] HH [HH …]  # comment`
   *   `[whitespace] HH [HH …]  // comment`
   * Block comments may also be written as `/ comment /` or `/* comment *\/`.
   * Lines with no hex content before the comment marker are ignored.
   */
  static fromHexDump(text: string, options?: FromHexDumpOptions): CborItem {
    const bytes: number[] = [];
    const uncommented = stripHexDumpComments(text);
    const tokens = uncommented.trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (/^[0-9A-Fa-f]{2}$/.test(token)) {
        bytes.push(parseInt(token, 16));
      } else if (/^[0-9A-Fa-f]+$/.test(token) && token.length % 2 === 0) {
        for (let i = 0; i < token.length; i += 2)
          bytes.push(parseInt(token.slice(i, i + 2), 16));
      } else {
        throw new SyntaxError(
          `Invalid hex token in dump: ${JSON.stringify(token)}`
        );
      }
    }
    return decodeCBOR(new Uint8Array(bytes), options);
  }

  // ─── Shortcut API ───────────────────────────────────────────────────────────

  /** Decode CBOR binary data directly to a JavaScript value. */
  static decode(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions & ToJSOptions
  ): unknown {
    return CBOR.fromCBOR(input, options).toJS(options);
  }

  /** Decode a CBOR Sequence (RFC 8742), yielding each item as a JavaScript value. */
  static *decodeSeq(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBORSeqOptions & ToJSOptions
  ): Generator<unknown> {
    for (const item of CBOR.fromCBORSeq(input, options)) {
      yield item.toJS(options);
    }
  }

  /** Parse a CDN Sequence text string, yielding each item as a JavaScript value. */
  static *parseSeq(
    text: string,
    options?: FromCDNSeqOptions & ToJSOptions
  ): Generator<unknown> {
    for (const item of CBOR.fromCDNSeq(text, options)) {
      yield item.toJS(options);
    }
  }

  /** Encode a JavaScript value directly to CBOR binary data. */
  static encode(
    value: unknown,
    options?: FromJSOptions & ToCBOROptions
  ): Uint8Array {
    return CBOR.fromJS(value, options).toCBOR(options);
  }

  /**
   * Compile a CDN text string to CBOR binary data.
   * Multi-item CDN Sequences produce a CBOR Sequence (RFC 8742): concatenated items.
   */
  static compile(
    text: string,
    options?: FromCDNSeqOptions & ToCBOROptions
  ): Uint8Array {
    const byteArrays = [...CBOR.fromCDNSeq(text, options)].map((item) =>
      item.toCBOR(options)
    );
    const total = byteArrays.reduce((s, b) => s + b.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const b of byteArrays) {
      result.set(b, off);
      off += b.length;
    }
    return result;
  }

  /**
   * Decompile CBOR binary data to a CDN text string.
   * CBOR Sequences (RFC 8742) produce multi-item CDN output, with items separated by newlines.
   */
  static decompile(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBORSeqOptions & ToCDNOptions
  ): string {
    return [...CBOR.fromCBORSeq(input, options)]
      .map((item) => item.toCDN(options))
      .join('\n');
  }

  /**
   * Convert CBOR binary data to an annotated hex dump string.
   * CBOR Sequences (RFC 8742) produce one dump per item, separated by newlines.
   */
  static toHex(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBORSeqOptions & ToHexDumpOptions
  ): string {
    return [...CBOR.fromCBORSeq(input, options)]
      .map((item) => item.toHexDump(options))
      .join('\n');
  }

  /**
   * Parse an annotated hex dump string to CBOR binary data.
   * Multi-item dumps produce a CBOR Sequence (RFC 8742): concatenated items.
   */
  static fromHex(
    text: string,
    options?: FromHexDumpOptions & ToCBOROptions
  ): Uint8Array {
    const byteArrays = [...CBOR.fromHexDumpSeq(text, options)].map((item) =>
      item.toCBOR(options)
    );
    const total = byteArrays.reduce((s, b) => s + b.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const b of byteArrays) {
      result.set(b, off);
      off += b.length;
    }
    return result;
  }

  /**
   * Convert CBOR binary data directly to a CDN text string.
   *
   * @deprecated Use `CBOR.decompile()` instead.
   */
  static cborToCdn(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions & ToCDNOptions
  ): string {
    return CBOR.fromCBOR(input, options).toCDN(options);
  }

  /** @deprecated Use `CBOR.decompile()` instead. */
  static cborToCborEdn(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions & ToCDNOptions
  ): string {
    return CBOR.fromCBOR(input, options).toCDN(options);
  }

  /**
   * Convert a CDN text string directly to CBOR binary data.
   *
   * @deprecated Use `CBOR.compile()` instead.
   */
  static cdnToCbor(
    text: string,
    options?: FromCDNOptions & ToCBOROptions
  ): Uint8Array {
    return CBOR.fromCDN(text, options).toCBOR(options);
  }

  /** @deprecated Use `CBOR.compile()` instead. */
  static cborEdnToCbor(
    text: string,
    options?: FromCDNOptions & ToCBOROptions
  ): Uint8Array {
    return CBOR.fromCDN(text, options).toCBOR(options);
  }

  /**
   * Parse a CDN text string directly to a JavaScript value.
   *
   * Accepts either a JSON-compatible `reviver` function as the second argument,
   * or a plain options object (existing API).
   *
   * When a `reviver` is supplied it is applied bottom-up after the CDN text has
   * been parsed and converted to a JS value, matching the semantics of
   * `JSON.parse(text, reviver)`.
   *
   * Note: CBOR-specific value types such as `bigint` are passed to the reviver
   * as-is; the reviver is responsible for handling them.
   */
  static parse(text: string): unknown;
  static parse(
    text: string,
    reviver: (this: unknown, key: unknown, value: unknown) => unknown
  ): unknown;
  static parse(text: string, options: FromCDNOptions & ToJSOptions): unknown;
  static parse(
    text: string,
    arg2?:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (FromCDNOptions & ToJSOptions)
  ): unknown {
    if (typeof arg2 === 'function') {
      return CBOR.fromCDN(text).toJS({ reviver: arg2 });
    }
    return CBOR.fromCDN(text, arg2).toJS(arg2);
  }

  /**
   * Serialize a JavaScript value directly to a CDN text string.
   *
   * Accepts either JSON-compatible `replacer` + `space` arguments, or a plain
   * options object (existing API).
   *
   * - `replacer` may be a function (transforms each key/value before encoding)
   *   or an array of strings/numbers (allowlist of object keys to include).
   *   Pass `null` to skip filtering.
   * - `space` controls indentation, mapping to `ToCDNOptions.indent`.
   *   Numbers are clamped to `[0, 10]`; strings are truncated to 10 characters.
   */
  static stringify(value: unknown): string;
  static stringify(
    value: unknown,
    replacer:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (string | number)[]
      | null,
    space?: string | number
  ): string;
  static stringify(
    value: unknown,
    options: FromJSOptions & ToCDNOptions
  ): string;
  static stringify(
    value: unknown,
    arg2?:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (string | number)[]
      | null
      | (FromJSOptions & ToCDNOptions),
    arg3?: string | number
  ): string {
    if (
      typeof arg2 === 'function' ||
      Array.isArray(arg2) ||
      arg2 === null ||
      (arg2 === undefined && arg3 !== undefined)
    ) {
      const replacer =
        typeof arg2 === 'function' || Array.isArray(arg2) ? arg2 : undefined;
      const indent = resolveSpace(arg3);
      if (replacer) {
        // Mirror JSON.stringify: if the replacer drops the root, return undefined.
        const replaced = _applyReplacer(value, replacer);
        if (replaced === undefined || replaced === CBOR_OMIT)
          return undefined as unknown as string;
        return _fromJS(replaced).toCDN(
          indent !== undefined ? { indent } : undefined
        );
      }
      return _fromJS(value).toCDN(
        indent !== undefined ? { indent } : undefined
      );
    }
    // Options form: also mirror JSON.stringify root-drop semantics.
    const opts = arg2 as (FromJSOptions & ToCDNOptions) | undefined;
    if (opts?.replacer) {
      const replaced = _applyReplacer(
        value,
        opts.replacer,
        opts.extensions,
        opts.undefinedOmits
      );
      if (replaced === undefined || replaced === CBOR_OMIT)
        return undefined as unknown as string;
      const { replacer: _r, ...restFromJS } = opts;
      return _fromJS(
        replaced,
        Object.keys(restFromJS).length > 0
          ? (restFromJS as FromJSOptions)
          : undefined
      ).toCDN(opts);
    }
    return _fromJS(value, opts as FromJSOptions | undefined).toCDN(opts);
  }

  /** Normalize a CDN text string by parsing and re-serializing it. */
  static format(text: string, options?: FromCDNOptions & ToCDNOptions): string {
    return CBOR.fromCDN(text, options).toCDN(options);
  }
}

function stripHexDumpComments(text: string): string {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1] ?? '';

    if (ch === '-' && next === '-') {
      i = skipLineComment(text, i + 2);
      out += ' ';
      continue;
    }

    if (ch === '—') {
      i = skipLineComment(text, i + 1);
      out += ' ';
      continue;
    }

    if (ch === '#') {
      i = skipLineComment(text, i + 1);
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '/') {
      i = skipLineComment(text, i + 2);
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxError('Unterminated comment in hex dump');
      out += whitespaceLike(text.slice(i, end + 2));
      i = end + 2;
      continue;
    }

    if (ch === '/') {
      const end = text.indexOf('/', i + 1);
      if (end < 0) throw new SyntaxError('Unterminated comment in hex dump');
      out += whitespaceLike(text.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function skipLineComment(text: string, start: number): number {
  const end = text.indexOf('\n', start);
  return end < 0 ? text.length : end;
}

function whitespaceLike(text: string): string {
  return text.replace(/[^\r\n]/g, ' ');
}

// ─── Module-scope helper ─────────────────────────────────────────────────────

function emitCDNSeqWarning(
  msg: string,
  offset: number,
  options: FromCDNSeqOptions | undefined
): void {
  const w: ParseWarning = { message: msg, offset };
  if (options?.onWarning) options.onWarning(w);
  else if (!options?.silent)
    console.warn(`CDN sequence warning at offset ${offset}: ${msg}`);
}

/** Whether `text[i]` starts a CDN comment (`#`, `//`, `/* … *\/`, or `/ … /`). */
function isCDNCommentStart(text: string, i: number): boolean {
  const ch = text[i];
  return ch === '#' || ch === '/';
}

/**
 * CDN sequence の item 間にある空白・コメント・省略可能なカンマを読み飛ばし、
 * 次の item が始まる文字位置と、何らかの separator が存在したかどうかを返す。
 * 未終端のブロックコメントは strict モードでは throw し、
 * strict: false の場合は警告を emit して末尾まで読み飛ばす。
 *
 * `stopAtComments` は `preserveComments` 有効時にコメントを次の item の
 * leading コメントとして残すためのモード:
 * - `'none'`: コメントも読み飛ばす(従来動作)
 * - `'all'`: 最初のコメントで停止する(先頭 item 用)
 * - `'after-newline'`: 改行より後のコメントで停止する。直前 item と同じ行の
 *   コメントはその item の trailing コメントとして既に付与されているため読み飛ばす。
 */
function skipCDNSeparator(
  text: string,
  from: number,
  options: FromCDNSeqOptions | undefined,
  stopAtComments: 'none' | 'after-newline' | 'all' = 'none'
): { offset: number; hadSeparator: boolean; commaOffset: number } {
  let i = from;
  let hadSeparator = false;
  let seenComma = false;
  let seenNewline = false;
  let commaOffset = -1;
  const stopHere = (): boolean =>
    stopAtComments === 'all' ||
    (stopAtComments === 'after-newline' && seenNewline);
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\x1e') {
      hadSeparator = true;
      i++;
      continue;
    }
    if (ch === '\n') {
      hadSeparator = true;
      seenNewline = true;
      i++;
      continue;
    }
    if (ch === '#') {
      hadSeparator = true;
      if (stopHere()) break;
      const nl = text.indexOf('\n', i + 1);
      i = nl < 0 ? text.length : nl + 1;
      seenNewline = true;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      hadSeparator = true;
      if (stopHere()) break;
      const nl = text.indexOf('\n', i + 2);
      i = nl < 0 ? text.length : nl + 1;
      seenNewline = true;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      hadSeparator = true;
      if (stopHere()) break;
      const end = text.indexOf('*/', i + 2);
      if (end < 0) {
        const msg = 'unterminated /* comment in CDN sequence';
        if (options?.strict !== false) throw new SyntaxError(msg);
        emitCDNSeqWarning(msg, i, options);
        i = text.length;
      } else {
        if (text.slice(i, end).includes('\n')) seenNewline = true;
        i = end + 2;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] !== '/') {
      hadSeparator = true;
      if (stopHere()) break;
      const end = text.indexOf('/', i + 1);
      if (end < 0) {
        const msg = 'unterminated / comment in CDN sequence';
        if (options?.strict !== false) throw new SyntaxError(msg);
        emitCDNSeqWarning(msg, i, options);
        i = text.length;
      } else {
        if (text.slice(i, end).includes('\n')) seenNewline = true;
        i = end + 1;
      }
      continue;
    }
    if (ch === ',' && !seenComma) {
      hadSeparator = true;
      seenComma = true;
      commaOffset = i;
      i++;
      continue;
    }
    break;
  }
  return { offset: i, hadSeparator, commaOffset };
}

/** Map JSON.stringify `space` argument to ToCDNOptions.indent. */
function resolveSpace(
  space: string | number | undefined
): string | number | undefined {
  if (typeof space === 'number') {
    const n = Math.floor(Math.min(10, Math.max(0, space)));
    return n === 0 ? undefined : n;
  }
  if (typeof space === 'string') {
    const s = space.slice(0, 10);
    return s || undefined;
  }
  return undefined;
}
