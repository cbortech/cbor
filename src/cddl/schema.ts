/**
 * CDDL compilation: rule table construction and static checks.
 *
 * `compile()` parses CDDL text and performs the semantic checks that do not
 * require a data item: duplicate rule detection, name resolution against the
 * user rules and the standard prelude, and generic arity checks. Validation
 * of CBOR data against a schema is a later phase.
 */

import { parseCDDL } from './parser';
import { getPreludeRules } from './prelude';
import { formatCddl } from './writer';
import { CddlSemanticError, type CddlWarning } from './errors';
import type {
  CddlGroup,
  CddlGroupEntry,
  CddlRef,
  CddlRule,
  CddlType,
  CddlType1,
  CddlType2,
} from './ast';

export interface CompileOptions {
  /**
   * When true (the default), semantic problems (undefined names, duplicate
   * rules, generic arity mismatches) throw a {@link CddlSemanticError}.
   * When false, they are collected into {@link CddlSchema.warnings}.
   */
  strict?: boolean;
}

/**
 * A compiled CDDL data model.
 *
 * `rules` maps each rule name to its definitions in source order: the base
 * definition plus any `/=` / `//=` choice extensions. User rules shadow
 * prelude names; the prelude itself is available via `getPreludeRules()`.
 */
export class CddlSchema {
  /** All rules in source order, as parsed (extensions unmerged). */
  readonly ast: readonly CddlRule[];
  /** Rule definitions by name (base definition first, then extensions). */
  readonly rules: ReadonlyMap<string, readonly CddlRule[]>;
  /**
   * The root of the data model: the first rule in the source (RFC 8610 §3.1).
   * Unset only for an empty model compiled with `strict: false`.
   */
  readonly root?: CddlRule;
  /** Semantic problems collected with `strict: false`; unset when clean. */
  readonly warnings?: CddlWarning[];

  /** @internal — use `CDDL.compile()`. */
  constructor(
    ast: CddlRule[],
    rules: Map<string, CddlRule[]>,
    root: CddlRule | undefined,
    warnings: CddlWarning[]
  ) {
    this.ast = ast;
    this.rules = rules;
    if (root) this.root = root;
    if (warnings.length > 0) this.warnings = warnings;
  }

  /** Serialize the data model back to CDDL text (comments are not preserved). */
  format(): string {
    return formatCddl(this.ast);
  }
}

/**
 * Parse and compile CDDL text.
 *
 * Throws `CddlSyntaxError` on grammar errors. Semantic problems throw a
 * {@link CddlSemanticError} by default; pass `strict: false` to collect them
 * into `schema.warnings` instead.
 */
export function compile(text: string, options?: CompileOptions): CddlSchema {
  const { rules } = parseCDDL(text);
  const warnings: CddlWarning[] = [];
  const prelude = getPreludeRules();

  if (rules.length === 0)
    warnings.push({
      code: 'no-rules',
      message:
        'a CDDL data model needs at least one rule to provide the root of the definition',
    });

  // Rule table: base definition plus /= and //= extensions, in source order.
  const table = new Map<string, CddlRule[]>();
  for (const rule of rules) {
    const existing = table.get(rule.name);
    if (!existing) {
      table.set(rule.name, [rule]);
      continue;
    }
    if (rule.assign === '=')
      warnings.push({
        code: 'duplicate-rule',
        message: `rule '${rule.name}' is already defined; use /= or //= to extend it`,
        start: rule.start,
        end: rule.end,
      });
    existing.push(rule);
  }

  // Name resolution and generic arity, per rule (generic parameters are in
  // scope only within their own rule definition's body).
  const declaredArity = (name: string): number | undefined => {
    const defs = table.get(name);
    if (defs) return defs[0]!.generics?.length ?? 0;
    const preludeRule = prelude.get(name);
    if (preludeRule) return preludeRule.generics?.length ?? 0;
    return undefined;
  };

  for (const rule of rules) {
    const generics = rule.generics;
    walkEntry(rule.body, {
      onRef(ref: CddlRef): void {
        if (generics?.includes(ref.name)) return;
        // Type and group sockets ($name / $$name) may be referenced and
        // extended without ever being defined.
        if (ref.name.startsWith('$')) return;
        const arity = declaredArity(ref.name);
        if (arity === undefined) {
          warnings.push({
            code: 'undefined-name',
            message: `'${ref.name}' is not defined (and is not a prelude name)`,
            start: ref.start,
            end: ref.end,
          });
          return;
        }
        const given = ref.genericArgs?.length ?? 0;
        if (arity !== given)
          warnings.push({
            code: 'generic-arity',
            message: `'${ref.name}' takes ${arity} generic argument${arity === 1 ? '' : 's'} but is used with ${given}`,
            start: ref.start,
            end: ref.end,
          });
      },
      onMajor(major: number, start: number, end: number): void {
        if (major > 7)
          warnings.push({
            code: 'invalid-major',
            message: `#${major} is not a CBOR major type (0–7)`,
            start,
            end,
          });
      },
    });
  }

  // The first rule is the root of the data model, and "there is no way to
  // use a group as a root -- it must be a type" (RFC 8610 §2.2.4).
  const root = rules[0];
  if (root && !isTypeBody(root.body))
    warnings.push({
      code: 'invalid-root',
      message: `the first rule '${root.name}' is the root of the data model and must define a type, not a group (RFC 8610 §2.2.4)`,
      start: root.start,
      end: root.end,
    });

  if ((options?.strict ?? true) && warnings.length > 0)
    throw new CddlSemanticError(warnings);

  // An empty model has no root; `no-rules` was already reported above.
  return new CddlSchema(rules, table, root, warnings);
}

/**
 * Whether a rule body is usable as a type: a plain entry (no occurrence, no
 * member key), or a parenthesized group that reduces to one such entry.
 * A trailing comma makes a parenthesized expression a group — `(int,)` is
 * never a parenthesized type.
 */
function isTypeBody(entry: CddlGroupEntry): boolean {
  if (entry.kind === 'entry') return !entry.occur && !entry.memberKey;
  if (entry.occur || entry.group.trailingComma) return false;
  const { choices } = entry.group;
  return (
    choices.length === 1 &&
    choices[0]!.length === 1 &&
    isTypeBody(choices[0]![0]!)
  );
}

// ─── AST walk ─────────────────────────────────────────────────────────────────

interface WalkHooks {
  onRef(ref: CddlRef): void;
  onMajor(major: number, start: number, end: number): void;
}

function walkEntry(entry: CddlGroupEntry, hooks: WalkHooks): void {
  if (entry.kind === 'entry-group') {
    walkGroup(entry.group, hooks);
    return;
  }
  if (entry.memberKey?.kind === 'type1') walkType1(entry.memberKey.key, hooks);
  walkType(entry.value, hooks);
}

function walkGroup(group: CddlGroup, hooks: WalkHooks): void {
  for (const choice of group.choices)
    for (const entry of choice) walkEntry(entry, hooks);
}

function walkType(type: CddlType, hooks: WalkHooks): void {
  for (const alt of type.alternatives) walkType1(alt, hooks);
}

function walkType1(type1: CddlType1, hooks: WalkHooks): void {
  walkType2(type1.target, hooks);
  if (type1.controller) walkType2(type1.controller, hooks);
}

function walkType2(type2: CddlType2, hooks: WalkHooks): void {
  switch (type2.kind) {
    case 'value':
    case 'any':
      return;
    case 'ref':
      hooks.onRef(type2);
      for (const arg of type2.genericArgs ?? []) walkType1(arg, hooks);
      return;
    case 'paren':
      walkType(type2.type, hooks);
      return;
    case 'map':
    case 'array':
      walkGroup(type2.group, hooks);
      return;
    case 'unwrap':
      hooks.onRef(type2.ref);
      for (const arg of type2.ref.genericArgs ?? []) walkType1(arg, hooks);
      return;
    case 'enum':
      if (type2.group.kind === 'ref') {
        hooks.onRef(type2.group);
        for (const arg of type2.group.genericArgs ?? []) walkType1(arg, hooks);
      } else walkGroup(type2.group, hooks);
      return;
    case 'tagged':
      if (typeof type2.tag === 'object') walkType(type2.tag, hooks);
      walkType(type2.item, hooks);
      return;
    case 'major':
      hooks.onMajor(type2.major, type2.start, type2.end);
      if (typeof type2.ai === 'object') walkType(type2.ai, hooks);
      return;
  }
}
