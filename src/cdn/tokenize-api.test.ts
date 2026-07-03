import { describe, expect, test } from 'vitest';
import { CBOR } from '../index';
import { CdnSyntaxError, tokenize, tokenizeLenient } from './index';

describe('tokenize', () => {
  test('scans tokens with source offsets', () => {
    const { tokens, comments } = tokenize('[1, "ab"]');
    expect(tokens.map((t) => t.type)).toEqual([
      'LBRACKET',
      'INTEGER',
      'COMMA',
      'TSTR',
      'RBRACKET',
    ]);
    expect(tokens.map((t) => [t.offset, t.endOffset])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [4, 8],
      [8, 9],
    ]);
    expect(comments).toEqual([]);
  });

  test('collects comments', () => {
    const { tokens, comments } = tokenize('# hi\n[1] /* there */');
    expect(tokens.map((t) => t.type)).toEqual([
      'LBRACKET',
      'INTEGER',
      'RBRACKET',
    ]);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ kind: 'line', start: 0, end: 4 });
    expect(comments[1]).toMatchObject({ kind: 'block', start: 9, end: 20 });
  });

  test('appPrefix is an own property only on app-string/app-sequence tokens', () => {
    const { tokens } = tokenize(
      `[1, "a", dt'2024-01-01T00:00:00Z', same<<1>>]`
    );
    for (const tok of tokens) {
      const isApp = tok.type === 'APP_STRING' || tok.type === 'APP_SEQUENCE';
      expect('appPrefix' in tok).toBe(isApp);
    }
    const appTok = tokens.find((t) => t.type === 'APP_STRING')!;
    expect(appTok.appPrefix).toBe('dt');
    const seqTok = tokens.find((t) => t.type === 'APP_SEQUENCE')!;
    expect(seqTok.appPrefix).toBe('same');
    // Shape survives the consumer's own spread / JSON round-trip
    expect('appPrefix' in { ...tokens[0] }).toBe(false);
    expect(JSON.parse(JSON.stringify(appTok)).appPrefix).toBe('dt');
  });

  test('SQSTR value is UTF-8 hex and the public token shape has no extras', () => {
    const { tokens } = tokenize("'abü'");
    const tok = tokens[0]!;
    expect(tok.type).toBe('SQSTR');
    expect(tok.value).toBe('6162c3bc'); // UTF-8 of "abü" as lowercase hex
    // The internal payload fast path must not leak into the public shape.
    expect(Object.keys(tok)).toEqual([
      'type',
      'value',
      'raw',
      'line',
      'col',
      'offset',
      'endOffset',
    ]);
    expect(JSON.parse(JSON.stringify(tok))).toEqual({
      type: 'SQSTR',
      value: '6162c3bc',
      raw: "'abü'",
      line: 1,
      col: 1,
      offset: 0,
      endOffset: 5,
    });
  });

  test('raw always equals the exact source range [offset, endOffset)', () => {
    // Covers the raw === value reuse paths (punctuation, keywords, numbers)
    // and the paths where raw must differ from value: +5 (sign eaten before
    // the number), .... (extra ellipsis dots), _1 (indicator), strings.
    const source = `{_ "k": [1, -2.5e3, +5, 0x1f_1, true, NaN_3, simple(9),
      h'00ff', 'sq', "t\\n", ....], "d": dt'2024-01-01T00:00:00Z'} + b64'AAE'`;
    const { tokens } = tokenize(source);
    expect(tokens.length).toBeGreaterThan(20);
    for (const tok of tokens) {
      expect(tok.raw).toBe(source.slice(tok.offset, tok.endOffset));
    }
  });

  test('throws CdnSyntaxError with position on invalid input', () => {
    let caught: unknown;
    try {
      tokenize('[1, @]');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CdnSyntaxError);
    expect(caught).toBeInstanceOf(SyntaxError);
    const err = caught as CdnSyntaxError;
    expect(err.offset).toBe(4);
    expect(err.line).toBe(1);
    expect(err.column).toBe(5);
    expect(err.message).toBe(
      'EDN parse error at line 1, column 5: unexpected character "@"'
    );
  });
});

describe('tokenizeLenient', () => {
  test('matches strict tokenize on valid input and reports no error', () => {
    const input = '{"a": h\'00ff\', "b": [1.5, true, null]} # trailing';
    const strict = tokenize(input);
    const lenient = tokenizeLenient(input);
    expect(lenient.error).toBeUndefined();
    expect(lenient.tokens).toEqual(strict.tokens);
    expect(lenient.comments).toEqual(strict.comments);
  });

  test('returns clean tokens plus an ERROR token covering the tail', () => {
    const { tokens, error } = tokenizeLenient('[1, "abc');
    expect(error).toBeInstanceOf(CdnSyntaxError);
    expect(tokens.map((t) => t.type)).toEqual([
      'LBRACKET',
      'INTEGER',
      'COMMA',
      'ERROR',
    ]);
    const errTok = tokens[tokens.length - 1]!;
    expect(errTok.offset).toBe(3);
    expect(errTok.endOffset).toBe(8);
    expect(errTok.raw).toBe(' "abc');
  });

  test('covers the whole input when nothing scans', () => {
    const { tokens, error } = tokenizeLenient('"abc');
    expect(error).toBeInstanceOf(CdnSyntaxError);
    expect(error!.offset).toBe(4);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      type: 'ERROR',
      offset: 0,
      endOffset: 4,
      line: 1,
      col: 1,
    });
  });

  test('keeps comments scanned before the failure', () => {
    const { comments, error } = tokenizeLenient('# note\n[1, @');
    expect(error).toBeInstanceOf(CdnSyntaxError);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: 'line', text: '# note' });
  });

  test('never throws and emits no ERROR token for empty input', () => {
    const { tokens, error } = tokenizeLenient('');
    expect(tokens).toEqual([]);
    expect(error).toBeUndefined();
  });
});

describe('CdnSyntaxError from the parser', () => {
  test('fromCDN throws CdnSyntaxError with the offending token position', () => {
    let caught: unknown;
    try {
      CBOR.fromCDN('[1, :]');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CdnSyntaxError);
    const err = caught as CdnSyntaxError;
    expect(err.offset).toBe(4);
    expect(err.endOffset).toBe(5);
    expect(err.line).toBe(1);
    expect(err.column).toBe(5);
    expect(err.message).toMatch(/^EDN parse error at line 1, column 5: /);
  });

  test('multi-line input reports correct line and column', () => {
    let caught: unknown;
    try {
      CBOR.fromCDN('{\n  "a": 1,\n  "b" 2\n}');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CdnSyntaxError);
    const err = caught as CdnSyntaxError;
    expect(err.line).toBe(3);
    expect(err.column).toBe(7);
    expect(err.offset).toBe(18);
  });

  test('base64 hard errors carry the token position', () => {
    let caught: unknown;
    try {
      CBOR.fromCDN("b64'ab@d'");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CdnSyntaxError);
    expect((caught as CdnSyntaxError).offset).toBe(0);
  });
});
