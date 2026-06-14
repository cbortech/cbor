/**
 * Renders the result of `CborItem.toJS()` as readable pseudo-JavaScript.
 * Handles the library's representations: bigints, boxed tagged values,
 * Simple instances, MapEntries, Uint8Array, and Map.
 */
import { MapEntries, Simple, Tag } from '@cbortech/cbor';

const IND = '  ';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function inspectJS(value: unknown, depth = 0): string {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function')
  ) {
    const tag = Tag.get(value);
    if (tag !== undefined) {
      // Tagged primitives come back boxed; unbox for display.
      // For non-primitives, inner === value (same tagged object), so we call
      // _render directly to avoid re-checking the tag and looping infinitely.
      const inner =
        value instanceof Number ||
        value instanceof String ||
        value instanceof Boolean
          ? (value as { valueOf(): unknown }).valueOf()
          : value;
      return `Tag(${tag}) ${_render(inner, depth)}`;
    }
  }
  return _render(value, depth);
}

function _render(value: unknown, depth: number): string {
  if (depth > 32) return '…';
  const pad = IND.repeat(depth + 1);
  const close = IND.repeat(depth);

  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (typeof value === 'string') return JSON.stringify(value);

  if (value instanceof Simple) return `Simple(${value.value})`;
  if (value instanceof Uint8Array)
    return `Uint8Array(${value.length}) [ ${hex(value)} ]`;
  if (value instanceof Date)
    return `Date(${JSON.stringify(value.toISOString())})`;

  if (value instanceof MapEntries) {
    if (value.length === 0) return 'MapEntries []';
    const body = value
      .map(
        ([k, v]) =>
          `${pad}[${inspectJS(k, depth + 1)}]: ${inspectJS(v, depth + 1)}`
      )
      .join(',\n');
    return `MapEntries [\n${body}\n${close}]`;
  }
  if (value instanceof Map) {
    if (value.size === 0) return 'Map {}';
    const body = [...value]
      .map(
        ([k, v]) =>
          `${pad}${inspectJS(k, depth + 1)} => ${inspectJS(v, depth + 1)}`
      )
      .join(',\n');
    return `Map {\n${body}\n${close}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const body = value.map((v) => pad + inspectJS(v, depth + 1)).join(',\n');
    return `[\n${body}\n${close}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const body = keys
    .map((k) => `${pad}${JSON.stringify(k)}: ${inspectJS(obj[k], depth + 1)}`)
    .join(',\n');
  return `{\n${body}\n${close}}`;
}
