import type { ToCDNOptions, ToCBOROptions, ToJSOptions } from '../types';
import { CborItem } from './CborItem';
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
    strict = true
  ): boolean {
    return isMultiWordRenderedLiteral(this._toCDN(options, 0), strict);
  }

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    this.inner._encode(writer, options);
  }

  _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    const mode = options?.encodingIndicators ?? 'auto';
    if (
      options?.appPrefix !== false &&
      mode === 'auto' &&
      (resolveIndent(options) !== null || !/[\r\n]/.test(this.ednSource))
    )
      return this.ednSource;
    return this.inner._toCDN(options, depth);
  }

  _toJS(options?: ToJSOptions): unknown {
    return this.inner._toJS(options);
  }
}
