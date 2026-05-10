import type { CborItem } from '../ast/CborItem';
import type { ToEDNOptions } from '../types';

/**
 * Serialize a CborItem AST node to CBOR-EDN diagnostic notation.
 * Equivalent to calling value.toEDN(options) directly.
 */
export function toEDN(value: CborItem, options?: ToEDNOptions): string {
  return value.toEDN(options);
}
