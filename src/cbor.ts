import type { CborItem } from './ast/CborItem';
import type {
  CBOROptions,
  FromCBOROptions,
  FromHexDumpOptions,
  FromEDNOptions,
  FromJSOptions,
  ToCBOROptions,
  ToEDNOptions,
  ToJSOptions,
} from './types';
import { CBOR_OMIT } from './types';
import { decodeCBOR } from './cbor/decoder';
import { parseEDN } from './edn/parser';
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

  /** Extension that maps CBOR-EDN dt/DT values to JavaScript Date objects. */
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

  fromEDN(text: string, options?: FromEDNOptions): CborItem {
    const node = CBOR.fromEDN(text, this.#merge(options));
    node._defaults = this.#defaults;
    return node;
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

  decode(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions & ToJSOptions
  ): unknown {
    return CBOR.decode(input, this.#merge(options));
  }

  encode(value: unknown, options?: FromJSOptions & ToCBOROptions): Uint8Array {
    return CBOR.encode(value, this.#merge(options));
  }

  /**
   * @deprecated Use `fromCBOR(input, options).toEDN(options)` instead.
   */
  cborToCborEdn(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions & ToEDNOptions
  ): string {
    return CBOR.cborToCborEdn(input, this.#merge(options));
  }

  /**
   * @deprecated Use `fromEDN(text, options).toCBOR(options)` instead.
   */
  cborEdnToCbor(
    text: string,
    options?: FromEDNOptions & ToCBOROptions
  ): Uint8Array {
    return CBOR.cborEdnToCbor(text, this.#merge(options));
  }

  parse(text: string): unknown;
  parse(
    text: string,
    reviver: (this: unknown, key: unknown, value: unknown) => unknown
  ): unknown;
  parse(text: string, options: FromEDNOptions & ToJSOptions): unknown;
  parse(
    text: string,
    arg2?:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (FromEDNOptions & ToJSOptions)
  ): unknown {
    if (typeof arg2 === 'function') {
      const merged = this.#merge<ToJSOptions>({ reviver: arg2 });
      return CBOR.fromEDN(text, merged).toJS(merged);
    }
    const merged = this.#merge(arg2);
    return CBOR.fromEDN(text, merged).toJS(merged);
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
  stringify(value: unknown, options: FromJSOptions & ToEDNOptions): string;
  stringify(
    value: unknown,
    arg2?:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (string | number)[]
      | null
      | (FromJSOptions & ToEDNOptions),
    arg3?: string | number
  ): string {
    if (
      typeof arg2 === 'function' ||
      Array.isArray(arg2) ||
      arg2 === null ||
      (arg2 === undefined && arg3 !== undefined)
    ) {
      const opts: FromJSOptions & ToEDNOptions = {
        ...(this.#defaults as FromJSOptions & ToEDNOptions),
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

  format(text: string, options?: FromEDNOptions & ToEDNOptions): string {
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

  /** Parse a CBOR-EDN text string into an AST node. */
  static fromEDN(text: string, options?: FromEDNOptions): CborItem {
    return parseEDN(text, options);
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
      if (!/^[0-9A-Fa-f]{2}$/.test(token))
        throw new SyntaxError(
          `Invalid hex token in dump: ${JSON.stringify(token)}`
        );
      bytes.push(parseInt(token, 16));
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

  /** Encode a JavaScript value directly to CBOR binary data. */
  static encode(
    value: unknown,
    options?: FromJSOptions & ToCBOROptions
  ): Uint8Array {
    return CBOR.fromJS(value, options).toCBOR(options);
  }

  /**
   * Convert CBOR binary data directly to a CBOR-EDN text string.
   *
   * @deprecated Use `CBOR.fromCBOR(input, options).toEDN(options)` instead.
   */
  static cborToCborEdn(
    input: ArrayBufferView | ArrayBufferLike,
    options?: FromCBOROptions & ToEDNOptions
  ): string {
    return CBOR.fromCBOR(input, options).toEDN(options);
  }

  /**
   * Convert a CBOR-EDN text string directly to CBOR binary data.
   *
   * @deprecated Use `CBOR.fromEDN(text, options).toCBOR(options)` instead.
   */
  static cborEdnToCbor(
    text: string,
    options?: FromEDNOptions & ToCBOROptions
  ): Uint8Array {
    return CBOR.fromEDN(text, options).toCBOR(options);
  }

  /**
   * Parse a CBOR-EDN text string directly to a JavaScript value.
   *
   * Accepts either a JSON-compatible `reviver` function as the second argument,
   * or a plain options object (existing API).
   *
   * When a `reviver` is supplied it is applied bottom-up after the EDN text has
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
  static parse(text: string, options: FromEDNOptions & ToJSOptions): unknown;
  static parse(
    text: string,
    arg2?:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (FromEDNOptions & ToJSOptions)
  ): unknown {
    if (typeof arg2 === 'function') {
      return CBOR.fromEDN(text).toJS({ reviver: arg2 });
    }
    return CBOR.fromEDN(text, arg2).toJS(arg2);
  }

  /**
   * Serialize a JavaScript value directly to a CBOR-EDN text string.
   *
   * Accepts either JSON-compatible `replacer` + `space` arguments, or a plain
   * options object (existing API).
   *
   * - `replacer` may be a function (transforms each key/value before encoding)
   *   or an array of strings/numbers (allowlist of object keys to include).
   *   Pass `null` to skip filtering.
   * - `space` controls indentation, mapping to `ToEDNOptions.indent`.
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
    options: FromJSOptions & ToEDNOptions
  ): string;
  static stringify(
    value: unknown,
    arg2?:
      | ((this: unknown, key: unknown, value: unknown) => unknown)
      | (string | number)[]
      | null
      | (FromJSOptions & ToEDNOptions),
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
        return _fromJS(replaced).toEDN(
          indent !== undefined ? { indent } : undefined
        );
      }
      return _fromJS(value).toEDN(
        indent !== undefined ? { indent } : undefined
      );
    }
    // Options form: also mirror JSON.stringify root-drop semantics.
    const opts = arg2 as (FromJSOptions & ToEDNOptions) | undefined;
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
      ).toEDN(opts);
    }
    return _fromJS(value, opts as FromJSOptions | undefined).toEDN(opts);
  }

  /** Normalize a CBOR-EDN text string by parsing and re-serializing it. */
  static format(text: string, options?: FromEDNOptions & ToEDNOptions): string {
    return CBOR.fromEDN(text, options).toEDN(options);
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

/** Map JSON.stringify `space` argument to ToEDNOptions.indent. */
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
