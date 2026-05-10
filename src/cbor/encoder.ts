import type { CborItem } from '../ast/CborItem';
import type { ToCBOROptions } from '../types';

/**
 * Encode a CborItem AST node to CBOR binary.
 * Equivalent to calling value.toCBOR() directly.
 */
export function encodeCBOR(
  value: CborItem,
  options?: ToCBOROptions
): Uint8Array {
  return value.toCBOR(options);
}
