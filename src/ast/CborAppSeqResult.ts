import type { ToCDNOptions, ToCBOROptions, ToJSOptions } from '../types';
import { CborItem } from './CborItem';
import type { CborWriter } from '../cbor/encode';
import { resolveIndent } from '../cdn/serialize-utils';

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

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    this.inner._encode(writer, options);
  }

  _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    const mode = options?.encodingIndicators ?? 'auto';
    if (
      options?.appStrings !== false &&
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
