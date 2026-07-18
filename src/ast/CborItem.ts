import type {
  CBOROptions,
  ToCDNOptions,
  ToJSOptions,
  ToHexDumpOptions,
  ToCBOROptions,
  CborComments,
  DecodeWarning,
  ParseWarning,
} from '../types';
import { CBOR_OMIT } from '../types';
import { convertCommentText } from '../cdn/serialize-utils';
import { CborWriter } from '../cbor/encode';
import { bytesToSpacedHexUpper } from '../utils/hex';

/** @internal One line of an annotated hex dump. */
export interface AnnotatedLine {
  depth: number;
  hex: string;
  comment: string;
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
   * embedded CBOR, app-sequence results), an array or map.
   * `inlineLeafContainers` never inlines a container whose entries contain
   * another container, even one that renders on a single line.
   */
  get _containsCdnContainer(): boolean {
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
    const merged = this._defaults ? { ...this._defaults, ...options } : options;
    const body = this._toCDN(merged, 0);
    const pv = merged?.preserveComments;
    if (!pv) return body;
    const style = typeof pv === 'string' ? pv : undefined;
    const leading =
      this.comments?.leading?.map((c) => convertCommentText(c, style)) ?? [];
    const trailing = this.comments?.trailing ?? [];
    const bodyWithTrailing =
      trailing.length === 0
        ? body
        : `${body} ${trailing.map((c) => convertCommentText(c, style).trimEnd()).join(' ')}`;
    return [...leading, bodyWithTrailing].join('\n');
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
    const merged = this._defaults ? { ...this._defaults, ...options } : options;
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
