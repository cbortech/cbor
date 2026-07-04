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
import { bytesToHex } from '../utils/hex';
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
import type { EncodingWidth } from './encode';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a non-canonical EncodingWidth when the CBOR additional-info byte
 * uses more bytes than the minimum needed for `value`. Returns undefined for
 * canonical (minimum-width) encodings so they round-trip without an _N marker.
 *
 * Canonical ranges: immediate 0–23, 1-byte 24–255, 2-byte 256–65535,
 * 4-byte 65536–4294967295, 8-byte ≥ 4294967296.
 */
function aiToNonCanonicalEW(
  ai: number,
  value: bigint
): EncodingWidth | undefined {
  if (ai === AI_1BYTE && value <= 23n) return 0;
  if (ai === AI_2BYTE && value <= 0xffn) return 1;
  if (ai === AI_4BYTE && value <= 0xffffn) return 2;
  if (ai === AI_8BYTE && value <= 0xffff_ffffn) return 3;
  return undefined;
}

/**
 * Number twin of {@link aiToNonCanonicalEW}, for the length/count arguments
 * read by {@link readLength}.  Values ≥ 2^53 arrive rounded, but they are far
 * above every threshold here, so the result is unaffected.
 */
function aiToNonCanonicalEWLen(
  ai: number,
  value: number
): EncodingWidth | undefined {
  if (ai === AI_1BYTE && value <= 23) return 0;
  if (ai === AI_2BYTE && value <= 0xff) return 1;
  if (ai === AI_4BYTE && value <= 0xffff) return 2;
  if (ai === AI_8BYTE && value <= 0xffff_ffff) return 3;
  return undefined;
}

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
function fingerprintKeyVal(key: CborItem): unknown {
  if (key instanceof CborUint) return ['u', String(key.value)];
  if (key instanceof CborNint) return ['n', String(key.value)];
  if (key instanceof CborTextString) return ['t', key.value];
  if (key instanceof CborIndefiniteTextString)
    return ['t', key.chunks.map((c) => c.value).join('')];
  if (key instanceof CborByteString) return ['b', bytesToHex(key.value)];
  if (key instanceof CborIndefiniteByteString) {
    let h = '';
    for (const chunk of key.chunks) h += bytesToHex(chunk.value);
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
  return ['c', bytesToHex(key.toCBOR())];
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
  if (key instanceof CborByteString) return 'b' + bytesToHex(key.value);
  if (key instanceof CborIndefiniteByteString) {
    let s = 'b';
    for (const chunk of key.chunks) s += bytesToHex(chunk.value);
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
 * Pre-computed BigInt values for CBOR inline arguments 0–23.
 * readArgument() is called for every data item header; avoiding BigInt()
 * construction for the common small-integer case saves measurable time.
 */
const SMALL_BIGINTS: readonly bigint[] = Array.from({ length: 24 }, (_, i) =>
  BigInt(i)
);

/**
 * BUILTIN_EXTENSIONS filtered to those with a parseTag hook, cached after
 * first use. Lazy (not module-level) because cbordata.ts imports decoder.ts,
 * forming a cycle that leaves BUILTIN_EXTENSIONS undefined at module init time.
 */
let _builtinTagExts: readonly CborExtension[] | undefined;
function getBuiltinTagExts(): readonly CborExtension[] {
  return (_builtinTagExts ??= BUILTIN_EXTENSIONS.filter(
    (ext) => ext.parseTag !== undefined
  ));
}

/**
 * Decode a short (< 64 byte) pure-ASCII UTF-8 sequence without invoking
 * TextDecoder. Returns undefined if any byte is >= 0x80 (non-ASCII).
 * Only called for length < 64; longer strings use TextDecoder directly to
 * avoid the double-scan cost of failing mid-way through a large buffer.
 */
function tryDecodeAscii(bytes: Uint8Array, length: number): string | undefined {
  for (let i = 0; i < length; i++) {
    if (bytes[i] >= 0x80) return undefined;
  }
  // eslint-disable-next-line prefer-spread
  return String.fromCharCode.apply(null, bytes as unknown as number[]);
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
    return { value: SMALL_BIGINTS[ai], nextOffset: offset };
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

/**
 * Read the CBOR argument as a JS number — used for the length/count of major
 * types 2–5, where {@link readArgument}'s bigint would immediately be
 * converted back via Number().  Avoids a BigInt allocation per non-immediate
 * header on the decode hot path.
 *
 * An 8-byte argument ≥ 2^53 loses precision exactly as Number(bigint) would
 * (both round to nearest double); such lengths always exceed any real input,
 * so the subsequent bounds check fails identically either way.
 */
function readLength(
  view: DataView,
  offset: number,
  ai: number
): { value: number; nextOffset: number } {
  if (ai <= 23) {
    return { value: ai, nextOffset: offset };
  }
  switch (ai) {
    case AI_1BYTE:
      if (offset + 1 > view.byteLength) decodeError('unexpected end of input');
      return { value: view.getUint8(offset), nextOffset: offset + 1 };
    case AI_2BYTE:
      if (offset + 2 > view.byteLength) decodeError('unexpected end of input');
      return { value: view.getUint16(offset, false), nextOffset: offset + 2 };
    case AI_4BYTE:
      if (offset + 4 > view.byteLength) decodeError('unexpected end of input');
      return { value: view.getUint32(offset, false), nextOffset: offset + 4 };
    case AI_8BYTE: {
      if (offset + 8 > view.byteLength) decodeError('unexpected end of input');
      const hi = view.getUint32(offset, false);
      const lo = view.getUint32(offset + 4, false);
      return { value: hi * 0x1_0000_0000 + lo, nextOffset: offset + 8 };
    }
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

/**
 * Copy a float's encoded payload bytes out of the input, so NaN payloads
 * survive a decode → encode round-trip (see `CborFloat.rawBits`).
 */
function floatPayloadBytes(
  view: DataView,
  offset: number,
  length: number
): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset + offset, length).slice();
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
      const encodingWidth = aiToNonCanonicalEW(ai, value);
      return { value: new CborUint(value, { encodingWidth }), nextOffset };
    }

    // ── Major Type 1: negative integer ───────────────────────────────────────
    case MT_NINT: {
      const { value, nextOffset } = readArgument(view, offset, ai);
      const encodingWidth = aiToNonCanonicalEW(ai, value);
      // CBOR encodes negative integers as -1 - argument
      return {
        value: new CborNint(-1n - value, { encodingWidth }),
        nextOffset,
      };
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
      const { value: length, nextOffset: dataOffset } = readLength(
        view,
        offset,
        ai
      );
      const encodingWidth = aiToNonCanonicalEWLen(ai, length);
      if (dataOffset + length > view.byteLength)
        decodeError('byte string extends beyond input');
      const bytes = new Uint8Array(
        view.buffer,
        view.byteOffset + dataOffset,
        length
      );
      return {
        value: new CborByteString(bytes.slice(), { encodingWidth }),
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
      const { value: length, nextOffset: dataOffset } = readLength(
        view,
        offset,
        ai
      );
      const encodingWidth = aiToNonCanonicalEWLen(ai, length);
      if (dataOffset + length > view.byteLength)
        decodeError('text string extends beyond input');
      const bytes = new Uint8Array(
        view.buffer,
        view.byteOffset + dataOffset,
        length
      );
      let text: string;
      let utf8Warning: DecodeWarning | undefined;
      // Fast path: short pure-ASCII strings (map keys, identifiers) avoid
      // TextDecoder overhead. Capped at 64 bytes to prevent double-scanning
      // long buffers that turn out to contain non-ASCII bytes.
      const asciiText = length < 64 ? tryDecodeAscii(bytes, length) : undefined;
      if (asciiText !== undefined) {
        text = asciiText;
      } else {
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
      }
      const textNode = new CborTextString(text, { encodingWidth });
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
      const { value: length, nextOffset: itemsStart } = readLength(
        view,
        offset,
        ai
      );
      const encodingWidth = aiToNonCanonicalEWLen(ai, length);
      const items: CborItem[] = [];
      let pos = itemsStart;
      for (let i = 0; i < length; i++) {
        const result = decodeItem(view, pos, options, tagExts);
        items.push(result.value);
        pos = result.nextOffset;
      }
      return {
        value: new CborArray(items, { encodingWidth }),
        nextOffset: pos,
      };
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
      const { value: length, nextOffset: entriesStart } = readLength(
        view,
        offset,
        ai
      );
      const encodingWidth = aiToNonCanonicalEWLen(ai, length);
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
      const mapNode = new CborMap(entries, { encodingWidth });
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
      const tagEncodingWidth = aiToNonCanonicalEW(ai, tagNum);
      const contentResult = decodeItem(view, contentStart, options, tagExts);
      for (const ext of tagExts) {
        const result = ext.parseTag!(tagNum, contentResult.value, options);
        if (result !== undefined) {
          if (result instanceof CborTag && tagEncodingWidth !== undefined)
            result.encodingWidth = tagEncodingWidth;
          return { value: result, nextOffset: contentResult.nextOffset };
        }
      }
      return {
        value: new CborTag(tagNum, contentResult.value, {
          encodingWidth: tagEncodingWidth,
        }),
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
      // Use new instances (not the static singletons) so that decodeItem() can
      // safely set byte-offset properties without corrupting any concurrently
      // live CDN AST that shares the same singleton.
      if (ai === 20) return { value: new CborSimple(20), nextOffset: offset };
      if (ai === 21) return { value: new CborSimple(21), nextOffset: offset };
      if (ai === 22) return { value: new CborSimple(22), nextOffset: offset };
      if (ai === 23) return { value: new CborSimple(23), nextOffset: offset };

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
        const value = float16BitsToFloat64(bits);
        return {
          value: new CborFloat(value, {
            precision: 'half',
            rawBits: Number.isNaN(value)
              ? floatPayloadBytes(view, offset, 2)
              : undefined,
          }),
          nextOffset: offset + 2,
        };
      }

      // ai 26: single-precision float
      if (ai === AI_4BYTE) {
        if (offset + 4 > view.byteLength)
          decodeError('unexpected end of input');
        const value = view.getFloat32(offset, false);
        return {
          value: new CborFloat(value, {
            precision: 'single',
            rawBits: Number.isNaN(value)
              ? floatPayloadBytes(view, offset, 4)
              : undefined,
          }),
          nextOffset: offset + 4,
        };
      }

      // ai 27: double-precision float
      if (ai === AI_8BYTE) {
        if (offset + 8 > view.byteLength)
          decodeError('unexpected end of input');
        const value = view.getFloat64(offset, false);
        return {
          value: new CborFloat(value, {
            precision: 'double',
            rawBits: Number.isNaN(value)
              ? floatPayloadBytes(view, offset, 8)
              : undefined,
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
  // Build the tag-extension list once per decode call.
  // For the common case (no user extensions) reuse the pre-filtered module-level
  // constant to avoid a spread + filter allocation on every decode call.
  const tagExts = options?.extensions?.length
    ? [
        ...options.extensions.filter((e) => e.parseTag !== undefined),
        ...getBuiltinTagExts(),
      ]
    : getBuiltinTagExts();
  const { value, nextOffset } = decodeItem(view, offset, options, tagExts);
  if (!options?.allowTrailing && nextOffset !== view.byteLength) {
    const w = strictViolation(
      `${view.byteLength - nextOffset} trailing byte(s) after end of CBOR item`,
      nextOffset,
      options
    );
    // Only reached in non-strict mode (strictViolation throws in strict mode).
    addWarning(value, w);
    // Scan the trailing bytes so that truly malformed trailing items
    // (e.g. truncated input, reserved additional-info values) still throw,
    // even though the leading item decoded successfully.
    const scanOpts: FromCBOROptions = { strict: false, silent: true };
    let pos = nextOffset;
    while (pos < view.byteLength) {
      ({ nextOffset: pos } = decodeItem(view, pos, scanOpts, tagExts));
    }
  }
  return value;
}
