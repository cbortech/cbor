/**
 * `e'...'` external-reference CDN app-extension
 * (draft-ietf-cbor-edn-e-ref): resolves a mnemonic name to the integer value
 * a CDDL model binds it to — a constant rule (`title = -1`) or a named
 * group-enumeration entry (`? &(title: -1) => oltext`) — and, in the other
 * direction, lets a CBOR/CDN integer map key that CDDL validation matched
 * against such a named *member-key* entry round-trip back through `toCDN()`
 * as `e'title'` instead of the bare integer (see `cddl/eref.ts`'s module
 * doc for exactly which CDDL constructs feed which direction).
 *
 * Scope: only integer-valued names are resolved. The draft frames `e'...'`
 * more broadly, as referencing any CDDL constant value, but this library's
 * first target is CDDL models that label map-entry integer keys (the
 * draft's own `problem-details` example); a name bound to a float, text, or
 * byte-string constant is not collected by `getERefTables()` at all, so
 * `e'name'` for one fails to resolve (`parseAppString` below) with a "not
 * defined" error rather than producing that constant's value. Broadening
 * this to arbitrary CDDL literal values is unimplemented future work, not a
 * bug. A map *value* whose own type is a closed `&(name: value)` choice of
 * named integer constants (not merely coinciding with some unrelated
 * name elsewhere) is annotated too — see `eRefValueFor()`'s own doc.
 *
 * Unlike the other bundled extensions (`dt`, `ip`, …), this one is not a
 * fixed singleton: `e'...'` names are only meaningful relative to a specific
 * CDDL model, so `createERefExtension(schema)` builds one bound to that
 * schema's own `getERefTables()` result. `CBOR.fromCDN()`/`fromCBOR()`/
 * `fromJS()` register it automatically whenever the `cddl` option is set —
 * see `cbor.ts`'s own `withERefExtension()`/`assertCddl()`.
 *
 * A fourth direction — a plain JS object's own property name converting
 * *to* the integer key it names, e.g. `fromJS({ title: "x" }, { cddl })`
 * producing the same map `{-1: "x"}` that `fromCDN()` parsing
 * `{e'title': "x"}` would (both `eRefKeys` options default to on, so
 * neither needs spelling out explicitly) — is implemented in `js/fromJS.ts`
 * (`FromJSOptions.eRefKeys`) rather than here, since it needs to intercept
 * `fromJS()`'s own plain-object-to-`CborMap` conversion directly. It can't
 * safely use `ERefTables.nameToValue` (a single, whole-schema table)
 * as-is, since it runs *before* validation — it instead resolves names
 * positionally, per `cddl/eRefScope.ts`, only consulting names bound within
 * the CDDL type actually reachable at each position as it recurses. It
 * still builds `CborERefUint`/`CborERefNint` nodes from this file, so the
 * resulting key round-trips through `toCDN()`/`toJS()` exactly the same way
 * an `annotateERefKeys()`-annotated one does.
 *
 * `annotateERefKeys()` (below) resolves names the *same*, positional way —
 * not the flat `ERefTables.byValue` table its own earlier design used —
 * for exactly the same reason: a name that exists *somewhere* in the
 * schema but isn't reachable from a given key's own structural position is
 * exactly the kind of name `fromJS()`'s `eRefKeys` direction refuses to
 * convert back, so labeling it here would make a `toJS()` → `fromJS()`
 * round-trip silently change that key's actual value — not merely its
 * display label — see `annotateERefKeys()`'s own doc for the full story.
 */

import type { ToCDNOptions, ToJSOptions } from '../types';
import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborTextString } from '../ast/CborTextString';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborTag } from '../ast/CborTag';
import type { EncodingWidth } from '../cbor/encode';
import {
  resolveEiSuffix,
  canonicalEncodingWidth,
  escapeAppString,
} from '../cdn/serialize-utils';
import { getERefTables } from '../cddl/eref';
import type { CddlSchema } from '../cddl/schema';
import type { CddlType } from '../cddl/ast';
import {
  mapGroupsOfType,
  plainTextMemberKeys,
  traceMapGroup,
  type CddlEnv,
  type MapGroupTarget,
  type MapMember,
  type ValidateOptions,
} from '../cddl/validator';
import {
  NO_POSITION,
  arrayScopeOfType,
  enumNameOfType,
  matchingArrayAlternatives,
  mergeTypes,
  memberKeyName,
  resolveElementPosition,
  resolveNestedPosition,
  resolveRootPosition,
  ruleRefType,
  scopeNameToValue,
  resolvesGloballyTo,
  type ERefPosition,
} from '../cddl/eRefScope';

export const PREFIX_EREF = 'e';

// ─── CborItem subclasses ─────────────────────────────────────────────────────

interface ERefNodeOptions {
  encodingWidth?: EncodingWidth;
  ednSource?: string;
  /**
   * Whether `toJS()` may use `refName` as this key's JS property name —
   * `false` when `fromJS()` would *not* convert that name back to this
   * integer key at this position (its string-key conversion is stricter
   * than annotation — see `cddl/eRefScope.ts`'s module doc), so a
   * `toJS()` → `fromJS()` round trip would otherwise silently turn the key
   * into literal text. The `e'name'` label is then display-only: `toCDN()`
   * still emits it, while `toJS()` treats the key as the plain integer it
   * is. Set by `annotateERefKeys()`; defaults to `true`.
   */
  jsKey?: boolean;
}

function eRefJsObjectKey(
  node: CborERefUint | CborERefNint,
  options: ToJSOptions | undefined
): string | undefined {
  if (options?.eRefKeys === false) return node.value.toString();
  if (node.jsKey) return node.refName;
  // Not object-eligible under 'auto' (so the map falls back to MapEntries
  // with the integer key intact); an explicit `mapAs: 'object'` gets the
  // same numeric property name a plain integer key would.
  return options?.mapAs === 'object' ? node.value.toString() : undefined;
}

/**
 * A non-negative integer whose value a CDDL model names — `_toCDN()` emits
 * `e'name'` notation unless `appPrefix` is `false`.
 */
export class CborERefUint extends CborUint {
  readonly refName: string;

  /** See `ERefNodeOptions.jsKey`. */
  readonly jsKey: boolean;

  constructor(
    value: number | bigint,
    refName: string,
    options?: ERefNodeOptions
  ) {
    super(value, options);
    this.refName = refName;
    this.jsKey = options?.jsKey ?? true;
  }

  override _toCDN(
    options: ToCDNOptions | undefined,
    depth: number,
    path?: readonly unknown[]
  ): string {
    if (options?.appPrefix === false) return super._toCDN(options, depth, path);
    const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
      canonicalEncodingWidth(this.value)
    );
    return `${PREFIX_EREF}${escapeAppString(this.refName)}${suffix}`;
  }

  override _jsObjectKey(options: ToJSOptions | undefined): string | undefined {
    // Default true: this key only exists in the first place because a
    // schema named it, so `eRefKeys` unset means "use the name" — unless
    // `jsKey` says `fromJS()` couldn't convert that name back here.
    return eRefJsObjectKey(this, options);
  }
}

/**
 * A negative integer whose value a CDDL model names — `_toCDN()` emits
 * `e'name'` notation unless `appPrefix` is `false`.
 */
export class CborERefNint extends CborNint {
  readonly refName: string;

  /** See `ERefNodeOptions.jsKey`. */
  readonly jsKey: boolean;

  constructor(
    value: number | bigint,
    refName: string,
    options?: ERefNodeOptions
  ) {
    super(value, options);
    this.refName = refName;
    this.jsKey = options?.jsKey ?? true;
  }

  override _toCDN(
    options: ToCDNOptions | undefined,
    depth: number,
    path?: readonly unknown[]
  ): string {
    if (options?.appPrefix === false) return super._toCDN(options, depth, path);
    const suffix = resolveEiSuffix(options, this.encodingWidth, () =>
      canonicalEncodingWidth(this.argument)
    );
    return `${PREFIX_EREF}${escapeAppString(this.refName)}${suffix}`;
  }

  override _jsObjectKey(options: ToJSOptions | undefined): string | undefined {
    // Default true: this key only exists in the first place because a
    // schema named it, so `eRefKeys` unset means "use the name" — unless
    // `jsKey` says `fromJS()` couldn't convert that name back here.
    return eRefJsObjectKey(this, options);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build the `e'...'` `CborExtension` for one compiled CDDL schema.
 *
 * `parseAppString('e', 'title', …)` resolves `title` via the schema's
 * `getERefTables().byName` and returns the appropriately-signed
 * `CborERefUint`/`CborERefNint`. A name the schema does not define (or
 * defines ambiguously — bound to more than one value — or defines only as a
 * non-integer constant; see the module doc's Scope note) is a hard parse
 * error, always thrown regardless of `onError`: there is no best-effort
 * value to fall back to.
 */
export function createERefExtension(schema: CddlSchema): CborExtension {
  const tables = getERefTables(schema);
  return {
    appStringPrefixes: [PREFIX_EREF],
    parseAppString(_prefix: string, content: string): CborItem {
      const value = tables.byName.get(content);
      if (value === undefined) {
        const msg = tables.ambiguousNames.has(content)
          ? `e'${content}': ambiguous — the CDDL model binds '${content}' to more than one value`
          : `e'${content}': not defined as an integer constant or named group entry in the CDDL model ` +
            `(only integer-valued names are resolved; a name bound to a float, text, or byte-string ` +
            `constant is not currently supported)`;
        throw new SyntaxError(msg);
      }
      return value >= 0n
        ? new CborERefUint(value, content)
        : new CborERefNint(value, content);
    },
  };
}

// ─── Post-validation annotation ────────────────────────────────────────────────

/**
 * Walk a CDDL-validated item tree and, for every plain (not already
 * annotated) `CborUint`/`CborNint` used as a `CborMap` key — or as a map
 * *value* whose own type is a closed `&(name: value)` choice of named
 * integer constants (see `eRefValueFor()`'s own doc) — replace that node
 * in place with the corresponding `CborERefUint`/`CborERefNint` — so
 * `toCDN()` naturally emits `e'name'` notation (and, for a key, `toJS()`
 * naturally uses `name` as the plain-object key — both by default;
 * `appPrefix: false` / `eRefKeys: false` opt back out), without the caller
 * having to spell `e'...'` in the original CBOR/CDN/JS source at all.
 *
 * Position-aware, exactly like `FromJSOptions.eRefKeys`'s own reverse
 * direction (`cddl/eRefScope.ts`): starting from the schema's root rule (or
 * `ruleName`, matching `ValidateOptions.rule` — the same rule the item was
 * actually validated against), a key is only annotated with a name bound at
 * a member-key position within the CDDL type actually reachable at *that*
 * key's own structural position, descending through nested maps the same
 * way this walk itself does — never a name that merely exists *somewhere*
 * in the schema. This is deliberate, not merely cosmetic: a name that
 * exists elsewhere in the schema but isn't reachable from this position is
 * exactly the kind of name `fromJS()`'s `eRefKeys` option (correctly)
 * refuses to convert back, so annotating with it here would make
 * `toJS()` → `fromJS()` silently turn the original integer key into a
 * *different*, wrong one (a plain text key, if the name isn't reachable at
 * all) instead of round-tripping it byte-for-byte. A name reachable at this
 * position also always satisfies `resolvesGloballyTo()` — the same
 * schema-wide-uniqueness check `fromJS()` applies before labeling — so
 * `e'name'` here always parses back to the same value via `fromCDN()`
 * against the same schema too. A value's own label doesn't carry this same
 * round-trip risk at all (see `eRefValueFor()`'s own doc for why), but is
 * still gated by `resolvesGloballyTo()` for the CDN-reparse property alone.
 *
 * Data-aware, too: a key takes a name only from the group entry that
 * actually consumed it in validation — read back from the validator's own
 * map matching (`traceMapGroup()`), so value types, occurrence limits,
 * entries already consumed and sub-group backtracking all count exactly as
 * they did there — and nested content is only
 * resolved against the value types that really matched. `ruleOrOptions`
 * takes the same `ValidateOptions` validation used (`rule`, `features`, …)
 * so those checks agree with it.
 *
 * Only descends through `CborArray`/`CborMap`/`CborTag` — the structural
 * containers a CDDL-validated data model is built from; other node types
 * (e.g. an indefinite-length string chunk) are left untouched, and their
 * contents are not searched for map keys of their own. A map key is itself
 * walked too (after any replacement of its own) — CBOR permits a map or
 * array as a key, and an integer key nested inside *that* still needs
 * annotating, e.g. `{{-1: "a"}: "b"}` — but never with a *positional*
 * scope, the same way `fromJS()`'s own reverse direction never resolves
 * `eRefKeys` names for a map key either (only this module's Scope note
 * applies: a key reached this way simply gets no eRefKeys-eligible names of
 * its own).
 *
 * Mutates `item` (and its descendants) in place; call only on a tree the
 * caller exclusively owns and has not yet handed to anyone else — this is
 * exactly the state a freshly decoded/parsed/constructed item is in right
 * after CDDL validation succeeds, which is the only place this is called
 * from (see `cbor.ts`'s `assertCddl()`).
 */
export function annotateERefKeys(
  item: CborItem,
  schema: CddlSchema,
  ruleOrOptions?: string | ValidateOptions
): void {
  const options =
    typeof ruleOrOptions === 'string' ? { rule: ruleOrOptions } : ruleOrOptions;
  const ruleName = options?.rule ?? schema.root?.name;
  const candidates = ruleName
    ? [{ type: ruleRefType(ruleName), env: undefined }]
    : undefined;
  walkAnnotate(
    item,
    { schema, options, seen: new WeakSet() },
    candidates,
    resolveRootPosition(schema, options?.rule)
  );
}

interface AnnotateContext {
  readonly schema: CddlSchema;
  readonly options: ValidateOptions | undefined;
  readonly seen: WeakSet<CborItem>;
}

/**
 * The types that may have governed one node during validation — the real
 * one is always among them — or `undefined` when that isn't known (the
 * node gets no names at all).
 */
type Candidates = readonly { readonly type: CddlType; readonly env: CddlEnv }[];

/**
 * `candidates` drive annotation itself: a map's own entries take names only
 * from the validator's actual assignment (`traceMapEntries()`). `jsPos` is
 * the (never larger) position `fromJS()` is guaranteed to reach for the
 * same node when converting this tree's own `toJS()` output back — it has
 * no data to check and resolves a JS *string* key strictly, without the
 * declaration-order relaxation (see `cddl/eRefScope.ts`'s module doc). A
 * key's label is only offered to `toJS()` as a property name (`jsKey`) when
 * `jsPos` alone would convert that name back to the same integer.
 */
function walkAnnotate(
  item: CborItem,
  ctx: AnnotateContext,
  candidates: Candidates | undefined,
  jsPos: ERefPosition
): void {
  if (ctx.seen.has(item)) return;
  ctx.seen.add(item);
  const { schema } = ctx;
  if (item instanceof CborMap) {
    const traced = candidates
      ? traceMapEntries(ctx, item, candidates)
      : undefined;
    const jsScope = jsPos.map;
    const jsNames = jsScope
      ? scopeNameToValue(schema, jsScope, false)
      : undefined;
    item.entries.forEach((entry, i) => {
      const [key, value] = entry;
      const members = traced?.owners.map((o) => o[i]);
      const owners =
        members && members.every((m) => m !== false)
          ? (members as MapMember[])
          : undefined;
      const keyValue =
        key instanceof CborUint || key instanceof CborNint
          ? key.value
          : undefined;
      const name =
        owners && keyValue !== undefined
          ? agreedName(schema, owners, keyValue, traced!.plainNames)
          : undefined;
      const keyReplacement = eRefKeyFor(key, schema, name, jsNames);
      if (keyReplacement) entry[0] = keyReplacement;
      if (owners && owners.every((o) => o.env === undefined)) {
        const valueReplacement = eRefValueFor(
          value,
          schema,
          mergeTypes(owners.map((o) => o.type))
        );
        if (valueReplacement) entry[1] = valueReplacement;
      }
      const jsIdentifier = jsIdentifierOf(entry[0]);
      const jsNested =
        jsScope && jsIdentifier !== undefined
          ? resolveNestedPosition(schema, jsScope, jsIdentifier, false)
          : NO_POSITION;
      walkAnnotate(entry[0], ctx, undefined, NO_POSITION);
      walkAnnotate(
        entry[1],
        ctx,
        owners?.map((o) => ({ type: o.type, env: o.env })),
        jsNested
      );
    });
    return;
  }
  if (item instanceof CborArray) {
    // Elements are positioned by index against a fixed-shape array type
    // (see `ERefArrayScope`) — for annotation, only the alternatives the
    // data actually satisfies; for `jsPos`, by length alone, the same way
    // `fromJS()` itself positions them.
    const { items } = item;
    const length = items.length;
    const alternatives = candidates
      ? arrayAlternatives(ctx, candidates, items)
      : undefined;
    items.forEach((child, i) =>
      walkAnnotate(
        child,
        ctx,
        alternatives?.map((alt) => ({ type: alt[i]!, env: undefined })),
        jsPos.array
          ? resolveElementPosition(schema, jsPos.array, i, length)
          : NO_POSITION
      )
    );
    return;
  }
  if (item instanceof CborTag) {
    walkAnnotate(item.content, ctx, undefined, NO_POSITION);
  }
}

/**
 * The validator's own assignment of `map`'s entries, for every map group
 * any candidate type denotes that `map` actually matches (`traceMapGroup()`
 * — exactly `matchMapGroup()`, so occurrence limits, entries already
 * consumed, sub-group backtracking, cuts and value types all behave as in
 * validation). `undefined` when that can't be pinned down: a candidate
 * could match a map some way that has no such assignment (`any`, a control
 * operator, …), the budget runs out, or no group matches.
 */
function traceMapEntries(
  ctx: AnnotateContext,
  map: CborMap,
  candidates: Candidates
):
  | {
      owners: (readonly (MapMember | false)[])[];
      plainNames: ReadonlySet<string>;
    }
  | undefined {
  const groups: MapGroupTarget[] = [];
  for (const c of candidates) {
    const found = mapGroupsOfType(ctx.schema, c.type, c.env);
    if (!found) return undefined;
    groups.push(...found);
  }
  const owners: (readonly (MapMember | false)[])[] = [];
  for (const g of groups) {
    const t = traceMapGroup(ctx.schema, map, g, ctx.options);
    if (t === undefined) return undefined;
    if (t) owners.push(t);
  }
  if (owners.length === 0) return undefined;
  const plainNames = new Set<string>();
  for (const g of groups) {
    const names = plainTextMemberKeys(ctx.schema, g);
    if (!names) return undefined;
    for (const n of names) plainNames.add(n);
  }
  return { owners, plainNames };
}

/**
 * The one e-ref name every consuming member gives key `keyValue` — none
 * when they disagree, any names none, or the spelling is also a plain text
 * key in this map (see `plainTextMemberKeys()`).
 */
function agreedName(
  schema: CddlSchema,
  owners: readonly MapMember[],
  keyValue: bigint,
  plainNames: ReadonlySet<string>
): string | undefined {
  const names = new Set(
    owners.map((o) =>
      memberKeyName(schema, o.memberKey, keyValue, (n) => !!o.env?.has(n))
    )
  );
  const [name] = names;
  return names.size === 1 && name !== undefined && !plainNames.has(name)
    ? name
    : undefined;
}

/**
 * The fixed-shape array alternatives the candidates denote that `items`
 * actually satisfy, or `undefined` when that isn't known (a generic
 * binding in force, or a shape `arrayScopeOfType()` can't pin down).
 */
function arrayAlternatives(
  ctx: AnnotateContext,
  candidates: Candidates,
  items: readonly CborItem[]
): readonly (readonly CddlType[])[] | undefined {
  const elementTypes: (readonly CddlType[])[] = [];
  for (const c of candidates) {
    if (c.env !== undefined) return undefined;
    const scope = arrayScopeOfType(ctx.schema, c.type);
    if (!scope) return undefined;
    elementTypes.push(...scope.elementTypes);
  }
  return matchingArrayAlternatives(
    ctx.schema,
    { elementTypes },
    items,
    ctx.options
  ).elementTypes;
}

/**
 * How `fromJS()` will identify `key` when converting this map's own
 * `toJS()` output back: by name for a text key or a label `toJS()` offers
 * as a property name (`jsKey`), by integer value for any other integer key
 * (`toJS()` emits it as a number, in a `MapEntries`). `undefined` for any
 * other key.
 */
function jsIdentifierOf(key: CborItem): string | bigint | undefined {
  if ((key instanceof CborERefUint || key instanceof CborERefNint) && key.jsKey)
    return key.refName;
  if (key instanceof CborTextString) return key.value;
  if (key instanceof CborUint || key instanceof CborNint) return key.value;
  return undefined;
}

/**
 * The replacement key node for `key`, or `undefined` to leave it exactly as
 * given. `name` is what the member that actually consumed this entry names
 * it (`traceMapGroup()`), if
 * anything named it. Two directions:
 *
 * - A plain `CborUint`/`CborNint`: labeled `e'name'` when `name` is set
 *   *and* also satisfies `resolvesGloballyTo()` (so the label parses back to
 *   the same value via `fromCDN()` against this same schema too).
 * - An *already*-labeled `CborERefUint`/`CborERefNint` — only ever produced
 *   by `e'name'` written explicitly in CDN source, resolved via
 *   `createERefExtension()`'s flat, schema-wide `byName` table at *parse*
 *   time, entirely independent of structural position. Kept only when the
 *   entry that actually claimed it carries that same name; otherwise the
 *   label describes a group entry the data didn't match, so it's
 *   downgraded to a plain, unlabeled key (never re-derived as a
 *   *different* label of our own).
 *
 * Either way, a kept label's `jsKey` records whether `fromJS()` would
 * convert the name back at this position (`jsNames`), so `toJS()` only
 * uses it as a property name when that round trip holds.
 */
function eRefKeyFor(
  key: CborItem,
  schema: CddlSchema,
  name: string | undefined,
  jsNames: ReadonlyMap<string, bigint> | undefined
): CborItem | undefined {
  let node: CborItem;
  if (key instanceof CborERefUint || key instanceof CborERefNint) {
    if (name === key.refName) {
      const jsKey = jsNames?.get(key.refName) === key.value;
      if (key.jsKey === jsKey) return undefined;
      node = eRefNode(key.value, key.refName, key, jsKey);
    } else {
      node =
        key instanceof CborERefUint
          ? new CborUint(key.value, {
              encodingWidth: key.encodingWidth,
              ednSource: key.ednSource,
            })
          : new CborNint(key.value, {
              encodingWidth: key.encodingWidth,
              ednSource: key.ednSource,
            });
    }
  } else {
    let value: bigint;
    if (key instanceof CborUint) value = key.value;
    else if (key instanceof CborNint) value = key.value;
    else return undefined;
    if (name === undefined || !resolvesGloballyTo(schema, name, value))
      return undefined;
    node = eRefNode(
      value,
      name,
      key as CborUint | CborNint,
      jsNames?.get(name) === value
    );
  }
  node.start = key.start;
  node.end = key.end;
  node.comments = key.comments;
  node.blankLineBefore = key.blankLineBefore;
  return node;
}

/** A labeled integer node carrying `from`'s own encoding details. */
function eRefNode(
  value: bigint,
  name: string,
  from: CborUint | CborNint,
  jsKey?: boolean
): CborERefUint | CborERefNint {
  const options = {
    encodingWidth: from.encodingWidth,
    ednSource: from.ednSource,
    jsKey,
  };
  return value >= 0n
    ? new CborERefUint(value, name, options)
    : new CborERefNint(value, name, options);
}

/**
 * The replacement node for `value` — the current entry's own value, whose
 * consuming members' value types are `valueType` (see `traceMapGroup()`) —
 * or `undefined` to leave it exactly as given. Unlike `eRefKeyFor()`, only
 * one direction: a plain `CborUint`/`CborNint` is labeled `e'name2'` when
 * `valueType` (e.g. `&(AES-CCM-16-64-128: 10, …)` from `? &(gp_enc_alg: -4)
 * => …`) names this exact value (`enumNameOfType()`), and that name also
 * satisfies `resolvesGloballyTo()` (so the label parses back to the same
 * value via `fromCDN()` against this same schema too).
 *
 * An *already*-labeled value (from `e'...'` written explicitly in CDN
 * source) is left untouched, never downgraded the way an unreachable *key*
 * label is: a value's own label never changes what `toJS()` produces for
 * it (`CborERefUint`/`CborERefNint` only override `_jsObjectKey()`, used
 * for a *key*'s own JS property name — a value converts through the
 * ordinary, unlabeled `CborUint`/`CborNint` numeric path regardless), so
 * there's no `toJS()` → `fromJS()` round-trip this label could corrupt —
 * `parseAppString()` already guarantees it's globally unambiguous, which is
 * the only safety property that matters for a value's own label.
 */
function eRefValueFor(
  value: CborItem,
  schema: CddlSchema,
  valueType: CddlType
): CborItem | undefined {
  if (value instanceof CborERefUint || value instanceof CborERefNint)
    return undefined;
  let v: bigint;
  if (value instanceof CborUint) v = value.value;
  else if (value instanceof CborNint) v = value.value;
  else return undefined;
  const refName = enumNameOfType(schema, valueType, v);
  if (refName === undefined || !resolvesGloballyTo(schema, refName, v))
    return undefined;
  const node = eRefNode(v, refName, value as CborUint | CborNint);
  node.start = value.start;
  node.end = value.end;
  node.comments = value.comments;
  node.blankLineBefore = value.blankLineBefore;
  return node;
}
