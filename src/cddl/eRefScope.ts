/**
 * Position-aware `e'...'` name resolution (draft-ietf-cbor-edn-e-ref), used
 * by both `fromJS()`'s `eRefKeys` direction and `annotateERefKeys()`'s own
 * post-validation labeling — see `js/fromJS.ts` and `extensions/eref.ts`
 * for how each one drives this module.
 *
 * `getERefTables()` (`eref.ts`) builds one flat, whole-schema name table —
 * correct for `e'name'`'s own CDN *parse* direction (`byName`), since a
 * genuinely ambiguous or unreachable name simply fails to parse there. It
 * is **not** enough on its own for either the JS→CBOR (`fromJS()`) or the
 * annotation (`annotateERefKeys()`) direction: `fromJS()` *constructs* the
 * CBOR key from a JS property name before any validation happens, and
 * `annotateERefKeys()`'s own labeling must stay reversible through
 * `fromJS()` for a `toJS()` → `fromJS()` round trip to reproduce the exact
 * same wire bytes — so both directions need a name bound *anywhere* in the
 * schema, even in a rule the value has no structural relationship to,
 * *not* to convert/relabel, or the result silently diverges from the
 * original (a text key rewritten as an unrelated integer key, or vice
 * versa) rather than merely carrying a wrong display label.
 *
 * This module instead tracks which CDDL type actually governs the current
 * position in the value tree being walked — starting from the schema's own
 * root rule (or an explicit `ValidateOptions.rule`) and descending through
 * map types the same way the caller itself descends through nested plain
 * objects/maps — so a name is only ever eRefKeys-eligible at a position the
 * schema's own structure actually reaches. A position whose own type is a
 * `/`/`//` choice between *differently-shaped* alternatives (e.g. a
 * discriminated union) keeps every alternative **separate** rather than
 * merging their entries into one list — a name used as a plain text key in
 * one alternative and as an `&(name: value)` binding in another must not be
 * converted, since which alternative the data actually matches isn't known
 * without validating it (something this module deliberately doesn't
 * attempt — see `scopeNameToValue()`'s own doc for exactly how this is
 * decided).
 *
 * *Within* one alternative, though, an open/wildcard member key (e.g. a
 * `* tstr => any` catch-all, RFC 9290's own idiom for "any other field") no
 * longer blocks every name in that same alternative — only a member key at
 * or after it in the alternative's own declared order. `cddl/validator.ts`
 * assigns each wire key to a group entry greedily, in declaration order —
 * an entry earlier in the source always gets first claim on any key it can
 * match, before a later, more permissive one (the wildcard) ever sees it —
 * so a name declared *before* the wildcard is exactly as safe as if the
 * wildcard weren't there at all, while one declared *after* it isn't (the
 * wildcard could have already claimed that wire key first) — see
 * `firstOpenIndex()`'s own doc for the full reasoning. Declaration order
 * alone isn't the whole rule, though: the validator only lets an entry
 * claim a key whose *value* also matches that entry's type, passing it on
 * otherwise. Annotation, which has the decoded data, applies exactly that
 * via the validator's own traced assignment (`traceMapGroup()`, used by
 * `extensions/eref.ts`); the schema-only functions here remain for
 * `fromJS()`, which has no such data before it converts.
 *
 * That declaration-order relaxation is sound only for resolving an
 * *already-typed* wire value — annotating an existing integer key/value
 * with its name (`annotateERefKeys()`), since a text-matching wildcard like
 * `* tstr => any` structurally can't have consumed an *integer* wire key
 * first regardless of where it's declared. It is **not** sound for
 * `fromJS()`'s own forward direction: converting a JS property name —
 * always a string — into an integer key. There, if the wildcard's own key
 * type also matches text, that exact string is just as validly a literal
 * text key claimed by the wildcard as it is the named entry's integer
 * value; declaration order doesn't resolve this, because `fromJS()` is
 * *choosing* which shape the JS property becomes, not discovering it from
 * a value whose wire type is already fixed. Every function below that
 * depends on this distinction therefore takes an optional
 * `respectDeclarationOrder` parameter (default `true`, the relaxed
 * behavior above); `fromJS()` passes `false` for its own string-key
 * conversion and any nested-scope descent driven by it, falling back to
 * the older, blanket "any open entry anywhere in this alternative blocks
 * every name in it" behavior instead.
 *
 * Scope: deliberately conservative, not a full CDDL type resolver. It
 * understands map types (`{...}`), parenthesized types, and references to
 * other rules (including their `/=`/`//=` extensions) — enough for
 * realistic schemas built from named map rules. It also descends through
 * *fixed-shape* array types (`[a, b, c]`, including spliced-in group
 * references like `[Headers, payload]`) positionally, element by element —
 * but only when no array entry carries an occurrence indicator, since
 * `?`/`*`/`+` would make "which entry does element *i* belong to" depend on
 * matching the data (see `ERefArrayScope`'s own doc). It does **not**
 * attempt: generic type arguments (`rule<T>`/`rule<int>`), `~unwrap`, or
 * tagged types. Whenever a type can't be resolved this way, the affected position
 * (and everything nested inside it) simply has no eRefKeys-eligible names
 * at all — never a *wrong* guess, only a missed one; a name that isn't
 * converted here still becomes an ordinary text-string key, exactly like
 * any other property name the schema never named at all.
 */

import type { CddlSchema } from './schema';
import type {
  CddlGroup,
  CddlGroupEntry,
  CddlMemberKey,
  CddlRule,
  CddlType,
  CddlType1,
  CddlType2,
} from './ast';
import type { CborItem } from '../ast/CborItem';
import { getERefTables, literalIntOfType } from './eref';
import { getPreludeRules } from './prelude';
import {
  itemMatchesType,
  plainTextSpelling,
  type ValidateOptions,
} from './validator';

/**
 * The CDDL type governing one position in a JS value tree — opaque outside
 * this module; obtain one via `resolveRootScope()`, then `resolveNestedScope()`
 * for each property that itself holds a nested object.
 */
export interface ERefScope {
  /**
   * Every distinct alternative shape this position's type could resolve
   * to — one array per `/`/`//` choice alternative (including every
   * `/=`/`//=` extension of the rule), each holding *that* alternative's
   * own complete group entries. Kept separate, not merged into one flat
   * list, so `scopeNameToValue()` can tell "this name means the same thing
   * in every alternative that mentions it, and isn't plain text in any of
   * them" (safe) apart from "different alternatives disagree about it"
   * (unsafe) — see the module doc.
   */
  readonly alternatives: readonly (readonly CddlGroupEntry[])[];
}

/**
 * The scope for the schema's own root rule (or `ruleName`, matching
 * `ValidateOptions.rule` — `fromJS()`'s own eRefKeys resolution should
 * start from the same rule the caller will actually validate against).
 * `undefined` when the named rule doesn't exist, isn't a map type, or
 * can't be resolved this way at all — see the module doc's Scope note.
 */
export function resolveRootScope(
  schema: CddlSchema,
  ruleName?: string
): ERefScope | undefined {
  const name = ruleName ?? schema.root?.name;
  if (!name) return undefined;
  const resolved = resolveRuleMapEntries(schema, name, new Set());
  return resolved.kind === 'resolved'
    ? { alternatives: resolved.alternatives }
    : undefined;
}

/**
 * The CDDL type governing an *array* position — the counterpart of
 * `ERefScope` for a value that is a `CborArray`/JS array rather than a
 * map/object. One positional element-type list per array alternative this
 * position's type could resolve to (kept separate, the same way
 * `ERefScope.alternatives` is). Only produced for arrays whose every entry
 * is exactly one element (no `?`/`*`/`+`), so element *i* of an array of
 * length *n* is governed by entry *i* of every alternative of length *n* —
 * no matching against the data required. An alternative of a different
 * length simply can't be the one the data matched, so it's skipped
 * (`resolveElementPosition()`).
 */
export interface ERefArrayScope {
  readonly elementTypes: readonly (readonly CddlType[])[];
}

/**
 * Everything known about one position in the value tree: its scope if the
 * value there is a map (`map`), and its positional element types if it's an
 * array (`array`). Both may be set when the governing type is a `/` choice
 * between a map and an array; the walker uses whichever matches the value
 * actually found there.
 */
export interface ERefPosition {
  readonly map?: ERefScope;
  readonly array?: ERefArrayScope;
}

/** A position nothing is known about — no names apply anywhere below it. */
export const NO_POSITION: ERefPosition = {};

/**
 * `resolveRootScope()`'s own counterpart covering an array root too —
 * e.g. `COSE_Sign1 = [protected: …, unprotected: header_map, …]`.
 */
export function resolveRootPosition(
  schema: CddlSchema,
  ruleName?: string
): ERefPosition {
  const name = ruleName ?? schema.root?.name;
  if (!name) return NO_POSITION;
  const array = resolveRuleArrayTypes(schema, name, new Set());
  return {
    map: resolveRootScope(schema, ruleName),
    array:
      array.kind === 'resolved'
        ? { elementTypes: array.alternatives }
        : undefined,
  };
}

/**
 * `resolveNestedScope()`'s own counterpart covering an array value too —
 * the position of `identifier`'s own value within map scope `scope`.
 */
export function resolveNestedPosition(
  schema: CddlSchema,
  scope: ERefScope,
  identifier: string | bigint,
  respectDeclarationOrder = true
): ERefPosition {
  const merged = matchingValueType(
    schema,
    scope,
    identifier,
    respectDeclarationOrder
  );
  return merged ? positionOfType(schema, merged) : NO_POSITION;
}

/**
 * The position of element `index` within an array of `length` elements
 * governed by `arrayScope` — the union of entry `index`'s own type across
 * every alternative of exactly that length (see `ERefArrayScope`'s own
 * doc). `NO_POSITION` when no alternative has that length.
 */
export function resolveElementPosition(
  schema: CddlSchema,
  arrayScope: ERefArrayScope,
  index: number,
  length: number
): ERefPosition {
  const types = arrayScope.elementTypes
    .filter((alt) => alt.length === length)
    .map((alt) => alt[index]!);
  if (types.length === 0) return NO_POSITION;
  return positionOfType(schema, mergeTypes(types));
}

/**
 * The e-ref name a member key gives the integer key `keyValue` it
 * consumed — the member's own `&(name: value)` binding for that value (from
 * a fully literal enum group, the only kind that pins the key down to one
 * named value), or a bare reference to a constant rule with that value.
 * `undefined` for any other member key (a bareword/literal key, a wildcard,
 * a controlled or non-literal key), or when the reference is a generic
 * parameter (`paramBound`), which names no rule at all.
 */
export function memberKeyName(
  schema: CddlSchema,
  mk: CddlMemberKey,
  keyValue: bigint,
  paramBound: (name: string) => boolean
): string | undefined {
  if (mk.kind !== 'type1' || mk.key.op) return undefined;
  const t2 = mk.key.target;
  if (t2.kind === 'enum' && t2.group.kind === 'group') {
    if (!enumGroupIsFullyLiteral(t2.group)) return undefined;
    const names = new Set(
      literalEnumBindings(t2.group)
        .filter(([, v]) => v === keyValue)
        .map(([n]) => n)
    );
    return names.size === 1 ? [...names][0] : undefined;
  }
  if (t2.kind === 'ref' && !t2.genericArgs?.length && !paramBound(t2.name))
    return getERefTables(schema).ruleConstantValues.get(t2.name) === keyValue
      ? t2.name
      : undefined;
  return undefined;
}

/** A type that is just a reference to rule `name` (the validation root). */
export function ruleRefType(name: string): CddlType {
  return {
    kind: 'type',
    start: 0,
    end: 0,
    alternatives: [
      {
        kind: 'type1',
        start: 0,
        end: 0,
        target: { kind: 'ref', name, start: 0, end: 0 },
      },
    ],
  };
}

/**
 * `type`'s own fixed-shape array alternatives (see `ERefArrayScope`), or
 * `undefined` when it may be an array of some other shape.
 */
export function arrayScopeOfType(
  schema: CddlSchema,
  type: CddlType
): ERefArrayScope | undefined {
  const resolved = resolveArrayTypes(schema, type, new Set());
  return resolved.kind === 'resolved'
    ? { elementTypes: resolved.alternatives }
    : undefined;
}

/**
 * The array alternatives in `arrayScope` a decoded array's `items`
 * actually satisfy — same length, and every element matching its own
 * entry's type. An element whose check runs out of budget keeps its
 * alternative (including an extra alternative only ever makes annotation
 * more conservative, never wrong).
 */
export function matchingArrayAlternatives(
  schema: CddlSchema,
  arrayScope: ERefArrayScope,
  items: readonly CborItem[],
  options?: ValidateOptions
): ERefArrayScope {
  return {
    elementTypes: arrayScope.elementTypes.filter(
      (alt) =>
        alt.length === items.length &&
        alt.every(
          (type, i) =>
            itemMatchesType(schema, items[i]!, type, options) !== false
        )
    ),
  };
}

/** The position governed by `type` — a map scope, array scope, or both. */
function positionOfType(schema: CddlSchema, type: CddlType): ERefPosition {
  const map = resolveMapEntries(schema, type, new Set());
  const array = resolveArrayTypes(schema, type, new Set());
  return {
    map:
      map.kind === 'resolved' ? { alternatives: map.alternatives } : undefined,
    array:
      array.kind === 'resolved'
        ? { elementTypes: array.alternatives }
        : undefined,
  };
}

/**
 * `type`'s own `/` alternatives with parentheses and (non-generic) type-rule
 * references expanded in place — including every `/=` extension of a
 * referenced rule — so each result is a `type1` that is neither of those.
 * A controlled alternative (`bstr .cbor T`) is kept whole, never looked
 * into. `undefined` when some alternative can't be expanded this way (a
 * generic reference, a rule defined nowhere, or a group rule referenced as
 * a type). A reference cycle contributes no alternatives of its own.
 */
export function typeAlternatives(
  schema: CddlSchema,
  type: CddlType,
  seen: ReadonlySet<string> = new Set()
): CddlType1[] | undefined {
  const result: CddlType1[] = [];
  for (const t1 of type.alternatives) {
    const t2 = t1.target;
    if (t1.op || (t2.kind !== 'paren' && t2.kind !== 'ref')) {
      result.push(t1);
      continue;
    }
    if (t2.kind === 'paren') {
      const inner = typeAlternatives(schema, t2.type, seen);
      if (!inner) return undefined;
      result.push(...inner);
      continue;
    }
    if (t2.genericArgs?.length) return undefined;
    if (seen.has(t2.name)) continue;
    const defs = ruleDefinitions(schema, t2.name);
    if (!defs) return undefined;
    const nextSeen = new Set(seen);
    nextSeen.add(t2.name);
    for (const def of defs) {
      if (!isTypeRule(def) || def.body.kind !== 'entry') return undefined;
      const inner = typeAlternatives(schema, def.body.value, nextSeen);
      if (!inner) return undefined;
      result.push(...inner);
    }
  }
  return result;
}

/** One `CddlType` whose alternatives are all of `types`' own, combined. */
export function mergeTypes(types: readonly CddlType[]): CddlType {
  return {
    kind: 'type',
    start: types[0]!.start,
    end: types[types.length - 1]!.end,
    alternatives: types.flatMap((t) => t.alternatives),
  };
}

/**
 * Name → value, from every `&(name: value)`/bare-constant-reference entry
 * directly at a member-key position among `scope`'s own alternatives (not
 * entries nested inside a further nested map) — the names `fromJS()` may
 * convert *this* object's own direct property names against.
 *
 * A name is included only when it's *consistently* eRefKeys-eligible
 * across every one of `scope`'s own alternatives: excluded entirely if
 * *any* alternative uses it as a plain bareword/quoted-text member key
 * (that alternative wants a literal text key there, and which alternative
 * the JS value being converted actually corresponds to isn't known without
 * validating it — something this module doesn't attempt), and excluded if
 * the alternatives that *do* bind it via `&(name: value)`/a bare
 * constant-rule reference disagree on the value. An alternative that
 * doesn't mention the name at all is simply silent on it, not a conflict.
 *
 * A `&(name: value)` binding's own value is computed fresh per scope —
 * unlike a bare reference to a constant rule (`? group_mode => bool`),
 * whose value comes from the rule's own, genuinely schema-wide definition,
 * so it's looked up via `getERefTables(schema).ruleConstantValues` — never
 * plain `byName`, which also mixes in any `&(name: value)` enum *label*
 * bound to `name` elsewhere in the schema (irrelevant here: a bare type
 * reference names a *rule*, not "this spelling however it's used
 * anywhere" — see `ruleConstantValues`'s own doc).
 *
 * This *value* is safe to use positionally as-is — it's exactly the
 * integer this position's own schema names, independent of anything
 * elsewhere in the document. Whether the resulting key should also be
 * *labeled* `e'name'` is a separate question `resolvesGloballyTo()`
 * answers — see its own doc for why.
 *
 * `respectDeclarationOrder` (default `true`) controls whether a name
 * declared before a same-alternative wildcard is included per that
 * relaxation — see the module doc's own note on why `fromJS()` must pass
 * `false` here instead, falling back to the plain "any open entry anywhere
 * in this alternative excludes every name in it" behavior.
 */
export function scopeNameToValue(
  schema: CddlSchema,
  scope: ERefScope,
  respectDeclarationOrder = true
): ReadonlyMap<string, bigint> {
  const ruleConstantValues = getERefTables(schema).ruleConstantValues;
  const values = new Map<string, Set<bigint>>();
  const plainTextNames = new Set<string>();
  const addValue = (name: string, value: bigint): void => {
    let vals = values.get(name);
    if (!vals) {
      vals = new Set();
      values.set(name, vals);
    }
    vals.add(value);
  };

  // Each *open* alternative's own bindings declared before its wildcard. The
  // data might match any alternative; an open one only resolves a wire key
  // to `name` if it binds `name` itself ahead of its own wildcard (which
  // would otherwise claim that key first, meaning something else) — so a
  // name must appear in every open alternative's list to be safe. A closed
  // alternative that doesn't mention the name can't hold that key at all,
  // so it stays silent, as before.
  const openAltBindings: Map<string, Set<bigint>>[] = [];
  const openness = alternativeOpenness(schema, scope);
  for (let altIndex = 0; altIndex < scope.alternatives.length; altIndex++) {
    const alt = scope.alternatives[altIndex]!;
    const openIndex = respectDeclarationOrder
      ? firstOpenIndex(schema, alt)
      : openness[altIndex]
        ? 0
        : alt.length;
    const bindings = new Map<string, Set<bigint>>();
    if (openIndex < alt.length) openAltBindings.push(bindings);
    const bind = (name: string, value: bigint): void => {
      addValue(name, value);
      let vals = bindings.get(name);
      if (!vals) bindings.set(name, (vals = new Set()));
      vals.add(value);
    };
    for (let i = 0; i < alt.length; i++) {
      const entry = alt[i]!;
      if (entry.kind !== 'entry' || !entry.memberKey) continue;
      const mk = entry.memberKey;
      const plain = plainTextSpelling(mk);
      if (plain !== undefined) plainTextNames.add(plain);
      if (mk.kind !== 'type1') continue;
      // kind === 'type1'. An entry at or after the first open/wildcard
      // entry in its own alternative might never actually be reached by a
      // given wire key — see firstOpenIndex()'s own doc — so, unlike an
      // entry before it (guaranteed closed: not `op`-qualified, and either
      // a fully-literal enum group or a resolvable constant-rule
      // reference), it's skipped here entirely, the same way an open entry
      // itself already is.
      if (i >= openIndex) continue;
      const t2 = mk.key.target;
      if (t2.kind === 'enum' && t2.group.kind === 'group') {
        for (const [name, value] of literalEnumBindings(t2.group))
          bind(name, value);
      } else if (t2.kind === 'ref' && !t2.genericArgs?.length) {
        const value = ruleConstantValues.get(t2.name);
        if (value !== undefined) bind(t2.name, value);
      }
    }
  }

  const result = new Map<string, bigint>();
  for (const [name, vals] of values) {
    if (vals.size !== 1) continue; // conflicting values across alternatives
    if (plainTextNames.has(name)) continue; // plain text in some alternative
    const value = vals.values().next().value!;
    if (!openAltBindings.every((b) => b.get(name)?.has(value))) continue;
    result.set(name, value);
  }
  return result;
}

/**
 * Whether each of `scope`'s own alternatives, in order, has an open member
 * key *anywhere* in it (`firstOpenIndex()` returns less than its own
 * length) — regardless of *where* in that alternative's own declared order
 * it falls. Used to tell whether some *other* alternative could match the
 * data instead of the one a name/entry was actually found in — see
 * `scopeNameToValue()`/`matchingValueType()`'s own use of this for why that
 * matters even when the open entry is nowhere near the name in question.
 */
function alternativeOpenness(
  schema: CddlSchema,
  scope: ERefScope
): readonly boolean[] {
  return scope.alternatives.map(
    (alt) => firstOpenIndex(schema, alt) < alt.length
  );
}

/**
 * The index of the first member key within `alt` (one alternative's own,
 * already-flattened entry list) whose own shape isn't fully pinned down to
 * either a literal text/bareword key or a specific `&(name:
 * value)`/constant-rule binding — e.g. a wildcard `* tstr => any` catch-all,
 * or a key qualified by a range/control operator — or `alt.length` when
 * every entry is fully pinned down (no such entry at all).
 *
 * CDDL map-group matching in this library (`cddl/validator.ts`'s own
 * `mapSeq`) assigns each wire key to a group entry *greedily, in
 * declaration order*: an entry earlier in `alt` always gets first claim on
 * any wire key it can match, before a later, more permissive entry (a
 * wildcard, say) ever gets a chance at it — this is a documented, deliberate
 * heuristic (`mapSeq`'s own doc: "put wildcard members last"), not
 * backtracked. So an entry *before* this index is safe to resolve exactly
 * as written: no wire key it could match was ever at risk of being consumed
 * by something less specific first. An entry *at or after* this index,
 * though, might never actually be reached — the wire key it names could
 * just as well have already been claimed by the open entry instead, the
 * same "wrong alternative" risk `scopeNameToValue()`'s own doc describes
 * for a `/`-choice, just within one alternative's own declared order rather
 * than across separate ones — so it's excluded the same way an
 * unrecognized/open construct always is throughout this module.
 */
function firstOpenIndex(
  schema: CddlSchema,
  alt: readonly CddlGroupEntry[]
): number {
  const ruleConstantValues = getERefTables(schema).ruleConstantValues;
  for (let i = 0; i < alt.length; i++) {
    const entry = alt[i]!;
    if (entry.kind !== 'entry' || !entry.memberKey) continue;
    const mk = entry.memberKey;
    if (mk.kind === 'bareword' || mk.kind === 'value') continue;
    // kind === 'type1'
    if (mk.key.op) return i;
    const t2 = mk.key.target;
    if (t2.kind === 'enum' && t2.group.kind === 'group') {
      if (enumGroupIsFullyLiteral(t2.group)) continue;
      return i; // e.g. `&(raw: tstr)`: not a closed set of literal values
    }
    if (
      t2.kind === 'ref' &&
      !t2.genericArgs?.length &&
      ruleConstantValues.has(t2.name)
    )
      continue;
    return i; // e.g. `* tstr => any`, a generic ref, or another shape
  }
  return alt.length;
}

/**
 * Whether `name` labeling `value` here would also resolve the *same* way
 * through `parseAppString()` (`e'name'`'s own parse direction), which
 * consults `getERefTables(schema).byName` — a single, genuinely
 * schema-wide table, unlike `scopeNameToValue()`'s own position-scoped
 * one. A name can be locally unambiguous at one member-key position (safe
 * to use as *this* key's integer value — see `scopeNameToValue()`) while
 * being bound to a *different* value, or ambiguously to more than one, at
 * some other, unrelated member-key position elsewhere in the same schema.
 * Labeling the key `e'name'` in that case would round-trip incorrectly (or
 * not at all) through `fromCDN()` against the very same schema, so
 * `fromJS()` only does so when this returns `true` — otherwise the key
 * still gets the correct integer value, just as a plain, unlabeled
 * integer (see `js/fromJS.ts`'s own use of this).
 */
export function resolvesGloballyTo(
  schema: CddlSchema,
  name: string,
  value: bigint
): boolean {
  return getERefTables(schema).byName.get(name) === value;
}

/**
 * `scopeNameToValue()`'s own result, inverted — dropping any value bound to
 * more than one *different* name at this position, since picking either
 * would be an arbitrary, unjustified choice this position's own schema
 * doesn't actually make (each individual name is still unambiguous on its
 * own — see `scopeNameToValue()`'s own doc — this is only about two
 * *different* names colliding on the same value). Used wherever a caller
 * already has an integer *value* (not a name) — e.g. an already-decoded map
 * key, or a `MapEntries` entry whose key is a plain number rather than a
 * string — and needs to know which name, if any, unambiguously describes
 * it at this position, so it can resolve a nested scope for that entry's
 * own value the same way a literal string key's name would (see
 * `extensions/eref.ts` and `js/fromJS.ts`'s own uses).
 */
export function scopeValueToName(
  schema: CddlSchema,
  scope: ERefScope
): ReadonlyMap<bigint, string> {
  const byValue = new Map<bigint, string>();
  const ambiguous = new Set<bigint>();
  for (const [name, value] of scopeNameToValue(schema, scope)) {
    if (byValue.has(value)) {
      ambiguous.add(value);
      continue;
    }
    byValue.set(value, name);
  }
  for (const value of ambiguous) byValue.delete(value);
  return byValue;
}

/**
 * The scope for `identifier`'s own nested value — matching, across every
 * one of `scope`'s own alternatives, an entry whose member key is either a
 * literal bareword/quoted-text key equal to `identifier` (a `string`), the
 * `&(name: value)`/bare-reference entry that names it (only when
 * `identifier` is itself one of `scope`'s own `scopeNameToValue()` names),
 * *or* a differently-spelled member key that resolves to that exact same
 * integer value — e.g. a literal `1: …` entry in one alternative and
 * `&(data: 1) => …` in another both govern the same wire position, even
 * though only the second one *names* it. Passing `identifier` as a
 * `bigint` instead skips name resolution entirely and matches purely by
 * that integer value — for a wire key with no name of its own at all, e.g.
 * a literal `1: &(AES-CCM-16-64-128: 10)` entry, whose value can still be
 * resolved this way even though the key `1` itself was never eRefKeys
 * -eligible (see `extensions/eref.ts`'s own use of this for exactly this
 * case). Every matching entry's own value type is resolved into the
 * nested scope's own alternatives (kept separate from each other the same
 * way `scope`'s own were — see the module doc); `undefined` when nothing
 * matches `identifier` at all, when what matches doesn't resolve to a map
 * type anywhere, or when an open/wildcard member key (`firstOpenIndex()`)
 * at or before the matching entry, *within that same alternative*, could
 * equally claim the same wire key with a shape this resolver can't pin
 * down — see `firstOpenIndex()`'s own doc for exactly when that does and
 * doesn't apply. The object being converted might just as well belong to
 * that open entry instead of whichever named one matched literally, so
 * descending as if it definitely doesn't would risk exactly the same
 * "wrong alternative" misconversion `scopeNameToValue()`'s own doc
 * describes for `scope`'s own direct names.
 *
 * `respectDeclarationOrder` (default `true`) — see `scopeNameToValue()`'s
 * own doc; `fromJS()` passes `false` when descending from a JS property
 * name it hasn't (or can't) also convert to an integer key this same way,
 * so the nested scope it resolves stays consistent with that decision.
 */
export function resolveNestedScope(
  schema: CddlSchema,
  scope: ERefScope,
  identifier: string | bigint,
  respectDeclarationOrder = true
): ERefScope | undefined {
  const merged = matchingValueType(
    schema,
    scope,
    identifier,
    respectDeclarationOrder
  );
  if (!merged) return undefined;
  const resolved = resolveMapEntries(schema, merged, new Set());
  return resolved.kind === 'resolved'
    ? { alternatives: resolved.alternatives }
    : undefined;
}

/**
 * `identifier`'s own entries' value types, matched and merged across every
 * one of `scope`'s own alternatives the same way `resolveNestedScope()`'s
 * own doc describes (literal spelling, a named `&(name: value)`/bare-
 * reference entry, or a differently-spelled entry resolving to the same
 * integer value). A `bigint` identifier matches purely by value, skipping
 * name resolution entirely (see `resolveNestedScope()`'s own doc) — one
 * combined `CddlType` representing every alternative's own value type for
 * this position. Within one alternative, only an entry *before* that
 * alternative's own `firstOpenIndex()` is matched — a later entry (at or
 * after an open/wildcard one) might never actually be reached for a given
 * wire key (see `firstOpenIndex()`'s own doc), so it's excluded the same
 * way an unrecognized construct always is. `undefined` when nothing
 * matches `identifier` at all this way. Shared by `resolveNestedScope()`
 * (resolved further into a nested map type) and `resolveValueEnumName()`
 * (resolved into a closed set of named integer constants instead — see its
 * own doc).
 */
function matchingValueType(
  schema: CddlSchema,
  scope: ERefScope,
  identifier: string | bigint,
  respectDeclarationOrder = true
): CddlType | undefined {
  const key = typeof identifier === 'string' ? identifier : undefined;
  const targetValue =
    typeof identifier === 'bigint'
      ? identifier
      : scopeNameToValue(schema, scope, respectDeclarationOrder).get(
          identifier
        );
  const valueTypes: CddlType[] = [];
  const openness = alternativeOpenness(schema, scope);
  for (let altIndex = 0; altIndex < scope.alternatives.length; altIndex++) {
    const alt = scope.alternatives[altIndex]!;
    const openIndex = respectDeclarationOrder
      ? firstOpenIndex(schema, alt)
      : openness[altIndex]
        ? 0
        : alt.length;
    let matched = false;
    for (let i = 0; i < openIndex; i++) {
      const entry = alt[i]!;
      if (entry.kind !== 'entry' || !entry.memberKey) continue;
      if (memberKeyMatches(schema, entry.memberKey, key, targetValue)) {
        valueTypes.push(entry.value);
        matched = true;
      }
    }
    // An open alternative that doesn't claim this key ahead of its own
    // wildcard could hand it to the wildcard instead — a value of some
    // other, unknown shape — so nothing can be said about it at all (the
    // same rule `scopeNameToValue()` applies to names). A closed one that
    // doesn't mention the key can't be what the data matched.
    if (!matched && openIndex < alt.length) return undefined;
  }
  return valueTypes.length === 0 ? undefined : mergeTypes(valueTypes);
}

/**
 * The name safely labeling `value` when it's the value of `identifier`'s
 * own entry within `scope` — resolving that entry's own value type
 * (`matchingValueType()`, the same position-aware matching
 * `resolveNestedScope()` uses) via `resolveEnumNames()`. Symmetric with
 * `resolveNestedScope()`, but for a value whose *type* is (or resolves to)
 * a closed `&(name: value)` choice of named integer constants — e.g.
 * `? &(gp_enc_alg: -4) => &(AES-CCM-16-64-128: 10, …)` — rather than a
 * nested map. `identifier` may be a `bigint` to match purely by the key's
 * own value when it has no name of its own at all (see
 * `resolveNestedScope()`'s own doc). `undefined` when no matching entry's
 * value type names `value` this way, when any matching entry's value type
 * can't be confidently resolved (see `resolveEnumNames()`'s own doc), or
 * when `scope` has an open/wildcard member key. Always uses the relaxed,
 * declaration-order-aware matching (see `scopeNameToValue()`'s own doc) —
 * every caller is on the annotation side, resolving an already-decoded
 * wire value, never `fromJS()`'s own forward conversion.
 */
export function resolveValueEnumName(
  schema: CddlSchema,
  scope: ERefScope,
  identifier: string | bigint,
  value: bigint
): string | undefined {
  const merged = matchingValueType(schema, scope, identifier);
  return merged ? enumNameOfType(schema, merged, value) : undefined;
}

/**
 * The name `type` — a value's own type, e.g. the merged types of the members that consumed it —
 * safely gives integer `value`: resolved via `resolveEnumNames()`, so any
 * choice accepting the same integer under no name blocks it.
 */
export function enumNameOfType(
  schema: CddlSchema,
  type: CddlType,
  value: bigint
): string | undefined {
  const resolved = resolveEnumNames(schema, type, new Set());
  if (resolved.kind !== 'resolved') return undefined;
  const name = resolved.names.get(value);
  return typeof name === 'string' ? name : undefined;
}

/**
 * Whether `mk` governs the same wire position as `key`/`targetValue` —
 * either by literal spelling (a bareword/quoted-text key equal to `key`,
 * matched regardless of `targetValue`, only possible when `key` is
 * defined) or, when `targetValue` is defined, by *value*: a literal
 * integer key equal to `targetValue`, an `&(name: value)`/enum entry
 * naming `targetValue` (whether or not that entry's own name is `key` —
 * two different names can both resolve to the same value, and either one
 * governs this same position), or a bare constant-rule reference whose
 * value is `targetValue`. Without this, an alternative that spells the
 * *same* wire key a different way (e.g. a literal `1: …` where another
 * alternative uses `&(data: 1) => …`) would be missed entirely, silently
 * omitting a shape that could equally apply — see `resolveNestedScope()`'s
 * own doc. `key` is `undefined` when the caller only has a raw integer
 * value and no name at all — value-based matching still applies, just
 * never the literal-spelling branches.
 */
function memberKeyMatches(
  schema: CddlSchema,
  mk: CddlMemberKey,
  key: string | undefined,
  targetValue: bigint | undefined
): boolean {
  if (mk.kind === 'bareword') return key !== undefined && mk.key === key;
  if (mk.kind === 'value') {
    if (mk.key.type === 'text')
      return key !== undefined && mk.key.value === key;
    if (mk.key.type === 'int' && targetValue !== undefined) {
      const v =
        typeof mk.key.value === 'bigint' ? mk.key.value : BigInt(mk.key.value);
      return v === targetValue;
    }
    return false;
  }
  // kind === 'type1'
  if (targetValue === undefined || mk.key.op) return false;
  const t2 = mk.key.target;
  if (t2.kind === 'enum' && t2.group.kind === 'group') {
    return literalEnumBindings(t2.group).some(
      ([name, value]) =>
        (key !== undefined && name === key) || value === targetValue
    );
  }
  if (t2.kind === 'ref' && !t2.genericArgs?.length) {
    if (key !== undefined && t2.name === key) return true;
    return (
      getERefTables(schema).ruleConstantValues.get(t2.name) === targetValue
    );
  }
  return false;
}

/** Every `name: <int literal>` entry directly in one `&(...)` literal group. */
function literalEnumBindings(group: CddlGroup): [string, bigint][] {
  const result: [string, bigint][] = [];
  for (const choice of group.choices) {
    for (const entry of choice) {
      const binding = literalEnumBinding(entry);
      if (binding) result.push(binding);
    }
  }
  return result;
}

/** `entry`'s own `name: <int literal>` binding, if it is exactly that. */
function literalEnumBinding(
  entry: CddlGroupEntry
): [string, bigint] | undefined {
  if (entry.kind !== 'entry' || !entry.memberKey) return undefined;
  const mk = entry.memberKey;
  const name =
    mk.kind === 'bareword'
      ? mk.key
      : mk.kind === 'value' && mk.key.type === 'text'
        ? mk.key.value
        : undefined;
  if (name === undefined) return undefined;
  const value = literalIntOfType(entry.value);
  return value === undefined ? undefined : [name, value];
}

/**
 * Whether every entry in `group` (an `&(...)` literal enum group used at a
 * member-key position) has a literal bareword/text name bound to a literal
 * integer value — `literalEnumBindings()`'s own contract, just checked for
 * completeness by comparing its result's length against the group's own
 * entry count. A group with even one entry that doesn't (a non-literal
 * value like `raw: tstr`, a missing/non-text member key, a nested group
 * reference, …) doesn't actually pin the key down to a closed set of
 * literal values the way `&(name: value)` normally does — effectively an
 * open/wildcard key, the same class of risk a `* tstr => any` catch-all is
 * — see `firstOpenIndex()`'s own use of this.
 */
function enumGroupIsFullyLiteral(group: CddlGroup): boolean {
  let total = 0;
  for (const choice of group.choices) total += choice.length;
  return literalEnumBindings(group).length === total;
}

/**
 * The outcome of trying to resolve one CDDL type expression to its own map
 * entries: `'resolved'` when it names definite map alternatives; `'none'`
 * when it definitely does **not** describe a map (a literal value, an
 * array, …) and so safely contributes nothing to a merge; `'open'` when it
 * might *still* describe a map despite not resolving to one here — `any`
 * (including the bare `#` token and an unshadowed reference to the CDDL
 * prelude's own `any = #`), and `~unwrap`/tagged types, which this
 * simplified resolver doesn't look inside (see the module doc's Scope
 * note). The distinction matters only when merging several alternatives
 * (`resolveMapEntries`): silently treating `'open'` the same as `'none'`
 * would let a name from some *other*, resolvable alternative through even
 * though this alternative could equally apply to the value being
 * converted — see `resolveMapEntries`'s own use of this.
 */
type MapResolution =
  | { readonly kind: 'resolved'; readonly alternatives: CddlGroupEntry[][] }
  | { readonly kind: 'open' }
  | { readonly kind: 'none' };

const NO_MAP: MapResolution = { kind: 'none' };
const OPEN_MAP: MapResolution = { kind: 'open' };

/**
 * `name`'s own map-type alternatives — every `=`/`/=`/`//=` definition of
 * that name, each contributing one or more alternatives of its own (a
 * plain-type definition is resolved recursively via `resolveMapEntries`,
 * which may itself have several `/` alternatives; a group-shaped
 * definition, from a `//=` group-choice extension, contributes each of its
 * own `//` choices as a separate alternative; a single bare group entry —
 * `rule //= foo: 1` — contributes one alternative containing just that
 * entry). `'none'` when the name isn't defined at all, only cycles back to
 * itself, or none of its definitions resolve to a map type at all. `'open'`
 * for the CDDL prelude's own `any` (see `MapResolution`'s own doc) or a
 * bare reference to a name only ever defined generically (`box<T> = …`
 * referenced as plain `box`, missing its own type argument) — this
 * resolver doesn't attempt generics (see the module doc's Scope note), so
 * such a reference's actual shape is unknown, not ruled out.
 */
function resolveRuleMapEntries(
  schema: CddlSchema,
  name: string,
  seen: ReadonlySet<string>
): MapResolution {
  if (seen.has(name)) return NO_MAP;
  const defs = schema.ast.filter((r) => r.name === name && !r.generics?.length);
  if (defs.length === 0) {
    if (name === 'any') return OPEN_MAP;
    const onlyGeneric = schema.ast.some(
      (r) => r.name === name && r.generics?.length
    );
    return onlyGeneric ? OPEN_MAP : NO_MAP;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  const alternatives: CddlGroupEntry[][] = [];
  for (const def of defs) {
    if (def.body.kind === 'entry' && !def.body.occur && !def.body.memberKey) {
      const resolved = resolveMapEntries(schema, def.body.value, nextSeen);
      if (resolved.kind === 'open') return OPEN_MAP;
      if (resolved.kind === 'resolved')
        alternatives.push(...resolved.alternatives);
    } else if (def.body.kind === 'entry-group') {
      for (const choice of def.body.group.choices) {
        const flat = flattenAlternative(schema, choice, nextSeen);
        if (flat.kind === 'open') return OPEN_MAP;
        alternatives.push(...flat.alternatives);
      }
    } else {
      const flat = flattenAlternative(schema, [def.body], nextSeen);
      if (flat.kind === 'open') return OPEN_MAP;
      alternatives.push(...flat.alternatives);
    }
  }
  return alternatives.length > 0 ? { kind: 'resolved', alternatives } : NO_MAP;
}

function resolveMapEntries(
  schema: CddlSchema,
  type: CddlType,
  seen: ReadonlySet<string>
): MapResolution {
  const alternatives: CddlGroupEntry[][] = [];
  for (const t1 of type.alternatives) {
    if (t1.op) return OPEN_MAP; // range/control operator: shape unknown, not ruled out
    const resolved = resolveMapEntriesType2(schema, t1.target, seen);
    if (resolved.kind === 'open') return OPEN_MAP;
    if (resolved.kind === 'resolved')
      alternatives.push(...resolved.alternatives);
  }
  return alternatives.length > 0 ? { kind: 'resolved', alternatives } : NO_MAP;
}

function resolveMapEntriesType2(
  schema: CddlSchema,
  t2: CddlType2,
  seen: ReadonlySet<string>
): MapResolution {
  switch (t2.kind) {
    case 'map': {
      // Flatten each choice, splicing in any bare group reference or
      // inline parenthesized group it contains — see flattenAlternative()'s
      // own doc for why this can't just take t2.group.choices as-is.
      const alternatives: CddlGroupEntry[][] = [];
      for (const choice of t2.group.choices) {
        const flat = flattenAlternative(schema, choice, seen);
        if (flat.kind === 'open') return OPEN_MAP;
        alternatives.push(...flat.alternatives);
      }
      return { kind: 'resolved', alternatives };
    }
    case 'paren':
      return resolveMapEntries(schema, t2.type, seen);
    case 'ref':
      // A generic instantiation (`box<T>`) isn't resolved by this
      // simplified resolver (see the module doc's Scope note) — but unlike
      // a name that simply isn't defined, `box`'s own definition might
      // still be a map (e.g. `box<T> = { * tstr => T }`), so this can't be
      // ruled out the way an unresolvable reference otherwise safely is.
      if (t2.genericArgs?.length) return OPEN_MAP;
      return resolveRuleMapEntries(schema, t2.name, seen);
    case 'any':
      return OPEN_MAP;
    case 'unwrap':
    case 'tagged':
      // Wraps further content this simplified resolver doesn't look inside
      // — see the module doc's Scope note — so, unlike a type we're sure
      // can never be a map, this can't be ruled out either.
      return OPEN_MAP;
    case 'major':
      // `#5[...]` denotes any item of major type 5 — a map, unconstrained —
      // so, like `any`, it can't be ruled out; every other major number
      // (array, text/byte string, integers, tag, simple/float) never is one.
      return t2.major === 5 ? OPEN_MAP : NO_MAP;
    case 'enum':
      // `&(group)` used as a bare *type* (not at a member-key position) is
      // a choice over the group's own entries' *value* types — e.g.
      // `&(raw: { * tstr => any })` reduces to that one entry's map type.
      // This resolver doesn't attempt to look inside and resolve those
      // value types individually (see the module doc's Scope note), so —
      // unlike a `value`/`array`, which can never be a map regardless of
      // what's inside them — this can't be ruled out either.
      return OPEN_MAP;
    default:
      // value/array: never (resolved as) a map type.
      return NO_MAP;
  }
}

/**
 * Expand one alternative's own entries into every fully-flattened shape
 * implied by any bare group reference (`{ name }`) or inline parenthesized
 * group entry (`{ (a: 1 // b: 2) }`) it contains, recursively — CDDL group
 * inclusion splices the referenced group's own entries in at that point
 * (see `CddlEntryValue`'s own doc: "grpent … also covers bare group
 * references"), and — for a `//`-choice, whether from a named rule's own
 * `//=` extensions or an inline group — each choice becomes its own fully
 * expanded alternative here, the same way any other `/`/`//` choice does
 * (see the module doc). Without this, a spliced-in entry (e.g. a plain
 * bareword key the referenced group names) would silently vanish from
 * every consumer that only recognizes an entry with its own `memberKey` —
 * exactly the same "silently drop what we can't immediately classify"
 * mistake `any`/wildcard handling elsewhere in this module guards against.
 *
 * `'open'` when any such reference can't be confidently resolved this way
 * (an unresolvable name, a generic, `any`, a controlled type, …) — the
 * whole alternative (and therefore the whole merge it's part of) must then
 * be treated as unsafe, not silently missing just the one entry.
 */
function flattenAlternative(
  schema: CddlSchema,
  entries: readonly CddlGroupEntry[],
  seen: ReadonlySet<string>
): { kind: 'resolved'; alternatives: CddlGroupEntry[][] } | { kind: 'open' } {
  let results: CddlGroupEntry[][] = [[]];
  for (const entry of entries) {
    if (entry.kind === 'entry' && entry.memberKey) {
      results = results.map((r) => [...r, entry]);
      continue;
    }
    let subChoices: CddlGroupEntry[][];
    if (entry.kind === 'entry-group') {
      subChoices = entry.group.choices;
    } else {
      const resolved = resolveMapEntries(schema, entry.value, seen);
      if (resolved.kind !== 'resolved') return { kind: 'open' };
      subChoices = resolved.alternatives;
    }
    const expanded: CddlGroupEntry[][] = [];
    for (const choice of subChoices) {
      const flat = flattenAlternative(schema, choice, seen);
      if (flat.kind === 'open') return { kind: 'open' };
      expanded.push(...flat.alternatives);
    }
    const next: CddlGroupEntry[][] = [];
    for (const r of results)
      for (const sub of expanded) next.push([...r, ...sub]);
    results = next;
  }
  return { kind: 'resolved', alternatives: results };
}

/**
 * The outcome of resolving one CDDL type expression to its own fixed-shape
 * array alternatives — `'resolved'` with one positional element-type list
 * per alternative; `'none'` when it definitely isn't an array (a map, a
 * literal value, a scalar prelude type, …); `'open'` when it might still be
 * one whose element positions can't be pinned down (`any`, `#4`, an array
 * entry with an occurrence indicator, a generic, a controlled/tagged/
 * unwrapped type, …). Same three-way contract as `MapResolution`: an open
 * alternative poisons the whole merge rather than being silently skipped.
 */
type ArrayResolution =
  | { readonly kind: 'resolved'; readonly alternatives: CddlType[][] }
  | { readonly kind: 'open' }
  | { readonly kind: 'none' };

const NO_ARRAY: ArrayResolution = { kind: 'none' };
const OPEN_ARRAY: ArrayResolution = { kind: 'open' };

/**
 * `name`'s own definitions (user rules first, else the prelude's) —
 * `undefined` when defined nowhere, or only generically.
 */
function ruleDefinitions(
  schema: CddlSchema,
  name: string
): readonly CddlRule[] | undefined {
  let defs: readonly CddlRule[] = schema.ast.filter((r) => r.name === name);
  if (defs.length === 0) {
    const preludeRule = getPreludeRules().get(name);
    defs = preludeRule ? [preludeRule] : [];
  }
  if (defs.length === 0 || defs.some((r) => r.generics?.length))
    return undefined;
  return defs;
}

/** Whether `def`'s body is a plain type rather than a group. */
function isTypeRule(def: CddlRule): boolean {
  return def.body.kind === 'entry' && !def.body.occur && !def.body.memberKey;
}

function resolveRuleArrayTypes(
  schema: CddlSchema,
  name: string,
  seen: ReadonlySet<string>
): ArrayResolution {
  if (seen.has(name)) return NO_ARRAY;
  const defs = ruleDefinitions(schema, name);
  if (!defs) return OPEN_ARRAY;
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  const alternatives: CddlType[][] = [];
  for (const def of defs) {
    // A group-shaped rule referenced as a type isn't something this
    // resolver attempts.
    if (!isTypeRule(def) || def.body.kind !== 'entry') return OPEN_ARRAY;
    const resolved = resolveArrayTypes(schema, def.body.value, nextSeen);
    if (resolved.kind === 'open') return OPEN_ARRAY;
    if (resolved.kind === 'resolved')
      alternatives.push(...resolved.alternatives);
  }
  return alternatives.length > 0
    ? { kind: 'resolved', alternatives }
    : NO_ARRAY;
}

function resolveArrayTypes(
  schema: CddlSchema,
  type: CddlType,
  seen: ReadonlySet<string>
): ArrayResolution {
  const alternatives: CddlType[][] = [];
  for (const t1 of type.alternatives) {
    if (t1.op) return OPEN_ARRAY;
    const resolved = resolveArrayTypesType2(schema, t1.target, seen);
    if (resolved.kind === 'open') return OPEN_ARRAY;
    if (resolved.kind === 'resolved')
      alternatives.push(...resolved.alternatives);
  }
  return alternatives.length > 0
    ? { kind: 'resolved', alternatives }
    : NO_ARRAY;
}

function resolveArrayTypesType2(
  schema: CddlSchema,
  t2: CddlType2,
  seen: ReadonlySet<string>
): ArrayResolution {
  switch (t2.kind) {
    case 'array': {
      const alternatives: CddlType[][] = [];
      for (const choice of t2.group.choices) {
        const flat = flattenArrayElements(schema, choice, seen);
        if (!flat) return OPEN_ARRAY;
        alternatives.push(...flat);
      }
      return { kind: 'resolved', alternatives };
    }
    case 'paren':
      return resolveArrayTypes(schema, t2.type, seen);
    case 'ref':
      if (t2.genericArgs?.length) return OPEN_ARRAY;
      return resolveRuleArrayTypes(schema, t2.name, seen);
    case 'major':
      return t2.major === 4 ? OPEN_ARRAY : NO_ARRAY;
    case 'map':
    case 'value':
      return NO_ARRAY;
    default:
      // any/unwrap/tagged/enum: might still be an array, shape unknown.
      return OPEN_ARRAY;
  }
}

/**
 * One array alternative's entries, as every fully-expanded positional list
 * of element types — splicing in inline `( … )` groups and bare group
 * references (`[Headers, payload]` with `Headers = (protected: …, …)`), one
 * expanded list per `//` choice they contain. `undefined` when any entry
 * carries an occurrence indicator (element positions would then depend on
 * the data), uses a `type1 =>` member key, or references a group this
 * resolver can't expand.
 */
function flattenArrayElements(
  schema: CddlSchema,
  entries: readonly CddlGroupEntry[],
  seen: ReadonlySet<string>
): CddlType[][] | undefined {
  let results: CddlType[][] = [[]];
  for (const entry of entries) {
    if (entry.occur) return undefined;
    let expanded: CddlType[][];
    if (entry.kind === 'entry-group') {
      expanded = [];
      for (const choice of entry.group.choices) {
        const flat = flattenArrayElements(schema, choice, seen);
        if (!flat) return undefined;
        expanded.push(...flat);
      }
    } else if (entry.memberKey) {
      // `label: type` in an array just names the element.
      if (entry.memberKey.kind === 'type1') return undefined;
      expanded = [[entry.value]];
    } else {
      const groupName = groupReferenceName(schema, entry.value);
      if (groupName === null) return undefined;
      if (groupName === undefined) {
        expanded = [[entry.value]];
      } else {
        if (seen.has(groupName)) return undefined;
        const nextSeen = new Set(seen);
        nextSeen.add(groupName);
        expanded = [];
        for (const def of ruleDefinitions(schema, groupName)!) {
          const choices =
            def.body.kind === 'entry-group'
              ? def.body.group.choices
              : [[def.body]];
          for (const choice of choices) {
            const flat = flattenArrayElements(schema, choice, nextSeen);
            if (!flat) return undefined;
            expanded.push(...flat);
          }
        }
      }
    }
    const next: CddlType[][] = [];
    for (const r of results)
      for (const sub of expanded) next.push([...r, ...sub]);
    results = next;
  }
  return results;
}

/**
 * When `type` (a member-keyless array entry's own type) is a bare reference
 * to a group-shaped rule — one to splice in, not a single element — that
 * rule's name; `undefined` when it's an ordinary element type; `null` when
 * it can't be told apart safely (a rule mixing group- and type-shaped
 * definitions, or a generic group reference).
 */
function groupReferenceName(
  schema: CddlSchema,
  type: CddlType
): string | null | undefined {
  if (type.alternatives.length !== 1) return undefined;
  const t1 = type.alternatives[0]!;
  if (t1.op || t1.target.kind !== 'ref') return undefined;
  const name = t1.target.name;
  if (
    t1.target.genericArgs?.length ||
    schema.ast.some((r) => r.name === name && r.generics?.length)
  )
    return null; // could be a generic group: element count unknown
  const defs = ruleDefinitions(schema, name);
  if (!defs) return undefined; // resolved (as open) by the element's own type
  const groupShaped = defs.filter((d) => !isTypeRule(d)).length;
  if (groupShaped === 0) return undefined;
  return groupShaped === defs.length ? name : null;
}

/**
 * The outcome of trying to resolve one CDDL type expression to the closed
 * set of named integer constants it could represent — `'resolved'` when it
 * names at least one such value (via an `&(name: value)` literal enum used
 * as a bare *type*, not at a member-key position); `'none'` when it
 * definitely never names *any* value this way, and never even structurally
 * holds a bare integer at all (a map, array, or a prelude type like
 * `bool`/`tstr`, none of which a decoded `CborUint`/`CborNint` could ever
 * be an instance of); `'open'` when some alternative *could* still explain
 * the same integer under no name at all — `any`, a prelude integer type
 * (`uint`/`nint`/`int`/`number`/`integer`/…), an unconstrained `#0`/`#1`
 * major-type constraint, a range or other controlled type (including one
 * inside the `&(...)` group itself, e.g. `reserved: 0..10`), a generic
 * instantiation, `~unwrap`/tagged content this simplified resolver doesn't
 * look inside, … (an unnamed integer *literal* instead cancels only a name
 * for that same value — see `UNNAMED`)
 * — labeling the value would then be misleading (it might just be an
 * ordinary, unrelated integer here, the same concern `annotateERefKeys()`'s
 * own doc raises for a value that merely *coincides* with some unrelated
 * name elsewhere), so it can't be ruled out the way a type we're sure never
 * even holds a bare integer safely is — see `resolveEnumNames()`'s own use
 * of this.
 */
type EnumResolution =
  | { readonly kind: 'resolved'; readonly names: ReadonlyMap<bigint, EnumName> }
  | { readonly kind: 'open' }
  | { readonly kind: 'none' };

const NO_ENUM_NAMES: EnumResolution = { kind: 'none' };
const OPEN_ENUM_NAMES: EnumResolution = { kind: 'open' };

/**
 * Merge `names` into `into`, in place, moving a value to `conflicting`
 * (and dropping it from `into`) the instant two *different* names both
 * claim it — narrower than `resolveMapEntries()`'s own "one open
 * alternative poisons everything" approach: a naming conflict for one
 * specific value doesn't cast doubt on any *other*, unrelated value this
 * same type also names unambiguously, since (unlike a member-key merge)
 * the value being labeled is already known, not being guessed at.
 */
function mergeEnumNames(
  into: Map<bigint, EnumName>,
  conflicting: Set<bigint>,
  names: ReadonlyMap<bigint, EnumName>
): void {
  for (const [value, name] of names) {
    const existing = into.get(value);
    if (existing !== undefined && existing !== name) {
      conflicting.add(value);
      continue;
    }
    into.set(value, name);
  }
}

/**
 * `type`'s own closed set of named integer constants — every `/`
 * alternative's own contribution (`resolveEnumNamesType2()`) merged
 * together via `mergeEnumNames()`. A controlled alternative (`t1.op`)
 * forces the *whole* type `'open'` (see `EnumResolution`'s own doc for why
 * a naming conflict and a genuinely unresolvable alternative are handled
 * differently).
 */
function resolveEnumNames(
  schema: CddlSchema,
  type: CddlType,
  seen: ReadonlySet<string>
): EnumResolution {
  const names = new Map<bigint, EnumName>();
  const conflicting = new Set<bigint>();
  for (const t1 of type.alternatives) {
    if (t1.op) return OPEN_ENUM_NAMES;
    const resolved = resolveEnumNamesType2(schema, t1.target, seen);
    if (resolved.kind === 'open') return OPEN_ENUM_NAMES;
    if (resolved.kind === 'resolved')
      mergeEnumNames(names, conflicting, resolved.names);
  }
  for (const value of conflicting) names.delete(value);
  return names.size > 0 ? { kind: 'resolved', names } : NO_ENUM_NAMES;
}

function resolveEnumNamesType2(
  schema: CddlSchema,
  t2: CddlType2,
  seen: ReadonlySet<string>
): EnumResolution {
  switch (t2.kind) {
    case 'enum': {
      // `&groupname<genericarg>` (a reference, not a literal group): this
      // resolver doesn't attempt group-reference resolution here.
      if (t2.group.kind !== 'group') return OPEN_ENUM_NAMES;
      // Every entry is one choice of the enum's own value set. A
      // `name: <int literal>` entry names its value; any other entry (a
      // range like `reserved: 0..10`, a `uint`-typed one, an unnamed
      // literal, …) is resolved as a type in its own right, so one that
      // could accept the same integer under no name poisons the result
      // exactly as a sibling `/` alternative would.
      const names = new Map<bigint, EnumName>();
      const conflicting = new Set<bigint>();
      for (const choice of t2.group.choices) {
        for (const entry of choice) {
          if (entry.kind !== 'entry') return OPEN_ENUM_NAMES;
          const binding = literalEnumBinding(entry);
          if (binding) {
            const [name, value] = binding;
            mergeEnumNames(names, conflicting, new Map([[value, name]]));
            continue;
          }
          const resolved = resolveEnumNames(schema, entry.value, seen);
          if (resolved.kind === 'open') return OPEN_ENUM_NAMES;
          if (resolved.kind === 'resolved')
            mergeEnumNames(names, conflicting, resolved.names);
        }
      }
      for (const value of conflicting) names.delete(value);
      return names.size > 0 ? { kind: 'resolved', names } : NO_ENUM_NAMES;
    }
    case 'paren':
      return resolveEnumNames(schema, t2.type, seen);
    case 'ref': {
      // A generic instantiation isn't resolved by this simplified resolver
      // (see the module doc's Scope note), so it might still accept this
      // integer under no name — open. A name with no user definition falls
      // back to the prelude's own (user rules shadow it), resolved the same
      // way as any other rule: `uint = #0`, `int = uint / nint`, `number`,
      // `integer`, `any = #`, … all come out open (they accept a bare
      // integer under no name), while `bool`/`tstr`/`float`/… come out none
      // (they never hold one). A name defined nowhere at all is open too —
      // its shape is unknown, not ruled out.
      if (t2.genericArgs?.length) return OPEN_ENUM_NAMES;
      if (seen.has(t2.name)) return NO_ENUM_NAMES;
      let defs = schema.ast.filter((r) => r.name === t2.name);
      if (defs.length === 0) {
        const preludeRule = getPreludeRules().get(t2.name);
        defs = preludeRule ? [preludeRule] : [];
      }
      if (defs.length === 0 || defs.some((r) => r.generics?.length))
        return OPEN_ENUM_NAMES;
      const nextSeen = new Set(seen);
      nextSeen.add(t2.name);
      const names = new Map<bigint, EnumName>();
      const conflicting = new Set<bigint>();
      for (const def of defs) {
        if (def.body.kind !== 'entry' || def.body.occur || def.body.memberKey)
          return OPEN_ENUM_NAMES; // an unusual rule-body shape: not attempted
        const resolved = resolveEnumNames(schema, def.body.value, nextSeen);
        if (resolved.kind === 'open') return OPEN_ENUM_NAMES;
        if (resolved.kind === 'resolved')
          mergeEnumNames(names, conflicting, resolved.names);
      }
      for (const value of conflicting) names.delete(value);
      return names.size > 0 ? { kind: 'resolved', names } : NO_ENUM_NAMES;
    }
    case 'any':
    case 'unwrap':
    case 'tagged':
      // `any` (the bare `#` token) structurally accepts *any* value under
      // no name, the same risk as an unshadowed `ref` to it above;
      // `unwrap`/tagged wrap further content this simplified resolver
      // doesn't look inside (see the module doc's Scope note) — none of
      // these can be ruled out the way a type we're sure never even
      // structurally holds an integer safely is.
      return OPEN_ENUM_NAMES;
    case 'major':
      // `#0[...]`/`#1[...]` denote any item of major type 0/1 — an
      // unsigned/negative integer, unconstrained, the same "could be any
      // integer under no name" risk as `any` itself; every other major
      // number (bytes/text/array/map/tag/simple) can never even
      // structurally be the bare integer this resolver is trying to name.
      return t2.major === 0 || t2.major === 1 ? OPEN_ENUM_NAMES : NO_ENUM_NAMES;
    case 'value': {
      // An integer literal accepts exactly that one integer, under no name
      // — recorded as UNNAMED so it conflicts with (and so cancels) any
      // name another choice gives the same value, while leaving every other
      // value alone. Any other literal (text/bytes/float) never matches a
      // bare integer at all.
      const v = literalIntOfType2(t2);
      return v === undefined
        ? NO_ENUM_NAMES
        : { kind: 'resolved', names: new Map([[v, UNNAMED]]) };
    }
    default:
      // map/array: never structurally the bare integer being named.
      return NO_ENUM_NAMES;
  }
}

/**
 * Placeholder "name" for an integer some choice accepts without naming it
 * (see `resolveEnumNamesType2()`'s `value` case) — never a real label;
 * `resolveValueEnumName()` treats it as no name at all. A `Symbol`, not a
 * string, so it can never collide with a genuine name — including the
 * empty string, which `&("": 1)` legitimately binds.
 */
const UNNAMED: unique symbol = Symbol('unnamed');

type EnumName = string | typeof UNNAMED;

function literalIntOfType2(
  t2: Extract<CddlType2, { kind: 'value' }>
): bigint | undefined {
  if (t2.type !== 'int') return undefined;
  return typeof t2.value === 'bigint' ? t2.value : BigInt(t2.value);
}
