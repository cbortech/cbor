import type { CborItem } from '../ast/CborItem';
import type { ToCDNOptions } from '../types';

/**
 * Serialize a CborItem AST node to CDN text.
 * Equivalent to calling value.toCDN(options) directly.
 */
export function toCDN(value: CborItem, options?: ToCDNOptions): string {
  return value.toCDN(options);
}
