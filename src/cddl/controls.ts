/**
 * Control operator implementations (RFC 8610 §3.8 plus RFC 9165 .plus /
 * .cat / .feature), table-driven and injected with the validator's matching
 * primitives to avoid an import cycle.
 *
 * Operators that are not in the table (.det, .abnf, .abnfb, the RFC 9741
 * text-conversion set, and anything unknown) are reported as a warning by
 * the validator, which then matches the target without the constraint.
 */

import type { CborItem } from '../ast/CborItem';
import { CborUint } from '../ast/CborUint';
import { CborFloat } from '../ast/CborFloat';
import { decodeCBOR } from '../cbor/decoder';
import { textValue, byteValue, intValueOf } from './equal';
import type { CddlNodeBase, CddlType2, CddlValue } from './ast';

type Path = readonly (string | number)[];

/** Matching primitives provided by the validator (closed over env/ctx). */
export interface ControlDeps {
  matchType2(item: CborItem, t2: CddlType2, path: Path): boolean;
  /** Like matchType2, but suppresses instance offsets in recorded errors —
   *  the item was decoded out of an embedded byte string, so its offsets
   *  are relative to the embedded bytes, not the outer document. */
  matchEmbedded(item: CborItem, t2: CddlType2, path: Path): boolean;
  resolveValue(t2: CddlType2): CddlValue | undefined;
  /** Whether some integer ≥ min matches the type; undefined = unanalyzable. */
  existsIntGE(t2: CddlType2, min: bigint): boolean | undefined;
  matchesLiteral(item: CborItem, v: CddlValue): boolean;
  fail(
    path: Path,
    item: CborItem | undefined,
    node: CddlNodeBase | undefined,
    message: string
  ): false;
  warnOnce(message: string, node?: CddlNodeBase): void;
  features: ReadonlySet<string>;
  uint(n: number | bigint): CborItem;
}

export type ControlHandler = (
  deps: ControlDeps,
  item: CborItem,
  target: CddlType2,
  controller: CddlType2,
  path: Path,
  node: CddlNodeBase
) => boolean;

const textEncoder = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** Synthesize a literal value for computed operators (.plus, .cat). */
const synthValue = (
  v:
    | { type: 'int'; value: number | bigint }
    | { type: 'float'; value: number }
    | { type: 'text'; value: string }
    | { type: 'bytes'; value: Uint8Array; qualifier: '' | 'h' | 'b64' }
): CddlValue =>
  ({ kind: 'value', raw: '', start: 0, end: 0, ...v }) as CddlValue;

const numericOf = (item: CborItem): bigint | number | undefined => {
  // Includes bignums (tags 2/3): CDDL values are abstract numbers.
  const int = intValueOf(item);
  if (int !== undefined) return int;
  if (item instanceof CborFloat) return item.value;
  return undefined;
};

const valueNumeric = (v: CddlValue): bigint | number | undefined =>
  v.type === 'int' || v.type === 'float' ? v.value : undefined;

/** Compare possibly-mixed bigint/number numerics: -1, 0, 1 (NaN → NaN). */
const cmp = (a: bigint | number, b: bigint | number): number => {
  if (typeof a === 'bigint' && typeof b === 'bigint')
    return a < b ? -1 : a > b ? 1 : 0;
  const an = Number(a);
  const bn = Number(b);
  return an < bn ? -1 : an > bn ? 1 : an === bn ? 0 : NaN;
};

// ─── RFC 8610 §3.8 ────────────────────────────────────────────────────────────

const size: ControlHandler = (deps, item, target, controller, path, node) => {
  if (!deps.matchType2(item, target, path)) return false;
  const checkSize = (n: number | bigint): boolean =>
    deps.matchType2(deps.uint(n), controller, path)
      ? true
      : deps.fail(
          path,
          item,
          node,
          `size ${n} does not match the .size constraint`
        );
  const text = textValue(item);
  if (text !== undefined) return checkSize(textEncoder.encode(text).length);
  const bytes = byteValue(item);
  if (bytes !== undefined) return checkSize(bytes.length);
  if (item instanceof CborUint) {
    // uint .size N means 0 ≤ value < 256^N (no upper limit on N): the value
    // fits iff the controller's integer set intersects [minBytes, ∞).
    let minBytes = 0;
    for (let v = item.value; v > 0n; v >>= 8n) minBytes++;
    const exists = deps.existsIntGE(controller, BigInt(minBytes));
    if (exists !== undefined)
      return exists
        ? true
        : deps.fail(
            path,
            item,
            node,
            `${item.value} does not fit the .size constraint`
          );
    // The controller could not be analyzed structurally (e.g. it uses a
    // control operator); fall back to a bounded search and say so.
    deps.warnOnce(
      '.size controller could not be analyzed; searching a bounded window of byte counts',
      node
    );
    for (let n = minBytes; n <= minBytes + 64; n++)
      if (deps.matchType2(deps.uint(n), controller, path)) return true;
    return deps.fail(
      path,
      item,
      node,
      `${item.value} does not fit the .size constraint`
    );
  }
  return deps.fail(
    path,
    item,
    node,
    '.size applies to strings and unsigned integers'
  );
};

const bits: ControlHandler = (deps, item, target, controller, path, node) => {
  if (!deps.matchType2(item, target, path)) return false;
  const positions: number[] = [];
  const bytes = byteValue(item);
  if (bytes !== undefined) {
    // Bit n of the string means (str[n >> 3] & (1 << (n & 7))) != 0 (§3.8.2).
    for (let i = 0; i < bytes.length; i++)
      for (let j = 0; j < 8; j++)
        if (bytes[i]! & (1 << j)) positions.push(i * 8 + j);
  } else if (item instanceof CborUint) {
    let v = item.value;
    for (let n = 0; v > 0n; n++, v >>= 1n) if (v & 1n) positions.push(n);
  } else {
    return deps.fail(
      path,
      item,
      node,
      '.bits applies to byte strings and unsigned integers'
    );
  }
  for (const n of positions)
    if (!deps.matchType2(deps.uint(n), controller, path))
      return deps.fail(
        path,
        item,
        node,
        `bit ${n} is set but not allowed by .bits`
      );
  return true;
};

const regexpCache = new Map<string, RegExp | null>();

const regexp: ControlHandler = (deps, item, target, controller, path, node) => {
  if (!deps.matchType2(item, target, path)) return false;
  const text = textValue(item);
  if (text === undefined)
    return deps.fail(path, item, node, '.regexp applies to text strings');
  const c = deps.resolveValue(controller);
  if (!c || c.type !== 'text') {
    deps.warnOnce(
      '.regexp controller does not resolve to a text string; not checked',
      node
    );
    return true;
  }
  // Approximation: the spec prescribes XSD regular expressions; we compile
  // the pattern as an anchored JavaScript RegExp with the 'u' flag, which
  // covers common patterns but differs in some character-class details.
  let re = regexpCache.get(c.value);
  if (re === undefined) {
    try {
      re = new RegExp(`^(?:${c.value})$`, 'u');
    } catch {
      re = null;
    }
    regexpCache.set(c.value, re);
  }
  if (re === null) {
    deps.warnOnce(
      `.regexp pattern is not a valid regular expression here: ${c.value}`,
      node
    );
    return true;
  }
  return re.test(text)
    ? true
    : deps.fail(
        path,
        item,
        node,
        `text does not match .regexp ${JSON.stringify(c.value)}`
      );
};

const makeCborControl =
  (seq: boolean): ControlHandler =>
  (deps, item, target, controller, path, node) => {
    if (!deps.matchType2(item, target, path)) return false;
    const bytes = byteValue(item);
    if (bytes === undefined)
      return deps.fail(
        path,
        item,
        node,
        `.cbor${seq ? 'seq' : ''} applies to byte strings`
      );
    let decoded: CborItem;
    try {
      if (seq) {
        // §3.8.4: wrap the sequence between 0x9f/0xff and decode as an
        // indefinite-length array.
        const wrapped = new Uint8Array(bytes.length + 2);
        wrapped[0] = 0x9f;
        wrapped.set(bytes, 1);
        wrapped[wrapped.length - 1] = 0xff;
        decoded = decodeCBOR(wrapped);
      } else {
        decoded = decodeCBOR(bytes);
      }
    } catch (e) {
      return deps.fail(
        path,
        item,
        node,
        `byte string does not contain valid CBOR: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return deps.matchEmbedded(decoded, controller, path)
      ? true
      : deps.fail(
          path,
          item,
          node,
          `embedded CBOR does not match the .cbor${seq ? 'seq' : ''} type`
        );
  };

const within: ControlHandler = (deps, item, target, controller, path, node) => {
  if (!deps.matchType2(item, target, path)) return false;
  return deps.matchType2(item, controller, path)
    ? true
    : deps.fail(
        path,
        item,
        node,
        'value does not match the .within/.and constraint'
      );
};

const makeCompare =
  (op: 'lt' | 'le' | 'gt' | 'ge'): ControlHandler =>
  (deps, item, target, controller, path, node) => {
    if (!deps.matchType2(item, target, path)) return false;
    const c = deps.resolveValue(controller);
    const bound = c && valueNumeric(c);
    if (bound === undefined) {
      deps.warnOnce(
        `.${op} controller does not resolve to a number; not checked`,
        node
      );
      return true;
    }
    const v = numericOf(item);
    if (v === undefined)
      return deps.fail(path, item, node, `.${op} applies to numbers`);
    const d = cmp(v, bound);
    const ok =
      op === 'lt' ? d < 0 : op === 'le' ? d <= 0 : op === 'gt' ? d > 0 : d >= 0;
    return ok
      ? true
      : deps.fail(path, item, node, `${v} does not satisfy .${op} ${bound}`);
  };

const eq: ControlHandler = (deps, item, target, controller, path, node) => {
  if (!deps.matchType2(item, target, path)) return false;
  const c = deps.resolveValue(controller);
  if (!c) {
    deps.warnOnce(
      '.eq controller does not resolve to a literal value; not checked',
      node
    );
    return true;
  }
  return deps.matchesLiteral(item, c)
    ? true
    : deps.fail(
        path,
        item,
        node,
        `value does not equal ${c.raw || '.eq controller'}`
      );
};

const ne: ControlHandler = (deps, item, target, controller, path, node) => {
  if (!deps.matchType2(item, target, path)) return false;
  const c = deps.resolveValue(controller);
  if (!c) {
    deps.warnOnce(
      '.ne controller does not resolve to a literal value; not checked',
      node
    );
    return true;
  }
  return deps.matchesLiteral(item, c)
    ? deps.fail(
        path,
        item,
        node,
        `value must not equal ${c.raw || '.ne controller'}`
      )
    : true;
};

const dflt: ControlHandler = (deps, item, target, controller, path, node) => {
  // .default is a variant of .ne: "the implied .ne control is there to
  // prevent this value from being sent over the wire" (RFC 8610 §3.8.6),
  // so the default value itself does not validate.
  if (!deps.matchType2(item, target, path)) return false;
  const c = deps.resolveValue(controller);
  if (!c) {
    deps.warnOnce(
      '.default controller does not resolve to a literal value; the implied .ne is not checked',
      node
    );
    return true;
  }
  return deps.matchesLiteral(item, c)
    ? deps.fail(
        path,
        item,
        node,
        `value equals the default ${c.raw || 'value'} (implied .ne, RFC 8610 §3.8.6)`
      )
    : true;
};

// ─── RFC 9165 ─────────────────────────────────────────────────────────────────

const plus: ControlHandler = (deps, item, target, controller, path, node) => {
  const t = deps.resolveValue(target);
  const c = deps.resolveValue(controller);
  const tv = t && valueNumeric(t);
  const cv = c && valueNumeric(c);
  if (t === undefined || tv === undefined || cv === undefined) {
    deps.warnOnce(
      '.plus operands do not resolve to numbers; not checked',
      node
    );
    return deps.fail(path, item, node, '.plus could not be computed');
  }
  // The sum is converted to the type of the target; float→int rounds
  // towards negative infinity (RFC 9165 §2.1).
  if (t!.type === 'float') {
    const sum = Number(tv) + Number(cv);
    return deps.matchesLiteral(item, synthValue({ type: 'float', value: sum }))
      ? true
      : deps.fail(path, item, node, `expected ${sum} (.plus)`);
  }
  const sum =
    typeof tv === 'bigint' && typeof cv === 'bigint'
      ? tv + cv
      : BigInt(Math.floor(Number(tv) + Number(cv)));
  return deps.matchesLiteral(item, synthValue({ type: 'int', value: sum }))
    ? true
    : deps.fail(path, item, node, `expected ${sum} (.plus)`);
};

const cat: ControlHandler = (deps, item, target, controller, path, node) => {
  const t = deps.resolveValue(target);
  const c = deps.resolveValue(controller);
  const toBytes = (v: CddlValue): Uint8Array | undefined =>
    v.type === 'text'
      ? textEncoder.encode(v.value)
      : v.type === 'bytes'
        ? v.value
        : undefined;
  const tb = t && toBytes(t);
  const cb = c && toBytes(c);
  if (!t || tb === undefined || cb === undefined) {
    deps.warnOnce('.cat operands do not resolve to strings; not checked', node);
    return deps.fail(path, item, node, '.cat could not be computed');
  }
  const joined = new Uint8Array(tb.length + cb.length);
  joined.set(tb, 0);
  joined.set(cb, tb.length);
  // The result has the type of the target (RFC 9165 §2.2).
  if (t.type === 'text') {
    let text: string;
    try {
      text = utf8Strict.decode(joined);
    } catch {
      return deps.fail(path, item, node, '.cat result is not valid UTF-8');
    }
    return deps.matchesLiteral(item, synthValue({ type: 'text', value: text }))
      ? true
      : deps.fail(path, item, node, `expected ${JSON.stringify(text)} (.cat)`);
  }
  return deps.matchesLiteral(
    item,
    synthValue({ type: 'bytes', value: joined, qualifier: 'h' })
  )
    ? true
    : deps.fail(path, item, node, 'byte string does not equal the .cat result');
};

/**
 * The .feature controller is a feature name, or an array whose first
 * element is the feature name and whose rest is detail (RFC 9165 §5).
 */
export const featureName = (
  deps: ControlDeps,
  controller: CddlType2
): string | undefined => {
  let t2 = controller;
  if (t2.kind === 'array') {
    const first = t2.group.choices[0]?.[0];
    if (
      !first ||
      first.kind !== 'entry' ||
      first.value.alternatives.length !== 1 ||
      first.value.alternatives[0]!.op
    )
      return undefined;
    t2 = first.value.alternatives[0]!.target;
  }
  const c = deps.resolveValue(t2);
  return c?.type === 'text' ? c.value : undefined;
};

const feature: ControlHandler = (
  deps,
  item,
  target,
  controller,
  path,
  node
) => {
  const name = featureName(deps, controller);
  if (name === undefined) {
    deps.warnOnce(
      '.feature controller does not resolve to a feature name',
      node
    );
    return deps.fail(path, item, node, 'unresolvable .feature');
  }
  if (!deps.features.has(name)) {
    deps.warnOnce(
      `feature "${name}" is not enabled (pass it in options.features to accept it)`,
      node
    );
    return deps.fail(path, item, node, `feature "${name}" is not enabled`);
  }
  return deps.matchType2(item, target, path);
};

// ─── Table ────────────────────────────────────────────────────────────────────

const CONTROLS: Record<string, ControlHandler> = {
  size,
  bits,
  regexp,
  cbor: makeCborControl(false),
  cborseq: makeCborControl(true),
  within,
  and: within,
  lt: makeCompare('lt'),
  le: makeCompare('le'),
  gt: makeCompare('gt'),
  ge: makeCompare('ge'),
  eq,
  ne,
  default: dflt,
  plus,
  cat,
  feature,
};

export function getControl(name: string): ControlHandler | undefined {
  return Object.prototype.hasOwnProperty.call(CONTROLS, name)
    ? CONTROLS[name]
    : undefined;
}
