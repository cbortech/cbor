/**
 * Public lower-level CDN tokenization API (`@cbortech/cbor/cdn`).
 *
 * Exposes the same lexer the parser uses, so tooling such as syntax
 * highlighters stays in exact agreement with parsing behavior.
 */

import { Tokenizer, type Token, type EdnComment } from './tokenizer';
import { CdnSyntaxError } from './errors';

export type { Token, TokenType, EdnComment } from './tokenizer';
export { CdnSyntaxError } from './errors';

export interface TokenizeResult {
  /** Scanned tokens in source order, excluding the final EOF token. */
  tokens: Token[];
  /** Comments encountered while scanning, in source order. */
  comments: EdnComment[];
}

export interface TokenizeLenientResult extends TokenizeResult {
  /**
   * The scan failure, if any. When set, `tokens` ends with a synthetic
   * `ERROR` token covering the source from the last clean token to the end
   * of the input.
   */
  error?: CdnSyntaxError;
}

/**
 * Tokenize CDN text. Throws {@link CdnSyntaxError} on invalid input.
 */
export function tokenize(text: string): TokenizeResult {
  const tokenizer = new Tokenizer(text);
  const tokens: Token[] = [];
  for (;;) {
    const tok = tokenizer.consume();
    if (tok.type === 'EOF') break;
    tokens.push(tok);
  }
  return { tokens, comments: tokenizer.comments };
}

/**
 * Error-tolerant tokenization for editors and highlighters: never throws on
 * invalid input. Tokens before the failure are returned as scanned; the
 * remainder of the input is covered by a single synthetic `ERROR` token and
 * the failure is reported in `error`.
 */
export function tokenizeLenient(text: string): TokenizeLenientResult {
  const tokenizer = new Tokenizer(text);
  const tokens: Token[] = [];
  try {
    for (;;) {
      const tok = tokenizer.consume();
      if (tok.type === 'EOF') break;
      tokens.push(tok);
    }
    return { tokens, comments: tokenizer.comments };
  } catch (e) {
    const error =
      e instanceof CdnSyntaxError
        ? e
        : new CdnSyntaxError(e instanceof Error ? e.message : String(e));
    const start = tokenizer.lastEndOffset;
    if (start < text.length) {
      let line = 1;
      let col = 1;
      for (let i = 0; i < start; i++) {
        if (text[i] === '\n') {
          line++;
          col = 1;
        } else {
          col++;
        }
      }
      tokens.push({
        type: 'ERROR',
        value: text.slice(start),
        raw: text.slice(start),
        line,
        col,
        offset: start,
        endOffset: text.length,
      });
    }
    return { tokens, comments: tokenizer.comments, error };
  }
}
