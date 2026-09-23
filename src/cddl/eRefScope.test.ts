import { describe, expect, test } from 'vitest';
import { CDDL } from './index';
import {
  resolveElementPosition,
  resolveNestedPosition,
  resolveRootPosition,
  resolveRootScope,
  resolveNestedScope,
  scopeNameToValue,
  scopeValueToName,
  resolvesGloballyTo,
  resolveValueEnumName,
} from './eRefScope';

describe('resolveRootScope / scopeNameToValue', () => {
  test('resolves the root rule and its own &(name: value) member keys', () => {
    const schema = CDDL.compile('p = { ? &(title: -1) => tstr }');
    const scope = resolveRootScope(schema);
    expect(scope).toBeDefined();
    expect(scopeNameToValue(schema, scope!).get('title')).toBe(-1n);
  });

  test('resolves a bare reference to a constant rule at a member-key position', () => {
    const schema = CDDL.compile('p = { ? group_mode => bool }\ngroup_mode = 3');
    const scope = resolveRootScope(schema);
    expect(scopeNameToValue(schema, scope!).get('group_mode')).toBe(3n);
  });

  test("a name bound only in a rule the root type never references isn't in scope", () => {
    // The exact reported bug: `other`'s own &(title: -1) must not leak into
    // root's own scope just because it exists somewhere in the schema.
    const schema = CDDL.compile(
      'root = { title: tstr }\nother = { &(title: -1) => tstr }'
    );
    const scope = resolveRootScope(schema);
    expect(scope).toBeDefined();
    expect(scopeNameToValue(schema, scope!).has('title')).toBe(false);
  });

  test('respects an explicit ruleName, matching ValidateOptions.rule', () => {
    const schema = CDDL.compile(
      'root = { title: tstr }\nother = { ? &(title: -1) => tstr }'
    );
    const rootScope = resolveRootScope(schema);
    expect(scopeNameToValue(schema, rootScope!).has('title')).toBe(false);
    const otherScope = resolveRootScope(schema, 'other');
    expect(scopeNameToValue(schema, otherScope!).get('title')).toBe(-1n);
  });

  test('a name bound twice with different values within the same scope is locally ambiguous', () => {
    const schema = CDDL.compile('p = { ? &(x: 1) => tstr, ? &(x: 2) => int }');
    const scope = resolveRootScope(schema);
    expect(scopeNameToValue(schema, scope!).has('x')).toBe(false);
  });

  test('a plain (non-map) root type resolves to no scope at all', () => {
    const schema = CDDL.compile('p = tstr');
    expect(resolveRootScope(schema)).toBeUndefined();
  });

  test('merges every choice alternative that resolves to a map type', () => {
    const schema = CDDL.compile(
      'p = a / b\na = { ? &(x: 1) => tstr }\nb = { ? &(y: 2) => tstr }'
    );
    const scope = resolveRootScope(schema);
    const names = scopeNameToValue(schema, scope!);
    expect(names.get('x')).toBe(1n);
    expect(names.get('y')).toBe(2n);
  });

  test('a //= group-choice extension of the root rule is picked up too', () => {
    const schema = CDDL.compile(
      'p = { ? &(x: 1) => tstr }\np //= ( ? &(y: 2) => tstr )'
    );
    const scope = resolveRootScope(schema);
    const names = scopeNameToValue(schema, scope!);
    expect(names.get('x')).toBe(1n);
    expect(names.get('y')).toBe(2n);
  });

  test('a generic type reference is not resolved (Scope note)', () => {
    const schema = CDDL.compile(
      'p = wrapper<int>\nwrapper<T> = { ? &(x: 1) => T }'
    );
    expect(resolveRootScope(schema)).toBeUndefined();
  });

  describe('discriminated-union safety — alternatives are never merged blindly', () => {
    // The exact reported bug: a name used as a plain text key in one
    // alternative and as an &(name: value) binding in another must not be
    // converted at all — which alternative the JS value being converted
    // actually corresponds to isn't known without validating it.
    test('a name that is plain text in one alternative and e-ref in another is excluded from both', () => {
      const schema = CDDL.compile(
        'root = { kind: "text", title: tstr }\n' +
          '     / { kind: "numeric", &(title: -1) => tstr }'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).has('title')).toBe(false);
    });

    test('the same name bound to different values in different alternatives is excluded', () => {
      const schema = CDDL.compile(
        'root = { ? &(x: 1) => tstr } / { ? &(x: 2) => int }'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).has('x')).toBe(false);
    });

    test('the same name bound to the same value in every alternative that mentions it is still safe', () => {
      const schema = CDDL.compile(
        'root = { ? &(x: 1) => tstr } / { ? &(x: 1) => int }'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).get('x')).toBe(1n);
    });

    test('a name only mentioned in one alternative — silent in the other — is still safe', () => {
      const schema = CDDL.compile(
        'root = { ? &(x: 1) => tstr } / { ? &(y: 2) => int }'
      );
      const scope = resolveRootScope(schema)!;
      const names = scopeNameToValue(schema, scope);
      expect(names.get('x')).toBe(1n);
      expect(names.get('y')).toBe(2n);
    });

    test('the same conflict via a //= group-choice extension (not just a / type choice)', () => {
      const schema = CDDL.compile(
        'root = { title: tstr }\nroot //= ( ? &(title: -1) => tstr )'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).has('title')).toBe(false);
    });

    test('a nested scope reached only through the safe alternative is unaffected', () => {
      const schema = CDDL.compile(
        'root = { kind: "text", title: tstr }\n' +
          '     / { kind: "numeric", outer: inner }\n' +
          'inner = { ? &(x: 1) => tstr }'
      );
      const root = resolveRootScope(schema)!;
      const nested = resolveNestedScope(schema, root, 'outer')!;
      expect(nested).toBeDefined();
      expect(scopeNameToValue(schema, nested).get('x')).toBe(1n);
    });
  });

  describe('`any`/wildcard alternatives are never silently dropped from a merge', () => {
    // The exact reported bug: an alternative whose shape can't be pinned
    // down (`any`, or a wildcard `* tstr => any` catch-all) was simply
    // skipped when merged with another, resolvable alternative — letting a
    // name from the resolvable alternative through even though the `any`/
    // wildcard alternative could equally apply to the value being
    // converted.
    test('a nested key that is `any` in one alternative and a named map in another resolves to no scope at all', () => {
      const schema = CDDL.compile(
        'root = { kind: "raw", data: any }\n' +
          '     / { kind: "named", data: { &(title: -1) => tstr } }'
      );
      const root = resolveRootScope(schema)!;
      expect(resolveNestedScope(schema, root, 'data')).toBeUndefined();
    });

    test('a wildcard `* tstr => any` alternative excludes every name, not just the ones it structurally collides with', () => {
      const schema = CDDL.compile(
        'root = {* tstr => any} / {&(title: -1) => tstr}'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).has('title')).toBe(false);
    });

    test('a member key qualified by a control/range operator is also treated as open, not silently ignored', () => {
      const schema = CDDL.compile(
        'root = {tstr .size 4 => any} / {&(title: -1) => tstr}'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).has('title')).toBe(false);
    });

    test('the literal `#` (bare "any") token is treated the same as the `any` identifier', () => {
      const schema = CDDL.compile(
        'root = { kind: "raw", data: # }\n' +
          '     / { kind: "named", data: { &(title: -1) => tstr } }'
      );
      const root = resolveRootScope(schema)!;
      expect(resolveNestedScope(schema, root, 'data')).toBeUndefined();
    });

    test('a schema that shadows the prelude name `any` with its own map rule is resolved normally, not treated as open', () => {
      const schema = CDDL.compile(
        'root = { data: any }\nany = { &(x: 1) => tstr }'
      );
      const root = resolveRootScope(schema)!;
      const nested = resolveNestedScope(schema, root, 'data')!;
      expect(nested).toBeDefined();
      expect(scopeNameToValue(schema, nested).get('x')).toBe(1n);
    });

    test('no regression: the named-only branch alone still resolves normally', () => {
      const schema = CDDL.compile(
        'root = { kind: "named", data: { &(title: -1) => tstr } }'
      );
      const root = resolveRootScope(schema)!;
      const nested = resolveNestedScope(schema, root, 'data')!;
      expect(scopeNameToValue(schema, nested).get('title')).toBe(-1n);
    });
  });

  describe('an unresolved generic instantiation or a map-capable major type is open, not none', () => {
    // The exact reported bug: a generic instantiation (`box<any>`) and a
    // bare `#5` (any major-type-5 item, i.e. any map) both failed to
    // resolve to definite map entries here, but were then treated the same
    // as a type we're *sure* can never be a map (a literal, an array, …) —
    // silently dropped from a merge instead of forcing the whole position
    // unsafe, the same class of bug `any`/wildcard alternatives had.
    test('a generic instantiation sibling excludes the whole root scope, not just that one alternative', () => {
      // An 'open' alternative found while resolving *root itself* poisons
      // the whole choice, the same as it does when found merging a nested
      // key's value types — there's no partial scope to fall back to here,
      // since root's own alternatives are exactly the top-level choice.
      const schema = CDDL.compile(
        'root = box<any> / { &(title: -1) => tstr }\nbox<T> = { * tstr => T }'
      );
      expect(resolveRootScope(schema)).toBeUndefined();
    });

    test('a bare `#5` (any map) sibling excludes the whole root scope, not just that one alternative', () => {
      const schema = CDDL.compile('root = #5 / {&(title: -1) => tstr}');
      expect(resolveRootScope(schema)).toBeUndefined();
    });

    test('a major type that can never be a map (e.g. #2, byte string) is still safely ignored', () => {
      const schema = CDDL.compile('root = #2 / {&(title: -1) => tstr}');
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).get('title')).toBe(-1n);
    });

    test('no regression: the named-only branch alone still resolves normally', () => {
      const schema = CDDL.compile('root = { &(title: -1) => tstr }');
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).get('title')).toBe(-1n);
    });
  });
});

describe('resolveNestedScope', () => {
  test("descends into a nested map type reachable via a bareword member key's own value type", () => {
    const schema = CDDL.compile(
      'root = { outer: inner }\ninner = { ? &(title: -1) => tstr }'
    );
    const root = resolveRootScope(schema)!;
    const nested = resolveNestedScope(schema, root, 'outer');
    expect(nested).toBeDefined();
    expect(scopeNameToValue(schema, nested!).get('title')).toBe(-1n);
  });

  test('a key with no matching entry at this scope resolves to no nested scope', () => {
    const schema = CDDL.compile('root = { outer: tstr }');
    const root = resolveRootScope(schema)!;
    expect(resolveNestedScope(schema, root, 'nope')).toBeUndefined();
  });

  test("a nested scope's own names don't leak back into an unrelated sibling position", () => {
    const schema = CDDL.compile(
      'root = { a: inner, b: { ? foo: tstr } }\ninner = { ? &(title: -1) => tstr }'
    );
    const root = resolveRootScope(schema)!;
    // 'title' is only reachable through 'a', not through 'b'.
    const bScope = resolveNestedScope(schema, root, 'b')!;
    expect(scopeNameToValue(schema, bScope).has('title')).toBe(false);
  });

  test('descends via a quoted-text member key the same way as a bareword one', () => {
    const schema = CDDL.compile(
      'root = { "outer": inner }\ninner = { ? &(title: -1) => tstr }'
    );
    const root = resolveRootScope(schema)!;
    const nested = resolveNestedScope(schema, root, 'outer');
    expect(scopeNameToValue(schema, nested!).get('title')).toBe(-1n);
  });

  test('descends into the value type of an &(name: value) member key itself', () => {
    // The nested object under key "group_mode" (once resolved as an
    // e-ref-eligible key at this scope) has its own value type resolved too.
    const schema = CDDL.compile(
      'root = { ? &(group_mode: 3) => inner }\ninner = { ? &(title: -1) => tstr }'
    );
    const root = resolveRootScope(schema)!;
    const nested = resolveNestedScope(schema, root, 'group_mode');
    expect(nested).toBeDefined();
    expect(scopeNameToValue(schema, nested!).get('title')).toBe(-1n);
  });

  describe("a sibling alternative's open/wildcard member key is inherited by nested descent", () => {
    // The exact reported bug: `root`'s own two alternatives disagree about
    // 'data' only in the sense that one names it explicitly and the other
    // has a wildcard that could *also* match it — but resolveNestedScope()
    // only ever looked for entries that *literally* matched 'data' (by
    // name), so the wildcard's own inherent uncertainty about what it
    // could hold at 'data' never factored in, and descent proceeded as if
    // only the named alternative could possibly apply.
    test('a wildcard sibling excludes a name reachable only through the other alternative', () => {
      const schema = CDDL.compile(
        'root = { * tstr => any }\n     / { data: { &(title: -1) => tstr } }'
      );
      const root = resolveRootScope(schema)!;
      expect(resolveNestedScope(schema, root, 'data')).toBeUndefined();
    });

    test('no regression: the named-only branch alone still resolves normally', () => {
      const schema = CDDL.compile('root = { data: { &(title: -1) => tstr } }');
      const root = resolveRootScope(schema)!;
      const nested = resolveNestedScope(schema, root, 'data')!;
      expect(scopeNameToValue(schema, nested).get('title')).toBe(-1n);
    });
  });

  describe('a differently-spelled entry for the same resolved key value is also inherited by nested descent', () => {
    // The exact reported bug: alt1's `1: any` and alt2's `&(data: 1) => …`
    // both govern the very same wire position (key value 1) — but only
    // alt2 *names* it 'data', so matching purely by name missed alt1's own
    // entry entirely, even though it structurally applies to the same key.
    test('a literal-int sibling entry for the same value excludes descent through the named one', () => {
      const schema = CDDL.compile(
        'root = { kind: "raw", 1: any }\n' +
          '     / { kind: "named", &(data: 1) => { &(title: -1) => tstr } }'
      );
      const root = resolveRootScope(schema)!;
      expect(resolveNestedScope(schema, root, 'data')).toBeUndefined();
    });

    test('no regression: the named-only branch alone still resolves normally', () => {
      const schema = CDDL.compile(
        'root = { kind: "named", &(data: 1) => { &(title: -1) => tstr } }'
      );
      const root = resolveRootScope(schema)!;
      const nested = resolveNestedScope(schema, root, 'data')!;
      expect(scopeNameToValue(schema, nested).get('title')).toBe(-1n);
    });
  });
});

describe('resolvesGloballyTo', () => {
  test('true for a name bound to that exact value schema-wide', () => {
    const schema = CDDL.compile('p = { ? &(title: -1) => tstr }');
    expect(resolvesGloballyTo(schema, 'title', -1n)).toBe(true);
  });

  test('false when the name resolves to a different value schema-wide', () => {
    const schema = CDDL.compile('p = { ? &(title: -1) => tstr }');
    expect(resolvesGloballyTo(schema, 'title', -2n)).toBe(false);
  });

  test('false when the name is ambiguous schema-wide, even if the value given matches one local binding', () => {
    const schema = CDDL.compile(
      'root = { &(x: 1) => tstr }\nother = { &(x: 2) => tstr }'
    );
    expect(resolvesGloballyTo(schema, 'x', 1n)).toBe(false);
    expect(resolvesGloballyTo(schema, 'x', 2n)).toBe(false);
  });

  test('false for a name the schema never binds at all', () => {
    const schema = CDDL.compile('p = { ? &(title: -1) => tstr }');
    expect(resolvesGloballyTo(schema, 'nope', -1n)).toBe(false);
  });
});

describe('unrecognized constructs default to open, not silently skipped', () => {
  // The exact reported bug: a bare group reference, a controlled top-level
  // type alternative, and an &(...) enum entry whose own value isn't a
  // literal integer were each simply skipped by the code that decides
  // whether a sibling alternative is safe to merge past — treated the same
  // as a construct genuinely proven incapable of being a map, rather than
  // "we don't understand this, so we can't rule it out". Fixed by flipping
  // the default: every one of these now forces 'open' (unsafe) unless
  // positively resolved, instead of accumulating one-off exceptions.
  test('a bare group reference that expands to a conflicting bareword key is not silently skipped', () => {
    const schema = CDDL.compile(
      'root = { raw } / { &(title: -1) => tstr }\nraw = (title: tstr)'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope).has('title')).toBe(false);
  });

  test('a controlled top-level type alternative (`.and`) is never assumed to be a non-map', () => {
    const schema = CDDL.compile(
      'root = (any .and #5) / { &(title: -1) => tstr }'
    );
    expect(resolveRootScope(schema)).toBeUndefined();
  });

  test('an &(...) enum entry whose own value is not a literal integer makes that member key open', () => {
    const schema = CDDL.compile(
      'root = { &(raw: tstr) => any } / { &(title: -1) => tstr }'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope).has('title')).toBe(false);
  });

  test('no regression: a bare group reference that expands to disjoint names stays safe', () => {
    const schema = CDDL.compile(
      'root = { raw } / { &(title: -1) => tstr }\nraw = (other: tstr)'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope).get('title')).toBe(-1n);
  });

  test('no regression: an &(...) enum whose entries are all literal integers stays safe', () => {
    const schema = CDDL.compile('root = { ? &(x: 1, y: 2) => tstr }');
    const scope = resolveRootScope(schema)!;
    const names = scopeNameToValue(schema, scope);
    expect(names.get('x')).toBe(1n);
    expect(names.get('y')).toBe(2n);
  });

  test('a bare group reference two levels deep still flattens through both levels', () => {
    const schema = CDDL.compile(
      'root = { raw } / { &(title: -1) => tstr }\n' +
        'raw = (mid)\n' +
        'mid = (title: tstr)'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope).has('title')).toBe(false);
  });

  test('no regression: a //-choice inline group entry keeps its own alternatives separate', () => {
    const schema = CDDL.compile('root = { (a: tstr // b: tstr) }');
    const root = resolveRootScope(schema)!;
    expect(root.alternatives.length).toBe(2);
  });

  test('an &(...) enum used as a bare type (not a member key) can represent a map, so it is never resolved as none', () => {
    const schema = CDDL.compile(
      'root = &(raw: { * tstr => any })\n     / { &(title: -1) => tstr }'
    );
    expect(resolveRootScope(schema)).toBeUndefined();
  });

  describe('a bare type reference at a member key is never conflated with an unrelated &(...) enum label of the same spelling', () => {
    // The exact reported bug: `keytype`'s own rule definition is `tstr`
    // (not an integer constant at all), but an unrelated schema-wide
    // `&(keytype: 2) => …` enum label — used as a plain enum entry name
    // inside `other`, nothing to do with the rule `keytype` — also happens
    // to bind the *string* 'keytype' to the integer 2 in getERefTables()'s
    // general-purpose byName table. A wildcard whose own key TYPE is the
    // *rule* `keytype` was being treated as "safely resolves to 2" purely
    // because that spelling was bound to an integer *somewhere*, not
    // because the rule itself does.
    test('a wildcard whose key type is a same-named rule (not an integer constant) still excludes a sibling name', () => {
      const schema = CDDL.compile(
        'root = { * keytype => any } / { &(title: -1) => tstr }\n' +
          'keytype = tstr\n' +
          'other = { &(keytype: 2) => int }'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).has('title')).toBe(false);
    });

    test('reproduces even when the wildcard key type is the prelude name itself (tstr), labeled elsewhere', () => {
      const schema = CDDL.compile(
        'root = { * tstr => any } / { &(title: -1) => tstr }\n' +
          'other = { &(tstr: 2) => int }'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).has('title')).toBe(false);
    });

    test('no regression: a genuine bare reference to an integer constant rule still resolves', () => {
      const schema = CDDL.compile(
        'root = { ? group_mode => bool }\ngroup_mode = 3'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).get('group_mode')).toBe(3n);
    });

    test("no regression: an unrelated &(...) enum label with the same spelling as a genuine integer constant rule doesn't change its value", () => {
      const schema = CDDL.compile(
        'root = { ? group_mode => bool } / { &(title: -1) => tstr }\n' +
          'group_mode = 3\n' +
          'other = { &(group_mode: 99) => int }'
      );
      const scope = resolveRootScope(schema)!;
      expect(scopeNameToValue(schema, scope).get('group_mode')).toBe(3n);
    });
  });
});

describe('scopeValueToName', () => {
  test('the inverse of scopeNameToValue for an unambiguous binding', () => {
    const schema = CDDL.compile('p = { ? &(title: -1) => tstr }');
    const scope = resolveRootScope(schema)!;
    expect(scopeValueToName(schema, scope).get(-1n)).toBe('title');
  });

  test('drops a value two different names both bind to at this position', () => {
    const schema = CDDL.compile('p = { ? &(a: 1) => tstr, ? &(b: 1) => int }');
    const scope = resolveRootScope(schema)!;
    expect(scopeValueToName(schema, scope).has(1n)).toBe(false);
  });
});

describe('resolveValueEnumName: a choice that accepts the same integer under no name blocks the label', () => {
  const resolve = (cddl: string, value: bigint): string | undefined => {
    const schema = CDDL.compile(cddl);
    return resolveValueEnumName(schema, resolveRootScope(schema)!, 1n, value);
  };

  test.each(['uint', 'int', 'nint', 'number', 'integer', 'unsigned', 'any'])(
    'a prelude `%s` alternative',
    (prelude) => {
      expect(resolve(`root = { 1: &(A: 1, B: -1) / ${prelude} }`, 1n)).toBe(
        undefined
      );
      expect(resolve(`root = { 1: &(A: 1, B: -1) / ${prelude} }`, -1n)).toBe(
        undefined
      );
    }
  );

  test('a range entry inside the enum group itself', () => {
    expect(resolve('root = { 1: &(A: 1, reserved: 0..10) }', 1n)).toBe(
      undefined
    );
  });

  test('a uint-typed entry inside the enum group itself', () => {
    expect(resolve('root = { 1: &(A: 1, other: uint) }', 1n)).toBe(undefined);
  });

  test('a user rule that is itself an integer type', () => {
    expect(resolve('root = { 1: &(A: 1) / code }\ncode = uint', 1n)).toBe(
      undefined
    );
  });

  test('an unnamed literal of the same value cancels only that value', () => {
    const cddl = 'root = { 1: &(A: 1, B: 2) / 1 }';
    expect(resolve(cddl, 1n)).toBe(undefined);
    expect(resolve(cddl, 2n)).toBe('B');
  });

  test('no regression: non-integer prelude types (bool/tstr/float/bstr/null) still do not block', () => {
    for (const other of ['bool', 'tstr', 'float', 'bstr', 'null'])
      expect(resolve(`root = { 1: &(A: 1) / ${other} }`, 1n)).toBe('A');
  });

  test('a genuine empty-string name is a real name, not the unnamed placeholder', () => {
    expect(resolve('root = { 1: &("": 1) }', 1n)).toBe('');
  });

  test('an unnamed literal still cancels a genuine empty-string name for the same value', () => {
    expect(resolve('root = { 1: &("": 1) / 1 }', 1n)).toBe(undefined);
  });

  test('no regression: a user rule shadowing a prelude name is resolved as defined', () => {
    expect(resolve('root = { 1: &(A: 1) / uint }\nuint = tstr', 1n)).toBe('A');
  });
});

describe('resolveValueEnumName', () => {
  test("names a value whose entry's own type is a closed &(name: value) choice", () => {
    const schema = CDDL.compile(
      'root = { ? &(alg: -4) => &(A: 1, B: 2, C: 3) }'
    );
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 2n)).toBe('B');
  });

  test('undefined for a value the enum never names', () => {
    const schema = CDDL.compile('root = { ? &(alg: -4) => &(A: 1, B: 2) }');
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 99n)).toBeUndefined();
  });

  test("undefined when the entry's own value type isn't an enum at all", () => {
    const schema = CDDL.compile('root = { ? &(group_mode: -3) => bool }');
    const scope = resolveRootScope(schema)!;
    expect(
      resolveValueEnumName(schema, scope, 'group_mode', 1n)
    ).toBeUndefined();
  });

  test('resolves through a bare reference to a named-enum rule', () => {
    const schema = CDDL.compile(
      'root = { ? &(alg: -4) => cose-alg }\ncose-alg = &(A: 1, B: 2)'
    );
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 1n)).toBe('A');
  });

  test('two different names both claiming the same value excludes only that value', () => {
    const schema = CDDL.compile(
      'root = { ? &(alg: -4) => &(A: 1, B: 1, C: 3) }'
    );
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 1n)).toBeUndefined();
    expect(resolveValueEnumName(schema, scope, 'alg', 3n)).toBe('C');
  });

  test('a controlled type alternative forces the whole entry unresolved, not just skipped', () => {
    const schema = CDDL.compile(
      'root = { ? &(alg: -4) => (&(A: 1) / (int .size 1)) }'
    );
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 1n)).toBeUndefined();
  });

  test('`any` alongside an enum alternative blocks resolution — the value could equally be unnamed', () => {
    const schema = CDDL.compile('root = { ? &(alg: -4) => &(A: 1) / any }');
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 1n)).toBeUndefined();
  });

  test('no regression: a scalar prelude type (bool/tstr/…) alongside an enum alternative does not block it', () => {
    const schema = CDDL.compile('root = { ? &(alg: -4) => &(A: 1) / bool }');
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 1n)).toBe('A');
  });

  test('a sibling alternative with a conflicting literal-int key still blocks resolution (matchingValueType safety)', () => {
    const schema = CDDL.compile(
      'root = { kind: "raw", -4: any }\n' +
        '     / { kind: "named", &(alg: -4) => &(A: 1) }'
    );
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 1n)).toBeUndefined();
  });

  test('undefined when scope has an open/wildcard member key', () => {
    const schema = CDDL.compile(
      'root = { * tstr => any } / { ? &(alg: -4) => &(A: 1) }'
    );
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 1n)).toBeUndefined();
  });
});

describe('a named entry declared before a wildcard, in the same alternative, is safe (RFC 9290-style "any other field" idiom)', () => {
  // cddl/validator.ts's own mapSeq assigns each wire key to a group entry
  // greedily, in *declaration order* — an earlier entry always gets first
  // claim on a key it can match, before a later, more permissive one (a
  // wildcard) ever sees it (mapSeq's own doc: "put wildcard members last").
  // So a name declared before the wildcard is exactly as safe as if the
  // wildcard weren't there; only one declared at or after it isn't.
  test('scopeNameToValue includes a name declared before a same-alternative wildcard', () => {
    const schema = CDDL.compile(
      'root = { ? &(hkdf: -1) => int, * (tstr / int) => any }'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope).get('hkdf')).toBe(-1n);
  });

  test('scopeNameToValue excludes a name declared after a same-alternative wildcard', () => {
    const schema = CDDL.compile(
      'root = { * (tstr / int) => any, ? &(hkdf: -1) => int }'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope).has('hkdf')).toBe(false);
  });

  test('a bareword entry declared before the wildcard still resolves its own nested scope', () => {
    const schema = CDDL.compile(
      'root = { data: { ? &(title: -1) => tstr }, * tstr => any }'
    );
    const root = resolveRootScope(schema)!;
    const nested = resolveNestedScope(schema, root, 'data');
    expect(nested).toBeDefined();
    expect(scopeNameToValue(schema, nested!).get('title')).toBe(-1n);
  });

  test('a bareword entry declared after the wildcard does not resolve a nested scope', () => {
    const schema = CDDL.compile(
      'root = { * tstr => any, data: { ? &(title: -1) => tstr } }'
    );
    const root = resolveRootScope(schema)!;
    expect(resolveNestedScope(schema, root, 'data')).toBeUndefined();
  });

  test('resolveValueEnumName resolves a value whose own enum entry is declared before the wildcard', () => {
    const schema = CDDL.compile(
      'root = { ? &(alg: -4) => &(A: 1), * (tstr / int) => any }'
    );
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 'alg', 1n)).toBe('A');
  });

  test('no regression: a wildcard in a *different* alternative still blocks everything, order notwithstanding', () => {
    // Declaration order only matters *within* one alternative — across a
    // `/` choice, the existing discriminated-union safety (an open
    // alternative anywhere still poisons the whole scope) is unaffected.
    const schema = CDDL.compile(
      'root = { ? &(hkdf: -1) => int } / { * tstr => any }'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope).has('hkdf')).toBe(false);
  });

  test('no regression: a wildcard entry that is itself the only entry in its own alternative still excludes an unrelated name from another alternative', () => {
    const schema = CDDL.compile(
      'root = { * tstr => any } / { ? &(hkdf: -1) => int }'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope).has('hkdf')).toBe(false);
  });
});

describe("respectDeclarationOrder: false — fromJS()'s own string-key conversion must not be loosened by declaration order", () => {
  // A name declared before a same-alternative wildcard is safe to *annotate*
  // an already-decoded integer with (the wildcard, matched against a wire
  // key of a different, incompatible type or claimed after the named entry
  // by validator.ts's own greedy matching, could never have consumed it
  // first). But converting a JS *string* property into that name's integer
  // value is a different question: if the wildcard's own key type also
  // matches text, that exact string is just as validly the wildcard's own
  // literal text key — declaration order doesn't disambiguate which shape
  // the author meant, since fromJS() is choosing the shape, not discovering
  // it from an already-typed wire value.
  test('scopeNameToValue(..., false) excludes a name declared before a same-alternative wildcard whose key type matches text', () => {
    const schema = CDDL.compile(
      'root = { ? &(title: -1) => tstr, * tstr => any }'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope, false).has('title')).toBe(false);
  });

  test('scopeNameToValue(..., true) (the default) still includes it — the relaxed behavior is unchanged for the annotation direction', () => {
    const schema = CDDL.compile(
      'root = { ? &(title: -1) => tstr, * tstr => any }'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope).get('title')).toBe(-1n);
    expect(scopeNameToValue(schema, scope, true).get('title')).toBe(-1n);
  });

  test('resolveNestedScope(..., false) does not descend via a name declared before a same-alternative wildcard', () => {
    const schema = CDDL.compile(
      'root = { ? &(title: -1) => { ? &(sub: 1) => int }, * tstr => any }'
    );
    const scope = resolveRootScope(schema)!;
    expect(resolveNestedScope(schema, scope, 'title', false)).toBeUndefined();
    // The relaxed default still resolves it — this is only unsafe for the
    // JS-string-key-conversion direction.
    expect(resolveNestedScope(schema, scope, 'title', true)).toBeDefined();
  });

  test('no regression: respectDeclarationOrder: false still includes a name whose alternative has no open entry at all', () => {
    const schema = CDDL.compile('root = { ? &(title: -1) => tstr }');
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope, false).get('title')).toBe(-1n);
  });

  test('no regression: respectDeclarationOrder: false still excludes a name declared after the wildcard, same as the relaxed default', () => {
    const schema = CDDL.compile(
      'root = { * tstr => any, ? &(title: -1) => tstr }'
    );
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope, false).has('title')).toBe(false);
    expect(scopeNameToValue(schema, scope, true).has('title')).toBe(false);
  });
});

describe('a literal integer member key with no name of its own can still resolve its value type by raw value', () => {
  // `root = { 1: &(AES-CCM-16-64-128: 10) }` — key `1` is a bare literal
  // int, never eRefKeys-eligible itself (nothing names it), but its value's
  // own type is still a closed, literal `&(name: value)` choice, resolvable
  // by matching the raw key value `1n` directly instead of via a name.
  test('resolveValueEnumName resolves a value whose key is a literal integer with no name', () => {
    const schema = CDDL.compile('root = { 1: &(AES-CCM-16-64-128: 10) }');
    const scope = resolveRootScope(schema)!;
    expect(resolveValueEnumName(schema, scope, 1n, 10n)).toBe(
      'AES-CCM-16-64-128'
    );
  });

  test('resolveNestedScope descends into a nested map governed by a literal integer key with no name', () => {
    const schema = CDDL.compile('root = { 1: { ? &(title: -1) => tstr } }');
    const scope = resolveRootScope(schema)!;
    const nested = resolveNestedScope(schema, scope, 1n);
    expect(nested).toBeDefined();
    expect(scopeNameToValue(schema, nested!).get('title')).toBe(-1n);
  });

  test('a differently-spelled &(name: value) entry for the same value is still matched by raw value', () => {
    const schema =
      CDDL.compile(`root = { 1: &(AES-CCM-16-64-128: 10) } / { ? &(data: 1) => tstr }
`);
    const scope = resolveRootScope(schema)!;
    // Matching by the raw value `1n` should find the value type from
    // *either* alternative that governs wire key `1` — not just the one
    // spelled as a literal `1:`.
    expect(resolveValueEnumName(schema, scope, 1n, 10n)).toBe(
      'AES-CCM-16-64-128'
    );
  });
});

describe('fixed-shape array positions', () => {
  const names = (
    schema: ReturnType<typeof CDDL.compile>,
    pos: { map?: Parameters<typeof scopeNameToValue>[1] }
  ): Record<string, bigint> =>
    pos.map ? Object.fromEntries(scopeNameToValue(schema, pos.map)) : {};

  test('an array root resolves each element positionally', () => {
    const schema = CDDL.compile(
      'root = [protected: bstr, unprotected: hdr, payload: bstr]\n' +
        'hdr = { ? &(alg: 1) => int, ? &(kid: 4) => bstr }'
    );
    const root = resolveRootPosition(schema);
    expect(root.map).toBeUndefined();
    expect(root.array?.elementTypes.map((a) => a.length)).toEqual([3]);
    expect(resolveElementPosition(schema, root.array!, 0, 3).map).toBe(
      undefined
    );
    expect(
      names(schema, resolveElementPosition(schema, root.array!, 1, 3))
    ).toEqual({ alg: 1n, kid: 4n });
  });

  test('a bare group reference is spliced in, not counted as one element', () => {
    const schema = CDDL.compile(
      'root = [Headers, payload: bstr]\n' +
        'Headers = (protected: bstr, unprotected: { ? &(kid: 4) => bstr })'
    );
    const root = resolveRootPosition(schema);
    expect(root.array?.elementTypes.map((a) => a.length)).toEqual([3]);
    expect(
      names(schema, resolveElementPosition(schema, root.array!, 1, 3))
    ).toEqual({ kid: 4n });
  });

  test('an entry with an occurrence indicator leaves the array unresolved', () => {
    for (const cddl of [
      'root = [* { ? &(kid: 4) => bstr }]',
      'root = [int, ? { ? &(kid: 4) => bstr }]',
      'root = [+ int, { ? &(kid: 4) => bstr }]',
    ])
      expect(resolveRootPosition(CDDL.compile(cddl)).array).toBeUndefined();
  });

  test('only alternatives of the actual length apply to an element', () => {
    const schema = CDDL.compile(
      'root = [{ ? &(a: 1) => int }] / [int, { ? &(b: 2) => int }]'
    );
    const arr = resolveRootPosition(schema).array!;
    expect(names(schema, resolveElementPosition(schema, arr, 0, 1))).toEqual({
      a: 1n,
    });
    expect(names(schema, resolveElementPosition(schema, arr, 1, 2))).toEqual({
      b: 2n,
    });
    expect(resolveElementPosition(schema, arr, 0, 2).map).toBeUndefined();
    expect(resolveElementPosition(schema, arr, 0, 3)).toEqual({});
  });

  test('an `any` (or otherwise open) alternative leaves the array unresolved', () => {
    for (const cddl of [
      'root = [{ ? &(a: 1) => int }] / any',
      'root = [{ ? &(a: 1) => int }] / #4',
      'root = [G<int>, { ? &(a: 1) => int }]\nG<T> = (x: T)',
    ])
      expect(resolveRootPosition(CDDL.compile(cddl)).array).toBeUndefined();
  });

  test('a map-or-array choice resolves both sides independently', () => {
    const schema = CDDL.compile(
      'root = { ? &(a: 1) => int } / [{ ? &(b: 2) => int }]'
    );
    const root = resolveRootPosition(schema);
    expect(names(schema, root)).toEqual({ a: 1n });
    expect(
      names(schema, resolveElementPosition(schema, root.array!, 0, 1))
    ).toEqual({ b: 2n });
  });

  test('a nested array value is resolved through its map key', () => {
    const schema = CDDL.compile(
      'root = { ? &(list: 1) => [int, { ? &(x: 2) => int }] }'
    );
    const nested = resolveNestedPosition(
      schema,
      resolveRootScope(schema)!,
      'list'
    );
    expect(
      names(schema, resolveElementPosition(schema, nested.array!, 1, 2))
    ).toEqual({ x: 2n });
  });
});

describe('several open alternatives that all bind a name before their own wildcard', () => {
  // `? ( a // b )` inside a map splits it into two alternatives, each ending
  // with the same wildcard — e.g. RFC 9052's header_map.
  const SCHEMA =
    'root = { ? &(kid: 4) => bstr, ? &(hdr: 7) => { ? &(x: 2) => int },' +
    ' ? ( &(IV: 5) => bstr // &(Partial-IV: 6) => bstr ), * tstr => any }';

  test('a name every open alternative binds ahead of its wildcard is kept', () => {
    const schema = CDDL.compile(SCHEMA);
    const scope = resolveRootScope(schema)!;
    expect(scope.alternatives).toHaveLength(2);
    const n2v = scopeNameToValue(schema, scope);
    expect(n2v.get('kid')).toBe(4n);
    expect(resolveNestedScope(schema, scope, 'hdr')).toBeDefined();
  });

  test('a name only one open alternative binds is still excluded', () => {
    const schema = CDDL.compile(SCHEMA);
    const n2v = scopeNameToValue(schema, resolveRootScope(schema)!);
    expect(n2v.has('IV')).toBe(false);
    expect(n2v.has('Partial-IV')).toBe(false);
  });

  test("fromJS()'s strict mode still excludes every name", () => {
    const schema = CDDL.compile(SCHEMA);
    const scope = resolveRootScope(schema)!;
    expect(scopeNameToValue(schema, scope, false).size).toBe(0);
    expect(resolveNestedScope(schema, scope, 'hdr', false)).toBeUndefined();
  });
});
