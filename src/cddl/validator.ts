/**
 * CDDL validation engine: matches a CBOR AST (CborItem) against a compiled
 * CDDL schema (CddlSchema).
 *
 * Design notes:
 * - Arrays are matched by backtracking over the group's occurrence
 *   indicators (regex-style over the item sequence), enumerating the
 *   possible end positions of each sub-group.
 * - Maps are matched by consuming entries: group entries are processed in
 *   definition order and greedily consume matching map entries; member keys
 *   with cut semantics (`:` and `^ =>`, RFC 8610 §3.5.4) commit to an entry
 *   once its key matches, failing the whole map when the value mismatches.
 * - Failures discarded by backtracking are noise; only the failure that
 *   reached furthest into the instance source is reported.
 * - `maxSteps` / `maxDepth` bound pathological backtracking and unbounded
 *   recursion; exceeding them aborts validation with an explanatory error.
 * - A CDN elision (`...`, CborEllipsis) matches any single item or map
 *   entry; container lengths and required counts still apply.
 */

import type { CddlSchema } from './schema';
import { getPreludeRules } from './prelude';
import { CborItem } from '../ast/CborItem';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborFloat } from '../ast/CborFloat';
import { CborSimple } from '../ast/CborSimple';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborTag } from '../ast/CborTag';
import { CborEllipsis } from '../ast/CborEllipsis';
import { autoSelectFloatPrecision } from '../cbor/encode';
import { textValue, byteValue, bytesEqual, intValueOf } from './equal';
import type {
  CddlValidationError,
  CddlValidationWarning,
  ValidationResult,
} from './errors';
import type {
  CddlGroup,
  CddlGroupEntry,
  CddlMemberKey,
  CddlNodeBase,
  CddlRef,
  CddlRule,
  CddlType,
  CddlType1,
  CddlType2,
  CddlValue,
} from './ast';
import { featureName, getControl, type ControlDeps } from './controls';

export interface ValidateOptions {
  /** Recursion guard for rule references and nested groups (default 256). */
  maxDepth?: number;
  /** Total backtracking step budget (default 1e6). */
  maxSteps?: number;
  /** Feature names accepted by the `.feature` control operator. */
  features?: string[];
}

// ─── Context ──────────────────────────────────────────────────────────────────

type PathSeg = string | number;

/** Generic parameter bindings; each binding closes over its defining env. */
type Env = Map<string, { type1: CddlType1; env: Env }> | undefined;

class LimitExceeded extends Error {}

class Ctx {
  steps = 0;
  ruleName: string | undefined;
  /** >0 while matching content decoded out of a .cbor/.cborseq byte string,
   *  whose node offsets are relative to the embedded bytes — meaningless in
   *  the outer document, so they are suppressed. */
  embeddedDepth = 0;
  /** >0 while matching inside a prelude rule, whose node offsets point into
   *  the prelude text; errors are anchored to the referencing user node. */
  preludeDepth = 0;
  preludeRef: CddlNodeBase | undefined;
  readonly warnings: CddlValidationWarning[] = [];
  private readonly warned = new Set<string>();
  best: (CddlValidationError & { depth: number; startKey: number }) | undefined;

  constructor(
    readonly schema: CddlSchema,
    readonly maxDepth: number,
    readonly maxSteps: number,
    readonly features: Set<string>
  ) {}

  step(): void {
    if (++this.steps > this.maxSteps)
      throw new LimitExceeded(
        `validation aborted: step budget of ${this.maxSteps} exceeded (pathological backtracking?)`
      );
  }

  checkDepth(depth: number): void {
    if (depth > this.maxDepth)
      throw new LimitExceeded(
        `validation aborted: recursion depth ${this.maxDepth} exceeded (cyclic rules without progress?)`
      );
  }

  warnOnce(message: string, node?: CddlNodeBase): void {
    const key = `${message}@${node?.start ?? -1}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push({
      message,
      ...(node ? { schemaStart: node.start, schemaEnd: node.end } : {}),
    });
  }

  /**
   * Record a failure candidate. The failure furthest into the instance
   * source wins (the standard furthest-progress heuristic — sub-failures
   * of ultimately-successful alternatives, e.g. the uint branch of `int`
   * rejecting a negative number, are left behind by later progress);
   * offset ties are broken by the deeper instance path, then recency.
   */
  fail(
    path: readonly PathSeg[],
    item: CborItem | undefined,
    node: CddlNodeBase | undefined,
    message: string
  ): false {
    const suppressed = this.embeddedDepth > 0;
    const startKey = suppressed ? -1 : (item?.start ?? -1);
    if (
      !this.best ||
      startKey > this.best.startKey ||
      (startKey === this.best.startKey && path.length >= this.best.depth)
    ) {
      const schemaNode = this.preludeDepth > 0 ? this.preludeRef : node;
      this.best = {
        depth: path.length,
        startKey,
        message,
        path: path.length === 0 ? '/' : '/' + path.join('/'),
        ...(!suppressed && item?.start !== undefined
          ? { start: item.start, end: item.end }
          : {}),
        ...(this.ruleName !== undefined ? { ruleName: this.ruleName } : {}),
        ...(schemaNode
          ? { schemaStart: schemaNode.start, schemaEnd: schemaNode.end }
          : {}),
      };
    }
    return false;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function validateItem(
  schema: CddlSchema,
  item: CborItem,
  options?: ValidateOptions
): ValidationResult {
  const root = schema.root;
  if (!root)
    return {
      valid: false,
      errors: [
        {
          message: 'schema has no rules (no root to validate against)',
          path: '/',
        },
      ],
    };
  const ctx = new Ctx(
    schema,
    options?.maxDepth ?? 256,
    options?.maxSteps ?? 1_000_000,
    new Set(options?.features ?? [])
  );
  let valid: boolean;
  try {
    valid = matchRuleName(item, root.name, undefined, [], ctx, 0);
  } catch (e) {
    if (!(e instanceof LimitExceeded)) throw e;
    return {
      valid: false,
      errors: [{ message: e.message, path: '/' }],
      ...(ctx.warnings.length ? { warnings: ctx.warnings } : {}),
    };
  }
  if (valid)
    return {
      valid: true,
      errors: [],
      ...(ctx.warnings.length ? { warnings: ctx.warnings } : {}),
    };
  const errors: CddlValidationError[] = ctx.best
    ? [(({ depth: _d, startKey: _s, ...rest }) => rest)(ctx.best)]
    : [
        {
          message: `value does not match rule '${root.name}'`,
          path: '/',
          ...(item.start !== undefined
            ? { start: item.start, end: item.end }
            : {}),
        },
      ];
  return {
    valid: false,
    errors,
    ...(ctx.warnings.length ? { warnings: ctx.warnings } : {}),
  };
}

// ─── Rule resolution ──────────────────────────────────────────────────────────

function ruleDefs(ctx: Ctx, name: string): readonly CddlRule[] | undefined {
  const defs = ctx.schema.rules.get(name);
  if (defs) return defs;
  const preludeRule = getPreludeRules().get(name);
  return preludeRule ? [preludeRule] : undefined;
}

function isPlainTypeEntry(
  entry: CddlGroupEntry
): entry is Extract<CddlGroupEntry, { kind: 'entry' }> {
  return entry.kind === 'entry' && !entry.occur && !entry.memberKey;
}

/** The group choices contributed by one rule definition body. */
function choicesOfBody(entry: CddlGroupEntry): CddlGroupEntry[][] {
  if (entry.kind === 'entry-group' && !entry.occur) return entry.group.choices;
  return [[entry]];
}

/** Whether a set of rule definitions can only be used as a group. */
function isGroupLike(defs: readonly CddlRule[]): boolean {
  return defs.some((d) => !isPlainTypeEntry(d.body));
}

/**
 * Bind one definition's own generic parameter names to the reference's
 * arguments. Each `/=` / `//=` extension may name its parameters
 * differently, so binding is per definition, never from `defs[0]` alone.
 */
function bindGenericsForDef(
  def: CddlRule,
  genericArgs: readonly CddlType1[] | undefined,
  callerEnv: Env
): Env {
  const params = def.generics;
  if (!params || !genericArgs) return undefined;
  const bound = new Map<string, { type1: CddlType1; env: Env }>();
  for (let i = 0; i < params.length && i < genericArgs.length; i++)
    bound.set(params[i]!, { type1: genericArgs[i]!, env: callerEnv });
  return bound;
}

function matchRuleName(
  item: CborItem,
  name: string,
  callerEnv: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number,
  refNode?: CddlNodeBase,
  genericArgs?: readonly CddlType1[]
): boolean {
  const defs = ruleDefs(ctx, name);
  if (!defs)
    return ctx.fail(
      path,
      item,
      refNode,
      name.startsWith('$')
        ? `socket '${name}' has no definitions, so nothing matches it`
        : `'${name}' is not defined`
    );
  ctx.checkDepth(depth);
  const prevRule = ctx.ruleName;
  ctx.ruleName = name;
  const fromPrelude = !ctx.schema.rules.has(name);
  if (fromPrelude && ++ctx.preludeDepth === 1) ctx.preludeRef = refNode;
  try {
    for (const def of defs) {
      const env = bindGenericsForDef(def, genericArgs, callerEnv);
      if (isPlainTypeEntry(def.body)) {
        if (matchType(item, def.body.value, env, path, ctx, depth + 1))
          return true;
        continue;
      }
      // A group-bodied definition in type position: usable only when every
      // choice reduces to a single plain entry (a choice-of-types group).
      const choices = choicesOfBody(def.body);
      let usable = true;
      for (const choice of choices) {
        if (choice.length === 1 && isPlainTypeEntry(choice[0]!)) continue;
        usable = false;
        break;
      }
      if (!usable) {
        ctx.fail(
          path,
          item,
          def.body,
          `group rule '${name}' cannot be used as a type`
        );
        continue;
      }
      for (const choice of choices) {
        const only = choice[0]! as Extract<CddlGroupEntry, { kind: 'entry' }>;
        if (matchType(item, only.value, env, path, ctx, depth + 1)) return true;
      }
    }
    return false;
  } finally {
    ctx.ruleName = prevRule;
    if (fromPrelude && --ctx.preludeDepth === 0) ctx.preludeRef = undefined;
  }
}

// ─── Type matching ────────────────────────────────────────────────────────────

function matchType(
  item: CborItem,
  type: CddlType,
  env: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): boolean {
  for (const alt of type.alternatives)
    if (matchType1(item, alt, env, path, ctx, depth)) return true;
  return false;
}

function matchType1(
  item: CborItem,
  t1: CddlType1,
  env: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): boolean {
  ctx.step();
  if (!t1.op || !t1.controller)
    return matchType2(item, t1.target, env, path, ctx, depth);
  if (t1.op.kind === 'range')
    return matchRange(item, t1, env, path, ctx, depth);
  const handler = getControl(t1.op.name);
  const deps = makeControlDeps(env, ctx, depth);
  if (!handler) {
    ctx.warnOnce(
      `control operator .${t1.op.name} is not supported; matching the target only`,
      t1
    );
    return matchType2(item, t1.target, env, path, ctx, depth);
  }
  return handler(deps, item, t1.target, t1.controller, path, t1);
}

function matchType2(
  item: CborItem,
  t2: CddlType2,
  env: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): boolean {
  // A CDN elision stands for content that was deliberately left out.
  if (item instanceof CborEllipsis) return true;

  switch (t2.kind) {
    case 'any':
      return true;

    case 'value':
      return matchesLiteral(item, t2)
        ? true
        : ctx.fail(path, item, t2, `expected the value ${t2.raw}`);

    case 'ref': {
      const binding = env?.get(t2.name);
      if (binding && !t2.genericArgs)
        return matchType1(
          item,
          binding.type1,
          binding.env,
          path,
          ctx,
          depth + 1
        );
      return matchRuleName(
        item,
        t2.name,
        env,
        path,
        ctx,
        depth + 1,
        t2,
        t2.genericArgs
      );
    }

    case 'paren':
      return matchType(item, t2.type, env, path, ctx, depth);

    case 'map':
      if (!(item instanceof CborMap))
        return ctx.fail(path, item, t2, 'expected a map');
      return matchMapGroup(item, t2.group, env, path, ctx, depth + 1);

    case 'array':
      if (!(item instanceof CborArray))
        return ctx.fail(path, item, t2, 'expected an array');
      return matchArrayGroup(item, t2.group, env, path, ctx, depth + 1);

    case 'tagged': {
      // #6.n(type) denotes a *tagged data item* (RFC 8610 §3.6): an untagged
      // integer never matches #6.2/#6.3. (Value-level bignum equivalence
      // lives in literals/ranges/comparisons via intValueOf instead.)
      if (!(item instanceof CborTag))
        return ctx.fail(path, item, t2, 'expected a tagged item');
      if (typeof t2.tag === 'bigint') {
        if (item.tag !== t2.tag)
          return ctx.fail(
            path,
            item,
            t2,
            `expected tag ${t2.tag}, got ${item.tag}`
          );
      } else if (t2.tag !== undefined) {
        if (
          !matchType(new CborUint(item.tag), t2.tag, env, path, ctx, depth + 1)
        )
          return ctx.fail(
            path,
            item,
            t2,
            `tag number ${item.tag} does not match the head type`
          );
      }
      return matchType(item.content, t2.item, env, path, ctx, depth + 1);
    }

    case 'major':
      return matchMajor(item, t2, env, path, ctx, depth);

    case 'unwrap': {
      // Unwrapping a tag rule exposes the tagged content's type
      // (RFC 8610 §3.7, e.g. `my-uri = ~uri` is a tstr).
      const inner = resolveUnwrapTagType(t2.ref, env, ctx, 0);
      if (inner)
        return matchType(item, inner.type, inner.env, path, ctx, depth + 1);
      // Unwrapping an array/map splices a group into the enclosing
      // array/map; group matching resolves that before type matching, so
      // reaching this point means it was used where only a type can appear.
      ctx.warnOnce(
        `~${t2.ref.name} is used outside of an array/map group context`,
        t2
      );
      return ctx.fail(path, item, t2, `~${t2.ref.name} cannot match here`);
    }

    case 'enum': {
      const choices =
        t2.group.kind === 'ref'
          ? resolveGroupRef(t2.group, env, ctx)
          : plainChoices(t2.group, env);
      if (!choices)
        return ctx.fail(
          path,
          item,
          t2,
          `'&' target does not resolve to a group`
        );
      ctx.checkDepth(depth);
      if (matchEnum(item, choices, path, ctx, depth + 1)) return true;
      return ctx.fail(path, item, t2, 'no enumeration value matches');
    }
  }
}

/** Match an item against the set of entry values of an enum group. */
function matchEnum(
  item: CborItem,
  choices: readonly GroupChoice[],
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): boolean {
  for (const { entries, env } of choices) {
    for (const entry of entries) {
      ctx.step();
      if (entry.kind === 'entry-group') {
        if (
          matchEnum(item, plainChoices(entry.group, env), path, ctx, depth + 1)
        )
          return true;
        continue;
      }
      // Nested group reference inside the enum.
      const groupRef = asBareGroupRef(entry, env, ctx);
      if (groupRef) {
        ctx.checkDepth(depth);
        if (matchEnum(item, groupRef, path, ctx, depth + 1)) return true;
        continue;
      }
      if (matchType(item, entry.value, env, path, ctx, depth + 1)) return true;
    }
  }
  return false;
}

// ─── Literal and numeric matching ─────────────────────────────────────────────

export function matchesLiteral(item: CborItem, v: CddlValue): boolean {
  switch (v.type) {
    case 'int':
      // Value comparison is numeric, including bignums: the only wire form
      // of an integer beyond ±(2^64) is its tag-2/3 representation.
      return intValueOf(item) === BigInt(v.value);
    case 'float':
      return (
        item instanceof CborFloat &&
        (item.value === v.value ||
          (Number.isNaN(item.value) && Number.isNaN(v.value)))
      );
    case 'text':
      return textValue(item) === v.value;
    case 'bytes': {
      const bytes = byteValue(item);
      return bytes !== undefined && bytesEqual(bytes, v.value);
    }
  }
}

/**
 * Resolve a type2 to a literal value, following parentheses, generic
 * bindings, and references to single-alternative value rules. Used for
 * range endpoints and computing control operators (.plus, .cat, …).
 */
function resolveValue(
  t2: CddlType2,
  env: Env,
  ctx: Ctx,
  depth = 0
): CddlValue | undefined {
  if (depth > 32) return undefined;
  if (t2.kind === 'value') return t2;
  if (t2.kind === 'paren') {
    const only =
      t2.type.alternatives.length === 1 ? t2.type.alternatives[0] : undefined;
    if (!only || only.op) return undefined;
    return resolveValue(only.target, env, ctx, depth + 1);
  }
  if (t2.kind !== 'ref') return undefined;
  const binding = env?.get(t2.name);
  if (binding && !t2.genericArgs) {
    if (binding.type1.op) return undefined;
    return resolveValue(binding.type1.target, binding.env, ctx, depth + 1);
  }
  const defs = ruleDefs(ctx, t2.name);
  if (!defs || defs.length !== 1) return undefined;
  const body = defs[0]!.body;
  if (!isPlainTypeEntry(body) || body.value.alternatives.length !== 1)
    return undefined;
  const only = body.value.alternatives[0]!;
  if (only.op) return undefined;
  const newEnv = bindGenericsForDef(defs[0]!, t2.genericArgs, env);
  return resolveValue(only.target, newEnv, ctx, depth + 1);
}

/**
 * Whether some integer ≥ `min` matches the type — i.e. whether the type's
 * integer set intersects [min, ∞). Used by `uint .size N` (which accepts
 * any byte count N ≥ the value's minimal length, with no upper limit on N).
 *
 * Tri-state: `undefined` means the type could not be analyzed structurally
 * (control operators, non-integer constructs, …) and the caller must fall
 * back to another strategy.
 */
function existsIntGE(
  t2: CddlType2,
  min: bigint,
  env: Env,
  ctx: Ctx,
  depth = 0
): boolean | undefined {
  return existsIntInRange(t2, min, undefined, env, ctx, depth);
}

/** Whether an integer in the inclusive interval [min, max] matches t2. */
function existsIntInRange(
  t2: CddlType2,
  min: bigint,
  max: bigint | undefined,
  env: Env,
  ctx: Ctx,
  depth = 0
): boolean | undefined {
  const found = findIntInRange(t2, min, max, env, ctx, depth);
  return found === undefined ? undefined : found !== null;
}

/**
 * The first integer in [min, max] matching t2. `null` means the analyzed
 * type has no such integer; `undefined` means it cannot be analyzed.
 */
function findIntInRange(
  t2: CddlType2,
  min: bigint,
  max: bigint | undefined,
  env: Env,
  ctx: Ctx,
  depth = 0
): bigint | null | undefined {
  if (max !== undefined && min > max) return null;
  if (depth > 32) return undefined;
  switch (t2.kind) {
    case 'value': {
      if (t2.type === 'int') {
        const value = BigInt(t2.value);
        return value >= min && (max === undefined || value <= max)
          ? value
          : null;
      }
      return null;
    }
    case 'any': {
      const candidate = min > 0n ? min : 0n;
      return max === undefined || candidate <= max ? candidate : null;
    }
    case 'major': {
      if (t2.ai !== undefined) return undefined;
      if (t2.major === 0) {
        const candidate = min > 0n ? min : 0n;
        return candidate <= 0xffff_ffff_ffff_ffffn &&
          (max === undefined || candidate <= max)
          ? candidate
          : null;
      }
      if (t2.major === 1) {
        const candidate =
          min > -0x1_0000_0000_0000_0000n ? min : -0x1_0000_0000_0000_0000n;
        return candidate <= -1n && (max === undefined || candidate <= max)
          ? candidate
          : null;
      }
      return null;
    }
    case 'paren':
      return findIntInRangeType(t2.type, min, max, env, ctx, depth + 1);
    case 'ref': {
      const binding = env?.get(t2.name);
      if (binding && !t2.genericArgs)
        return findIntInRangeType1(
          binding.type1,
          min,
          max,
          binding.env,
          ctx,
          depth + 1
        );
      const defs = ruleDefs(ctx, t2.name);
      if (!defs) return undefined;
      let sawUnknown = false;
      let best: bigint | null = null;
      for (const def of defs) {
        if (!isPlainTypeEntry(def.body)) {
          sawUnknown = true;
          continue;
        }
        const defEnv = bindGenericsForDef(def, t2.genericArgs, env);
        const r = findIntInRangeType(
          def.body.value,
          min,
          max,
          defEnv,
          ctx,
          depth + 1
        );
        if (typeof r === 'bigint' && (best === null || r < best)) best = r;
        if (r === undefined) sawUnknown = true;
      }
      return best ?? (sawUnknown ? undefined : null);
    }
    case 'enum': {
      const choices =
        t2.group.kind === 'ref'
          ? resolveGroupRef(t2.group, env, ctx)
          : plainChoices(t2.group, env);
      if (!choices) return undefined;
      let sawUnknown = false;
      let best: bigint | null = null;
      for (const { entries, env: choiceEnv } of choices) {
        for (const entry of entries) {
          if (entry.kind !== 'entry') {
            sawUnknown = true;
            continue;
          }
          const r = findIntInRangeType(
            entry.value,
            min,
            max,
            choiceEnv,
            ctx,
            depth + 1
          );
          if (typeof r === 'bigint' && (best === null || r < best)) best = r;
          if (r === undefined) sawUnknown = true;
        }
      }
      return best ?? (sawUnknown ? undefined : null);
    }
    default:
      return undefined;
  }
}

function findIntInRangeType(
  type: CddlType,
  min: bigint,
  max: bigint | undefined,
  env: Env,
  ctx: Ctx,
  depth: number
): bigint | null | undefined {
  let sawUnknown = false;
  let best: bigint | null = null;
  for (const alt of type.alternatives) {
    const r = findIntInRangeType1(alt, min, max, env, ctx, depth);
    if (typeof r === 'bigint' && (best === null || r < best)) best = r;
    if (r === undefined) sawUnknown = true;
  }
  return best ?? (sawUnknown ? undefined : null);
}

function findIntInRangeType1(
  t1: CddlType1,
  min: bigint,
  max: bigint | undefined,
  env: Env,
  ctx: Ctx,
  depth: number
): bigint | null | undefined {
  if (!t1.op) return findIntInRange(t1.target, min, max, env, ctx, depth);
  if (t1.op.kind === 'ctl') {
    if (t1.op.name === 'bits')
      return findBitsIntersection(
        t1.target,
        t1.controller!,
        min,
        max,
        env,
        ctx,
        depth + 1
      );
    if (t1.op.name === 'size') {
      const candidate = findIntInRange(
        t1.target,
        min > 0n ? min : 0n,
        max,
        env,
        ctx,
        depth + 1
      );
      if (candidate === undefined || candidate === null) return candidate;
      const fits = existsIntGE(
        t1.controller!,
        BigInt(uintByteLength(candidate)),
        env,
        ctx,
        depth + 1
      );
      return fits === undefined ? undefined : fits ? candidate : null;
    }
    if (t1.op.name === 'feature') {
      const name = featureName(
        makeControlDeps(env, ctx, depth),
        t1.controller!
      );
      if (name === undefined) return undefined;
      if (!ctx.features.has(name)) {
        ctx.warnOnce(
          `feature "${name}" is not enabled (pass it in options.features to accept it)`,
          t1
        );
        return null;
      }
      return findIntInRange(t1.target, min, max, env, ctx, depth + 1);
    }
    if (t1.op.name === 'and' || t1.op.name === 'within')
      return findIntIntersection(
        t1.target,
        t1.controller!,
        min,
        max,
        env,
        ctx,
        depth + 1
      );
    if (t1.op.name === 'plus') {
      const left = resolveValue(t1.target, env, ctx);
      const right = resolveValue(t1.controller!, env, ctx);
      if (
        !left ||
        !right ||
        left.type === 'text' ||
        left.type === 'bytes' ||
        right.type === 'text' ||
        right.type === 'bytes'
      )
        return undefined;
      // .plus converts the result to the target's numeric type. A float
      // target therefore cannot produce the integer byte count sought here;
      // an integer target floors a mixed float sum (RFC 9165 §2.1).
      if (left.type === 'float') return null;
      const sum =
        right.type === 'int'
          ? BigInt(left.value) + BigInt(right.value)
          : BigInt(Math.floor(Number(left.value) + right.value));
      return sum >= min && (max === undefined || sum <= max) ? sum : null;
    }
    const bound = resolveValue(t1.controller!, env, ctx);
    if (!bound || bound.type !== 'int') return undefined;
    const value = BigInt(bound.value);
    switch (t1.op.name) {
      case 'eq':
        return findIntInRange(
          t1.target,
          value > min ? value : min,
          max === undefined || value < max ? value : max,
          env,
          ctx,
          depth + 1
        );
      case 'ne':
      case 'default': {
        const below = findIntInRange(
          t1.target,
          min,
          max === undefined || value - 1n < max ? value - 1n : max,
          env,
          ctx,
          depth + 1
        );
        if (typeof below === 'bigint') return below;
        const above = findIntInRange(
          t1.target,
          value + 1n > min ? value + 1n : min,
          max,
          env,
          ctx,
          depth + 1
        );
        if (typeof above === 'bigint') return above;
        return below === undefined || above === undefined ? undefined : null;
      }
      case 'lt':
      case 'le': {
        const upper = value - (t1.op.name === 'lt' ? 1n : 0n);
        return findIntInRange(
          t1.target,
          min,
          max === undefined || upper < max ? upper : max,
          env,
          ctx,
          depth + 1
        );
      }
      case 'gt':
      case 'ge': {
        const lower = value + (t1.op.name === 'gt' ? 1n : 0n);
        return findIntInRange(
          t1.target,
          lower > min ? lower : min,
          max,
          env,
          ctx,
          depth + 1
        );
      }
      default:
        return undefined;
    }
  }
  const lo = resolveValue(t1.target, env, ctx);
  const hi = resolveValue(t1.controller!, env, ctx);
  if (!lo || !hi || lo.type !== 'int' || hi.type !== 'int') return undefined;
  const loV = BigInt(lo.value);
  const hiV = BigInt(hi.value) - (t1.op.inclusive ? 0n : 1n);
  const lower = loV > min ? loV : min;
  const upper = max === undefined || hiV < max ? hiV : max;
  return lower <= upper ? lower : null;
}

/** First integer in the intersection of two analyzable integer types. */
function findIntIntersection(
  left: CddlType2,
  right: CddlType2,
  min: bigint,
  max: bigint | undefined,
  env: Env,
  ctx: Ctx,
  depth: number
): bigint | null | undefined {
  let cursor = min;
  // Each iteration advances to a boundary returned by one side. The guard
  // only protects malformed/cyclic analyses; ordinary finite unions
  // converge in at most their combined number of alternatives.
  for (let i = 0; i < 256; i++) {
    const a = findIntInRange(left, cursor, max, env, ctx, depth + 1);
    const b = findIntInRange(right, cursor, max, env, ctx, depth + 1);
    if (a === null || b === null) return null;
    if (a === undefined || b === undefined) return undefined;
    if (a === b) return a;
    cursor = a > b ? a : b;
  }
  return undefined;
}

/** First uint in the target whose set bits are all admitted by controller. */
function findBitsIntersection(
  target: CddlType2,
  controller: CddlType2,
  min: bigint,
  max: bigint | undefined,
  env: Env,
  ctx: Ctx,
  depth: number
): bigint | null | undefined {
  let allowedMask = 0n;
  for (let bit = 0; bit < 64; bit++) {
    const allowed = findIntInRange(
      controller,
      BigInt(bit),
      BigInt(bit),
      env,
      ctx,
      depth + 1
    );
    if (allowed === undefined) return undefined;
    if (allowed !== null) allowedMask |= 1n << BigInt(bit);
  }

  let cursor = min > 0n ? min : 0n;
  const upper =
    max === undefined || max > 0xffff_ffff_ffff_ffffn
      ? 0xffff_ffff_ffff_ffffn
      : max;
  for (let i = 0; i < 256; i++) {
    const fromTarget = findIntInRange(
      target,
      cursor,
      upper,
      env,
      ctx,
      depth + 1
    );
    const fromBits = nextAllowedBitValue(cursor, upper, allowedMask);
    if (fromTarget === undefined) return undefined;
    if (fromTarget === null || fromBits === null) return null;
    if (fromTarget === fromBits) return fromTarget;
    cursor = fromTarget > fromBits ? fromTarget : fromBits;
  }
  return undefined;
}

/** Smallest value >= min, <= max whose one-bits are a subset of mask. */
function nextAllowedBitValue(
  min: bigint,
  max: bigint,
  mask: bigint
): bigint | null {
  if (min < 0n) min = 0n;
  if (min > max) return null;

  const visit = (
    bit: number,
    greater: boolean,
    value: bigint
  ): bigint | null => {
    if (bit < 0) return value <= max ? value : null;
    const minBit = Number((min >> BigInt(bit)) & 1n);
    for (let chosen = 0; chosen <= 1; chosen++) {
      if (chosen === 1 && (mask & (1n << BigInt(bit))) === 0n) continue;
      if (!greater && chosen < minBit) continue;
      const found = visit(
        bit - 1,
        greater || chosen > minBit,
        chosen === 1 ? value | (1n << BigInt(bit)) : value
      );
      if (found !== null) return found;
    }
    return null;
  };
  return visit(63, false, 0n);
}

function uintByteLength(value: bigint): number {
  let bytes = 0;
  for (let v = value; v > 0n; v >>= 8n) bytes++;
  return bytes;
}

function matchRange(
  item: CborItem,
  t1: CddlType1,
  env: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): boolean {
  void depth;
  const op = t1.op as { kind: 'range'; inclusive: boolean };
  const lo = resolveValue(t1.target, env, ctx);
  const hi = resolveValue(t1.controller!, env, ctx);
  if (!lo || !hi) {
    ctx.warnOnce('range endpoints do not resolve to literal values', t1);
    return ctx.fail(path, item, t1, 'unresolvable range');
  }
  if (lo.type === 'int' && hi.type === 'int') {
    // Numeric comparison, including bignums (tags 2/3).
    const v = intValueOf(item);
    if (v === undefined)
      return ctx.fail(
        path,
        item,
        t1,
        `expected an integer in ${rangeText(t1)}`
      );
    const min = BigInt(lo.value);
    const max = BigInt(hi.value);
    if (v >= min && (op.inclusive ? v <= max : v < max)) return true;
    return ctx.fail(path, item, t1, `${v} is outside ${rangeText(t1)}`);
  }
  if (lo.type === 'float' && hi.type === 'float') {
    if (!(item instanceof CborFloat))
      return ctx.fail(path, item, t1, `expected a float in ${rangeText(t1)}`);
    const v = item.value;
    if (v >= lo.value && (op.inclusive ? v <= hi.value : v < hi.value))
      return true;
    return ctx.fail(path, item, t1, `${v} is outside ${rangeText(t1)}`);
  }
  ctx.warnOnce('range endpoints mix integer and float types', t1);
  return ctx.fail(path, item, t1, 'invalid range');
}

function rangeText(t1: CddlType1): string {
  const op = t1.op as { kind: 'range'; inclusive: boolean };
  return `${sourceText(t1.target)}${op.inclusive ? '..' : '...'}${sourceText(t1.controller!)}`;
}

function sourceText(t2: CddlType2): string {
  if (t2.kind === 'value') return t2.raw;
  if (t2.kind === 'ref') return t2.name;
  return '…';
}

// ─── Major types (#N[.ai]) ────────────────────────────────────────────────────

const FLOAT_AI: Record<string, bigint> = {
  half: 25n,
  single: 26n,
  double: 27n,
};

function matchMajor(
  item: CborItem,
  t2: Extract<CddlType2, { kind: 'major' }>,
  env: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): boolean {
  const matchHead = (n: bigint): boolean => {
    if (t2.ai === undefined) return true;
    if (typeof t2.ai === 'bigint') return t2.ai === n;
    return matchType(new CborUint(n), t2.ai, env, path, ctx, depth + 1);
  };
  const failKind = (what: string): false =>
    ctx.fail(path, item, t2, `expected ${what} (#${t2.major})`);

  switch (t2.major) {
    case 0:
      if (!(item instanceof CborUint)) return failKind('an unsigned integer');
      break;
    case 1:
      if (!(item instanceof CborNint)) return failKind('a negative integer');
      break;
    case 2:
      if (byteValue(item) === undefined) return failKind('a byte string');
      break;
    case 3:
      if (textValue(item) === undefined) return failKind('a text string');
      break;
    case 4:
      if (!(item instanceof CborArray)) return failKind('an array');
      break;
    case 5:
      if (!(item instanceof CborMap)) return failKind('a map');
      break;
    case 6: {
      if (!(item instanceof CborTag)) return failKind('a tagged item');
      if (!matchHead(item.tag))
        return ctx.fail(
          path,
          item,
          t2,
          `tag ${item.tag} does not match ${sourceMajor(t2)}`
        );
      return true;
    }
    case 7: {
      if (item instanceof CborSimple) {
        if (matchHead(BigInt(item.value))) return true;
        return ctx.fail(
          path,
          item,
          t2,
          `simple(${item.value}) does not match ${sourceMajor(t2)}`
        );
      }
      if (item instanceof CborFloat) {
        if (t2.ai === undefined) return true;
        // When no width was recorded (e.g. CDN input without an encoding
        // suffix), use the smallest width that represents the value
        // losslessly — its preferred serialization.
        const precision =
          item.precision ?? autoSelectFloatPrecision(item.value);
        if (matchHead(FLOAT_AI[precision]!)) return true;
        return ctx.fail(
          path,
          item,
          t2,
          `float does not match ${sourceMajor(t2)}`
        );
      }
      return failKind('a simple value or float');
    }
    default:
      return ctx.fail(path, item, t2, `#${t2.major} is not a valid major type`);
  }
  // Majors 0–5: an additional-information constraint is about encoding,
  // which Phase 2 does not check.
  if (t2.ai !== undefined && t2.major <= 5)
    ctx.warnOnce(
      `the additional-information constraint ${sourceMajor(t2)} is not checked (encoding-level)`,
      t2
    );
  return true;
}

function sourceMajor(t2: Extract<CddlType2, { kind: 'major' }>): string {
  return t2.raw ?? `#${t2.major}`;
}

// ─── Group matching: shared expansion ─────────────────────────────────────────

interface Occ {
  min: number;
  max: number;
}

/**
 * One group choice with the environment its entries are evaluated in.
 * The env is per choice because `//=` extensions of a generic rule may
 * name their parameters differently per definition.
 */
interface GroupChoice {
  entries: readonly CddlGroupEntry[];
  env: Env;
}

const plainChoices = (group: CddlGroup, env: Env): GroupChoice[] =>
  group.choices.map((entries) => ({ entries, env }));

type SeqMatcher =
  | {
      kind: 'type';
      occur: Occ;
      memberKey?: CddlMemberKey;
      type: CddlType;
      env: Env;
      node: CddlNodeBase;
    }
  | {
      kind: 'group';
      occur: Occ;
      choices: readonly GroupChoice[];
      node: CddlNodeBase;
    };

const ONE: Occ = { min: 1, max: 1 };

function occOf(entry: CddlGroupEntry): Occ {
  const o = entry.occur;
  if (!o) return ONE;
  if (o.marker === '?') return { min: 0, max: 1 };
  if (o.marker === '+') return { min: 1, max: Infinity };
  return { min: o.min ?? 0, max: o.max ?? Infinity };
}

/** Resolve a bare reference to a group-like rule (for splicing). */
function resolveGroupRef(
  ref: CddlRef,
  env: Env,
  ctx: Ctx
): GroupChoice[] | undefined {
  const defs = ruleDefs(ctx, ref.name);
  if (!defs) return undefined;
  if (!isGroupLike(defs)) return undefined;
  const choices: GroupChoice[] = [];
  for (const def of defs) {
    const defEnv = bindGenericsForDef(def, ref.genericArgs, env);
    for (const entries of choicesOfBody(def.body))
      choices.push({ entries, env: defEnv });
  }
  return choices;
}

/**
 * When an entry is a bare single reference, return the group it stands for
 * (group rule or unwrap) — the caller splices it into the sequence.
 */
function asBareGroupRef(
  entry: CddlGroupEntry,
  env: Env,
  ctx: Ctx
): GroupChoice[] | undefined {
  if (entry.kind !== 'entry' || entry.memberKey) return undefined;
  if (entry.value.alternatives.length !== 1) return undefined;
  const t1 = entry.value.alternatives[0]!;
  if (t1.op) return undefined;
  const target = t1.target;
  if (target.kind === 'ref') {
    if (env?.has(target.name) && !target.genericArgs) return undefined;
    const resolved = resolveGroupRef(target, env, ctx);
    if (resolved) return resolved;
    // An unplugged group socket is a choice with zero alternatives: it
    // matches nothing (which is why sockets are used as `* $$name`).
    if (target.name.startsWith('$$') && !ruleDefs(ctx, target.name)) return [];
    return undefined;
  }
  if (target.kind === 'unwrap')
    return resolveUnwrapGroup(target.ref, env, ctx, 0);
  return undefined;
}

/** ~ref: follow references to a map/array type and return its group. */
function resolveUnwrapGroup(
  ref: CddlRef,
  env: Env,
  ctx: Ctx,
  depth: number
): GroupChoice[] | undefined {
  if (depth > 32) return undefined;
  const defs = ruleDefs(ctx, ref.name);
  if (!defs || defs.length !== 1) return undefined;
  const body = defs[0]!.body;
  const newEnv = bindGenericsForDef(defs[0]!, ref.genericArgs, env);
  if (!isPlainTypeEntry(body)) {
    // Unwrapping a group rule: the group itself.
    return choicesOfBody(body).map((entries) => ({ entries, env: newEnv }));
  }
  if (body.value.alternatives.length !== 1) return undefined;
  const t1 = body.value.alternatives[0]!;
  if (t1.op) return undefined;
  if (t1.target.kind === 'map' || t1.target.kind === 'array')
    return plainChoices(t1.target.group, newEnv);
  if (t1.target.kind === 'ref')
    return resolveUnwrapGroup(t1.target, newEnv, ctx, depth + 1);
  return undefined;
}

/**
 * ~ref where the target is a tag rule: unwrapping removes the tag, exposing
 * the content type (RFC 8610 §3.7, e.g. `my-uri = ~uri` is a tstr).
 */
function resolveUnwrapTagType(
  ref: CddlRef,
  env: Env,
  ctx: Ctx,
  depth: number
): { type: CddlType; env: Env } | undefined {
  if (depth > 32) return undefined;
  const defs = ruleDefs(ctx, ref.name);
  if (!defs || defs.length !== 1) return undefined;
  const body = defs[0]!.body;
  if (!isPlainTypeEntry(body) || body.value.alternatives.length !== 1)
    return undefined;
  const t1 = body.value.alternatives[0]!;
  if (t1.op) return undefined;
  const newEnv = bindGenericsForDef(defs[0]!, ref.genericArgs, env);
  if (t1.target.kind === 'tagged') return { type: t1.target.item, env: newEnv };
  if (t1.target.kind === 'ref')
    return resolveUnwrapTagType(t1.target, newEnv, ctx, depth + 1);
  return undefined;
}

function expandEntry(entry: CddlGroupEntry, env: Env, ctx: Ctx): SeqMatcher {
  const occur = occOf(entry);
  if (entry.kind === 'entry-group')
    return {
      kind: 'group',
      occur,
      choices: plainChoices(entry.group, env),
      node: entry,
    };
  const groupRef = asBareGroupRef(entry, env, ctx);
  if (groupRef)
    return {
      kind: 'group',
      occur,
      choices: groupRef,
      node: entry,
    };
  return {
    kind: 'type',
    occur,
    ...(entry.memberKey ? { memberKey: entry.memberKey } : {}),
    type: entry.value,
    env,
    node: entry,
  };
}

// ─── Group matching: arrays (sequences) ───────────────────────────────────────

function matchArrayGroup(
  arr: CborArray,
  group: CddlGroup,
  env: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): boolean {
  ctx.checkDepth(depth);
  const ends = seqEnds(
    arr.items,
    0,
    plainChoices(group, env),
    path,
    ctx,
    depth
  );
  if (ends.has(arr.items.length)) return true;
  return ctx.fail(
    path,
    arr,
    group,
    `array of ${arr.items.length} item(s) does not match the group`
  );
}

/** All end positions reachable by matching the group's choices at `idx`. */
function seqEnds(
  items: readonly CborItem[],
  idx: number,
  choices: readonly GroupChoice[],
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): Set<number> {
  const out = new Set<number>();
  for (const choice of choices) {
    const matchers = choice.entries.map((e) => expandEntry(e, choice.env, ctx));
    seqStep(items, idx, matchers, 0, path, ctx, depth, out);
  }
  return out;
}

function seqStep(
  items: readonly CborItem[],
  idx: number,
  ms: readonly SeqMatcher[],
  k: number,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number,
  out: Set<number>
): void {
  if (k === ms.length) {
    out.add(idx);
    return;
  }
  const m = ms[k]!;

  const tryCount = (count: number, at: number): void => {
    ctx.step();
    if (count >= m.occur.min)
      seqStep(items, at, ms, k + 1, path, ctx, depth, out);
    if (count >= m.occur.max || at >= items.length) return;
    for (const end of matchOnceEnds(items, at, m, path, ctx, depth)) {
      // An empty match makes no progress; recursing on it would loop.
      if (end === at) continue;
      tryCount(count + 1, end);
    }
  };
  tryCount(0, idx);
}

/** End positions from matching a single occurrence of `m` at `at`. */
function matchOnceEnds(
  items: readonly CborItem[],
  at: number,
  m: SeqMatcher,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): number[] {
  if (m.kind === 'type') {
    // Member keys inside arrays are documentation only (RFC 8610 §3.4).
    return matchType(items[at]!, m.type, m.env, [...path, at], ctx, depth)
      ? [at + 1]
      : [];
  }
  ctx.checkDepth(depth);
  const ends = seqEnds(items, at, m.choices, path, ctx, depth + 1);
  // Descending order: prefer greedy consumption first.
  return [...ends].sort((a, b) => b - a);
}

// ─── Group matching: maps ─────────────────────────────────────────────────────

function matchMapGroup(
  map: CborMap,
  group: CddlGroup,
  env: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): boolean {
  ctx.checkDepth(depth);
  const consumed = new Array<boolean>(map.entries.length).fill(false);
  for (const choice of plainChoices(group, env)) {
    consumed.fill(false);
    if (
      mapSeq(
        map,
        choice.entries,
        0,
        consumed,
        choice.env,
        path,
        ctx,
        depth,
        () => mapFullyConsumed(map, consumed, path, ctx, group)
      )
    )
      return true;
  }
  return false;
}

function mapFullyConsumed(
  map: CborMap,
  consumed: boolean[],
  path: readonly PathSeg[],
  ctx: Ctx,
  node: CddlNodeBase
): boolean {
  for (let i = 0; i < consumed.length; i++) {
    if (consumed[i]) continue;
    const [k, v] = map.entries[i]!;
    // Leftover elided entries are what "..." stands for — ignore them.
    if (k instanceof CborEllipsis) continue;
    ctx.fail(
      [...path, keySeg(k, i)],
      v,
      node,
      `entry ${describeItem(k)} is not allowed by the group`
    );
    return false;
  }
  return true;
}

/**
 * Match the entries of one group choice against the map, in continuation
 * style so that sub-group choices and occurrence counts can backtrack when
 * downstream matchers (or the final completeness check) fail.
 *
 * Entry-to-member assignment itself is greedy in definition order and is
 * not backtracked (a deliberate heuristic — put wildcard members last).
 */
function mapSeq(
  map: CborMap,
  entries: readonly CddlGroupEntry[],
  k: number,
  consumed: boolean[],
  env: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number,
  cont: () => boolean
): boolean {
  if (k === entries.length) return cont();
  const m = expandEntry(entries[k]!, env, ctx);

  if (m.kind === 'type') {
    if (!m.memberKey) {
      // A bare type as a map entry can only be `any` standing for a whole
      // entry — not expressible; report instead of silently ignoring.
      return ctx.fail(
        path,
        map,
        m.node,
        'group entry without a member key cannot match a map entry'
      );
    }
    let count = 0;
    for (let i = 0; i < map.entries.length && count < m.occur.max; i++) {
      if (consumed[i]) continue;
      const [key, value] = map.entries[i]!;
      if (!keyMatches(m.memberKey, key, m.env, path, ctx, depth)) continue;
      const valuePath = [...path, keySeg(key, i)];
      if (matchType(value, m.type, m.env, valuePath, ctx, depth + 1)) {
        consumed[i] = true;
        count++;
        continue;
      }
      if (m.memberKey.cut) {
        // Cut: the key committed this entry to this member; a value
        // mismatch fails the whole map (§3.5.4).
        return ctx.fail(
          valuePath,
          value,
          m.node,
          `value for ${describeKey(m.memberKey)} does not match`
        );
      }
    }
    if (count < m.occur.min)
      return ctx.fail(
        path,
        map,
        m.node,
        `missing required entry ${describeKey(m.memberKey)}`
      );
    return mapSeq(map, entries, k + 1, consumed, env, path, ctx, depth, cont);
  }

  // Sub-group with an occurrence: backtrack over stop-vs-repeat and over
  // the sub-group's choices.
  ctx.checkDepth(depth);
  const consumedCount = (): number => {
    let n = 0;
    for (const c of consumed) if (c) n++;
    return n;
  };
  const tryIter = (iter: number): boolean => {
    ctx.step();
    if (
      iter >= m.occur.min &&
      mapSeq(map, entries, k + 1, consumed, env, path, ctx, depth, cont)
    )
      return true;
    if (iter >= m.occur.max) return false;
    const snapshot = consumed.slice();
    const before = consumedCount();
    for (const sub of m.choices) {
      if (
        mapSeq(
          map,
          sub.entries,
          0,
          consumed,
          sub.env,
          path,
          ctx,
          depth + 1,
          () => {
            if (consumedCount() === before)
              // An empty iteration makes no progress; repeating it cannot
              // help, so treat the occurrence as satisfied and move on.
              return mapSeq(
                map,
                entries,
                k + 1,
                consumed,
                env,
                path,
                ctx,
                depth,
                cont
              );
            return tryIter(iter + 1);
          }
        )
      )
        return true;
      for (let i = 0; i < consumed.length; i++) consumed[i] = snapshot[i]!;
    }
    return false;
  };
  return tryIter(0);
}

function keyMatches(
  mk: CddlMemberKey,
  key: CborItem,
  env: Env,
  path: readonly PathSeg[],
  ctx: Ctx,
  depth: number
): boolean {
  if (key instanceof CborEllipsis) return true;
  switch (mk.kind) {
    case 'bareword':
      return textValue(key) === mk.key;
    case 'value':
      return matchesLiteral(key, mk.key);
    case 'type1':
      return matchType1(key, mk.key, env, path, ctx, depth + 1);
  }
}

function describeKey(mk: CddlMemberKey): string {
  switch (mk.kind) {
    case 'bareword':
      return `'${mk.key}'`;
    case 'value':
      return mk.key.raw;
    case 'type1':
      return sourceText(mk.key.target);
  }
}

function keySeg(key: CborItem, index: number): PathSeg {
  const text = textValue(key);
  if (text !== undefined) return text;
  if (key instanceof CborUint || key instanceof CborNint) {
    const v = key.value;
    if (
      v >= BigInt(Number.MIN_SAFE_INTEGER) &&
      v <= BigInt(Number.MAX_SAFE_INTEGER)
    )
      return Number(v);
  }
  return index;
}

function describeItem(item: CborItem): string {
  const text = textValue(item);
  if (text !== undefined) return JSON.stringify(text);
  if (item instanceof CborUint || item instanceof CborNint)
    return item.value.toString();
  return item.constructor.name.replace(/^Cbor/, '').toLowerCase();
}

// ─── Control operator plumbing ────────────────────────────────────────────────

function makeControlDeps(env: Env, ctx: Ctx, depth: number): ControlDeps {
  return {
    matchType2: (item, t2, path) =>
      matchType2(item, t2, env, path, ctx, depth + 1),
    matchEmbedded: (item, t2, path) => {
      ctx.embeddedDepth++;
      try {
        return matchType2(item, t2, env, path, ctx, depth + 1);
      } finally {
        ctx.embeddedDepth--;
      }
    },
    resolveValue: (t2) => resolveValue(t2, env, ctx),
    existsIntGE: (t2, min) => existsIntGE(t2, min, env, ctx),
    matchesLiteral,
    fail: (path, item, node, message) => ctx.fail(path, item, node, message),
    warnOnce: (message, node) => ctx.warnOnce(message, node),
    features: ctx.features,
    uint: (n) => new CborUint(n),
  };
}
