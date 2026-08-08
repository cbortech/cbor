import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { decodeCBOR } from '../cbor/decoder';
import { CborEllipsis, CPA888_TAG } from './CborEllipsis';
import { CborByteString } from './CborByteString';
import { CborTextString } from './CborTextString';
import { CborArray } from './CborArray';
import { CborMap } from './CborMap';
import { CborTag } from './CborTag';
import { CborSimple } from './CborSimple';
import { CborUint } from './CborUint';

// ─── Subtree elision: standalone ... ─────────────────────────────────────────

describe('CborEllipsis — subtree elision (888(null))', () => {
  test('... parses to CborEllipsis with CborSimple.NULL content', () => {
    const v = CBOR.fromCDN('...');
    expect(v).toBeInstanceOf(CborEllipsis);
    expect((v as CborEllipsis).tag).toBe(CPA888_TAG);
    expect((v as CborEllipsis).content).toBe(CborSimple.NULL);
  });

  test('... toCDN() round-trips to "..."', () => {
    const v = CBOR.fromCDN('...');
    expect(v.toCDN()).toBe('...');
  });

  test('... toCBOR() → tag(888, null)', () => {
    const v = CBOR.fromCDN('...');
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(888n);
    expect((decoded as CborTag).content).toBeInstanceOf(CborSimple);
    expect(((decoded as CborTag).content as CborSimple).value).toBe(22);
  });

  test('new CborEllipsis() constructs subtree elision', () => {
    const e = new CborEllipsis();
    expect(e.tag).toBe(888n);
    expect(e.content).toBe(CborSimple.NULL);
    expect(e.toCDN()).toBe('...');
  });

  test('... inside array', () => {
    const v = CBOR.fromCDN('[1, ..., 3]');
    expect(v).toBeInstanceOf(CborArray);
    const arr = v as CborArray;
    expect(arr.items[1]).toBeInstanceOf(CborEllipsis);
    expect(arr.items[1].toCDN()).toBe('...');
  });

  test('... inside map value', () => {
    const v = CBOR.fromCDN('{"key": ...}');
    expect(v.toCDN()).toContain('...');
  });
});

// ─── String elision: "prefix" + ... + "suffix" ───────────────────────────────

describe('CborEllipsis — text string elision (888([...]))', () => {
  test('"foo" + ... + "bar" → CborEllipsis with 3 items', () => {
    const v = CBOR.fromCDN('"foo" + ... + "bar"');
    expect(v).toBeInstanceOf(CborEllipsis);
    const e = v as CborEllipsis;
    expect(e.content).toBeInstanceOf(CborArray);
    const items = (e.content as CborArray).items;
    expect(items).toHaveLength(3);
    expect(items[0]).toBeInstanceOf(CborTextString);
    expect((items[0] as CborTextString).value).toBe('foo');
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect(items[2]).toBeInstanceOf(CborTextString);
    expect((items[2] as CborTextString).value).toBe('bar');
  });

  test('"foo" + ... + "bar" toCDN() → "foo" + ... + "bar"', () => {
    const v = CBOR.fromCDN('"foo" + ... + "bar"');
    expect(v.toCDN()).toBe('"foo" + ... + "bar"');
  });

  test('"foo" + ... → elision at end', () => {
    const v = CBOR.fromCDN('"foo" + ...');
    expect(v).toBeInstanceOf(CborEllipsis);
    expect(v.toCDN()).toBe('"foo" + ...');
  });

  test('... is a standalone subtree elision value', () => {
    // ... on its own parses as subtree elision, not a concat chain
    const v = CBOR.fromCDN('...');
    expect(v).toBeInstanceOf(CborEllipsis);
    expect((v as CborEllipsis).content).toBe(CborSimple.NULL);
  });

  test('"a" + "b" + ... + "c" → adjacent string fragments merged', () => {
    const v = CBOR.fromCDN('"a" + "b" + ... + "c"');
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    // "a" + "b" should merge into "ab"
    expect(items[0]).toBeInstanceOf(CborTextString);
    expect((items[0] as CborTextString).value).toBe('ab');
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect(items[2]).toBeInstanceOf(CborTextString);
    expect((items[2] as CborTextString).value).toBe('c');
  });

  test('"a" + ... + "b" + ... + "c" → multiple ellipsis', () => {
    const v = CBOR.fromCDN('"a" + ... + "b" + ... + "c"');
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(5);
    expect((items[0] as CborTextString).value).toBe('a');
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect((items[2] as CborTextString).value).toBe('b');
    expect(items[3]).toBeInstanceOf(CborEllipsis);
    expect((items[4] as CborTextString).value).toBe('c');
  });

  test('"foo" + ... + "bar" toCBOR() → tag(888, ["foo", 888(null), "bar"])', () => {
    const v = CBOR.fromCDN('"foo" + ... + "bar"');
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(888n);
    const arr = (decoded as CborTag).content as CborArray;
    expect(arr).toBeInstanceOf(CborArray);
    expect(arr.items).toHaveLength(3);
  });

  test('new CborEllipsis([items]) constructs string/bytes elision', () => {
    const items = [
      new CborTextString('foo'),
      new CborEllipsis(),
      new CborTextString('bar'),
    ];
    const e = new CborEllipsis(items);
    expect(e.tag).toBe(888n);
    expect(e.content).toBeInstanceOf(CborArray);
    expect(e.toCDN()).toBe('"foo" + ... + "bar"');
  });
});

// ─── Bytes elision: h'xx' + ... + h'yy' ──────────────────────────────────────

describe('CborEllipsis — byte string elision (888([...]))', () => {
  test("h'4711' + ... + h'0815' → CborEllipsis", () => {
    const v = CBOR.fromCDN("h'4711' + ... + h'0815'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(3);
    expect(items[0]).toBeInstanceOf(CborByteString);
    expect((items[0] as CborByteString).value).toEqual(
      new Uint8Array([0x47, 0x11])
    );
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect(items[2]).toBeInstanceOf(CborByteString);
    expect((items[2] as CborByteString).value).toEqual(
      new Uint8Array([0x08, 0x15])
    );
  });

  test("h'4711' + ... + h'0815' toCDN() round-trips to the compact h'4711...0815' literal", () => {
    const v = CBOR.fromCDN("h'4711' + ... + h'0815'");
    expect(v.toCDN()).toBe("h'4711...0815'");
  });

  test("h'4711...0815' — inline ellipsis in hex literal", () => {
    const v = CBOR.fromCDN("h'4711...0815'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(3);
    expect((items[0] as CborByteString).value).toEqual(
      new Uint8Array([0x47, 0x11])
    );
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect((items[2] as CborByteString).value).toEqual(
      new Uint8Array([0x08, 0x15])
    );
  });

  test("h'4711...0815' toCDN() round-trips verbatim", () => {
    const v = CBOR.fromCDN("h'4711...0815'");
    expect(v.toCDN()).toBe("h'4711...0815'");
  });

  test("h'...ff' — leading ellipsis in hex literal", () => {
    const v = CBOR.fromCDN("h'...ff'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(2);
    expect(items[0]).toBeInstanceOf(CborEllipsis);
    expect((items[1] as CborByteString).value).toEqual(new Uint8Array([0xff]));
  });

  test("h'ff...' — trailing ellipsis in hex literal", () => {
    const v = CBOR.fromCDN("h'ff...'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(2);
    expect((items[0] as CborByteString).value).toEqual(new Uint8Array([0xff]));
    expect(items[1]).toBeInstanceOf(CborEllipsis);
  });

  test("h'...' — pure ellipsis hex literal", () => {
    const v = CBOR.fromCDN("h'...'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(CborEllipsis);
  });

  test("h'aa' + ... — bytes then standalone ellipsis", () => {
    const v = CBOR.fromCDN("h'aa' + ...");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(2);
    expect((items[0] as CborByteString).value).toEqual(new Uint8Array([0xaa]));
    expect(items[1]).toBeInstanceOf(CborEllipsis);
  });

  test("h'aa' + h'bb' + ... + h'cc' — adjacent bytes merged", () => {
    const v = CBOR.fromCDN("h'aa' + h'bb' + ... + h'cc'");
    expect(v).toBeInstanceOf(CborEllipsis);
    const items = ((v as CborEllipsis).content as CborArray).items;
    expect(items).toHaveLength(3);
    expect((items[0] as CborByteString).value).toEqual(
      new Uint8Array([0xaa, 0xbb])
    );
    expect(items[1]).toBeInstanceOf(CborEllipsis);
    expect((items[2] as CborByteString).value).toEqual(new Uint8Array([0xcc]));
  });
});

// ─── CborEllipsis in EDN output via toCDN ────────────────────────────────────

describe('CborEllipsis — toCDN', () => {
  test('subtree elision → "..."', () => {
    expect(new CborEllipsis().toCDN()).toBe('...');
  });

  test('string elision → fragments joined with " + ", always single-line', () => {
    const e = new CborEllipsis([
      new CborTextString('hello'),
      new CborEllipsis(),
      new CborTextString('world'),
    ]);
    expect(e.toCDN()).toBe('"hello" + ... + "world"');
    // Unlike a real `+` concatenation, elision stays single-line even under
    // `indent`: it's an abbreviated, inherently short summary, not something
    // meant to be reflowed across lines.
    expect(e.toCDN({ indent: 2 })).toBe('"hello" + ... + "world"');
  });

  test("bytes elision (plain byte-string fragments) → compact h'xx...yy' literal", () => {
    const e = new CborEllipsis([
      new CborByteString(new Uint8Array([0x47, 0x11])),
      new CborEllipsis(),
      new CborByteString(new Uint8Array([0x08, 0x15])),
    ]);
    expect(e.toCDN()).toBe("h'4711...0815'");
    // Always hex, and always single-line, regardless of bstrEncoding/sqstr
    // or indent: h'...' is the only elidable literal form.
    expect(e.toCDN({ indent: 2, sqstr: 'none', bstrEncoding: 'base64' })).toBe(
      "h'4711...0815'"
    );
  });

  test("bytes elision with no byte fragment at all (h'...') falls back to the plain join", () => {
    const e = new CborEllipsis([new CborEllipsis()]);
    expect(e.toCDN()).toBe('...');
  });

  test('preserveConcatenation has no effect without a realBoundary array (nothing to preserve) — stays compact', () => {
    // Constructed directly (no `realBoundary`), same as an ellipsis
    // reconstructed from raw CBOR bytes: there is no "was there a real +
    // here" information to preserve, so this is identical to the
    // reconstruction-from-bytes case in extensions/ellipsis.test.ts.
    const e = new CborEllipsis([
      new CborByteString(new Uint8Array([0x47, 0x11])),
      new CborEllipsis(),
      new CborByteString(new Uint8Array([0x08, 0x15])),
    ]);
    expect(e.realBoundary).toBeUndefined();
    expect(e.toCDN({ preserveConcatenation: true })).toBe("h'4711...0815'");
  });

  test('preserveConcatenation keeps the frag + ... + frag spelling when realBoundary marks it real', () => {
    // realBoundary[0] is never consulted (nothing precedes the first item);
    // both the ellipsis and the trailing fragment are real (`+`-joined)
    // boundaries here, matching how the parser marks a genuine `h'4711' +
    // ... + h'0815'` chain.
    const e = new CborEllipsis(
      [
        new CborByteString(new Uint8Array([0x47, 0x11])),
        new CborEllipsis(),
        new CborByteString(new Uint8Array([0x08, 0x15])),
      ],
      [false, true, true]
    );
    expect(e.toCDN({ preserveConcatenation: true })).toBe(
      "h'4711' + ... + h'0815'"
    );
  });

  test("preserveConcatenation shows only the real `+` boundaries, not a `h'xx...yy'` literal's own internal `...`", () => {
    // 'test' and h'1234...abcd' sit across a real `+`, so that boundary is
    // shown; but the `...` inside h'1234...abcd' is that single literal's
    // own notation, not a `+`-joined fragment, so it stays fused instead of
    // expanding into h'1234' + ... + h'abcd'.
    const src = "'test' + h'1234...abcd' + ...";
    const expected = "'test' + h'1234...abcd' + ...";
    expect(CBOR.format(src, { preserveConcatenation: true })).toBe(expected);
    expect(CBOR.format(src, { preserveConcatenation: true, indent: 2 })).toBe(
      expected
    );
    // Without preserveConcatenation, the default compact form merges
    // everything it can into hex, including 'test'.
    expect(CBOR.format(src)).toBe("h'746573741234...abcd...'");
  });

  test('preserveConcatenation still splits a real `+` between two plain (non-elided) byte literals', () => {
    expect(
      CBOR.format("h'1234' + ... + h'abcd'", { preserveConcatenation: true })
    ).toBe("h'1234' + ... + h'abcd'");
    expect(
      CBOR.format("'test' + h'12' + h'34...56'", {
        preserveConcatenation: true,
      })
    ).toBe("'test' + h'12' + h'34...56'");
  });

  describe('preserveConcatenation + preserveComments keeps a comment next to a real `...` boundary', () => {
    // Regression coverage: a comment sitting between two `+`-joined
    // fragments in a chain that also contains a `...` used to be silently
    // dropped — the whole value becomes a `CborEllipsis` (tag 888) rather
    // than a plain `CborByteString`, so the comment ends up either
    // `dangling` on a fused multi-part `CborByteString` fragment (no
    // ellipsis directly between the two literals — they merge into one
    // `ednParts` item during parsing) or as ordinary `leading`/`trailing` on
    // one of the `CborEllipsis`'s own array items (an ellipsis genuinely
    // sits between the two literals), and neither was ever consulted by
    // `_renderPreservedBytesElision`.
    //
    // Elision is compact/single-line by default and stays that way unless a
    // comment actually needs the extra room — see `joinElisionParts` — so
    // every case below needs `indent` to actually show anything; without it
    // every comment is dropped, same as any other comment kind in
    // single-line output (covered at the end of this block).
    test('comment between two literals that merge into one ednParts fragment (no ellipsis between them)', () => {
      expect(
        CBOR.format("h'aa' + /* c */ h'bb' + ...", {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("h'aa' +\n  /* c */\n  h'bb' +\n  ...");
    });

    test('comment between an ellipsis and the literal that follows it (ordinary array items)', () => {
      expect(
        CBOR.format("h'aa' + ... + /* c */ h'bb'", {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("h'aa' +\n  ... +\n  /* c */\n  h'bb'");
    });

    test('comment between the literal that precedes an ellipsis and the ellipsis itself', () => {
      expect(
        CBOR.format("h'aa' + /* c */ ... + h'bb'", {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("h'aa' +\n  /* c */\n  ... +\n  h'bb'");
    });

    test('a # line comment in either position is preserved when indent lets the chain reflow', () => {
      expect(
        CBOR.format("h'aa' + # note\n  h'bb' + ...", {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("h'aa' +\n  # note\n  h'bb' +\n  ...");
      expect(
        CBOR.format("h'aa' + ... + # note\n  h'bb'", {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("h'aa' +\n  ... +\n  # note\n  h'bb'");
    });

    test('a trailing comment after the very last fragment is preserved, not lost', () => {
      // The comment ties, in source position, with this CborEllipsis's own
      // end (there's no closing delimiter after the last fragment to give
      // it a later end of its own), so `attachComments` resolves the tie in
      // favour of the last fragment itself. `promoteEllipsisTailComments`
      // (in the parser) moves it up onto the `CborEllipsis`'s own
      // `comments.trailing` right after parsing, so the ordinary
      // `entryTrailing`/root-`toCDN()` machinery renders it — on the same
      // line as the rest of the chain, since nothing else follows it there
      // (no reflow needed just for this).
      expect(
        CBOR.format("h'aa' + ... /* end */", {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("h'aa' + ... /* end */");
      expect(
        CBOR.format("h'aa' + h'bb' + ... # end\n", {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("h'aa' + h'bb' + ... # end");
    });

    test('the same trailing comment is preserved when nested inside an array', () => {
      // A `#` comment here is only safe because it's promoted onto the
      // CborEllipsis's own trailing — the array's `,` separator is emitted
      // by `entryTrailing`'s caller *before* the comment, not swallowed by
      // it (see the `# key`/`: value` map regression test below).
      expect(
        CBOR.format("[h'aa' + ... /* end */]", {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("[\n  h'aa' + ... /* end */\n]");
    });

    test('a trailing # comment does not swallow the parent separator (regression)', () => {
      // Before the last-fragment trailing comment was promoted onto the
      // CborEllipsis itself, it was folded directly into the chain's own
      // rendered body — so the parent's `:`/`,` separator, appended right
      // after, ended up as literal text *inside* the `#` comment, silently
      // corrupting the map/array on re-parse.
      const mapOut = CBOR.format("{h'aa' + ... # key\n: 1}", {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      });
      expect(mapOut).toBe("{\n  h'aa' + ...: 1 # key\n}");
      const reparsedMap = CBOR.fromCDN(mapOut, {
        preserveAll: true,
      }) as CborMap;
      expect(reparsedMap).toBeInstanceOf(CborMap);
      expect(reparsedMap.entries).toHaveLength(1);
      expect(reparsedMap.entries[0]![0]).toBeInstanceOf(CborEllipsis);
      expect(reparsedMap.entries[0]![1]).toBeInstanceOf(CborUint);
      expect((reparsedMap.entries[0]![1] as CborUint).value).toBe(1n);

      const arrSrc = "[h'aa' + ..., # next\n 1]";
      const arrOnce = CBOR.format(arrSrc, {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      });
      const arrTwice = CBOR.format(arrOnce, {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      });
      expect(arrTwice).toBe(arrOnce);
    });

    test('without indent, every comment is dropped, matching single-line output elsewhere', () => {
      expect(
        CBOR.format("h'aa' + /* c */ h'bb' + ...", {
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("h'aa' + h'bb' + ...");
      expect(
        CBOR.format("h'aa' + ... /* end */", {
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe("h'aa' + ...");
    });

    test('is stable under a second round trip', () => {
      const opts = {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      };
      for (const src of [
        "h'aa' + /* c */ h'bb' + ...",
        "h'aa' + ... + /* c */ h'bb'",
        "h'aa' + /* c */ ... + h'bb'",
        "h'aa' + # note\n  h'bb' + ...",
        "h'aa' + ... /* end */",
      ]) {
        const once = CBOR.format(src, opts);
        expect(CBOR.format(once, opts)).toBe(once);
      }
    });

    test('without preserveComments the comment is dropped as before, with no crash', () => {
      expect(
        CBOR.format("h'aa' + /* c */ h'bb' + ...", {
          indent: 2,
          preserveConcatenation: true,
        })
      ).toBe("h'aa' + h'bb' + ...");
    });
  });

  describe('preserveConcatenation + preserveComments keeps a comment next to a real `...` boundary (text elision)', () => {
    // Same regression as the byte-string describe block above, for text
    // elision: "a" + "b" merge into one `CborTextString` (`ednPartSpans
    // .length > 1`) when no ellipsis sits between them, so a comment there
    // lands as `dangling` on that fused node; otherwise it lands as ordinary
    // `leading`/`trailing` on one of the `CborEllipsis`'s own array items.
    // `_renderFragment`/`_toCDN`'s `frag + ... + frag` path used to consult
    // neither.
    test('comment between two literals that merge into one ednPartSpans fragment (no ellipsis between them)', () => {
      expect(
        CBOR.format('"a" + /* c */ "b" + ...', {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe('"a" +\n  /* c */\n  "b" + ...');
    });

    test('comment between an ellipsis and the literal that follows it (ordinary array items)', () => {
      expect(
        CBOR.format('"a" + ... + /* c */ "b"', {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe('"a" +\n  ... +\n  /* c */\n  "b"');
    });

    test('comment between the literal that precedes an ellipsis and the ellipsis itself', () => {
      expect(
        CBOR.format('"a" + /* c */ ... + "b"', {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe('"a" +\n  /* c */\n  ... +\n  "b"');
    });

    test('a # line comment in either position is preserved when indent lets the chain reflow', () => {
      expect(
        CBOR.format('"a" + # note\n  "b" + ...', {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe('"a" +\n  # note\n  "b" + ...');
      expect(
        CBOR.format('"a" + ... + # note\n  "b"', {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe('"a" +\n  ... +\n  # note\n  "b"');
    });

    test('a trailing comment after the very last fragment is preserved, not lost', () => {
      expect(
        CBOR.format('"a" + ... /* end */', {
          indent: 2,
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe('"a" + ... /* end */');
    });

    test('without indent, every comment is dropped, matching single-line output elsewhere', () => {
      expect(
        CBOR.format('"a" + /* c */ "b" + ...', {
          preserveConcatenation: true,
          preserveComments: true,
        })
      ).toBe('"a" + "b" + ...');
    });

    test('is stable under a second round trip', () => {
      const opts = {
        indent: 2,
        preserveConcatenation: true,
        preserveComments: true,
      };
      const src = '"a" + /* c */ "b" + ...';
      const once = CBOR.format(src, opts);
      expect(CBOR.format(once, opts)).toBe(once);
    });

    test('without preserveComments the comment is dropped as before, with no crash', () => {
      expect(
        CBOR.format('"a" + /* c */ "b" + ...', {
          indent: 2,
          preserveConcatenation: true,
        })
      ).toBe('"a" + "b" + ...');
    });
  });

  describe('preserveConcatenation with a leading/trailing/fully-elided literal on either side of a real +', () => {
    // Regression coverage for the case where an elided-hex literal's own
    // `...` sits at the very start or end of the literal (so the atom
    // adjacent to the real `+` boundary is the ellipsis itself, not a byte
    // segment) — the boundary must still land between the two *literals*,
    // not get absorbed into treating the ellipsis as a standalone token.
    test('leading-ellipsis literal on the right of +', () => {
      expect(
        CBOR.format("h'12' + h'...ff'", { preserveConcatenation: true })
      ).toBe("h'12' + h'...ff'");
    });

    test('leading-ellipsis literal on the left of +', () => {
      expect(
        CBOR.format("h'...ff' + h'12'", { preserveConcatenation: true })
      ).toBe("h'...ff' + h'12'");
    });

    test('trailing-ellipsis literal on the left of +', () => {
      expect(
        CBOR.format("h'12...' + h'ff'", { preserveConcatenation: true })
      ).toBe("h'12...' + h'ff'");
    });

    test('trailing-ellipsis literal on the right of +', () => {
      expect(
        CBOR.format("h'ff' + h'12...'", { preserveConcatenation: true })
      ).toBe("h'ff' + h'12...'");
    });

    test('fully-elided literal on the right of +', () => {
      expect(
        CBOR.format("h'12' + h'...'", { preserveConcatenation: true })
      ).toBe("h'12' + h'...'");
    });

    test('fully-elided literal on the left of +', () => {
      expect(
        CBOR.format("h'...' + h'12'", { preserveConcatenation: true })
      ).toBe("h'...' + h'12'");
    });

    test('two elided literals joined by a real +', () => {
      expect(
        CBOR.format("h'12...' + h'...ff'", { preserveConcatenation: true })
      ).toBe("h'12...' + h'...ff'");
    });
  });

  describe("preserveConcatenation + preserveByteString keeps a lone fragment's own spelling", () => {
    // A single byte atom next to an ellipsis (no `+`-merge with a neighbor,
    // so it never gets an `ednParts` array) still needs its own source
    // spelling preserved via `ednSource`, the same as a plain non-elided
    // byte-string literal.
    const opts = { preserveConcatenation: true, preserveByteString: true };

    test("h'41' next to a trailing ellipsis", () => {
      expect(CBOR.format("h'41' + ...", opts)).toBe("h'41' + ...");
    });

    test("h'41' next to a leading ellipsis", () => {
      expect(CBOR.format("... + h'41'", opts)).toBe("... + h'41'");
    });

    test("b64'QQ==' next to a trailing ellipsis", () => {
      expect(CBOR.format("b64'QQ==' + ...", opts)).toBe("b64'QQ==' + ...");
    });

    test("b64'QQ==' next to a leading ellipsis", () => {
      expect(CBOR.format("... + b64'QQ=='", opts)).toBe("... + b64'QQ=='");
    });

    test("empty h'' next to a trailing ellipsis", () => {
      expect(CBOR.format("h'' + ...", opts)).toBe("h'' + ...");
    });

    test("empty h'' next to a leading ellipsis", () => {
      expect(CBOR.format("... + h''", opts)).toBe("... + h''");
    });

    test("empty h'' as the fragment following a leading-ellipsis literal", () => {
      expect(CBOR.format("h'12...' + h''", opts)).toBe("h'12...' + h''");
    });

    test('without preserveByteString, the lone fragment still round-trips (just not verbatim)', () => {
      // 0x41 is printable ASCII, so the default (non-preserved) spelling is
      // the sqstr form 'A', not h'41' — this only confirms nothing throws
      // or drops the fragment when preserveByteString is off.
      expect(CBOR.format("h'41' + ...", { preserveConcatenation: true })).toBe(
        "'A' + ..."
      );
    });
  });

  describe("preserveConcatenation + preserveByteString keeps an elided h'xx...yy' literal's own spelling", () => {
    // The literal itself (case, interior whitespace, comments) is preserved
    // verbatim rather than re-encoded as fresh lower-case hex — the same
    // fidelity `preserveByteString` gives a non-elided byte-string literal.
    const opts = { preserveConcatenation: true, preserveByteString: true };

    test('uppercase hex digits', () => {
      expect(CBOR.format("h'AB...CD' + ...", opts)).toBe("h'AB...CD' + ...");
      expect(CBOR.format("... + h'AB...CD'", opts)).toBe("... + h'AB...CD'");
    });

    test('interior whitespace (no newline)', () => {
      const src = "h'ab ... cd' + ...";
      expect(CBOR.format(src, opts)).toBe(src);
    });

    test('a block comment inside the literal', () => {
      const src = "h'AB /x/ ... CD' + ...";
      // preserveByteString alone strips it — combine with preserveComments
      // to keep it, the same as for a non-elided h'...' literal.
      expect(CBOR.format(src, opts)).toBe("h'AB  ... CD' + ...");
      expect(CBOR.format(src, { ...opts, preserveComments: true })).toBe(src);
    });

    test('leading-ellipsis and trailing-ellipsis literals on either side of +', () => {
      expect(CBOR.format("h'AB' + h'...CD'", opts)).toBe("h'AB' + h'...CD'");
      expect(CBOR.format("h'AB...' + h'CD'", opts)).toBe("h'AB...' + h'CD'");
    });

    test('without preserveByteString, falls back to fresh lower-case hex (no comments)', () => {
      expect(
        CBOR.format("h'AB...CD' + ...", { preserveConcatenation: true })
      ).toBe("h'ab...cd' + ...");
    });

    describe('a preserved spelling that spans multiple lines', () => {
      // ToCDNOptions.indent guarantees single-line output contains no
      // newlines when indent is omitted (the same guarantee
      // CborByteString/CborTextString's own preserved-source fallback
      // honors) — a literal spelling with an embedded newline (interior
      // line break, or a `#`/`//` line comment) is only safe to re-emit
      // verbatim when `indent` enables multi-line output.
      test('interior line break falls back to fresh hex without indent', () => {
        expect(CBOR.format("h'ab\n  ...\n  cd' + ...", opts)).toBe(
          "h'ab...cd' + ..."
        );
      });

      test('interior line break is preserved verbatim with indent', () => {
        const src = "h'ab\n  ...\n  cd' + ...";
        expect(CBOR.format(src, { ...opts, indent: 2 })).toBe(src);
      });

      test('a line comment forces a fallback to fresh hex without indent', () => {
        expect(CBOR.format("h'ab # note\n  ...cd' + ...", opts)).toBe(
          "h'ab...cd' + ..."
        );
      });

      test('a line comment is stripped by preserveByteString alone, even with indent', () => {
        const src = "h'ab # note\n  ...cd' + ...";
        expect(CBOR.format(src, { ...opts, indent: 2 })).toBe(
          "h'ab \n  ...cd' + ..."
        );
      });

      test('a line comment is preserved verbatim with indent + preserveComments', () => {
        const src = "h'ab # note\n  ...cd' + ...";
        expect(
          CBOR.format(src, { ...opts, indent: 2, preserveComments: true })
        ).toBe(src);
      });
    });
  });

  describe("preserveByteString alone (no preserveConcatenation) preserves a non-concatenated h'xx...yy' literal", () => {
    // Per preserveByteString's own docs, "Byte strings produced by +
    // concatenation are normalised as usual; combine with
    // preserveConcatenation to keep both the part boundaries and each
    // part's spelling" — but a lone h'xx...yy' literal (no + anywhere) was
    // never "produced by + concatenation" in the first place, so
    // preserveByteString alone is enough, the same as for a non-elided
    // h'...' literal.
    const opts = { preserveByteString: true };

    test('uppercase hex digits, no + at all', () => {
      expect(CBOR.format("h'AB...CD'", opts)).toBe("h'AB...CD'");
    });

    test('a block comment inside the literal, no + at all', () => {
      const src = "h'AB /x/ ... CD'";
      // preserveByteString alone strips it — combine with preserveComments
      // to keep it.
      expect(CBOR.format(src, opts)).toBe("h'AB  ... CD'");
      expect(CBOR.format(src, { ...opts, preserveComments: true })).toBe(src);
    });

    test('a fully-elided literal, no + at all', () => {
      expect(CBOR.format("h'  ...  '", opts)).toBe("h'  ...  '");
    });

    test('leading/trailing-ellipsis literal, no + at all', () => {
      expect(CBOR.format("h'...CD'", opts)).toBe("h'...CD'");
      expect(CBOR.format("h'AB...'", opts)).toBe("h'AB...'");
    });

    test('a real + concatenation still merges/lower-cases as usual (preserveConcatenation not set)', () => {
      // The whole point of requiring preserveConcatenation for a genuine
      // `+`-joined chain: without it, this is normalised the same way a
      // plain `h'AB' + h'CD'` (non-elided) concatenation would be.
      expect(CBOR.format("h'AB' + h'CD...EF'", opts)).toBe("h'abcd...ef'");
      expect(CBOR.format("h'AB' + h'CD...EF'")).toBe("h'abcd...ef'");
    });

    test('a real + concatenation combined with preserveConcatenation still splits, uppercase kept', () => {
      expect(
        CBOR.format("h'AB' + h'CD...EF'", {
          ...opts,
          preserveConcatenation: true,
        })
      ).toBe("h'AB' + h'CD...EF'");
    });

    test('without preserveByteString, falls back to fresh lower-case hex', () => {
      expect(CBOR.format("h'AB...CD'")).toBe("h'ab...cd'");
    });

    test('a preserved spelling with an interior line break falls back without indent, keeps it with indent', () => {
      expect(CBOR.format("h'ab\n...\ncd'", opts)).toBe("h'ab...cd'");
      const src = "h'ab\n...\ncd'";
      expect(CBOR.format(src, { ...opts, indent: 2 })).toBe(src);
    });
  });

  test('stays single-line even inside an indented container', () => {
    const node = new CborArray([
      new CborEllipsis([
        new CborTextString('hello'),
        new CborEllipsis(),
        new CborTextString('world'),
      ]),
    ]);
    expect(node.toCDN({ indent: 2 })).toBe('[\n  "hello" + ... + "world"\n]');
  });

  test('a huge number of `...` markers inside one elided hex literal does not overflow the call stack', () => {
    // Regression: parsing an elided hex literal's atoms (split on `...`)
    // used `atoms.push(...sub)` — spreading `sub` as call arguments hits
    // the engine's argument-count limit long before 130k markers, and
    // `...` count inside a single token is unbounded by input size.
    const source = `h'00' + h'${'00...'.repeat(130_000)}00'`;
    expect(() => CBOR.fromCDN(source)).not.toThrow();
  });
});

// ─── modernConcat ─────────────────────────────────────────────────────────────

describe('CborEllipsis — toCDN with modernConcat', () => {
  const opts = { preserveConcatenation: true, modernConcat: true };

  test('text elision renders as t1<<...>>, with ... as a literal argument', () => {
    expect(CBOR.format('"a" + ... + "b"', opts)).toBe('t1<<"a", ..., "b">>');
  });

  test('bytes elision with a real boundary renders as b1<<...>>', () => {
    expect(CBOR.format("h'ab' + h'cd...ef' + h'01'", opts)).toBe(
      "b1<<h'ab', h'cd...ef', h'01'>>"
    );
  });

  test("a lone h'xx...yy' literal (no real boundary) is not wrapped", () => {
    // Nothing to concatenate — modernConcat only changes how a real `+`
    // boundary is spelled, not the compact elided-literal form itself.
    expect(CBOR.format("h'AB...CD'", opts)).toBe("h'ab...cd'");
  });

  test('falls back to raw tag notation when appStrings is false, same as without modernConcat', () => {
    // `...`/`+` elision notation is itself app-string sugar, so
    // `appStrings: false` already reverts the whole thing to `888([...])`
    // regardless of `modernConcat` — matching plain `preserveConcatenation`
    // with `appStrings: false`.
    const withT1B1 = CBOR.format('"a" + ... + "b"', {
      ...opts,
      appStrings: false,
    });
    const withoutT1B1 = CBOR.format('"a" + ... + "b"', {
      preserveConcatenation: true,
      appStrings: false,
    });
    expect(withT1B1).toBe(withoutT1B1);
  });

  test('applies even without preserveConcatenation — an elision chain always renders as multiple parts', () => {
    // Unlike plain (non-elision) concatenation, an elision chain has no
    // single-merged-literal state to begin with (the `...` denotes
    // genuinely unknown content), so modernConcat isn't gated behind
    // preserveConcatenation here.
    expect(CBOR.format('"a" + ... + "b"', { modernConcat: true })).toBe(
      't1<<"a", ..., "b">>'
    );
    // Also applies to a value reconstructed with no realBoundary info at
    // all (e.g. from raw CBOR — `_hasRealConcatenation`-style provenance is
    // irrelevant here, only the fragment shape matters).
    const raw = new CborEllipsis([
      new CborTextString('a'),
      new CborEllipsis(),
      new CborTextString('b'),
    ]);
    expect(raw.toCDN({ modernConcat: true })).toBe('t1<<"a", ..., "b">>');
  });

  test('plain (non-elision) concatenation still requires preserveConcatenation', () => {
    // The asymmetry with the elision case above is intentional: plain
    // concatenation collapses to one merged literal by default, and
    // modernConcat only changes the spelling of an already-preserved
    // expansion — see CborTextString/CborByteString.
    expect(CBOR.format('"a" + "b"', { modernConcat: true })).toBe('"ab"');
  });

  test('a fused (non-elided) `+` part inside an elision fragment nests its own t1<<>>', () => {
    const original = CBOR.fromCDN('"a" + "b" + ... + "c"');
    const rendered = original.toCDN(opts);
    expect(rendered).toBe('t1<<t1<<"a", "b">>, ..., "c">>');
    // Round-trips through t1/b1's own parser back to an equivalent value
    // (t1<<>>'s own parseAppSequence flattens the nested t1<<>> argument).
    expect(CBOR.fromCDN(rendered).toCBOR()).toEqual(original.toCBOR());
  });

  test('round-trips through the parser to an equivalent CBOR encoding', () => {
    const original = CBOR.fromCDN("h'ab' + h'cd...ef' + h'01'");
    const rendered = original.toCDN(opts);
    const reparsed = CBOR.fromCDN(rendered);
    expect(reparsed.toCBOR()).toEqual(original.toCBOR());
  });

  test('stays single-line even with indent, matching the plain + rendering', () => {
    expect(CBOR.format('"a" + ... + "b"', { ...opts, indent: 2 })).toBe(
      't1<<"a", ..., "b">>'
    );
  });
});
