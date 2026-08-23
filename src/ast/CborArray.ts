import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CBOR_OMIT } from '../types';
import {
  CborItem,
  needsItemDispatch,
  needsCdnItemDispatch,
  withoutReviver,
  ROOT_OCCURRENCE,
  RAW_PASS_MARKER,
} from './CborItem';
import type { AnnotatedLine } from './CborItem';
import { MT_ARRAY, AI_INDEFINITE, BREAK_CODE } from '../cbor/constants';
import {
  writeHead,
  writeHeadTo,
  type CborWriter,
  type EncodingWidth,
} from '../cbor/encode';
import {
  formatTrailingComments,
  hasPreservedComments,
  pushAll,
  serializeContainer,
} from '../cdn/serialize-utils';
import { byteToHexUpper, bytesToSpacedHexUpper } from '../utils/hex';

/** CBOR Major Type 4 — array (definite- or indefinite-length). */
export class CborArray extends CborItem {
  readonly items: CborItem[];
  readonly indefiniteLength: boolean;
  encodingWidth: EncodingWidth | undefined;

  constructor(
    items: CborItem[],
    options?: { indefiniteLength?: boolean; encodingWidth?: EncodingWidth }
  ) {
    super();
    this.items = items;
    this.indefiniteLength = options?.indefiniteLength ?? false;
    this.encodingWidth = options?.encodingWidth;
  }

  override get _containsCdnContainer(): boolean {
    return true;
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    if (this.indefiniteLength) {
      writer.writeByte((MT_ARRAY << 5) | AI_INDEFINITE);
      for (const item of this.items) item._encode(writer, options);
      writer.writeByte(BREAK_CODE);
      return;
    }
    writeHeadTo(writer, MT_ARRAY, this.items.length, this.encodingWidth);
    for (const item of this.items) item._encode(writer, options);
  }

  override _toCDN(
    options: ToCDNOptions | undefined,
    depth: number,
    path?: readonly unknown[]
  ): string {
    const basePath = path ?? [];
    const dispatch = needsCdnItemDispatch(options);
    // Resolves itemOptions for element `i` fresh on each call — including
    // when both `renderEntry` and `entryIsMultiWordText` ask for the same
    // `i` during one parent render — rather than caching, matching this
    // whole mechanism's design (see the "toCDN() per-item dispatch" note
    // in CborItem.ts).
    const childOptions = (i: number): ToCDNOptions | undefined =>
      dispatch
        ? this.items[i]._resolveCdnOptions(options, [...basePath, i], {
            parent: this,
          })
        : options;
    return serializeContainer({
      node: this,
      options,
      depth,
      openChar: '[',
      closeChar: ']',
      count: this.items.length,
      indefiniteLength: this.indefiniteLength,
      encodingWidth: this.encodingWidth,
      hasEntryComments: (i) => hasPreservedComments(this.items[i]),
      renderEntry: (i) =>
        this.items[i]._toCDN(
          childOptions(i),
          depth + 1,
          dispatch ? [...basePath, i] : undefined
        ),
      entryIsLeaf: (i) => !this.items[i]._containsCdnContainer,
      entryIsMultiWordText: (i) =>
        this.items[i]._isMultiWordText(
          childOptions(i),
          true,
          dispatch ? [...basePath, i] : undefined
        ),
      entryLeadingNode: (i) => this.items[i],
      entryTrailing: (i, style) => formatTrailingComments(this.items[i], style),
      entryOptions: dispatch ? childOptions : undefined,
    });
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    if (this.indefiniteLength) {
      const lines: AnnotatedLine[] = [
        {
          depth,
          hex: byteToHexUpper((MT_ARRAY << 5) | AI_INDEFINITE),
          comment: 'Start indefinite-length array',
        },
      ];
      for (const item of this.items)
        pushAll(lines, item._toHexDump(depth + 1, options));
      lines.push({
        depth,
        hex: byteToHexUpper(BREAK_CODE),
        comment: '"break"',
      });
      return lines;
    }
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: bytesToSpacedHexUpper(
          writeHead(MT_ARRAY, BigInt(this.items.length), this.encodingWidth)
        ),
        comment: `Array of length ${this.items.length}`,
      },
    ];
    for (const item of this.items)
      pushAll(lines, item._toHexDump(depth + 1, options));
    return lines;
  }

  _toJS(
    options?: ToJSOptions,
    path?: readonly unknown[],
    occurrence?: readonly unknown[]
  ): unknown {
    const reviver = options?.reviver;
    const dispatch = needsItemDispatch(options);
    const occ = occurrence ?? ROOT_OCCURRENCE;
    // `rawPass` marks a call as belonging to the raw pre-population pass
    // below — its occurrence gets `RAW_PASS_MARKER` inserted (see
    // `Occurrence`) so it can never be reused by the real, revived pass,
    // even indirectly through some other, more deeply nested raw pass.
    const convert = (
      item: CborItem,
      i: number,
      opts: ToJSOptions | undefined,
      rawPass: boolean
    ) =>
      dispatch
        ? item._toJSChild(
            opts,
            [...(path ?? []), i],
            // Cache-matching identity: chained from this array's own
            // occurrence plus the element's own index, never from a
            // converted JS value — see `Occurrence`.
            rawPass ? [...occ, RAW_PASS_MARKER, i] : [...occ, i],
            { parent: this }
          )
        : item._toJS(opts);
    if (!reviver)
      return this.items.map((item, i) => convert(item, i, options, false));
    // First pass: pre-populate holder with unrevived values so later siblings
    // are still raw when earlier callbacks run (matches JSON.parse sibling
    // timing). `itemOptions`/`extensions` still apply here — see
    // `withoutReviver` — since this holder is directly observable through
    // `this[j]` inside an earlier sibling's own reviver call, not just
    // internal scaffolding; the `RAW_PASS_MARKER` in each element's
    // occurrence above keeps this pass's resolutions from being reused by
    // the real, revived pass below.
    const optNoReviver = withoutReviver(options);
    const holder: unknown[] = this.items.map((item, i) =>
      convert(item, i, optNoReviver, true)
    );
    // Second pass: revive each element depth-first, splice out undefined entries
    // immediately so `this` reflects the compacted in-progress array.
    // Original indices are used as reviver keys; undefined → omit (compact,
    // differs from JSON.parse which leaves holes).
    let deleted = 0;
    for (let i = 0; i < this.items.length; i++) {
      const hIdx = i - deleted;
      const val = convert(this.items[i], i, options, false);
      const rv = reviver.call(holder, String(i), val);
      const omit =
        rv === CBOR_OMIT || (options?.undefinedOmits && rv === undefined);
      if (omit) {
        holder.splice(hIdx, 1);
        deleted++;
      } else {
        holder[hIdx] = rv;
      }
    }
    return holder;
  }
}
