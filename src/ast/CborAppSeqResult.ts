import type { ToCDNOptions, ToCBOROptions, ToJSOptions } from '../types';
import {
  CborItem,
  needsItemDispatch,
  needsCdnItemDispatch,
  ROOT_OCCURRENCE,
  CDN_OVERRIDE_TRACKER,
} from './CborItem';
import type { Occurrence, CdnOverrideTrackerBox } from './CborItem';
import type { CborWriter } from '../cbor/encode';
import {
  isMultiWordRenderedLiteral,
  resolveIndent,
} from '../cdn/serialize-utils';

/**
 * Wraps a resolved app-sequence result and preserves the original EDN source
 * text for round-trip fidelity.
 *
 * In the default `encodingIndicators: 'auto'` mode, `_toCDN` returns the
 * stored source text verbatim. For `'always'` and `'never'`, it delegates to
 * the resolved item so the option is applied recursively to every data item;
 * preserving the source verbatim would leave nested indicators unchanged.
 * In single-line output (no `indent`), a source spelling that spans multiple
 * lines also delegates to the inner item, since it cannot be re-emitted
 * without breaking the single-line guarantee.
 *
 * When `toCDN()`'s `itemOptions` is configured (see `needsCdnItemDispatch`),
 * the verbatim `ednSource` fast path alone can't be trusted: it was produced
 * without ever visiting `this.inner`'s own descendants, so an override
 * targeting one of them (e.g. one chunk of an `ilbs<<...>>`) would otherwise
 * never even be offered the chance to apply. But merely *having* `itemOptions`
 * configured must not by itself change the output — many callers set it
 * without it ever matching anything in this particular subtree, and
 * `itemOptions` returning `undefined` everywhere is documented to mean "no
 * change" (see `CdnItemContext`). So this renders through the normal
 * recursive path while tracking, via `CDN_OVERRIDE_TRACKER` (an out-of-band
 * symbol key, *not* a wrapped `itemOptions` — wrapping it would make
 * `ctx.options.itemOptions` a different function for every descendant here
 * than everywhere else in the tree, observable even to a pure callback),
 * whether any call in the subtree actually returned an override, and only
 * swaps in that freshly rendered text when one did; otherwise the exact
 * preserved `ednSource` is still returned.
 *
 * Each `_toCDN()` call installs its *own fresh* tracker box before
 * recursing, rather than reusing whatever tracker it was handed — reusing
 * one directly would let an override applied by some unrelated part of the
 * tree that merely happens to share the same ambient `options` object (a
 * later sibling reached through the same `itemOptions`, say) falsely mark
 * *this* wrapper's own verbatim source as stale. But a genuinely *nested*
 * app-sequence (e.g. a custom `wrap<<ilbs<<h'61'>>>>` extension wrapping an
 * `ilbs<<...>>` result) must still have its own outer verbatim source
 * abandoned when the inner wrapper's own tracked render found something to
 * apply — an inner override changes what the outer source would need to
 * embed too. So once this call's own local tracker comes back `applied`,
 * that fact is additionally bubbled up to whichever ancestor tracker (if
 * any) this call itself received via `options` — the exact wrapper this
 * call is nested inside, never a sibling reached only through shared
 * top-level `options`.
 *
 * CBOR encoding and JS conversion always delegate to the inner item so the
 * wrapper is fully transparent for those operations.
 */
export class CborAppSeqResult extends CborItem {
  constructor(
    readonly inner: CborItem,
    readonly ednSource: string
  ) {
    super();
  }

  override get _containsCdnContainer(): boolean {
    return this.inner._containsCdnContainer;
  }

  /**
   * Same approach as `CborTag`: tokenize this wrapper's own `_toCDN()`
   * output rather than delegating to `this.inner._isMultiWordText()`.
   * Delegating to `this.inner` was tried and found wrong: for
   * `ilbs<<h'68656c6c6f20776f726c64'>>`, the chunk's raw bytes decode to
   * printable "hello world", so `this.inner`'s own semantic check reports
   * it as multi-word — but the *actual* rendering is the preserved
   * `ilbs<<...>>` app-sequence spelling, where that chunk appears as a
   * `h'...'` literal, never as decoded text; the semantic prediction and
   * the real output disagree. Tokenizing `this._toCDN()` directly sees
   * whichever one actually happens: the preserved `ednSource` verbatim
   * (`isMultiWordRenderedLiteral` peels the `prefix<<...>>` wrapper and
   * checks each item under the loose rule, same as `<<...>>` — a
   * multi-word text item like `ilts<<"two words">>` still always counts,
   * a prefixed-literal item like `ilbs<<h'00'>>` does not) or, in the
   * 'always'/'never' `encodingIndicators` modes, a pure passthrough to
   * `this.inner._toCDN()` with no extra wrapping (any node needing that to
   * be caught, like a self-disqualifying `CborIndefiniteByteString`, has
   * already produced a `\n` in that string, which the caller's own
   * `s.includes('\n')` check picks up independently either way).
   */
  override _isMultiWordText(
    options: ToCDNOptions | undefined,
    strict = true,
    path?: readonly unknown[]
  ): boolean {
    return isMultiWordRenderedLiteral(this._toCDN(options, 0, path), strict);
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    this.inner._encode(writer, options);
  }

  _toCDN(
    options: ToCDNOptions | undefined,
    depth: number,
    path?: readonly unknown[]
  ): string {
    const mode = options?.encodingIndicators ?? 'auto';
    const sourceEligible =
      options?.appPrefix !== false &&
      mode === 'auto' &&
      (resolveIndent(options) !== null || !/[\r\n]/.test(this.ednSource));
    if (!sourceEligible)
      // Transparent wrapper — the inner item shares this wrapper's own path
      // (see CdnItemContext.path) and gets its own itemOptions resolved
      // against it (`_resolveCdnOptions` is a no-op when itemOptions isn't
      // in play, so this is always safe to call).
      return this.inner._toCDN(
        this.inner._resolveCdnOptions(options, path ?? [], { parent: this }),
        depth,
        path
      );
    if (!needsCdnItemDispatch(options)) return this.ednSource;
    // itemOptions is configured, so some descendant *could* override
    // something the verbatim source doesn't reflect — but "undefined
    // everywhere = no change" must still hold. Render through the normal
    // recursive path while tracking, via the `CDN_OVERRIDE_TRACKER`
    // out-of-band box (not a wrapped `itemOptions` — see this class's own
    // doc for why that's observably different from the real thing), whether
    // any call in the subtree actually returned a non-undefined override;
    // only then is it safe to decide between the freshly rendered text (an
    // override applied) and the still-exact preserved source (none did).
    //
    // The ancestor tracker (if this call is itself nested inside another
    // app-sequence wrapper's own tracked render) is captured *before* it's
    // shadowed below, so a genuine override found only once this call
    // recurses into `this.inner` can still be bubbled up to it afterwards —
    // see this class's own doc.
    const ancestorTracker = (
      options as ToCDNOptions & {
        [CDN_OVERRIDE_TRACKER]?: CdnOverrideTrackerBox;
      }
    )[CDN_OVERRIDE_TRACKER];
    const tracker: CdnOverrideTrackerBox = { applied: false };
    const tracked: ToCDNOptions & {
      [CDN_OVERRIDE_TRACKER]?: CdnOverrideTrackerBox;
    } = {
      ...options,
      [CDN_OVERRIDE_TRACKER]: tracker,
    };
    const rendered = this.inner._toCDN(
      this.inner._resolveCdnOptions(tracked, path ?? [], { parent: this }),
      depth,
      path
    );
    if (tracker.applied && ancestorTracker) ancestorTracker.applied = true;
    return tracker.applied ? rendered : this.ednSource;
  }

  _toJS(
    options?: ToJSOptions,
    path?: readonly unknown[],
    occurrence?: Occurrence
  ): unknown {
    // Transparent wrapper — the inner item shares this wrapper's own path
    // (see ItemContext.path) and its own cache-matching identity (see
    // Occurrence) unchanged.
    return needsItemDispatch(options)
      ? this.inner._toJSChild(
          options,
          path ?? [],
          occurrence ?? ROOT_OCCURRENCE,
          { parent: this }
        )
      : this.inner._toJS(options);
  }
}
