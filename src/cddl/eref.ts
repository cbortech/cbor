/**
 * Name/value tables for the `e'...'` external-reference EDN extension
 * (draft-ietf-cbor-edn-e-ref): resolving a CDDL-model mnemonic (`title`) to
 * the constant value it stands for (`-1`), and back.
 *
 * Three kinds of CDDL construct contribute a name, but not symmetrically:
 *
 * - A constant rule: `title = -1` (a rule whose body reduces to a single
 *   integer literal). Contributes to `byName` only — `e'title'` should
 *   still resolve it while parsing CDN text, but a general-purpose constant
 *   says nothing about whether `-1` *means* "title" wherever it happens to
 *   show up as a map key elsewhere, so it must not drive the reverse
 *   annotation direction (`byValue` — see `extensions/eref.ts`'s
 *   `annotateERefKeys()` and `ToJSOptions.eRefKeys`) *on its own*.
 * - A named group-enumeration entry used to label a map member key, e.g.
 *   `? &(title: -1) => oltext`: the `&(name: value)` enum literal sitting at
 *   an entry's own member-key position. Contributes to both `byName` and
 *   `byValue`. The same `&(name: value)` syntax appearing somewhere *other*
 *   than a member-key position (e.g. as an entry's value type) contributes
 *   to `byName` only, for the same reason a constant rule does — it is not
 *   itself labeling a map key.
 * - A bare reference to a constant rule, itself sitting at a member-key
 *   position, e.g. `? group_mode => bool` where `group_mode = 3` elsewhere
 *   in the schema: this pins the entry's key to `group_mode`'s value just
 *   as narrowly as `&(name: value)` does (the schema itself requires that
 *   exact key, not merely a type the value happens to satisfy), so it
 *   contributes to `byValue` too — the *same* constant rule referenced
 *   anywhere else (as a value's type, or not referenced by any entry at
 *   all) still only contributes to `byName`, same as the first bullet.
 *
 * Only integer-valued constants are covered — a name bound to a float, text,
 * or byte-string literal is not collected. This is a deliberate, narrower
 * scope than the draft's own "any CDDL constant value" framing: the `e'...'`
 * use case this library targets first is CDDL models that label map-entry
 * integer keys, per the draft's own `problem-details` example, and
 * `e'name'` for such a non-integer constant currently fails to resolve —
 * see `createERefExtension()`'s parse error.
 *
 * A name bound to more than one different value anywhere in the schema is
 * ambiguous and excluded from `byName` — and, since annotating a value as
 * that name would then make the annotated CDN text itself fail to re-parse
 * (`e'name'` would have nowhere unambiguous to resolve back to), every
 * `byValue` entry for that name is excluded too, regardless of which source
 * produced it. A value bound to more than one different name is
 * independently excluded from `byValue` only (each name individually still
 * resolves via `byName`) — see `ERefTables`.
 */

import type { CddlSchema } from './schema';
import type {
  CddlGroup,
  CddlGroupEntry,
  CddlRule,
  CddlType,
  CddlType1,
  CddlType2,
} from './ast';

export interface ERefTables {
  /** Name → value, for resolving `e'name'` while parsing CDN. */
  readonly byName: ReadonlyMap<string, bigint>;
  /**
   * Value → name, for annotating a validated integer map key with a name —
   * populated only from a binding at a genuine map-member-key position
   * (a `&(name: value)` literal, or a bare reference to a constant rule
   * used as the member key itself — never from either construct appearing
   * anywhere else, and never from a general constant rule that isn't
   * referenced at a member-key position at all) and only when neither the
   * name nor the value is ambiguous (see the module doc and
   * `ambiguousNames`).
   */
  readonly byValue: ReadonlyMap<bigint, string>;
  /**
   * Name → value, the exact inverse of `byValue` (safe and unambiguous by
   * construction: every name appearing in `byValue` appears there with
   * exactly one value, since a name bound to more than one value is already
   * excluded — see `ambiguousNames`). Used for the reverse direction:
   * `fromJS()`'s `eRefKeys` option converting a plain-object property name
   * back to the integer key it names, symmetric with `ToJSOptions.eRefKeys`.
   */
  readonly nameToValue: ReadonlyMap<string, bigint>;
  /**
   * Names that were seen bound to more than one different value anywhere in
   * the schema, and so were excluded from `byName` (and, transitively, from
   * every `byValue`/`nameToValue` entry that would have named a value after
   * one of them) — kept separately only to produce a clearer "ambiguous"
   * error message than a plain "not defined" one would.
   */
  readonly ambiguousNames: ReadonlySet<string>;
  /**
   * Name → value, from `name = <int literal>` rule definitions **only**
   * (including every `/=`/`//=` extension of the same name, when they all
   * agree on a single value) — deliberately excludes a name that's *only*
   * ever used as an `&(name: value)` enum label somewhere in the schema,
   * even though that label also feeds `byName`/`nameToValue` (a
   * general-purpose lookup that doesn't distinguish the two, correctly, for
   * `e'name'`'s own CDN parse direction). A *bare* type reference at a
   * member-key position (`? group_mode => bool`, or a wildcard's own key
   * type, `* group_mode => …`) means "this rule's own constant value" —
   * e.g. `group_mode = 3` — never "this spelling, however it's used
   * anywhere in the schema"; conflating the two would let an unrelated
   * `&(group_mode: 2) => …` enum label elsewhere make a wildcard whose key
   * type is the *rule* `group_mode` (which might not even be an integer
   * type at all) look like a closed, safe reference when it isn't — see
   * `cddl/eRefScope.ts`'s own use of this.
   */
  readonly ruleConstantValues: ReadonlyMap<string, bigint>;
}

const cache = new WeakMap<CddlSchema, ERefTables>();

/**
 * Extract (and cache, per schema instance) the `e'...'` name tables for a
 * compiled CDDL schema.
 */
export function getERefTables(schema: CddlSchema): ERefTables {
  let tables = cache.get(schema);
  if (!tables) {
    tables = extractERefTables(schema);
    cache.set(schema, tables);
  }
  return tables;
}

function extractERefTables(schema: CddlSchema): ERefTables {
  // Every name↔value binding, from every source (constant rules, and every
  // `&(name: value)` literal regardless of position) — drives `byName` and
  // `ambiguousNames`: the CDN `e'name'` *parse* direction, and the ambiguity
  // check a name bound to two different values anywhere must fail.
  const nameToValues = new Map<string, Set<bigint>>();
  // Only a binding at a genuine map-member-key position — drives `byValue`
  // (the reverse *annotation* direction).
  const keyPosValueToNames = new Map<bigint, Set<string>>();

  const addName = (name: string, value: bigint): void => {
    let values = nameToValues.get(name);
    if (!values) {
      values = new Set();
      nameToValues.set(name, values);
    }
    values.add(value);
  };
  const addKeyPosValue = (value: bigint, name: string): void => {
    let names = keyPosValueToNames.get(value);
    if (!names) {
      names = new Set();
      keyPosValueToNames.set(value, names);
    }
    names.add(name);
  };
  // Names forced out of consideration entirely — merged into
  // `ambiguousNames` at the end, alongside names genuinely bound to more
  // than one distinct integer.
  const forcedAmbiguous = new Set<string>();

  // Constant rules: `name = <int literal>`, including every `/=`/`//=`
  // choice extension of the same name — `x = 1` plus `x /= 2` elsewhere in
  // the schema makes `x` denote `1 / 2`, not a single constant, so both
  // literals are collected the same way two *different* rules binding `x`
  // to different values would be, letting the existing ambiguity check
  // below (`nameToValues`) correctly exclude `x` from `byName` rather than
  // resolving it to whichever definition this loop happened to see first.
  // Grouped by name *first* — rather than processed rule by rule — so that
  // an extension whose own body *isn't* a single integer literal (`x /=
  // tstr`, or `x /= 2 / 3`, itself a 2-way choice) forces the whole name
  // out of consideration too: `x` genuinely denotes `1 / tstr` (or
  // `1 / 2 / 3`) then, not reliably an integer at all, so treating *any*
  // reference to it as "the constant 1" would be just as wrong as the
  // all-integer ambiguous case below — silently ignoring the non-integer
  // side (as a rule-by-rule loop would, since `literalIntOfEntry` simply
  // returns `undefined` for it) is not the same as it not existing.
  // Always feeds `byName`; also consulted below (`constantValues`) so a
  // member key that's a *bare reference* to one of these rules — `?
  // group_mode => bool`, where `group_mode = 3` — is recognized as a
  // key-position binding too, the same as `&(name: value)` already is (see
  // `walkType2`'s `'ref'` case); a name with more than one possible value
  // there is likewise left for the same post-processing ambiguity check to
  // exclude, not filtered out here.
  const constantValues = new Map<string, Set<bigint>>();
  const rulesByName = new Map<string, CddlRule[]>();
  for (const rule of schema.ast) {
    if (rule.generics?.length) continue;
    let rules = rulesByName.get(rule.name);
    if (!rules) {
      rules = [];
      rulesByName.set(rule.name, rules);
    }
    rules.push(rule);
  }
  for (const [name, rules] of rulesByName) {
    const values: bigint[] = [];
    let hasNonInt = false;
    for (const rule of rules) {
      const value = literalIntOfEntry(rule.body);
      if (value === undefined) hasNonInt = true;
      else values.push(value);
    }
    // A name with *no* integer-literal definition at all was never a
    // constant-rule candidate in the first place — an ordinary map/array/
    // text-typed rule, say — same as the original, simpler rule-by-rule
    // version of this loop, which just skipped it via `continue`.
    if (values.length === 0) continue;
    // A name with *some* integer definitions and *some* non-integer ones
    // (`x = 1` plus `x /= tstr`, or a `/=` extension that's itself a
    // multi-alternative choice like `2 / 3`) is forced out entirely: it
    // genuinely denotes a union that isn't reliably an integer, so
    // treating *any* reference to it as "the constant" would be as wrong
    // as the all-integer ambiguous case below.
    if (hasNonInt) {
      forcedAmbiguous.add(name);
      continue;
    }
    for (const value of values) {
      addName(name, value);
      let seen = constantValues.get(name);
      if (!seen) {
        seen = new Set();
        constantValues.set(name, seen);
      }
      seen.add(value);
    }
  }

  // `&(name: value)` literal enum groups and bare constant-rule references,
  // wherever they appear.
  for (const rule of schema.ast)
    walkEntry(rule.body, addName, addKeyPosValue, constantValues);

  const ambiguousNames = new Set<string>(forcedAmbiguous);
  const byName = new Map<string, bigint>();
  for (const [name, values] of nameToValues) {
    if (values.size > 1 || forcedAmbiguous.has(name)) ambiguousNames.add(name);
    else byName.set(name, values.values().next().value!);
  }

  const byValue = new Map<bigint, string>();
  const nameToValue = new Map<string, bigint>();
  for (const [value, names] of keyPosValueToNames) {
    if (names.size !== 1) continue; // value named more than once: ambiguous
    const [name] = names;
    if (ambiguousNames.has(name)) continue; // name itself is ambiguous
    byValue.set(value, name);
    nameToValue.set(name, value);
  }

  const ruleConstantValues = new Map<string, bigint>();
  for (const [name, values] of constantValues) {
    if (values.size === 1)
      ruleConstantValues.set(name, values.values().next().value!);
  }

  return { byName, byValue, nameToValue, ambiguousNames, ruleConstantValues };
}

/**
 * The literal integer value of a rule/entry body that reduces to a single
 * `type1` alternative with no range/control operator — e.g. `title = -1`,
 * or (the shortcut form) `title: -1` in a group entry. `undefined` for
 * anything else (a type reference, a group, a range, …).
 */
function literalIntOfEntry(entry: CddlGroupEntry): bigint | undefined {
  if (entry.kind !== 'entry') return undefined;
  return literalIntOfType(entry.value);
}

/**
 * The literal integer value of a `type`, when it reduces to a single
 * `type1` alternative with no range/control operator. `undefined` for
 * anything else. Exported for `eRefScope.ts`'s own, position-aware name
 * extraction, which needs the exact same check for an entry's own value.
 */
export function literalIntOfType(type: CddlType): bigint | undefined {
  if (type.alternatives.length !== 1) return undefined;
  const t1 = type.alternatives[0]!;
  if (t1.op) return undefined;
  return literalIntOfType2(t1.target);
}

function literalIntOfType2(t2: CddlType2): bigint | undefined {
  if (t2.kind !== 'value' || t2.type !== 'int') return undefined;
  return typeof t2.value === 'bigint' ? t2.value : BigInt(t2.value);
}

// ─── AST walk: find every `&(...)` literal enum group and every bare
// constant-rule reference at a member-key position, collecting their named,
// integer-literal-valued entries. Mirrors the structural walk in schema.ts.
//
// `atKeyPos` is `true` for the subtree reached from a *specific* entry's own
// `memberKey.key` (a genuine map-member-key position) and `false` for the
// subtree reached from that entry's `value` — threaded down through further
// *type*-level nesting only (parens, tagged content, generic arguments), so
// a `&(...)` (or a bare reference like `group_mode` in `? group_mode =>
// bool`, where `group_mode = 3`) several levels inside a member key's own
// type still counts as key-position. It is deliberately NOT threaded into a
// nested *group* (`walkGroup`, reached via a map/array type, an
// `entry-group`, or an enum literal's own group): every group entry
// re-derives key-vs-value fresh, independent of how the group containing it
// was itself reached — a `&(inner: 1)` genuinely at *its own* map's
// member-key position counts as key-position even if that whole nested map
// sits inside some outer entry's *value* (e.g. `? title: { &(inner: 1) =>
// tstr }`), and conversely a `&(...)` sitting somewhere in a value
// contributes to `byName` but never implies its enclosing group's own
// entries are key-positioned by association. `walkEntry`/`walkGroup` are
// the only functions that decide this split; every other function just
// propagates what it was given.
//
// `constantValues` (name → its single literal-int value, from every `=`
// constant rule in the schema — see `extractERefTables`) is threaded
// through unchanged, purely so `walkType2`'s `'ref'` case can recognize a
// bare reference to one of those rules.

type AddNameFn = (name: string, value: bigint) => void;
type AddKeyPosValueFn = (value: bigint, name: string) => void;
/**
 * Name → every literal value some `=`/`/=`/`//=` rule binds it to (see
 * `extractERefTables`'s own comment on why this is a set, not a single
 * value: a `/=`/`//=` extension of an already-defined name can add more).
 */
type ConstantValues = ReadonlyMap<string, ReadonlySet<bigint>>;

function walkEntry(
  entry: CddlGroupEntry,
  addName: AddNameFn,
  addKeyPosValue: AddKeyPosValueFn,
  constantValues: ConstantValues
): void {
  if (entry.kind === 'entry-group') {
    walkGroup(entry.group, addName, addKeyPosValue, constantValues);
    return;
  }
  if (entry.memberKey?.kind === 'type1')
    walkType1(
      entry.memberKey.key,
      addName,
      addKeyPosValue,
      true,
      constantValues
    );
  walkType(entry.value, addName, addKeyPosValue, false, constantValues);
}

function walkGroup(
  group: CddlGroup,
  addName: AddNameFn,
  addKeyPosValue: AddKeyPosValueFn,
  constantValues: ConstantValues
): void {
  for (const choice of group.choices)
    for (const entry of choice)
      walkEntry(entry, addName, addKeyPosValue, constantValues);
}

function walkType(
  type: CddlType,
  addName: AddNameFn,
  addKeyPosValue: AddKeyPosValueFn,
  atKeyPos: boolean,
  constantValues: ConstantValues
): void {
  for (const alt of type.alternatives)
    walkType1(alt, addName, addKeyPosValue, atKeyPos, constantValues);
}

function walkType1(
  t1: CddlType1,
  addName: AddNameFn,
  addKeyPosValue: AddKeyPosValueFn,
  atKeyPos: boolean,
  constantValues: ConstantValues
): void {
  walkType2(t1.target, addName, addKeyPosValue, atKeyPos, constantValues);
  if (t1.controller)
    walkType2(t1.controller, addName, addKeyPosValue, atKeyPos, constantValues);
}

function walkType2(
  t2: CddlType2,
  addName: AddNameFn,
  addKeyPosValue: AddKeyPosValueFn,
  atKeyPos: boolean,
  constantValues: ConstantValues
): void {
  switch (t2.kind) {
    case 'value':
    case 'any':
      return;
    case 'ref': {
      // A bare reference to a constant rule, sitting at a member-key
      // position — e.g. `? group_mode => bool` where `group_mode = 3` —
      // pins that entry's key to `group_mode`'s value exactly as narrowly
      // as `&(name: value)` does; see the module doc. No generic args means
      // this reference *is* the whole key type, not a parameterized type
      // merely mentioning the name, so only that shape qualifies. A name
      // extended with `/=`/`//=` elsewhere has more than one possible
      // value here (see `extractERefTables`'s own comment) — every one of
      // them is added, and the post-processing ambiguity check below
      // (`keyPosValueToNames`/`ambiguousNames`) is what actually excludes
      // an extended name from `byValue`, the same as it already does for
      // two unrelated rules binding one name to different values.
      const values = constantValues.get(t2.name);
      if (atKeyPos && values && !t2.genericArgs?.length) {
        for (const value of values) addKeyPosValue(value, t2.name);
      }
      for (const arg of t2.genericArgs ?? [])
        walkType1(arg, addName, addKeyPosValue, atKeyPos, constantValues);
      return;
    }
    case 'paren':
      walkType(t2.type, addName, addKeyPosValue, atKeyPos, constantValues);
      return;
    case 'map':
    case 'array':
      walkGroup(t2.group, addName, addKeyPosValue, constantValues);
      return;
    case 'unwrap':
      for (const arg of t2.ref.genericArgs ?? [])
        walkType1(arg, addName, addKeyPosValue, atKeyPos, constantValues);
      return;
    case 'enum':
      if (t2.group.kind === 'group') {
        collectEnumGroup(t2.group, addName, addKeyPosValue, atKeyPos);
        walkGroup(t2.group, addName, addKeyPosValue, constantValues);
      } else {
        for (const arg of t2.group.genericArgs ?? [])
          walkType1(arg, addName, addKeyPosValue, atKeyPos, constantValues);
      }
      return;
    case 'tagged':
      if (typeof t2.tag === 'object')
        walkType(t2.tag, addName, addKeyPosValue, atKeyPos, constantValues);
      walkType(t2.item, addName, addKeyPosValue, atKeyPos, constantValues);
      return;
    case 'major':
      if (typeof t2.ai === 'object')
        walkType(t2.ai, addName, addKeyPosValue, atKeyPos, constantValues);
      return;
  }
}

/**
 * Collect named entries directly in one `&(...)` literal group — e.g. both
 * of `&(title: -1, detail: -2)`'s entries. Only entries whose member key is
 * a bareword or a quoted-text literal, and whose value is a single integer
 * literal, contribute a name (`&(foo: 1..2)`, `&(foo: bar)`, and unnamed
 * entries are silently skipped — not every enum literal is used for naming).
 * `addKeyPosValue` is only called when `atKeyPos` — see `walkEntry`'s doc.
 */
function collectEnumGroup(
  group: CddlGroup,
  addName: AddNameFn,
  addKeyPosValue: AddKeyPosValueFn,
  atKeyPos: boolean
): void {
  for (const choice of group.choices) {
    for (const entry of choice) {
      if (entry.kind !== 'entry' || !entry.memberKey) continue;
      const mk = entry.memberKey;
      const name =
        mk.kind === 'bareword'
          ? mk.key
          : mk.kind === 'value' && mk.key.type === 'text'
            ? mk.key.value
            : undefined;
      if (name === undefined) continue;
      const value = literalIntOfType(entry.value);
      if (value === undefined) continue;
      addName(name, value);
      if (atKeyPos) addKeyPosValue(value, name);
    }
  }
}
