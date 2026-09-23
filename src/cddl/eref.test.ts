import { describe, expect, test } from 'vitest';
import { CDDL } from './index';
import { getERefTables } from './eref';
import { CBOR } from '../cbor';
import { CddlMismatchError } from './errors';
import { MapEntries } from '../mapEntries';
import { CBOR_OMIT } from '../types';
import type { FromJSOptions, ToCDNOptions } from '../types';

// A `problem-details`-style schema (this library's own choice of a
// realistic example — the &(name: value) member-key idiom itself isn't in
// the draft; see cddl/eref.ts's own module doc, and the CDDL.compile(...)
// tests further down that use the draft's own plain-constant-rule example
// verbatim) — kept minimal, isolating the `&(name: value)` naming idiom
// under test from unrelated CDDL features (generics, `.and`, `~uri` unwrap).
const PROBLEM_DETAILS_CDDL = `
problem-details = {
  ? &(title: -1) => tstr
  ? &(detail: -2) => tstr
  ? &(instance: -3) => tstr
  ? &(response-code: -4) => uint
}
`;

describe('getERefTables', () => {
  test('collects named &(...) group entries from the whole schema', () => {
    const schema = CDDL.compile(PROBLEM_DETAILS_CDDL);
    const tables = getERefTables(schema);
    expect(tables.byName.get('title')).toBe(-1n);
    expect(tables.byName.get('detail')).toBe(-2n);
    expect(tables.byName.get('instance')).toBe(-3n);
    expect(tables.byName.get('response-code')).toBe(-4n);
    expect(tables.byValue.get(-1n)).toBe('title');
    expect(tables.byValue.get(-2n)).toBe('detail');
    expect(tables.ambiguousNames.size).toBe(0);
  });

  test('collects a constant rule into byName only, never byValue', () => {
    // A general constant rule is a fine `e'hkdf'` *parse* target, but on its
    // own says nothing about whether -1 *means* "hkdf" wherever it shows up
    // as a map key elsewhere — see the module doc's Scope note.
    const schema = CDDL.compile('hkdf = -1');
    const tables = getERefTables(schema);
    expect(tables.byName.get('hkdf')).toBe(-1n);
    expect(tables.byValue.has(-1n)).toBe(false);
  });

  test('a /= choice extension of a constant rule makes the name ambiguous, not a second definition', () => {
    // `x = 1` plus `x /= 2` makes `x` denote `1 / 2` — a 2-way choice, not
    // a single constant — so `e'x'` must not silently resolve to whichever
    // definition happened to be seen first.
    const schema = CDDL.compile('x = 1\nx /= 2');
    const tables = getERefTables(schema);
    expect(tables.byName.has('x')).toBe(false);
    expect(tables.ambiguousNames.has('x')).toBe(true);
  });

  test('a //= choice extension of a constant rule is likewise treated as ambiguous', () => {
    const schema = CDDL.compile('x = 1\nx //= 2');
    const tables = getERefTables(schema);
    expect(tables.byName.has('x')).toBe(false);
    expect(tables.ambiguousNames.has('x')).toBe(true);
  });

  test('a /= extension that repeats the same literal is not ambiguous', () => {
    // Redundant, but the two definitions genuinely agree — a single value,
    // same as if only one of them existed.
    const schema = CDDL.compile('x = 1\nx /= 1');
    const tables = getERefTables(schema);
    expect(tables.byName.get('x')).toBe(1n);
    expect(tables.ambiguousNames.has('x')).toBe(false);
  });

  test("e'x' throws (not silently resolves to the base definition) once extended", () => {
    const schema = CDDL.compile('x = 1\nx /= 2');
    expect(() => CBOR.fromCDN("e'x'", { cddl: schema })).toThrow(SyntaxError);
  });

  test('a /= extension referenced at a member-key position never feeds byValue, either', () => {
    const schema = CDDL.compile('p = { ? x => bool }\nx = 1\nx /= 2');
    const tables = getERefTables(schema);
    expect(tables.byValue.has(1n)).toBe(false);
    expect(tables.byValue.has(2n)).toBe(false);
  });

  test('a /= extension whose own body is not a single integer literal also forces the name out', () => {
    // `x` denotes `1 / tstr` now — not reliably an integer at all, so
    // silently ignoring the non-integer side (as a naive rule-by-rule
    // literalIntOfEntry() check would) and resolving e'x' to 1 anyway
    // would be just as wrong as the two-different-integers ambiguous case.
    const schema = CDDL.compile('root = any\nx = 1\nx /= tstr');
    const tables = getERefTables(schema);
    expect(tables.byName.has('x')).toBe(false);
    expect(tables.ambiguousNames.has('x')).toBe(true);
    expect(() => CBOR.fromCDN("e'x'", { cddl: schema, silent: true })).toThrow(
      SyntaxError
    );
  });

  test('a /= extension that is itself a multi-alternative choice also forces the name out', () => {
    // `x /= 2 / 3` is a single `/=` statement whose own body already has
    // two alternatives — literalIntOfEntry() rejects it (not a single
    // type1), so this must be treated the same as separate `x /= 2` and
    // `x /= 3` extensions would be, not silently ignored.
    const schema = CDDL.compile('root = any\nx = 1\nx /= 2 / 3');
    const tables = getERefTables(schema);
    expect(tables.byName.has('x')).toBe(false);
    expect(tables.ambiguousNames.has('x')).toBe(true);
  });

  test('a rule with no integer-literal definition at all is not a constant-rule candidate (no regression)', () => {
    // A named map/group rule like `problem-details` below was never a
    // constant-rule candidate in the first place — collecting its own
    // &(name: value) member-key entries must not also flag *it* as
    // "forced ambiguous" just because its own body isn't a literal int.
    const schema = CDDL.compile(PROBLEM_DETAILS_CDDL);
    const tables = getERefTables(schema);
    expect(tables.ambiguousNames.size).toBe(0);
  });

  test('a bare reference to a constant rule, at a member-key position, feeds byValue too', () => {
    // `? group_mode => bool` pins the entry's key to group_mode's value (3)
    // just as narrowly as `&(name: value)` does — the schema requires
    // exactly that key, not merely a type the value happens to satisfy.
    const schema = CDDL.compile('p = { ? group_mode => bool }\ngroup_mode = 3');
    const tables = getERefTables(schema);
    expect(tables.byName.get('group_mode')).toBe(3n);
    expect(tables.byValue.get(3n)).toBe('group_mode');
  });

  test('the same constant rule referenced only as a value type still contributes to byName only', () => {
    const schema = CDDL.compile('p = { ? foo: group_mode }\ngroup_mode = 3');
    const tables = getERefTables(schema);
    expect(tables.byName.get('group_mode')).toBe(3n);
    expect(tables.byValue.has(3n)).toBe(false);
  });

  test('an ambiguous name referenced at a member-key position still never feeds byValue', () => {
    // 'x' is bound to two different values (1 via the constant rule, 2 via
    // &(x: 2)) — ambiguous everywhere, so even though `x` sits at a
    // member-key position here, it must not resolve to a value that would
    // make the annotated CDN unparseable.
    const schema = CDDL.compile(
      'p = { ? x => bool }\nx = 1\nq = { ? &(x: 2) => int }'
    );
    const tables = getERefTables(schema);
    expect(tables.ambiguousNames.has('x')).toBe(true);
    expect(tables.byValue.has(1n)).toBe(false);
    expect(tables.byValue.has(2n)).toBe(false);
  });

  test('a name bound to two different values is ambiguous, and excluded from byValue too', () => {
    const schema = CDDL.compile(
      'p = { ? &(x: 1) => tstr, ? &(y: 2) => tstr }\nq = { ? &(x: 3) => int }'
    );
    const tables = getERefTables(schema);
    expect(tables.byName.has('x')).toBe(false);
    expect(tables.ambiguousNames.has('x')).toBe(true);
    // Neither of 'x''s two values may be annotated back to 'x' — doing so
    // would produce `e'x'` notation that fails to re-parse (ambiguous).
    expect(tables.byValue.has(1n)).toBe(false);
    expect(tables.byValue.has(3n)).toBe(false);
    // 'y' is unaffected.
    expect(tables.byName.get('y')).toBe(2n);
    expect(tables.byValue.get(2n)).toBe('y');
  });

  test('&(...) used as a value (not a member key) contributes to byName only', () => {
    const schema = CDDL.compile('p = { ? foo: &(bar: 42) }');
    const tables = getERefTables(schema);
    expect(tables.byName.get('bar')).toBe(42n);
    expect(tables.byValue.has(42n)).toBe(false);
  });

  test("a nested map's own member-key position still counts, even inside a value", () => {
    // The outer `foo:` entry's *value* is itself a map; `&(bar: 42)` is at
    // *that* map's own member-key position, independent of the fact that
    // the whole nested map sits inside an outer value.
    const schema = CDDL.compile('p = { ? foo: { ? &(bar: 42) => tstr } }');
    const tables = getERefTables(schema);
    expect(tables.byValue.get(42n)).toBe('bar');
  });

  test('a value named by two different names is excluded from byValue only', () => {
    const schema = CDDL.compile('p = { ? &(a: 1) => tstr, ? &(b: 1) => int }');
    const tables = getERefTables(schema);
    // Each name still resolves individually (byName is unaffected by a
    // *value* collision — only a *name* bound to two different values is
    // ambiguous there).
    expect(tables.byName.get('a')).toBe(1n);
    expect(tables.byName.get('b')).toBe(1n);
    expect(tables.byValue.has(1n)).toBe(false);
  });

  test('non-integer-literal entries are ignored', () => {
    const schema = CDDL.compile(
      'p = { ? &(a: tstr) => int, ? &(b: 1..2) => int }'
    );
    const tables = getERefTables(schema);
    expect(tables.byName.size).toBe(0);
  });

  test('results are cached per schema instance', () => {
    const schema = CDDL.compile('hkdf = -1');
    expect(getERefTables(schema)).toBe(getERefTables(schema));
  });

  describe('ruleConstantValues', () => {
    test('includes a genuine `name = <int>` constant rule', () => {
      const schema = CDDL.compile('hkdf = -1');
      const tables = getERefTables(schema);
      expect(tables.ruleConstantValues.get('hkdf')).toBe(-1n);
    });

    // The exact reported bug: an &(...) enum *label* of the same spelling
    // (used as a plain group-entry name, nothing to do with the rule of
    // the same name) also feeds byName/nameToValue — a correct, deliberate
    // design for e'name' CDN *parsing* (any spelling bound to an integer
    // anywhere should resolve) — but ruleConstantValues must stay narrow:
    // only an actual `name = <int>` rule definition, never a same-spelled
    // enum label elsewhere.
    test('excludes a name that is only ever used as an &(...) enum label, never defined as a rule', () => {
      const schema = CDDL.compile('other = { &(keytype: 2) => int }');
      const tables = getERefTables(schema);
      expect(tables.byName.get('keytype')).toBe(2n); // byName still sees it
      expect(tables.ruleConstantValues.has('keytype')).toBe(false); // this doesn't
    });

    test('a rule defined as a non-integer type keeps its own definition, even when an unrelated enum label binds the same spelling to an integer', () => {
      const schema = CDDL.compile(
        'keytype = tstr\nother = { &(keytype: 2) => int }'
      );
      const tables = getERefTables(schema);
      expect(tables.byName.get('keytype')).toBe(2n); // from the enum label
      expect(tables.ruleConstantValues.has('keytype')).toBe(false); // keytype's own rule isn't an int
    });

    test("an unrelated enum label doesn't change a genuine constant rule's own value", () => {
      const schema = CDDL.compile(
        'group_mode = 3\nother = { &(group_mode: 99) => int }'
      );
      const tables = getERefTables(schema);
      expect(tables.ruleConstantValues.get('group_mode')).toBe(3n);
    });
  });
});

describe("e'...' CDN parsing", () => {
  test('resolves a named entry to its integer value', () => {
    const item = CBOR.fromCDN('{e\'title\': "oops"}', {
      cddl: PROBLEM_DETAILS_CDDL,
    });
    // eRefKeys: false here to check the underlying *value* this test is
    // actually about — toJS()'s own default key-naming has its own tests
    // below.
    expect(item.toJS({ mapAs: 'object', eRefKeys: false })).toEqual({
      '-1': 'oops',
    });
  });

  test("explicit e'title' syntax also defaults to the name in toJS()", () => {
    const item = CBOR.fromCDN(`{e'title': "Not Found"}`, {
      cddl: PROBLEM_DETAILS_CDDL,
    });
    expect(item.toJS()).toEqual({ title: 'Not Found' });
  });

  test('an undefined name throws SyntaxError', () => {
    expect(() =>
      CBOR.fromCDN("{e'nope': 1}", { cddl: PROBLEM_DETAILS_CDDL })
    ).toThrow(SyntaxError);
  });

  test('a general constant rule still resolves explicitly, even though it never drives annotation', () => {
    const schema = CDDL.compile('p = {* any => any}\nhkdf = -1');
    const item = CBOR.fromCDN("{e'hkdf': 1}", { cddl: schema });
    expect(item.toJS({ mapAs: 'object', eRefKeys: false })).toEqual({
      '-1': 1,
    });
    // But the reverse never happens automatically: a plain -1 key is not
    // auto-annotated back to `e'hkdf'` (see the `eref.ts` module doc) — a
    // general constant rule says nothing about whether -1 *means* "hkdf"
    // wherever -1 happens to show up; only an explicitly named member-key
    // position does.
    expect(CBOR.fromCDN('{-1: 1}', { cddl: schema }).toCDN()).toBe('{-1:1}');
  });

  test("without a cddl option, e'...' is an unresolved app-extension", () => {
    const item = CBOR.fromCDN("e'title'", { silent: true });
    expect(item.toCDN()).toBe("e'title'");
  });

  test("resolves in value position too, and in draft-ietf-cbor-edn-e-ref's own example (constant rules used as both key and value)", () => {
    // Verbatim from the draft's own "Motivation and Requirements" example
    // (https://datatracker.ietf.org/doc/draft-ietf-cbor-edn-e-ref/, §2.2):
    // every name here is a plain constant rule (`name = value`), not a
    // `&(name: value)` member-key entry — and two of them (AES-CCM-16-64-128,
    // HMAC-256-256) are used as a map *value*, not a key at all.
    // `parseAppString()` doesn't care which position it's called from, so
    // this direction (parsing explicit `e'...'` CDN) works via `byName`
    // alone — this just closes a test-coverage gap (the earlier
    // constant-rule test above only exercises key position). The *keys*
    // parsed this way don't keep that label past validation, though: `l`'s
    // own type (`{* any => any}`) never names any of these constants at a
    // member-key position, so `annotateERefKeys()` downgrades them back to
    // plain integers — keeping the label would make a `toJS()` →
    // `fromJS()` round trip silently turn the key into ordinary text
    // instead (see `annotateERefKeys()`'s own doc). A *value*'s label is
    // untouched either way — annotation only ever replaces a map key.
    const schema = CDDL.compile(`
      l = {* any => any}
      hkdf = -1
      group_mode = -3
      gp_enc_alg = -4
      HMAC-256-256 = 5
      AES-CCM-16-64-128 = 10
    `);
    const item = CBOR.fromCDN(
      `{
        e'group_mode' : true,
        e'gp_enc_alg' : e'AES-CCM-16-64-128',
              e'hkdf' : e'HMAC-256-256'
      }`,
      { cddl: schema }
    );
    expect(item.toCDN()).toBe(
      `{-3:true,-4:e'AES-CCM-16-64-128',-1:e'HMAC-256-256'}`
    );
    // mapAs: 'entries' converts each key through the ordinary `_toJS()`
    // path, which stays numeric for a plain CborUint/CborNint — and a
    // value's e-ref annotation (if any) likewise returns its underlying
    // integer, not a name (see `extensions/eref.ts`). eRefKeys: false isn't
    // needed for this assertion either way.
    expect(item.toJS({ mapAs: 'entries' })).toEqual(
      MapEntries.from([
        [-3, true],
        [-4, 10],
        [-1, 5],
      ])
    );
  });

  test("toJS() on the draft's own example: neither the keys nor the values keep their e'...' label", () => {
    // The map's KEYS were parsed directly as `e'...'` (parseAppString()
    // builds a CborERefUint/Nint node right there, independent of
    // position), but `annotateERefKeys()` downgrades them back to plain
    // integers once validated, since `l`'s own type never names any of
    // them at a member-key position — see the test just above. The VALUES
    // were *also* parsed as `e'...'` nodes, and keep that label (annotation
    // never touches a value), but `toJS()` still deliberately returns their
    // plain integer, not the name — a value is data, not a key, and the
    // draft's own example (§2) says this map is equivalent to `{-3: true,
    // -4: 10, -1: 5}`; converting a value to a *string* here would silently
    // change what a consumer reading `toJS()` sees the algorithm/mode as (a
    // name, not the registered integer), and would round-trip wrong
    // through `fromJS()` besides, since `fromJS()` has no reverse (string
    // value → integer) direction — see `ToJSOptions.eRefKeys`'s own doc.
    // Since no key keeps a name either now, the whole map isn't
    // object-eligible — 'auto' falls back to MapEntries, same as
    // `mapAs: 'entries'` above.
    const schema = CDDL.compile(`
      l = {* any => any}
      hkdf = -1
      group_mode = -3
      gp_enc_alg = -4
      HMAC-256-256 = 5
      AES-CCM-16-64-128 = 10
    `);
    const item = CBOR.fromCDN(
      `{
        e'group_mode' : true,
        e'gp_enc_alg' : e'AES-CCM-16-64-128',
              e'hkdf' : e'HMAC-256-256'
      }`,
      { cddl: schema }
    );
    expect(item.toJS()).toEqual(
      MapEntries.from([
        [-3, true],
        [-4, 10],
        [-1, 5],
      ])
    );
  });

  test('a general constant rule does not auto-annotate raw bytes at all — not as a key, and not as a value', () => {
    // Unlike the previous test (which parses explicit `e'...'` CDN text —
    // parseAppString() resolves a name via byName regardless of position),
    // starting from bare integers exercises the *annotation* path
    // (annotateERefKeys(), via byValue) — and a plain constant rule never
    // populates byValue (see the module doc's Scope note), so nothing here
    // is annotated at all, whether it would-be name a key or a value.
    const schema = CDDL.compile(`
      l = {* any => any}
      hkdf = -1
      group_mode = -3
      gp_enc_alg = -4
      HMAC-256-256 = 5
      AES-CCM-16-64-128 = 10
    `);
    const item = CBOR.fromCDN('{-3: true, -4: 10, -1: 5}', { cddl: schema });
    expect(item.toCDN()).toBe('{-3:true,-4:10,-1:5}');
    expect(item.toJS()).toBeInstanceOf(MapEntries);
  });
});

describe('post-validation e-ref annotation', () => {
  test("plain -1 written directly is annotated and round-trips as e'title'", () => {
    const item = CBOR.fromCDN('{-1: "oops"}', { cddl: PROBLEM_DETAILS_CDDL });
    expect(item.toCDN()).toBe(`{e'title':"oops"}`);
  });

  test('appPrefix: false suppresses e-ref notation', () => {
    const item = CBOR.fromCDN('{-1: "oops"}', { cddl: PROBLEM_DETAILS_CDDL });
    expect(item.toCDN({ appPrefix: false })).toBe('{-1:"oops"}');
  });

  test('a bare constant-rule reference at a member-key position auto-annotates from raw bytes, mixed with &(name: value) entries in the same map', () => {
    // Mirrors a real reported case: title/detail (via &(name: value)) and
    // group_mode/gp_enc_alg (via a bare `name => type` reference to a plain
    // constant rule) all sit at a member-key position in the same schema,
    // so all four round-trip as e'...' from a fresh decode — not just the
    // &(name: value) ones — and toJS() produces a single plain object
    // instead of falling back to MapEntries because one of the five keys
    // wasn't object-eligible.
    const schema = CDDL.compile(`
      problem-details = {
        ? &(title: -1) => tstr
        ? &(detail: -2) => tstr
        ? group_mode => bool
        ? gp_enc_alg => uint
      }
      group_mode = 3
      gp_enc_alg = 4
      HMAC-256-256 = 5
    `);
    const bytes = CBOR.fromCDN(
      `{
        e'title': "Not Found",
        e'detail': "The requested resource could not be located.",
        e'group_mode': true,
        e'gp_enc_alg': e'HMAC-256-256'
      }`,
      { cddl: schema }
    ).toCBOR();
    // Decoding fresh from bytes (no e'...' anywhere in the source) exercises
    // annotateERefKeys(), not parseAppString() — the actual gap this fixes.
    const item = CBOR.fromCBOR(bytes, { cddl: schema });
    expect(item.toCDN()).toBe(
      `{e'title':"Not Found",e'detail':"The requested resource could not be located.",e'group_mode':true,e'gp_enc_alg':5}`
    );
    // gp_enc_alg's *value* (5) stays the plain integer — HMAC-256-256 is a
    // constant rule referenced in value position, not a member key, so it
    // isn't annotated at all here (see the module doc and the dedicated
    // value-position test group above).
    expect(item.toJS()).toEqual({
      title: 'Not Found',
      detail: 'The requested resource could not be located.',
      group_mode: true,
      gp_enc_alg: 5,
    });
  });

  test('fromCBOR also annotates', () => {
    const bytes = CBOR.fromCDN('{-1: "oops"}').toCBOR();
    const item = CBOR.fromCBOR(bytes, { cddl: PROBLEM_DETAILS_CDDL });
    expect(item.toCDN()).toBe(`{e'title':"oops"}`);
  });

  test('fromJS also annotates a non-text (numeric) key', () => {
    // Plain JS objects only ever have string keys — a non-text key needs
    // `MapEntries` to round-trip through `fromJS()` (a native `Map` is not
    // recognized by `fromJS()` at all — see the `eRefKeys` test group below).
    const item = CBOR.fromJS(MapEntries.from([[-1, 'oops']]), {
      cddl: PROBLEM_DETAILS_CDDL,
    });
    expect(item.toCDN()).toBe(`{e'title':"oops"}`);
  });

  test('annotation still walks into arrays and tags structurally, but never positionally labels content reached that way', () => {
    // Position-aware, matching `FromJSOptions.eRefKeys`'s own reverse
    // direction (`cddl/eRefScope.ts`'s Scope note): descent only tracks a
    // schema position through nested *map* types, never through an array
    // element or tagged item's own content, so a map reached that way gets
    // no eRefKeys-eligible names of its own — even when, as here, it's
    // nested inside a position ('list'/'tagged') the schema *does* know
    // about. The walk itself still reaches in (so a *sibling* map key at a
    // genuinely known position, like root's own 'title', is still
    // annotated) — it just never labels anything found this way.
    const schema = `root = { ? &(title: -1) => tstr, ? list: [* any], ? tagged: any }`;
    const item = CBOR.fromCDN(
      '{-1: "a", "list": [{-1: "b"}, 100({-2: "c"})], "tagged": 50({-1: "d"})}',
      { cddl: schema }
    );
    expect(item.toCDN()).toBe(
      `{e'title':"a","list":[{-1:"b"},100({-2:"c"})],"tagged":50({-1:"d"})}`
    );
  });

  test('annotation only ever replaces a map KEY — a map value or array element is left alone, even when it matches a named member-key value', () => {
    // -1 and -2 are each named (title/detail) *at a member-key position* —
    // clearly annotatable in principle — but here they appear as a map
    // *value* and as array *elements*, not as keys, so neither is touched:
    // annotation success at CDDL-validation time says nothing about
    // whether a given occurrence of -2 was actually meant as "detail" (it
    // might just be an unrelated integer that happens to equal detail's
    // value) — only a map key position carries that meaning.
    const schema = `root = { ? &(title: -1) => any, ? &(detail: -2) => any }`;
    const item = CBOR.fromCDN('{-1: -2}', { cddl: schema });
    expect(item.toCDN()).toBe(`{e'title':-2}`);
    expect(item.toJS()).toEqual({ title: -2 });

    const arr = CBOR.fromCDN('[-1, -2, "x"]', {
      cddl: `l = [* any]\n${PROBLEM_DETAILS_CDDL}`,
    });
    expect(arr.toCDN()).toBe(`[-1,-2,"x"]`);
    expect(arr.toJS()).toEqual([-1, -2, 'x']);
  });

  describe('a map value is annotated too, when its own type is a closed &(name: value) choice', () => {
    // draft-ietf-cbor-edn-e-ref's own COSE-algorithm-identifier example:
    // gp_enc_alg's own value type is &(AES-CCM-16-64-128: 10, …), a closed
    // choice of named integer constants — unlike the test above (where -2's
    // value type was `any`, saying nothing about a name at all), this
    // position's schema unambiguously names every value it could hold, so
    // labeling it is never misleading.
    const COSE_ALG_CDDL = `
      payload = {
        ? &(hkdf: -1) => &(HMAC-256-64: 4, HMAC-256-256: 5, HMAC-384-384: 6, HMAC-512-512: 7),
        ? &(group_mode: -3) => bool,
        ? &(gp_enc_alg: -4) => &(AES-CCM-16-64-128: 10, AES-CCM-16-64-256: 11)
      }
    `;

    test('a value from raw bytes gets labeled alongside its key', () => {
      const item = CBOR.fromCDN('{-3: true, -4: 10, -1: 5}', {
        cddl: COSE_ALG_CDDL,
      });
      expect(item.toCDN()).toBe(
        `{e'group_mode':true,e'gp_enc_alg':e'AES-CCM-16-64-128',e'hkdf':e'HMAC-256-256'}`
      );
    });

    test('toJS() still returns the plain integer for the value, never the name (ToJSOptions.eRefKeys only ever applies to a key)', () => {
      const item = CBOR.fromCDN('{-4: 10}', { cddl: COSE_ALG_CDDL });
      expect(item.toJS()).toEqual({ gp_enc_alg: 10 });
    });

    test('fromCBOR also labels the value, the same as fromCDN', () => {
      const bytes = CBOR.fromCDN('{-4: 11}', { cddl: COSE_ALG_CDDL }).toCBOR();
      const item = CBOR.fromCBOR(bytes, { cddl: COSE_ALG_CDDL });
      expect(item.toCDN()).toBe(`{e'gp_enc_alg':e'AES-CCM-16-64-256'}`);
    });

    test('a value the enum permits but does not literally name stays a plain integer', () => {
      // A range entry within the same enum group is a value this schema
      // position genuinely accepts, but — unlike a literal `name: <int>`
      // entry — doesn't itself propose a name for any particular value in
      // that range (see literalEnumBindings()'s own contract).
      const schema = `
        payload = {
          ? &(gp_enc_alg: -4) => &(AES-CCM-16-64-128: 10, reserved: 100..200)
        }
      `;
      const item = CBOR.fromCDN('{-4: 150}', { cddl: schema });
      expect(item.toCDN()).toBe(`{e'gp_enc_alg':150}`);
    });

    test('a named value is not labeled when a range in the same enum group also accepts it unnamed', () => {
      const item = CBOR.fromCDN('{1: 1}', {
        cddl: 'root = { 1: &(A: 1, reserved: 0..10) }',
      });
      expect(item.toCDN()).toBe('{1:1}');
    });

    test("a value named by the empty string is labeled e'' — the same as parsing it explicitly", () => {
      const cddl = 'root = { 1: &("": 1) }';
      expect(CBOR.fromCDN('{1: 1}', { cddl }).toCDN()).toBe(`{1:e''}`);
      expect(CBOR.fromCDN(`{1: e''}`, { cddl }).toCDN()).toBe(`{1:e''}`);
    });

    test('a named value is not labeled when a sibling uint alternative also accepts it unnamed', () => {
      const item = CBOR.fromCDN('{1: 1}', {
        cddl: 'root = { 1: &(A: 1) / uint }',
      });
      expect(item.toCDN()).toBe('{1:1}');
    });

    test("an explicit e'...' value written in CDN source is untouched either way (annotation never replaces an already-labeled value)", () => {
      const item = CBOR.fromCDN("{-4: e'AES-CCM-16-64-128'}", {
        cddl: COSE_ALG_CDDL,
      });
      expect(item.toCDN()).toBe(`{e'gp_enc_alg':e'AES-CCM-16-64-128'}`);
    });

    test('a name that would be schema-wide ambiguous is never used to label a value either (resolvesGloballyTo gate)', () => {
      const schema = `
        root = { ? &(gp_enc_alg: -4) => &(A: 1) }
        other = { ? &(A: 2) => int }
      `;
      const item = CBOR.fromCDN('{-4: 1}', { cddl: schema });
      // 'A' is locally unambiguous at this position (names 1), but 'A' is
      // bound to a *different* value (2) elsewhere in the schema — e'A'
      // would round-trip wrong through fromCDN(), so it stays plain,
      // exactly the same gate a key's own label goes through.
      expect(item.toCDN()).toBe("{e'gp_enc_alg':1}");
    });

    test('a decode -> toJS() -> fromJS() round trip stays byte-exact', () => {
      const decoded = CBOR.fromCDN('{-3: true, -4: 10, -1: 5}', {
        cddl: COSE_ALG_CDDL,
      });
      const js = decoded.toJS();
      expect(js).toEqual({ group_mode: true, gp_enc_alg: 10, hkdf: 5 });
      const reEncoded = CBOR.fromJS(js, { cddl: COSE_ALG_CDDL });
      expect(reEncoded.toCDN({ appPrefix: false })).toBe(
        '{-3:true,-4:10,-1:5}'
      );
    });
  });

  describe('a value is annotated even when its own key is a literal integer with no name of its own', () => {
    // `1:` here is a bare literal member key — never eRefKeys-eligible
    // itself (nothing names it) — but its value's own type is still a
    // closed, literal `&(name: value)` choice, resolvable by matching the
    // raw key value directly instead of via a name.
    const SCHEMA = 'root = { 1: &(AES-CCM-16-64-128: 10) }';

    test('raw bytes are annotated even though the key itself has no name', () => {
      const item = CBOR.fromCDN('{1: 10}', { cddl: SCHEMA });
      expect(item.toCDN()).toBe(`{1:e'AES-CCM-16-64-128'}`);
    });

    test('an explicit CDN label under a literal integer key survives a decode -> bytes -> decode round trip', () => {
      const first = CBOR.fromCDN("{1:e'AES-CCM-16-64-128'}", {
        cddl: SCHEMA,
      });
      expect(first.toCDN()).toBe(`{1:e'AES-CCM-16-64-128'}`);
      const bytes = first.toCBOR();
      const second = CBOR.fromCBOR(bytes, { cddl: SCHEMA });
      expect(second.toCDN()).toBe(`{1:e'AES-CCM-16-64-128'}`);
    });

    test('a nested map under a literal integer key is also annotated', () => {
      const schema = 'root = { 1: { ? &(title: -1) => tstr } }';
      const item = CBOR.fromCDN('{1: {-1: "hello"}}', { cddl: schema });
      expect(item.toCDN()).toBe(`{1:{e'title':"hello"}}`);
    });
  });

  describe('a name declared before a wildcard, in the same alternative, is annotated (RFC 9290-style "any other field" idiom)', () => {
    // cddl/validator.ts's own mapSeq assigns each wire key to a group entry
    // greedily, in *declaration order* — an earlier entry always gets first
    // claim on a key it can match, before a later, more permissive one (a
    // wildcard) ever sees it. RFC 9290 (Concise Problem Details) itself
    // uses exactly this pattern: named fields, then a catch-all for any
    // other extension member.
    const RFC9290_STYLE_CDDL = `
      payload = {
        ? &(hkdf: -1) => &(HMAC-256-64: 4, HMAC-256-256: 5),
        ? &(group_mode: -3) => bool,
        * (tstr / int) => any
      }
    `;

    test("an explicit e'...' key is kept labeled through Format, not downgraded", () => {
      const item = CBOR.fromCDN("{e'group_mode': true}", {
        cddl: RFC9290_STYLE_CDDL,
      });
      expect(item.toCDN()).toBe(`{e'group_mode':true}`);
    });

    test('raw bytes auto-annotate both the key and its own enum-typed value', () => {
      const item = CBOR.fromCDN('{-3: true, -1: 5}', {
        cddl: RFC9290_STYLE_CDDL,
      });
      expect(item.toCDN()).toBe(`{e'group_mode':true,e'hkdf':e'HMAC-256-256'}`);
    });

    test("fromJS() does NOT convert a named property when the wildcard's own key type also matches text — the JS string could equally be the wildcard's own literal key, and declaration order (safe for annotating an already-decoded *integer*) doesn't resolve that ambiguity for a JS *string* property", () => {
      const item = CBOR.fromJS(
        { group_mode: true },
        { cddl: RFC9290_STYLE_CDDL }
      );
      expect(item.toCDN({ appPrefix: false })).toBe('{"group_mode":true}');
    });

    test('fromJS() still converts a named property to its integer key when no wildcard/open entry exists at all in the alternative', () => {
      const schema = `
        payload = {
          ? &(group_mode: -3) => bool,
          ? &(hkdf: -1) => &(HMAC-256-64: 4, HMAC-256-256: 5)
        }
      `;
      const item = CBOR.fromJS({ group_mode: true }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{-3:true}');
    });

    test('the wildcard still accepts a genuinely unnamed extra field', () => {
      const item = CBOR.fromCDN('{"anything": 42}', {
        cddl: RFC9290_STYLE_CDDL,
      });
      expect(item.toCDN()).toBe('{"anything":42}');
    });

    test('reversed declaration order (wildcard first) does not annotate the named entry — matches actual validator matching semantics', () => {
      const schema = `
        payload = {
          * (tstr / int) => any,
          ? &(group_mode: -3) => bool
        }
      `;
      const item = CBOR.fromCDN('{-3: true}', { cddl: schema });
      expect(item.toCDN()).toBe('{-3:true}');
    });

    test('a wildcard in a *different*, `/`-separated alternative blocks annotation whenever that alternative also accepts the data', () => {
      const schema = `
        payload = { ? &(group_mode: -3) => bool }
             / { * int => any }
      `;
      const item = CBOR.fromCDN('{-3: true}', { cddl: schema });
      expect(item.toCDN()).toBe('{-3:true}');
    });

    test("…but not when that alternative can't match the data at all (-3 is no text key)", () => {
      const schema = `
        payload = { ? &(group_mode: -3) => bool }
             / { * tstr => any }
      `;
      const item = CBOR.fromCDN('{-3: true}', { cddl: schema });
      expect(item.toCDN()).toBe(`{e'group_mode':true}`);
    });
  });

  test('a map used as a map key is walked structurally, but its own content is never positionally labeled either', () => {
    // A map key isn't itself reached via any position `eRefScope.ts` can
    // track (RFC 8610 does allow one; this library's `fromJS()` never
    // produces one via a plain object's own properties, only through
    // `MapEntries`, whose entries likewise get no scope — see
    // `cddl/eRefScope.ts`'s Scope note and `js/fromJS.ts`'s own
    // `MapEntries` handling) — so nested content reached this way is left
    // exactly as decoded, the same as any other position this can't
    // resolve.
    const item = CBOR.fromCDN('{{-1: "inner"}: "outer"}', {
      cddl: `l = {* any => any}\n${PROBLEM_DETAILS_CDDL}`,
    });
    expect(item.toCDN()).toBe(`{{-1:"inner"}:"outer"}`);
  });

  test('a non-ambiguous annotated key re-parses back to the same value', () => {
    const item = CBOR.fromCDN('{-1: "oops"}', { cddl: PROBLEM_DETAILS_CDDL });
    const cdn = item.toCDN();
    expect(cdn).toBe(`{e'title':"oops"}`);
    const reparsed = CBOR.fromCDN(cdn, { cddl: PROBLEM_DETAILS_CDDL });
    expect(reparsed.toJS({ mapAs: 'object', eRefKeys: false })).toEqual({
      '-1': 'oops',
    });
  });

  test('an ambiguous name is never used for annotation, so its emitted CDN always re-parses', () => {
    // 'x' names 1 in `p` (the root) and 2 in `q` — ambiguous everywhere.
    const schema = CDDL.compile(
      'p = { ? &(x: 1) => tstr }\nq = { ? &(x: 2) => int }'
    );
    const item = CBOR.fromCDN('{1: "a"}', { cddl: schema });
    const cdn = item.toCDN();
    // Must stay the bare integer — annotating it as `e'x'` would be
    // unparseable, since 'x' has no single unambiguous resolution.
    expect(cdn).toBe('{1:"a"}');
    expect(() => CBOR.fromCDN(cdn, { cddl: schema })).not.toThrow();
  });

  test('a name bound only in a rule the root type never references is never used for annotation — a decode→toJS()→fromJS() round trip stays byte-exact', () => {
    // The exact reported bug: `other`'s own &(title: -1) is genuinely
    // unambiguous schema-wide (byName/byValue's flat table would happily
    // resolve it), but `root` never references `other` at all — annotating
    // -1 as 'title' here anyway, the way the old flat-table-based
    // annotateERefKeys() did, produced CDN/JS that *looked* fine on its
    // own, but silently corrupted on a round trip: `fromJS()`'s own
    // eRefKeys direction (correctly) refuses to convert 'title' back,
    // since it isn't reachable from root either, so -1 became the *wrong*
    // key (plain text "title") instead of round-tripping byte-for-byte.
    const schema = 'root = { * any => any }\nother = { &(title: -1) => tstr }';
    const decoded = CBOR.fromCDN('{-1:"hello"}', { cddl: schema });
    expect(decoded.toCDN({ appPrefix: false })).toBe('{-1:"hello"}');
    const js = decoded.toJS();
    // -1 has no name at all now, so it isn't object-eligible — 'auto'
    // falls back to MapEntries, same as any other unnamed integer key.
    expect(js).toEqual(MapEntries.from([[-1, 'hello']]));
    const reEncoded = CBOR.fromJS(js, { cddl: schema });
    expect(reEncoded.toCDN({ appPrefix: false })).toBe('{-1:"hello"}');
  });

  test('a nested map annotated under a parent that itself falls back to MapEntries still round-trips', () => {
    // The exact reported bug: key 0 has no e-ref name, so `toJS()`'s 'auto'
    // falls the *parent* map back to MapEntries — a decision `fromJS()`'s
    // own MapEntries branch (deliberately) tracks no eRefScope through, for
    // either a key or a value, since a MapEntries key isn't necessarily
    // even a string. But 'data' *is* a plain string key here, naming a
    // schema position with its own nested e-ref binding, and that nested
    // object's *value* (unlike its key) genuinely can carry a scope the
    // same way an ordinary property's value would — so `fromJS()` must
    // still convert 'data''s own 'title' back to -1, even though 'data'
    // itself sits inside a MapEntries entry rather than a plain object.
    const schema = 'root = { 0: int, data: { &(title: -1) => tstr } }';
    const decoded = CBOR.fromCDN('{0:7,"data":{-1:"hello"}}', { cddl: schema });
    const js = decoded.toJS();
    expect(js).toEqual(
      MapEntries.from([
        [0, 7],
        ['data', { title: 'hello' }],
      ])
    );
    const reEncoded = CBOR.fromJS(js, { cddl: schema });
    expect(reEncoded.toCDN({ appPrefix: false })).toBe(
      '{0:7,"data":{-1:"hello"}}'
    );
  });

  test('a nested map annotated under an *integer* MapEntries key still round-trips', () => {
    // Same class of bug as the string-key case just above, but for a
    // MapEntries key that's itself a plain *integer* — the value a schema
    // name resolves to (`&(data: 1) => …`), not the name itself, since
    // `toJS()` never renames a MapEntries key. The key must stay exactly
    // 1 (never becomes 'data' or anything else), but its own *value* still
    // needs the nested scope 'data' names, found by looking up which name
    // (if any) resolves to the value 1 at this position.
    const schema = 'root = { 0: int, &(data: 1) => { &(title: -1) => tstr } }';
    const decoded = CBOR.fromCDN('{0:7,1:{-1:"hello"}}', { cddl: schema });
    const js = decoded.toJS();
    expect(js).toEqual(
      MapEntries.from([
        [0, 7],
        [1, { title: 'hello' }],
      ])
    );
    const reEncoded = CBOR.fromJS(js, { cddl: schema });
    expect(reEncoded.toCDN({ appPrefix: false })).toBe('{0:7,1:{-1:"hello"}}');
  });

  test('a decode -> toJS() -> fromJS() round trip stays byte-exact when a sibling alternative spells the same key a different way', () => {
    // The exact reported bug: `root`'s "raw" alternative has an unnamed
    // literal `1: any` entry at the very same wire position `root`'s
    // "named" alternative reaches via `&(data: 1) => …` — the document
    // being converted is structurally the "raw" shape here (kind: "raw"),
    // so its own `data`'s content must stay exactly as decoded, not be
    // converted as if the "named" alternative's own binding applied.
    const schema = `
      root = { kind: "raw", 1: any }
           / { kind: "named", &(data: 1) => { &(title: -1) => tstr } }
    `;
    const decoded = CBOR.fromCDN('{"kind":"raw",1:{"title":"hello"}}', {
      cddl: schema,
    });
    expect(decoded.toCDN({ appPrefix: false })).toBe(
      '{"kind":"raw",1:{"title":"hello"}}'
    );
    const js = decoded.toJS();
    const reEncoded = CBOR.fromJS(js, { cddl: schema });
    expect(reEncoded.toCDN({ appPrefix: false })).toBe(
      '{"kind":"raw",1:{"title":"hello"}}'
    );
  });

  test("an explicit e'...' written in CDN source is downgraded to a plain integer when its position can't reach it, so a round trip stays byte-exact", () => {
    // The exact reported bug: `e'title'` parses directly to a
    // CborERefNint via the flat, schema-wide byName table (title = -1 is a
    // perfectly valid, unambiguous constant rule) — independent of
    // structural position. But `root`'s own type (`any`) never reaches
    // 'title' at a member-key position, so keeping that label would make
    // toJS() emit the plain-object key "title", which fromJS() can't
    // convert back to -1 (root reaches nothing positionally) — silently
    // corrupting the round trip. annotateERefKeys() now downgrades an
    // already-labeled key the same way it would decline to label a fresh
    // one at an unreachable position.
    const schema = 'root = any\ntitle = -1';
    const item = CBOR.fromCDN('{e\'title\':"hello"}', { cddl: schema });
    expect(item.toCDN({ appPrefix: false })).toBe('{-1:"hello"}');
    const js = item.toJS();
    const reEncoded = CBOR.fromJS(js, { cddl: schema });
    expect(reEncoded.toCDN({ appPrefix: false })).toBe('{-1:"hello"}');
  });

  test("no regression: an explicit e'...' at a position the schema genuinely does name keeps its label", () => {
    const schema = 'root = { &(title: -1) => tstr }';
    const item = CBOR.fromCDN('{e\'title\':"hello"}', { cddl: schema });
    expect(item.toCDN()).toBe(`{e'title':"hello"}`);
  });

  test('a value validation rejects is not annotated (validation still fails)', () => {
    expect(() =>
      CBOR.fromCDN('{-1: 1}', { cddl: PROBLEM_DETAILS_CDDL })
    ).toThrow(CddlMismatchError);
  });

  test('eRefKeys: false opts back into the plain numeric key', () => {
    const item = CBOR.fromCDN('{-1: "oops"}', { cddl: PROBLEM_DETAILS_CDDL });
    expect(item.toJS({ mapAs: 'object', eRefKeys: false })).toEqual({
      '-1': 'oops',
    });
  });

  test("toJS() defaults to the name as the object key (eRefKeys unset), and — since every key is then object-eligible — 'auto' produces a plain object without needing mapAs at all", () => {
    const item = CBOR.fromCDN('{-1: "oops", -2: "meh"}', {
      cddl: PROBLEM_DETAILS_CDDL,
    });
    const expected = { title: 'oops', detail: 'meh' };
    expect(item.toJS()).toEqual(expected);
    // Explicit true is now redundant with the default, but must still work.
    expect(item.toJS({ eRefKeys: true })).toEqual(expected);
  });

  test("eRefKeys (default true) does not affect 'auto' when an entry has no name", () => {
    // -1 is named ('title'); 7 is not — the map can't cleanly become a
    // plain object, so 'auto' still falls back to MapEntries.
    const item = CBOR.fromCDN('{-1: "a", 7: "b"}', {
      cddl: `l = {* any => any}\n${PROBLEM_DETAILS_CDDL}`,
    });
    expect(item.toJS()).toBeInstanceOf(MapEntries);
  });

  test('a name that also appears as a literal bareword key in the same scope is never used for annotation', () => {
    // `&(title: -1)` names -1 "title", but the *same* map shape also
    // accepts a literal "title" text key — a document matching this schema
    // could present title's value either way, and which one a given -1
    // actually means isn't knowable without deeper context, the same
    // "plain text somewhere in scope" exclusion `scopeNameToValue()`
    // already applies across discriminated-union alternatives (see the
    // module doc) — it applies just as well *within* one shape. Labeling
    // -1 as `e'title'` here would risk exactly the round-trip corruption
    // `annotateERefKeys()`'s own doc warns about: `toJS()`'s 'auto' would
    // collide the two into one property, and converting back via
    // `fromJS()` could never reconstruct which physical key -1 was.
    const schema = `
      root = {
        ? &(title: -1) => int
        ? title: int
      }
    `;
    const item = CBOR.fromCDN('{-1: 1, "title": 2}', { cddl: schema });
    expect(item.toCDN()).toBe('{-1:1,"title":2}');

    // -1 has no name at all now, so it isn't object-eligible — 'auto'
    // falls back to MapEntries for that reason, same as any other
    // unnamed integer key (see the "does not affect 'auto'" test above).
    expect(item.toJS()).toBeInstanceOf(MapEntries);
    expect(item.toJS()).toEqual(
      MapEntries.from([
        [-1, 1],
        ['title', 2],
      ])
    );
  });

  test("a positive-int named entry round-trips as e'name' and toJS name key", () => {
    const schema = CDDL.compile('p = { ? &(pos: 5) => tstr }');
    const item = CBOR.fromCDN('{5: "x"}', { cddl: schema });
    expect(item.toCDN()).toBe(`{e'pos':"x"}`);
    expect(item.toJS()).toEqual({ pos: 'x' });
    expect(item.toJS({ mapAs: 'object', eRefKeys: false })).toEqual({
      '5': 'x',
    });
  });
});

describe('fromJS() eRefKeys (default true) — the reverse (JS → CBOR/CDN) direction', () => {
  test('a named property converts to the integer key it names, with eRefKeys unset', () => {
    const item = CBOR.fromJS({ title: 'oops' }, { cddl: PROBLEM_DETAILS_CDDL });
    expect(item.toCDN()).toBe(`{e'title':"oops"}`);
    expect(item.toJS({ mapAs: 'object', eRefKeys: false })).toEqual({
      '-1': 'oops',
    });
  });

  test('explicit eRefKeys: true behaves the same as the default', () => {
    const item = CBOR.fromJS(
      { title: 'oops' },
      { cddl: PROBLEM_DETAILS_CDDL, eRefKeys: true }
    );
    expect(item.toCDN()).toBe(`{e'title':"oops"}`);
  });

  test('eRefKeys: false opts out — the property stays a text-string key (validation then fails)', () => {
    expect(() =>
      CBOR.fromJS(
        { title: 'oops' },
        { cddl: PROBLEM_DETAILS_CDDL, eRefKeys: false }
      )
    ).toThrow(CddlMismatchError);
  });

  test('a bare constant-rule reference at a member-key position is used for this direction too', () => {
    const schema = CDDL.compile('p = { ? group_mode => bool }\ngroup_mode = 3');
    const item = CBOR.fromJS({ group_mode: true }, { cddl: schema });
    expect(item.toCDN()).toBe(`{e'group_mode':true}`);
  });

  describe('position-aware — a name bound in an unrelated rule never leaks in', () => {
    // The exact reported bug: fromJS() used to build one flat, whole-schema
    // name table and apply it everywhere, so a name bound only in some
    // *other*, structurally unrelated rule could still silently rewrite an
    // unrelated property elsewhere — see `cddl/eRefScope.ts`'s own module
    // doc for the full rationale.
    const UNRELATED_SCHEMA = `
      root = { title: tstr }
      other = { &(title: -1) => tstr }
    `;

    test("a strict root's own genuine text key round-trips as text, not the unrelated rule's integer", () => {
      const forward = CBOR.fromCDN('{"title":"hello"}', {
        cddl: UNRELATED_SCHEMA,
      });
      expect(forward.toJS()).toEqual({ title: 'hello' });

      const back = CBOR.fromJS({ title: 'hello' }, { cddl: UNRELATED_SCHEMA });
      expect(back.toCDN()).toBe('{"title":"hello"}');
    });

    test("a permissive root doesn't silently rewrite the key either (no validation error to catch it)", () => {
      const permissiveSchema = `
        root = {* any => any}
        other = { &(title: -1) => tstr }
      `;
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: permissiveSchema });
      // Both a permissive AND a strict root would accept {-1: "hello"} just
      // as validly as {"title": "hello"} — the old bug produced the former
      // silently, with no error to reveal it. This must stay the latter.
      expect(item.toCDN()).toBe('{"title":"hello"}');
    });

    test('a name bound only inside a nested rule is eligible there, and only there', () => {
      const schema = `
        root = { ? outer: inner, ? sibling: { ? foo: tstr } }
        inner = { ? &(title: -1) => tstr }
      `;
      const nested = CBOR.fromJS({ outer: { title: 'ok' } }, { cddl: schema });
      expect(nested.toCDN()).toBe(`{"outer":{e'title':"ok"}}`);

      // The same name at the *sibling* position (an unrelated nested map)
      // must not convert, even though 'title' is legitimately e-ref-named
      // elsewhere in the very same schema.
      const item = CBOR.fromJS({ sibling: { foo: 'x' } }, { cddl: schema });
      expect(item.toCDN()).toContain('"foo":"x"');
    });
  });

  describe("never emits e'name' notation that fromCDN() couldn't resolve back", () => {
    // Local uniqueness (safe to use as *this* position's own integer
    // value) and the schema-wide uniqueness parseAppString() requires for
    // e'name' to resolve at all are different questions — a name can be
    // locally unambiguous at one member-key position while being globally
    // ambiguous (bound to a *different* value at some other, unrelated
    // member-key position elsewhere in the very same schema).
    const AMBIGUOUS_GLOBALLY_SCHEMA = `
      root  = { &(x: 1) => tstr }
      other = { &(x: 2) => tstr }
    `;

    test("the key still gets the correct integer value, just not the e'name' label", () => {
      const item = CBOR.fromJS(
        { x: 'hello' },
        { cddl: AMBIGUOUS_GLOBALLY_SCHEMA }
      );
      expect(item.toCDN()).toBe('{1:"hello"}');
    });

    test('the result always round-trips through fromCDN() against the same schema', () => {
      const item = CBOR.fromJS(
        { x: 'hello' },
        { cddl: AMBIGUOUS_GLOBALLY_SCHEMA }
      );
      const reparsed = CBOR.fromCDN(item.toCDN(), {
        cddl: AMBIGUOUS_GLOBALLY_SCHEMA,
      });
      expect(reparsed.toCDN()).toBe(item.toCDN());
    });

    test('a name unambiguous both locally and globally still gets the e-ref label', () => {
      // Sanity check: this isn't a blanket "never label" regression — a
      // name with no such schema-wide conflict still round-trips as
      // e'name' exactly as before.
      const item = CBOR.fromJS(
        { title: 'oops' },
        { cddl: PROBLEM_DETAILS_CDDL }
      );
      expect(item.toCDN()).toBe(`{e'title':"oops"}`);
    });
  });

  describe('discriminated unions — a name conflicting across choice alternatives is never converted', () => {
    // The exact reported bug: naively merging every alternative's own
    // entries together conflated a name that means different things (or
    // one thing in one alternative and nothing special in another) in
    // different, mutually exclusive shapes of the same type choice.
    const DISCRIMINATED_UNION_SCHEMA = `
      root = { kind: "text", title: tstr }
           / { kind: "numeric", &(title: -1) => tstr }
    `;

    test("the text-shaped alternative's own genuine text key is not rewritten to the numeric alternative's integer", () => {
      const item = CBOR.fromJS(
        { kind: 'text', title: 'hello' },
        { cddl: DISCRIMINATED_UNION_SCHEMA }
      );
      expect(item.toCDN()).toBe('{"kind":"text","title":"hello"}');
    });

    test('the numeric-shaped alternative still resolves title on its own (no conflict there)', () => {
      const schema = 'root = { kind: "numeric", &(title: -1) => tstr }';
      const item = CBOR.fromJS(
        { kind: 'numeric', title: 'hello' },
        { cddl: schema }
      );
      expect(item.toCDN()).toBe(`{"kind":"numeric",e'title':"hello"}`);
    });
  });

  describe('`any`/wildcard alternatives are never silently dropped from a merge', () => {
    // The exact reported bug: an alternative that resolves to `any` (or a
    // wildcard `* tstr => any` catch-all) doesn't structurally rule out any
    // possible shape at all, so merging it away in favor of only the
    // alternatives that *did* resolve to a definite map let a name from
    // the wrong alternative through, converting data that should have
    // stayed exactly as the author wrote it.
    test('a nested object reached through an `any`-typed sibling alternative keeps its own keys as plain text', () => {
      const schema = `
        root = { kind: "raw", data: any }
             / { kind: "named", data: { &(title: -1) => tstr } }
      `;
      const item = CBOR.fromJS(
        { kind: 'raw', data: { title: 'hello' } },
        { cddl: schema }
      );
      expect(item.toCDN({ appPrefix: false })).toBe(
        '{"kind":"raw","data":{"title":"hello"}}'
      );
    });

    test('a wildcard `* tstr => any` alternative also blocks conversion, not just an explicit `any`', () => {
      const schema = 'root = {* tstr => any} / {&(title: -1) => tstr}';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });

    test('no regression: the named-only branch alone still converts normally', () => {
      const schema = 'root = { kind: "named", data: { &(title: -1) => tstr } }';
      const item = CBOR.fromJS(
        { kind: 'named', data: { title: 'hello' } },
        { cddl: schema }
      );
      expect(item.toCDN({ appPrefix: false })).toBe(
        '{"kind":"named","data":{-1:"hello"}}'
      );
    });
  });

  describe('an unresolved generic instantiation or a map-capable major type is never silently dropped either', () => {
    test('a generic instantiation sibling (`box<any>`) blocks conversion, the same as an explicit `any`', () => {
      const schema =
        'root = box<any> / { &(title: -1) => tstr }\nbox<T> = { * tstr => T }';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });

    test('a bare `#5` (any major-type-5 item, i.e. any map) sibling also blocks conversion', () => {
      const schema = 'root = #5 / {&(title: -1) => tstr}';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });

    test('no regression: a major type that can never be a map does not block conversion', () => {
      const schema = 'root = #2 / {&(title: -1) => tstr}';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{-1:"hello"}');
    });
  });

  describe('unrecognized constructs default to open, never silently skipped', () => {
    test('a bare group reference sibling that expands to a conflicting bareword key blocks conversion', () => {
      const schema =
        'root = { raw } / { &(title: -1) => tstr }\nraw = (title: tstr)';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });

    test('a controlled top-level type alternative (`.and`) sibling blocks conversion', () => {
      const schema = 'root = (any .and #5) / { &(title: -1) => tstr }';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });

    test('an &(...) enum entry whose own value is not a literal integer blocks conversion', () => {
      const schema =
        'root = { &(raw: tstr) => any } / { &(title: -1) => tstr }';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });

    test('no regression: a bare group reference sibling with disjoint names still converts normally', () => {
      const schema =
        'root = { raw } / { &(title: -1) => tstr }\nraw = (other: tstr)';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{-1:"hello"}');
    });

    test('an &(...) enum used as a bare type sibling (not a member key) blocks conversion, since it can represent a map', () => {
      const schema =
        'root = &(raw: { * tstr => any })\n     / { &(title: -1) => tstr }';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });
  });

  describe('a bare type reference at a member key is never conflated with an unrelated &(...) enum label of the same spelling', () => {
    test('a wildcard whose key type is a same-named rule (not an integer constant) still blocks conversion of a sibling name', () => {
      const schema =
        'root = { * keytype => any } / { &(title: -1) => tstr }\n' +
        'keytype = tstr\n' +
        'other = { &(keytype: 2) => int }';
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });

    test('no regression: a genuine bare reference to an integer constant rule still converts', () => {
      const schema = 'root = { ? group_mode => bool }\ngroup_mode = 3';
      const item = CBOR.fromJS({ group_mode: true }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{3:true}');
    });

    test("no regression: an unrelated &(...) enum label with the same spelling as a genuine integer constant rule doesn't change its converted value", () => {
      const schema =
        'root = { ? group_mode => bool }\n' +
        'group_mode = 3\n' +
        'other = { &(group_mode: 99) => int }';
      const item = CBOR.fromJS({ group_mode: true }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{3:true}');
    });
  });

  describe('a differently-spelled entry for the same resolved key value is also inherited by nested descent', () => {
    test("a literal-int sibling entry for the same value blocks the nested 'title' conversion, so the result can't validate", () => {
      // 'data' itself still converts to key 1 at the top level (root's own
      // scope isn't affected — only 'raw''s literal `1: any` entry, which
      // has no name of its own, conflicts). But descending into that key's
      // *value* is unsafe: 'raw' permits *anything* there, so converting
      // 'title' to -1 could easily be wrong. Before the fix, this instead
      // silently succeeded with a wrong conversion (matching only the
      // "named" alternative); now it correctly can't produce a value that
      // validates at all, rather than guessing.
      const schema = `
        root = { kind: "raw", 1: any }
             / { kind: "named", &(data: 1) => { &(title: -1) => tstr } }
      `;
      expect(() =>
        CBOR.fromJS(
          { kind: 'named', data: { title: 'hello' } },
          { cddl: schema }
        )
      ).toThrow(CddlMismatchError);
    });

    test('no regression: the named-only branch alone still converts normally', () => {
      const schema =
        'root = { kind: "named", &(data: 1) => { &(title: -1) => tstr } }';
      const item = CBOR.fromJS(
        { kind: 'named', data: { title: 'hello' } },
        { cddl: schema }
      );
      expect(item.toCDN({ appPrefix: false })).toBe(
        '{"kind":"named",1:{-1:"hello"}}'
      );
    });
  });

  describe("a sibling alternative's wildcard is inherited by nested descent, not just its own scope", () => {
    test('a nested object reached through a wildcard sibling keeps its own keys as plain text', () => {
      const schema = `
        root = { * tstr => any }
             / { data: { &(title: -1) => tstr } }
      `;
      const item = CBOR.fromJS({ data: { title: 'hello' } }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe(
        '{"data":{"title":"hello"}}'
      );
    });

    test('no regression: the named-only branch alone still converts normally', () => {
      const schema = 'root = { data: { &(title: -1) => tstr } }';
      const item = CBOR.fromJS({ data: { title: 'hello' } }, { cddl: schema });
      expect(item.toCDN({ appPrefix: false })).toBe('{"data":{-1:"hello"}}');
    });
  });

  describe('a same-alternative wildcard whose own key type also matches text is not disambiguated by declaration order', () => {
    // The wildcard's own key type (`tstr`) accepts "title" just as validly
    // as the named entry's own integer value does — declaration order only
    // tells which entry would claim an *already-decoded* wire value (safe
    // for annotation), not which shape fromJS() should *construct* from a
    // JS string that could equally be either one.
    const SCHEMA = 'root = { ? &(title: -1) => tstr, * tstr => any }';

    test('a name declared before the wildcard is still left as a plain text key', () => {
      const item = CBOR.fromJS({ title: 'hello' }, { cddl: SCHEMA });
      expect(item.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });

    test('round trip: fromCDN → toJS → fromJS reproduces the original literal-text-key document, not the named integer key', () => {
      // Regression for the exact scenario reported: a document using the
      // wildcard's own literal-text-key shape must round-trip back to
      // itself, not silently turn into the named entry's integer key.
      const decoded = CBOR.fromCDN('{"title":"hello"}', { cddl: SCHEMA });
      expect(decoded.toCDN()).toBe('{"title":"hello"}');
      const js = decoded.toJS({ eRefKeys: true });
      expect(js).toEqual({ title: 'hello' });
      const reconverted = CBOR.fromJS(js, { cddl: SCHEMA });
      expect(reconverted.toCDN({ appPrefix: false })).toBe('{"title":"hello"}');
    });

    test("no regression: the actual integer wire value -1 is still safely annotated e'title' — only the JS-string-conversion direction is stricter", () => {
      const item = CBOR.fromCDN('{-1: "hello"}', { cddl: SCHEMA });
      expect(item.toCDN()).toBe(`{e'title':"hello"}`);
    });
  });

  test('a property name the schema does not name falls back to a text-string key', () => {
    const item = CBOR.fromJS(
      { nope: 'oops' },
      {
        cddl: `l = {* any => any}\n${PROBLEM_DETAILS_CDDL}`,
        eRefKeys: true,
      }
    );
    expect(item.toCDN()).toBe(`{"nope":"oops"}`);
  });

  test('a general constant rule is not used for this direction either', () => {
    const schema = CDDL.compile('p = {* any => any}\nhkdf = -1');
    const item = CBOR.fromJS(
      { hkdf: 'oops' },
      { cddl: schema, eRefKeys: true }
    );
    expect(item.toCDN()).toBe(`{"hkdf":"oops"}`);
  });

  test('an ambiguous name is not used for this direction either', () => {
    const schema = CDDL.compile(
      'l = {* any => any}\np = { ? &(x: 1) => tstr }\nq = { ? &(x: 2) => int }'
    );
    const item = CBOR.fromJS({ x: 'a' }, { cddl: schema, eRefKeys: true });
    expect(item.toCDN()).toBe(`{"x":"a"}`);
  });

  test('MapEntries keys are preserved exactly, unaffected by eRefKeys', () => {
    const item = CBOR.fromJS(MapEntries.from([['title', 'oops']]), {
      cddl: `l = {* any => any}\n${PROBLEM_DETAILS_CDDL}`,
      eRefKeys: true,
    });
    expect(item.toCDN()).toBe(`{"title":"oops"}`);
  });

  test('full round trip: fromJS(eRefKeys) → toCDN → re-parse → toJS(eRefKeys) reproduces the original object', () => {
    const original = { title: 'oops', detail: 'meh' };
    const item = CBOR.fromJS(original, {
      cddl: PROBLEM_DETAILS_CDDL,
      eRefKeys: true,
    });
    const cdn = item.toCDN();
    expect(cdn).toBe(`{e'title':"oops",e'detail':"meh"}`);
    const reparsed = CBOR.fromCDN(cdn, { cddl: PROBLEM_DETAILS_CDDL });
    expect(reparsed.toJS({ eRefKeys: true })).toEqual(original);
  });

  test('the converted key still validates against the schema (wrong type still throws)', () => {
    expect(() =>
      CBOR.fromJS({ title: 42 }, { cddl: PROBLEM_DETAILS_CDDL, eRefKeys: true })
    ).toThrow(CddlMismatchError);
  });

  test('a native Map is not recognized by fromJS() at all, independent of eRefKeys', () => {
    // Documents the pre-existing (unrelated to this feature) gap called out
    // in the `FromJSOptions.eRefKeys` doc: fromJS() has no dedicated `Map`
    // branch, so its entries fall through to `Object.entries()` and are
    // silently lost. Not something eRefKeys introduces or could fix on its
    // own — `MapEntries` is the supported non-text-key round-trip type.
    const item = CBOR.fromJS(new Map([['title', 'x']]), {
      cddl: `l = {* any => any}\n${PROBLEM_DETAILS_CDDL}`,
      eRefKeys: true,
    });
    expect(item.toCDN()).toBe('{}');
  });
});

describe('CBOR.stringify({ eRefKeys: true }) — the same shortcut as CBOR.fromJS(...).toCDN()', () => {
  test('matches CBOR.fromJS(...).toCDN() with the same options', () => {
    const options = { cddl: PROBLEM_DETAILS_CDDL, eRefKeys: true } as const;
    const viaFromJS = CBOR.fromJS({ title: 'x' }, options).toCDN();
    const viaStringify = CBOR.stringify({ title: 'x' }, options);
    expect(viaStringify).toBe(viaFromJS);
    expect(viaStringify).toBe(`{e'title':"x"}`);
  });

  test('also resolves eRefKeys on the replacer-function path', () => {
    const result = CBOR.stringify({ title: 'x', drop: 'y' }, {
      cddl: PROBLEM_DETAILS_CDDL,
      eRefKeys: true,
      replacer: (key, value) => (key === 'drop' ? CBOR_OMIT : value),
    } as FromJSOptions & ToCDNOptions);
    expect(result).toBe(`{e'title':"x"}`);
  });

  test('the instance method delegates through the same path', () => {
    const cbor = new CBOR({ cddl: PROBLEM_DETAILS_CDDL, eRefKeys: true });
    expect(cbor.stringify({ title: 'x' })).toBe(`{e'title':"x"}`);
  });
});

describe('maps inside fixed-shape arrays (RFC 9052 COSE_Sign1)', () => {
  const COSE_SIGN1_CDDL = `COSE_Sign1 = [
  protected: bstr .cbor header_map / bstr .size 0,
  unprotected: header_map,
  payload: bstr / nil,
  signature: bstr,
]
header_map = {
  ? &(alg: 1) => int / tstr,
  ? &(crit: 2) => [+label],
  ? &(content-type: 3) => tstr / int,
  ? &(kid: 4) => bstr,
  ? ( &(IV: 5) => bstr //
      &(Partial-IV: 6) => bstr ),
  * label => any,
}
label = int / tstr`;

  test("Format keeps an explicit e'kid' inside the array's own map element", () => {
    const item = CBOR.fromCDN(
      `[<< {e'alg': -7} >>, {e'kid': '11'}, 'payload', h'00']`,
      { cddl: COSE_SIGN1_CDDL }
    );
    expect(item.toCDN()).toBe(
      `[<<{e'alg':-7}>>,{e'kid':'11'},'payload',h'00']`
    );
  });

  test('raw bytes annotate a key inside an array element', () => {
    const bytes = CBOR.fromCDN(`[h'', {4: '11'}, 'payload', h'00']`).toCBOR();
    const item = CBOR.fromCBOR(bytes, { cddl: COSE_SIGN1_CDDL });
    expect(item.toCDN()).toBe(`['',{e'kid':'11'},'payload',h'00']`);
  });

  test('a name only one //-alternative binds (IV) stays a plain integer', () => {
    const item = CBOR.fromCDN(`[h'', {5: h'00'}, 'payload', h'00']`, {
      cddl: COSE_SIGN1_CDDL,
    });
    expect(item.toCDN()).toBe(`['',{5:h'00'},'payload',h'00']`);
  });

  test("toJS() -> fromJS() stays byte-exact even though fromJS() won't convert 'kid' here (the wildcard also accepts it as text)", () => {
    const bytes = CBOR.fromCDN(`[h'', {4: '11'}, 'payload', h'00']`).toCBOR();
    const decoded = CBOR.fromCBOR(bytes, { cddl: COSE_SIGN1_CDDL });
    const js = decoded.toJS() as unknown[];
    expect(js[1]).toEqual(
      MapEntries.from([[4, new TextEncoder().encode('11')]])
    );
    const back = CBOR.fromJS(js, { cddl: COSE_SIGN1_CDDL });
    expect(back.toCBOR()).toEqual(bytes);
  });

  test('fromJS() converts a name inside an array element when nothing else could claim it', () => {
    const cddl = 'root = [int, { ? &(kid: 4) => bstr }]';
    const item = CBOR.fromJS([1, { kid: new Uint8Array([0x31]) }], { cddl });
    expect(item.toCDN({ appPrefix: false })).toBe(`[1,{4:'1'}]`);
    expect(CBOR.fromCBOR(item.toCBOR(), { cddl }).toJS()).toEqual([
      1,
      { kid: new Uint8Array([0x31]) },
    ]);
  });

  test('raw bytes expand a `bstr .cbor header_map` element to <<...>> and annotate inside it', () => {
    const bytes = Uint8Array.from([
      0x84, 0x43, 0xa1, 0x01, 0x26, 0xa0, 0x40, 0x40,
    ]);
    const item = CBOR.fromCBOR(bytes, { cddl: COSE_SIGN1_CDDL });
    expect(item.toCDN()).toBe(`[<<{e'alg':-7}>>,{},'','']`);
    expect(item.toCBOR()).toEqual(bytes);
    // toJS() still sees the protected header as its raw bytes.
    expect((item.toJS() as unknown[])[0]).toEqual(
      Uint8Array.from([0xa1, 0x01, 0x26])
    );
  });

  test('a plain integer key inside explicit <<...>> CDN is annotated too', () => {
    const item = CBOR.fromCDN(`[<<{1: -7}>>, {}, h'', h'']`, {
      cddl: COSE_SIGN1_CDDL,
    });
    expect(item.toCDN()).toBe(`[<<{e'alg':-7}>>,{},'','']`);
  });

  test("an empty protected header (the `bstr .size 0` alternative) stays h''", () => {
    const bytes = CBOR.fromCDN(`[h'', {}, h'', h'']`).toCBOR();
    const item = CBOR.fromCBOR(bytes, { cddl: COSE_SIGN1_CDDL });
    expect(item.toCDN()).toBe(`['',{},'','']`);
  });

  test('no annotation when an occurrence indicator makes element positions data-dependent', () => {
    const cddl = 'root = [* { ? &(kid: 4) => bstr }]';
    const item = CBOR.fromCDN(`[{4: h'31'}]`, { cddl });
    expect(item.toCDN()).toBe(`[{4:'1'}]`);
  });
});

describe("a label fromJS() wouldn't convert back is display-only in toJS()", () => {
  // Annotation may label a key declared before a same-alternative wildcard
  // (safe for an already-decoded integer), but fromJS() refuses to turn the
  // JS string back into that integer when the wildcard also accepts it as
  // text — so toJS() must not offer the name as a property name.
  const WILDCARD_CDDL = 'root = { ? &(group_mode: -3) => bool, * tstr => any }';

  test('toCDN() shows the label; toJS() keeps the plain integer key', () => {
    const item = CBOR.fromCDN('{-3: true}', { cddl: WILDCARD_CDDL });
    expect(item.toCDN()).toBe(`{e'group_mode':true}`);
    expect(item.toJS()).toEqual(MapEntries.from([[-3, true]]));
    expect(item.toJS({ mapAs: 'object' })).toEqual({ '-3': true });
  });

  test('an explicit CDN label behaves the same', () => {
    const item = CBOR.fromCDN(`{e'group_mode': true}`, { cddl: WILDCARD_CDDL });
    expect(item.toCDN()).toBe(`{e'group_mode':true}`);
    expect(item.toJS()).toEqual(MapEntries.from([[-3, true]]));
  });

  test('toJS() -> fromJS() is byte-exact', () => {
    const bytes = CBOR.fromCDN('{-3: true, "extra": 1}').toCBOR();
    const decoded = CBOR.fromCBOR(bytes, { cddl: WILDCARD_CDDL });
    expect(
      CBOR.fromJS(decoded.toJS(), { cddl: WILDCARD_CDDL }).toCBOR()
    ).toEqual(bytes);
  });

  test('a map nested under a text key whose parent has a wildcard: fromJS() never reaches it, so its labels are display-only too', () => {
    const cddl = 'root = { data: { ? &(kid: 4) => bstr }, * tstr => any }';
    const bytes = CBOR.fromCDN(`{"data": {4: h'31'}}`).toCBOR();
    const decoded = CBOR.fromCBOR(bytes, { cddl });
    expect(decoded.toCDN()).toBe(`{"data":{e'kid':'1'}}`);
    expect(CBOR.fromJS(decoded.toJS(), { cddl }).toCBOR()).toEqual(bytes);
  });

  test('a map nested under a plain literal integer key round-trips through MapEntries', () => {
    const cddl = 'root = { 1: { ? &(kid: 4) => bstr }, ? &(x: 2) => int }';
    const bytes = CBOR.fromCDN(`{1: {4: h'31'}, 2: 0}`).toCBOR();
    const decoded = CBOR.fromCBOR(bytes, { cddl });
    expect(decoded.toCDN()).toBe(`{1:{e'kid':'1'},e'x':0}`);
    expect(CBOR.fromJS(decoded.toJS(), { cddl }).toCBOR()).toEqual(bytes);
  });

  test('no regression: without a wildcard the name is still the JS property name', () => {
    const cddl = 'root = { ? &(group_mode: -3) => bool }';
    expect(CBOR.fromCDN('{-3: true}', { cddl }).toJS()).toEqual({
      group_mode: true,
    });
  });
});

describe('a key is labeled only by the group entry that actually claimed it — key *and* value type (validator mapSeq semantics)', () => {
  // The validator gives a map entry to the first group entry whose key and
  // value both match; a value mismatch passes it on to later entries (e.g.
  // a trailing wildcard). A named entry whose value type the data doesn't
  // satisfy must not lend its name.
  test('a value-type mismatch falls through to the wildcard: no label', () => {
    const cddl = 'root = { ? &(kid: 4) => bstr, * int => any }';
    expect(CBOR.fromCDN('{4: 42}', { cddl }).toCDN()).toBe('{4:42}');
    expect(CBOR.fromCDN(`{4: h'31'}`, { cddl }).toCDN()).toBe(`{e'kid':'1'}`);
  });

  test('nested content is not labeled from a type the value never matched', () => {
    const cddl = `root = {
      ? &(kid: 4) => { ? &(x: 1) => tstr },
      * int => any
    }`;
    expect(CBOR.fromCDN('{4: {1: 42}}', { cddl }).toCDN()).toBe('{4:{1:42}}');
    expect(CBOR.fromCDN('{4: {1: "a"}}', { cddl }).toCDN()).toBe(
      `{e'kid':{e'x':"a"}}`
    );
  });

  test("an explicit e'kid' whose value doesn't match kid's type is downgraded", () => {
    const cddl = 'root = { ? &(kid: 4) => bstr, * int => any }';
    expect(CBOR.fromCDN(`{e'kid': 42}`, { cddl }).toCDN()).toBe('{4:42}');
  });

  test('a value enum is only labeled when its own entry claimed the key', () => {
    const cddl = 'root = { ? &(alg: 1) => &(A: 5), * int => any }';
    expect(CBOR.fromCDN('{1: 5}', { cddl }).toCDN()).toBe(`{e'alg':e'A'}`);
    expect(CBOR.fromCDN('{1: 6}', { cddl }).toCDN()).toBe('{1:6}');
  });

  test('a cut (^ =>) mismatch rules its alternative out; another alternative claims the key', () => {
    const cddl = `root = { ? &(kid: 4) ^ => bstr, * int => any }
                       / { ? &(other: 4) => int }`;
    expect(CBOR.fromCDN('{4: 42}', { cddl }).toCDN()).toBe(`{e'other':42}`);
  });

  test('array alternatives are narrowed by the elements actually present', () => {
    const cddl = 'root = [0, { ? &(x: 1) => int }] / [1, { ? &(y: 1) => int }]';
    expect(CBOR.fromCDN('[0, {1: 5}]', { cddl }).toCDN()).toBe(`[0,{e'x':5}]`);
    expect(CBOR.fromCDN('[1, {1: 5}]', { cddl }).toCDN()).toBe(`[1,{e'y':5}]`);
  });

  test('no regression: COSE kid (bstr) is still labeled', () => {
    const cddl = `COSE_Sign1 = [protected: bstr, unprotected: header_map,
                    payload: bstr / nil, signature: bstr]
      header_map = {
        ? &(alg: 1) => int / tstr,
        ? &(kid: 4) => bstr,
        ? ( &(IV: 5) => bstr // &(Partial-IV: 6) => bstr ),
        * label => any,
      }
      label = int / tstr`;
    expect(
      CBOR.fromCDN(`[h'', {1: -7, 4: '11'}, 'p', h'00']`, { cddl }).toCDN()
    ).toBe(`['',{e'alg':-7,e'kid':'11'},'p',h'00']`);
    expect(CBOR.fromCDN(`[h'', {4: 11}, 'p', h'00']`, { cddl }).toCDN()).toBe(
      `['',{4:11},'p',h'00']`
    );
  });
});

describe("labels follow the validator's actual map assignment (consumed entries, occurrence limits, sub-group backtracking)", () => {
  test('duplicate keys: an optional named entry consumes only the first; the wildcard takes the second', () => {
    const cddl = `root = {
      ? &(kid: 4) => { ? &(x: 1) => tstr },
      * int => any
    }`;
    const item = CBOR.fromCDN('{4: {1: "ok"}, 4: {1: "also"}}', { cddl });
    expect(item.toCDN()).toBe(`{e'kid':{e'x':"ok"},4:{1:"also"}}`);
  });

  test('an occurrence limit above one lets the named entry take that many', () => {
    const cddl = 'root = { 2*2 &(kid: 4) => int, * int => any }';
    const item = CBOR.fromCDN('{4: 1, 4: 2, 4: 3}', { cddl });
    expect(item.toCDN()).toBe(`{e'kid':1,e'kid':2,4:3}`);
  });

  test('an optional sub-group that only partially matches is dropped as a whole; the wildcard takes the key', () => {
    const cddl = `root = {
      ? ( &(a: 1) => int, &(b: 2) => int ),
      * int => any
    }`;
    expect(CBOR.fromCDN('{1: 1}', { cddl }).toCDN()).toBe('{1:1}');
    // The validator tries an optional group's zero-iteration path first, so
    // even a complete a/b pair is taken by the trailing wildcard here.
    expect(CBOR.fromCDN('{1: 1, 2: 2}', { cddl }).toCDN()).toBe('{1:1,2:2}');
  });

  test('a required sub-group consumes its own entries', () => {
    const cddl = `root = {
      ( &(a: 1) => int, &(b: 2) => int ),
      * int => any
    }`;
    expect(CBOR.fromCDN('{1: 1, 2: 2, 3: 3}', { cddl }).toCDN()).toBe(
      `{e'a':1,e'b':2,3:3}`
    );
  });

  test('a group choice labels only from the choice that matched', () => {
    const cddl = `root = {
      ( &(a: 1) => int, &(b: 2) => tstr // &(c: 1) => int, &(d: 2) => int )
    }`;
    expect(CBOR.fromCDN('{1: 0, 2: "s"}', { cddl }).toCDN()).toBe(
      `{e'a':0,e'b':"s"}`
    );
    expect(CBOR.fromCDN('{1: 0, 2: 0}', { cddl }).toCDN()).toBe(
      `{e'c':0,e'd':0}`
    );
  });

  test('a named entry reached through a generic binding still labels its key', () => {
    const cddl = `root = wrap<int>
      wrap<T> = { ? &(kid: 4) => T }`;
    expect(CBOR.fromCDN('{4: 5}', { cddl }).toCDN()).toBe(`{e'kid':5}`);
  });

  test('a map matched through `any` (or a control operator) gets no labels', () => {
    for (const cddl of [
      'root = { ? &(kid: 4) => int } / any',
      'root = { ? &(kid: 4) => int } .ne { 4: 0 }',
    ])
      expect(CBOR.fromCDN('{4: 5}', { cddl }).toCDN()).toBe('{4:5}');
  });
});

describe('a plain text key reached through a group reference blocks the same spelling as a label, exactly like an inline one', () => {
  const labelOf = (cddl: string): string =>
    CBOR.fromCDN('{1: 1}', { cddl }).toCDN();

  test('bare group reference (bareword key)', () => {
    expect(labelOf('root = { G, ? &(x: 1) => int }\nG = (? x: tstr)')).toBe(
      '{1:1}'
    );
    // same result as writing the group inline
    expect(labelOf('root = { (? x: tstr), ? &(x: 1) => int }')).toBe('{1:1}');
  });

  test('bare group reference (quoted-text key, both spellings)', () => {
    expect(labelOf('root = { G, ? &(x: 1) => int }\nG = (? "x": tstr)')).toBe(
      '{1:1}'
    );
    expect(labelOf('root = { G, ? &(x: 1) => int }\nG = (? "x" => tstr)')).toBe(
      '{1:1}'
    );
  });

  test('generic group reference, nested reference, and a // choice inside it', () => {
    expect(
      labelOf('root = { G<tstr>, ? &(x: 1) => int }\nG<T> = (? y: T // ? x: T)')
    ).toBe('{1:1}');
    expect(
      labelOf('root = { G, ? &(x: 1) => int }\nG = (H)\nH = (? x: tstr)')
    ).toBe('{1:1}');
  });

  test('a group spliced in through ~unwrap', () => {
    expect(labelOf('root = { ~M, ? &(x: 1) => int }\nM = { ? x: tstr }')).toBe(
      '{1:1}'
    );
  });

  test('a self-referencing group terminates', () => {
    expect(
      labelOf('root = { ? G, ? &(x: 1) => int }\nG = (? x: tstr, ? G)')
    ).toBe('{1:1}');
  });

  test('no regression: a referenced group without that spelling still allows the label', () => {
    expect(labelOf('root = { G, ? &(x: 1) => int }\nG = (? y: tstr)')).toBe(
      `{e'x':1}`
    );
  });
});

describe('a plain text key produced by a generic argument (or any key type accepting a text literal) blocks the same spelling', () => {
  const labelOf = (cddl: string): string =>
    CBOR.fromCDN('{1: 1}', { cddl }).toCDN();

  test('a single generic instantiation binding the key to "x"', () => {
    expect(
      labelOf('root = { G<"x">, ? &(x: 1) => int }\nG<K> = (? K => int)')
    ).toBe('{1:1}');
  });

  test('several instantiations of the same group are each resolved', () => {
    expect(
      labelOf(
        'root = { G<"y">, G<"x">, ? &(x: 1) => int }\nG<K> = (? K => int)'
      )
    ).toBe('{1:1}');
    expect(
      labelOf(
        'root = { G<"x">, G<"y">, ? &(x: 1) => int }\nG<K> = (? K => int)'
      )
    ).toBe('{1:1}');
  });

  test('no regression: an instantiation with a different spelling keeps the label', () => {
    expect(
      labelOf('root = { G<"y">, ? &(x: 1) => int }\nG<K> = (? K => int)')
    ).toBe(`{e'x':1}`);
  });

  test('a binding passed through another generic layer', () => {
    expect(
      labelOf(
        'root = { O<"x">, ? &(x: 1) => int }\nO<A> = (G<A>)\nG<K> = (? K => int)'
      )
    ).toBe('{1:1}');
  });

  test('a recursive generic group terminates and still sees its key', () => {
    expect(
      labelOf(
        'root = { ? G<"x">, ? &(x: 1) => int }\nG<K> = (? K => int, ? G<K>)'
      )
    ).toBe('{1:1}');
    expect(
      labelOf(
        'root = { ? G<"y">, ? &(x: 1) => int }\nG<K> = (? K => int, ? G<K>)'
      )
    ).toBe(`{e'x':1}`);
  });

  test('a key type that is a rule or a choice of text literals', () => {
    expect(labelOf('root = { ? k => int, ? &(x: 1) => int }\nk = "x"')).toBe(
      '{1:1}'
    );
    expect(labelOf('root = { ? ("z" / "x") => int, ? &(x: 1) => int }')).toBe(
      '{1:1}'
    );
  });
});

describe('a controlled (or otherwise non-literal) key type is resolved three ways: known literals, text wildcard, or unknown', () => {
  const labelOf = (cddl: string): string =>
    CBOR.fromCDN('{1: 1}', { cddl }).toCDN();

  test('a control operator that may accept "x" blocks the label (inline and via a rule)', () => {
    expect(
      labelOf('root = { ? &(x: 1) => int, ? ("x" .within tstr) => int }')
    ).toBe('{1:1}');
    expect(
      labelOf('root = { ? &(x: 1) => int, ? K => int }\nK = "x" .within tstr')
    ).toBe('{1:1}');
  });

  test('a control that could narrow arbitrary text, or build a new literal, is unknown: no labels', () => {
    expect(
      labelOf('root = { ? &(x: 1) => int, ? (tstr .regexp "x") => int }')
    ).toBe('{1:1}');
    expect(labelOf('root = { ? &(x: 1) => int, ? ("" .cat "x") => int }')).toBe(
      '{1:1}'
    );
  });

  test('a narrowing control on a known literal keeps that literal', () => {
    expect(labelOf('root = { ? &(x: 1) => int, ? ("x" .size 1) => int }')).toBe(
      '{1:1}'
    );
    expect(labelOf('root = { ? &(x: 1) => int, ? ("y" .size 1) => int }')).toBe(
      `{e'x':1}`
    );
  });

  test('a controlled key that can never be text does not block', () => {
    expect(labelOf('root = { ? &(x: 1) => int, ? (uint .lt 5) => tstr }')).toBe(
      `{e'x':1}`
    );
    expect(
      labelOf('root = { ? &(x: 1) => int, ? (bstr .size 4) => tstr }')
    ).toBe(`{e'x':1}`);
  });

  test('a plain text wildcard (tstr) is not a plain spelling and does not block', () => {
    expect(labelOf('root = { ? &(x: 1) => int, * tstr => any }')).toBe(
      `{e'x':1}`
    );
  });

  test('an &(...) key type and an unwrapped tag type accepting "x" both block', () => {
    expect(
      labelOf('root = { ? &(x: 1) => int, ? &(a: "x", b: "y") => int }')
    ).toBe('{1:1}');
    expect(
      labelOf('root = { ? &(x: 1) => int, ? ~T => int }\nT = #6.32("x")')
    ).toBe('{1:1}');
  });
});

describe('byte strings typed `.cbor`/`.cborseq` render as <<...>>', () => {
  const annotated = (cddl: string, cdn: string): string => {
    const bytes = CBOR.fromCDN(cdn).toCBOR();
    const item = CBOR.fromCBOR(bytes, { cddl });
    expect(item.toCBOR()).toEqual(bytes);
    return item.toCDN();
  };

  test('.cborseq expands every item, annotating each against its array position', () => {
    expect(
      annotated(
        'root = [bstr .cborseq [int, { ? &(kid: 4) => int }]]',
        `[<<1, {4: 2}>>]`
      )
    ).toBe(`[<<1,{e'kid':2}>>]`);
  });

  test('expanded but left unannotated when a plain bstr alternative also accepts the bytes', () => {
    expect(
      annotated(
        'root = [bstr .cbor { ? &(kid: 4) => int } / bstr]',
        `[<<{4: 2}>>]`
      )
    ).toBe(`[<<{4:2}>>]`);
  });

  test("bytes that are not the `.cbor` type stay h'...'", () => {
    expect(annotated('root = [bstr .cbor int / bstr]', `[h'ff']`)).toBe(
      `[h'ff']`
    );
  });

  test('a map value typed `.cbor` expands too', () => {
    expect(
      annotated(
        'root = { ? &(hdr: 1) => bstr .cbor { ? &(kid: 4) => int } }',
        `{1: <<{4: 2}>>}`
      )
    ).toBe(`{e'hdr':<<{e'kid':2}>>}`);
  });

  test("embedded content decodes with the caller's own extension settings", () => {
    const cddl = 'root = [bstr .cbor any]';
    const bytes = CBOR.fromCDN('[<<1(0)>>]').toCBOR();
    expect(CBOR.fromCBOR(bytes, { cddl }).toCDN()).toBe(
      `[<<DT'1970-01-01T00:00:00Z'>>]`
    );
    expect(
      CBOR.fromCBOR(bytes, { cddl, builtinExtensions: false }).toCDN()
    ).toBe('[<<1(0)>>]');
    expect(
      CBOR.fromCDN(`[h'c100']`, { cddl, builtinExtensions: false }).toCDN()
    ).toBe('[<<1(0)>>]');
    const seq = CBOR.fromCDN('[<<1(0), 1(0)>>]').toCBOR();
    expect(
      CBOR.fromCBOR(seq, {
        cddl: 'root = [bstr .cborseq [* any]]',
        builtinExtensions: false,
      }).toCDN()
    ).toBe('[<<1(0),1(0)>>]');
  });

  test('non-canonical embedded content still round-trips byte-exact', () => {
    // 0x18 0x01 is 1 in a non-preferred 1-byte argument.
    const cddl = 'root = [bstr .cbor int]';
    const bytes = Uint8Array.from([0x81, 0x42, 0x18, 0x01]);
    const item = CBOR.fromCBOR(bytes, { cddl });
    expect(item.toCBOR()).toEqual(bytes);
  });
});
