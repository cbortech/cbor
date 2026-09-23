import type {
  CborComment,
  ToCDNOptions,
  ToJSOptions,
  ToCBOROptions,
} from '../types';
import { CBOR_OMIT } from '../types';
import { MapEntries } from '../mapEntries';
import {
  CborItem,
  needsItemDispatch,
  needsCdnItemDispatch,
  withoutReviver,
  ROOT_OCCURRENCE,
  RAW_PASS_MARKER,
} from './CborItem';
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
  isPrefixedLiteralText,
  pushAll,
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

  override _toCDN(
    options: ToCDNOptions | undefined,
    depth: number,
    path?: readonly unknown[]
  ): string {
    const basePath = path ?? [];
    const dispatch = needsCdnItemDispatch(options);
    // `entryIsMultiWordText` needs each side's own rendering (not just the
    // combined "key: value" string serializeContainer sees — see its
    // comment below), and `renderEntry` needs the exact same strings right
    // after — cached per index so a custom key/value's `_toCDN()` is never
    // called twice for the same render, matching serializeContainer's own
    // "never serialize more than once per parent render" invariant. The
    // resolved per-item options (and, for a non-text key, the `toCDN()`
    // rendering used as its path label — see `ItemContext.path`'s CDN
    // counterpart) are cached the same way, for the same reason: an
    // `itemOptions` callback should not be asked twice for one entry
    // within a single parent render just because both `renderEntry` and
    // `entryIsMultiWordText` need its result.
    const optsCache: (
      [unknown, ToCDNOptions | undefined, ToCDNOptions | undefined] | undefined
    )[] = [];
    const resolveKV = (
      i: number
    ): [unknown, ToCDNOptions | undefined, ToCDNOptions | undefined] => {
      let r = optsCache[i];
      if (!r) {
        const [k, v] = this.entries[i];
        if (!dispatch) {
          r = [undefined, options, options];
        } else {
          // Independent of `options`/depth — a stable label identifying
          // this entry's key for path purposes, same derivation `toJS()`'s
          // own object-mode key naming uses, not the entry's real render.
          const key = k instanceof CborTextString ? k.value : k.toCDN();
          r = [
            key,
            k._resolveCdnOptions(options, basePath, {
              parent: this,
              isMapKey: true,
              keyNode: k,
            }),
            v._resolveCdnOptions(options, [...basePath, key], {
              parent: this,
              keyNode: k,
            }),
          ];
        }
        optsCache[i] = r;
      }
      return r;
    };
    const kvCache: ([string, string] | undefined)[] = [];
    const renderKV = (i: number): [string, string] => {
      let kv = kvCache[i];
      if (!kv) {
        const [k, v] = this.entries[i];
        const [key, kOpts, vOpts] = resolveKV(i);
        kv = [
          k._toCDN(kOpts, depth + 1, dispatch ? basePath : undefined),
          v._toCDN(vOpts, depth + 1, dispatch ? [...basePath, key] : undefined),
        ];
        kvCache[i] = kv;
      }
      return kv;
    };
    return serializeContainer({
      node: this,
      options,
      depth,
      openChar: '{',
      closeChar: '}',
      count: this.entries.length,
      indefiniteLength: this.indefiniteLength,
      encodingWidth: this.encodingWidth,
      hasEntryComments: (i) => {
        const [key, value] = this.entries[i];
        return hasPreservedComments(key) || hasPreservedComments(value);
      },
      renderEntry: (i, colSep) => {
        const [kStr, vStr] = renderKV(i);
        return `${kStr}${colSep}${vStr}`;
      },
      entryIsLeaf: (i) => {
        const [k, v] = this.entries[i];
        return !k._containsCdnContainer && !v._containsCdnContainer;
      },
      entryIsMultiWordText: (i) => {
        const [k, v] = this.entries[i];
        const [key, kOpts, vOpts] = resolveKV(i);
        const kPath = dispatch ? basePath : undefined;
        const vPath = dispatch ? [...basePath, key] : undefined;
        if (
          k._isMultiWordText(kOpts, true, kPath) ||
          v._isMultiWordText(vOpts, true, vPath)
        )
          return true;
        // serializeContainer's own isPrefixedLiteralText check only sees a
        // map entry's combined "key: value" rendering, which can't tell a
        // prefixed literal in the value (or a non-leading key) apart from
        // one embedded inside the other's own quoted content — so check
        // each side's own rendering here instead, same as the multi-word
        // check above already does for text/byte strings.
        const [kStr, vStr] = renderKV(i);
        return isPrefixedLiteralText(kStr) || isPrefixedLiteralText(vStr);
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
      // The entry's own comment handling follows the key's resolved
      // options — same as entryLeadingNode's own choice of the key as the
      // entry's leading-comment anchor.
      entryOptions: dispatch ? (i) => resolveKV(i)[1] : undefined,
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
        pushAll(lines, k._toHexDump(depth + 1, options));
        pushAll(lines, v._toHexDump(depth + 1, options));
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
      pushAll(lines, k._toHexDump(depth + 1, options));
      pushAll(lines, v._toHexDump(depth + 1, options));
    }
    return lines;
  }

  _toJS(
    options?: ToJSOptions,
    path?: readonly unknown[],
    occurrence?: readonly unknown[]
  ): unknown {
    const reviver = options?.reviver;
    const dispatch = needsItemDispatch(options);
    const basePath = path ?? [];
    const occ = occurrence ?? ROOT_OCCURRENCE;
    const toEntries = () => {
      const convertPair = (
        k: CborItem,
        v: CborItem,
        i: number,
        opts: ToJSOptions | undefined
      ): [unknown, unknown] => {
        if (!dispatch) return [k._toJS(opts), v._toJS(opts)];
        // The key has no path segment of its own — it names the value's —
        // so it's converted first, against the parent's own path, and its
        // result becomes the value's path segment. The occurrence chains
        // (unlike path) are derived purely from this map's own occurrence
        // plus this entry's own ordinal `i`, never from the key's converted
        // JS value — see `Occurrence`.
        const kJs = k._toJSChild(opts, basePath, [...occ, `k${i}`], {
          parent: this,
          isMapKey: true,
          keyNode: k,
        });
        const vJs = v._toJSChild(opts, [...basePath, kJs], [...occ, `v${i}`], {
          parent: this,
          keyNode: k,
        });
        return [kJs, vJs];
      };
      const result = MapEntries.from(this.entries, ([k, v], i) =>
        convertPair(k, v, i, options)
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
      // `rawPass` marks a call as belonging to the raw pre-population pass
      // below — its occurrence gets `RAW_PASS_MARKER` inserted (see
      // `Occurrence`) so it can never be reused by the real, revived pass,
      // even indirectly through some other, more deeply nested raw pass.
      const convertValue = (
        k: CborItem,
        v: CborItem,
        key: string,
        i: number,
        opts: ToJSOptions | undefined,
        rawPass: boolean
      ) =>
        dispatch
          ? v._toJSChild(
              opts,
              [...basePath, key],
              // Derived from this map's own occurrence plus this entry's
              // own ordinal `i`, not from `key` (a converted JS value) —
              // see `Occurrence`.
              rawPass ? [...occ, RAW_PASS_MARKER, `v${i}`] : [...occ, `v${i}`],
              { parent: this, keyNode: k }
            )
          : v._toJS(opts);
      // First pass: pre-populate holder with unrevived values so all sibling
      // keys are visible in `this` when reviver runs (matches JSON.parse).
      // `itemOptions`/`extensions` still apply here — see `withoutReviver`
      // — since this holder is directly observable through `this[key]`
      // inside an earlier sibling's own reviver call, not just internal
      // scaffolding; the `RAW_PASS_MARKER` in each value's occurrence above
      // keeps this pass's resolutions from being reused by the real,
      // revived pass below. When there's no reviver, this loop's result
      // *is* the final output (see `if (!reviver) return holder` below) —
      // `withoutReviver` is then a no-op (`reviver` was already unset), and
      // `rawPass` is `false` so no marker is inserted, matching that this
      // loop is not throwaway in that case.
      const optNoReviver = withoutReviver(options);
      const holder: Record<string, unknown> = {};
      for (let i = 0; i < this.entries.length; i++) {
        const [k, v] = this.entries[i];
        const key =
          k instanceof CborTextString
            ? k.value
            : (k._jsObjectKey(options) ?? k.toCDN());
        const raw = convertValue(k, v, key, i, optNoReviver, !!reviver);
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
        lastIdx.set(
          k instanceof CborTextString
            ? k.value
            : (k._jsObjectKey(options) ?? k.toCDN()),
          i
        );
      }
      for (let i = 0; i < this.entries.length; i++) {
        const [k, v] = this.entries[i];
        const key =
          k instanceof CborTextString
            ? k.value
            : (k._jsObjectKey(options) ?? k.toCDN());
        if (lastIdx.get(key) !== i) continue;
        const val = convertValue(k, v, key, i, options, false);
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
    // A key is object-eligible under 'auto' when it's a text string, or when
    // it offers an alternate key spelling via `_jsObjectKey()` (a CDDL
    // e-ref annotated integer key; see `extensions/eref.ts`) — which, by
    // default, every such key does: `eRefKeys` defaults to `true` for a key
    // that exists only because a schema named it in the first place, so
    // only an *explicit* `eRefKeys: false` turns this off (see
    // `CborERefUint`/`CborERefNint`'s own `_jsObjectKey()`, which under
    // `eRefKeys: false` falls back to the key's own plain numeric string
    // rather than `undefined` — so `eRefKeys !== false` is checked here too;
    // it returns `undefined` for a label `fromJS()` couldn't convert back,
    // making that key ineligible like any plain integer).
    //
    // Eligibility alone isn't enough, though: an e-ref name can collide
    // with an unrelated entry's own genuine text key of the same spelling
    // (e.g. `&(title: -1)` alongside a literal `"title"` key in the same
    // map) — 'auto' silently overwriting one with the other, via the same
    // property, would be a much less obvious data loss than the *already*
    // -accepted case of two literal duplicate text keys colliding (which
    // 'auto' already tolerates today, independent of e-ref, so that case is
    // deliberately left alone below). Falls back to entries/Map whenever a
    // collision involves at least one non-text side; an explicit
    // `mapAs: 'object'` still accepts it, same as it already does for a
    // literal duplicate key.
    const objectEligible = (k: CborItem): boolean =>
      k instanceof CborTextString ||
      (options?.eRefKeys !== false && k._jsObjectKey(options) !== undefined);
    const isAutoObjectSafe = (): boolean => {
      // Value: whether every occurrence of this key string seen so far was
      // a genuine CborTextString (not e.g. an e-ref name).
      const allTextSoFar = new Map<string, boolean>();
      for (const [k] of this.entries) {
        if (!objectEligible(k)) return false;
        const isText = k instanceof CborTextString;
        const key = isText
          ? (k as CborTextString).value
          : k._jsObjectKey(options)!;
        const priorAllText = allTextSoFar.get(key);
        if (priorAllText !== undefined && !(priorAllText && isText))
          return false;
        allTextSoFar.set(key, isText);
      }
      return true;
    };
    if (isAutoObjectSafe()) return toObject();
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
