/**
 * CDN lexer (internal).
 *
 * Used by parser.ts for parsing and by CborTextString serialization to collect
 * source offsets after parseCDN() has already validated embedded CDN.
 */

export type TokenType =
  | 'INTEGER'
  | 'FLOAT'
  | 'TSTR'
  | 'SQSTR'
  | 'RAWSTRING'
  | 'BYTES_HEX'
  | 'BYTES_HEX_ELIDED'
  | 'BYTES_B64'
  | 'APP_STRING'
  | 'APP_SEQUENCE'
  | 'EMPTY_INDEF_BYTES'
  | 'EMPTY_INDEF_TEXT'
  | 'TRUE'
  | 'FALSE'
  | 'NULL'
  | 'UNDEFINED'
  | 'SIMPLE'
  | 'LBRACKET'
  | 'RBRACKET'
  | 'LBRACE'
  | 'RBRACE'
  | 'LPAREN'
  | 'RPAREN'
  | 'COLON'
  | 'COMMA'
  | 'PLUS'
  | 'UNDERSCORE'
  | 'ENCODING_INDICATOR'
  | 'LT_LT'
  | 'GT_GT'
  | 'ELLIPSIS'
  | 'EOF';

export interface Token {
  type: TokenType;
  /** Processed value: decoded string content, raw number text, raw byte content, etc. */
  value: string;
  /** Original source text for this token. */
  raw: string;
  line: number;
  col: number;
  /** Character offset of the first character of this token in the source input. */
  offset: number;
  /** Character offset just past the last character of this token in the source input. */
  endOffset: number;
  /** Only set when type === 'APP_STRING': the extension prefix (e.g. 'dt', 'DT'). */
  appPrefix?: string;
}

export interface TokenizerOptions {
  /** Character offset at which tokenization starts. */
  offset?: number;
}

export interface EdnComment {
  kind: 'line' | 'block';
  marker: '#' | '//' | '/*' | '/';
  text: string;
  start: number;
  end: number;
  line: number;
  col: number;
}

function positionAt(
  input: string,
  offset: number
): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset; i++) {
    if (input[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

export class Tokenizer {
  private pos: number;
  private line: number;
  private col: number;
  private _peeked: Token | null = null;
  private _lastConsumedEndOffset: number;
  /** Comments encountered while scanning, appended in source order. */
  readonly comments: EdnComment[] = [];
  /**
   * When set, non-standard-but-JS-valid escape sequences are accepted instead
   * of throwing.  The callback receives a message and the position of the `\`
   * (offset, line, column) so the parser can forward it as a ParseWarning.
   */
  onEscapeWarning?: (
    msg: string,
    offset: number,
    line: number,
    col: number
  ) => void;
  constructor(
    private readonly input: string,
    options?: TokenizerOptions
  ) {
    const offset = options?.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > input.length)
      throw new RangeError(
        `EDN parse offset must be an integer between 0 and ${input.length}`
      );
    const position = positionAt(input, offset);
    this.pos = offset;
    this.line = position.line;
    this.col = position.col;
    this._lastConsumedEndOffset = offset;
  }

  peek(): Token {
    if (this._peeked === null) this._peeked = this._readNext();
    return this._peeked;
  }

  consume(): Token {
    const tok = this._peeked !== null ? this._peeked : this._readNext();
    this._peeked = null;
    this._lastConsumedEndOffset = tok.endOffset;
    return tok;
  }

  /** Character offset just past the last character of the most recently consumed token. */
  get lastEndOffset(): number {
    return this._lastConsumedEndOffset;
  }

  /** The full source text supplied to this tokenizer. */
  get source(): string {
    return this.input;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private _ch(): string {
    return this.input[this.pos] ?? '';
  }
  private _eof(): boolean {
    return this.pos >= this.input.length;
  }

  private _advance(): string {
    const c = this.input[this.pos++] ?? '';
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  private _fail(msg: string, line = this.line, col = this.col): never {
    throw new SyntaxError(
      `EDN parse error at line ${line}, column ${col}: ${msg}`
    );
  }

  private _skipWS(): void {
    for (;;) {
      // Skip whitespace characters
      while (!this._eof() && /\s/.test(this._ch())) this._advance();
      if (this._eof()) return;

      const c = this._ch();

      // CDN line comment: # to end of line
      if (c === '#') {
        const start = this.pos;
        const line = this.line;
        const col = this.col;
        while (!this._eof() && this._ch() !== '\n') this._advance();
        this.comments.push({
          kind: 'line',
          marker: '#',
          text: this.input.slice(start, this.pos),
          start,
          end: this.pos,
          line,
          col,
        });
        continue;
      }

      // Comments starting with /
      if (c === '/') {
        const next = this.input[this.pos + 1] ?? '';
        if (next === '/') {
          // EDN end-of-line comment: // to end of line (§2.2)
          const start = this.pos;
          const line = this.line;
          const col = this.col;
          this._advance();
          this._advance();
          while (!this._eof() && this._ch() !== '\n') this._advance();
          this.comments.push({
            kind: 'line',
            marker: '//',
            text: this.input.slice(start, this.pos),
            start,
            end: this.pos,
            line,
            col,
          });
          continue;
        }
        if (next === '*') {
          // EDN block comment: /* ... */ (§2.2)
          const start = this.pos;
          const line = this.line;
          const col = this.col;
          this._advance();
          this._advance();
          this._skipBlockCommentStar();
          this.comments.push({
            kind: 'block',
            marker: '/*',
            text: this.input.slice(start, this.pos),
            start,
            end: this.pos,
            line,
            col,
          });
          continue;
        }
        // EDN slash-delimited comment: / ... / (§2.2, first char must not be * or /)
        const start = this.pos;
        const line = this.line;
        const col = this.col;
        this._advance(); // consume opening /
        this._skipBlockCommentSlash();
        this.comments.push({
          kind: 'block',
          marker: '/',
          text: this.input.slice(start, this.pos),
          start,
          end: this.pos,
          line,
          col,
        });
        continue;
      }

      return;
    }
  }

  /**
   * Skip a comment in a quoted byte string literal (h'', b64'').
   * Returns true if a comment was consumed, false if the current char is not a
   * comment start. `quote` is the closing delimiter character.
   *
   * Supports / ... /, /* *\/, //, and # comment forms (§2.2).
   */
  private _skipByteStringComment(quote: string): boolean {
    const ch = this._ch();
    if (ch === '/') {
      const next = this.input[this.pos + 1] ?? '';
      if (next === '/') {
        this._advance();
        this._advance();
        while (!this._eof() && this._ch() !== '\n') {
          if (this._ch() === '\\') {
            this._advance();
            if (!this._eof() && this._ch() !== '\n') this._advance();
            continue;
          }
          if (this._ch() === quote) break;
          this._advance();
        }
        return true;
      }
      if (next === '*') {
        this._advance();
        this._advance();
        this._skipBlockCommentStar();
        return true;
      }
      this._advance();
      this._skipBlockCommentSlash();
      return true;
    }
    if (ch === '#') {
      while (!this._eof() && this._ch() !== '\n') {
        if (this._ch() === '\\') {
          this._advance(); // consume '\'
          if (this._eof() || this._ch() === '\n') continue;
          const escaped = this._advance();
          if (escaped === 'u') this._validateHexCommentUnicodeEscape();
          continue;
        }
        if (this._ch() === quote) break;
        this._advance();
      }
      return true;
    }
    return false;
  }

  /**
   * Validate a `\uXXXX` or `\u{N}` escape inside a hex-string comment.
   *
   * Called immediately after the `u` character has been consumed.  Rejects
   * lone surrogates and invalid surrogate pairs; tolerates truncated/
   * non-hex sequences (comments are informational, but surrogates are
   * always illegal).
   */
  private _validateHexCommentUnicodeEscape(): void {
    const line = this.line,
      col = this.col;

    // Extended form \u{XXXXXX}
    if (!this._eof() && this._ch() === '{') {
      this._advance(); // {
      let hex = '';
      while (!this._eof() && this._ch() !== '}' && this._ch() !== '\n')
        hex += this._advance();
      if (!this._eof() && this._ch() === '}') this._advance(); // }
      const cp = parseInt(hex || '0', 16);
      if (cp >= 0xd800 && cp <= 0xdfff)
        this._fail(
          `\\u{${hex}} is a surrogate code point, not allowed in hex string comments`,
          line,
          col
        );
      return;
    }

    // Standard \uXXXX — read up to 4 hex digits
    let hex = '';
    for (let i = 0; i < 4; i++) {
      if (this._eof() || this._ch() === '\n') break;
      if (!/[0-9a-fA-F]/.test(this._ch())) break;
      hex += this._advance();
    }
    if (hex.length < 4) return; // truncated / non-hex — not our problem

    const cp = parseInt(hex, 16);

    // High surrogate: must be followed immediately by a low-surrogate escape
    if (cp >= 0xd800 && cp <= 0xdbff) {
      if (this._ch() !== '\\' || (this.input[this.pos + 1] ?? '') !== 'u')
        this._fail(
          `lone high surrogate \\u${hex} in hex string comment`,
          line,
          col
        );
      this._advance(); // \
      this._advance(); // u
      let hex2 = '';
      for (let i = 0; i < 4; i++) {
        if (this._eof() || this._ch() === '\n') break;
        if (!/[0-9a-fA-F]/.test(this._ch())) break;
        hex2 += this._advance();
      }
      const cp2 = parseInt(hex2 || '0', 16);
      if (cp2 < 0xdc00 || cp2 > 0xdfff)
        this._fail(
          `\\u${hex} (high surrogate) not followed by valid low surrogate in hex string comment`,
          line,
          col
        );
      return;
    }

    if (cp >= 0xdc00 && cp <= 0xdfff)
      this._fail(
        `lone low surrogate \\u${hex} in hex string comment`,
        line,
        col
      );
  }

  /**
   * Skip a comment in a raw byte string (h``, b64``).
   * Called with `i` pointing at the comment-start character.
   * Returns the index after the comment, or -1 if no comment was found.
   *
   * Supports / ... /, /* *\/, //, and # comment forms (§2.2).
   * `context` is used in unterminated-comment error messages.
   */
  private _skipRawComment(
    raw: string,
    i: number,
    context: string,
    tokenLine: number,
    tokenCol: number
  ): number {
    const ch = raw[i];
    if (ch === '/') {
      i++;
      if (raw[i] === '/') {
        i++;
        while (i < raw.length && raw[i] !== '\n') i++;
        return i;
      }
      if (raw[i] === '*') {
        i++;
        while (i < raw.length) {
          if (raw[i] === '*' && raw[i + 1] === '/') return i + 2;
          i++;
        }
        return i; // EOF inside comment — fall through; caller will report
      }
      // / … / comment
      while (i < raw.length && raw[i] !== '/') i++;
      if (i >= raw.length)
        throw new SyntaxError(
          `EDN parse error at line ${tokenLine}, column ${tokenCol}: unterminated block comment in ${context}`
        );
      return i + 1; // consume closing /
    }
    if (ch === '#') {
      while (i < raw.length && raw[i] !== '\n') i++;
      return i;
    }
    return -1; // not a comment
  }

  /** Skip content until a closing `/` (CDN block comment). */
  private _skipBlockCommentSlash(): void {
    const line = this.line,
      col = this.col;
    while (!this._eof()) {
      if (this._ch() === '\\') {
        this._advance();
        if (!this._eof()) this._advance();
        continue;
      }
      if (this._ch() === '/') break;
      this._advance();
    }
    if (this._eof()) this._fail('unterminated block comment', line, col);
    this._advance(); // consume closing /
  }

  /** Skip content until a closing `*\/` (JSONC block comment). */
  private _skipBlockCommentStar(): void {
    const line = this.line,
      col = this.col;
    while (!this._eof()) {
      if (this._ch() === '*' && (this.input[this.pos + 1] ?? '') === '/') {
        this._advance();
        this._advance();
        return;
      }
      this._advance();
    }
    this._fail('unterminated block comment', line, col);
  }

  /**
   * Read content between `quote` delimiters, processing escape sequences.
   *
   * Strict spec compliance:
   * - Literal LF (U+000A) is allowed; all other C0 controls and U+007F are rejected.
   * - Literal CR (U+000D) is silently stripped (source-level CRLF normalisation).
   * - Only spec-defined escape sequences are accepted; `\q` etc. throw SyntaxError.
   * - `\/` is valid only in double-quoted strings (not in escapable-s, §5.1).
   * - `\\` (backslash) is valid in both single- and double-quoted strings.
   * - `\uXXXX` for a high surrogate must be immediately followed by `\uXXXX` for
   *   the corresponding low surrogate; lone surrogates are rejected.
   * - `\u{N}` … `\u{10FFFF}` extended syntax is supported; surrogates are rejected.
   * - In single-quoted strings, `\u` escapes to printable ASCII (U+0020–U+007E)
   *   are forbidden (hexchar-s restriction, draft-25 §5.1).
   */
  private _readStringContent(quote: string): string {
    this._advance(); // opening quote
    let out = '';
    while (!this._eof() && this._ch() !== quote) {
      const ch = this._ch();

      // Strip literal CR (cross-platform source normalisation — spec §2.5.1)
      if (ch === '\r') {
        this._advance();
        continue;
      }

      // Reject unescaped C0 control characters (except LF) and DEL — spec §5.1 unescaped
      const cp = ch.codePointAt(0)!;
      if ((cp < 0x20 && cp !== 0x0a) || cp === 0x7f)
        this._fail(
          `unescaped control character U+${cp.toString(16).padStart(4, '0')} is not allowed in string literals`
        );

      if (ch === '\\') {
        // Capture position of the backslash itself before consuming it.
        const eOffset = this.pos,
          eLine = this.line,
          eCol = this.col;
        this._advance();
        const e = this._advance();
        switch (e) {
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case '\\':
            out += '\\';
            break;
          case 'u':
            out += this._readUnicodeEscape(quote, eOffset, eLine, eCol);
            break;
          default:
            // Escaped delimiter char (e.g. \' inside '...' or \" inside "...")
            if (e === quote) {
              out += e;
              break;
            }
            if (e === '/') {
              if (quote === "'")
                this._fail(
                  `\\/ is not a valid escape in single-quoted byte strings (§5.1)`,
                  eLine,
                  eCol
                );
              out += '/';
              break;
            }
            // Non-standard JS escape sequences — accepted when onEscapeWarning is set.
            if (this.onEscapeWarning) {
              if (e === '0') {
                this.onEscapeWarning(
                  '\\0 is a non-standard escape sequence; use \\u0000 instead',
                  eOffset,
                  eLine,
                  eCol
                );
                out += '\0';
                break;
              }
              if (e === 'v') {
                this.onEscapeWarning(
                  '\\v is a non-standard escape sequence; use \\u000b instead',
                  eOffset,
                  eLine,
                  eCol
                );
                out += '\v';
                break;
              }
              if (e === 'x') {
                // \xHH — two hex digits
                const h1 = this._ch();
                const h2 = this.input[this.pos + 1] ?? '';
                if (!/[0-9a-fA-F]/.test(h1) || !/[0-9a-fA-F]/.test(h2)) {
                  this._fail(
                    '\\x escape requires exactly two hex digits',
                    eLine,
                    eCol
                  );
                }
                this._advance();
                this._advance();
                const codePoint = parseInt(h1 + h2, 16);
                this.onEscapeWarning(
                  `\\x${h1}${h2} is a non-standard escape sequence; use \\u00${h1}${h2} instead`,
                  eOffset,
                  eLine,
                  eCol
                );
                out += String.fromCharCode(codePoint);
                break;
              }
              // Cross-quote delimiter (e.g. \" inside '...' or \' inside "...")
              if (e === '"' || e === "'") {
                this.onEscapeWarning(
                  `\\${e} inside ${quote === '"' ? 'double' : 'single'}-quoted string is non-standard`,
                  eOffset,
                  eLine,
                  eCol
                );
                out += e;
                break;
              }
              // JS line continuation: \ + LF / CR / CRLF → nothing added
              if (e === '\n' || e === '\r') {
                if (e === '\r' && this._ch() === '\n') this._advance(); // consume CRLF
                this.onEscapeWarning(
                  'line continuation (\\<newline>) is non-standard; the newline is ignored',
                  eOffset,
                  eLine,
                  eCol
                );
                break;
              }
              // Identity escape: \X → X (JS accepts any \X as just X)
              this.onEscapeWarning(
                `\\${e} is an unknown escape sequence; interpreted as '${e}'`,
                eOffset,
                eLine,
                eCol
              );
              out += e;
              break;
            }
            this._fail(
              `invalid escape sequence \\${e} in ${quote === '"' ? 'double' : 'single'}-quoted string`,
              eLine,
              eCol
            );
        }
      } else {
        out += this._advance();
      }
    }
    if (this._eof()) this._fail('unterminated string literal');
    this._advance(); // closing quote
    return out;
  }

  /**
   * Parse a Unicode escape immediately after `\u` has been consumed.
   *
   * @param quote - The enclosing string delimiter (`"` or `'`).
   *
   * Handles two forms:
   * - `\u{N}` … `\u{10FFFF}`: direct Unicode scalar value (surrogates rejected)
   * - `\uXXXX`: exactly four hex digits; a high surrogate must be followed by
   *   `\uXXXX` for the matching low surrogate to form a valid surrogate pair,
   *   which is then decoded into the corresponding non-BMP code point.
   *
   * In single-quoted strings (`quote === "'"`), `\u` escapes that resolve to
   * printable ASCII (U+0020–U+007E) are rejected per draft-25 §5.1 hexchar-s.
   * Use `\\` for backslash (U+005C) and `\'` for the single-quote delimiter.
   */
  private _readUnicodeEscape(
    quote: string,
    bsOffset?: number,
    bsLine?: number,
    bsCol?: number
  ): string {
    const line = this.line,
      col = this.col;

    /** Warn or throw when this is a single-quoted string and the code point is printable ASCII. */
    const checkSingleQuotedPrintable = (cp: number): void => {
      // Per draft-25 §5.1 hexchar-s, \u escapes for printable ASCII (U+0020–U+007E)
      // are not valid in single-quoted strings.  Use \\ for backslash and \' for
      // the single-quote delimiter.  In lenient mode (onEscapeWarning set) we emit
      // a warning and accept the value rather than hard-failing.
      if (quote === "'" && cp >= 0x20 && cp <= 0x7e) {
        const msg = `\\u escape for printable ASCII U+${cp.toString(16).padStart(4, '0').toUpperCase()} is not allowed in single-quoted strings (§5.1 hexchar-s)`;
        if (this.onEscapeWarning) {
          this.onEscapeWarning(
            msg,
            bsOffset ?? this.pos,
            bsLine ?? line,
            bsCol ?? col
          );
          return;
        }
        this._fail(msg, line, col);
      }
    };

    // Extended form \u{NNN}
    if (!this._eof() && this._ch() === '{') {
      this._advance(); // {
      let hex = '';
      while (!this._eof() && this._ch() !== '}') {
        const c = this._ch();
        if (!/[0-9a-fA-F]/.test(c))
          this._fail(
            `invalid character in \\u{} escape: ${JSON.stringify(c)}`,
            line,
            col
          );
        hex += this._advance();
      }
      if (this._eof()) this._fail('unterminated \\u{} escape', line, col);
      this._advance(); // }
      if (hex.length === 0) this._fail('empty \\u{} escape', line, col);
      const cp = parseInt(hex, 16);
      if (cp > 0x10_ffff)
        this._fail(
          `\\u{${hex}} exceeds maximum Unicode code point U+10FFFF`,
          line,
          col
        );
      if (cp >= 0xd800 && cp <= 0xdfff)
        this._fail(
          `\\u{${hex}} is a surrogate code point, which is not a valid Unicode scalar value`,
          line,
          col
        );
      checkSingleQuotedPrintable(cp);
      return String.fromCodePoint(cp);
    }

    // Standard form \uXXXX
    let hex = '';
    for (let i = 0; i < 4; i++) {
      if (this._eof()) this._fail('truncated \\uXXXX escape', line, col);
      const c = this._ch();
      if (!/[0-9a-fA-F]/.test(c))
        this._fail(
          `invalid hex digit in \\uXXXX escape: ${JSON.stringify(c)}`,
          line,
          col
        );
      hex += this._advance();
    }
    const cp = parseInt(hex, 16);

    // High surrogate: must be immediately followed by a low-surrogate escape
    if (cp >= 0xd800 && cp <= 0xdbff) {
      if (this._ch() !== '\\' || (this.input[this.pos + 1] ?? '') !== 'u')
        this._fail(
          `lone high surrogate \\u${hex} must be followed by \\uDC00–\\uDFFF`,
          line,
          col
        );
      this._advance(); // \
      this._advance(); // u
      const line2 = this.line,
        col2 = this.col;
      let hex2 = '';
      for (let i = 0; i < 4; i++) {
        if (this._eof())
          this._fail('truncated low-surrogate escape', line2, col2);
        hex2 += this._advance();
      }
      const cp2 = parseInt(hex2, 16);
      if (cp2 < 0xdc00 || cp2 > 0xdfff)
        this._fail(
          `\\u${hex} (high surrogate) not followed by a valid low surrogate (got \\u${hex2})`,
          line,
          col
        );
      // Surrogate pairs always resolve to non-BMP (> U+FFFF), never printable ASCII
      return String.fromCodePoint(
        0x10000 + (cp - 0xd800) * 0x400 + (cp2 - 0xdc00)
      );
    }

    // Low surrogate without a preceding high surrogate is invalid
    if (cp >= 0xdc00 && cp <= 0xdfff)
      this._fail(`lone low surrogate \\u${hex} is not valid`, line, col);

    checkSingleQuotedPrintable(cp);
    return String.fromCharCode(cp);
  }

  /**
   * Read raw text-string content between N-backtick delimiters (§2.5.3).
   *
   * - The opening delimiter is the maximal run of consecutive backticks (N ≥ 1).
   * - A single leading newline (LF or CRLF) immediately after the opening is stripped.
   * - No escape sequences are processed — content is taken verbatim.
   * - Literal CR is stripped for source-level CRLF normalisation.
   * - The closing delimiter is the first run of M ≥ N backticks; any excess
   *   M-N backticks are appended to the content before closing.
   */
  private _readRawStringContent(): string {
    const openLine = this.line,
      openCol = this.col;

    // Count opening backticks (greedy)
    let n = 0;
    while (!this._eof() && this._ch() === '`') {
      this._advance();
      n++;
    }

    // Strip a single leading CRLF or LF (§2.5.3)
    if (!this._eof() && this._ch() === '\r') this._advance(); // CR
    if (!this._eof() && this._ch() === '\n') this._advance(); // LF

    let out = '';
    while (!this._eof()) {
      const ch = this._ch();

      // Source-level CRLF normalisation: strip bare CR
      if (ch === '\r') {
        this._advance();
        continue;
      }

      if (ch === '`') {
        // Count this backtick run
        let m = 0;
        while (!this._eof() && this._ch() === '`') {
          this._advance();
          m++;
        }
        if (m >= n) {
          // Closing delimiter found; excess backticks become content
          out += '`'.repeat(m - n);
          if (out === '')
            this._fail(
              'raw string must not be empty (§2.5.3)',
              openLine,
              openCol
            );
          return out;
        }
        // Not enough backticks — all become content
        out += '`'.repeat(m);
      } else {
        const cp = ch.codePointAt(0)!;
        // rawchars = 1*(%x0a/%x0d / %x20-5f / %x61-7e / NONASCII) — HT and other C0 controls forbidden
        if (cp < 0x20 && cp !== 0x0a && cp !== 0x0d) {
          this._fail(
            `raw string content must not contain control character U+${cp.toString(16).toUpperCase().padStart(4, '0')} (§2.5.3)`,
            this.line,
            this.col
          );
        }
        if (cp === 0x7f) {
          this._fail(
            'raw string content must not contain DEL (U+007F) (§2.5.3)',
            this.line,
            this.col
          );
        }
        out += this._advance();
      }
    }

    this._fail('unterminated raw string literal', openLine, openCol);
  }

  /**
   * Post-process raw hex content from a `h``…``\` raw string (§5.3.3).
   *
   * Skips:
   *   - lblank whitespace (LF, SP; also CR for source-level normalisation)
   *   - `/ … /` block comments
   *   - `# …` line comments (up to but not including LF)
   * Detects `...` ellipsis sequences.
   *
   * A trailing `# comment` immediately before the closing delimiter is allowed
   * per §5.3.3 `r-app-string-h`.
   *
   * Returns { value: hex-string-with-ellipsis-markers, elided: boolean }
   */
  private _processRawHexContent(
    raw: string,
    tokenLine: number,
    tokenCol: number
  ): { value: string; elided: boolean } {
    let hex = '';
    let elided = false;
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      // lblank / CR — skip
      if (ch === '\n' || ch === ' ' || ch === '\r') {
        i++;
        continue;
      }
      // HT is still forbidden (rawchars excludes %x09)
      if (ch === '\t') {
        throw new SyntaxError(
          `EDN parse error at line ${tokenLine}, column ${tokenCol}: horizontal tab (HT) is not allowed inside h\`\` raw byte string literals (§5.3.3)`
        );
      }
      // Comments (§2.2)
      const afterComment = this._skipRawComment(
        raw,
        i,
        'h`` raw byte string',
        tokenLine,
        tokenCol
      );
      if (afterComment !== -1) {
        i = afterComment;
        continue;
      }
      // Ellipsis: ... (three or more dots)
      if (ch === '.' && raw[i + 1] === '.' && raw[i + 2] === '.') {
        i += 3;
        while (i < raw.length && raw[i] === '.') i++;
        hex += '...';
        elided = true;
        continue;
      }
      // Hex digit
      if (/[0-9a-fA-F]/.test(ch)) {
        hex += ch;
        i++;
        continue;
      }
      throw new SyntaxError(
        `EDN parse error at line ${tokenLine}, column ${tokenCol}: unexpected character ${JSON.stringify(ch)} in h\`\` raw byte string`
      );
    }
    return { value: hex, elided };
  }

  /**
   * Post-process raw base64 content from a `b64``…``\` raw string (§5.3.4).
   *
   * Skips:
   *   - lblank whitespace (LF, SP; also CR for source-level normalisation)
   *   - `# …` line comments (up to but not including LF)
   *
   * Returns the stripped base64 string.
   */
  private _processRawB64Content(
    raw: string,
    tokenLine: number,
    tokenCol: number
  ): string {
    let out = '';
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      // lblank / CR — skip
      if (ch === '\n' || ch === ' ' || ch === '\r') {
        i++;
        continue;
      }
      // HT forbidden
      if (ch === '\t') {
        throw new SyntaxError(
          `EDN parse error at line ${tokenLine}, column ${tokenCol}: horizontal tab (HT) is not allowed inside b64\`\` raw byte string literals (§5.3.4)`
        );
      }
      // Line comment: # … (to end of line)
      // Note: // is NOT treated as a comment because / is a valid B64DIGIT
      // (e.g. 0xFF 0xFF encodes to //8= in standard base64).
      if (ch === '#') {
        while (i < raw.length && raw[i] !== '\n') i++;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  /**
   * Read raw byte-string content between `quote` chars (b64 / b64url).
   *
   * Strips whitespace and skips `# ...` line comments per §2.5.5.
   * `/` is NOT treated as a comment delimiter because it is a valid base64 character.
   */
  private _readByteContent(quote: string): string {
    this._advance(); // opening quote
    let raw = '';
    while (!this._eof() && this._ch() !== quote) {
      const ch = this._ch();
      // lblank = %x0A / %x20 — only LF and SP are whitespace (§5.2.2 Fig 4); HT is forbidden
      if (ch === '\n' || ch === ' ') {
        this._advance();
        continue;
      }
      if (ch === '\r') {
        // CR is not lblank; skip silently as source-level normalization only
        this._advance();
        continue;
      }
      if (ch === '\t') {
        this._fail(
          'horizontal tab (HT) is not allowed inside byte string literals (§5.2.2)',
          this.line,
          this.col
        );
      }
      // # line comment — stop at newline or the closing quote (whichever comes first)
      // Note: // is NOT treated as a comment here because / is a valid B64DIGIT;
      // treating // as a comment would corrupt base64 data that naturally contains
      // consecutive slashes (e.g. 0xFF 0xFF encodes to //8= in standard base64).
      if (ch === '#') {
        while (!this._eof() && this._ch() !== '\n') {
          if (this._ch() === '\\') {
            this._advance();
            if (!this._eof() && this._ch() !== '\n') this._advance();
            continue;
          }
          if (this._ch() === quote) break;
          this._advance();
        }
        continue;
      }
      raw += this._advance();
    }
    if (this._eof()) this._fail('unterminated byte string literal');
    this._advance(); // closing quote
    return raw;
  }

  /**
   * Read hex byte-string content, recognising `...` ellipsis sequences (§4.2).
   *
   * Returns the raw hex string (with `...` markers embedded) and a flag
   * indicating whether any ellipsis was found.
   */
  private _readHexByteContentElisionAware(quote: string): {
    value: string;
    elided: boolean;
  } {
    this._advance(); // opening quote
    let hex = '';
    let elided = false;
    while (!this._eof() && this._ch() !== quote) {
      const ch = this._ch();
      // lblank = %x0A / %x20 only; HT is forbidden per §5.2 Figure 3
      if (ch === '\n' || ch === ' ' || ch === '\r') {
        this._advance();
        continue;
      }
      if (ch === '\t') {
        this._fail(
          'horizontal tab (HT) is not allowed inside hex byte string literals (§5.2.1)',
          this.line,
          this.col
        );
      }
      if (this._skipByteStringComment(quote)) continue;
      // Detect '...' ellipsis inside hex literal
      if (
        ch === '.' &&
        (this.input[this.pos + 1] ?? '') === '.' &&
        (this.input[this.pos + 2] ?? '') === '.'
      ) {
        this._advance();
        this._advance();
        this._advance();
        // consume any additional dots (spec says "three or more")
        while (!this._eof() && this._ch() === '.') this._advance();
        // adjacent ... separated only by whitespace collapse into a single ellipsis
        if (!hex.endsWith('...')) hex += '...';
        elided = true;
        continue;
      }
      if (/[0-9a-fA-F]/.test(ch)) {
        hex += this._advance();
        continue;
      }
      this._fail(
        `unexpected character ${JSON.stringify(ch)} in hex byte string`
      );
    }
    if (this._eof()) this._fail('unterminated hex byte string literal');
    this._advance(); // closing quote
    return { value: hex, elided };
  }

  // ── Token reader ─────────────────────────────────────────────────────────

  private _readNext(): Token {
    this._skipWS();
    const offset = this.pos;
    const tok = this._readNextCore();
    return {
      ...tok,
      raw: this.input.slice(offset, this.pos),
      offset,
      endOffset: this.pos,
    };
  }

  private _readNextCore(): Omit<Token, 'raw' | 'offset' | 'endOffset'> {
    const line = this.line,
      col = this.col;
    if (this._eof()) return { type: 'EOF', value: '', line, col };

    const c = this._ch();

    switch (c) {
      case '[':
        this._advance();
        return { type: 'LBRACKET', value: '[', line, col };
      case ']':
        this._advance();
        return { type: 'RBRACKET', value: ']', line, col };
      case '{':
        this._advance();
        return { type: 'LBRACE', value: '{', line, col };
      case '}':
        this._advance();
        return { type: 'RBRACE', value: '}', line, col };
      case '(':
        this._advance();
        return { type: 'LPAREN', value: '(', line, col };
      case ')':
        this._advance();
        return { type: 'RPAREN', value: ')', line, col };
      case ':':
        this._advance();
        return { type: 'COLON', value: ':', line, col };
      case ',':
        this._advance();
        return { type: 'COMMA', value: ',', line, col };
      case '<':
        if ((this.input[this.pos + 1] ?? '') === '<') {
          this._advance();
          this._advance();
          return { type: 'LT_LT', value: '<<', line, col };
        }
        this._fail(`unexpected character '<'`, line, col);
      case '>':
        if ((this.input[this.pos + 1] ?? '') === '>') {
          this._advance();
          this._advance();
          return { type: 'GT_GT', value: '>>', line, col };
        }
        this._fail(`unexpected character '>'`, line, col);
      case '+': {
        const rest1 = this.input.slice(this.pos + 1);
        // +Infinity[_N]
        if (rest1.startsWith('Infinity')) {
          const after = rest1[8] ?? '';
          const hasSuffix =
            after === '_' &&
            /[0-3i]/.test(rest1[9] ?? '') &&
            !/[a-zA-Z0-9_]/.test(rest1[10] ?? '');
          if (!/[a-zA-Z0-9_]/.test(after) || hasSuffix) {
            this._advance(); // +
            for (let i = 0; i < 8; i++) this._advance(); // Infinity
            let value = 'Infinity';
            if (hasSuffix) value += this._advance() + this._advance(); // _N
            return { type: 'FLOAT', value, line, col };
          }
        }
        // Numeric literal with explicit positive sign
        const afterPlus = rest1[0] ?? '';
        if ((afterPlus >= '0' && afterPlus <= '9') || afterPlus === '.') {
          this._advance(); // consume '+'
          return this._readNumber(line, col);
        }
        // String concatenation operator
        this._advance();
        return { type: 'PLUS', value: '+', line, col };
      }
      case '`':
        return {
          type: 'RAWSTRING',
          value: this._readRawStringContent(),
          line,
          col,
        };
      case '"': {
        const strVal = this._readStringContent('"');
        if (strVal === '' && this._ch() === '_') {
          this._advance(); // _
          return { type: 'EMPTY_INDEF_TEXT', value: '', line, col };
        }
        return { type: 'TSTR', value: strVal, line, col };
      }
      case "'": {
        // ''_ → empty indefinite byte string
        if (
          (this.input[this.pos + 1] ?? '') === "'" &&
          (this.input[this.pos + 2] ?? '') === '_'
        ) {
          this._advance(); // first '
          this._advance(); // second '
          this._advance(); // _
          return { type: 'EMPTY_INDEF_BYTES', value: '', line, col };
        }
        // 'text' → UTF-8 encoded byte string (major type 2)
        const strVal = this._readStringContent("'");
        const utf8 = new TextEncoder().encode(strVal);
        const hex = Array.from(utf8, (b) =>
          b.toString(16).padStart(2, '0')
        ).join('');
        return { type: 'SQSTR', value: hex, line, col };
      }
    }

    // -Infinity (check before generic '-' handling)
    if (c === '-') {
      const rest = this.input.slice(this.pos + 1);
      if (rest.startsWith('Infinity')) {
        const after = rest[8] ?? '';
        const hasSuffix =
          after === '_' &&
          /[0-7i]/.test(rest[9] ?? '') &&
          !/[a-zA-Z0-9_]/.test(rest[10] ?? '');
        if (!/[a-zA-Z0-9_]/.test(after) || hasSuffix) {
          this._advance(); // -
          for (let i = 0; i < 8; i++) this._advance(); // Infinity
          let value = '-Infinity';
          if (hasSuffix) value += this._advance() + this._advance(); // _N
          return { type: 'FLOAT', value, line, col };
        }
      }
      return this._readNumber(line, col);
    }

    if (c === '+') {
      const rest = this.input.slice(this.pos + 1);
      if (rest.startsWith('Infinity')) {
        const after = rest[8] ?? '';
        const hasSuffix =
          after === '_' &&
          /[0-7i]/.test(rest[9] ?? '') &&
          !/[a-zA-Z0-9_]/.test(rest[10] ?? '');
        if (!/[a-zA-Z0-9_]/.test(after) || hasSuffix) {
          this._advance(); // +
          for (let i = 0; i < 8; i++) this._advance(); // Infinity
          let value = 'Infinity';
          if (hasSuffix) value += this._advance() + this._advance(); // _N
          return { type: 'FLOAT', value, line, col };
        }
      }
      this._advance(); // consume '+' (positive sign is a no-op)
      return this._readNumber(line, col);
    }

    if (c >= '0' && c <= '9') return this._readNumber(line, col);
    // Leading-dot float: .5, .1e2, etc. (same as +.5 / -.5)
    if (c === '.' && /[0-9]/.test(this.input[this.pos + 1] ?? ''))
      return this._readNumber(line, col);
    if (/[a-zA-Z_]/.test(c)) return this._readIdent(line, col);

    // Three or more dots → ellipsis notation (§4.2)
    if (c === '.') {
      if (
        (this.input[this.pos + 1] ?? '') === '.' &&
        (this.input[this.pos + 2] ?? '') === '.'
      ) {
        this._advance();
        this._advance();
        this._advance();
        while (!this._eof() && this._ch() === '.') this._advance();
        return { type: 'ELLIPSIS', value: '...', line, col };
      }
      this._fail(`unexpected character '.'`, line, col);
    }

    this._fail(`unexpected character ${JSON.stringify(c)}`, line, col);
  }

  private _readNumber(
    line: number,
    col: number
  ): Omit<Token, 'raw' | 'offset' | 'endOffset'> {
    let raw = '';
    if (this._ch() === '-') raw += this._advance();

    // Alternative bases: 0x 0o 0b
    if (this._ch() === '0') {
      const next = this.input[this.pos + 1] ?? '';
      if (next === 'x' || next === 'X') {
        raw += this._advance() + this._advance(); // '0x'
        const hexDigitsBefore = raw.length;
        while (!this._eof() && /[0-9a-fA-F]/.test(this._ch()))
          raw += this._advance();
        const hasIntDigits = raw.length > hexDigitsBefore;
        // Hex float: optional '.[hex]' fractional part followed by 'p'/'P' exponent
        let isHexFloat = false;
        let hasFracDigits = false;
        if (!this._eof() && this._ch() === '.') {
          isHexFloat = true;
          raw += this._advance();
          const fracStart = raw.length;
          while (!this._eof() && /[0-9a-fA-F]/.test(this._ch()))
            raw += this._advance();
          hasFracDigits = raw.length > fracStart;
        }
        if (!this._eof() && (this._ch() === 'p' || this._ch() === 'P')) {
          isHexFloat = true;
          // Validate mantissa: need at least one hex digit before or after dot
          if (!hasIntDigits && !hasFracDigits)
            this._fail(`hex float has no mantissa digits: ${raw}`, line, col);
          raw += this._advance();
          if (!this._eof() && (this._ch() === '+' || this._ch() === '-'))
            raw += this._advance();
          const expStart = raw.length;
          while (!this._eof() && this._ch() >= '0' && this._ch() <= '9')
            raw += this._advance();
          // Validate exponent: at least one decimal digit required
          if (raw.length === expStart)
            this._fail(`hex float missing exponent digits: ${raw}`, line, col);
        } else if (isHexFloat) {
          // Had a dot but no 'p' — missing exponent
          this._fail(`hex float missing 'p' exponent: ${raw}`, line, col);
        }
        if (isHexFloat) {
          // Encoding-indicator suffix _0/_1/_2/_3/_4/_5/_6/_7/_i for hex floats
          if (this._ch() === '_') {
            const d = this.input[this.pos + 1] ?? '';
            const after = this.input[this.pos + 2] ?? '';
            if (
              (d === '0' ||
                d === '1' ||
                d === '2' ||
                d === '3' ||
                d === '4' ||
                d === '5' ||
                d === '6' ||
                d === '7' ||
                d === 'i') &&
              !/[0-9a-zA-Z_]/.test(after)
            ) {
              raw += this._advance() + this._advance();
            }
          }
          return { type: 'FLOAT', value: raw, line, col };
        }
        return { type: 'INTEGER', value: raw, line, col };
      }
      if (next === 'o' || next === 'O') {
        raw += this._advance() + this._advance();
        while (!this._eof() && this._ch() >= '0' && this._ch() <= '7')
          raw += this._advance();
        return { type: 'INTEGER', value: raw, line, col };
      }
      if (next === 'b' || next === 'B') {
        raw += this._advance() + this._advance();
        while (!this._eof() && (this._ch() === '0' || this._ch() === '1'))
          raw += this._advance();
        return { type: 'INTEGER', value: raw, line, col };
      }
    }

    // Decimal digits
    while (!this._eof() && this._ch() >= '0' && this._ch() <= '9')
      raw += this._advance();

    let isFloat = false;
    if (!this._eof() && this._ch() === '.') {
      isFloat = true;
      raw += this._advance();
      while (!this._eof() && this._ch() >= '0' && this._ch() <= '9')
        raw += this._advance();
    }
    if (!this._eof() && (this._ch() === 'e' || this._ch() === 'E')) {
      isFloat = true;
      raw += this._advance();
      if (!this._eof() && (this._ch() === '+' || this._ch() === '-'))
        raw += this._advance();
      const expStart = raw.length;
      while (!this._eof() && this._ch() >= '0' && this._ch() <= '9')
        raw += this._advance();
      if (raw.length === expStart)
        this._fail(
          `float exponent has no digits: ${JSON.stringify(raw)}`,
          line,
          col
        );
    }

    // Encoding-indicator suffix _0–_7 / _i (no whitespace, not followed by more ident chars)
    if (this._ch() === '_') {
      const d = this.input[this.pos + 1] ?? '';
      const after = this.input[this.pos + 2] ?? '';
      if (
        (d === '0' ||
          d === '1' ||
          d === '2' ||
          d === '3' ||
          d === '4' ||
          d === '5' ||
          d === '6' ||
          d === '7' ||
          d === 'i') &&
        !/[0-9a-zA-Z_]/.test(after)
      ) {
        // Include the suffix in the raw value.
        // isFloat is NOT set here — a float is only a float when it contains
        // '.' or 'e'/'E'.  The parser extracts encoding width from the suffix.
        raw += this._advance() + this._advance();
      }
    }

    return { type: isFloat ? 'FLOAT' : 'INTEGER', value: raw, line, col };
  }

  private _readIdent(
    line: number,
    col: number
  ): Omit<Token, 'raw' | 'offset' | 'endOffset'> {
    let ident = '';
    while (!this._eof() && /[a-zA-Z0-9_]/.test(this._ch()))
      ident += this._advance();

    // Known keywords — checked first so they are never shadowed by app-strings.
    switch (ident) {
      case 'true':
        return { type: 'TRUE', value: ident, line, col };
      case 'false':
        return { type: 'FALSE', value: ident, line, col };
      case 'null':
        return { type: 'NULL', value: ident, line, col };
      case 'undefined':
        return { type: 'UNDEFINED', value: ident, line, col };
      case 'NaN':
      case 'NaN_0':
      case 'NaN_1':
      case 'NaN_2':
      case 'NaN_3':
      case 'NaN_4':
      case 'NaN_5':
      case 'NaN_6':
      case 'NaN_7':
      case 'NaN_i':
      case 'Infinity':
      case 'Infinity_0':
      case 'Infinity_1':
      case 'Infinity_2':
      case 'Infinity_3':
      case 'Infinity_4':
      case 'Infinity_5':
      case 'Infinity_6':
      case 'Infinity_7':
      case 'Infinity_i':
        return { type: 'FLOAT', value: ident, line, col };
      case 'simple':
        return { type: 'SIMPLE', value: ident, line, col };
      case '_':
        return { type: 'UNDERSCORE', value: '_', line, col };
      // Encoding indicators used in array/map/string/bytes contexts
      case '_0':
        return { type: 'ENCODING_INDICATOR', value: '0', line, col };
      case '_1':
        return { type: 'ENCODING_INDICATOR', value: '1', line, col };
      case '_2':
        return { type: 'ENCODING_INDICATOR', value: '2', line, col };
      case '_3':
        return { type: 'ENCODING_INDICATOR', value: '3', line, col };
      case '_4':
        return { type: 'ENCODING_INDICATOR', value: '4', line, col };
      case '_5':
        return { type: 'ENCODING_INDICATOR', value: '5', line, col };
      case '_6':
        return { type: 'ENCODING_INDICATOR', value: '6', line, col };
      case '_7':
        // _7 = AI 31 = indefinite-length; kept as ENCODING_INDICATOR so that
        // bare `_` (UNDERSCORE) and explicit `_7` stay distinguishable.
        return { type: 'ENCODING_INDICATOR', value: '7', line, col };
      case '_i':
        return { type: 'ENCODING_INDICATOR', value: 'i', line, col };
    }

    // Byte-string prefixes or app-string extensions.
    // App-prefix grammar (§3 of draft-ietf-cbor-edn-literals-25):
    //   app-prefix = lcalpha *lcldh / ucalpha *ucldh
    //   lcldh = lcalpha / DIGIT / "-"
    //   ucldh = ucalpha / DIGIT / "-"
    // Mixed-case or underscore-containing idents are not valid app-prefixes.
    const firstChar = ident[0] ?? '';
    const isLower = firstChar >= 'a' && firstChar <= 'z';
    const isUpper = firstChar >= 'A' && firstChar <= 'Z';

    if (isLower || isUpper) {
      // Validate chars already consumed by the main loop (no underscore, correct case).
      const restAlreadyRead = ident.slice(1);
      const restValid = isLower
        ? /^[a-z0-9]*$/.test(restAlreadyRead)
        : /^[A-Z0-9]*$/.test(restAlreadyRead);

      if (restValid) {
        // Extend the prefix with any remaining lcldh / ucldh chars.
        // The main loop stops at '-', so we need to consume hyphen-segments here.
        while (!this._eof()) {
          const ch = this._ch();
          const validCh = isLower
            ? (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-'
            : (ch >= 'A' && ch <= 'Z') ||
              (ch >= '0' && ch <= '9') ||
              ch === '-';
          if (!validCh) break;
          ident += this._advance();
        }

        const q = this._ch();
        // Double quotes are not valid for app-string / byte-string prefixes.
        // app-string = app-prefix sqstr  (sqstr uses single quotes only)
        if (q === '"')
          this._fail(
            `"${ident}" prefix requires single quotes or backticks, not double quotes`,
            line,
            col
          );
        if (q === "'") {
          switch (ident) {
            case 'h': {
              const { value: hexVal, elided } =
                this._readHexByteContentElisionAware(q);
              return {
                type: elided ? 'BYTES_HEX_ELIDED' : 'BYTES_HEX',
                value: hexVal,
                line,
                col,
              };
            }
            case 'b64':
              return {
                type: 'BYTES_B64',
                value: this._readByteContent(q),
                line,
                col,
              };
            default:
              return {
                type: 'APP_STRING',
                appPrefix: ident,
                value: this._readStringContent(q),
                line,
                col,
              };
          }
        }

        // app-rstring: prefix followed by backtick raw string (§2.5.3 / app-rstring)
        if (q === '`') {
          const raw = this._readRawStringContent();
          switch (ident) {
            case 'h': {
              // §5.3.3: lblank + / / block comments + # line comments + ellipsis
              const { value: hexVal, elided } = this._processRawHexContent(
                raw,
                line,
                col
              );
              return {
                type: elided ? 'BYTES_HEX_ELIDED' : 'BYTES_HEX',
                value: hexVal,
                line,
                col,
              };
            }
            case 'b64':
              // §5.3.4: lblank + # line comments
              return {
                type: 'BYTES_B64',
                value: this._processRawB64Content(raw, line, col),
                line,
                col,
              };
            default:
              return {
                type: 'APP_STRING',
                appPrefix: ident,
                value: raw,
                line,
                col,
              };
          }
        }

        // App-sequence extension: prefix<<items...>>
        // The tokenizer consumes only prefix + "<<"; the parser reads items until ">>".
        if (q === '<' && (this.input[this.pos + 1] ?? '') === '<') {
          this._advance();
          this._advance(); // <<
          return {
            type: 'APP_SEQUENCE',
            appPrefix: ident,
            value: '',
            line,
            col,
          };
        }
      }
    }

    this._fail(`unknown identifier ${JSON.stringify(ident)}`, line, col);
  }
}
