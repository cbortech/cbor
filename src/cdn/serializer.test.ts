import { describe, test, expect } from 'vitest';
import type { ToCDNOptions } from '../types';
import { toCDN } from './serializer';
import { parseCDN } from './parser';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborByteString } from '../ast/CborByteString';
import { CborIndefiniteByteString } from '../ast/CborIndefiniteByteString';
import { CborTextString } from '../ast/CborTextString';
import { CborIndefiniteTextString } from '../ast/CborIndefiniteTextString';
import { CborArray } from '../ast/CborArray';
import { CborMap } from '../ast/CborMap';
import { CborTag } from '../ast/CborTag';
import { CborEmbeddedCBOR } from '../ast/CborEmbeddedCBOR';
import { CborFloat } from '../ast/CborFloat';
import { CborSimple } from '../ast/CborSimple';

// ─── Unsigned integers ────────────────────────────────────────────────────────

describe('CborUint.toCDN()', () => {
  test('0', () => expect(toCDN(new CborUint(0n))).toBe('0'));
  test('1', () => expect(toCDN(new CborUint(1n))).toBe('1'));
  test('255', () => expect(toCDN(new CborUint(255n))).toBe('255'));
  test('18446744073709551615', () => {
    expect(toCDN(new CborUint(18_446_744_073_709_551_615n))).toBe(
      '18446744073709551615'
    );
  });
});

// ─── Negative integers ────────────────────────────────────────────────────────

describe('CborNint.toCDN()', () => {
  test('-1', () => expect(toCDN(new CborNint(-1n))).toBe('-1'));
  test('-10', () => expect(toCDN(new CborNint(-10n))).toBe('-10'));
  test('-100', () => expect(toCDN(new CborNint(-100n))).toBe('-100'));
  test('-1000', () => expect(toCDN(new CborNint(-1000n))).toBe('-1000'));
});

// ─── Byte strings ─────────────────────────────────────────────────────────────

describe('CborByteString.toCDN()', () => {
  test('empty → sqstr (printable-string default)', () => {
    expect(toCDN(new CborByteString(new Uint8Array()))).toBe("''");
  });
  test('empty → hex with sqstr:none', () => {
    expect(toCDN(new CborByteString(new Uint8Array()), { sqstr: 'none' })).toBe(
      "h''"
    );
  });

  test('[01,02,03,04] hex (default)', () => {
    expect(
      toCDN(new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04])))
    ).toBe("h'01020304'");
  });

  test('[01,02,03,04] hex via options override', () => {
    expect(
      toCDN(
        new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04]), {
          ednEncoding: 'base64',
        }),
        { bstrEncoding: 'hex' }
      )
    ).toBe("h'01020304'");
  });

  test('[01,02,03,04] base64', () => {
    expect(
      toCDN(new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04])), {
        bstrEncoding: 'base64',
      })
    ).toBe("b64'AQIDBA'");
  });

  test('[01,02,03,04] base64url', () => {
    expect(
      toCDN(new CborByteString(new Uint8Array([0x01, 0x02, 0x03, 0x04])), {
        bstrEncoding: 'base64url',
      })
    ).toBe("b64'AQIDBA'");
  });

  test('ednEncoding on node (no options)', () => {
    expect(
      toCDN(new CborByteString(new Uint8Array([0xff]), { ednEncoding: 'hex' }))
    ).toBe("h'ff'");
  });

  test("sqstr:'string' — valid UTF-8 → single-quoted", () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(toCDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "'Hello'"
    );
  });
  test("sqstr:'string' — single quote in value is escaped", () => {
    const bytes = new TextEncoder().encode("it's");
    expect(toCDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "'it\\'s'"
    );
  });
  test("sqstr:'string' — invalid UTF-8 falls back to hex", () => {
    const bytes = new Uint8Array([0xff, 0xfe]);
    expect(toCDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "h'fffe'"
    );
  });
  test("sqstr:'string' — control characters are escaped (not hex fallback)", () => {
    const bytes = new TextEncoder().encode('a\nb');
    expect(toCDN(new CborByteString(bytes), { sqstr: 'string' })).toBe(
      "'a\\nb'"
    );
  });
});

describe("sqstr:'printable-string' (default)", () => {
  test('printable ASCII → single-quoted', () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(toCDN(new CborByteString(bytes))).toBe("'Hello'");
  });
  test('single quote in value is escaped', () => {
    const bytes = new TextEncoder().encode("it's");
    expect(toCDN(new CborByteString(bytes))).toBe("'it\\'s'");
  });
  test('control character (\\n) → hex fallback', () => {
    const bytes = new TextEncoder().encode('a\nb');
    expect(toCDN(new CborByteString(bytes))).toBe("h'610a62'");
  });
  test('DEL (0x7F) → hex fallback', () => {
    const bytes = new Uint8Array([0x41, 0x7f, 0x42]);
    expect(toCDN(new CborByteString(bytes))).toBe("h'417f42'");
  });
  test('invalid UTF-8 → hex fallback', () => {
    const bytes = new Uint8Array([0xff, 0xfe]);
    expect(toCDN(new CborByteString(bytes))).toBe("h'fffe'");
  });
  test("sqstr:'none' suppresses single-quoted output", () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(toCDN(new CborByteString(bytes), { sqstr: 'none' })).toBe(
      "h'48656c6c6f'"
    );
  });
});

describe('CborIndefiniteByteString.toCDN()', () => {
  test('two chunks', () => {
    const node = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([0x01, 0x02])),
      new CborByteString(new Uint8Array([0x03, 0x04, 0x05])),
    ]);
    expect(toCDN(node)).toBe("(_ h'0102',h'030405')");
  });

  test('empty chunks', () => {
    expect(toCDN(new CborIndefiniteByteString([]))).toBe("''_");
  });

  test('two chunks with indent=2', () => {
    const node = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([0x01, 0x02])),
      new CborByteString(new Uint8Array([0x03, 0x04, 0x05])),
    ]);
    expect(toCDN(node, { indent: 2 })).toBe("(_ \n  h'0102',\n  h'030405'\n)");
  });

  test('empty chunks with indent stays single-line', () => {
    expect(toCDN(new CborIndefiniteByteString([]), { indent: 2 })).toBe("''_");
  });
});

// ─── Text strings ─────────────────────────────────────────────────────────────

describe('CborTextString.toCDN()', () => {
  test('empty string', () => expect(toCDN(new CborTextString(''))).toBe('""'));
  test('hello', () =>
    expect(toCDN(new CborTextString('hello'))).toBe('"hello"'));
  test('with double quote', () =>
    expect(toCDN(new CborTextString('"'))).toBe('"\\""'));
  test('with backslash', () =>
    expect(toCDN(new CborTextString('\\'))).toBe('"\\\\"'));
  test('with newline', () =>
    expect(toCDN(new CborTextString('\n'))).toBe('"\\n"'));
  test('with tab', () => expect(toCDN(new CborTextString('\t'))).toBe('"\\t"'));
  test('with carriage return', () =>
    expect(toCDN(new CborTextString('\r'))).toBe('"\\r"'));
  test('control char U+0001', () =>
    expect(toCDN(new CborTextString('\x01'))).toBe('"\\u0001"'));
  test('unicode', () => expect(toCDN(new CborTextString('ü'))).toBe('"ü"'));
});

describe('CborIndefiniteTextString.toCDN()', () => {
  test('two chunks', () => {
    const node = new CborIndefiniteTextString([
      new CborTextString('strea'),
      new CborTextString('ming'),
    ]);
    expect(toCDN(node)).toBe('(_ "strea","ming")');
  });

  test('empty', () => {
    expect(toCDN(new CborIndefiniteTextString([]))).toBe('""_');
  });

  test('two chunks with indent=2', () => {
    const node = new CborIndefiniteTextString([
      new CborTextString('strea'),
      new CborTextString('ming'),
    ]);
    expect(toCDN(node, { indent: 2 })).toBe('(_ \n  "strea",\n  "ming"\n)');
  });

  test('nested in array with indent=2', () => {
    const node = new CborArray([
      new CborIndefiniteTextString([
        new CborTextString('a'),
        new CborTextString('b'),
      ]),
    ]);
    expect(toCDN(node, { indent: 2 })).toBe(
      '[\n  (_ \n    "a",\n    "b"\n  )\n]'
    );
  });
});

// ─── Arrays ───────────────────────────────────────────────────────────────────

describe('CborArray.toCDN() — single-line', () => {
  test('[]', () => expect(toCDN(new CborArray([]))).toBe('[]'));

  test('[1, 2, 3]', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborUint(2n),
      new CborUint(3n),
    ]);
    expect(toCDN(node)).toBe('[1,2,3]');
  });

  test('nested [1, [2, 3]]', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborArray([new CborUint(2n), new CborUint(3n)]),
    ]);
    expect(toCDN(node)).toBe('[1,[2,3]]');
  });

  test('[_ ] empty indefinite', () => {
    expect(toCDN(new CborArray([], { indefiniteLength: true }))).toBe('[_ ]');
  });

  test('[_ 1, 2] indefinite', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)], {
      indefiniteLength: true,
    });
    expect(toCDN(node)).toBe('[_ 1,2]');
  });
});

describe('CborArray.toCDN() — multi-line', () => {
  test('[1, 2, 3] with indent=2', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborUint(2n),
      new CborUint(3n),
    ]);
    expect(toCDN(node, { indent: 2 })).toBe('[\n  1,\n  2,\n  3\n]');
  });

  test('nested with indent=2', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborArray([new CborUint(2n), new CborUint(3n)]),
    ]);
    expect(toCDN(node, { indent: 2 })).toBe(
      '[\n  1,\n  [\n    2,\n    3\n  ]\n]'
    );
  });

  test('indefinite [_ 1, 2] with indent=2', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)], {
      indefiniteLength: true,
    });
    expect(toCDN(node, { indent: 2 })).toBe('[_ \n  1,\n  2\n]');
  });

  test('empty array with indent stays single-line', () => {
    expect(toCDN(new CborArray([]), { indent: 2 })).toBe('[]');
  });
});

describe('toCDN() — inlineLeafContainers', () => {
  const opts = { indent: 2, inlineLeafContainers: true };

  test('array of primitives stays single-line', () => {
    const node = new CborArray([
      new CborUint(1n),
      new CborUint(2n),
      new CborUint(3n),
    ]);
    expect(toCDN(node, opts)).toBe('[1, 2, 3]');
  });

  test('matrix: outer breaks, inner rows inline', () => {
    const node = new CborArray([
      new CborArray([new CborUint(1n), new CborUint(2n)]),
      new CborArray([new CborUint(3n), new CborUint(4n)]),
    ]);
    expect(toCDN(node, opts)).toBe('[\n  [1, 2],\n  [3, 4]\n]');
  });

  test('map of primitives stays single-line', () => {
    const node = new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);
    expect(toCDN(node, opts)).toBe('{1: 2, 3: 4}');
  });

  test('map with container value breaks; leaf value inlines', () => {
    const node = new CborMap([
      [
        new CborTextString('a'),
        new CborArray([new CborUint(1n), new CborUint(2n)]),
      ],
    ]);
    expect(toCDN(node, opts)).toBe('{\n  "a": [1, 2]\n}');
  });

  test('indefinite array of primitives stays single-line', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)], {
      indefiniteLength: true,
    });
    expect(toCDN(node, opts)).toBe('[_ 1, 2]');
  });

  test('indefinite string chunks stay single-line', () => {
    const node = new CborIndefiniteTextString([
      new CborTextString('a'),
      new CborTextString('b'),
    ]);
    expect(toCDN(node, opts)).toBe('(_ "a", "b")');
    const arr = new CborArray([node, new CborUint(1n)]);
    expect(toCDN(arr, opts)).toBe('[(_ "a", "b"), 1]');
  });

  test('tag wrapping a container is not inlined in its parent', () => {
    const node = new CborArray([
      new CborTag(100n, new CborArray([new CborUint(1n), new CborUint(2n)])),
    ]);
    expect(toCDN(node, opts)).toBe('[\n  100([1, 2])\n]');
  });

  test('tag wrapping a primitive inlines', () => {
    const node = new CborArray([
      new CborTag(1n, new CborUint(2n)),
      new CborTag(1n, new CborUint(3n)),
    ]);
    expect(toCDN(node, opts)).toBe('[1(2), 1(3)]');
  });

  test('entry rendering with a line break forces multi-line', () => {
    const node = new CborArray([new CborTextString('a\nb')]);
    expect(toCDN(node, { ...opts, splitNewline: true })).toBe(
      '[\n  "a\\n" +\n    "b"\n]'
    );
  });

  test('entry comments force multi-line', () => {
    const node = parseCDN('[1, 2 # trailing\n]', { preserveComments: true });
    expect(toCDN(node, { ...opts, preserveComments: true })).toBe(
      '[\n  1,\n  2 # trailing\n]'
    );
  });

  test('dangling comments force multi-line', () => {
    const node = parseCDN('[1, 2\n# dangling\n]', { preserveComments: true });
    expect(toCDN(node, { ...opts, preserveComments: true })).toBe(
      '[\n  1,\n  2\n  # dangling\n]'
    );
  });

  test('container-level trailing comment does not force multi-line', () => {
    const node = parseCDN('[1, 2] # trailing', { preserveComments: true });
    expect(toCDN(node, { ...opts, preserveComments: true })).toBe(
      '[1, 2] # trailing'
    );

    const mapNode = parseCDN('{ "a": 1, "b": 2 } // comment', {
      preserveComments: true,
    });
    expect(toCDN(mapNode, { ...opts, preserveComments: 'cdn-style' })).toBe(
      '{"a": 1, "b": 2} # comment'
    );
  });

  test('no effect without indent (compact single-line as usual)', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)]);
    expect(toCDN(node, { inlineLeafContainers: true })).toBe('[1,2]');
  });
});

describe('toCDN() — inlineLeafContainers with multi-word text/byte strings', () => {
  const opts = { indent: 2, inlineLeafContainers: true };

  test('single-word string entries stay single-line', () => {
    const node = new CborArray([
      new CborTextString('hello'),
      new CborTextString('world'),
    ]);
    expect(toCDN(node, opts)).toBe('["hello", "world"]');
  });

  test('a multi-word string entry forces the array multi-line', () => {
    const node = new CborArray([
      new CborTextString('Hello, World!'),
      new CborTextString('This is the CBOR library.'),
    ]);
    expect(toCDN(node, opts)).toBe(
      '[\n  "Hello, World!",\n  "This is the CBOR library."\n]'
    );
  });

  test('a multi-word map key or value forces the map multi-line', () => {
    const keyNode = new CborMap([
      [new CborTextString('two words'), new CborUint(1n)],
    ]);
    expect(toCDN(keyNode, opts)).toBe('{\n  "two words": 1\n}');

    const valueNode = new CborMap([
      [new CborTextString('a'), new CborTextString('two words')],
    ]);
    expect(toCDN(valueNode, opts)).toBe('{\n  "a": "two words"\n}');
  });

  test('a tag wrapping a multi-word string still disqualifies its parent', () => {
    const node = new CborArray([
      new CborTag(100n, new CborTextString('two words')),
    ]);
    expect(toCDN(node, opts)).toBe('[\n  100("two words")\n]');
  });

  test('an embedded CBOR entry with multi-word text still breaks despite the loose rule', () => {
    const node = new CborEmbeddedCBOR([
      new CborTextString('two words'),
      new CborUint(1n),
    ]);
    expect(toCDN(node, opts)).toBe('<<\n  "two words",\n  1\n>>');
  });

  test('an indefinite-length text string chunk with multi-word text still breaks', () => {
    const node = new CborIndefiniteTextString([
      new CborTextString('two words'),
      new CborTextString('b'),
    ]);
    expect(toCDN(node, opts)).toBe('(_ \n  "two words",\n  "b"\n)');
  });

  test('punctuation counts as a word boundary', () => {
    // "well-known" splits into two word-like segments (letters separated by `-`).
    const node = new CborArray([new CborTextString('well-known')]);
    expect(toCDN(node, opts)).toBe('[\n  "well-known"\n]');
  });

  test('a decimal point between digits does not count as a word boundary', () => {
    // Intl.Segmenter's UAX #29 word-break rules keep "3.14" as one numeric
    // word (unlike a generic letters/digits regex, which would split on `.`).
    const node = new CborArray([new CborTextString('3.14')]);
    expect(toCDN(node, opts)).toBe('["3.14"]');
  });

  test('space-less scripts (e.g. Japanese) still split on their own word boundaries', () => {
    // No ASCII whitespace/punctuation at all — Intl.Segmenter's dictionary
    // segmentation for Japanese still finds four word-like segments.
    const node = new CborArray([new CborTextString('これはテストです')]);
    expect(toCDN(node, opts)).toBe('[\n  "これはテストです"\n]');
  });

  test('no effect without inlineLeafContainers', () => {
    const node = new CborArray([
      new CborTextString('Hello, World!'),
      new CborTextString('This is the CBOR library.'),
    ]);
    expect(toCDN(node, { indent: 2 })).toBe(
      '[\n  "Hello, World!",\n  "This is the CBOR library."\n]'
    );
  });

  const encoder = new TextEncoder();

  test('single-word sqstr byte string entries stay single-line', () => {
    const node = new CborArray([
      new CborByteString(encoder.encode('hello')),
      new CborByteString(encoder.encode('world')),
    ]);
    expect(toCDN(node, opts)).toBe("['hello', 'world']");
  });

  test('a multi-word sqstr byte string entry forces the array multi-line', () => {
    const node = new CborArray([
      new CborByteString(encoder.encode('This is a test.')),
    ]);
    expect(toCDN(node, opts)).toBe("[\n  'This is a test.'\n]");
  });

  test('a prefixed byte-string literal always counts as multi-word, even a short one', () => {
    // Bytes 0x00 0x01 aren't printable, so this renders as h'0001' rather
    // than a bare sqstr — a hex dump has no natural word boundaries, so it
    // always disqualifies inlining regardless of length.
    const node = new CborArray([new CborByteString(new Uint8Array([0, 1]))]);
    expect(toCDN(node, opts)).toBe("[\n  h'0001'\n]");
  });

  test('the sqstr option changes which byte strings count as text', () => {
    // Printable ASCII bytes would normally render as a bare sqstr (single
    // word, stays inline) — but sqstr: 'none' forces hex rendering instead,
    // which always counts as multi-word.
    const node = new CborArray([new CborByteString(encoder.encode('hi'))]);
    expect(toCDN(node, { ...opts, sqstr: 'none' })).toBe("[\n  h'6869'\n]");
  });

  test('a trivial CborByteString subclass with multi-word bytes still disqualifies', () => {
    // A subclass that doesn't override _toCDN() at all renders exactly
    // like the base class — the multi-word check must judge it by its
    // actual content/rendering, not by whether it's a subclass at all.
    class DerivedByteString extends CborByteString {}
    const node = new CborArray([
      new DerivedByteString(encoder.encode('two words')),
    ]);
    expect(toCDN(node, opts)).toBe("[\n  'two words'\n]");
  });

  test('a tag wrapping a prefixed byte-string literal still disqualifies its parent array', () => {
    // The array is a strict frame, and CborTag forwards that rule straight
    // through to its content — h'00' still counts as multi-word here, same
    // as if the tag weren't there. Contrast with the loose-rule case in
    // "CborEmbeddedCBOR.toCDN() — inlineLeafContainers (loose rule)" below,
    // where the same tagged byte string stays inline instead.
    const node = new CborArray([
      new CborTag(100n, new CborByteString(new Uint8Array([0]))),
    ]);
    expect(toCDN(node, opts)).toBe("[\n  100(h'00')\n]");
  });

  test('an indefinite-length byte string chunk with a prefixed literal still disqualifies (strict rule)', () => {
    // Indefinite-length string groups follow the same strict rule as
    // CborArray/CborMap — unlike `<<...>>`, a prefixed byte-string literal
    // here always disqualifies inlining, same as it would in `[h'...']`.
    const node = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([0, 1])),
      new CborByteString(new Uint8Array([2, 3])),
    ]);
    expect(toCDN(node, opts)).toBe("(_ \n  h'0001',\n  h'0203'\n)");
  });
});

describe('CborEmbeddedCBOR.toCDN() — inlineLeafContainers (loose rule)', () => {
  const opts = { indent: 2, inlineLeafContainers: true };

  test('a map entry still inlines, unlike CborArray/CborMap', () => {
    // <<...>> is a flat sequence of encoded items, not a nested-structure
    // display, so entryIsLeaf is intentionally not consulted for it: an
    // entry that is itself an array/map still inlines as long as its own
    // rendering fits on one line.
    const node = new CborEmbeddedCBOR([
      new CborMap([[new CborUint(1n), new CborNint(-7n)]]),
    ]);
    expect(toCDN(node, opts)).toBe('<<{1: -7}>>');
  });

  test('array entries inline too', () => {
    const node = new CborEmbeddedCBOR([
      new CborArray([new CborUint(1n), new CborUint(2n)]),
      new CborArray([new CborUint(3n), new CborUint(4n)]),
    ]);
    expect(toCDN(node, opts)).toBe('<<[1, 2], [3, 4]>>');
  });

  test('a nested <<...>> entry still forces its own parent array multi-line', () => {
    // The loose rule is local to CborEmbeddedCBOR's own entries; a CborArray
    // containing a <<...>> entry still applies the strict entryIsLeaf rule.
    const node = new CborArray([
      new CborEmbeddedCBOR([
        new CborMap([[new CborUint(1n), new CborNint(-7n)]]),
      ]),
    ]);
    expect(toCDN(node, opts)).toBe('[\n  <<{1: -7}>>\n]');
  });

  test('entry rendering with a line break still forces multi-line', () => {
    const node = new CborEmbeddedCBOR([new CborTextString('a\nb')]);
    expect(toCDN(node, { ...opts, splitNewline: true })).toBe(
      '<<\n  "a\\n" +\n    "b"\n>>'
    );
  });

  test('a prefixed byte-string literal entry stays inline under the loose rule', () => {
    // Unlike a multi-word text string (which always disqualifies inlining,
    // loose rule or not — see "an embedded CBOR entry with multi-word text
    // still breaks despite the loose rule" above), a prefixed byte-string
    // literal only always counts as multi-word under the strict rule
    // (CborArray/CborMap). The loose rule treats it as an ordinary leaf
    // instead: h'0000' has no nested array/map, so it stays inline.
    const node = new CborEmbeddedCBOR([
      new CborByteString(new Uint8Array([0, 0])),
    ]);
    expect(toCDN(node, opts)).toBe("<<h'0000'>>");
  });

  test('a tag wrapping a prefixed byte-string literal is transparent to the loose rule', () => {
    // CborTag just forwards the strict/loose rule it was given to its
    // content — it doesn't decide independently — so the byte string here
    // is still governed by CborEmbeddedCBOR's loose rule and stays inline,
    // same as if the tag weren't there.
    const node = new CborEmbeddedCBOR([
      new CborTag(100n, new CborByteString(new Uint8Array([0, 0]))),
    ]);
    expect(toCDN(node, opts)).toBe("<<100(h'0000')>>");
  });
});

describe('CborEmbeddedCBOR.toCDN() — <<...>> always collapses regardless of inlineLeafContainers', () => {
  // <<...>>'s one-line collapse isn't gated behind inlineLeafContainers at
  // all: there's no structural reason to ever spread a flat encoded-item
  // sequence one item per line just because indent is set and the option
  // is off. Indefinite-length string groups do NOT get this treatment —
  // see the contrast test below — they follow the same option-gated
  // strict rule as CborArray/CborMap instead.
  const opts = { indent: 2 };

  test('<<...>> collapses without inlineLeafContainers', () => {
    const node = new CborEmbeddedCBOR([
      new CborByteString(new Uint8Array([0, 0])),
    ]);
    expect(toCDN(node, opts)).toBe("<<h'0000'>>");
  });

  test('a multi-word text entry still forces <<...>> multi-line without inlineLeafContainers', () => {
    const node = new CborEmbeddedCBOR([new CborTextString('two words')]);
    expect(toCDN(node, opts)).toBe('<<\n  "two words"\n>>');
  });

  test('contrast: an indefinite-length string group does NOT collapse without inlineLeafContainers', () => {
    // Unlike <<...>>, this follows CborArray/CborMap's option-gated rule —
    // spreads one entry per line by default, same as `[_ "a", "b"]` would.
    const textNode = new CborIndefiniteTextString([
      new CborTextString('a'),
      new CborTextString('b'),
    ]);
    expect(toCDN(textNode, opts)).toBe('(_ \n  "a",\n  "b"\n)');

    const byteNode = new CborIndefiniteByteString([
      new CborByteString(new Uint8Array([0, 1])),
      new CborByteString(new Uint8Array([2, 3])),
    ]);
    expect(toCDN(byteNode, opts)).toBe("(_ \n  h'0001',\n  h'0203'\n)");
  });

  test('a strict array/map is unaffected — still one entry per line without inlineLeafContainers', () => {
    const node = new CborArray([new CborUint(1n), new CborUint(2n)]);
    expect(toCDN(node, opts)).toBe('[\n  1,\n  2\n]');
  });
});

describe('CborArray.toCDN() — commas option', () => {
  const node = () =>
    new CborArray([new CborUint(1n), new CborUint(2n), new CborUint(3n)]);

  test("commas:'none' single-line → space-separated", () => {
    expect(toCDN(node(), { commas: 'none' })).toBe('[1 2 3]');
  });

  test("commas:'none' multi-line → no trailing comma on lines", () => {
    expect(toCDN(node(), { commas: 'none', indent: 2 })).toBe(
      '[\n  1\n  2\n  3\n]'
    );
  });

  test("commas:'trailing' multi-line → trailing comma on last item", () => {
    expect(toCDN(node(), { commas: 'trailing', indent: 2 })).toBe(
      '[\n  1,\n  2,\n  3,\n]'
    );
  });

  test("commas:'trailing' has no effect on single-line", () => {
    expect(toCDN(node(), { commas: 'trailing' })).toBe('[1,2,3]');
  });
});

// ─── Maps ─────────────────────────────────────────────────────────────────────

describe('CborMap.toCDN() — single-line', () => {
  test('{}', () => expect(toCDN(new CborMap([]))).toBe('{}'));

  test('{1: 2, 3: 4}', () => {
    const node = new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);
    expect(toCDN(node)).toBe('{1:2,3:4}');
  });

  test('{_ } empty indefinite', () => {
    expect(toCDN(new CborMap([], { indefiniteLength: true }))).toBe('{_ }');
  });

  test('{_ "a": 1} indefinite', () => {
    const node = new CborMap([[new CborTextString('a'), new CborUint(1n)]], {
      indefiniteLength: true,
    });
    expect(toCDN(node)).toBe('{_ "a":1}');
  });
});

describe('CborMap.toCDN() — multi-line', () => {
  test('{1: 2, 3: 4} with indent=2', () => {
    const node = new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);
    expect(toCDN(node, { indent: 2 })).toBe('{\n  1: 2,\n  3: 4\n}');
  });

  test('empty map with indent stays single-line', () => {
    expect(toCDN(new CborMap([]), { indent: 2 })).toBe('{}');
  });
});

describe('CborMap.toCDN() — inlineLeafContainers renders each key/value exactly once', () => {
  // entryIsMultiWordText's isPrefixedLiteralText check needs each side's
  // own rendering separately (the combined "key: value" string can't be
  // split unambiguously — see the comment in CborMap.ts), and renderEntry
  // needs the exact same strings right after. A per-index cache shares them
  // so a custom key/value's _toCDN() is never called twice for the same
  // render, matching serializeContainer's own single-render invariant.
  const opts = { indent: 2, inlineLeafContainers: true };

  function countingTextString(value: string, counts: number[], slot: number) {
    class Counting extends CborTextString {
      override _toCDN(o: ToCDNOptions | undefined, d: number): string {
        counts[slot]++;
        return super._toCDN(o, d);
      }
    }
    return new Counting(value);
  }

  test('a single-word entry that stays inline is rendered once per side', () => {
    const counts = [0, 0];
    const node = new CborMap([
      [countingTextString('a', counts, 0), countingTextString('b', counts, 1)],
    ]);
    expect(toCDN(node, opts)).toBe('{"a": "b"}');
    expect(counts).toEqual([1, 1]);
  });

  test('entries are still rendered once per side when the probe breaks partway and falls back to multi-line', () => {
    const counts = [0, 0, 0, 0];
    const node = new CborMap([
      [countingTextString('a', counts, 0), countingTextString('b', counts, 1)],
      [
        countingTextString('c', counts, 2),
        countingTextString('two words', counts, 3),
      ],
    ]);
    expect(toCDN(node, opts)).toBe('{\n  "a": "b",\n  "c": "two words"\n}');
    expect(counts).toEqual([1, 1, 1, 1]);
  });
});

describe('CborMap.toCDN() — commas option', () => {
  const node = () =>
    new CborMap([
      [new CborUint(1n), new CborUint(2n)],
      [new CborUint(3n), new CborUint(4n)],
    ]);

  test("commas:'none' single-line → space-separated", () => {
    expect(toCDN(node(), { commas: 'none' })).toBe('{1:2 3:4}');
  });

  test("commas:'none' multi-line → no trailing comma on lines", () => {
    expect(toCDN(node(), { commas: 'none', indent: 2 })).toBe(
      '{\n  1: 2\n  3: 4\n}'
    );
  });

  test("commas:'trailing' multi-line → trailing comma on last item", () => {
    expect(toCDN(node(), { commas: 'trailing', indent: 2 })).toBe(
      '{\n  1: 2,\n  3: 4,\n}'
    );
  });

  test("commas:'trailing' has no effect on single-line", () => {
    expect(toCDN(node(), { commas: 'trailing' })).toBe('{1:2,3:4}');
  });
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe('CborTag.toCDN()', () => {
  test('0("2013-03-21T20:04:00Z")', () => {
    const node = new CborTag(0n, new CborTextString('2013-03-21T20:04:00Z'));
    expect(toCDN(node)).toBe('0("2013-03-21T20:04:00Z")');
  });

  test('1(1363896240)', () => {
    const node = new CborTag(1n, new CborUint(1363896240n));
    expect(toCDN(node)).toBe('1(1363896240)');
  });

  test("23(h'01020304')", () => {
    const node = new CborTag(
      23n,
      new CborByteString(new Uint8Array([1, 2, 3, 4]))
    );
    expect(toCDN(node)).toBe("23(h'01020304')");
  });
});

describe('CborTag.toCDN() — inlineLeafContainers _isMultiWordText fallback', () => {
  // _isMultiWordText's prefixed-literal fallback (added to detect e.g.
  // 100(dt'...') and, with preserveByteString, 100(h'68')) renders
  // `this.content` to check its shape, and the real _toCDN() call right
  // after (via the array's renderEntry) renders it again — a deliberate,
  // uncached double-render (see CborTag.ts). An earlier version cached
  // this on the instance, which was wrong two ways, both regression-tested
  // below: the cache ignored depth (breaking preserveConcatenation's
  // depth-dependent continuation-line indentation) and never expired
  // (returning a stale render after the same `options` object was mutated
  // and reused for a second `toCDN()` call).
  const opts = { indent: 2, inlineLeafContainers: true };

  test('a tagged entry that stays inline renders its content more than once (accepted cost)', () => {
    let renderCount = 0;
    class Counting extends CborTextString {
      override _toCDN(o: ToCDNOptions | undefined, d: number): string {
        renderCount++;
        return super._toCDN(o, d);
      }
    }
    const node = new CborArray([new CborTag(100n, new Counting('word'))]);
    expect(toCDN(node, opts)).toBe('[100("word")]');
    expect(renderCount).toBe(2);
  });

  test('a tagged entry with no options passed at all does not throw', () => {
    // Regression guard: a naive cache-hit check of
    // `cache?.options === options` is trivially true when both are
    // `undefined`, even on a cache miss — this only matters if caching is
    // reintroduced; asserted here so that regression can't creep back in
    // silently.
    const node = new CborArray([new CborTag(100n, new CborTextString('word'))]);
    expect(node.toCDN()).toBe('[100("word")]');
  });

  test("preserveConcatenation indents a wrapped entry's continuation line by its actual depth", () => {
    // Regression guard: a render cached at a fixed depth (e.g. 0) for the
    // _isMultiWordText probe must not leak into the real, depth-correct
    // render — preserveConcatenation's continuation-line indentation
    // genuinely depends on depth even for leaf (non-container) content.
    const node = parseCDN('[100("a" + "b")]');
    expect(toCDN(node, { ...opts, preserveConcatenation: true })).toBe(
      '[\n  100("a" +\n    "b")\n]'
    );
  });

  test('mutating the same options object between two toCDN() calls is not masked by a stale cache', () => {
    const node = parseCDN('100("a" + "b")');
    const mutableOpts: ToCDNOptions = { indent: 2, inlineLeafContainers: true };
    expect(toCDN(node, mutableOpts)).toBe('100("ab")');
    mutableOpts.preserveConcatenation = true;
    expect(toCDN(node, mutableOpts)).toBe('100("a" +\n  "b")');
  });
});

describe('CborTag.toCDN() with preserveComments', () => {
  test('leading comment on the content forces multi-line', () => {
    const node = parseCDN('99(/note/ 42)', { preserveComments: true });
    // /note/ and 42 were on the same source line, so they stay together on
    // the content's own line rather than the comment getting a line above it.
    expect(toCDN(node, { indent: 2, preserveComments: true })).toBe(
      '99(\n  /note/ 42\n)'
    );
  });

  test('leading comment on its own source line stays on its own line', () => {
    const node = parseCDN('99(/note/\n42)', { preserveComments: true });
    expect(toCDN(node, { indent: 2, preserveComments: true })).toBe(
      '99(\n  /note/\n  42\n)'
    );
  });

  test('c-style / cdn-style normalise the marker', () => {
    const node = parseCDN('99(/note/ 42)', { preserveComments: true });
    expect(toCDN(node, { indent: 2, preserveComments: 'c-style' })).toBe(
      '99(\n  /*note*/ 42\n)'
    );
    const node2 = parseCDN('99(# note\n 42)', { preserveComments: true });
    expect(toCDN(node2, { indent: 2, preserveComments: 'cdn-style' })).toBe(
      '99(\n  # note\n  42\n)'
    );
  });

  test('trailing comment on the content stays on its line', () => {
    const node = parseCDN('99(42 /trailing/)', { preserveComments: true });
    expect(toCDN(node, { indent: 2, preserveComments: true })).toBe(
      '99(\n  42 /trailing/\n)'
    );
  });

  test('dangling comment (own line, nothing after it) is emitted before the close paren', () => {
    const node = parseCDN('99(\n  42\n  # dangling\n)', {
      preserveComments: true,
    });
    expect(toCDN(node, { indent: 2, preserveComments: true })).toBe(
      '99(\n  42\n  # dangling\n)'
    );
  });

  test('preserveComments: false drops the comment (no multi-line forced)', () => {
    const node = parseCDN('99(/note/ 42)', { preserveComments: true });
    expect(toCDN(node, { indent: 2, preserveComments: false })).toBe('99(42)');
    expect(toCDN(node, { indent: 2 })).toBe('99(42)');
  });

  test('no comments at all: unaffected, including nested multi-line content', () => {
    const node = parseCDN('12345({"a":1,"b":[1,2,3]})');
    expect(toCDN(node, { indent: 2 })).toBe(
      '12345({\n  "a": 1,\n  "b": [\n    1,\n    2,\n    3\n  ]\n})'
    );
  });

  test('no effect without indent (compact single-line, comments stripped as usual)', () => {
    const node = parseCDN('99(/note/ 42)', { preserveComments: true });
    expect(toCDN(node, { preserveComments: true })).toBe('99(42)');
  });
});

// ─── Floats ───────────────────────────────────────────────────────────────────

describe('CborFloat.toCDN()', () => {
  test('0.0 (half, auto)', () => expect(toCDN(new CborFloat(0.0))).toBe('0.0'));
  test('-0.0 (half, auto)', () =>
    expect(toCDN(new CborFloat(-0.0))).toBe('-0.0'));
  test('1.0 (half, auto — no suffix)', () =>
    expect(toCDN(new CborFloat(1.0))).toBe('1.0'));
  test('1.5 (half, auto)', () => expect(toCDN(new CborFloat(1.5))).toBe('1.5'));
  test('1.1 (double, auto)', () =>
    expect(toCDN(new CborFloat(1.1))).toBe('1.1'));
  test('100000.0 (single, auto)', () =>
    expect(toCDN(new CborFloat(100000.0))).toBe('100000.0'));
  test('Infinity (half, auto)', () =>
    expect(toCDN(new CborFloat(Infinity))).toBe('Infinity'));
  test('-Infinity (half, auto)', () =>
    expect(toCDN(new CborFloat(-Infinity))).toBe('-Infinity'));
  test('NaN (half, auto)', () => expect(toCDN(new CborFloat(NaN))).toBe('NaN'));

  // ── NaN with non-auto precision ───────────────────────────────────────────

  test('NaN precision=half → NaN (matches auto)', () => {
    expect(toCDN(new CborFloat(NaN, { precision: 'half' }))).toBe('NaN');
  });
  test('NaN precision=single → NaN_2', () => {
    expect(toCDN(new CborFloat(NaN, { precision: 'single' }))).toBe('NaN_2');
  });
  test('NaN precision=double → NaN_3', () => {
    expect(toCDN(new CborFloat(NaN, { precision: 'double' }))).toBe('NaN_3');
  });

  // ── Infinity with non-auto precision ──────────────────────────────────────

  test('Infinity precision=half → Infinity (matches auto)', () => {
    expect(toCDN(new CborFloat(Infinity, { precision: 'half' }))).toBe(
      'Infinity'
    );
  });
  test('Infinity precision=single → Infinity_2', () => {
    expect(toCDN(new CborFloat(Infinity, { precision: 'single' }))).toBe(
      'Infinity_2'
    );
  });
  test('Infinity precision=double → Infinity_3', () => {
    expect(toCDN(new CborFloat(Infinity, { precision: 'double' }))).toBe(
      'Infinity_3'
    );
  });
  test('-Infinity precision=half → -Infinity (matches auto)', () => {
    expect(toCDN(new CborFloat(-Infinity, { precision: 'half' }))).toBe(
      '-Infinity'
    );
  });
  test('-Infinity precision=single → -Infinity_2', () => {
    expect(toCDN(new CborFloat(-Infinity, { precision: 'single' }))).toBe(
      '-Infinity_2'
    );
  });
  test('-Infinity precision=double → -Infinity_3', () => {
    expect(toCDN(new CborFloat(-Infinity, { precision: 'double' }))).toBe(
      '-Infinity_3'
    );
  });

  test('1.0 precision=half → no suffix (matches auto)', () => {
    expect(toCDN(new CborFloat(1.0, { precision: 'half' }))).toBe('1.0');
  });
  test('1.0 precision=single → _2 suffix', () => {
    expect(toCDN(new CborFloat(1.0, { precision: 'single' }))).toBe('1.0_2');
  });
  test('1.0 precision=double → _3 suffix', () => {
    expect(toCDN(new CborFloat(1.0, { precision: 'double' }))).toBe('1.0_3');
  });
  test('100000.0 precision=half → _1 suffix (mismatches auto=single)', () => {
    expect(toCDN(new CborFloat(100000.0, { precision: 'half' }))).toBe(
      '100000.0_1'
    );
  });
  test('1.1 precision=double → no suffix (matches auto)', () => {
    expect(toCDN(new CborFloat(1.1, { precision: 'double' }))).toBe('1.1');
  });
});

// ─── floatFormat: 'hex' ───────────────────────────────────────────────────────

describe("CborFloat.toCDN() — floatFormat: 'hex'", () => {
  test('1.5 → 0x1.8p+0', () => {
    expect(toCDN(new CborFloat(1.5), { floatFormat: 'hex' })).toBe('0x1.8p+0');
  });
  test('1.0 → 0x1p+0', () => {
    expect(toCDN(new CborFloat(1.0), { floatFormat: 'hex' })).toBe('0x1p+0');
  });
  test('-1.5 → -0x1.8p+0', () => {
    expect(toCDN(new CborFloat(-1.5), { floatFormat: 'hex' })).toBe(
      '-0x1.8p+0'
    );
  });
  test('+0 → 0x0p+0', () => {
    expect(toCDN(new CborFloat(0.0), { floatFormat: 'hex' })).toBe('0x0p+0');
  });
  test('-0 → -0x0p+0', () => {
    expect(toCDN(new CborFloat(-0.0), { floatFormat: 'hex' })).toBe('-0x0p+0');
  });

  // Non-finite values are unchanged regardless of floatFormat
  test('Infinity → "Infinity" (unchanged)', () => {
    expect(toCDN(new CborFloat(Infinity), { floatFormat: 'hex' })).toBe(
      'Infinity'
    );
  });
  test('-Infinity → "-Infinity" (unchanged)', () => {
    expect(toCDN(new CborFloat(-Infinity), { floatFormat: 'hex' })).toBe(
      '-Infinity'
    );
  });
  test('NaN → "NaN" (unchanged)', () => {
    expect(toCDN(new CborFloat(NaN), { floatFormat: 'hex' })).toBe('NaN');
  });

  // Precision suffix is still emitted with hex format
  test('1.0 precision=single → 0x1p+0_2', () => {
    expect(
      toCDN(new CborFloat(1.0, { precision: 'single' }), { floatFormat: 'hex' })
    ).toBe('0x1p+0_2');
  });
  test('1.0 precision=double → 0x1p+0_3', () => {
    expect(
      toCDN(new CborFloat(1.0, { precision: 'double' }), { floatFormat: 'hex' })
    ).toBe('0x1p+0_3');
  });

  // default floatFormat behaves same as 'decimal'
  test("floatFormat: 'decimal' same as default", () => {
    const f = new CborFloat(1.5);
    expect(toCDN(f, { floatFormat: 'decimal' })).toBe(toCDN(f));
  });
});

// ─── intFormat ────────────────────────────────────────────────────────────────

describe('CborUint.toCDN() — intFormat', () => {
  test("default (decimal): 42 → '42'", () => {
    expect(toCDN(new CborUint(42n))).toBe('42');
  });
  test("'hex': 42 → '0x2a'", () => {
    expect(toCDN(new CborUint(42n), { intFormat: 'hex' })).toBe('0x2a');
  });
  test("'octal': 42 → '0o52'", () => {
    expect(toCDN(new CborUint(42n), { intFormat: 'octal' })).toBe('0o52');
  });
  test("'binary': 42 → '0b101010'", () => {
    expect(toCDN(new CborUint(42n), { intFormat: 'binary' })).toBe('0b101010');
  });
  test("0 → '0x0' in hex", () => {
    expect(toCDN(new CborUint(0n), { intFormat: 'hex' })).toBe('0x0');
  });
  test("encodingWidth preserved: 42_1 in hex → '0x2a_1'", () => {
    expect(
      toCDN(new CborUint(42n, { encodingWidth: 1 }), { intFormat: 'hex' })
    ).toBe('0x2a_1');
  });
  test("'decimal' same as default", () => {
    const n = new CborUint(255n);
    expect(toCDN(n, { intFormat: 'decimal' })).toBe(toCDN(n));
  });
});

describe('CborNint.toCDN() — intFormat', () => {
  test("default (decimal): -1 → '-1'", () => {
    expect(toCDN(new CborNint(-1n))).toBe('-1');
  });
  test("'hex': -1 → '-0x1'", () => {
    expect(toCDN(new CborNint(-1n), { intFormat: 'hex' })).toBe('-0x1');
  });
  test("'hex': -14159024 → '-0xd80cb0'", () => {
    expect(toCDN(new CborNint(-14159024n), { intFormat: 'hex' })).toBe(
      '-0xd80cb0'
    );
  });
  test("'octal': -8 → '-0o10'", () => {
    expect(toCDN(new CborNint(-8n), { intFormat: 'octal' })).toBe('-0o10');
  });
  test("'binary': -1 → '-0b1'", () => {
    expect(toCDN(new CborNint(-1n), { intFormat: 'binary' })).toBe('-0b1');
  });
  test("encodingWidth preserved: -1_1 in hex → '-0x1_1'", () => {
    expect(
      toCDN(new CborNint(-1n, { encodingWidth: 1 }), { intFormat: 'hex' })
    ).toBe('-0x1_1');
  });
});

// ─── Simple values ────────────────────────────────────────────────────────────

describe('CborSimple.toCDN()', () => {
  test('false', () => expect(toCDN(CborSimple.FALSE)).toBe('false'));
  test('true', () => expect(toCDN(CborSimple.TRUE)).toBe('true'));
  test('null', () => expect(toCDN(CborSimple.NULL)).toBe('null'));
  test('undefined', () =>
    expect(toCDN(CborSimple.UNDEFINED)).toBe('undefined'));
  test('simple(16)', () =>
    expect(toCDN(new CborSimple(16))).toBe('simple(16)'));
  test('simple(255)', () =>
    expect(toCDN(new CborSimple(255))).toBe('simple(255)'));
});

// ─── toCDN() convenience function ────────────────────────────────────────────

describe('toCDN() delegates to node.toCDN()', () => {
  test('delegates', () => {
    const node = new CborUint(42n);
    expect(toCDN(node)).toBe(node.toCDN());
  });
});

// ─── preserveComments with comment conversion ─────────────────────────────────

/** Parse CDN with comments collected, then re-serialize with the given options. */
function fmt(
  src: string,
  preserveComments: boolean | 'c-style' | 'cdn-style' = true,
  indent = 2
): string {
  return parseCDN(src, { preserveComments: true }).toCDN({
    preserveComments,
    indent,
  });
}

describe("preserveComments: 'c-style'", () => {
  test('# line → //', () =>
    expect(fmt('[\n  # comment\n  1\n]', 'c-style')).toBe(
      '[\n  // comment\n  1\n]'
    ));

  test('// line stays //', () =>
    expect(fmt('[\n  // comment\n  1\n]', 'c-style')).toBe(
      '[\n  // comment\n  1\n]'
    ));

  test('/ block / → /* block */', () =>
    expect(fmt('[\n  1 / note /\n]', 'c-style')).toBe('[\n  1 /* note */\n]'));

  test('/* block */ stays /* block */', () =>
    expect(fmt('[\n  1 /* note */\n]', 'c-style')).toBe(
      '[\n  1 /* note */\n]'
    ));

  test('root trailing comment', () =>
    expect(fmt('42 # end', 'c-style')).toBe('42 // end'));

  test('root leading comment', () =>
    expect(fmt('# start\n42', 'c-style')).toBe('// start\n42'));
});

describe("preserveComments: 'cdn-style'", () => {
  test('// line → #', () =>
    expect(fmt('[\n  // comment\n  1\n]', 'cdn-style')).toBe(
      '[\n  # comment\n  1\n]'
    ));

  test('# line stays #', () =>
    expect(fmt('[\n  # comment\n  1\n]', 'cdn-style')).toBe(
      '[\n  # comment\n  1\n]'
    ));

  test('/* block */ → / block /', () =>
    expect(fmt('[\n  1 /* note */\n]', 'cdn-style')).toBe(
      '[\n  1 / note /\n]'
    ));

  test('/ block / stays / block /', () =>
    expect(fmt('[\n  1 / note /\n]', 'cdn-style')).toBe('[\n  1 / note /\n]'));

  test('/** double-star */ → / *double-star / (space inserted)', () =>
    expect(fmt('[\n  1 /**double-star*/\n]', 'cdn-style')).toBe(
      '[\n  1 / *double-star/\n]'
    ));

  test('/* content with / */ kept as /* */ (cannot represent in / /)', () =>
    expect(fmt('[\n  1 /* 2026/6/7 */\n]', 'cdn-style')).toBe(
      '[\n  1 /* 2026/6/7 */\n]'
    ));

  test('root trailing comment', () =>
    expect(fmt('42 // end', 'cdn-style')).toBe('42 # end'));

  test('root leading comment', () =>
    expect(fmt('// start\n42', 'cdn-style')).toBe('# start\n42'));
});

describe('preserveComments: true (preserve markers as-is)', () => {
  test('mixed markers are kept unchanged', () => {
    const src = '[\n  # hash\n  1,\n  2 // line\n]';
    expect(fmt(src, true)).toBe(src);
  });
});

describe('preserveComments — map comments', () => {
  test("'c-style': map key leading and entry trailing", () =>
    expect(
      fmt('{\n  # key-leading\n  "a": 1 / val-trailing /\n}', 'c-style')
    ).toBe('{\n  // key-leading\n  "a": 1 /* val-trailing */\n}'));

  test("'cdn-style': map key leading and entry trailing", () =>
    expect(
      fmt('{\n  /* key-leading */\n  "a": 1 // val-trailing\n}', 'cdn-style')
    ).toBe('{\n  / key-leading /\n  "a": 1 # val-trailing\n}'));
});

describe('preserveComments — same-line leading comments', () => {
  // RFC 9052-style annotated arrays, e.g. COSE_Sign1: a leading comment on
  // the same source line as the entry (a "label") stays inline instead of
  // getting pushed onto its own line above.
  test('array entries: same-line comment stays inline', () => {
    const src = '[\n  / protected / 1,\n  / unprotected / 2\n]';
    expect(fmt(src)).toBe(src);
  });

  test('array entry: own-line comment still gets its own line', () => {
    const src = '[\n  // note\n  1\n]';
    expect(fmt(src)).toBe(src);
  });

  test('array entry: own-line comment followed by a same-line comment — only the latter is inlined', () => {
    const src = '[\n  // note\n  / protected / 1\n]';
    expect(fmt(src)).toBe(src);
  });

  test('map key: same-line comment stays inline', () => {
    const src = '{\n  / a / "x": 1,\n  / b / "y": 2\n}';
    expect(fmt(src)).toBe(src);
  });

  test('tag content: same-line comment stays inline', () => {
    const src = '99(\n  / note / 42\n)';
    expect(fmt(src)).toBe(src);
  });
});
