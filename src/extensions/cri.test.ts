import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { decodeCBOR } from '../cbor/decoder';
import { CborCriExt, CborTaggedCriExt, TAG_CRI } from './cri';
import { CborNint } from '../ast/CborNint';
import { CborUint } from '../ast/CborUint';
import { CborTextString } from '../ast/CborTextString';
import { CborByteString } from '../ast/CborByteString';
import { CborArray } from '../ast/CborArray';
import { CborSimple } from '../ast/CborSimple';
import { CborTag } from '../ast/CborTag';

// ─── cri'…' — bare CRI array ──────────────────────────────────────────────────

describe("cri — cri'…' (lowercase, untagged)", () => {
  test("cri'https://example.com/bottarga/shaved' → CborCriExt", () => {
    const v = CBOR.fromEDN("cri'https://example.com/bottarga/shaved'");
    expect(v).toBeInstanceOf(CborCriExt);
    const arr = v as CborCriExt;
    expect(arr.items[0]).toBeInstanceOf(CborNint);
    expect((arr.items[0] as CborNint).value).toBe(-4n); // https
    expect(arr.items[1]).toBeInstanceOf(CborArray);
    // authority: ["example", "com"]
    const auth = arr.items[1] as CborArray;
    expect(auth.items.map((i) => (i as CborTextString).value)).toEqual([
      'example',
      'com',
    ]);
    // path: ["bottarga", "shaved"]
    const path = arr.items[2] as CborArray;
    expect(path.items.map((i) => (i as CborTextString).value)).toEqual([
      'bottarga',
      'shaved',
    ]);
  });

  test("cri'https://example.com/bottarga/shaved' round-trips via toEDN", () => {
    const uri = 'https://example.com/bottarga/shaved';
    const v = CBOR.fromEDN(`cri'${uri}'`);
    expect(v.toEDN()).toBe(`cri'${uri}'`);
  });

  test("cri'http://example.com/' — scheme -3, trailing slash kept", () => {
    const v = CBOR.fromEDN("cri'http://example.com/'");
    expect(v).toBeInstanceOf(CborCriExt);
    const arr = v as CborCriExt;
    expect((arr.items[0] as CborNint).value).toBe(-3n); // http
    const path = arr.items[2] as CborArray;
    // trailing slash → one empty segment
    expect(path.items).toHaveLength(1);
    expect((path.items[0] as CborTextString).value).toBe('');
    expect(v.toEDN()).toBe("cri'http://example.com/'");
  });

  test("cri'https://example.com' — no path → trimmed to 2 items", () => {
    const v = CBOR.fromEDN("cri'https://example.com'");
    expect(v).toBeInstanceOf(CborCriExt);
    const arr = v as CborCriExt;
    expect(arr.items).toHaveLength(2); // scheme + authority only
    expect(v.toEDN()).toBe("cri'https://example.com'");
  });

  test('coap URI with IPv4 host and port', () => {
    const uri = 'coap://198.51.100.1:61616/.well-known/core';
    const v = CBOR.fromEDN(`cri'${uri}'`);
    expect(v).toBeInstanceOf(CborCriExt);
    const arr = v as CborCriExt;
    expect((arr.items[0] as CborNint).value).toBe(-1n); // coap
    const auth = arr.items[1] as CborArray;
    // host-ip: 4 bytes for 198.51.100.1
    expect(auth.items[0]).toBeInstanceOf(CborByteString);
    expect((auth.items[0] as CborByteString).value).toEqual(
      new Uint8Array([198, 51, 100, 1])
    );
    // port: 61616
    expect(auth.items[1]).toBeInstanceOf(CborUint);
    expect((auth.items[1] as CborUint).value).toBe(61616n);
    expect(v.toEDN()).toBe(`cri'${uri}'`);
  });

  test('URI with IPv6 host', () => {
    const uri = 'coaps://[2001:db8::1]/path';
    const v = CBOR.fromEDN(`cri'${uri}'`);
    expect(v).toBeInstanceOf(CborCriExt);
    const auth = (v as CborCriExt).items[1] as CborArray;
    expect(auth.items[0]).toBeInstanceOf(CborByteString);
    expect((auth.items[0] as CborByteString).value).toHaveLength(16);
    expect(v.toEDN()).toBe(`cri'${uri}'`);
  });

  test('URI with port', () => {
    const uri = 'https://example.com:8080/api';
    const v = CBOR.fromEDN(`cri'${uri}'`);
    const auth = (v as CborCriExt).items[1] as CborArray;
    // labels: "example", "com", then port
    expect((auth.items[0] as CborTextString).value).toBe('example');
    expect((auth.items[1] as CborTextString).value).toBe('com');
    expect((auth.items[2] as CborUint).value).toBe(8080n);
    expect(v.toEDN()).toBe(`cri'${uri}'`);
  });

  test('URI with query string', () => {
    const uri = 'https://example.com/search?q=cbor&lang=en';
    const v = CBOR.fromEDN(`cri'${uri}'`);
    expect(v).toBeInstanceOf(CborCriExt);
    const arr = v as CborCriExt;
    const query = arr.items[3] as CborArray;
    expect(query.items.map((i) => (i as CborTextString).value)).toEqual([
      'q=cbor',
      'lang=en',
    ]);
    expect(v.toEDN()).toBe(`cri'${uri}'`);
  });

  test('URI with fragment', () => {
    const uri = 'https://example.com/page#section-1';
    const v = CBOR.fromEDN(`cri'${uri}'`);
    expect(v).toBeInstanceOf(CborCriExt);
    const arr = v as CborCriExt;
    // query placeholder [] trimmed, fragment present at index 3
    const frag = arr.items[arr.items.length - 1] as CborTextString;
    expect(frag.value).toBe('section-1');
    expect(v.toEDN()).toBe(`cri'${uri}'`);
  });

  test('URI with query and fragment', () => {
    const uri = 'https://example.com/path?q=1#top';
    const v = CBOR.fromEDN(`cri'${uri}'`);
    const arr = v as CborCriExt;
    expect(arr.items).toHaveLength(5); // scheme, auth, path, query, fragment
    expect(v.toEDN()).toBe(`cri'${uri}'`);
  });

  test('unknown scheme stored as text string', () => {
    const uri = 'ftp://ftp.example.com/file.txt';
    const v = CBOR.fromEDN(`cri'${uri}'`);
    expect(v).toBeInstanceOf(CborCriExt);
    expect((v as CborCriExt).items[0]).toBeInstanceOf(CborTextString);
    expect(((v as CborCriExt).items[0] as CborTextString).value).toBe('ftp');
    expect(v.toEDN()).toBe(`cri'${uri}'`);
  });

  test('did: URI — rootless, no authority (NOAUTH-ROOTLESS = true)', () => {
    const uri = 'did:web:alice:bob';
    const v = CBOR.fromEDN(`cri'${uri}'`);
    expect(v).toBeInstanceOf(CborCriExt);
    const arr = v as CborCriExt;
    // scheme-id -6, true (NOAUTH-ROOTLESS), ["web:alice:bob"]
    expect((arr.items[0] as CborNint).value).toBe(-6n);
    expect(arr.items[1]).toBeInstanceOf(CborSimple);
    expect((arr.items[1] as CborSimple).value).toBe(21); // true
    expect(v.toEDN()).toBe(`cri'${uri}'`);
  });

  test('hostname is lowercased', () => {
    const v = CBOR.fromEDN("cri'https://Example.COM/path'");
    const auth = (v as CborCriExt).items[1] as CborArray;
    expect((auth.items[0] as CborTextString).value).toBe('example');
    expect((auth.items[1] as CborTextString).value).toBe('com');
    // toEDN reflects the normalised form
    expect(v.toEDN()).toBe("cri'https://example.com/path'");
  });

  test('percent-encoded path segment is stored decoded', () => {
    const v = CBOR.fromEDN("cri'https://example.com/a%20b/c'");
    const path = (v as CborCriExt).items[2] as CborArray;
    expect((path.items[0] as CborTextString).value).toBe('a b');
    // re-encoded on toEDN
    expect(v.toEDN()).toBe("cri'https://example.com/a%20b/c'");
  });

  test('appStrings:false falls back to generic array notation', () => {
    const v = CBOR.fromEDN("cri'https://example.com/path'");
    const edn = v.toEDN({ appStrings: false });
    expect(edn).not.toContain("cri'");
    expect(edn).toMatch(/^\[/); // plain array
  });

  // ── Issue fixes ────────────────────────────────────────────────────────────

  // Issue 1: empty query "?" must be distinguishable from no query
  test("empty query '?' is preserved and distinct from no query", () => {
    const withQuery = CBOR.fromEDN("cri'https://example.com?'");
    const noQuery = CBOR.fromEDN("cri'https://example.com'");
    // Different CBOR representations
    expect(withQuery.toCBOR()).not.toEqual(noQuery.toCBOR());
    // toEDN round-trips
    expect(withQuery.toEDN()).toBe("cri'https://example.com?'");
    expect(noQuery.toEDN()).toBe("cri'https://example.com'");
  });

  test("empty query ['' ] is at position 3 in the CRI array (§5.1: '?' = [''])", () => {
    const v = CBOR.fromEDN("cri'https://example.com?'") as CborCriExt;
    // items: [scheme, auth, path[], query[""]]
    // Per draft-ietf-core-href §5.1: [] = absent query; [""] = present but empty query
    expect(v.items).toHaveLength(4);
    expect(v.items[2]).toBeInstanceOf(CborArray); // path []
    expect((v.items[2] as CborArray).items).toHaveLength(0);
    expect(v.items[3]).toBeInstanceOf(CborArray); // query [""]
    expect((v.items[3] as CborArray).items).toHaveLength(1);
    expect(((v.items[3] as CborArray).items[0] as CborTextString).value).toBe(
      ''
    );
  });

  test("empty query with path: 'https://example.com/?'", () => {
    const v = CBOR.fromEDN("cri'https://example.com/?'");
    expect(v.toEDN()).toBe("cri'https://example.com/?'");
  });

  test("empty query + fragment: 'https://example.com?#section'", () => {
    const v = CBOR.fromEDN("cri'https://example.com?#section'") as CborCriExt;
    // items: [scheme, auth, path[], query[""], fragment]
    // Per §5.1: [""] = present but empty query
    expect(v.items).toHaveLength(5);
    expect((v.items[3] as CborArray).items).toHaveLength(1); // query [""]
    expect(((v.items[3] as CborArray).items[0] as CborTextString).value).toBe(
      ''
    );
    expect((v.items[4] as CborTextString).value).toBe('section');
    expect(v.toEDN()).toBe("cri'https://example.com?#section'");
  });

  test("no-query + fragment: 'https://example.com#section'", () => {
    const v = CBOR.fromEDN("cri'https://example.com#section'") as CborCriExt;
    // items: [scheme, auth, path[], fragment]  — no query element
    expect(v.items).toHaveLength(4);
    // items[3] is a text string (fragment), not an array (query)
    expect(v.items[3]).toBeInstanceOf(CborTextString);
    expect(v.toEDN()).toBe("cri'https://example.com#section'");
  });

  // Issue 2: "&" inside a query parameter value must be percent-encoded
  test("literal '&' in query value is stored decoded and re-encoded as %26", () => {
    const v = CBOR.fromEDN(
      "cri'https://example.com/path?a%26b=c'"
    ) as CborCriExt;
    const query = v.items[3] as CborArray;
    // stored as one item with decoded "&"
    expect(query.items).toHaveLength(1);
    expect((query.items[0] as CborTextString).value).toBe('a&b=c');
    // re-encoded as %26 on output
    expect(v.toEDN()).toBe("cri'https://example.com/path?a%26b=c'");
  });

  test("'&' literal in query splits into two parameters", () => {
    const v = CBOR.fromEDN(
      "cri'https://example.com/path?a=1&b=2'"
    ) as CborCriExt;
    const query = v.items[3] as CborArray;
    expect(query.items).toHaveLength(2);
    expect((query.items[0] as CborTextString).value).toBe('a=1');
    expect((query.items[1] as CborTextString).value).toBe('b=2');
    expect(v.toEDN()).toBe("cri'https://example.com/path?a=1&b=2'");
  });

  // Issue 3: ":" in userinfo must not be percent-encoded
  test("':' in userinfo is preserved as-is", () => {
    const v = CBOR.fromEDN("cri'https://user:pass@example.com/'");
    expect(v.toEDN()).toBe("cri'https://user:pass@example.com/'");
  });

  test("userinfo with ':' is stored decoded in the CRI authority", () => {
    const v = CBOR.fromEDN("cri'https://user:pass@example.com/'") as CborCriExt;
    const auth = v.items[1] as CborArray;
    // [false, "user:pass", "example", "com"]
    expect(auth.items[0]).toBeInstanceOf(CborSimple);
    expect((auth.items[0] as CborSimple).value).toBe(20); // false
    expect((auth.items[1] as CborTextString).value).toBe('user:pass');
  });
});

// ─── CRI'…' — tag(99, …) ─────────────────────────────────────────────────────

describe("cri — CRI'…' (uppercase, tag 99)", () => {
  test("CRI'https://example.com/path' → CborTaggedCriExt with tag 99", () => {
    const v = CBOR.fromEDN("CRI'https://example.com/path'");
    expect(v).toBeInstanceOf(CborTaggedCriExt);
    expect((v as CborTaggedCriExt).tag).toBe(TAG_CRI); // 99n
    expect((v as CborTaggedCriExt).content).toBeInstanceOf(CborCriExt);
  });

  test("CRI'…' round-trips via toEDN", () => {
    const uri = 'https://example.com/bottarga/shaved';
    const v = CBOR.fromEDN(`CRI'${uri}'`);
    expect(v.toEDN()).toBe(`CRI'${uri}'`);
  });

  test("CRI'…' encodes to tag(99, […])", () => {
    const v = CBOR.fromEDN("CRI'https://example.com'");
    const cbor = v.toCBOR();
    const decoded = decodeCBOR(cbor);
    // Should decode back to CborTaggedCriExt via parseTag
    expect(decoded).toBeInstanceOf(CborTaggedCriExt);
    expect(decoded.toEDN()).toBe("CRI'https://example.com'");
  });

  test('appStrings:false falls back to generic tag(99, …) notation', () => {
    const v = CBOR.fromEDN("CRI'https://example.com/path'");
    const edn = v.toEDN({ appStrings: false });
    expect(edn).toMatch(/^99\(/);
    expect(edn).not.toContain("CRI'");
  });
});

// ─── CBOR round-trip ──────────────────────────────────────────────────────────

describe('cri — CBOR round-trip', () => {
  test("cri'…' binary round-trip preserves CBOR bytes", () => {
    // Bare cri arrays have no CBOR tag, so the decoder cannot distinguish them
    // from generic arrays. Binary round-trip preserves bytes; EDN re-emission
    // requires the tagged CRI'…' form (see CRI'…' tests below).
    const uris = [
      'https://example.com/path',
      'coap://198.51.100.1:61616/.well-known/core',
      'https://example.com/search?q=test',
      'https://example.com/page#anchor',
      'did:web:alice:bob',
    ];
    for (const uri of uris) {
      const original = CBOR.fromEDN(`cri'${uri}'`);
      const cbor = original.toCBOR();
      const decoded = decodeCBOR(cbor);
      // Decoded back as plain CborArray (no tag to identify it as CRI)
      expect(decoded).toBeInstanceOf(CborArray);
      // CBOR bytes are identical
      expect(decoded.toCBOR()).toEqual(cbor);
    }
  });

  test('tag(99, generic array) parsed as CborTaggedCriExt via parseTag', () => {
    // Manually build tag(99, [-4, ["example", "com"], ["path"]])
    const inner = new CborArray([
      new CborNint(-4n),
      new CborArray([new CborTextString('example'), new CborTextString('com')]),
      new CborArray([new CborTextString('path')]),
    ]);
    const tag = new CborTag(99n, inner);
    const cbor = tag.toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(decoded).toBeInstanceOf(CborTaggedCriExt);
    expect(decoded.toEDN()).toBe("CRI'https://example.com/path'");
  });
});

// ─── cri<<…>> app-sequence ────────────────────────────────────────────────────

describe('cri — app-sequence cri<<…>>', () => {
  test('cri<<"https://example.com/path">> → same as cri\'…\'', () => {
    const v = CBOR.fromEDN('cri<<"https://example.com/path">>');
    expect(v).toBeInstanceOf(CborCriExt);
    expect(v.toEDN()).toBe("cri'https://example.com/path'");
  });
});

// ─── Relative CRI references ──────────────────────────────────────────────────

describe('cri — relative CRI references', () => {
  // ── Same-document references (discard = 0) ─────────────────────────────────

  test("cri'' — empty same-document reference → [] (canonical per §5.2)", () => {
    const v = CBOR.fromEDN("cri''") as CborCriExt;
    // Per §5.2: [discard=0] with nothing else is canonically sent as []
    expect(v.items).toHaveLength(0);
    expect(v.toEDN()).toBe("cri''");
  });

  test("cri'#section' — fragment-only → [0, 'section']", () => {
    const v = CBOR.fromEDN("cri'#section'") as CborCriExt;
    expect(v.items).toHaveLength(2);
    expect((v.items[0] as CborUint).value).toBe(0n);
    expect((v.items[1] as CborTextString).value).toBe('section');
    expect(v.toEDN()).toBe("cri'#section'");
  });

  test("cri'?q=1' — query-only → [0, ['q=1']]", () => {
    const v = CBOR.fromEDN("cri'?q=1'") as CborCriExt;
    expect(v.items).toHaveLength(2);
    expect((v.items[0] as CborUint).value).toBe(0n);
    const query = v.items[1] as CborArray;
    expect(query.items).toHaveLength(1);
    expect((query.items[0] as CborTextString).value).toBe('q=1');
    expect(v.toEDN()).toBe("cri'?q=1'");
  });

  test("cri'?q=1#top' — query and fragment → [0, ['q=1'], 'top']", () => {
    const v = CBOR.fromEDN("cri'?q=1#top'") as CborCriExt;
    expect(v.items).toHaveLength(3);
    expect((v.items[0] as CborUint).value).toBe(0n);
    expect(v.toEDN()).toBe("cri'?q=1#top'");
  });

  // ── Relative-path references (discard ≥ 1) ────────────────────────────────

  test("cri'foo' — same-directory → [1, ['foo']]", () => {
    const v = CBOR.fromEDN("cri'foo'") as CborCriExt;
    expect((v.items[0] as CborUint).value).toBe(1n);
    const path = v.items[1] as CborArray;
    expect(path.items).toHaveLength(1);
    expect((path.items[0] as CborTextString).value).toBe('foo');
    expect(v.toEDN()).toBe("cri'foo'");
  });

  test("cri'foo/bar' — same-directory, multi-segment → [1, ['foo','bar']]", () => {
    const v = CBOR.fromEDN("cri'foo/bar'") as CborCriExt;
    expect((v.items[0] as CborUint).value).toBe(1n);
    expect((v.items[1] as CborArray).items).toHaveLength(2);
    expect(v.toEDN()).toBe("cri'foo/bar'");
  });

  test("cri'./foo' normalises to cri'foo' (same discard=1)", () => {
    const v = CBOR.fromEDN("cri'./foo'") as CborCriExt;
    expect((v.items[0] as CborUint).value).toBe(1n);
    expect(v.toEDN()).toBe("cri'foo'"); // canonical form without ./
  });

  test("cri'../sibling' — one level up → [2, ['sibling']]", () => {
    const v = CBOR.fromEDN("cri'../sibling'") as CborCriExt;
    expect((v.items[0] as CborUint).value).toBe(2n);
    expect(((v.items[1] as CborArray).items[0] as CborTextString).value).toBe(
      'sibling'
    );
    expect(v.toEDN()).toBe("cri'../sibling'");
  });

  test("cri'../../other/path' — two levels up → [3, ['other','path']]", () => {
    const v = CBOR.fromEDN("cri'../../other/path'") as CborCriExt;
    expect((v.items[0] as CborUint).value).toBe(3n);
    expect((v.items[1] as CborArray).items).toHaveLength(2);
    expect(v.toEDN()).toBe("cri'../../other/path'");
  });

  test("cri'../sibling?q=1#frag' — relative with query and fragment", () => {
    const v = CBOR.fromEDN("cri'../sibling?q=1#frag'");
    expect(v.toEDN()).toBe("cri'../sibling?q=1#frag'");
  });

  // ── Absolute-path references (first element = true / simple(21)) ──────────

  test("cri'/abs/path' — absolute-path reference → [true, ['abs','path']]", () => {
    const v = CBOR.fromEDN("cri'/abs/path'") as CborCriExt;
    expect(v.items[0]).toBeInstanceOf(CborSimple);
    expect((v.items[0] as CborSimple).value).toBe(21); // true
    expect((v.items[1] as CborArray).items).toHaveLength(2);
    expect(v.toEDN()).toBe("cri'/abs/path'");
  });

  test("cri'/' — root path only → [true, ['']]", () => {
    const v = CBOR.fromEDN("cri'/'") as CborCriExt;
    expect((v.items[0] as CborSimple).value).toBe(21);
    expect(v.toEDN()).toBe("cri'/'");
  });

  test("cri'/path?q=1#top' — absolute-path with query and fragment", () => {
    const v = CBOR.fromEDN("cri'/path?q=1#top'");
    expect(v.toEDN()).toBe("cri'/path?q=1#top'");
  });

  // ── Network-path references (first element = false / simple(20)) ──────────

  test("cri'//other.example.com/path' — network-path reference → [false, authority, path]", () => {
    const v = CBOR.fromEDN("cri'//other.example.com/path'") as CborCriExt;
    expect(v.items[0]).toBeInstanceOf(CborSimple);
    expect((v.items[0] as CborSimple).value).toBe(20); // false
    expect(v.items[1]).toBeInstanceOf(CborArray); // authority
    expect(v.items[2]).toBeInstanceOf(CborArray); // path
    expect(v.toEDN()).toBe("cri'//other.example.com/path'");
  });

  test("cri'//other.example.com:8080/api' — network-path with port", () => {
    const v = CBOR.fromEDN("cri'//other.example.com:8080/api'");
    expect(v.toEDN()).toBe("cri'//other.example.com:8080/api'");
  });

  test("cri'//other.example.com' — network-path, no path", () => {
    const v = CBOR.fromEDN("cri'//other.example.com'");
    expect(v.toEDN()).toBe("cri'//other.example.com'");
  });

  // ── Manual construction round-trip ────────────────────────────────────────

  test("manually constructed [2, ['sibling']] → cri'../sibling'", () => {
    const v = new CborCriExt([
      new CborUint(2n),
      new CborArray([new CborTextString('sibling')]),
    ]);
    expect(v.toEDN()).toBe("cri'../sibling'");
  });

  test("manually constructed [0, 'section'] → cri'#section'", () => {
    const v = new CborCriExt([new CborUint(0n), new CborTextString('section')]);
    expect(v.toEDN()).toBe("cri'#section'");
  });

  // ── appStrings:false falls back to generic array ──────────────────────────

  test('relative CRI with appStrings:false falls back to array notation', () => {
    const v = CBOR.fromEDN("cri'../sibling'");
    const edn = v.toEDN({ appStrings: false });
    expect(edn).toMatch(/^\[/);
    expect(edn).not.toContain("cri'");
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('cri — parse errors', () => {
  test("':foo' — colon in first segment without './' throws SyntaxError (RFC 3986 §3.3)", () => {
    expect(() => CBOR.fromEDN("cri':foo'")).toThrow(SyntaxError);
  });

  test("'1abc:def' — colon in first segment without './' throws SyntaxError", () => {
    expect(() => CBOR.fromEDN("cri'1abc:def'")).toThrow(SyntaxError);
  });

  test("'foo:bar/baz' — valid scheme, treated as absolute URI (not relative)", () => {
    // 'foo' is a valid scheme token → absolute URI, no error
    expect(() => CBOR.fromEDN("cri'foo:bar/baz'")).not.toThrow();
  });

  test("'../foo:bar' — valid relative-path reference (discard=2 disambiguates)", () => {
    // [2, ["foo:bar"]] is a valid CRI per §2.2; ../foo:bar is a valid URI reference
    expect(() => CBOR.fromEDN("cri'../foo:bar'")).not.toThrow();
    expect(CBOR.fromEDN("cri'../foo:bar'").toEDN()).toBe("cri'../foo:bar'");
  });

  test("'./this:that' — valid with explicit './' prefix", () => {
    // ./this:that → [1, ["this:that"]]; re-emitted as ./this:that (§6.1)
    expect(() => CBOR.fromEDN("cri'./this:that'")).not.toThrow();
    expect(CBOR.fromEDN("cri'./this:that'").toEDN()).toBe("cri'./this:that'");
  });

  test("'foo/bar:baz' — colon in second segment is fine", () => {
    expect(() => CBOR.fromEDN("cri'foo/bar:baz'")).not.toThrow();
  });

  test('invalid port throws SyntaxError', () => {
    expect(() => CBOR.fromEDN("cri'https://example.com:abc/path'")).toThrow(
      SyntaxError
    );
  });

  test('port out of range throws SyntaxError', () => {
    expect(() => CBOR.fromEDN("cri'https://example.com:99999/path'")).toThrow(
      SyntaxError
    );
  });
});
