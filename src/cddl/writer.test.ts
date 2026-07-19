import { describe, expect, test } from 'vitest';
import { CDDL, parseCDDL } from './index';

/** Deep-copy an AST value with `start`/`end` offsets removed. */
const stripPositions = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'start' || k === 'end') continue;
      out[k] = stripPositions(v);
    }
    return out;
  }
  return value;
};

/** parse → format → parse must reproduce the same AST (modulo offsets). */
const roundtrips = (text: string): string => {
  const first = parseCDDL(text).rules;
  const formatted = CDDL.compile(text, { strict: false }).format();
  const second = parseCDDL(formatted).rules;
  expect(stripPositions(second)).toEqual(stripPositions(first));
  return formatted;
};

describe('CDDL formatter', () => {
  test('normalizes spacing', () => {
    expect(roundtrips('a=int\nb   =   { x :  tstr }')).toBe(
      'a = int\nb = {x: tstr}\n'
    );
  });

  test('keeps literal values verbatim (bases, escapes, qualifiers)', () => {
    const formatted = roundtrips(
      `t = 0x1F / 0b101 / -5 / 1.5e-3 / 0x1.8p+1 / "a\\nb" / h'BEEF' / b64'Zm9v' / 'raw'`
    );
    for (const lit of [
      '0x1F',
      '0b101',
      '-5',
      '1.5e-3',
      '0x1.8p+1',
      '"a\\nb"',
      "h'BEEF'",
      "b64'Zm9v'",
      "'raw'",
    ])
      expect(formatted).toContain(lit);
  });

  test('formats the whole construct zoo', () => {
    expect(
      roundtrips(
        `msg<t> = { type: t, ? id: uint, * tstr => any, k ^ => int }
choice = (int / tstr // 1*2 (a: 1))
arr = [+ item, (b // c)]
item = ~base
base = &(x: 1, y: 2)
tags = #6.<num>(any) / #6.37(bstr) / #7.25 / #0.3 / #
num = 100..200
sized = tstr .size (1...5)
socketed = { $$ext }
`
      )
    ).toBe(`msg<t> = {type: t, ? id: uint, * tstr => any, k ^ => int}
choice = (int / tstr // 1*2 (a: 1))
arr = [+ item, (b // c)]
item = ~base
base = &(x: 1, y: 2)
tags = #6.<num>(any) / #6.37(bstr) / #7.25 / #0.3 / #
num = 100..200
sized = tstr .size (1...5)
socketed = {$$ext}
`);
  });

  test('tag and major-type head-numbers keep their source spelling', () => {
    expect(roundtrips('a = #6.0x10(tstr)\nb = #7.0b11001\nc = #0.0x3')).toBe(
      'a = #6.0x10(tstr)\nb = #7.0b11001\nc = #0.0x3\n'
    );
  });

  test('occurrence forms', () => {
    expect(roundtrips('a = [? x, + y, * z, 2*3 w, 1* v, *4 u]')).toBe(
      'a = [? x, + y, * z, 2*3 w, 1* v, *4 u]\n'
    );
  });

  test('rule-level group entries and extensions', () => {
    expect(roundtrips('g //= (a: 1 // b: 2)\nh /= int')).toBe(
      'g //= (a: 1 // b: 2)\nh /= int\n'
    );
  });

  test('trailing commas survive formatting (they mark groups)', () => {
    expect(
      roundtrips('start = int\ng = (a: 1,)\nm = {x: int,}\narr = [1, 2,]')
    ).toBe('start = int\ng = (a: 1,)\nm = {x: int,}\narr = [1, 2,]\n');
  });

  test('empty containers', () => {
    expect(roundtrips('a = {}\nb = []\nc = ()')).toBe(
      'a = {}\nb = []\nc = ()\n'
    );
  });
});

describe('CDDL formatter: pretty layout (indent)', () => {
  /** Pretty round trip: parse → format({indent}) → parse, same AST. */
  const prettyRoundtrips = (text: string): string => {
    const first = parseCDDL(text).rules;
    const formatted = CDDL.compile(text, { strict: false }).format({
      indent: 2,
      preserveComments: true,
    });
    const second = parseCDDL(formatted).rules;
    expect(stripPositions(second)).toEqual(stripPositions(first));
    return formatted;
  };

  test('multi-entry groups get one entry per line', () => {
    expect(prettyRoundtrips('person = {name: tstr, ? age: uint}')).toBe(
      'person = {\n  name: tstr,\n  ? age: uint\n}\n'
    );
  });

  test('single-entry groups stay inline', () => {
    expect(prettyRoundtrips('t = [* int]\nu = {a: int}')).toBe(
      't = [* int]\nu = {a: int}\n'
    );
  });

  test('nesting indents accumulate; blank lines separate multiline rules', () => {
    expect(
      prettyRoundtrips(
        'a = int\nt = {meta: {version: uint, tags: [* tstr]}, body: bstr}\nb = int'
      )
    ).toBe(
      `a = int

t = {
  meta: {
    version: uint,
    tags: [* tstr]
  },
  body: bstr
}

b = int
`
    );
  });

  test('group choices are separated by a // line', () => {
    expect(prettyRoundtrips('t = [a // b, c]\na = 1\nb = 2\nc = 3')).toBe(
      `t = [
  a,
  //
  b,
  c
]

a = 1
b = 2
c = 3
`
    );
  });

  test('trailing commas are preserved in both layouts', () => {
    expect(prettyRoundtrips('t = {a: int, b: tstr,}')).toBe(
      't = {\n  a: int,\n  b: tstr,\n}\n'
    );
    expect(prettyRoundtrips('g = (int,)')).toBe('g = (int,)\n');
  });

  test('indent accepts a literal string', () => {
    const out = CDDL.compile('t = {a: int, b: tstr}').format({
      indent: '\t',
    });
    expect(out).toBe('t = {\n\ta: int,\n\tb: tstr\n}\n');
  });

  test('pretty formatting is idempotent', () => {
    const opts = { indent: 2 as const, preserveComments: true };
    const once = CDDL.compile(
      'person = {name: tstr, ? age: uint / nil, addr: {street: tstr, zip: uint}}'
    ).format(opts);
    const twice = CDDL.compile(once).format(opts);
    expect(twice).toBe(once);
  });
});

describe('CDDL formatter: comments (preserveComments)', () => {
  test('the default playground sample formats to itself', () => {
    const text = `; CDDL (RFC 8610) — the schema language for CBOR. Edit me!
person = {
  name: tstr,
  ? age: uint,
  ? email: tstr .regexp "[^@]+@[^@]+",
}
`;
    const out = CDDL.compile(text).format({
      indent: 2,
      preserveComments: true,
    });
    expect(out).toBe(text);
  });

  test('rule-level comments survive both layouts', () => {
    const text = '; header\na = int ; trailing\nb = tstr\n';
    expect(CDDL.compile(text).format({ preserveComments: true })).toBe(
      '; header\na = int ; trailing\nb = tstr\n'
    );
    expect(
      CDDL.compile(text).format({ indent: 2, preserveComments: true })
    ).toBe('; header\na = int ; trailing\nb = tstr\n');
  });

  test('entry-level comments attach to their entries in pretty layout', () => {
    const text = `g = (
  "name": tstr, ; key comment
  ; leading note
  age: int,
)
`;
    const out = CDDL.compile(text, { strict: false }).format({
      indent: 2,
      preserveComments: true,
    });
    expect(out).toBe(text);
  });

  test('a comment forces its single-entry group onto multiple lines', () => {
    const out = CDDL.compile('t = [\n  ; only entry\n  int\n]').format({
      indent: 2,
      preserveComments: true,
    });
    expect(out).toBe('t = [\n  ; only entry\n  int\n]\n');
  });

  test('comments before a rule body are kept (pretty) or hoisted (compact)', () => {
    const source = 'a = ; important\n  int';
    expect(
      CDDL.compile(source).format({ indent: 2, preserveComments: true })
    ).toBe('a =\n  ; important\n  int\n');
    expect(CDDL.compile(source).format({ preserveComments: true })).toBe(
      '; important\na = int\n'
    );
  });

  test('comments after the last entry sit before the group closer', () => {
    const text = `t = {
  a: int,
  ; last
}
`;
    expect(
      CDDL.compile(text).format({ indent: 2, preserveComments: true })
    ).toBe(text);
  });

  test('comments in empty groups stay inside the delimiters', () => {
    const text = `t = [
  ; nothing yet
]
`;
    expect(
      CDDL.compile(text).format({ indent: 2, preserveComments: true })
    ).toBe(text);
  });

  test('comments between inline type choices move to the rule line end', () => {
    const out = CDDL.compile('a = int /\n  ; note\n  tstr').format({
      indent: 2,
      preserveComments: true,
    });
    expect(out).toBe('a = int / tstr ; note\n');
  });

  test('comments after the last rule are kept at the end', () => {
    const out = CDDL.compile('a = int\n; the end').format({
      preserveComments: true,
    });
    expect(out).toBe('a = int\n; the end\n');
  });

  test('comments are dropped without preserveComments', () => {
    expect(CDDL.compile('; note\na = int').format()).toBe('a = int\n');
  });
});

describe('CDDL formatter: fixed points', () => {
  test('formatting is idempotent', () => {
    const once = CDDL.compile('person = {name: tstr, ? age: uint / nil}\n', {
      strict: false,
    }).format();
    const twice = CDDL.compile(once, { strict: false }).format();
    expect(twice).toBe(once);
  });
});
