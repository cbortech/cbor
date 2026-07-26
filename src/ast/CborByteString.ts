import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import { MT_BYTES } from '../cbor/constants';
import {
  writeHeadTo,
  type CborWriter,
  type EncodingWidth,
} from '../cbor/encode';
import {
  serializeBytes,
  resolveEiSuffix,
  resolveIndent,
  joinConcatParts,
  canonicalEncodingWidth,
  stripByteLiteralComments,
  danglingCommentsByGap,
  type ByteCommentSyntax,
} from '../cdn/serialize-utils';

/**
 * A preserved literal source, with any embedded comment stripped unless
 * `preserveComments` is set — the preserved spelling should still drop
 * comments by default, the same as an unpreserved literal re-derived from
 * its decoded value would. `commentSyntax` is `undefined` for a literal
 * family with no comment syntax at all (bare sqstr `'...'`) or one whose
 * comment syntax isn't known (an app-string extension other than the
 * specific built-in `b32`/`h32` objects — see `ednCommentSyntax`); in
 * either case the source is returned verbatim, since there's nothing safe
 * to strip.
 */
function preservedSource(
  source: string | undefined,
  options: ToCDNOptions | undefined,
  commentSyntax: ByteCommentSyntax | undefined
): string | undefined {
  if (source === undefined) return undefined;
  if (options?.preserveComments || commentSyntax === undefined) return source;
  return stripByteLiteralComments(source, commentSyntax);
}

/** One part of a byte string parsed from a CDN `+` concatenation chain. */
export interface CborByteStringPart {
  bytes: Uint8Array;
  /** Original literal source text, when the part came from a byte string token. */
  source?: string;
  /** Which comment syntax `source` recognizes, if any — see `ednCommentSyntax`. */
  commentSyntax?: ByteCommentSyntax;
  /**
   * Source span of this part's own literal token, when known — used to place
   * a comment sitting between two `+`-joined parts (attached to the whole
   * `CborByteString` as a `dangling` comment, since there is no per-part AST
   * node for it to attach to) at the right gap in `_toCDN`'s
   * `preserveConcatenation` branch. `undefined` for a part merged from a
   * single elided literal's own internal segments, which cannot have a
   * comment between them.
   */
  start?: number;
  end?: number;
}

/** CBOR Major Type 2 — definite-length byte string. */
export class CborByteString extends CborItem {
  readonly indefiniteLength = false as const;
  readonly value: Uint8Array;
  /** Preferred EDN encoding for this byte string. */
  readonly ednEncoding: 'hex' | 'base64' | 'base64url' | 'base32' | 'base32hex';
  encodingWidth: EncodingWidth | undefined;
  readonly ednSource: string | undefined;
  /**
   * Which comment syntax `ednSource` recognizes, if any — set once at parse
   * time by whoever actually knows the literal's real origin (see
   * `ByteCommentSyntax`), never re-derived later from its prefix string:
   * a user extension can register under any prefix, including one a
   * built-in (`b32`/`h32`) also uses, so the prefix string alone can't say
   * which comment rules (if any) actually apply. `undefined` when
   * `ednSource` has no comment syntax, or its extension's isn't known.
   */
  readonly ednCommentSyntax: ByteCommentSyntax | undefined;
  /** Part boundaries of the original `+` concatenation chain, if any. */
  readonly ednParts: readonly CborByteStringPart[] | undefined;

  constructor(
    value: Uint8Array,
    options?: {
      ednEncoding?: 'hex' | 'base64' | 'base64url' | 'base32' | 'base32hex';
      encodingWidth?: EncodingWidth;
      ednSource?: string;
      ednCommentSyntax?: ByteCommentSyntax;
      ednParts?: readonly CborByteStringPart[];
    }
  ) {
    super();
    this.value = value;
    this.ednEncoding = options?.ednEncoding ?? 'hex';
    this.encodingWidth = options?.encodingWidth;
    this.ednSource = options?.ednSource;
    this.ednCommentSyntax = options?.ednCommentSyntax;
    this.ednParts = options?.ednParts;
  }

  override _encodeTo(writer: CborWriter, _options?: ToCBOROptions): void {
    writeHeadTo(writer, MT_BYTES, this.value.length, this.encodingWidth);
    writer.writeBytes(this.value);
  }

  _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    const indentStr = resolveIndent(options);
    if (
      options?.preserveConcatenation &&
      // Preserved concatenation is a layout feature; single-line mode joins
      // the parts into one literal instead.
      indentStr !== null &&
      this.ednParts !== undefined &&
      this.ednParts.length > 1
    ) {
      const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
        canonicalEncodingWidth(BigInt(this.value.length))
      );
      let encoding = options?.bstrEncoding ?? this.ednEncoding;
      if (options?.appStrings === false && encoding !== 'hex') encoding = 'hex';
      const literals = this.ednParts.map((part) => {
        const source = options?.preserveByteString
          ? preservedSource(part.source, options, part.commentSyntax)
          : undefined;
        return source !== undefined
          ? source
          : serializeBytes(part.bytes, encoding, options?.sqstr);
      });
      literals[literals.length - 1] += suffix;
      const midComments = options?.preserveComments
        ? danglingCommentsByGap(
            this.comments?.dangling,
            this.ednParts,
            typeof options.preserveComments === 'string'
              ? options.preserveComments
              : undefined
          )
        : undefined;
      return joinConcatParts(literals, indentStr, _depth, midComments);
    }
    const preservedWhole = options?.preserveByteString
      ? preservedSource(this.ednSource, options, this.ednCommentSyntax)
      : undefined;
    if (
      preservedWhole !== undefined &&
      // In single-line mode a spelling that spans multiple lines (e.g. a
      // byte string with an interior line comment that survived stripping,
      // or a genuine interior line break) cannot be re-emitted.
      (indentStr !== null || !/[\r\n]/.test(preservedWhole))
    ) {
      // App-string byte strings (e.g. b32'...'_1) embed the EI inside ednSource.
      // Regular byte strings (h'...', b64'...') store EI separately in encodingWidth.
      if (/_[0-3i]$/.test(preservedWhole)) {
        const mode = options?.encodingIndicators ?? 'auto';
        if (mode === 'never') return preservedWhole.replace(/_[0-3i]$/, '');
        return preservedWhole; // 'auto' or 'always': EI already present
      }
      const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
        canonicalEncodingWidth(BigInt(this.value.length))
      );
      return preservedWhole + suffix;
    }
    const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
      canonicalEncodingWidth(BigInt(this.value.length))
    );
    let encoding = options?.bstrEncoding ?? this.ednEncoding;
    if (options?.appStrings === false && encoding !== 'hex') encoding = 'hex';
    return serializeBytes(this.value, encoding, options?.sqstr) + suffix;
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this.value;
  }
}
