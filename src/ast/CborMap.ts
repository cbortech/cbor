import type {
  CborComment,
  ToCDNOptions,
  ToJSOptions,
  ToCBOROptions,
} from '../types';
import { CBOR_OMIT } from '../types';
import { MapEntries } from '../mapEntries';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import { CborTextString } from './CborTextString';
import { MT_MAP, AI_INDEFINITE, BREAK_CODE } from '../cbor/constants';
import {
  writeHead,
  writeHeadTo,
  type CborWriter,
  type EncodingWidth,
} from '../cbor/encode';
import {
  convertCommentText,
  hasPreservedComments,
  serializeContainer,
} from '../cdn/serialize-utils';
import { byteToHexUpper, bytesToSpacedHexUpper } from '../utils/hex';

/** CBOR Major Type 5 — map (definite- or indefinite-length). */
export class CborMap extends CborItem {
  readonly entries: [CborItem, CborItem][];
  readonly indefiniteLength: boolean;
  encodingWidth: EncodingWidth | undefined;

  constructor(
    entries: [CborItem, CborItem][],
    options?: { indefiniteLength?: boolean; encodingWidth?: EncodingWidth }
  ) {
    super();
    this.entries = entries;
    this.indefiniteLength = options?.indefiniteLength ?? false;
    this.encodingWidth = options?.encodingWidth;
  }

  override get _containsCdnContainer(): boolean {
    return true;
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    if (this.indefiniteLength) {
      writer.writeByte((MT_MAP << 5) | AI_INDEFINITE);
      for (const [k, v] of this.entries) {
        k._encode(writer, options);
        v._encode(writer, options);
      }
      writer.writeByte(BREAK_CODE);
      return;
    }
    writeHeadTo(writer, MT_MAP, this.entries.length, this.encodingWidth);
    for (const [k, v] of this.entries) {
      k._encode(writer, options);
      v._encode(writer, options);
    }
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    return serializeContainer({
      node: this,
      options,
      depth,
      openChar: '{',
      closeChar: '}',
      count: this.entries.length,
      indefiniteLength: this.indefiniteLength,
      encodingWidth: this.encodingWidth,
      hasEntryComments: () =>
        this.entries.some(
          ([key, value]) =>
            hasPreservedComments(key) || hasPreservedComments(value)
        ),
      renderEntry: (i, colSep) => {
        const [k, v] = this.entries[i];
        return `${k._toCDN(options, depth + 1)}${colSep}${v._toCDN(options, depth + 1)}`;
      },
      entryIsLeaf: (i) => {
        const [k, v] = this.entries[i];
        return !k._containsCdnContainer && !v._containsCdnContainer;
      },
      // Leading comments come from the key; the value's leading comments
      // render inline after the entry (see entryTrailing).
      entryLeadingNode: (i) => this.entries[i][0],
      entryTrailing: (i, style) => {
        const [k, v] = this.entries[i];
        return formatMapEntryTrailingComments(
          [
            ...(k.comments?.trailing ?? []),
            ...(v.comments?.leading ?? []),
            ...(v.comments?.trailing ?? []),
          ],
          style
        );
      },
    });
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    if (this.indefiniteLength) {
      const lines: AnnotatedLine[] = [
        {
          depth,
          hex: byteToHexUpper((MT_MAP << 5) | AI_INDEFINITE),
          comment: 'Start indefinite-length map',
        },
      ];
      for (const [k, v] of this.entries) {
        lines.push(...k._toHexDump(depth + 1, options));
        lines.push(...v._toHexDump(depth + 1, options));
      }
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
          writeHead(MT_MAP, BigInt(this.entries.length), this.encodingWidth)
        ),
        comment: `Map of length ${this.entries.length}`,
      },
    ];
    for (const [k, v] of this.entries) {
      lines.push(...k._toHexDump(depth + 1, options));
      lines.push(...v._toHexDump(depth + 1, options));
    }
    return lines;
  }

  _toJS(options?: ToJSOptions): unknown {
    const reviver = options?.reviver;
    const toEntries = () => {
      const result = MapEntries.from(
        this.entries,
        ([k, v]) => [k._toJS(options), v._toJS(options)] as [unknown, unknown]
      );
      if (!reviver) return result;
      const uOmits = options?.undefinedOmits;
      for (let i = 0; i < result.length; i++) {
        const [k, v] = result[i];
        const rv = reviver.call(result, k, v);
        if (rv === CBOR_OMIT || (uOmits && rv === undefined))
          result.splice(i--, 1);
        else result[i] = [k, rv];
      }
      return result;
    };
    const toObject = () => {
      // First pass: pre-populate holder with unrevived values so all sibling
      // keys are visible in `this` when reviver runs (matches JSON.parse).
      const optNoReviver = options
        ? { ...options, reviver: undefined }
        : undefined;
      const holder: Record<string, unknown> = {};
      for (const [k, v] of this.entries) {
        const key = k instanceof CborTextString ? k.value : k.toCDN();
        const raw = v._toJS(optNoReviver);
        if (key === '__proto__') {
          Object.defineProperty(holder, key, {
            value: raw,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        } else {
          holder[key] = raw;
        }
      }
      if (!reviver) return holder;
      // Second pass: process each property sequentially depth-first.
      // Only the last occurrence of each key is revived to avoid duplicate
      // callbacks when CBOR maps contain repeated keys.
      const lastIdx = new Map<string, number>();
      for (let i = 0; i < this.entries.length; i++) {
        const [k] = this.entries[i];
        lastIdx.set(k instanceof CborTextString ? k.value : k.toCDN(), i);
      }
      for (let i = 0; i < this.entries.length; i++) {
        const [k, v] = this.entries[i];
        const key = k instanceof CborTextString ? k.value : k.toCDN();
        if (lastIdx.get(key) !== i) continue;
        const val = v._toJS(options);
        const rv = reviver.call(holder, key, val);
        const omit =
          rv === CBOR_OMIT || (options?.undefinedOmits && rv === undefined);
        if (!omit) {
          if (key === '__proto__') {
            Object.defineProperty(holder, key, {
              value: rv,
              writable: true,
              enumerable: true,
              configurable: true,
            });
          } else {
            holder[key] = rv;
          }
        } else {
          delete holder[key];
        }
      }
      return holder;
    };

    if (options?.mapAs === 'entries') return toEntries();
    if (options?.mapAs === 'object') return toObject();
    if (this.entries.every(([k]) => k instanceof CborTextString))
      return toObject();
    return toEntries();
  }
}

function formatMapEntryTrailingComments(
  comments: CborComment[],
  style?: 'c-style' | 'cdn-style'
): string {
  if (comments.length === 0) return '';
  return (
    ' ' +
    comments
      .map((comment) => convertCommentText(comment, style).trimEnd())
      .join(' ')
  );
}
