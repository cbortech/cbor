/**
 * Renders the result of `CborItem.toJS()` as readable pseudo-JavaScript.
 * Handles the library's representations: bigints, boxed tagged values,
 * Simple instances, MapEntries, Uint8Array, Set, and Map.
 *
 * `tokenizeJS` walks the value once into a flat list of `JSChunk`s — plain
 * structural text (brackets, commas, indentation) plus classed value text —
 * and both `inspectJS` (plain string) and `appendJSChunks` (DOM spans) are
 * thin projections of that same list, so the two can never drift apart.
 * Chunk classes reuse the CDN editor's own token classes (`.cdn-num`,
 * `.cdn-str`, ...), so a decoded value is colored the same way here as its
 * CDN spelling would be.
 */
import { MapEntries, Simple, Tag } from '@cbortech/cbor';

const IND = '  ';

export interface JSChunk {
  text: string;
  /** One of the shared `.cdn-*` token classes, or undefined for plain
   * structural text (brackets, commas, colons, indentation). */
  cls?: string;
}

type Emit = (text: string, cls?: string) => void;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function emitValue(value: unknown, depth: number, emit: Emit): void {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function')
  ) {
    const tag = Tag.get(value);
    if (tag !== undefined) {
      // Tagged primitives come back boxed; unbox for display.
      // For non-primitives, inner === value (same tagged object), so we
      // recurse into emitInner directly to avoid re-checking the tag and
      // looping infinitely.
      const inner =
        value instanceof Number ||
        value instanceof String ||
        value instanceof Boolean
          ? (value as { valueOf(): unknown }).valueOf()
          : value;
      emit('Tag(', 'cdn-punct');
      emit(String(tag), 'cdn-num'); // mirrors a raw N(...) tag's number in CDN
      emit(') ', 'cdn-punct');
      emitInner(inner, depth, emit);
      return;
    }
  }
  emitInner(value, depth, emit);
}

function emitInner(value: unknown, depth: number, emit: Emit): void {
  if (depth > 32) return emit('…');
  const pad = IND.repeat(depth + 1);
  const close = IND.repeat(depth);

  if (value === undefined) return emit('undefined', 'cdn-atom');
  if (value === null) return emit('null', 'cdn-atom');
  if (typeof value === 'bigint') return emit(`${value}n`, 'cdn-num');
  if (typeof value === 'number') return emit(String(value), 'cdn-num');
  if (typeof value === 'boolean') return emit(String(value), 'cdn-atom');
  if (typeof value === 'string') return emit(JSON.stringify(value), 'cdn-str');

  if (value instanceof Simple)
    // Whole literal, one color — mirrors CDN's own simple(N) token, which
    // is a single 'atom'-classed token rather than punct+number.
    return emit(`Simple(${value.value})`, 'cdn-atom');
  if (value instanceof Uint8Array) {
    emit(`Uint8Array(${value.length}) [ `, 'cdn-punct');
    emit(hex(value), 'cdn-bytes');
    emit(' ]', 'cdn-punct');
    return;
  }
  if (value instanceof Date)
    // Whole literal, one color — mirrors an app-extension's DT'...' spelling
    // in CDN, which is a single 'app'-classed token.
    return emit(`Date(${JSON.stringify(value.toISOString())})`, 'cdn-app');

  if (value instanceof Set) {
    if (value.size === 0) return emit('Set {}', 'cdn-mod');
    emit('Set {\n', 'cdn-mod');
    let first = true;
    for (const v of value) {
      if (!first) emit(',\n');
      first = false;
      emit(pad);
      emitValue(v, depth + 1, emit);
    }
    emit(`\n${close}`);
    emit('}', 'cdn-mod');
    return;
  }

  if (value instanceof MapEntries) {
    if (value.length === 0) return emit('MapEntries []', 'cdn-mod');
    emit('MapEntries [\n', 'cdn-mod');
    value.forEach(([k, v], i) => {
      if (i > 0) emit(',\n');
      emit(pad);
      emit('[');
      emitValue(k, depth + 1, emit);
      emit(']: ');
      emitValue(v, depth + 1, emit);
    });
    emit(`\n${close}`);
    emit(']', 'cdn-mod');
    return;
  }
  if (value instanceof Map) {
    if (value.size === 0) return emit('Map {}', 'cdn-mod');
    emit('Map {\n', 'cdn-mod');
    let first = true;
    for (const [k, v] of value) {
      if (!first) emit(',\n');
      first = false;
      emit(pad);
      emitValue(k, depth + 1, emit);
      emit(' => ');
      emitValue(v, depth + 1, emit);
    }
    emit(`\n${close}`);
    emit('}', 'cdn-mod');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return emit('[]');
    emit('[\n');
    value.forEach((v, i) => {
      if (i > 0) emit(',\n');
      emit(pad);
      emitValue(v, depth + 1, emit);
    });
    emit(`\n${close}]`);
    return;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return emit('{}');
  emit('{\n');
  keys.forEach((k, i) => {
    if (i > 0) emit(',\n');
    emit(pad);
    emit(JSON.stringify(k), 'cdn-str');
    emit(': ');
    emitValue(obj[k], depth + 1, emit);
  });
  emit(`\n${close}}`);
}

/** Walk `value` into a flat list of plain/classed text chunks. */
export function tokenizeJS(value: unknown): JSChunk[] {
  const chunks: JSChunk[] = [];
  emitValue(value, 0, (text, cls) => chunks.push({ text, cls }));
  return chunks;
}

/** Plain-text rendering — every chunk's text, concatenated. */
export function inspectJS(value: unknown): string {
  return tokenizeJS(value)
    .map((c) => c.text)
    .join('');
}

/** Append `chunks` to `container` as text nodes and `.cdn-*`-classed spans. */
export function appendJSChunks(
  container: HTMLElement,
  chunks: JSChunk[]
): void {
  for (const { text, cls } of chunks) {
    if (!cls) {
      container.appendChild(document.createTextNode(text));
      continue;
    }
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    container.appendChild(span);
  }
}
