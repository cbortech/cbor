import type { CborItem } from '../ast/CborItem';

/**
 * Convert a CborItem AST node to a plain JavaScript value.
 * Equivalent to calling value.toJS() directly.
 */
export function toJS(value: CborItem): unknown {
  return value.toJS();
}
