import type { FromCBOROptions, DecodeWarning, CborExtension } from '../types';
import type { CborItem } from '../ast/CborItem';
import { BUILTIN_EXTENSIONS } from '../extensions/builtins';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborByteString } from '../ast/CborByteString';
import { CborIndefiniteByteString } from '../ast/CborIndefiniteByteString';
import { CborTextString } from '../ast/CborTextString';
import { CborIndefiniteTextString } from '../ast/CborIndefiniteTextString';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborTag } from '../ast/CborTag';
import { CborFloat } from '../ast/CborFloat';
import { CborSimple } from '../ast/CborSimple';
import { float16BitsToFloat64 } from '../utils/float16';
import {
  MT_UINT,
  MT_NINT,
  MT_BYTES,
  MT_TEXT,
  MT_ARRAY,
  MT_MAP,
  MT_TAG,
  MT_SIMPLE,
  AI_1BYTE,
  AI_2BYTE,
  AI_4BYTE,
  AI_8BYTE,
  AI_INDEFINITE,
  BREAK_CODE,
} from './constants';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const textDecoderStrict = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});

const textDecoderLenient = new TextDecoder('utf-8', {
  fatal: false,
  ignoreBOM: true,
});

function decodeError(msg: string): never {
  throw new Error(`CBOR decode error: ${msg}`);
}

/**
 * Emit a CBOR validity violation warning and, unless `strict: false`, throw.
 * Returns the created `DecodeWarning` (only reachable in non-strict mode).
 * For truly malformed data that cannot be recovered, use `decodeError` instead.
 */
function strictViolation(
  msg: string,
  offset: number,
  options: FromCBOROptions | undefined
): DecodeWarning {
  const warning: DecodeWarning = { message: msg, offset };
  if (options?.onWarning) {
    options.onWarning(warning);
  } else if (!options?.silent) {
    console.warn(`CBOR strict violation at offset ${offset}: ${msg}`);
  }
  if (options?.strict !== false) {
    throw new Error(`CBOR decode error: ${msg}`);
  }
  return warning;
}

function addWarning(node: CborItem, warning: DecodeWarning): void {
  node.warnings ??= [];
  node.warnings.push(warning);
}

/**
 * Return a data-model fingerprint for a CBOR map key.
 *
 * The fingerprint is designed so that two keys are equal if and only if they
 * represent the same CBOR data-model value, regardless of the encoding form:
 *   - Integers: compared by numeric value (width differences ignored)
 *   - Text strings: compared by Unicode string content (definite vs indefinite ignored)
 *   - Byte strings: compared by raw byte sequence (definite vs indefinite ignored)
 *   - Floats: compared by numeric value (precision ignored; all NaN treated equal)
 *   - Simple values: compared by simple value number
 *   - Arrays/maps/tags: recursively fingerprinted
 *
 * Implemented as two functions: `fingerprintKeyVal` builds a nested-array
 * structure (no pre-serialised strings), and `fingerprintKey` serialises it
 * with a single JSON.stringify call.  Keeping recursion in the array domain
 * avoids the exponential character-escaping blowup that occurs when
 * pre-serialised JSON strings are embedded inside further JSON.stringify calls.
 */
function bytesToHexFingerprint(bytes: Uint8Array): string {
  let h = '';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return h;
}

function fingerprintKeyVal(key: CborItem): unknown {
  if (key instanceof CborUint) return ['u', String(key.value)];
  if (key instanceof CborNint) return ['n', String(key.value)];
  if (key instanceof CborTextString) return ['t', key.value];
  if (key instanceof CborIndefiniteTextString)
    return ['t', key.chunks.map((c) => c.value).join('')];
  if (key instanceof CborByteString)
    return ['b', bytesToHexFingerprint(key.value)];
  if (key instanceof CborIndefiniteByteString) {
    let h = '';
    for (const chunk of key.chunks) h += bytesToHexFingerprint(chunk.value);
    return ['b', h];
  }
  if (key instanceof CborFloat) {
    // Use String() for all float cases: avoids JSON.stringify silently converting
    // NaN and ±Infinity to null, and -0 to "0".
    if (isNaN(key.value)) return ['f', 'NaN'];
    if (Object.is(key.value, -0)) return ['f', '-0'];
    return ['f', String(key.value)];
  }
  if (key instanceof CborSimple) return ['s', key.value];
  if (key instanceof CborArray) return ['A', key.items.map(fingerprintKeyVal)];
  if (key instanceof CborMap) {
    const pairs = key.entries.map(([k, v]) => [
      fingerprintKeyVal(k),
      fingerprintKeyVal(v),
    ]);
    // 0/1 entries: nothing to sort — and skipping the stringify here keeps
    // deeply-nested single-entry map chains linear instead of quadratic.
    if (pairs.length <= 1) return ['M', pairs];
    // Sort by key fingerprint so that maps with the same entries in different
    // insertion order fingerprint identically (RFC 8949 data model: unordered).
    // Decorate-sort-undecorate: stringify each key once, not per comparison.
    const decorated = pairs.map(
      (pair) => [JSON.stringify(pair[0]), pair] as const
    );
    decorated.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return ['M', decorated.map((d) => d[1])];
  }
  if (key instanceof CborTag)
    return ['G', String(key.tag), fingerprintKeyVal(key.content)];
  // Fallback for any remaining AST node (e.g. CborEmbeddedCBOR): canonical CBOR bytes.
  const bytes = key.toCBOR();
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return ['c', hex];
}

function fingerprintKey(key: CborItem): string {
  // Fast paths for scalar keys (the overwhelmingly common case) — avoids a
  // throwaway array + JSON.stringify per key.  JSON fingerprints always start
  // with '[', so these single-letter prefixes cannot collide with them, and
  // each fast-path prefix is distinct so they cannot collide with each other.
  if (key instanceof CborUint) return 'u' + key.value;
  if (key instanceof CborNint) return 'n' + key.value;
  if (key instanceof CborTextString) return 't' + key.value;
  if (key instanceof CborIndefiniteTextString) {
    let s = 't';
    for (const c of key.chunks) s += c.value;
    return s;
  }
  if (key instanceof CborByteString)
    return 'b' + bytesToHexFingerprint(key.value);
  if (key instanceof CborIndefiniteByteString) {
    let s = 'b';
    for (const chunk of key.chunks) s += bytesToHexFingerprint(chunk.value);
    return s;
  }
  if (key instanceof CborFloat) {
    if (isNaN(key.value)) return 'fNaN';
    if (Object.is(key.value, -0)) return 'f-0';
    return 'f' + key.value;
  }
  if (key instanceof CborSimple) return 's' + key.value;
  return JSON.stringify(fingerprintKeyVal(key));
}

/**
 * Read the CBOR "argument" that follows the initial byte.
 * For ai 0–23 the argument is inline; for 24–27 it occupies 1/2/4/8 bytes.
 */
function readArgument(
  view: DataView,
  offset: number,
  ai: number
): { value: bigint; nextOffset: number } {
  if (ai <= 23) {
    return { value: BigInt(ai), nextOffset: offset };
  }
  switch (ai) {
    case AI_1BYTE:
      if (offset + 1 > view.byteLength) decodeError('unexpected end of input');
      return { value: BigInt(view.getUint8(offset)), nextOffset: offset + 1 };
    case AI_2BYTE:
      if (offset + 2 > view.byteLength) decodeError('unexpected end of input');
      return {
        value: BigInt(view.getUint16(offset, false)),
        nextOffset: offset + 2,
      };
    case AI_4BYTE:
      if (offset + 4 > view.byteLength) decodeError('unexpected end of input');
      return {
        value: BigInt(view.getUint32(offset, false)),
        nextOffset: offset + 4,
      };
    case AI_8BYTE:
      if (offset + 8 > view.byteLength) decodeError('unexpected end of input');
      return {
        value: view.getBigUint64(offset, false),
        nextOffset: offset + 8,
      };
    default:
      decodeError(`reserved additional info value: ${ai}`);
  }
}

// ─── Core recursive decoder ───────────────────────────────────────────────────

type DecodeResult = { value: CborItem; nextOffset: number };

/**
 * Decode the chunks of an indefinite-length string (major type 2 or 3) up to
 * and including the "break" code.  `what` is used in error messages and
 * `isChunk` enforces that every chunk is a definite string of that type.
 */
function decodeIndefiniteChunks<T extends CborItem>(
  view: DataView,
  offset: number,
  options: FromCBOROptions | undefined,
  tagExts: readonly CborExtension[],
  what: 'byte string' | 'text string',
  isChunk: (item: CborItem) => item is T
): { chunks: T[]; nextOffset: number } {
  const chunks: T[] = [];
  let pos = offset;
  while (true) {
    if (pos >= view.byteLength)
      decodeError(`unexpected end of indefinite ${what}`);
    if (view.getUint8(pos) === BREAK_CODE) {
      pos++;
      break;
    }
    const result = decodeItem(view, pos, options, tagExts);
    if (!isChunk(result.value))
      decodeError(`indefinite-length ${what} chunk must be a definite ${what}`);
    chunks.push(result.value);
    pos = result.nextOffset;
  }
  return { chunks, nextOffset: pos };
}

/**
 * Record a duplicate-key strict violation if `key` was already seen.
 * Mutates `seenKeys` and appends any non-strict-mode warning to `warnings`.
 */
function checkDuplicateKey(
  key: CborItem,
  seenKeys: Set<string>,
  warnings: DecodeWarning[],
  options: FromCBOROptions | undefined
): void {
  const fp = fingerprintKey(key);
  if (seenKeys.has(fp)) {
    warnings.push(
      strictViolation(
        `duplicate map key at offset ${key.start}`,
        key.start!,
        options
      )
    );
  }
  seenKeys.add(fp);
}

function decodeItem(
  view: DataView,
  offset: number,
  options: FromCBOROptions | undefined,
  tagExts: readonly CborExtension[]
): DecodeResult {
  const startOffset = offset;
  const result = decodeItemInner(view, offset, options, tagExts);
  result.value.start = startOffset;
  result.value.end = result.nextOffset;
  return result;
}

function decodeItemInner(
  view: DataView,
  offset: number,
  options: FromCBOROptions | undefined,
  tagExts: readonly CborExtension[]
): DecodeResult {
  if (offset >= view.byteLength) decodeError('unexpected end of input');

  const initialByte = view.getUint8(offset++);
  const mt = initialByte >> 5;
  const ai = initialByte & 0x1f;

  switch (mt) {
    // ── Major Type 0: unsigned integer ────────────────────────────────────────
    case MT_UINT: {
      const { value, nextOffset } = readArgument(view, offset, ai);
      return { value: new CborUint(value), nextOffset };
    }

    // ── Major Type 1: negative integer ───────────────────────────────────────
    case MT_NINT: {
      const { value, nextOffset } = readArgument(view, offset, ai);
      // CBOR encodes negative integers as -1 - argument
      return { value: new CborNint(-1n - value), nextOffset };
    }

    // ── Major Type 2: byte string ─────────────────────────────────────────────
    case MT_BYTES: {
      if (ai === AI_INDEFINITE) {
        const { chunks, nextOffset } = decodeIndefiniteChunks(
          view,
          offset,
          options,
          tagExts,
          'byte string',
          (item): item is CborByteString => item instanceof CborByteString
        );
        return { value: new CborIndefiniteByteString(chunks), nextOffset };
      }
      const { value: len, nextOffset: dataOffset } = readArgument(
        view,
        offset,
        ai
      );
      const length = Number(len);
      if (dataOffset + length > view.byteLength)
        decodeError('byte string extends beyond input');
      const bytes = new Uint8Array(
        view.buffer,
        view.byteOffset + dataOffset,
        length
      );
      return {
        value: new CborByteString(bytes.slice()),
        nextOffset: dataOffset + length,
      };
    }

    // ── Major Type 3: text string ─────────────────────────────────────────────
    case MT_TEXT: {
      if (ai === AI_INDEFINITE) {
        const { chunks, nextOffset } = decodeIndefiniteChunks(
          view,
          offset,
          options,
          tagExts,
          'text string',
          (item): item is CborTextString => item instanceof CborTextString
        );
        return { value: new CborIndefiniteTextString(chunks), nextOffset };
      }
      const { value: len, nextOffset: dataOffset } = readArgument(
        view,
        offset,
        ai
      );
      const length = Number(len);
      if (dataOffset + length > view.byteLength)
        decodeError('text string extends beyond input');
      const bytes = new Uint8Array(
        view.buffer,
        view.byteOffset + dataOffset,
        length
      );
      let text: string;
      let utf8Warning: DecodeWarning | undefined;
      try {
        text = textDecoderStrict.decode(bytes);
      } catch {
        utf8Warning = strictViolation(
          'invalid UTF-8 sequence in text string',
          dataOffset,
          options
        );
        // Only reached in non-strict mode — decode with replacement characters
        text = textDecoderLenient.decode(bytes);
      }
      const textNode = new CborTextString(text);
      if (utf8Warning) addWarning(textNode, utf8Warning);
      return { value: textNode, nextOffset: dataOffset + length };
    }

    // ── Major Type 4: array ───────────────────────────────────────────────────
    case MT_ARRAY: {
      if (ai === AI_INDEFINITE) {
        const items: CborItem[] = [];
        let pos = offset;
        while (true) {
          if (pos >= view.byteLength)
            decodeError('unexpected end of indefinite array');
          if (view.getUint8(pos) === BREAK_CODE) {
            pos++;
            break;
          }
          const result = decodeItem(view, pos, options, tagExts);
          items.push(result.value);
          pos = result.nextOffset;
        }
        return {
          value: new CborArray(items, { indefiniteLength: true }),
          nextOffset: pos,
        };
      }
      const { value: count, nextOffset: itemsStart } = readArgument(
        view,
        offset,
        ai
      );
      const length = Number(count);
      const items: CborItem[] = [];
      let pos = itemsStart;
      for (let i = 0; i < length; i++) {
        const result = decodeItem(view, pos, options, tagExts);
        items.push(result.value);
        pos = result.nextOffset;
      }
      return { value: new CborArray(items), nextOffset: pos };
    }

    // ── Major Type 5: map ─────────────────────────────────────────────────────
    case MT_MAP: {
      if (ai === AI_INDEFINITE) {
        const entries: [CborItem, CborItem][] = [];
        const seenKeysIndef = new Set<string>();
        const indefMapWarnings: DecodeWarning[] = [];
        let pos = offset;
        while (true) {
          if (pos >= view.byteLength)
            decodeError('unexpected end of indefinite map');
          if (view.getUint8(pos) === BREAK_CODE) {
            pos++;
            break;
          }
          const keyResult = decodeItem(view, pos, options, tagExts);
          checkDuplicateKey(
            keyResult.value,
            seenKeysIndef,
            indefMapWarnings,
            options
          );
          pos = keyResult.nextOffset;
          const valResult = decodeItem(view, pos, options, tagExts);
          pos = valResult.nextOffset;
          entries.push([keyResult.value, valResult.value]);
        }
        const indefMapNode = new CborMap(entries, { indefiniteLength: true });
        for (const w of indefMapWarnings) addWarning(indefMapNode, w);
        return { value: indefMapNode, nextOffset: pos };
      }
      const { value: count, nextOffset: entriesStart } = readArgument(
        view,
        offset,
        ai
      );
      const length = Number(count);
      const entries: [CborItem, CborItem][] = [];
      const seenKeys = new Set<string>();
      const mapWarnings: DecodeWarning[] = [];
      let pos = entriesStart;
      for (let i = 0; i < length; i++) {
        const keyResult = decodeItem(view, pos, options, tagExts);
        checkDuplicateKey(keyResult.value, seenKeys, mapWarnings, options);
        pos = keyResult.nextOffset;
        const valResult = decodeItem(view, pos, options, tagExts);
        pos = valResult.nextOffset;
        entries.push([keyResult.value, valResult.value]);
      }
      const mapNode = new CborMap(entries);
      for (const w of mapWarnings) addWarning(mapNode, w);
      return { value: mapNode, nextOffset: pos };
    }

    // ── Major Type 6: tagged item ─────────────────────────────────────────────
    case MT_TAG: {
      if (ai === AI_INDEFINITE)
        decodeError('tags cannot use indefinite-length encoding');
      const { value: tagNum, nextOffset: contentStart } = readArgument(
        view,
        offset,
        ai
      );
      const contentResult = decodeItem(view, contentStart, options, tagExts);
      for (const ext of tagExts) {
        const result = ext.parseTag!(tagNum, contentResult.value, options);
        if (result !== undefined)
          return { value: result, nextOffset: contentResult.nextOffset };
      }
      return {
        value: new CborTag(tagNum, contentResult.value),
        nextOffset: contentResult.nextOffset,
      };
    }

    // ── Major Type 7: float / simple value ────────────────────────────────────
    case MT_SIMPLE: {
      // ai 0–19: simple value encoded inline
      if (ai <= 19) {
        return { value: new CborSimple(ai), nextOffset: offset };
      }
      // ai 20–23: false / true / null / undefined
      if (ai === 20) return { value: CborSimple.FALSE, nextOffset: offset };
      if (ai === 21) return { value: CborSimple.TRUE, nextOffset: offset };
      if (ai === 22) return { value: CborSimple.NULL, nextOffset: offset };
      if (ai === 23) return { value: CborSimple.UNDEFINED, nextOffset: offset };

      // ai 24: simple value in next byte (value must be >= 32)
      if (ai === AI_1BYTE) {
        if (offset + 1 > view.byteLength)
          decodeError('unexpected end of input');
        const simpleVal = view.getUint8(offset);
        if (simpleVal < 32) {
          const w = strictViolation(
            `simple value ${simpleVal} must be encoded in initial byte (0–31 reserved for extended encoding)`,
            offset - 1,
            options
          );
          // Only reached in non-strict mode — decode the value as-is
          const simpleNode = new CborSimple(simpleVal);
          addWarning(simpleNode, w);
          return { value: simpleNode, nextOffset: offset + 1 };
        }
        return { value: new CborSimple(simpleVal), nextOffset: offset + 1 };
      }

      // ai 25: half-precision float
      if (ai === AI_2BYTE) {
        if (offset + 2 > view.byteLength)
          decodeError('unexpected end of input');
        const bits = view.getUint16(offset, false);
        return {
          value: new CborFloat(float16BitsToFloat64(bits), {
            precision: 'half',
          }),
          nextOffset: offset + 2,
        };
      }

      // ai 26: single-precision float
      if (ai === AI_4BYTE) {
        if (offset + 4 > view.byteLength)
          decodeError('unexpected end of input');
        return {
          value: new CborFloat(view.getFloat32(offset, false), {
            precision: 'single',
          }),
          nextOffset: offset + 4,
        };
      }

      // ai 27: double-precision float
      if (ai === AI_8BYTE) {
        if (offset + 8 > view.byteLength)
          decodeError('unexpected end of input');
        return {
          value: new CborFloat(view.getFloat64(offset, false), {
            precision: 'double',
          }),
          nextOffset: offset + 8,
        };
      }

      // ai 28–30: reserved
      if (ai < AI_INDEFINITE) {
        decodeError(`reserved additional info value in major type 7: ${ai}`);
      }

      // ai 31: break code — not valid at item level
      return decodeError(
        'unexpected break code outside indefinite-length item'
      );
    }
  }
  // unreachable: all major types 0–7 are handled above
  return decodeError(`unknown major type: ${mt}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

function toInputBytes(data: ArrayBufferView | ArrayBufferLike): Uint8Array {
  if (
    data instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' &&
      data instanceof SharedArrayBuffer)
  ) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError('expected ArrayBufferView or ArrayBufferLike');
}

/**
 * Decode a CBOR-encoded byte array into a CborItem AST node.
 *
 * Accepts any `ArrayBufferView` (e.g. `Uint8Array`, `DataView`) or
 * `ArrayBufferLike` (e.g. `ArrayBuffer`, `SharedArrayBuffer`).
 *
 * Throws if the input is not well-formed CBOR or contains trailing bytes.
 */
export function decodeCBOR(
  input: ArrayBufferView | ArrayBufferLike,
  options?: FromCBOROptions
): CborItem {
  const bytes = toInputBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = options?.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > view.byteLength) {
    throw new RangeError(
      `CBOR decode offset must be an integer between 0 and ${view.byteLength}`
    );
  }
  // Build the tag-extension list once per decode call; the previous
  // per-tag spread of user + builtin extensions showed up in profiles.
  const tagExts = [
    ...(options?.extensions ?? []),
    ...BUILTIN_EXTENSIONS,
  ].filter((ext) => ext.parseTag !== undefined);
  const { value, nextOffset } = decodeItem(view, offset, options, tagExts);
  if (!options?.allowTrailing && nextOffset !== view.byteLength) {
    decodeError(
      `${view.byteLength - nextOffset} trailing byte(s) after end of CBOR item`
    );
  }
  return value;
}
