/**
 * Public CDDL API (`@cbortech/cbor/cddl`).
 *
 * Phase 1 covers the grammar layer of RFC 8610 + RFC 9682: compiling CDDL
 * text into a checked rule table (`CDDL.compile`), re-serializing it
 * (`schema.format()`), and the lower-level tokenization API used by tooling
 * such as syntax highlighters. Validating CBOR/CDN data against a schema is
 * a later phase.
 */

import { CddlTokenizer, type CddlComment, type CddlToken } from './tokenizer';
import { CddlSyntaxError } from './errors';
import { compile, CddlSchema, type CompileOptions } from './schema';

export type { CddlToken, CddlTokenType, CddlComment } from './tokenizer';
export { CddlSyntaxError, CddlSemanticError } from './errors';
export type {
  CddlWarning,
  CddlValidationError,
  CddlValidationWarning,
  ValidationResult,
} from './errors';
export type { ValidateOptions } from './validator';
export { CddlSchema } from './schema';
export type { CompileOptions } from './schema';
export { parseCDDL } from './parser';
export type { ParseCddlResult } from './parser';
export { PRELUDE_CDDL, getPreludeRules } from './prelude';
export type {
  CddlRule,
  CddlType,
  CddlType1,
  CddlType2,
  CddlValue,
  CddlRef,
  CddlParenType,
  CddlMapType,
  CddlArrayType,
  CddlUnwrap,
  CddlEnum,
  CddlTagged,
  CddlMajor,
  CddlAny,
  CddlGroup,
  CddlGroupEntry,
  CddlEntryValue,
  CddlEntryGroup,
  CddlOccur,
  CddlMemberKey,
  CddlNodeBase,
} from './ast';

/** Main CDDL facade — mirrors the shape of the `CBOR` facade. */
export class CDDL {
  /**
   * Parse and compile a CDDL data model.
   *
   * @example
   * const schema = CDDL.compile(`person = { name: tstr, ? age: uint }`);
   * schema.root.name;  // 'person'
   */
  static compile(text: string, options?: CompileOptions): CddlSchema {
    return compile(text, options);
  }
}

export default CDDL;

export interface TokenizeResult {
  /** Scanned tokens in source order, excluding the final EOF token. */
  tokens: CddlToken[];
  /** Comments encountered while scanning, in source order. */
  comments: CddlComment[];
}

export interface TokenizeLenientResult extends TokenizeResult {
  /**
   * The scan failure, if any. When set, `tokens` ends with a synthetic
   * `ERROR` token covering the source from the last clean token to the end
   * of the input.
   */
  error?: CddlSyntaxError;
}

/**
 * Tokenize CDDL text. Throws {@link CddlSyntaxError} on invalid input.
 */
export function tokenize(text: string): TokenizeResult {
  const tokenizer = new CddlTokenizer(text);
  const tokens: CddlToken[] = [];
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
  const tokenizer = new CddlTokenizer(text);
  const tokens: CddlToken[] = [];
  try {
    for (;;) {
      const tok = tokenizer.consume();
      if (tok.type === 'EOF') break;
      tokens.push(tok);
    }
    return { tokens, comments: tokenizer.comments };
  } catch (e) {
    const error =
      e instanceof CddlSyntaxError
        ? e
        : new CddlSyntaxError(e instanceof Error ? e.message : String(e));
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
