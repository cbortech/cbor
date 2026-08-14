import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import { CborTextString } from './CborTextString';
import { MT_TEXT, AI_INDEFINITE, BREAK_CODE } from '../cbor/constants';
import type { CborWriter } from '../cbor/encode';
import {
  formatTrailingComments,
  hasPreservedComments,
  pushAll,
  serializeContainer,
} from '../cdn/serialize-utils';
import { byteToHexUpper } from '../utils/hex';

/** CBOR Major Type 3 — indefinite-length UTF-8 text string (chunked). */
export class CborIndefiniteTextString extends CborItem {
  readonly indefiniteLength = true as const;
  readonly chunks: CborTextString[];

  constructor(chunks: CborTextString[]) {
    super();
    this.chunks = chunks;
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    writer.writeByte((MT_TEXT << 5) | AI_INDEFINITE);
    for (const chunk of this.chunks) chunk._encode(writer, options);
    writer.writeByte(BREAK_CODE);
  }

  /**
   * True when any chunk is multi-word. Reachable when this node is a
   * *direct* entry of another container (`[(_ "two words")]`) — though even
   * then, its own `_toCDN()` already self-disqualifies internally in that
   * case, producing a multi-line self-render that the ordinary "entry's own
   * rendering has a line break" check would catch regardless of what this
   * method answers, so this mostly exists for robustness/consistency with
   * `CborTextString`/`CborByteString` rather than because some case is
   * otherwise unreachable. (`CborAppSeqResult`, which wraps this node for
   * results like `ilts<<...>>`, does *not* delegate to this method — it
   * tokenizes its own rendered output directly instead; see its doc for
   * why that turned out to be necessary.) `_strict` is intentionally
   * unused: a chunk is always CborTextString, whose own word count doesn't
   * depend on it.
   */
  override _isMultiWordText(
    options: ToCDNOptions | undefined,
    _strict = true
  ): boolean {
    return this.chunks.some((c) => c._isMultiWordText(options));
  }

  _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if ((options?.encodingIndicators ?? 'auto') === 'never') {
      const merged = this.chunks.map((c) => c.value).join('');
      return new CborTextString(merged)._toCDN(options, depth);
    }
    // `ilts<<...>>` (draft-27 §3.6) replaces the legacy `(_ ...)` marker
    // notation; falls back to it when `appPrefix` disables app-string
    // notation entirely.
    const useIlts =
      !!options?.modernStreamSyntax && options?.appPrefix !== false;
    if (!useIlts && this.chunks.length === 0) return '""_';
    return serializeContainer({
      node: this,
      options,
      depth,
      openChar: useIlts ? 'ilts<<' : '(',
      closeChar: useIlts ? '>>' : ')',
      count: this.chunks.length,
      indefiniteLength: true,
      indefiniteMarker: !useIlts,
      encodingWidth: undefined,
      hasEntryComments: () => this.chunks.some(hasPreservedComments),
      renderEntry: (i) => this.chunks[i]._toCDN(options, depth + 1),
      // Unlike CborEmbeddedCBOR (`<<...>>`), the legacy `(_ ...)` group
      // follows the same strict rule as CborArray/CborMap, gated behind
      // inlineLeafContainers: entryIsLeaf is trivially always true (chunks
      // can never be containers), but its presence is what signals "strict"
      // to serializeContainer's probe. `ilts<<...>>` is itself an
      // app-sequence form, so it always collapses like
      // CborEmbeddedCBOR instead (loose rule, entryIsLeaf omitted).
      entryIsLeaf: useIlts ? undefined : () => true,
      alwaysInlineLeaf: useIlts,
      entryIsMultiWordText: (i) =>
        this.chunks[i]._isMultiWordText(options, !useIlts),
      entryLeadingNode: (i) => this.chunks[i],
      entryTrailing: (i, style) =>
        formatTrailingComments(this.chunks[i], style),
    });
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: byteToHexUpper((MT_TEXT << 5) | AI_INDEFINITE),
        comment: 'Start indefinite-length text string',
      },
    ];
    for (const chunk of this.chunks)
      pushAll(lines, chunk._toHexDump(depth + 1, options));
    lines.push({ depth, hex: byteToHexUpper(BREAK_CODE), comment: '"break"' });
    return lines;
  }

  _toJS(_options?: ToJSOptions): unknown {
    return this.chunks.map((c) => c.value).join('');
  }
}
