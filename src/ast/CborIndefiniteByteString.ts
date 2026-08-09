import type { ToCDNOptions, ToJSOptions, ToCBOROptions } from '../types';
import { CborItem } from './CborItem';
import type { AnnotatedLine } from './CborItem';
import { CborByteString } from './CborByteString';
import { MT_BYTES, AI_INDEFINITE, BREAK_CODE } from '../cbor/constants';
import type { CborWriter } from '../cbor/encode';
import {
  formatTrailingComments,
  hasPreservedComments,
  pushAll,
  serializeContainer,
} from '../cdn/serialize-utils';
import { byteToHexUpper } from '../utils/hex';

/** CBOR Major Type 2 — indefinite-length byte string (chunked). */
export class CborIndefiniteByteString extends CborItem {
  readonly indefiniteLength = true as const;
  readonly chunks: CborByteString[];

  constructor(chunks: CborByteString[]) {
    super();
    this.chunks = chunks;
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    writer.writeByte((MT_BYTES << 5) | AI_INDEFINITE);
    for (const chunk of this.chunks) chunk._encode(writer, options);
    writer.writeByte(BREAK_CODE);
  }

  /**
   * True when any chunk's own decoded content, if it renders as bare sqstr
   * text, has two or more words. Reachable when this node is a *direct*
   * entry of another container (`[(_ "two words")]`) — though even then,
   * its own `_toCDN()` already self-disqualifies internally in that case
   * (a multi-word chunk forces a multi-line self-render), which the
   * ordinary "entry's own rendering has a line break" check would catch
   * regardless of what this method answers, so this mostly exists for
   * robustness/consistency with `CborTextString`/`CborByteString` rather
   * than because some case is otherwise unreachable.
   *
   * `CborAppSeqResult`, which wraps this node for results like
   * `ilbs<<...>>`, does *not* delegate to this method — it tokenizes its
   * own rendered output directly instead (`isMultiWordRenderedLiteral`),
   * which is exactly why `ilbs<<h'00'>>` stays an ordinary leaf (checked
   * under the loose rule, matching `<<...>>`) while `[h'00']`/`(_ h'00')`
   * still always disqualify — this method's own `_strict` (always `true`,
   * matching how a chunk renders when this container *is* regenerated
   * directly) plays no part in that distinction anymore, and a byte string
   * chunk's own `_isMultiWordText` doesn't consult `strict` at all
   * regardless (see `CborByteString`'s doc — its "prefixed literal" case
   * was removed there too).
   */
  override _isMultiWordText(
    options: ToCDNOptions | undefined,
    _strict = true
  ): boolean {
    return this.chunks.some((c) => c._isMultiWordText(options));
  }

  _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if ((options?.encodingIndicators ?? 'auto') === 'never') {
      const totalLen = this.chunks.reduce((sum, c) => sum + c.value.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of this.chunks) {
        merged.set(chunk.value, offset);
        offset += chunk.value.length;
      }
      return new CborByteString(merged)._toCDN(options, depth);
    }
    // `ilbs<<...>>` (draft-27 §3.6) replaces the legacy `(_ ...)` marker
    // notation; falls back to it when `appPrefix` disables app-string
    // notation entirely.
    const useIlbs =
      !!options?.modernStreamSyntax && options?.appPrefix !== false;
    if (!useIlbs && this.chunks.length === 0) return "''_";
    return serializeContainer({
      node: this,
      options,
      depth,
      openChar: useIlbs ? 'ilbs<<' : '(',
      closeChar: useIlbs ? '>>' : ')',
      count: this.chunks.length,
      indefiniteLength: true,
      indefiniteMarker: !useIlbs,
      encodingWidth: undefined,
      hasEntryComments: () => this.chunks.some(hasPreservedComments),
      renderEntry: (i) => this.chunks[i]._toCDN(options, depth + 1),
      // Unlike CborEmbeddedCBOR (`<<...>>`), the legacy `(_ ...)` group
      // follows the same strict rule as CborArray/CborMap, gated behind
      // inlineLeafContainers: entryIsLeaf is trivially always true (chunks
      // can never be containers), but its presence is what signals "strict"
      // to serializeContainer's probe — so a chunk that renders as a
      // prefixed literal (`h'...'`) always disqualifies inlining here, same
      // as it would in `[h'...']`. `ilbs<<...>>` is itself an
      // app-sequence form, so it always collapses like
      // CborEmbeddedCBOR instead (loose rule, entryIsLeaf omitted).
      entryIsLeaf: useIlbs ? undefined : () => true,
      alwaysInlineLeaf: useIlbs,
      entryIsMultiWordText: (i) =>
        this.chunks[i]._isMultiWordText(options, !useIlbs),
      entryLeadingNode: (i) => this.chunks[i],
      entryTrailing: (i, style) =>
        formatTrailingComments(this.chunks[i], style),
    });
  }

  override _toHexDump(depth: number, options?: ToCDNOptions): AnnotatedLine[] {
    const lines: AnnotatedLine[] = [
      {
        depth,
        hex: byteToHexUpper((MT_BYTES << 5) | AI_INDEFINITE),
        comment: 'Start indefinite-length byte string',
      },
    ];
    for (const chunk of this.chunks)
      pushAll(lines, chunk._toHexDump(depth + 1, options));
    lines.push({ depth, hex: byteToHexUpper(BREAK_CODE), comment: '"break"' });
    return lines;
  }

  _toJS(_options?: ToJSOptions): unknown {
    const totalLen = this.chunks.reduce((sum, c) => sum + c.value.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk.value, offset);
      offset += chunk.value.length;
    }
    return result;
  }
}
