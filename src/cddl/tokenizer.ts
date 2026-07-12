/**
 * CDDL lexer (internal).
 *
 * Implements the token-level grammar of RFC 8610 as updated by RFC 9682
 * (Appendix A collected ABNF). Used by parser.ts and exposed through the
 * `tokenize()` / `tokenizeLenient()` helpers in index.ts so tooling such as
 * syntax highlighters stays in exact agreement with parsing behavior.
 */

import { CddlSyntaxError } from './errors';
import { hexToBytes } from '../utils/hex';
import { base64ToBytes } from '../utils/base64';

export type CddlTokenType =
  | 'ID'
  | 'INT' // raw text in `value`, incl. optional '-' and 0x/0b forms
  | 'FLOAT' // raw text in `value`, decimal or hexfloat
  | 'TSTR' // decoded content in `value`
  | 'BYTES' // raw content in `value`, decoded bytes in `bytes`
  | 'HASH' // '#' with optional major/head-number (see hashMajor/hashAI)
  | 'ASSIGN' // =
  | 'SLASH_EQ' // /=
  | 'DSLASH_EQ' // //=
  | 'SLASH' // /
  | 'DSLASH' // //
  | 'COMMA'
  | 'LPAREN'
  | 'RPAREN'
  | 'LBRACE'
  | 'RBRACE'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'LT'
  | 'GT'
  | 'TILDE'
  | 'AMP'
  | 'RANGE_INCL' // ..
  | 'RANGE_EXCL' // ...
  | 'CTLOP' // .id — operator name (without the dot) in `value`
  | 'STAR'
  | 'PLUS'
  | 'QUEST'
  | 'ARROW' // =>
  | 'COLON'
  | 'CARET'
  | 'EOF'
  /** Synthetic token emitted by tokenizeLenient() for the unscannable tail. */
  | 'ERROR';

export interface CddlToken {
  type: CddlTokenType;
  /** Processed value: decoded string content, raw numeric text, id text, etc. */
  value: string;
  /** Original source text for this token. */
  raw: string;
  line: number;
  col: number;
  /** Character offset of the first character of this token in the source input. */
  offset: number;
  /** Character offset just past the last character of this token in the source input. */
  endOffset: number;
  /** Only set when type === 'BYTES': the qualifier ('' | 'h' | 'b64'). */
  qualifier?: '' | 'h' | 'b64';
  /** Only set when type === 'BYTES': the decoded byte content. */
  bytes?: Uint8Array;
  /** Only set when type === 'HASH': the major digit (0–9), absent for bare '#'. */
  hashMajor?: number;
  /** Only set when type === 'HASH': the literal head-number after the dot. */
  hashAI?: bigint;
  /**
   * Only set when type === 'HASH': the head-number is a `<type>` expression
   * (RFC 9682 §3.2); the tokens for `<` type `>` follow this token.
   */
  hashAIExpr?: boolean;
}

/** A `;` line comment collected while scanning. */
export interface CddlComment {
  /** Comment text after the ';' marker, without the trailing newline. */
  text: string;
  start: number;
  end: number;
  line: number;
  col: number;
}

// Shared codec instance — constructing TextEncoder per token is measurably
// expensive in hot parsing paths (same pattern as cdn/parser.ts).
const textEncoder = new TextEncoder();

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isHexDigit = (c: string): boolean =>
  isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isEAlpha = (c: string): boolean =>
  (c >= 'a' && c <= 'z') ||
  (c >= 'A' && c <= 'Z') ||
  c === '@' ||
  c === '_' ||
  c === '$';

/** NONASCII = %xA0-D7FF / %xE000-10FFFD (RFC 9682) */
const isNonAscii = (cp: number): boolean =>
  (cp >= 0xa0 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0x10fffd);

export class CddlTokenizer {
  private readonly input: string;
  private pos = 0;
  private line = 1;
  private col = 1;

  /** Comments encountered while scanning, in source order. */
  readonly comments: CddlComment[] = [];

  /** Character offset just past the last successfully scanned token. */
  lastEndOffset = 0;

  constructor(input: string) {
    this.input = input;
  }

  // ─── Low-level helpers ──────────────────────────────────────────────────────

  private _eof(): boolean {
    return this.pos >= this.input.length;
  }

  private _ch(): string {
    return this.input[this.pos] ?? '';
  }

  private _advance(): string {
    const ch = this.input[this.pos] ?? '';
    this.pos++;
    if (ch === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private _fail(message: string, line?: number, col?: number): never {
    throw new CddlSyntaxError(message, {
      offset: this.pos,
      line: line ?? this.line,
      column: col ?? this.col,
    });
  }

  // ─── Whitespace and comments ────────────────────────────────────────────────

  /**
   * Skip S = *(SP / NL) where NL = COMMENT / CRLF.
   *
   * Per the ABNF only SP (0x20), LF, and CRLF are whitespace; horizontal tab
   * is not valid CDDL whitespace and is rejected with a targeted message.
   * Deliberate leniency: a bare CR (not part of CRLF) is also accepted as
   * whitespace, as source-level line-ending normalization.
   */
  private _skipWs(): void {
    for (;;) {
      const ch = this._ch();
      if (ch === ' ' || ch === '\n' || ch === '\r') {
        this._advance();
        continue;
      }
      if (ch === '\t')
        this._fail(
          'horizontal tab is not valid whitespace in CDDL (RFC 8610 ABNF allows only space and newline)'
        );
      if (ch === ';') {
        this._scanComment();
        continue;
      }
      return;
    }
  }

  /**
   * COMMENT = ";" *PCHAR CRLF — collected into `this.comments`.
   *
   * Deliberate leniency: content characters are not PCHAR-validated, and a
   * comment terminated by end-of-input (no trailing newline) is accepted.
   */
  private _scanComment(): void {
    const start = this.pos;
    const line = this.line;
    const col = this.col;
    this._advance(); // ';'
    let p = this.pos;
    while (p < this.input.length) {
      const c = this.input[p]!;
      if (c === '\n' || c === '\r') break;
      p++;
    }
    const text = this.input.slice(this.pos, p);
    this.col += p - this.pos;
    this.pos = p;
    this.comments.push({ text, start, end: p, line, col });
  }

  // ─── Token production ───────────────────────────────────────────────────────

  private _make(
    type: CddlTokenType,
    value: string,
    startOffset: number,
    line: number,
    col: number,
    extra?: Partial<CddlToken>
  ): CddlToken {
    const token: CddlToken = {
      type,
      value,
      raw: this.input.slice(startOffset, this.pos),
      line,
      col,
      offset: startOffset,
      endOffset: this.pos,
      ...extra,
    };
    this.lastEndOffset = this.pos;
    return token;
  }

  /** Scan and return the next token (skipping whitespace and comments). */
  consume(): CddlToken {
    this._skipWs();
    const start = this.pos;
    const line = this.line;
    const col = this.col;

    if (this._eof()) return this._make('EOF', '', start, line, col);

    const ch = this._ch();

    if (isEAlpha(ch)) {
      const id = this._scanIdText();
      // bsqual: h'...' / b64'...'
      if ((id === 'h' || id === 'b64') && this._ch() === "'")
        return this._scanBytes(id, start, line, col);
      return this._make('ID', id, start, line, col);
    }

    if (isDigit(ch) || ch === '-') return this._scanNumber(start, line, col);

    if (ch === '"') return this._scanText(start, line, col);
    if (ch === "'") return this._scanBytes('', start, line, col);
    if (ch === '#') return this._scanHash(start, line, col);

    switch (ch) {
      case '=':
        this._advance();
        if (this._ch() === '>') {
          this._advance();
          return this._make('ARROW', '=>', start, line, col);
        }
        return this._make('ASSIGN', '=', start, line, col);
      case '/':
        this._advance();
        if (this._ch() === '/') {
          this._advance();
          if (this._ch() === '=') {
            this._advance();
            return this._make('DSLASH_EQ', '//=', start, line, col);
          }
          return this._make('DSLASH', '//', start, line, col);
        }
        if (this._ch() === '=') {
          this._advance();
          return this._make('SLASH_EQ', '/=', start, line, col);
        }
        return this._make('SLASH', '/', start, line, col);
      case '.': {
        // '...' / '..' / '.id' (control operator)
        this._advance();
        if (this._ch() === '.') {
          this._advance();
          if (this._ch() === '.') {
            this._advance();
            return this._make('RANGE_EXCL', '...', start, line, col);
          }
          return this._make('RANGE_INCL', '..', start, line, col);
        }
        if (!isEAlpha(this._ch()))
          this._fail(
            `expected a control operator name after '.' (e.g. .size), got ${this._eof() ? 'end of input' : JSON.stringify(this._ch())}`,
            line,
            col
          );
        const op = this._scanIdText();
        return this._make('CTLOP', op, start, line, col);
      }
      case ',':
        this._advance();
        return this._make('COMMA', ',', start, line, col);
      case '(':
        this._advance();
        return this._make('LPAREN', '(', start, line, col);
      case ')':
        this._advance();
        return this._make('RPAREN', ')', start, line, col);
      case '{':
        this._advance();
        return this._make('LBRACE', '{', start, line, col);
      case '}':
        this._advance();
        return this._make('RBRACE', '}', start, line, col);
      case '[':
        this._advance();
        return this._make('LBRACKET', '[', start, line, col);
      case ']':
        this._advance();
        return this._make('RBRACKET', ']', start, line, col);
      case '<':
        this._advance();
        return this._make('LT', '<', start, line, col);
      case '>':
        this._advance();
        return this._make('GT', '>', start, line, col);
      case '~':
        this._advance();
        return this._make('TILDE', '~', start, line, col);
      case '&':
        this._advance();
        return this._make('AMP', '&', start, line, col);
      case '*':
        this._advance();
        return this._make('STAR', '*', start, line, col);
      case '+':
        this._advance();
        return this._make('PLUS', '+', start, line, col);
      case '?':
        this._advance();
        return this._make('QUEST', '?', start, line, col);
      case ':':
        this._advance();
        return this._make('COLON', ':', start, line, col);
      case '^':
        this._advance();
        return this._make('CARET', '^', start, line, col);
      default:
        this._fail(`unexpected character ${JSON.stringify(ch)}`);
    }
  }

  // ─── Identifiers ────────────────────────────────────────────────────────────

  /**
   * id = EALPHA *(*("-" / ".") (EALPHA / DIGIT))
   *
   * Interior '-' and '.' runs are allowed when followed by an EALPHA/DIGIT,
   * so `a.b`, `a-b`, and even `tstr.size` are single ids (the ABNF note
   * "space may be needed before the operator if type2 ends in a name" exists
   * for exactly this reason). This includes `..`: RFC 8610 §2.2.2.1 says
   * `min..max` "is not a range expression but a single name" — a range with
   * a name on the left-hand side must be written `min .. max`.
   */
  private _scanIdText(): string {
    const start = this.pos;
    this._advance(); // leading EALPHA, verified by caller
    for (;;) {
      const c = this._ch();
      if (isEAlpha(c) || isDigit(c)) {
        this._advance();
        continue;
      }
      if (c === '-' || c === '.') {
        // Look ahead across the separator run without consuming: the run is
        // part of the id only when an EALPHA/DIGIT follows it.
        let q = this.pos;
        while (this.input[q] === '-' || this.input[q] === '.') q++;
        const after = this.input[q] ?? '';
        if (!(isEAlpha(after) || isDigit(after))) break;
        while (this.pos <= q) this._advance(); // separators + first id char
        continue;
      }
      break;
    }
    return this.input.slice(start, this.pos);
  }

  // ─── Numbers ────────────────────────────────────────────────────────────────

  /**
   * number = hexfloat / (int ["." fraction] ["e" exponent])
   * hexfloat = ["-"] "0x" 1*HEXDIG ["." 1*HEXDIG] "p" exponent
   * uint = DIGIT1 *DIGIT / "0x" 1*HEXDIG / "0b" 1*BINDIG / "0"
   *
   * The token `value` is the raw numeric text; the parser converts it.
   * A '.' followed by another '.' is never consumed (range operator).
   */
  private _scanNumber(start: number, line: number, col: number): CddlToken {
    if (this._ch() === '-') this._advance();
    if (!isDigit(this._ch()))
      this._fail(`expected a digit after '-'`, line, col);

    let isFloat = false;

    if (this._ch() === '0' && /[xX]/.test(this.input[this.pos + 1] ?? '')) {
      this._advance(); // 0
      this._advance(); // x
      if (!isHexDigit(this._ch()))
        this._fail('expected hex digits after 0x', line, col);
      while (isHexDigit(this._ch())) this._advance();
      // hexfloat fraction/exponent
      if (
        this._ch() === '.' &&
        isHexDigit(this.input[this.pos + 1] ?? '') &&
        this.input[this.pos + 1] !== undefined
      ) {
        // Only a hexfloat may follow; a plain hex int never has a fraction.
        this._advance(); // .
        while (isHexDigit(this._ch())) this._advance();
        if (!/[pP]/.test(this._ch()))
          this._fail(
            "hexadecimal fraction requires a 'p' exponent (hexfloat)",
            line,
            col
          );
      }
      if (/[pP]/.test(this._ch())) {
        this._advance(); // p
        if (this._ch() === '+' || this._ch() === '-') this._advance();
        if (!isDigit(this._ch()))
          this._fail("expected exponent digits after 'p'", line, col);
        while (isDigit(this._ch())) this._advance();
        isFloat = true;
      }
    } else if (
      this._ch() === '0' &&
      /[bB]/.test(this.input[this.pos + 1] ?? '')
    ) {
      this._advance(); // 0
      this._advance(); // b
      if (!/[01]/.test(this._ch()))
        this._fail('expected binary digits after 0b', line, col);
      while (/[01]/.test(this._ch())) this._advance();
    } else {
      if (this._ch() === '0' && isDigit(this.input[this.pos + 1] ?? ''))
        this._fail('leading zeros are not allowed in CDDL numbers', line, col);
      while (isDigit(this._ch())) this._advance();
      // fraction — but never consume '..' (range operator)
      if (this._ch() === '.' && isDigit(this.input[this.pos + 1] ?? '')) {
        this._advance(); // .
        while (isDigit(this._ch())) this._advance();
        isFloat = true;
      }
      if (/[eE]/.test(this._ch())) {
        this._advance(); // e
        if (this._ch() === '+' || this._ch() === '-') this._advance();
        if (!isDigit(this._ch()))
          this._fail("expected exponent digits after 'e'", line, col);
        while (isDigit(this._ch())) this._advance();
        isFloat = true;
      }
    }

    const raw = this.input.slice(start, this.pos);
    return this._make(isFloat ? 'FLOAT' : 'INT', raw, start, line, col);
  }

  /** Scan a uint (decimal / 0x / 0b) for a '#' head-number; returns raw text. */
  private _scanUintRaw(): string {
    const start = this.pos;
    if (!isDigit(this._ch()))
      this._fail('expected an unsigned integer head-number');
    if (this._ch() === '0' && /[xX]/.test(this.input[this.pos + 1] ?? '')) {
      this._advance();
      this._advance();
      if (!isHexDigit(this._ch())) this._fail('expected hex digits after 0x');
      while (isHexDigit(this._ch())) this._advance();
    } else if (
      this._ch() === '0' &&
      /[bB]/.test(this.input[this.pos + 1] ?? '')
    ) {
      this._advance();
      this._advance();
      if (!/[01]/.test(this._ch()))
        this._fail('expected binary digits after 0b');
      while (/[01]/.test(this._ch())) this._advance();
    } else {
      if (this._ch() === '0' && isDigit(this.input[this.pos + 1] ?? ''))
        this._fail('leading zeros are not allowed in CDDL numbers');
      while (isDigit(this._ch())) this._advance();
    }
    return this.input.slice(start, this.pos);
  }

  // ─── '#' types ──────────────────────────────────────────────────────────────

  /**
   * "#" — any
   * "#" DIGIT ["." head-number] — major type (and tag/simple shorthands)
   * head-number = uint / "<" type ">"   (RFC 9682 §3.2)
   *
   * The '#', major digit, and a literal head-number are fused into a single
   * HASH token (they must be adjacent in the source; `# 6` is a bare '#'
   * followed by the value 6). For the `<type>` form, hashAIExpr is set and
   * the `<` type `>` tokens follow.
   */
  private _scanHash(start: number, line: number, col: number): CddlToken {
    this._advance(); // '#'
    const extra: Partial<CddlToken> = {};
    if (isDigit(this._ch())) {
      extra.hashMajor = this._advance().charCodeAt(0) - 0x30;
      if (this._ch() === '.') {
        if (this.input[this.pos + 1] === '<') {
          this._advance(); // '.' — the '<' type '>' tokens follow
          extra.hashAIExpr = true;
        } else {
          this._advance(); // '.'
          extra.hashAI = BigInt(this._scanUintRaw());
        }
      }
    }
    return this._make(
      'HASH',
      this.input.slice(start, this.pos),
      start,
      line,
      col,
      extra
    );
  }

  // ─── Strings ────────────────────────────────────────────────────────────────

  /** text = %x22 *SCHAR %x22 — single-line, strict SCHAR/SESC per RFC 9682. */
  private _scanText(start: number, line: number, col: number): CddlToken {
    const value = this._readStringBody('"');
    return this._make('TSTR', value, start, line, col);
  }

  /**
   * bytes = [bsqual] %x27 *BCHAR %x27
   *
   * Unqualified: content is UTF-8-encoded like a text string ('\'' must be
   * escaped). Qualified h''/b64'': whitespace and ';' line comments inside
   * the literal are ignored, then the rest is hex / base64 decoded
   * (RFC 8610 §3.1).
   */
  private _scanBytes(
    qualifier: '' | 'h' | 'b64',
    start: number,
    line: number,
    col: number
  ): CddlToken {
    const content = this._readStringBody("'");
    let bytes: Uint8Array;
    if (qualifier === '') {
      bytes = textEncoder.encode(content);
    } else {
      const data = stripWsAndComments(content);
      try {
        bytes = qualifier === 'h' ? hexToBytes(data) : base64ToBytes(data);
      } catch (e) {
        if (!(e instanceof SyntaxError) || e instanceof CddlSyntaxError)
          throw e;
        throw new CddlSyntaxError(e.message, {
          offset: start,
          line,
          column: col,
          endOffset: this.pos,
        });
      }
    }
    return this._make('BYTES', content, start, line, col, {
      qualifier,
      bytes,
    });
  }

  /**
   * Read the body of a '"' text string or "'" byte string, decoding escapes.
   *
   * SCHAR = %x20-21 / %x23-5B / %x5D-7E / NONASCII / SESC
   * BCHAR = %x20-26 / %x28-5B / %x5D-7E / NONASCII / SESC / "\'" / CRLF
   * SESC  = "\" ( %x22 / "/" / "\" / b / f / n / r / t / (%x75 hexchar) )
   */
  private _readStringBody(quote: '"' | "'"): string {
    const isBytes = quote === "'";
    this._advance(); // opening quote
    let out = '';
    for (;;) {
      if (this._eof())
        this._fail(`unterminated ${isBytes ? 'byte' : 'text'} string literal`);
      const ch = this._ch();
      if (ch === quote) {
        this._advance();
        return out;
      }
      if (ch === '\\') {
        const eLine = this.line;
        const eCol = this.col;
        this._advance();
        const e = this._advance();
        switch (e) {
          case '"':
            out += '"';
            break;
          case '/':
            out += '/';
            break;
          case '\\':
            out += '\\';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u':
            out += this._readUnicodeEscape(eLine, eCol);
            break;
          case "'":
            if (!isBytes)
              this._fail(
                `\\' is only valid in byte string literals; text strings do not need it`,
                eLine,
                eCol
              );
            out += "'";
            break;
          default:
            this._fail(`invalid escape sequence \\${e}`, eLine, eCol);
        }
        continue;
      }
      // CRLF / LF is content in byte strings only.
      if (ch === '\n' || ch === '\r') {
        if (!isBytes)
          this._fail(
            'text string literals cannot span lines (escape the newline as \\n)'
          );
        if (ch === '\r') {
          this._advance();
          if (this._ch() !== '\n')
            this._fail('bare CR is not allowed in byte string literals');
          this._advance();
          out += '\r\n';
        } else {
          this._advance();
          out += '\n';
        }
        continue;
      }
      // Read the full code point (an astral char spans two UTF-16 units).
      const cp = this.input.codePointAt(this.pos)!;
      if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f))
        this._fail(
          `unescaped control character U+${cp.toString(16).padStart(4, '0').toUpperCase()} is not allowed in string literals`
        );
      if (cp > 0x7e && !isNonAscii(cp))
        this._fail(
          `code point U+${cp.toString(16).toUpperCase()} is not allowed in CDDL source`
        );
      this._advance();
      if (cp > 0xffff) this._advance(); // astral: second UTF-16 code unit
      out += String.fromCodePoint(cp);
    }
  }

  /**
   * hexchar (RFC 9682): after `\u`, either `{...}` with a scalar value
   * (leading zeros allowed, surrogates rejected) or 4 hex digits, where a
   * high surrogate must be immediately followed by `\uXXXX` low surrogate.
   */
  private _readUnicodeEscape(eLine: number, eCol: number): string {
    if (this._ch() === '{') {
      this._advance();
      let hex = '';
      while (isHexDigit(this._ch())) hex += this._advance();
      if (hex.length === 0)
        this._fail('\\u{} escape requires at least one hex digit', eLine, eCol);
      if (this._ch() !== '}')
        this._fail("expected '}' to close \\u{...} escape", eLine, eCol);
      this._advance();
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff)
        this._fail(
          `\\u{${hex}} is above the Unicode code point maximum U+10FFFF`,
          eLine,
          eCol
        );
      if (cp >= 0xd800 && cp <= 0xdfff)
        this._fail(
          `\\u{${hex}} is a surrogate code point, not a Unicode scalar value`,
          eLine,
          eCol
        );
      return String.fromCodePoint(cp);
    }
    const readHex4 = (): number => {
      let hex = '';
      for (let i = 0; i < 4; i++) {
        if (!isHexDigit(this._ch()))
          this._fail('\\u escape requires four hex digits', eLine, eCol);
        hex += this._advance();
      }
      return parseInt(hex, 16);
    };
    const cp = readHex4();
    if (cp >= 0xd800 && cp <= 0xdbff) {
      // High surrogate: a low surrogate escape must follow immediately.
      if (this._ch() !== '\\' || this.input[this.pos + 1] !== 'u')
        this._fail(
          'high surrogate \\u escape must be followed by a low surrogate \\u escape',
          eLine,
          eCol
        );
      this._advance();
      this._advance();
      const lo = readHex4();
      if (lo < 0xdc00 || lo > 0xdfff)
        this._fail(
          'high surrogate \\u escape must be followed by a low surrogate \\u escape',
          eLine,
          eCol
        );
      return String.fromCodePoint(
        0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
      );
    }
    if (cp >= 0xdc00 && cp <= 0xdfff)
      this._fail('lone low surrogate \\u escape', eLine, eCol);
    return String.fromCodePoint(cp);
  }
}

/**
 * Remove whitespace and ';' line comments from the (escape-processed) content
 * of a prefixed h''/b64'' byte string — RFC 8610 §3.1: "any whitespace
 * present within the string (including comments) is ignored in the prefixed
 * case".
 */
function stripWsAndComments(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    const c = content[i]!;
    if (c === ' ' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === ';') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
