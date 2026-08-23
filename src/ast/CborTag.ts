import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem, needsItemDispatch, ROOT_OCCURRENCE } from './CborItem';
import { Tag } from '../tag';
import type { AnnotatedLine, Occurrence } from './CborItem';
import { MT_TAG } from '../cbor/constants';
import {
  writeHead,
  writeHeadTo,
  type CborWriter,
  type EncodingWidth,
} from '../cbor/encode';
import {
  resolveEiSuffix,
  canonicalEncodingWidth,
  isMultiWordRenderedLiteral,
  pushAll,
  renderSingleChildWithComments,
} from '../cdn/serialize-utils';
import { bytesToSpacedHexUpper } from '../utils/hex';

/** CBOR Major Type 6 — tagged data item. */
export class CborTag extends CborItem {
  readonly tag: bigint;
  readonly content: CborItem;
  encodingWidth: EncodingWidth | undefined;
  /**
   * Original CDN digit spelling of the tag number (base + digits, without
   * the encoding-indicator suffix), set by the parser when this tag came
   * from CDN text. Used by `_toCDN()` to round-trip the tag number's base
   * (`0x3e7`, decimal, …) when `preserveNumberFormat` is set.
   */
  ednSource?: string;

  constructor(
    tag: number | bigint,
    content: CborItem,
    options?: { encodingWidth?: EncodingWidth; ednSource?: string }
  ) {
    super();
    this.tag = BigInt(tag);
    if (this.tag < 0n)
      throw new RangeError('CborTag tag number must be non-negative');
    this.content = content;
    this.encodingWidth = options?.encodingWidth;
    this.ednSource = options?.ednSource;
  }

  override get _containsCdnContainer(): boolean {
    return this.content._containsCdnContainer;
  }

  /**
   * Checked by tokenizing `this._toCDN()`'s own actual output — not by
   * delegating to `this.content._isMultiWordText()` (a semantic prediction
   * from the AST) — because a subclass may override `_toCDN()` to render
   * something that doesn't match generic `tagNum(content)` notation at all
   * (`CborTaggedIpExt` renders `IP<<'192.0.2.42'>>`, `CborTaggedEpochDtExt`
   * renders `DT'...'`/`DT<<...>>`, ...); a check based on `this.content`
   * would be looking at the wrong thing entirely for those. Tokenizing the
   * real output instead is exact regardless of which class produced it —
   * see `isMultiWordRenderedLiteral`, which also handles the plain,
   * generic-tag case (peeling `tagNum[_EI](...)` to see what's inside, so
   * `100(dt'...')` and `100("two words")` still work the same as before).
   *
   * Deliberately *not* cached: an earlier version cached this render on
   * the instance keyed by `options` reference alone, which was wrong two
   * ways — (1) `preserveConcatenation`'s continuation-line indentation
   * *does* depend on depth even for leaf content, so a render cached at
   * depth 0 here and reused by `_toCDN`'s real render at a different depth
   * produced under-indented continuation lines; (2) the cache persisted
   * on the node forever and was keyed only by object identity, so
   * mutating the same `options` object between two `toCDN()` calls
   * silently returned the first call's stale result. `this` is re-rendered
   * here and again by the real `_toCDN` call from whatever holds this
   * entry — an accepted, narrow cost (only tag-wrapped entries reach this
   * at all).
   */
  override _isMultiWordText(
    options: ToCDNOptions | undefined,
    strict = true,
    path?: readonly unknown[]
  ): boolean {
    return isMultiWordRenderedLiteral(this._toCDN(options, 0, path), strict);
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    writeHeadTo(writer, MT_TAG, this.tag, this.encodingWidth);
    this.content._encode(writer, options);
  }

  override _toCDN(
    options: ToCDNOptions | undefined,
    depth: number,
    path?: readonly unknown[]
  ): string {
    const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
      canonicalEncodingWidth(this.tag)
    );
    const tagStr =
      options?.preserveNumberFormat && this.ednSource !== undefined
        ? this.ednSource
        : this.tag.toString();
    // A tag wrapper adds no path segment of its own — the content shares
    // this tag's own path (see CdnItemContext.path) and gets its own
    // itemOptions resolved against it (`_resolveCdnOptions` is a no-op
    // when itemOptions isn't in play, so this is always safe to call).
    const contentOptions = this.content._resolveCdnOptions(
      options,
      path ?? [],
      { parent: this }
    );
    const wrapped = renderSingleChildWithComments(
      this.content,
      this,
      options,
      contentOptions,
      depth,
      (childDepth) => this.content._toCDN(contentOptions, childDepth, path),
      '(',
      ')'
    );
    return `${tagStr}${suffix}${wrapped}`;
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: bytesToSpacedHexUpper(
          writeHead(MT_TAG, this.tag, this.encodingWidth)
        ),
        comment: `Tag ${this.tag}`,
      },
    ];
    pushAll(
      lines,
      this.content._toHexDump(depth + 1, { ...options, appPrefix: false })
    );
    return lines;
  }

  _toJS(
    options?: ToJSOptions,
    path?: readonly unknown[],
    occurrence?: Occurrence
  ): unknown {
    // A tag wrapper adds no path segment — or occurrence — of its own: the
    // content shares this tag's own path (see ItemContext.path) and its own
    // cache-matching identity (see Occurrence) unchanged.
    const value = needsItemDispatch(options)
      ? this.content._toJSChild(
          options,
          path ?? [],
          occurrence ?? ROOT_OCCURRENCE,
          { parent: this }
        )
      : this.content._toJS(options);
    return options?.stripTags ? value : Tag.set(value, this.tag);
  }
}
