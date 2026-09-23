import type { FromJSOptions } from '../types';
import { CBOR_OMIT } from '../types';
import type { CborItem } from '../ast/CborItem';
import type { CborExtension } from '../extensions/types';
import { resolveBuiltinExtensions } from '../extensions/builtins';
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
import { CborERefUint, CborERefNint } from '../extensions/eref';
import {
  resolveElementPosition,
  resolveNestedPosition,
  resolveRootPosition,
  scopeNameToValue,
  resolvesGloballyTo,
  type ERefPosition,
} from '../cddl/eRefScope';
import type { CddlSchema } from '../cddl/schema';

/**
 * `schema` plus the CDDL type currently governing this position in the JS
 * value tree — see `cddl/eRefScope.ts`'s own module doc for why this is
 * position-aware rather than a single flat, whole-schema table the way
 * `toJS()`'s own `ERefTables` is. `undefined` means "no eRefKeys context
 * here" — either `eRefKeys` is off, there's no schema, or this position
 * (or an ancestor of it) couldn't be resolved to a map or fixed-shape array
 * type at all.
 */
interface ActiveERefScope {
  readonly schema: CddlSchema;
  readonly pos: ERefPosition;
}

function activeScope(
  schema: CddlSchema,
  pos: ERefPosition
): ActiveERefScope | undefined {
  return pos.map || pos.array ? { schema, pos } : undefined;
}

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
 * Default resolved builtins (no `builtinExtensions` override) pre-filtered
 * per hook, cached after first use. Lazy (not module-level) because
 * mapEntries.ts imports fromJS.ts, forming a cycle that leaves the builtins
 * module's exports undefined at module init time.
 */
let _defaultResolvedExts: ResolvedExtensions | undefined;
function getBuiltinResolvedExts(
  builtinExtensions: CborExtension[] | false | undefined
): ResolvedExtensions {
  if (builtinExtensions === undefined) {
    if (_defaultResolvedExts) return _defaultResolvedExts;
    const resolved = resolveBuiltinExtensions(undefined);
    return (_defaultResolvedExts = {
      fromJS: resolved.filter((ext) => ext.fromJS !== undefined),
      parseTag: resolved.filter((ext) => ext.parseTag !== undefined),
    });
  }
  const resolved = resolveBuiltinExtensions(builtinExtensions);
  return {
    fromJS: resolved.filter((ext) => ext.fromJS !== undefined),
    parseTag: resolved.filter((ext) => ext.parseTag !== undefined),
  };
}

/**
 * Build the hook lists once per fromJS() entry call — _fromJS recursion is
 * per-node, so rebuilding a spread extension array there is measurably slow.
 */
function resolveExtensions(
  options: FromJSOptions | undefined
): ResolvedExtensions {
  const user = options?.extensions;
  const builtin = getBuiltinResolvedExts(options?.builtinExtensions);
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
/**
 * `schema` is an already-resolved (compiled, and — for string `cddl` —
 * cached) CDDL schema, supplied by `cbor.ts`'s `CBOR.fromJS()` when
 * `options.cddl` is set; this internal entry point never resolves `options.
 * cddl` itself (`cbor.ts` owns the compile-and-cache step, same as it does
 * for `fromCDN()`'s `e'...'` extension registration — see `resolveCddl()`
 * there). Only consulted when `schema` is defined at all (i.e. `options.
 * cddl` was set) — `options.eRefKeys` defaults to `true` and only an
 * explicit `false` turns this back off — see `FromJSOptions.eRefKeys`.
 * The scope this starts from is the schema's own root rule, or
 * `options.cddlValidationOptions.rule` when set — the same rule
 * `assertCddl()`'s own subsequent validation will actually check the
 * result against (see `cddl/eRefScope.ts`'s own module doc).
 */
export function fromJS(
  value: unknown,
  options?: FromJSOptions,
  schema?: CddlSchema
): CborItem {
  if (options?.replacer) {
    const { replacer, ...rest } = options;
    const replaced = _applyReplacer(
      value,
      replacer,
      rest.extensions,
      rest.undefinedOmits,
      rest.builtinExtensions
    );
    if (replaced === CBOR_OMIT) return CborSimple.UNDEFINED;
    return fromJS(
      replaced,
      Object.keys(rest).length > 0 ? (rest as FromJSOptions) : undefined,
      schema
    );
  }
  const eRefScope: ActiveERefScope | undefined =
    options?.eRefKeys !== false && schema
      ? resolveActiveScope(schema, options?.cddlValidationOptions?.rule)
      : undefined;
  return _fromJS(value, options, true, resolveExtensions(options), eRefScope);
}

/**
 * Wrap `inner` in tag `tag` exactly as converting a JS value carrying that
 * tag would (`parseTag()` hooks first, so e.g. tag 1 becomes the `dt`
 * extension's `DT'…'` node) — used for tags a CDDL schema implies (see
 * `FromJSOptions.implicitTags`).
 */
export function tagFromJS(
  tag: bigint,
  inner: CborItem,
  options?: FromJSOptions
): CborItem {
  for (const ext of resolveExtensions(options).parseTag) {
    const result = ext.parseTag!(tag, inner);
    if (result !== undefined) return result;
  }
  return new CborTag(tag, inner);
}

function resolveActiveScope(
  schema: CddlSchema,
  ruleName: string | undefined
): ActiveERefScope | undefined {
  return activeScope(schema, resolveRootPosition(schema, ruleName));
}

/**
 * `respectDeclarationOrder` must be `false` whenever `key` is itself a JS
 * string that has not (and will not) also be converted to an integer key
 * this same way — a MapEntries/plain-object string key, preserved or left
 * as literal text — since a same-alternative wildcard whose own key type
 * matches text could equally have claimed that exact string, and resolving
 * the nested scope as if the *named* entry definitely matched instead would
 * make nested content convert inconsistently with the key that governs it
 * staying text. `true` is safe only when `key` was derived from an
 * *already-integer* wire/JS value (see `cddl/eRefScope.ts`'s own module doc
 * on why declaration order only disambiguates an already-typed value).
 */
function nestActiveScope(
  ctx: ActiveERefScope,
  key: string | bigint,
  respectDeclarationOrder: boolean
): ActiveERefScope | undefined {
  if (!ctx.pos.map) return undefined;
  return activeScope(
    ctx.schema,
    resolveNestedPosition(ctx.schema, ctx.pos.map, key, respectDeclarationOrder)
  );
}

/** The scope for element `index` of a JS array of `length` elements. */
function elementActiveScope(
  ctx: ActiveERefScope | undefined,
  index: number,
  length: number
): ActiveERefScope | undefined {
  if (!ctx?.pos.array) return undefined;
  return activeScope(
    ctx.schema,
    resolveElementPosition(ctx.schema, ctx.pos.array, index, length)
  );
}

function _fromJS(
  value: unknown,
  options: FromJSOptions | undefined,
  checkTag: boolean,
  exts: ResolvedExtensions,
  eRefScope: ActiveERefScope | undefined
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
    const innerValue = _fromJS(value, options, false, exts, eRefScope);
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
  // Same eRefScope: unwrapping a box doesn't change the schema position.
  if (value instanceof Number)
    return _fromJS(value.valueOf(), options, false, exts, eRefScope);
  if (value instanceof Boolean)
    return _fromJS(value.valueOf(), options, false, exts, eRefScope);
  if (value instanceof String)
    return _fromJS(value.valueOf(), options, false, exts, eRefScope);
  // Object(bigint) — detected via Object.prototype.toString
  if (Object.prototype.toString.call(value) === '[object BigInt]')
    return _fromJS(
      (value as { valueOf(): bigint }).valueOf(),
      options,
      false,
      exts,
      eRefScope
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
    // Keys are preserved exactly as given — MapEntries round-trips CBOR map
    // entries verbatim, unlike a plain object's own properties below, so a
    // key never gets an eRefScope (isn't looked up as a name at all) and
    // never converts to an e-ref key itself: a MapEntries key isn't
    // necessarily even a string `resolveNestedScope()` could match against,
    // and preserving entries *exactly* is the whole point of using
    // MapEntries over a plain object in the first place. The key still
    // identifies a nested scope for its own *value*, though: a string key
    // by spelling, an integer key by value — whether a schema name spells
    // it (`&(data: 1) => …`) or it's a bare literal key (`1: …`), matched
    // the same way `annotateERefKeys()` matches a decoded integer key — so
    // a map `toJS()` produced as MapEntries (see `annotateERefKeys()`'s own
    // doc) still lets that nested content convert back correctly.
    return new CborMap(
      [...value].map(([k, v]): [CborItem, CborItem] => {
        const isStringKey = typeof k === 'string';
        const name = isStringKey
          ? k
          : typeof k === 'bigint'
            ? k
            : typeof k === 'number' && Number.isInteger(k)
              ? BigInt(k)
              : undefined;
        // A string key is preserved verbatim (see the doc above) — never
        // converted to an integer the way a plain-object property is — so
        // nested descent from it must use the same strict,
        // non-declaration-order matching `fromJS()`'s own string-key
        // conversion does (see `nestActiveScope()`'s own doc), not the
        // relaxed one a genuinely already-integer key safely gets.
        const nestedScope =
          eRefScope && name !== undefined && v !== null && typeof v === 'object'
            ? nestActiveScope(eRefScope, name, !isStringKey)
            : undefined;
        return [
          _fromJS(k, options, true, exts, undefined),
          _fromJS(v, options, true, exts, nestedScope),
        ];
      })
    );
  }

  if (Array.isArray(value)) {
    // Elements are positioned by index against a fixed-shape array type —
    // the same way `annotateERefKeys()` walks a decoded array, so a
    // `toJS()` → `fromJS()` round trip converts back exactly the names it
    // labeled (see `cddl/eRefScope.ts`'s `ERefArrayScope`).
    return new CborArray(
      value.map((item, i) =>
        _fromJS(
          item,
          options,
          true,
          exts,
          elementActiveScope(eRefScope, i, value.length)
        )
      )
    );
  }

  if (typeof value === 'object') {
    const entries: [CborItem, CborItem][] = [];
    // `false`: a JS property name is always a string that could equally be
    // preserved as a literal text key by a same-alternative wildcard whose
    // own key type matches text — declaration order alone can't tell which
    // shape the author meant (see `cddl/eRefScope.ts`'s own module doc), so
    // this must use the strict, non-relaxed matching, unlike the annotation
    // direction's own `scopeNameToValue()` calls.
    const localNames = eRefScope?.pos.map
      ? scopeNameToValue(eRefScope.schema, eRefScope.pos.map, false)
      : undefined;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyItem =
        eRefKeyItemFor(k, localNames, eRefScope?.schema) ??
        new CborTextString(k);
      const nestedScope =
        eRefScope && v !== null && typeof v === 'object'
          ? nestActiveScope(eRefScope, k, false)
          : undefined;
      entries.push([keyItem, _fromJS(v, options, true, exts, nestedScope)]);
    }
    return new CborMap(entries);
  }

  throw new TypeError(`fromJS: unsupported value type: ${typeof value}`);
}

/**
 * `FromJSOptions.eRefKeys` support: resolve a plain object's own property
 * name to the integer key it names, via the *current position's own*
 * `scopeNameToValue()` result (see `cddl/eRefScope.ts`) — already
 * restricted to unambiguous, member-key-position names reachable from
 * this exact position, not the whole schema. Returns `undefined` (falling
 * through to the ordinary `CborTextString` key) for a name this scope
 * doesn't know, or when there's no scope in effect at all.
 *
 * The resulting key is only *labeled* `e'name'` (a `CborERefUint`/
 * `CborERefNint`) when `resolvesGloballyTo()` confirms `e'name'` would
 * resolve back to this exact value via `parseAppString()`'s own,
 * genuinely schema-wide table too — otherwise the position-local value is
 * still correct and still used, just as a plain, unlabeled integer (a
 * `CborUint`/`CborNint`), so it always round-trips through `fromCDN()`
 * against the same schema instead of risking `e'name'` notation that
 * fails to re-parse, or re-parses to a different value, there.
 */
function eRefKeyItemFor(
  name: string,
  localNames: ReadonlyMap<string, bigint> | undefined,
  schema: CddlSchema | undefined
): CborItem | undefined {
  const value = localNames?.get(name);
  if (value === undefined) return undefined;
  if (schema && resolvesGloballyTo(schema, name, value)) {
    return value >= 0n
      ? new CborERefUint(value, name)
      : new CborERefNint(value, name);
  }
  return value >= 0n ? new CborUint(value) : new CborNint(value);
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
  undefinedOmits?: boolean,
  builtinExtensions?: CborExtension[] | false
): unknown {
  // Only isJSType hooks are consulted below; filter once, not per node.
  const jsTypeExts: readonly CborExtension[] = [
    ...(extensions ?? []),
    ...resolveBuiltinExtensions(builtinExtensions),
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
