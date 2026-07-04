import type { FromJSOptions } from '../types';
import { CBOR_OMIT } from '../types';
import type { CborItem } from '../ast/CborItem';
import type { CborExtension } from '../extensions/types';
import { BUILTIN_EXTENSIONS } from '../extensions/builtins';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborBigUint, CborBigNint } from '../ast/CborBignum';
import { CborByteString } from '../ast/CborByteString';
import { CborTextString } from '../ast/CborTextString';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborFloat } from '../ast/CborFloat';
import { CborSimple } from '../ast/CborSimple';
import { CborTag } from '../ast/CborTag';
import { Tag } from '../tag';
import { Simple } from '../simple';
import { MapEntries } from '../mapEntries';

/**
 * Extension hooks used by _fromJS, pre-filtered so the per-node loops touch
 * only extensions that actually implement each hook.
 */
interface ResolvedExtensions {
  /** Extensions with a fromJS hook (user extensions first). */
  fromJS: readonly CborExtension[];
  /** Extensions with a parseTag hook (user extensions first). */
  parseTag: readonly CborExtension[];
}

/**
 * BUILTIN_EXTENSIONS pre-filtered per hook, cached after first use.
 * Lazy (not module-level) because mapEntries.ts imports fromJS.ts, forming a
 * cycle that leaves BUILTIN_EXTENSIONS undefined at module init time.
 */
let _builtinResolvedExts: ResolvedExtensions | undefined;
function getBuiltinResolvedExts(): ResolvedExtensions {
  return (_builtinResolvedExts ??= {
    fromJS: BUILTIN_EXTENSIONS.filter((ext) => ext.fromJS !== undefined),
    parseTag: BUILTIN_EXTENSIONS.filter((ext) => ext.parseTag !== undefined),
  });
}

/**
 * Build the hook lists once per fromJS() entry call — _fromJS recursion is
 * per-node, so rebuilding a spread extension array there is measurably slow.
 */
function resolveExtensions(
  options: FromJSOptions | undefined
): ResolvedExtensions {
  const user = options?.extensions;
  const builtin = getBuiltinResolvedExts();
  if (!user?.length) return builtin;
  return {
    fromJS: [
      ...user.filter((ext) => ext.fromJS !== undefined),
      ...builtin.fromJS,
    ],
    parseTag: [
      ...user.filter((ext) => ext.parseTag !== undefined),
      ...builtin.parseTag,
    ],
  };
}

/**
 * Convert a plain JavaScript value to a CborItem AST node.
 *
 * Type dispatch order:
 *   object with [Tag.symbol] symbol       → CborTag (wraps the inner value)
 *   null / undefined / boolean  → CborSimple
 *   bigint                       → CborUint / CborNint / CborBigUint / CborBigNint
 *   number                       → CborFloat, or CborUint/CborNint if integerAs='int' (default)
 *   string                       → CborTextString
 *   Number / Boolean / String / BigInt object → unwrapped primitive (recurse)
 *   Tag.Null / Tag.Undefined              → CborSimple.NULL / UNDEFINED
 *   ArrayBuffer / SharedArrayBuffer            → CborByteString
 *   ArrayBufferView (TypedArray, DataView, …)  → CborByteString (Uint8Array respects uint8ArrayAs)
 *   Array                        → CborArray (recursive)
 *   Map                          → CborMap (keys also converted recursively)
 *   plain object                 → CborMap (string keys → CborTextString)
 */
export function fromJS(value: unknown, options?: FromJSOptions): CborItem {
  if (options?.replacer) {
    const { replacer, ...rest } = options;
    const replaced = _applyReplacer(
      value,
      replacer,
      rest.extensions,
      rest.undefinedOmits
    );
    if (replaced === CBOR_OMIT) return CborSimple.UNDEFINED;
    return fromJS(
      replaced,
      Object.keys(rest).length > 0 ? (rest as FromJSOptions) : undefined
    );
  }
  return _fromJS(value, options, true, resolveExtensions(options));
}

function _fromJS(
  value: unknown,
  options: FromJSOptions | undefined,
  checkTag: boolean,
  exts: ResolvedExtensions
): CborItem {
  // ── Extension fromJS hooks ───────────────────────────────────────────────────
  for (const ext of exts.fromJS) {
    const result = ext.fromJS!(value, options ?? {});
    if (result !== undefined) return result;
  }

  // ── CBOR tag annotation (Symbol key) ────────────────────────────────────────
  // checkTag=false on the recursive call to skip this branch and convert the
  // inner value normally, avoiding infinite recursion.
  // After converting the inner value, try parseTag() hooks so that e.g.
  // dt / ip can produce their specialised subclasses without needing
  // a separate fromJS() hook on the extension.
  if (
    checkTag &&
    typeof value === 'object' &&
    value !== null &&
    Tag.symbol in (value as object)
  ) {
    const tag = (value as Record<symbol, bigint>)[Tag.symbol];
    const innerValue = _fromJS(value, options, false, exts);
    for (const ext of exts.parseTag) {
      const result = ext.parseTag!(tag, innerValue);
      if (result !== undefined) return result;
    }
    return new CborTag(tag, innerValue);
  }

  // ── Null wrapper (from CborTag.toJS() of tagged null) ───────────────────────
  // Must come AFTER the Tag.symbol check so that Tag.Null (which carries
  // a [Tag.symbol] symbol) is first wrapped in CborTag, then unwrapped as NULL
  // in the recursive checkTag=false call.
  if (value instanceof Tag.Null) return CborSimple.NULL;
  if (value instanceof Tag.Undefined) return CborSimple.UNDEFINED;
  if (value instanceof Simple) return new CborSimple(value.value);

  // ── Primitives ───────────────────────────────────────────────────────────────
  if (value === null) return CborSimple.NULL;
  if (value === undefined) return CborSimple.UNDEFINED;
  if (value === true) return CborSimple.TRUE;
  if (value === false) return CborSimple.FALSE;

  if (typeof value === 'bigint') {
    if (value > 0xffff_ffff_ffff_ffffn) return new CborBigUint(value);
    if (value < -(0xffff_ffff_ffff_ffffn + 1n)) return new CborBigNint(value);
    return value >= 0n ? new CborUint(value) : new CborNint(value);
  }

  if (typeof value === 'number') {
    const integerAs = options?.encodeIntegerAs ?? 'int';
    if (
      integerAs === 'int' &&
      Number.isInteger(value) &&
      !Object.is(value, -0)
    ) {
      if (value >= 0) return new CborUint(BigInt(value));
      return new CborNint(BigInt(value));
    }
    return new CborFloat(value);
  }

  if (typeof value === 'string') return new CborTextString(value);

  // ── Boxed primitives — unwrap and recurse ───────────────────────────────────
  if (value instanceof Number)
    return _fromJS(value.valueOf(), options, false, exts);
  if (value instanceof Boolean)
    return _fromJS(value.valueOf(), options, false, exts);
  if (value instanceof String)
    return _fromJS(value.valueOf(), options, false, exts);
  // Object(bigint) — detected via Object.prototype.toString
  if (Object.prototype.toString.call(value) === '[object BigInt]')
    return _fromJS(
      (value as { valueOf(): bigint }).valueOf(),
      options,
      false,
      exts
    );

  // ── ArrayBuffer / SharedArrayBuffer ─────────────────────────────────────────
  if (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' &&
      value instanceof SharedArrayBuffer)
  ) {
    return new CborByteString(new Uint8Array(value as ArrayBuffer));
  }

  // ── ArrayBufferView (TypedArray variants, DataView) ─────────────────────────
  if (ArrayBuffer.isView(value)) {
    if (value instanceof Uint8Array && options?.uint8ArrayAs === 'array') {
      return new CborArray(Array.from(value, (b) => new CborUint(BigInt(b))));
    }
    return new CborByteString(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    );
  }

  if (value instanceof MapEntries) {
    return new CborMap(
      [...value].map(
        ([k, v]) =>
          [
            _fromJS(k, options, true, exts),
            _fromJS(v, options, true, exts),
          ] as [CborItem, CborItem]
      )
    );
  }

  if (Array.isArray(value)) {
    return new CborArray(
      value.map((item) => _fromJS(item, options, true, exts))
    );
  }

  if (typeof value === 'object') {
    const entries: [CborItem, CborItem][] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      entries.push([new CborTextString(k), _fromJS(v, options, true, exts)]);
    }
    return new CborMap(entries);
  }

  throw new TypeError(`fromJS: unsupported value type: ${typeof value}`);
}

// ─── Replacer helper ────────────────────────────────────────────────────────

type _FnReplacer = (this: unknown, key: unknown, value: unknown) => unknown;
type _Replacer = _FnReplacer | (string | number)[];

/** True for values that _fromJS handles via a dedicated branch (not Object.entries). */
function _isNativelyHandled(v: object): boolean {
  return (
    ArrayBuffer.isView(v) ||
    v instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' &&
      v instanceof SharedArrayBuffer) ||
    v instanceof Number ||
    v instanceof Boolean ||
    v instanceof String ||
    Object.prototype.toString.call(v) === '[object BigInt]' ||
    v instanceof Tag.Null ||
    v instanceof Tag.Undefined ||
    v instanceof Simple
  );
}

export function _applyReplacer(
  value: unknown,
  replacer: _Replacer,
  extensions?: readonly CborExtension[],
  undefinedOmits?: boolean
): unknown {
  // Only isJSType hooks are consulted below; filter once, not per node.
  const jsTypeExts: readonly CborExtension[] = [
    ...(extensions ?? []),
    ...BUILTIN_EXTENSIONS,
  ].filter((ext) => ext.isJSType !== undefined);

  /** True when a replacer/reviver result should cause the entry to be dropped. */
  function _omits(v: unknown): boolean {
    return v === CBOR_OMIT || (undefinedOmits === true && v === undefined);
  }

  if (Array.isArray(replacer)) {
    const allowed = (replacer as (string | number)[]).map(String);
    function filterKeys(v: unknown): unknown {
      if (v === null || typeof v !== 'object') return v;
      if (v instanceof MapEntries)
        return MapEntries.from(
          v,
          ([k, val]) => [k, filterKeys(val)] as [unknown, unknown]
        );
      if (Array.isArray(v)) return v.map(filterKeys);
      // Tagged objects pass through so fromJS can encode the tag natively.
      if (Tag.symbol in (v as object)) return v;
      // Built-in types pass through so fromJS can handle them natively.
      if (_isNativelyHandled(v as object)) return v;
      // Extension-owned values pass through so fromJS can handle them natively.
      if (jsTypeExts.some((ext) => ext.isJSType!(v))) return v;
      // Plain objects only: honor toJSON() first (matches JSON.stringify semantics).
      const proto = Object.getPrototypeOf(v as object) as unknown;
      if (proto === Object.prototype || proto === null) {
        const toJSON = (v as Record<string, unknown>)['toJSON'];
        if (typeof toJSON === 'function')
          return filterKeys((toJSON as () => unknown).call(v));
      }
      const result: Record<string, unknown> = {};
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(v, k))
          result[k] = filterKeys((v as Record<string, unknown>)[k]);
      }
      return result;
    }
    return filterKeys(value);
  }

  const fn = replacer as _FnReplacer;
  function applyFn(val: unknown, key: unknown, holder: unknown): unknown {
    // Call toJSON() only on plain objects (proto === Object.prototype or null).
    // Non-plain objects (Date, TypedArray, extension-backed classes…) pass
    // through so fromJS extensions can handle them; MapEntries is also skipped
    // so its integer keys and structure are preserved for CBOR encoding.
    if (
      val !== null &&
      typeof val === 'object' &&
      !(val instanceof MapEntries)
    ) {
      const proto = Object.getPrototypeOf(val as object) as unknown;
      if (proto === Object.prototype || proto === null) {
        const toJSON = (val as Record<string, unknown>)['toJSON'];
        if (typeof toJSON === 'function')
          val = (toJSON as (k: unknown) => unknown).call(val, key);
      }
    }
    val = fn.call(holder, key, val);
    if (val !== null && typeof val === 'object') {
      // Tagged objects pass through so fromJS can encode the tag natively.
      if (Tag.symbol in (val as object)) return val;
      if (val instanceof MapEntries) {
        const result = new MapEntries();
        for (const [k, v] of val) {
          const newV = applyFn(v, k, val);
          if (!_omits(newV)) result.push([k, newV]);
        }
        return result;
      }
      if (Array.isArray(val)) {
        return (val as unknown[]).map((v, i) => {
          const child = applyFn(v, String(i), val);
          // CBOR.OMIT / undefined-omits in arrays → null (matches JSON.stringify).
          return _omits(child) ? null : child;
        });
      }
      // Built-in types pass through to fromJS unchanged.
      if (_isNativelyHandled(val as object)) return val;
      // Extension-owned values pass through so fromJS can handle them natively.
      if (jsTypeExts.some((ext) => ext.isJSType!(val))) return val;
      const result: Record<string, unknown> = {};
      for (const k of Object.keys(val as object)) {
        const child = applyFn((val as Record<string, unknown>)[k], k, val);
        if (!_omits(child)) result[k] = child;
      }
      return result;
    }
    return val;
  }
  return applyFn(value, '', { '': value });
}
