import type { ToCDNOptions, ToCBOROptions, ToJSOptions } from '../types';
import { CborItem } from './CborItem';
import type { CborWriter } from '../cbor/encode';

/**
 * Wraps a resolved app-sequence result and preserves the original EDN source
 * text for round-trip fidelity.
 *
 * When `appStrings !== false`, `_toCDN` returns the stored source text verbatim.
 * Otherwise it delegates to the wrapped item so the caller gets a plain value.
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

  override _encodeTo(writer: CborWriter, options?: ToCBOROptions): void {
    this.inner._encode(writer, options);
  }

  _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (options?.appStrings !== false) return this.ednSource;
    return this.inner._toCDN(options, depth);
  }

  _toJS(options?: ToJSOptions): unknown {
    return this.inner._toJS(options);
  }
}
