/**
 * Schema-implied ("implicit") CBOR tags: a tag the CDDL schema itself
 * requires at some position — `time = #6.1(number)`, `tdate = #6.0(tstr)`,
 * any `#6.N(type)` with a literal tag number — carries no information a
 * JS value needs to spell out, so it can be left off in both directions:
 *
 * - `inferImplicitTags()` (`fromJS()`): a JS value converted without a
 *   `Tag.symbol` annotation becomes an untagged item; where validation
 *   fails only because such a type expected a tag, the missing tag is
 *   added (`FromJSOptions.implicitTags`).
 * - `markImplicitTags()` (after any successful `cddl` validation): flags
 *   each `CborTag` whose tag inference would restore exactly, so `toJS()`
 *   omits it (`ToJSOptions.implicitTags`).
 *
 * Inference is only ever a fallback. A tree that already validates is left
 * alone, and within inference every type/rule/map-group choice tries its
 * alternatives without inference first (`TagTracing.infer`), so a plain
 * number under `time / number` stays a plain number.
 *
 * Marking never *predicts* what inference would do: it runs inference on
 * the tree with the candidate tags stripped and keeps a candidate only if
 * exactly the stripped tags come back (see `markImplicitTags()`). Since
 * `fromJS()`'s own inference is the same deterministic procedure on the
 * same stripped tree, a `toJS()` → `fromJS()` round trip restores every
 * omitted tag, and never adds one that wasn't there.
 */

import type { CddlSchema } from './schema';
import {
  validateItem,
  type TagRecord,
  type ValidateOptions,
} from './validator';
import { CborItem } from '../ast/CborItem';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborTag } from '../ast/CborTag';
import { CborAppSeqResult } from '../ast/CborAppSeqResult';

/** Upper bound on `markImplicitTags()`'s candidate-narrowing rounds. */
const MAX_ROUNDS = 8;

/**
 * `item` with every tag the schema implies — but that the item lacks —
 * added via `makeTag`, when that is what makes it valid. Returns `item`
 * itself (unchanged) when it already validates, or when even inference
 * cannot make it valid (the caller's own validation then reports why).
 * Nodes are replaced in place inside their containers; the returned root
 * differs from `item` only when the root itself gets tagged.
 */
export function inferImplicitTags(
  schema: CddlSchema,
  item: CborItem,
  options: ValidateOptions | undefined,
  makeTag: (tag: bigint, inner: CborItem) => CborItem
): CborItem {
  if (validateItem(schema, item, options).valid) return item;
  const trail: TagRecord[] = [];
  if (!validateItem(schema, item, options, { infer: true, trail }).valid)
    return item;
  const wraps = inferredTagsByItem(trail);
  if (!wraps || wraps.size === 0) return item;
  return rewrite(item, wraps, makeTag);
}

/**
 * Flag (`CborTag._implicit`) every tag in `item` that the schema implies
 * and that `inferImplicitTags()` would restore exactly if it were left off;
 * clear the flag on every other tag. `trail` holds the records of the
 * caller's own successful validation of `item` (its candidates: every tag
 * matched by a literal `#6.N`).
 *
 * The candidate set shrinks until stripping it and inferring again yields
 * back exactly that set: a tag that isn't restored (another alternative
 * accepts the untagged content, the untagged tree already validates, …)
 * drops out, and dropping one can change what the rest infer, hence the
 * rounds. If inference would ever tag something that wasn't tagged, or
 * the rounds run out, nothing is flagged — omission is an optimization,
 * never worth a round trip that changes the data.
 */
export function markImplicitTags(
  schema: CddlSchema,
  item: CborItem,
  options: ValidateOptions | undefined,
  trail: readonly TagRecord[]
): void {
  clearMarks(item);
  let candidates = new Set<CborTag>();
  for (const r of trail)
    if (!r.inferred && isCandidate(r.item)) candidates.add(r.item);
  for (let round = 0; candidates.size > 0 && round < MAX_ROUNDS; round++) {
    const restored = restoredBy(schema, item, options, candidates);
    if (!restored) return;
    if (restored.size === candidates.size) {
      for (const tag of candidates) tag._implicit = true;
      return;
    }
    candidates = restored;
  }
}

/**
 * Which of `stripped` inference restores when they are all left off, or
 * `undefined` when it would also add a tag none of them accounts for.
 */
function restoredBy(
  schema: CddlSchema,
  item: CborItem,
  options: ValidateOptions | undefined,
  stripped: ReadonlySet<CborTag>
): Set<CborTag> | undefined {
  // Mirrors inferImplicitTags(): no inference when the stripped tree
  // already validates as it is.
  if (validateItem(schema, item, options, { stripped, trail: [] }).valid)
    return new Set();
  const trail: TagRecord[] = [];
  if (
    !validateItem(schema, item, options, { infer: true, stripped, trail }).valid
  )
    return new Set();
  // Inference records the item validation actually sees in place of a
  // stripped tag — the bottom of its run of directly nested stripped tags —
  // once per layer. A run is restored only if inference yields exactly its
  // tag numbers, in order.
  const chains = new Map<CborItem, CborTag[]>();
  for (const tag of stripped) {
    const chain = strippedRun(tag, stripped);
    const bottom = unwrapAppSeq(chain[chain.length - 1]!.content);
    // The run starting at its outermost tag is the longest one.
    if ((chains.get(bottom)?.length ?? 0) < chain.length)
      chains.set(bottom, chain);
  }
  const inferred = inferredTagsByItem(trail);
  if (!inferred) return undefined;
  const restored = new Set<CborTag>();
  for (const [inner, tags] of inferred) {
    const chain = chains.get(inner);
    // A tag on an item that wasn't stripped: fromJS() would add it.
    if (!chain) return undefined;
    if (
      chain.length === tags.length &&
      chain.every((t, i) => t.tag === tags[i])
    )
      for (const t of chain) restored.add(t);
  }
  return restored;
}

/**
 * `tag` and the stripped tags directly nested inside it, outermost first
 * (validation sees through all of them at once — see `viewItem()`).
 */
function strippedRun(tag: CborTag, stripped: ReadonlySet<CborTag>): CborTag[] {
  const run: CborTag[] = [];
  let node: CborItem = tag;
  while (node instanceof CborTag && stripped.has(node)) {
    run.push(node);
    node = unwrapAppSeq(node.content);
  }
  return run;
}

/**
 * Inferred tag numbers per untagged item, outermost first (by
 * `TagRecord.layer`); a layer checked more than once (`.and`, `.within`,
 * …) counts once. `undefined` when one layer got two different numbers,
 * or a layer is missing — no single tagging to apply.
 */
function inferredTagsByItem(
  trail: readonly TagRecord[]
): Map<CborItem, bigint[]> | undefined {
  const out = new Map<CborItem, bigint[]>();
  for (const r of trail) {
    if (!r.inferred) continue;
    let tags = out.get(r.item);
    if (!tags) out.set(r.item, (tags = []));
    const seen = tags[r.layer];
    if (seen === undefined) tags[r.layer] = r.tag;
    else if (seen !== r.tag) return undefined;
  }
  for (const tags of out.values())
    for (let i = 0; i < tags.length; i++)
      if (tags[i] === undefined) return undefined;
  return out;
}

/**
 * Only a tag whose `toJS()` is the generic tag-annotated conversion: a
 * bignum (`CborBigUint`/`CborBigNint`) converts to a plain `bigint`
 * already, and other subclasses convert to something of their own.
 */
function isCandidate(item: CborItem): item is CborTag {
  return item instanceof CborTag && item._toJS === CborTag.prototype._toJS;
}

function unwrapAppSeq(item: CborItem): CborItem {
  while (item instanceof CborAppSeqResult) item = item.inner;
  return item;
}

/** Reset `_implicit` on every tag reachable the way `toJS()` reaches it. */
function clearMarks(item: CborItem): void {
  forEachChild(item, clearMarks);
  if (item instanceof CborTag) item._implicit = false;
}

function forEachChild(item: CborItem, fn: (child: CborItem) => void): void {
  if (item instanceof CborArray) item.items.forEach(fn);
  else if (item instanceof CborMap)
    for (const [k, v] of item.entries) {
      fn(k);
      fn(v);
    }
  else if (item instanceof CborTag) fn(item.content);
  else if (item instanceof CborAppSeqResult) fn(item.inner);
}

/** Replace each node in `wraps` (bottom-up) by its tagged form. */
function rewrite(
  item: CborItem,
  wraps: ReadonlyMap<CborItem, readonly bigint[]>,
  makeTag: (tag: bigint, inner: CborItem) => CborItem
): CborItem {
  const visit = (node: CborItem): CborItem => {
    if (node instanceof CborArray) {
      const { items } = node;
      for (let i = 0; i < items.length; i++) items[i] = visit(items[i]!);
    } else if (node instanceof CborMap) {
      for (const entry of node.entries) {
        entry[0] = visit(entry[0]);
        entry[1] = visit(entry[1]);
      }
    } else if (node instanceof CborTag) {
      (node as { content: CborItem }).content = visit(node.content);
    }
    let out = node;
    const tags = wraps.get(node) ?? [];
    // Innermost (last) first.
    for (let i = tags.length - 1; i >= 0; i--) out = makeTag(tags[i]!, out);
    return out;
  };
  return visit(item);
}
