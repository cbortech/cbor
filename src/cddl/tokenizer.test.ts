import { describe, expect, test } from 'vitest';
import { CddlSyntaxError, tokenize, tokenizeLenient } from './index';

const types = (text: string): string[] =>
  tokenize(text).tokens.map((t) => t.type);

describe('CDDL tokenizer: identifiers', () => {
  test('scans plain, extended, and dotted ids', () => {
    const { tokens } = tokenize('a A9 @me _x $sock $$gsock a-b a.b a1-b2.c3');
    expect(tokens.map((t) => [t.type, t.value])).toEqual([
      ['ID', 'a'],
      ['ID', 'A9'],
      ['ID', '@me'],
      ['ID', '_x'],
      ['ID', '$sock'],
      ['ID', '$$gsock'],
      ['ID', 'a-b'],
      ['ID', 'a.b'],
      ['ID', 'a1-b2.c3'],
    ]);
  });

  test('tstr.size is a single id (ABNF note: space needed before operator)', () => {
    const { tokens } = tokenize('tstr.size');
    expect(tokens.map((t) => [t.type, t.value])).toEqual([['ID', 'tstr.size']]);
  });

  test('min..max is a single name, not a range (RFC 8610 §2.2.2.1)', () => {
    for (const id of ['a..b', 'min..max', 'max..0', 'b..5'])
      expect(tokenize(id).tokens.map((t) => [t.type, t.value])).toEqual([
        ['ID', id],
      ]);
  });

  test('a name-based range needs spacing: min .. max', () => {
    expect(tokenize('min .. max').tokens.map((t) => t.type)).toEqual([
      'ID',
      'RANGE_INCL',
      'ID',
    ]);
    expect(tokenize('min ..max').tokens.map((t) => t.type)).toEqual([
      'ID',
      'RANGE_INCL',
      'ID',
    ]);
  });

  test('trailing separators are not part of an id', () => {
    // 'a' then '.b' scans as a single id a.b, but 'a.' followed by
    // whitespace leaves the dot, which then fails as a control operator.
    expect(() => tokenize('a. ')).toThrow(CddlSyntaxError);
  });
});

describe('CDDL tokenizer: operators and punctuation', () => {
  test('maximal munch for slash operators', () => {
    expect(types('a //= b // c /= d / e')).toEqual([
      'ID',
      'DSLASH_EQ',
      'ID',
      'DSLASH',
      'ID',
      'SLASH_EQ',
      'ID',
      'SLASH',
      'ID',
    ]);
  });

  test('range and control operators', () => {
    expect(types('0..10 0...10 tstr .size 5')).toEqual([
      'INT',
      'RANGE_INCL',
      'INT',
      'INT',
      'RANGE_EXCL',
      'INT',
      'ID',
      'CTLOP',
      'INT',
    ]);
    const { tokens } = tokenize('x .size 2');
    expect(tokens[1]).toMatchObject({
      type: 'CTLOP',
      value: 'size',
      raw: '.size',
    });
  });

  test('memberkey and occurrence punctuation', () => {
    expect(types('? a: 1, + b => 2, * c ^ => 3')).toEqual([
      'QUEST',
      'ID',
      'COLON',
      'INT',
      'COMMA',
      'PLUS',
      'ID',
      'ARROW',
      'INT',
      'COMMA',
      'STAR',
      'ID',
      'CARET',
      'ARROW',
      'INT',
    ]);
  });

  test('tab is rejected as whitespace', () => {
    expect(() => tokenize('a\t= int')).toThrow(/horizontal tab/);
  });
});

describe('CDDL tokenizer: numbers', () => {
  test('int forms', () => {
    const { tokens } = tokenize('0 10 -5 0x1F 0b101 -0x10');
    expect(tokens.map((t) => [t.type, t.value])).toEqual([
      ['INT', '0'],
      ['INT', '10'],
      ['INT', '-5'],
      ['INT', '0x1F'],
      ['INT', '0b101'],
      ['INT', '-0x10'],
    ]);
  });

  test('float forms', () => {
    const { tokens } = tokenize('1.5 -0.25 1e10 1.5e-3 0x1.8p+1 -0x1p-3');
    expect(tokens.map((t) => [t.type, t.value])).toEqual([
      ['FLOAT', '1.5'],
      ['FLOAT', '-0.25'],
      ['FLOAT', '1e10'],
      ['FLOAT', '1.5e-3'],
      ['FLOAT', '0x1.8p+1'],
      ['FLOAT', '-0x1p-3'],
    ]);
  });

  test('a fraction dot is never confused with a range', () => {
    expect(types('1..5')).toEqual(['INT', 'RANGE_INCL', 'INT']);
    expect(types('1.5..2.5')).toEqual(['FLOAT', 'RANGE_INCL', 'FLOAT']);
    expect(types('0x10..0x20')).toEqual(['INT', 'RANGE_INCL', 'INT']);
  });

  test('leading zeros are rejected', () => {
    expect(() => tokenize('007')).toThrow(/leading zeros/);
  });

  test('hex fraction requires a p exponent', () => {
    expect(() => tokenize('0x1.8')).toThrow(/hexfloat/);
  });
});

describe('CDDL tokenizer: strings', () => {
  test('text strings decode escapes', () => {
    const { tokens } = tokenize(String.raw`"a\"b\\c\ndAe\u{1F073}f"`);
    expect(tokens[0]).toMatchObject({
      type: 'TSTR',
      value: 'a"b\\c\ndAe\u{1F073}f',
    });
  });

  test('surrogate pair escapes decode to one code point', () => {
    const { tokens } = tokenize(String.raw`"🁳"`);
    expect(tokens[0]!.value).toBe('\u{1F073}');
  });

  test('lone surrogate escapes are rejected', () => {
    expect(() => tokenize(String.raw`"\uD83C"`)).toThrow(/surrogate/);
    expect(() => tokenize(String.raw`"\uDC73"`)).toThrow(/surrogate/);
    expect(() => tokenize(String.raw`"\u{D800}"`)).toThrow(/surrogate/);
  });

  test('text strings cannot span lines', () => {
    expect(() => tokenize('"a\nb"')).toThrow(/span lines/);
  });

  test("\\' is valid only in byte strings", () => {
    expect(() => tokenize(String.raw`"a\'b"`)).toThrow(CddlSyntaxError);
    const { tokens } = tokenize(String.raw`'a\'b'`);
    expect(tokens[0]!.bytes).toEqual(new TextEncoder().encode("a'b"));
  });
});

describe('CDDL tokenizer: byte strings', () => {
  test("unqualified '' is UTF-8 text content", () => {
    const { tokens } = tokenize("'Domino'");
    expect(tokens[0]).toMatchObject({ type: 'BYTES', qualifier: '' });
    expect(tokens[0]!.bytes).toEqual(new TextEncoder().encode('Domino'));
  });

  test('RFC 9682 Figure 5: escaping techniques produce identical bytes', () => {
    const expected = new TextEncoder().encode("Domino's 🁳 + ⌘");
    const literals = [
      String.raw`"D\u{6f}mino's \u{1F073} + \u{2318}"`,
      String.raw`"Domino's 🁳 + ⌘"`,
      `"Domino's 🁳 + ⌘"`,
      String.raw`'D\u{6f}mino\u{27}s \u{1F073} + \u{2318}'`,
      String.raw`'Domino\'s 🁳 + ⌘'`,
      `'Domino\\'s 🁳 + ⌘'`,
    ];
    for (const lit of literals) {
      const tok = tokenize(lit).tokens[0]!;
      const bytes =
        tok.type === 'TSTR' ? new TextEncoder().encode(tok.value) : tok.bytes;
      expect(bytes, lit).toEqual(expected);
    }
  });

  test('byte strings may span lines (CRLF is content)', () => {
    const { tokens } = tokenize("'a\nb'");
    expect(tokens[0]!.bytes).toEqual(new TextEncoder().encode('a\nb'));
  });

  test("h'' decodes hex, ignoring whitespace and comments", () => {
    const { tokens } = tokenize("h'44 65 ; comment\n 66'");
    expect(tokens[0]!.bytes).toEqual(new Uint8Array([0x44, 0x65, 0x66]));
    expect(tokens[0]).toMatchObject({ qualifier: 'h' });
  });

  test("b64'' decodes classic and url-safe base64", () => {
    expect(tokenize("b64'Zm9v'").tokens[0]!.bytes).toEqual(
      new TextEncoder().encode('foo')
    );
    expect(tokenize("b64'_-8='").tokens[0]!.bytes).toEqual(
      new Uint8Array([0xff, 0xef])
    );
  });

  test("invalid hex in h'' is a syntax error with position", () => {
    try {
      tokenize("h'4x'");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CddlSyntaxError);
      expect((e as CddlSyntaxError).offset).toBe(0);
    }
  });

  test('odd number of hex digits is rejected', () => {
    expect(() => tokenize("h'446'")).toThrow(CddlSyntaxError);
  });
});

describe('CDDL tokenizer: # tokens', () => {
  test('bare #, major, major.ai', () => {
    const { tokens } = tokenize('# #0 #6.32 #7.25 #6.0x63740101');
    expect(tokens.map((t) => [t.hashMajor, t.hashAI, t.hashAIExpr])).toEqual([
      [undefined, undefined, undefined],
      [0, undefined, undefined],
      [6, 32n, undefined],
      [7, 25n, undefined],
      [6, 0x63740101n, undefined],
    ]);
  });

  test('#6.<type> sets hashAIExpr and leaves <type> tokens', () => {
    expect(types('#6.<tag-number>(content)')).toEqual([
      'HASH',
      'LT',
      'ID',
      'GT',
      'LPAREN',
      'ID',
      'RPAREN',
    ]);
    const first = tokenize('#6.<x>(y)').tokens[0]!;
    expect(first).toMatchObject({ hashMajor: 6, hashAIExpr: true });
  });

  test('# 6 with a space is a bare # followed by the value 6', () => {
    const { tokens } = tokenize('# 6');
    expect(tokens.map((t) => [t.type, t.hashMajor])).toEqual([
      ['HASH', undefined],
      ['INT', undefined],
    ]);
  });
});

describe('CDDL tokenizer: comments', () => {
  test('collects ; comments with positions', () => {
    const { tokens, comments } = tokenize('a = int ; trailing\n; full line\n');
    expect(tokens.map((t) => t.type)).toEqual(['ID', 'ASSIGN', 'ID']);
    expect(comments).toEqual([
      { text: ' trailing', start: 8, end: 18, line: 1, col: 9 },
      { text: ' full line', start: 19, end: 30, line: 2, col: 1 },
    ]);
  });
});

describe('CDDL tokenizer: deliberate leniency', () => {
  test('a bare CR is accepted as whitespace (line-ending normalization)', () => {
    const { tokens } = tokenize('a = uint\rb = tstr');
    expect(tokens.map((t) => t.value)).toEqual([
      'a',
      '=',
      'uint',
      'b',
      '=',
      'tstr',
    ]);
  });

  test('a comment terminated by end-of-input is accepted', () => {
    const { tokens, comments } = tokenize('a = int ; no newline');
    expect(tokens.map((t) => t.type)).toEqual(['ID', 'ASSIGN', 'ID']);
    expect(comments).toMatchObject([{ text: ' no newline' }]);
  });
});

describe('tokenizeLenient', () => {
  test('returns clean tokens plus an ERROR tail', () => {
    const { tokens, error } = tokenizeLenient('a = "unterminated');
    expect(error).toBeInstanceOf(CddlSyntaxError);
    expect(tokens.map((t) => t.type)).toEqual(['ID', 'ASSIGN', 'ERROR']);
    const tail = tokens[tokens.length - 1]!;
    expect(tail.offset).toBe(3);
    expect(tail.endOffset).toBe(17);
  });

  test('never throws and matches tokenize on valid input', () => {
    const text = 'person = { name: tstr }';
    expect(tokenizeLenient(text).tokens).toEqual(tokenize(text).tokens);
    expect(tokenizeLenient(text).error).toBeUndefined();
  });
});
