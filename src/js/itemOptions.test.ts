/**
 * Tests for `ToJSOptions.itemOptions` (per-node option overrides) and
 * `ToJSOptions.extensions` / `CborExtension.toJS()` (per-node conversion
 * override via extension swap), including their combination via `dt`/
 * `dt_as_Date`.
 */

import { describe, test, expect, vi } from 'vitest';
import { CBOR } from '../cbor';
import { dt, dt_as_Date } from '../extensions/dt';
import { Tag } from '../tag';
import { CborTag } from '../ast/CborTag';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborUint } from '../ast/CborUint';
import { CborTextString } from '../ast/CborTextString';
import type { ItemContext, ToJSNodeOptions } from '../types';
import type { CborItem } from '../ast/CborItem';
import type { CborExtension } from '../extensions/types';

describe('itemOptions — basic dispatch', () => {
  test('unset itemOptions leaves toJS() output unchanged', () => {
    const item = CBOR.fromCDN('{"a": 1, "b": [2, 3]}');
    expect(item.toJS()).toEqual({ a: 1, b: [2, 3] });
  });

  test('itemOptions returning undefined for every node changes nothing', () => {
    const item = CBOR.fromCDN('{"a": 1, "b": [2, 3]}');
    const spy = vi.fn(() => undefined);
    expect(item.toJS({ itemOptions: spy })).toEqual({ a: 1, b: [2, 3] });
    expect(spy).toHaveBeenCalled();
  });

  test('overriding integerAs for one array element only', () => {
    const item = CBOR.fromCDN('[1, 2, 3]');
    const js = item.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 1
          ? { integerAs: 'bigint' }
          : undefined,
    }) as unknown[];
    expect(js).toEqual([1, 2n, 3]);
  });

  test('overriding a nested map value by path', () => {
    const item = CBOR.fromCDN('{"outer": {"inner": 1}}');
    const js = item.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path.length === 2 &&
        ctx.path[0] === 'outer' &&
        ctx.path[1] === 'inner'
          ? { integerAs: 'bigint' }
          : undefined,
    }) as { outer: { inner: unknown } };
    expect(js.outer.inner).toBe(1n);
  });

  test('override cascades to descendants unless re-overridden', () => {
    const item = CBOR.fromCDN('{"a": [1, 2]}');
    const js = item.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 'a' ? { integerAs: 'bigint' } : undefined,
    }) as { a: unknown[] };
    // Both elements of "a" inherit the override from their parent.
    expect(js.a).toEqual([1n, 2n]);
  });

  test('root itself can be targeted (empty path)', () => {
    const item = CBOR.fromCDN('1');
    const js = item.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path.length === 0 ? { integerAs: 'bigint' } : undefined,
    });
    expect(js).toBe(1n);
  });

  test('ctx.parent is the immediate container', () => {
    const item = CBOR.fromCDN('[1]');
    let seenParent: CborItem | undefined;
    item.toJS({
      itemOptions: (_node, ctx) => {
        if (ctx.path.length === 1) seenParent = ctx.parent;
        return undefined;
      },
    });
    expect(seenParent).toBe(item);
  });

  test('tag/app-sequence wrappers do not add a path segment', () => {
    // DT'...' is a CborTag (tag 1) wrapping an epoch value; its content
    // must be visited at the *same* path as the tag itself.
    const item = CBOR.fromCDN('{"d": DT\'2023-01-01T00:00:00Z\'}', {
      extensions: [dt],
    });
    const paths: unknown[][] = [];
    item.toJS({
      itemOptions: (_node, ctx) => {
        paths.push([...ctx.path]);
        return undefined;
      },
    });
    // Every visited node under "d" (the tag and its numeric content) shares
    // the same one-segment path — no extra segment for the tag wrapper.
    const dPaths = paths.filter((p) => p.length >= 1 && p[0] === 'd');
    expect(dPaths.length).toBeGreaterThan(0);
    for (const p of dPaths) expect(p).toEqual(['d']);
  });

  test('tag content inherits the wrapper key, matching ctx.key === path.at(-1)', () => {
    // {"d": 100(0)}: tag 100 has no built-in extension, so it stays a plain
    // CborTag wrapping a CborUint content node. The tag and its content
    // share path ['d']; per ItemContext.key's documented invariant, ctx.key
    // must equal the last path element at both the tag itself and its
    // content.
    const item = CBOR.fromCDN('{"d": 100(0)}');
    const calls: { path: unknown[]; key: unknown; isTag: boolean }[] = [];
    item.toJS({
      itemOptions: (node, ctx) => {
        calls.push({
          path: [...ctx.path],
          key: ctx.key,
          isTag: node instanceof CborTag,
        });
        return undefined;
      },
    });
    const dCalls = calls.filter(
      (c) => c.path.length === 1 && c.path[0] === 'd'
    );
    // Both the tag and its wrapped content were visited under "d" ...
    expect(dCalls.some((c) => c.isTag)).toBe(true);
    expect(dCalls.some((c) => !c.isTag)).toBe(true);
    // ... and every one of them reports key === 'd', not undefined.
    for (const c of dCalls) expect(c.key).toBe('d');
  });

  test('array index vs. map key at the same numeric path segment', () => {
    const item = CBOR.fromCDN('{0: "mapped", "arr": [9]}');
    // Distinguish via ctx.parent's constructor rather than the path value,
    // since a map key `0` and an array index `0` both appear as `0` in path.
    const seen: { path: unknown[]; parentIsArray: boolean }[] = [];
    item.toJS({
      mapAs: 'entries',
      itemOptions: (_node, ctx) => {
        seen.push({
          path: [...ctx.path],
          parentIsArray: ctx.parent?.constructor.name === 'CborArray',
        });
        return undefined;
      },
    });
    const arrHit = seen.find(
      (s) => s.parentIsArray && s.path[s.path.length - 1] === 0
    );
    expect(arrHit).toBeDefined();
  });
});

describe('itemOptions — ctx.options', () => {
  test('reflects the root options at the top level', () => {
    const item = CBOR.fromCDN('1');
    let seenIntegerAs: unknown;
    item.toJS({
      integerAs: 'bigint',
      itemOptions: (_node, ctx) => {
        seenIntegerAs = ctx.options.integerAs;
        return undefined;
      },
    });
    expect(seenIntegerAs).toBe('bigint');
  });

  test('reflects an ancestor override, not the original root options', () => {
    const item = CBOR.fromCDN('{"a": {"b": 1}}');
    const seen: { path: unknown[]; integerAs: unknown }[] = [];
    item.toJS({
      itemOptions: (_node, ctx) => {
        seen.push({ path: [...ctx.path], integerAs: ctx.options.integerAs });
        return ctx.path[0] === 'a' ? { integerAs: 'bigint' } : undefined;
      },
    });
    const aInner = seen.find(
      (s) => s.path.length === 2 && s.path[0] === 'a' && s.path[1] === 'b'
    );
    // "b" is a descendant of "a", so it sees "a"'s override already merged
    // in, not the (unset) top-level default.
    expect(aInner?.integerAs).toBe('bigint');
    const outer = seen.find((s) => s.path.length === 0);
    expect(outer?.integerAs).toBeUndefined();
  });

  test('lets a callback add to, rather than replace, the current extensions list', () => {
    // A no-op extension already configured at the top level, plus
    // dt_as_Date appended per-node via ctx.options — the override must
    // preserve the pre-existing entry, not just install its own.
    const noop: CborExtension = { toJS: () => undefined };
    let seenExtensions: readonly CborExtension[] | undefined;

    const item = CBOR.fromCDN("DT'2023-01-01T00:00:00Z'", { extensions: [dt] });
    const value = item.toJS({
      extensions: [noop],
      itemOptions: (_node, ctx) => {
        seenExtensions = ctx.options.extensions;
        return {
          extensions: [...(ctx.options.extensions ?? []), dt_as_Date],
        };
      },
    });

    expect(seenExtensions).toEqual([noop]);
    expect(value).toBeInstanceOf(Date);
  });

  test('does not carry a reviver', () => {
    const item = CBOR.fromCDN('1');
    let hasReviver: unknown;
    item.toJS({
      itemOptions: (_node, ctx) => {
        hasReviver = 'reviver' in ctx.options;
        return undefined;
      },
      reviver: (_key, value) => value,
    });
    expect(hasReviver).toBe(false);
  });

  test('is a fresh snapshot per call, not shared with a later resolution', () => {
    // A stateful callback mutating what it reads must not corrupt what a
    // later, independent call (a different occurrence, or the same
    // occurrence resolved again via a distinct raw/real pass) observes.
    const item = CBOR.fromCDN('[1, 2]');
    const seen: unknown[] = [];
    item.toJS({
      itemOptions: (_node, ctx) => {
        seen.push(ctx.options.integerAs);
        // Mutating the returned snapshot must not leak anywhere else.
        (ctx.options as { integerAs?: string }).integerAs = 'bigint';
        return undefined;
      },
    });
    expect(seen).toEqual([undefined, undefined, undefined]);
  });

  test('mutating ctx.options.extensions in place does not corrupt siblings, the caller, or a later occurrence', () => {
    // A stray CborExtension pushed onto ctx.options.extensions while
    // resolving one element must not leak into a sibling's own resolution
    // (which would let a hook resolve nodes it was never actually
    // configured to see, e.g. turning [1, 2] into ['hooked', 'hooked']),
    // nor mutate the array reference the caller itself passed in.
    const hookedExtension: CborExtension = {
      toJS: (item) =>
        item instanceof CborUint ? { value: 'hooked' } : undefined,
    };
    const callerExtensions: CborExtension[] = [];
    const item = CBOR.fromCDN('[1, 2]');

    const result = item.toJS({
      extensions: callerExtensions,
      itemOptions: (_node, ctx) => {
        // Bypasses the readonly type — simulating a careless caller, or one
        // not using TypeScript at all — to exercise the runtime defense
        // directly, not just the type-level one.
        (ctx.options.extensions as CborExtension[] | undefined)?.push(
          hookedExtension
        );
        return undefined;
      },
    });

    expect(result).toEqual([1, 2]);
    expect(callerExtensions).toEqual([]);
  });
});

describe('CborExtension.toJS() — options.extensions is copy-safe', () => {
  test('mutating options.extensions inside a hook does not corrupt a sibling resolution', () => {
    const hookedExtension: CborExtension = {
      toJS: (item) =>
        item instanceof CborUint ? { value: 'hooked' } : undefined,
    };
    const mutatingExtension: CborExtension = {
      toJS: (_item, options) => {
        (options.extensions as CborExtension[] | undefined)?.push(
          hookedExtension
        );
        return undefined; // declines — falls through to the default value
      },
    };
    const callerExtensions = [mutatingExtension];
    const item = CBOR.fromCDN('[1, 2]');

    const result = item.toJS({ extensions: callerExtensions });

    expect(result).toEqual([1, 2]);
    expect(callerExtensions).toEqual([mutatingExtension]);
  });

  test('mutating options.extensions in one hook does not leak to a later hook resolving the same node', () => {
    // Both hooks are tried, in order, against the *same* node — a single,
    // shared `hookOptions` snapshot across that whole loop (rather than a
    // fresh one per hook) would let the first hook's mutation be observed
    // by the second, even though neither ever left this one node's own
    // resolution.
    const marker: CborExtension = { toJS: () => undefined };
    const calls: string[] = [];
    let sawLeakedMarker = false;
    const firstHook: CborExtension = {
      toJS: (_item, options) => {
        calls.push('first');
        (options.extensions as CborExtension[] | undefined)?.push(marker);
        return undefined; // declines — the loop moves on to secondHook
      },
    };
    const secondHook: CborExtension = {
      toJS: (_item, options) => {
        calls.push('second');
        if (options.extensions?.includes(marker)) sawLeakedMarker = true;
        return undefined;
      },
    };

    CBOR.fromCDN('1').toJS({ extensions: [firstHook, secondHook] });

    expect(calls).toEqual(['first', 'second']);
    expect(sawLeakedMarker).toBe(false);
  });
});

describe('itemOptions — map keys (mapAs: entries)', () => {
  test('isMapKey is set when converting a key node, path unchanged', () => {
    const item = CBOR.fromCDN('{"k": 1}');
    const calls: ItemContext[] = [];
    item.toJS({
      mapAs: 'entries',
      itemOptions: (_node, ctx) => {
        calls.push({ ...ctx, path: [...ctx.path] });
        return undefined;
      },
    });
    const keyCall = calls.find((c) => c.isMapKey);
    expect(keyCall).toBeDefined();
    expect(keyCall!.path).toEqual([]);
  });

  test('object-mode (mapAs auto/object) never invokes itemOptions for the key itself', () => {
    const item = CBOR.fromCDN('{"k": 1}');
    const calls: ItemContext[] = [];
    item.toJS({
      itemOptions: (_node, ctx) => {
        calls.push({ ...ctx, path: [...ctx.path] });
        return undefined;
      },
    });
    expect(calls.some((c) => c.isMapKey)).toBe(false);
  });
});

describe('itemOptions — reviver interaction', () => {
  test('itemOptions still applies once per visit under a reviver', () => {
    const item = CBOR.fromCDN('[1, 2]');
    const js = item.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 1 ? { integerAs: 'bigint' } : undefined,
      reviver(_key, value) {
        return value;
      },
    });
    expect(js).toEqual([1, 2n]);
  });

  test('a reviver-driven raw scaffolding pass makes itemOptions run twice per element, once per reviver state', () => {
    // CborArray converts each element twice when a reviver is present: once
    // (reviver stripped) to pre-populate a holder a reviver can inspect via
    // `this[j]` for a not-yet-processed sibling j, and once more (reviver
    // intact) to compute the real, returned value. itemOptions/extensions
    // must run once per *occurrence*, but that "once" is now scoped to each
    // of those two reviver states separately (see the next test for why:
    // the scaffolding pass's value must itself reflect itemOptions/
    // extensions, since it is observable, not just internal bookkeeping) —
    // so a node under this split is offered to itemOptions/extensions up
    // to twice, not once.
    const item = CBOR.fromCDN('[1, 2]');
    const spy = vi.fn(() => undefined);

    item.toJS({ itemOptions: spy });
    // No reviver: a single pass, so root + 2 elements = 3.
    expect(spy).toHaveBeenCalledTimes(3);

    spy.mockClear();
    item.toJS({
      itemOptions: spy,
      reviver: (_key, value) => value, // identity reviver
    });
    // With a reviver: root is visited once (nothing above it forces a
    // raw/revived split on it), but each of the 2 elements sits inside
    // CborArray's own split and is offered once per reviver state — 1 + 2*2.
    expect(spy).toHaveBeenCalledTimes(5);
  });

  test('the raw scaffolding value seen by an earlier sibling reflects itemOptions overrides', () => {
    // The reviewer's exact reproduction: overriding integerAs for index 1
    // only must be visible to index 0's own reviver call via `this[1]`
    // (index 1 hasn't been "really" processed yet at that point — it's
    // still showing the raw scaffolding pass's value) — matching what a
    // plain top-level `integerAs: 'bigint'` would have produced, not the
    // default `'auto'` typing.
    const item = CBOR.fromCDN('[0, 1]');
    const seenTypeOfSibling: unknown[] = [];

    const js = item.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 1 ? { integerAs: 'bigint' } : undefined,
      reviver(key, value) {
        if (key === '0') seenTypeOfSibling.push(typeof (this as unknown[])[1]);
        return value;
      },
    });

    expect(js).toEqual([0, 1n]);
    expect(seenTypeOfSibling).toEqual(['bigint']);
  });

  test('the raw scaffolding value reflects itemOptions overrides in an object-mode map too', () => {
    const item = CBOR.fromCDN('{"a": 0, "b": 1}');
    const seenTypeOfSibling: unknown[] = [];

    const js = item.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 'b' ? { integerAs: 'bigint' } : undefined,
      reviver(key, value) {
        if (key === 'a')
          seenTypeOfSibling.push(typeof (this as Record<string, unknown>).b);
        return value;
      },
    });

    expect(js).toEqual({ a: 0, b: 1n });
    expect(seenTypeOfSibling).toEqual(['bigint']);
  });

  test('the raw scaffolding value reflects an extension conversion (e.g. dt_as_Date) too', () => {
    // `dt` (number output) is already the default builtin, so parsing needs
    // no extra option; `extensions: [dt_as_Date]` below reinterprets the
    // parsed tag as a Date for toJS() only — see the "itemOptions +
    // extensions" tests above.
    const item = CBOR.fromCDN(`["marker", DT'2023-01-01T00:00:00Z']`);
    const seenSibling: unknown[] = [];

    const js = item.toJS({
      extensions: [dt_as_Date],
      reviver(key, value) {
        if (key === '0')
          seenSibling.push((this as unknown[])[1] instanceof Date);
        return value;
      },
    }) as [string, Date];

    expect(js[1]).toBeInstanceOf(Date);
    expect(seenSibling).toEqual([true]);
  });

  test('a stateful itemOptions callback still produces the same result with or without an identity reviver', () => {
    // Call *count* is no longer preserved by adding a reviver (see the
    // "raw scaffolding pass" test above), but the *result* still is — a
    // deterministic callback resolves each (occurrence, reviver-state)
    // combination independently and consistently.
    const item = CBOR.fromCDN('[1, 2, 3]');
    let counter = 0;
    const itemOptions = () => {
      counter++;
      return undefined;
    };

    const resultWithoutReviver = item.toJS({ itemOptions });
    const countWithoutReviver = counter;
    counter = 0;
    const resultWithReviver = item.toJS({
      itemOptions,
      reviver: (_key, value) => value,
    });

    expect(resultWithReviver).toEqual(resultWithoutReviver);
    // Root + 3 elements without a reviver; with one, root is unaffected
    // (nothing above it splits) but each element is offered twice.
    expect(countWithoutReviver).toBe(4);
    expect(counter).toBe(7);
  });

  test('extension toJS() hook runs once per reviver state under a reviver', () => {
    const item = CBOR.fromCDN(
      `{"a": DT'2023-01-01T00:00:00Z', "b": DT'2024-01-01T00:00:00Z'}`,
      { extensions: [dt] }
    );
    const hookSpy = vi.fn(dt_as_Date.toJS!.bind(dt_as_Date));
    const spiedExtension = { ...dt_as_Date, toJS: hookSpy };

    const value = item.toJS({
      extensions: [spiedExtension],
      reviver: (_key, value) => value,
    }) as { a: unknown; b: unknown };

    expect(value.a).toBeInstanceOf(Date);
    expect(value.b).toBeInstanceOf(Date);
    // Root (declines, visited once — nothing splits it) + "a" and "b" each
    // offered once per reviver state (object-mode map values sit inside
    // CborMap.toObject's own raw/revived split) — 1 + 2*2.
    expect(hookSpy).toHaveBeenCalledTimes(5);
  });

  test('object-mode map value dispatch runs once per reviver state under a reviver', () => {
    const item = CBOR.fromCDN('{"a": 1, "b": 2}');
    const spy = vi.fn(() => undefined);

    item.toJS({ itemOptions: spy, reviver: (_key, value) => value });
    // Root (1, unaffected) + "a" and "b" each offered once per reviver
    // state (1 + 2*2) — object-mode keys never reach itemOptions
    // themselves either way (see the "map keys" describe block above).
    expect(spy).toHaveBeenCalledTimes(5);
  });
});

describe('ToJSOptions.extensions — CborExtension.toJS() hook', () => {
  test('unset extensions leaves default dt-parsed output as number', () => {
    const item = CBOR.fromCDN("DT'2023-01-01T00:00:00Z'", { extensions: [dt] });
    // Not stripTags, so the number is tag-wrapped for round-tripping — same
    // as CborTag's own default `_toJS()` — but it is not a Date.
    expect(item.toJS()).not.toBeInstanceOf(Date);
    expect(Tag.getValue(item.toJS())).toBe(1672531200);
  });

  test('extensions: [dt_as_Date] reinterprets a dt-parsed tree as Date, globally', () => {
    const item = CBOR.fromCDN(
      '{"a": DT\'2023-01-01T00:00:00Z\', "b": DT\'2024-01-01T00:00:00Z\'}',
      { extensions: [dt] }
    );
    const js = item.toJS({ extensions: [dt_as_Date] }) as {
      a: unknown;
      b: unknown;
    };
    expect(js.a).toBeInstanceOf(Date);
    expect(js.b).toBeInstanceOf(Date);
    expect((js.a as Date).toISOString()).toBe('2023-01-01T00:00:00.000Z');
  });

  test('extensions: [dt] reinterprets a dt_as_Date-parsed tree as number, globally', () => {
    const item = CBOR.fromCDN("DT'2023-01-01T00:00:00Z'", {
      extensions: [dt_as_Date],
    });
    expect(item.toJS()).toBeInstanceOf(Date);
    const asNumber = item.toJS({ extensions: [dt] });
    expect(asNumber).not.toBeInstanceOf(Date);
    expect(Tag.getValue(asNumber)).toBe(
      Math.floor(new Date('2023-01-01T00:00:00Z').getTime() / 1000)
    );
  });

  test('stripTags is honoured by the number-mode dt toJS hook', () => {
    const item = CBOR.fromCDN("DT'2023-01-01T00:00:00Z'", {
      extensions: [dt_as_Date],
    });
    const js = item.toJS({ extensions: [dt], stripTags: true });
    expect(typeof js).toBe('number');
    // Without stripTags the numeric value is wrapped for Tag round-tripping,
    // so equality against a bare primitive would fail; with stripTags it's
    // a bare, unwrapped number.
    expect(Object.getOwnPropertySymbols(js as object).length).toBe(0);
  });

  test('a non-matching node is left to its own default conversion', () => {
    const item = CBOR.fromCDN('42');
    expect(item.toJS({ extensions: [dt_as_Date] })).toBe(42);
  });
});

describe('itemOptions + extensions — the motivating example', () => {
  test('partial override: only date1 becomes a Date, date2 stays a number', () => {
    const item = CBOR.fromCDN(
      '{"date1": DT\'2026-08-23T00:00:00Z\', "date2": DT\'2026-08-23T00:00:00Z\'}',
      { extensions: [dt] }
    );
    const js = item.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 'date1'
          ? { extensions: [dt_as_Date] }
          : undefined,
    }) as { date1: unknown; date2: unknown };

    expect(js.date1).toBeInstanceOf(Date);
    expect(js.date2).not.toBeInstanceOf(Date);
    expect(Tag.getValue(js.date2)).toBe(
      Math.floor(new Date('2026-08-23T00:00:00Z').getTime() / 1000)
    );
    expect((js.date1 as Date).toISOString()).toBe('2026-08-23T00:00:00.000Z');
  });
});

describe('itemOptions — a node shared across multiple occurrences', () => {
  // fromCDN()/fromCBOR() never produce a shared node instance, but a
  // hand-built AST can reuse the same CborItem at more than one position.
  function sharedArray() {
    const shared = new CborUint(1n);
    return { root: new CborArray([shared, shared]), shared };
  }

  test('a shared node resolves once per occurrence, not once per node', () => {
    const { root } = sharedArray();
    const calls: unknown[] = [];
    root.toJS({
      itemOptions: (_node, ctx) => {
        calls.push([...ctx.path]);
        return undefined;
      },
    });
    // Root + two distinct occurrences of the shared node = 3 visits, not 2
    // (one per occurrence would be collapsed into a single cache entry if
    // the cache only kept the most recent path per node).
    expect(calls).toEqual([[], [0], [1]]);
  });

  test('each occurrence keeps its own override, independent of the other', () => {
    const { root } = sharedArray();
    const js = root.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 1 ? { integerAs: 'bigint' } : undefined,
    });
    expect(js).toEqual([1, 1n]);
  });

  test('adding an identity reviver does not change the result', () => {
    const { root: withoutReviver } = sharedArray();
    const { root: withReviver } = sharedArray();
    const itemOptions = (_node: CborItem, ctx: ItemContext) =>
      ctx.path[0] === 1 ? ({ integerAs: 'bigint' } as const) : undefined;

    const resultWithout = withoutReviver.toJS({ itemOptions });
    const resultWith = withReviver.toJS({
      itemOptions,
      reviver: (_key, value) => value,
    });

    expect(resultWith).toEqual(resultWithout);
    expect(resultWith).toEqual([1, 1n]);
  });

  test('each occurrence resolves once per reviver state when a reviver doubles visits', () => {
    const { root } = sharedArray();
    const spy = vi.fn(() => undefined);
    root.toJS({ itemOptions: spy, reviver: (_key, value) => value });
    // Root (1, unaffected) + 2 occurrences, each offered once per reviver
    // state via CborArray's own raw/revived double pass — 1 + 2*2.
    expect(spy).toHaveBeenCalledTimes(5);
  });

  test('descendants of a shared container are distinguished by occurrence, not just by their immediate parent', () => {
    // A shared *container* (not just a shared leaf): `shared`'s own two
    // occurrences (root[0] and root[1]) are already distinguishable by
    // {immediate parent: root, slot: 0 or 1} alone — but `leaf`, reached
    // through `shared` both times, would resolve to the identical
    // {immediate parent: shared, slot: 0} at both occurrences if matching
    // only considered the immediate container, wrongly conflating them.
    const leaf = new CborUint(1n);
    const shared = new CborArray([leaf]);
    const root = new CborArray([shared, shared]);

    const js = root.toJS({
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 1 ? { integerAs: 'bigint' } : undefined,
    });

    expect(js).toEqual([[1], [1n]]);
  });

  test('the same shared-container scenario resolves leaf once per distinct pass context', () => {
    const leaf = new CborUint(1n);
    const shared = new CborArray([leaf]);
    const root = new CborArray([shared, shared]);

    const leafCalls: string[] = [];
    root.toJS({
      itemOptions: (node, ctx) => {
        if (node === leaf) leafCalls.push(JSON.stringify(ctx.path));
        return undefined;
      },
      reviver: (_key, value) => value,
    });

    // For each of shared's two occurrences (index 0 and index 1 of root),
    // leaf is reached through three distinct contexts, not two: root's own
    // raw pass (shared itself sees no reviver there, so it converts leaf in
    // a single, unsplit pass); root's real pass reaching shared, which
    // *does* see a reviver there and so forks its own raw sub-pass over
    // leaf; and that same real-pass path's real sub-pass, the one whose
    // result is what's actually kept. 3 contexts * 2 occurrences = 6.
    expect(leafCalls).toHaveLength(6);
    const counts = new Map<string, number>();
    for (const p of leafCalls) counts.set(p, (counts.get(p) ?? 0) + 1);
    expect(counts).toEqual(
      new Map([
        ['[0,0]', 3],
        ['[1,0]', 3],
      ])
    );
  });

  test('duplicate map keys sharing a value node resolve independently via keyNode', () => {
    const k1 = new CborTextString('a');
    const k2 = new CborTextString('a'); // same JS key value, distinct node
    const sharedValue = new CborUint(1n);
    const root = new CborMap([
      [k1, sharedValue],
      [k2, sharedValue],
    ]);

    const calls: { path: unknown[]; keyNode: CborItem | undefined }[] = [];
    root.toJS({
      mapAs: 'entries',
      itemOptions: (node, ctx) => {
        // Only the two occurrences of sharedValue itself — not the root map
        // or either key node's own conversion.
        if (node instanceof CborUint) {
          calls.push({ path: [...ctx.path], keyNode: ctx.keyNode });
        }
        return undefined;
      },
    });

    // Both entries share path ["a"] (path is derived from the key's JS
    // value, not its node identity or position — see ItemContext.path) but
    // are still resolved as two independent occurrences, disambiguated by
    // their distinct keyNode.
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toEqual(['a']);
    expect(calls[1].path).toEqual(['a']);
    expect(calls[0].keyNode).toBe(k1);
    expect(calls[1].keyNode).toBe(k2);
  });

  test('a composite map key does not defeat occurrence matching under a reviver', () => {
    // The key [1] converts to a *new* array object every time its JS value
    // is computed — path's last segment for the value "2" is therefore a
    // different array reference each time it's derived, even though it's
    // always the same logical position. Occurrence matching must not rely
    // on that reference staying stable.
    const item = CBOR.fromCDN('[{[1]: 2}]');
    const spy = vi.fn(() => undefined);

    const result = item.toJS({
      mapAs: 'entries',
      itemOptions: spy,
      reviver: (_key, value) => value, // identity reviver
    });

    expect(result).toEqual([[[[1], 2]]]);
    // root: 1 (nothing above it splits it).
    // map: 2 (root's raw pass, where the map itself sees no reviver and so
    //   doesn't fork further; root's real pass, reaching it).
    // value "2" (a leaf, so it never forks itself): 2, one per map visit.
    // key array [1]: 2, one per map visit — but reached via root's real
    //   pass, it *does* see a reviver (mapAs: 'entries' has no internal
    //   split of its own, so the map simply passes reviver through), so it
    //   forks its own raw/real sub-pass over its one element.
    // that element ("1"): 3 — once via root's raw pass (key array doesn't
    //   fork there), plus once per key array's own raw/real sub-pass.
    // 1 + 2 + 2 + 2 + 3 = 10.
    expect(spy).toHaveBeenCalledTimes(10);
  });

  test('the value path reflects the fully-revived key, whether or not the map is nested', () => {
    // The reviver rewrites the composite key's own content (1 -> 9) — so
    // itemOptions, run once per occurrence, must see the *final* revived
    // key ([9]) when computing the value's path, not whatever the key
    // happened to look like the first time this occurrence was resolved.
    // In particular this must hold the same way whether the map converts
    // in a single pass (bare root) or is itself revisited as part of an
    // outer container's own raw/revived double pass (nested in an array).
    const reviver = (_key: unknown, value: unknown) =>
      value === 1 ? 9 : value;
    const itemOptions = (_node: CborItem, ctx: ItemContext) =>
      JSON.stringify(ctx.path[ctx.path.length - 1]) === JSON.stringify([9])
        ? { integerAs: 'bigint' as const }
        : undefined;

    const bareRoot = CBOR.fromCDN('{[1]: 2}');
    const bareResult = bareRoot.toJS({
      mapAs: 'entries',
      itemOptions,
      reviver,
    });
    expect(bareResult).toEqual([[[9], 2n]]);

    const nested = CBOR.fromCDN('[{[1]: 2}]');
    const nestedResult = nested.toJS({
      mapAs: 'entries',
      itemOptions,
      reviver,
    });
    expect(nestedResult).toEqual([[[[9], 2n]]]);
  });

  test('a raw sub-pass nested inside a real pass sees the already-revived key, not the outer raw pass', () => {
    // The reviewer's exact reproduction: `[{[1]: [0, 2]}]`, with a reviver
    // that both rewrites the composite key (1 -> 9) and is watched from
    // inside the inner array's own reviver calls. Three distinct contexts
    // reach the inner array's elements for one and the same occurrence:
    //   1. the outer array's own raw pass (key still unrevived, [1])
    //   2. the outer array's real pass -> inner array's own raw sub-pass
    //      (key *already* revived to [9] by this point, since the map's
    //      key conversion happens before the value's)
    //   3. that same real-pass path's real sub-pass (the kept result)
    // Context 2 is the one whose raw scaffolding is actually observable,
    // via `this[1]` inside the inner array's own reviver call for index 0
    // — and it must reflect the itemOptions override computed against the
    // *revived* key ([9]), matching context 3's own result, not context
    // 1's stale, pre-revival one.
    const item = CBOR.fromCDN('[{[1]: [0, 2]}]');
    const seenTypeOfSibling: unknown[] = [];

    const itemOptions = (_node: CborItem, ctx: ItemContext) => {
      const last2 = ctx.path.slice(-2);
      return JSON.stringify(last2[0]) === JSON.stringify([9]) && last2[1] === 1
        ? ({ integerAs: 'bigint' } as const)
        : undefined;
    };

    const result = item.toJS({
      mapAs: 'entries',
      itemOptions,
      reviver(key, value) {
        if (value === 1) return 9; // revives the composite key's own "1"
        // Identify "index 0 of the inner [0, 2] array" by its value (0),
        // not by key === '0' alone — the outer array's own single element
        // (the map) is also revived with key '0'.
        if (key === '0' && value === 0)
          seenTypeOfSibling.push(typeof (this as unknown[])[1]);
        return value;
      },
    });

    expect(result).toEqual([[[[9], [0, 2n]]]]);
    expect(seenTypeOfSibling).toEqual(['bigint']);
  });

  test('duplicate map entries sharing both key and value nodes still resolve independently', () => {
    // The reverse of the keyNode-disambiguation case above: here *both* the
    // key and the value node are the exact same shared instances across two
    // entries, so parent/keyNode/isMapKey/path could never tell them apart
    // — only their distinct entry ordinal (index 0 vs 1) can.
    const k = new CborTextString('a');
    const v = new CborUint(1n);
    const root = new CborMap([
      [k, v],
      [k, v],
    ]);

    const valueCalls: unknown[] = [];
    root.toJS({
      mapAs: 'entries',
      itemOptions: (node, ctx) => {
        if (node instanceof CborUint) valueCalls.push([...ctx.path]);
        return undefined;
      },
    });

    // Two entries, each resolved once — not collapsed into a single call
    // just because every field a path/keyNode-only match would compare is
    // identical between them.
    expect(valueCalls).toEqual([['a'], ['a']]);
  });
});

describe('CborExtension.toJS() — reviver is never observable', () => {
  test("options passed to a hook never carries 'reviver'", () => {
    const seen: unknown[] = [];
    const probe: CborExtension = {
      toJS(item, options) {
        if (item instanceof CborUint) seen.push('reviver' in options);
        return undefined; // never claims the node — only observes options
      },
    };
    const item = CBOR.fromCDN('1');

    item.toJS({ extensions: [probe] });
    item.toJS({ extensions: [probe], reviver: (_key, value) => value });

    expect(seen).toEqual([false, false]);
  });

  test('a hook cannot branch on reviver even by reaching past the type', () => {
    // Simulates an extension author trying to observe reviver anyway, via
    // an `any`-cast — confirms the value is actually absent at runtime,
    // not merely hidden by the type.
    const flakyHook = (
      item: CborItem,
      options: ToJSNodeOptions
    ): { value: unknown } | undefined => {
      if (!(item instanceof CborUint)) return undefined;
      const hasReviver = 'reviver' in (options as Record<string, unknown>);
      return { value: hasReviver ? 'with-reviver' : 'without-reviver' };
    };
    const flaky: CborExtension = { toJS: flakyHook };

    const withoutReviver = CBOR.fromCDN('[1, 2]').toJS({
      extensions: [flaky],
    });
    const withReviver = CBOR.fromCDN('[1, 2]').toJS({
      extensions: [flaky],
      reviver: (_key, value) => value,
    });

    // Same result either way: the hook has no way to tell the two calls
    // apart, so a reviver-driven container's repeat visit to the same
    // occurrence can safely reuse the first visit's result.
    expect(withoutReviver).toEqual(withReviver);
    expect(withReviver).toEqual(['without-reviver', 'without-reviver']);
  });

  test('a matched hook result is reused across a reviver-driven repeat visit', () => {
    const item = CBOR.fromCDN(
      `{"a": DT'2023-01-01T00:00:00Z', "b": DT'2024-01-01T00:00:00Z'}`,
      { extensions: [dt] }
    );
    const hookSpy = vi.fn(dt_as_Date.toJS!.bind(dt_as_Date));
    const spiedExtension = { ...dt_as_Date, toJS: hookSpy };

    const value = item.toJS({
      extensions: [spiedExtension],
      reviver: (_key, value) => value,
    }) as { a: unknown; b: unknown };

    expect(value.a).toBeInstanceOf(Date);
    expect(value.b).toBeInstanceOf(Date);
    // Root (declines, visited once) + "a" and "b" each offered once per
    // reviver state (object-mode map values sit inside CborMap.toObject's
    // own raw/revived split) — 1 + 2*2 = 5, not 6 (which would mean a
    // shared node visited twice at the *same* occurrence-and-state).
    expect(hookSpy).toHaveBeenCalledTimes(5);
  });
});
