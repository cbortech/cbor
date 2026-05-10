import type {
  CborComment,
  ToEDNOptions,
  ToJSOptions,
  ToCBOROptions,
} from '../types';
import { CBOR_OMIT } from '../types';
import { MapEntries } from '../mapEntries';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import { CborTextString } from './CborTextString';
import { MT_MAP, AI_INDEFINITE, BREAK_CODE } from '../cbor/constants';
import { writeHead, concat, type EncodingWidth } from '../cbor/encode';
import {
  resolveIndent,
  indentOf,
  resolveSeparators,
  formatDanglingComments,
  formatLeadingComments,
  hasContainerLayoutComments,
  hasPreservedComments,
} from '../edn/serialize-utils';

/** CBOR Major Type 5 — map (definite- or indefinite-length). */
export class CborMap extends CborItem {
  readonly entries: [CborItem, CborItem][];
  readonly indefiniteLength: boolean;
  readonly encodingWidth: EncodingWidth | undefined;

  constructor(
    entries: [CborItem, CborItem][],
    options?: { indefiniteLength?: boolean; encodingWidth?: EncodingWidth }
  ) {
    super();
    this.entries = entries;
    this.indefiniteLength = options?.indefiniteLength ?? false;
    this.encodingWidth = options?.encodingWidth;
  }

  _toCBOR(options?: ToCBOROptions): Uint8Array {
    if (this.indefiniteLength) {
      const parts: Uint8Array[] = [
        new Uint8Array([(MT_MAP << 5) | AI_INDEFINITE]),
      ];
      for (const [k, v] of this.entries) {
        parts.push(k._toCBOR(options), v._toCBOR(options));
      }
      parts.push(new Uint8Array([BREAK_CODE]));
      return concat(parts);
    }
    const parts = [
      writeHead(MT_MAP, BigInt(this.entries.length), this.encodingWidth),
    ];
    for (const [k, v] of this.entries) {
      parts.push(k._toCBOR(options), v._toCBOR(options));
    }
    return concat(parts);
  }

  override _toEDN(options: ToEDNOptions | undefined, depth: number): string {
    let indentStr = resolveIndent(options);
    const preserveComments = options?.preserveComments;
    const hasComments =
      preserveComments &&
      (hasContainerLayoutComments(this) ||
        this.entries.some(
          ([key, value]) =>
            hasPreservedComments(key) || hasPreservedComments(value)
        ));
    if (indentStr === null && hasComments) indentStr = '  ';
    const { inlineSep, multilineSep, trailSep, colSep } = resolveSeparators(
      options,
      indentStr === null
    );
    const eiSuffix =
      !this.indefiniteLength && this.encodingWidth !== undefined
        ? `_${this.encodingWidth} `
        : '';
    const open = this.indefiniteLength ? '{_ ' : `{${eiSuffix}`;

    if (indentStr === null || (this.entries.length === 0 && !hasComments)) {
      // single-line
      const inner = this.entries
        .map(
          ([k, v]) =>
            `${k._toEDN(options, depth + 1)}${colSep}${v._toEDN(options, depth + 1)}`
        )
        .join(inlineSep);
      if (this.indefiniteLength) {
        return this.entries.length === 0 ? '{_ }' : `{_ ${inner}}`;
      }
      return `{${eiSuffix}${inner}}`;
    }

    // multi-line
    const childIndent = indentOf(indentStr, depth + 1);
    const closeIndent = indentOf(indentStr, depth);
    const lines: string[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const [k, v] = this.entries[i];
      if (preserveComments) {
        lines.push(...formatLeadingComments(k, childIndent));
      }
      const sep = i < this.entries.length - 1 ? multilineSep : trailSep;
      const entryComments = preserveComments
        ? formatMapEntryTrailingComments([
            ...(k.comments?.trailing ?? []),
            ...(v.comments?.leading ?? []),
            ...(v.comments?.trailing ?? []),
          ])
        : '';
      lines.push(
        `${childIndent}${k._toEDN(options, depth + 1)}${colSep}${v._toEDN(options, depth + 1)}${sep}${entryComments}`
      );
    }
    if (preserveComments)
      lines.push(...formatDanglingComments(this, childIndent));
    const body = lines.join('\n');
    return `${open}\n${body}\n${closeIndent}}`;
  }

  override _toHexDump(depth: number, options?: ToEDNOptions): AnnotatedLine[] {
    const byteHex = (b: number) =>
      b.toString(16).toUpperCase().padStart(2, '0');
    const toHex = (bytes: Uint8Array) =>
      Array.from(bytes, (b) =>
        b.toString(16).toUpperCase().padStart(2, '0')
      ).join(' ');

    if (this.indefiniteLength) {
      const lines: AnnotatedLine[] = [
        {
          depth,
          hex: byteHex((MT_MAP << 5) | AI_INDEFINITE),
          comment: 'Start indefinite-length map',
        },
      ];
      for (const [k, v] of this.entries) {
        lines.push(...k._toHexDump(depth + 1, options));
        lines.push(...v._toHexDump(depth + 1, options));
      }
      lines.push({ depth, hex: byteHex(BREAK_CODE), comment: '"break"' });
      return lines;
    }
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: toHex(
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
        const key = k instanceof CborTextString ? k.value : k.toEDN();
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
        lastIdx.set(k instanceof CborTextString ? k.value : k.toEDN(), i);
      }
      for (let i = 0; i < this.entries.length; i++) {
        const [k, v] = this.entries[i];
        const key = k instanceof CborTextString ? k.value : k.toEDN();
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

function formatMapEntryTrailingComments(comments: CborComment[]): string {
  if (comments.length === 0) return '';
  return ' ' + comments.map((comment) => comment.text.trimEnd()).join(' ');
}
