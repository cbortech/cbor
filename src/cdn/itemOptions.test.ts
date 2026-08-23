/**
 * Tests for `ToCDNOptions.itemOptions` (per-node option overrides for
 * `toCDN()`) — the `toCDN()` counterpart of `ToJSOptions.itemOptions` (see
 * `src/js/itemOptions.test.ts`), with a different underlying reason a node
 * can be visited more than once: `inlineLeafContainers`'s layout probe (and
 * a tag/app-sequence entry's own multi-word check) re-render an entry
 * purely to answer a layout question, before the real render — see
 * `CdnItemContext`'s own doc.
 */

import { describe, test, expect, vi } from 'vitest';
import { CBOR } from '../cbor';
import type { CdnItemContext } from '../types';
import type { CborItem } from '../ast/CborItem';
import { CborAppSeqResult } from '../ast/CborAppSeqResult';
import { CborIndefiniteByteString } from '../ast/CborIndefiniteByteString';
import { CborByteString } from '../ast/CborByteString';
import { CborArray } from '../ast/CborArray';

describe('itemOptions — basic dispatch', () => {
  test('unset itemOptions leaves toCDN() output unchanged', () => {
    const item = CBOR.fromCDN('[1, 2, 3]');
    expect(item.toCDN()).toBe('[1,2,3]');
  });

  test('itemOptions returning undefined for every node changes nothing', () => {
    const item = CBOR.fromCDN('[1, 2, 3]');
    const spy = vi.fn(() => undefined);
    expect(item.toCDN({ itemOptions: spy })).toBe('[1,2,3]');
    expect(spy).toHaveBeenCalled();
  });

  test('overriding intFormat for one array element only', () => {
    const item = CBOR.fromCDN('[1, 2, 3]');
    const text = item.toCDN({
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 1
          ? { intFormat: 'hex' }
          : undefined,
    });
    expect(text).toBe('[1,0x2,3]');
  });

  test('overriding a nested map value by path', () => {
    const item = CBOR.fromCDN('{"outer": {"inner": 10}}');
    const text = item.toCDN({
      itemOptions: (_node, ctx) =>
        ctx.path.length === 2 &&
        ctx.path[0] === 'outer' &&
        ctx.path[1] === 'inner'
          ? { intFormat: 'hex' }
          : undefined,
    });
    expect(text).toBe('{"outer":{"inner":0xa}}');
  });

  test('override cascades to descendants unless re-overridden', () => {
    const item = CBOR.fromCDN('{"a": [1, 2]}');
    const text = item.toCDN({
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 'a' ? { intFormat: 'hex' } : undefined,
    });
    expect(text).toBe('{"a":[0x1,0x2]}');
  });

  test('root itself can be targeted (empty path)', () => {
    const item = CBOR.fromCDN('1');
    const text = item.toCDN({
      itemOptions: (_node, ctx) =>
        ctx.path.length === 0 ? { intFormat: 'hex' } : undefined,
    });
    expect(text).toBe('0x1');
  });

  test('ctx.parent is the immediate container', () => {
    const item = CBOR.fromCDN('[1]');
    let seenParent: CborItem | undefined;
    item.toCDN({
      itemOptions: (_node, ctx) => {
        if (ctx.path.length === 1) seenParent = ctx.parent;
        return undefined;
      },
    });
    expect(seenParent).toBe(item);
  });

  test('map key path segments use the string value for text-string keys', () => {
    const item = CBOR.fromCDN('{"date1": 1}');
    const seenPaths: unknown[][] = [];
    item.toCDN({
      itemOptions: (_node, ctx) => {
        seenPaths.push([...ctx.path]);
        return undefined;
      },
    });
    expect(seenPaths).toContainEqual(['date1']);
  });

  test('tag/app-sequence wrappers do not add a path segment', () => {
    const item = CBOR.fromCDN('{"d": 100(1)}');
    const paths: unknown[][] = [];
    item.toCDN({
      itemOptions: (_node, ctx) => {
        paths.push([...ctx.path]);
        return undefined;
      },
    });
    const dPaths = paths.filter((p) => p.length >= 1 && p[0] === 'd');
    expect(dPaths.length).toBeGreaterThan(0);
    for (const p of dPaths) expect(p).toEqual(['d']);
  });

  test('tag content can still be overridden independently of the tag itself', () => {
    const item = CBOR.fromCDN('100(1)');
    const text = item.toCDN({
      itemOptions: (node) =>
        node.constructor.name !== 'CborTag' ? { intFormat: 'hex' } : undefined,
    });
    expect(text).toBe('100(0x1)');
  });
});

describe('itemOptions — map keys', () => {
  test('isMapKey is set when converting a key node, path unchanged', () => {
    const item = CBOR.fromCDN('{"k": 1}');
    const calls: CdnItemContext[] = [];
    item.toCDN({
      itemOptions: (_node, ctx) => {
        calls.push({ ...ctx, path: [...ctx.path] });
        return undefined;
      },
    });
    const keyCall = calls.find((c) => c.isMapKey);
    expect(keyCall).toBeDefined();
    expect(keyCall!.path).toEqual([]);
  });

  test('a map key itself can be overridden independently of its value', () => {
    const item = CBOR.fromCDN('{1: "a"}');
    const text = item.toCDN({
      itemOptions: (_node, ctx) =>
        ctx.isMapKey ? { intFormat: 'hex' } : undefined,
    });
    expect(text).toBe('{0x1:"a"}');
  });
});

describe('itemOptions — ctx.options', () => {
  test('reflects the root options at the top level', () => {
    const item = CBOR.fromCDN('1');
    let seenIntFormat: unknown;
    item.toCDN({
      intFormat: 'hex',
      itemOptions: (_node, ctx) => {
        seenIntFormat = ctx.options.intFormat;
        return undefined;
      },
    });
    expect(seenIntFormat).toBe('hex');
  });

  test('reflects an ancestor override, not the original root options', () => {
    const item = CBOR.fromCDN('{"a": {"b": 1}}');
    const seen: { path: unknown[]; intFormat: unknown }[] = [];
    item.toCDN({
      itemOptions: (_node, ctx) => {
        seen.push({ path: [...ctx.path], intFormat: ctx.options.intFormat });
        return ctx.path[0] === 'a' ? { intFormat: 'hex' } : undefined;
      },
    });
    const aInner = seen.find(
      (s) => s.path.length === 2 && s.path[0] === 'a' && s.path[1] === 'b'
    );
    expect(aInner?.intFormat).toBe('hex');
    const outer = seen.find((s) => s.path.length === 0);
    expect(outer?.intFormat).toBeUndefined();
  });

  test('is a fresh snapshot, not shared with a later resolution', () => {
    const item = CBOR.fromCDN('[1, 2]');
    const seen: unknown[] = [];
    item.toCDN({
      itemOptions: (_node, ctx) => {
        seen.push(ctx.options.intFormat);
        (ctx.options as { intFormat?: string }).intFormat = 'hex';
        return undefined;
      },
    });
    expect(seen.every((v) => v === undefined)).toBe(true);
  });
});

describe('itemOptions — indefinite-length strings and <<...>>', () => {
  test('chunk path addressing distinguishes each chunk of an indefinite-length text string', () => {
    // `sqstr`/`intFormat`-style formatting overrides have no text-string
    // counterpart (sqstr only governs byte strings), so this checks
    // addressing directly: each chunk is offered itemOptions at its own
    // index, not conflated with its siblings.
    const item = CBOR.fromCDN('(_ "a", "b")');
    const seenPaths: unknown[][] = [];
    item.toCDN({
      itemOptions: (_node, ctx) => {
        seenPaths.push([...ctx.path]);
        return undefined;
      },
    });
    expect(seenPaths).toContainEqual([0]);
    expect(seenPaths).toContainEqual([1]);
  });

  test('overriding one chunk of an indefinite-length byte string', () => {
    // Default sqstr ('printable-string') renders both chunks as quoted
    // text ('a', 'b') since both decode to printable ASCII; overriding
    // chunk 0 to sqstr: 'none' forces it back to h'...' form.
    const item = CBOR.fromCDN("(_ h'61', h'62')");
    expect(item.toCDN()).toBe("(_ 'a','b')");
    const text = item.toCDN({
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 0 ? { sqstr: 'none' } : undefined,
    });
    expect(text).toBe("(_ h'61','b')");
  });

  test('overriding one item of a <<...>> embedded CBOR sequence', () => {
    const item = CBOR.fromCDN('<<1, 2>>');
    const text = item.toCDN({
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 1 ? { intFormat: 'hex' } : undefined,
    });
    expect(text).toBe('<<1,0x2>>');
  });
});

describe('itemOptions — inlineLeafContainers layout consistency', () => {
  test('an override affecting rendered length still influences the collapse decision correctly', () => {
    // Force a very long hex spelling for element 0 so this array can no
    // longer fit on one line despite `inlineLeafContainers` — the same
    // decision `entryIsMultiWordText`/the flat-render probe would reach
    // whether or not itemOptions is involved. Mainly a regression guard
    // against the layout probe and the real render disagreeing about which
    // options apply to a given entry.
    const item = CBOR.fromCDN('[1, 2]');
    const withOverride = item.toCDN({
      indent: 2,
      inlineLeafContainers: true,
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 0 ? { intFormat: 'binary' } : undefined,
    });
    // The override is applied consistently: value 1 in binary is `0b1`.
    expect(withOverride).toContain('0b1');
    // And the whole thing is still valid, re-parseable CDN.
    expect(CBOR.fromCDN(withOverride).toJS()).toEqual([1, 2]);
  });

  test('itemOptions may run more than once for a tag-wrapped entry, but the final output reflects the override consistently', () => {
    const item = CBOR.fromCDN('[100(1), 2]');
    const calls: unknown[] = [];
    const text = item.toCDN({
      itemOptions: (_node, ctx) => {
        calls.push([...ctx.path]);
        return ctx.path[0] === 0 ? { intFormat: 'hex' } : undefined;
      },
    });
    expect(text).toBe('[100(0x1),2]');
    // itemOptions was offered path [0] more than once (the tag's own
    // multi-word layout probe, plus the real render) — this is expected,
    // documented behavior, not a bug (see CdnItemContext).
    const zeroPathCalls = calls.filter(
      (p) => Array.isArray(p) && p.length === 1 && p[0] === 0
    );
    expect(zeroPathCalls.length).toBeGreaterThan(1);
  });
});

describe('itemOptions — preserveAll re-expansion', () => {
  test('an override enabling preserveAll expands the preserve* flags for that subtree', () => {
    const item = CBOR.fromCDN('{"a": [1, "b" + "c"]}', { preserveAll: true });
    const text = item.toCDN({
      indent: 2,
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 'a' ? { preserveAll: true } : undefined,
    });
    // Without the override, indent mode collapses "b" + "c" into a single
    // joined literal ("bc") when re-serializing. preserveConcatenation
    // (implied by preserveAll) keeps the "+" split instead, for the value
    // under "a" only, even though preserveAll wasn't set at the top level.
    expect(item.toCDN({ indent: 2 })).not.toContain('+');
    expect(text).toMatch(/"b"\s*\+\s*"c"/);
  });
});

describe('itemOptions — CborAppSeqResult chunk-level overrides', () => {
  test('an itemOptions override on one chunk of a preserved ilbs<<...>> bypasses the verbatim fast path', () => {
    // Without itemOptions, CborAppSeqResult returns the preserved ednSource
    // verbatim — the fast path never visits `inner`'s own descendants.
    const item = CBOR.fromCDN("ilbs<<h'61',h'62'>>");
    expect(item.toCDN()).toBe("ilbs<<h'61',h'62'>>");
    const text = item.toCDN({
      modernStreamSyntax: true,
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 0
          ? { sqstr: 'none', bstrEncoding: 'base64' }
          : undefined,
    });
    // Chunk 0 is rendered per its own override (base64, no sqstr); chunk 1
    // is unaffected.
    expect(text).toBe("ilbs<<b64'YQ','b'>>");
  });

  test('merely configuring itemOptions still visits every chunk individually, but leaves output unchanged when nothing overrides', () => {
    const item = CBOR.fromCDN("ilbs<<h'61',h'62'>>");
    const paths: unknown[][] = [];
    const text = item.toCDN({
      itemOptions: (_node, ctx) => {
        paths.push([...ctx.path]);
        return undefined;
      },
    });
    // Each chunk was individually offered itemOptions, proving the wrapper
    // recursed into `inner`'s own children instead of short-circuiting...
    expect(paths).toContainEqual([0]);
    expect(paths).toContainEqual([1]);
    // ...but since every call returned undefined, the "undefined = no
    // change" contract still holds: the exact preserved source comes back,
    // not a freshly (if equivalently) rendered string.
    expect(text).toBe(item.toCDN());
    expect(text).toBe("ilbs<<h'61',h'62'>>");
  });

  test('the same holds for ilts<<...>>', () => {
    const item = CBOR.fromCDN('ilts<<"a","b">>');
    const text = item.toCDN({ itemOptions: () => undefined });
    expect(text).toBe(item.toCDN());
    expect(text).toBe('ilts<<"a","b">>');
  });
});

describe('itemOptions — path threading through dt/ip/cri extension classes', () => {
  test('dt: tag content sees its real path, not an empty one, under appPrefix:false', () => {
    const item = CBOR.fromCDN('{"d": 1(1)}');
    const text = item.toCDN({
      appPrefix: false,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 'd'
          ? { intFormat: 'hex' }
          : undefined,
    });
    expect(text).toBe('{"d":1(0x1)}');
  });

  test('ip: tagged content sees its real path under appPrefix:false', () => {
    const item = CBOR.fromCDN('{"a": IP\'192.0.2.42\'}');
    const text = item.toCDN({
      appPrefix: false,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 'a'
          ? { intFormat: 'hex' }
          : undefined,
    });
    expect(text).toBe('{"a":52(h\'c000022a\')}');
  });

  test('cri: tagged content sees its real path under appPrefix:false', () => {
    const item = CBOR.fromCDN('{"a": CRI\'https://example.com/x\'}');
    const text = item.toCDN({
      appPrefix: false,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 'a'
          ? { intFormat: 'hex' }
          : undefined,
    });
    expect(text).toBe('{"a":99([-0x4,["example","com"],["x"]])}');
  });
});

describe('itemOptions — per-child comment overrides', () => {
  test('CborArray: overriding one element strips only its own comment', () => {
    const item = CBOR.fromCDN('[1 # one\n, 2 # two\n]', {
      preserveComments: true,
    });
    const text = item.toCDN({
      preserveComments: true,
      indent: 2,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 0
          ? { preserveComments: false, comments: 'strip' }
          : undefined,
    });
    expect(text).toBe('[\n  1,\n  2 # two\n]');
  });

  test("CborMap: overriding one entry via its key node strips only that entry's comments", () => {
    const item = CBOR.fromCDN('{"a": 1 # one\n, "b": 2 # two\n}', {
      preserveComments: true,
    });
    // Comment handling for a map entry is anchored to its key (see
    // `entryLeadingNode`/`entryOptions` in CborMap._toCDN), so the override
    // targets the "a" key node via `ctx.isMapKey`, not its value's own path.
    const text = item.toCDN({
      preserveComments: true,
      indent: 2,
      itemOptions: (_node, ctx) =>
        ctx.isMapKey && ctx.path.length === 0 && ctx.keyNode
          ? (ctx.keyNode as unknown as { value: unknown }).value === 'a'
            ? { preserveComments: false, comments: 'strip' }
            : undefined
          : undefined,
    });
    expect(text).toBe('{\n  "a": 1,\n  "b": 2 # two\n}');
  });

  test('CborEmbeddedCBOR: overriding one item strips only its own comment', () => {
    const item = CBOR.fromCDN('<<1 # one\n, 2 # two\n>>', {
      preserveComments: true,
    });
    const text = item.toCDN({
      preserveComments: true,
      indent: 2,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 0
          ? { preserveComments: false, comments: 'strip' }
          : undefined,
    });
    expect(text).toBe('<<\n  1,\n  2 # two\n>>');
  });

  test('CborIndefiniteByteString: overriding one chunk strips only its own comment', () => {
    const item = CBOR.fromCDN("(_ h'61' # one\n, h'62' # two\n)", {
      preserveComments: true,
    });
    const text = item.toCDN({
      preserveComments: true,
      indent: 2,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 0
          ? { preserveComments: false, comments: 'strip' }
          : undefined,
    });
    expect(text).toBe("(_ \n  'a',\n  'b' # two\n)");
  });

  test('CborIndefiniteTextString: overriding one chunk strips only its own comment', () => {
    const item = CBOR.fromCDN('(_ "a" # one\n, "b" # two\n)', {
      preserveComments: true,
    });
    const text = item.toCDN({
      preserveComments: true,
      indent: 2,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 0
          ? { preserveComments: false, comments: 'strip' }
          : undefined,
    });
    expect(text).toBe('(_ \n  "a",\n  "b" # two\n)');
  });

  test('CborTag: overriding the content node strips only its own comment', () => {
    const item = CBOR.fromCDN('99(1 # inner\n)', { preserveComments: true });
    const text = item.toCDN({
      preserveComments: true,
      indent: 2,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 0
          ? { preserveComments: false, comments: 'strip' }
          : undefined,
    });
    expect(text).toBe('99(1)');
  });
});

describe('itemOptions — deprecated alias override precedence (Fix 4)', () => {
  test('a child override on the deprecated appStrings alias is not swallowed by an inherited canonical appPrefix', () => {
    const item = CBOR.fromCDN('{"top": dt\'2020-01-01T00:00:00Z\'}');
    expect(item.toCDN({ appStrings: true })).toBe(
      '{"top":dt\'2020-01-01T00:00:00Z\'}'
    );
    const text = item.toCDN({
      appStrings: true,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 'top'
          ? { appStrings: false }
          : undefined,
    });
    // Matches the same-shape output as setting appStrings: false globally —
    // the child's own alias-based override must win over the inherited,
    // already-resolved canonical appPrefix: true.
    expect(text).toBe(item.toCDN({ appStrings: false }));
    expect(text).toBe('{"top":1577836800}');
  });

  test('the deprecated preserveAppSequence alias is likewise resolved on the override alone', () => {
    const item = CBOR.fromCDN('{"a": ilbs<<h\'61\'>>}');
    // Top level: preserveAppSequence: true (deprecated alias for
    // preserveAppPrefix) keeps the preserved <<...>> spelling.
    const withAlias = item.toCDN({ preserveAppSequence: true });
    expect(withAlias).toContain('ilbs<<');
    // A child override using only the deprecated alias, set to false, must
    // disable preservation for that child specifically — not be silently
    // discarded by the inherited, already-resolved preserveAppPrefix: true.
    const text = item.toCDN({
      preserveAppSequence: true,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 'a'
          ? { preserveAppSequence: false }
          : undefined,
    });
    expect(text).not.toContain('ilbs<<');
  });
});

describe('itemOptions — CborAppSeqResult: configuring itemOptions alone must not change output', () => {
  test('an itemOptions callback that never overrides anything leaves ilbs<<...>> byte-for-byte unchanged', () => {
    const item = CBOR.fromCDN("ilbs<<h'61',h'62'>>");
    expect(item.toCDN({ itemOptions: () => undefined })).toBe(item.toCDN());
    expect(item.toCDN({ itemOptions: () => undefined })).toBe(
      "ilbs<<h'61',h'62'>>"
    );
  });

  test('an itemOptions callback that never overrides anything leaves ilts<<...>> byte-for-byte unchanged', () => {
    const item = CBOR.fromCDN('ilts<<"a","b">>');
    expect(item.toCDN({ itemOptions: () => undefined })).toBe(item.toCDN());
    expect(item.toCDN({ itemOptions: () => undefined })).toBe(
      'ilts<<"a","b">>'
    );
  });

  test('an itemOptions callback that overrides an unrelated sibling subtree still leaves this one unchanged', () => {
    const item = CBOR.fromCDN('{"a": ilbs<<h\'61\'>>, "b": 1}');
    const text = item.toCDN({
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 'b'
          ? { intFormat: 'hex' }
          : undefined,
    });
    expect(text).toBe('{"a":ilbs<<h\'61\'>>,"b":0x1}');
  });

  test('a matching override still takes effect, switching away from the verbatim source', () => {
    const item = CBOR.fromCDN("ilbs<<h'61',h'62'>>");
    const text = item.toCDN({
      modernStreamSyntax: true,
      itemOptions: (_node, ctx) =>
        ctx.path[0] === 0
          ? { sqstr: 'none', bstrEncoding: 'base64' }
          : undefined,
    });
    expect(text).toBe("ilbs<<b64'YQ','b'>>");
    expect(text).not.toBe(item.toCDN());
  });

  test("ctx.options.itemOptions is always the caller's own function, inside the app-sequence subtree too", () => {
    // The bypass-tracking mechanism must be out-of-band: it must not
    // replace `options.itemOptions` itself, since `ctx.options` (built from
    // that same `options`) is documented as reflecting the current
    // *effective options* — a pure callback could otherwise tell an
    // app-sequence subtree apart from an ordinary one just by checking
    // `ctx.options.itemOptions === callback`.
    const item = CBOR.fromCDN("ilbs<<h'61',h'62'>>");
    const seen: { node: string; identical: boolean }[] = [];
    const callback = (node: CborItem, ctx: CdnItemContext) => {
      seen.push({
        node: node.constructor.name,
        identical: ctx.options.itemOptions === callback,
      });
      return undefined;
    };
    item.toCDN({ itemOptions: callback });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.identical).toBe(true);
  });
});

describe("itemOptions — layout decisions use each entry's own effective comment visibility", () => {
  test('a child override enabling comments the parent hides still shows that comment', () => {
    const item = CBOR.fromCDN('[1 # one\n, 2]', { preserveComments: true });
    const text = item.toCDN({
      indent: 2,
      preserveComments: false,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 0
          ? { preserveComments: true, comments: 'cdn-style' }
          : undefined,
    });
    expect(text).toBe('[\n  1, # one\n  2\n]');
  });

  test('stripping the only comment on a CborTag content node collapses back to single-line', () => {
    const item = CBOR.fromCDN('99(1 # inner\n)', { preserveComments: true });
    // Without the override, the captured comment forces multi-line layout.
    expect(item.toCDN({ indent: 2, preserveComments: true })).toBe(
      '99(\n  1 # inner\n)'
    );
    const text = item.toCDN({
      indent: 2,
      preserveComments: true,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 0
          ? { preserveComments: false, comments: 'strip' }
          : undefined,
    });
    // No comment survives the override, so the multi-line layout it alone
    // justified is no longer needed either.
    expect(text).toBe('99(1)');
  });

  test('stripping the only comment on an inlineLeafContainers array entry collapses back to single-line', () => {
    const item = CBOR.fromCDN('[1 # one\n]', { preserveComments: true });
    expect(
      item.toCDN({
        indent: 2,
        inlineLeafContainers: true,
        preserveComments: true,
      })
    ).toBe('[\n  1 # one\n]');
    const text = item.toCDN({
      indent: 2,
      inlineLeafContainers: true,
      preserveComments: true,
      itemOptions: (_node, ctx) =>
        ctx.path.length === 1 && ctx.path[0] === 0
          ? { preserveComments: false, comments: 'strip' }
          : undefined,
    });
    expect(text).toBe('[1]');
  });
});

describe('itemOptions — CborAppSeqResult: nested app-sequence override propagation', () => {
  // No built-in extension nests one preserve-source app-sequence inside
  // another, so these build the AST directly: an outer `CborAppSeqResult`
  // (standing in for a hypothetical `wrap<<...>>` app-extension) wrapping an
  // inner `CborAppSeqResult` (`ilbs<<...>>`) wrapping a
  // `CborIndefiniteByteString` chunk.
  function nestedWrap(byte: number): CborAppSeqResult {
    const hex = byte.toString(16).padStart(2, '0');
    const inner = new CborAppSeqResult(
      new CborIndefiniteByteString([
        new CborByteString(new Uint8Array([byte])),
      ]),
      `ilbs<<h'${hex}'>>`
    );
    return new CborAppSeqResult(inner, `wrap<<ilbs<<h'${hex}'>>>>`);
  }

  test('an override on the innermost chunk is not discarded by the outer wrapper', () => {
    const outer = nestedWrap(0x61);
    expect(outer.toCDN()).toBe("wrap<<ilbs<<h'61'>>>>");
    const text = outer.toCDN({
      modernStreamSyntax: true,
      itemOptions: (node) =>
        node instanceof CborByteString
          ? { sqstr: 'none', bstrEncoding: 'base64' }
          : undefined,
    });
    // The override did take effect somewhere in the subtree — this must not
    // fall back to the outer wrapper's stale preserved source.
    expect(text).not.toBe("wrap<<ilbs<<h'61'>>>>");
    expect(text).toContain("b64'YQ'");
  });

  test('configuring itemOptions with no matching override still leaves the nested source untouched', () => {
    const outer = nestedWrap(0x61);
    const text = outer.toCDN({ itemOptions: () => undefined });
    expect(text).toBe(outer.toCDN());
    expect(text).toBe("wrap<<ilbs<<h'61'>>>>");
  });

  test('an override in one sibling nested app-sequence does not leak into an unrelated one', () => {
    const arr = new CborArray([nestedWrap(0x61), nestedWrap(0x62)]);
    expect(arr.toCDN()).toBe("[wrap<<ilbs<<h'61'>>>>,wrap<<ilbs<<h'62'>>>>]");
    const text = arr.toCDN({
      modernStreamSyntax: true,
      itemOptions: (node, ctx) =>
        node instanceof CborByteString && ctx.path[0] === 0
          ? { sqstr: 'none', bstrEncoding: 'base64' }
          : undefined,
    });
    // Element 0's nested source is abandoned in favor of the override...
    expect(text).toContain("b64'YQ'");
    // ...but element 1, untouched by the override, keeps its exact
    // preserved source — a fresh local tracker per wrapper call, not a
    // shared one, is what keeps these independent.
    expect(text).toContain("wrap<<ilbs<<h'62'>>>>");
  });
});
