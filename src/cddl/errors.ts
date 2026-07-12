/**
 * Structured errors thrown by the CDDL tokenizer, parser, and compiler.
 *
 * Both carry source positions so tooling (editors, linters, playgrounds) can
 * point at the offending range without parsing the message.
 */

/** A semantic problem found while compiling a syntactically valid CDDL file. */
export interface CddlWarning {
  /** Stable machine-readable identifier, e.g. 'undefined-name'. */
  code:
    | 'no-rules'
    | 'duplicate-rule'
    | 'undefined-name'
    | 'generic-arity'
    | 'invalid-major'
    | 'invalid-root';
  message: string;
  /** Character offset of the start of the offending range in the source input. */
  start?: number;
  /** Character offset just past the end of the offending range. */
  end?: number;
}

/** Syntax error thrown by the CDDL tokenizer and parser. */
export class CddlSyntaxError extends SyntaxError {
  /** Character offset of the start of the offending range in the source input. */
  readonly offset?: number;
  /** 1-based line number of the offending range. */
  readonly line?: number;
  /** 1-based column number of the offending range. */
  readonly column?: number;
  /** Character offset just past the end of the offending range. */
  readonly endOffset?: number;

  constructor(
    message: string,
    position?: {
      offset?: number;
      line?: number;
      column?: number;
      endOffset?: number;
    }
  ) {
    const loc =
      position?.line !== undefined
        ? ` at line ${position.line}, column ${position.column}`
        : '';
    super(`CDDL parse error${loc}: ${message}`);
    this.name = 'CddlSyntaxError';
    this.offset = position?.offset;
    this.line = position?.line;
    this.column = position?.column;
    this.endOffset = position?.endOffset;
  }
}

/**
 * Semantic error thrown by `CDDL.compile` in strict mode (the default) when
 * a syntactically valid file has semantic problems: undefined names,
 * duplicate rule definitions, generic arity mismatches, and the like.
 * With `strict: false` the same problems are collected into
 * `CddlSchema.warnings` instead.
 */
export class CddlSemanticError extends Error {
  readonly warnings: CddlWarning[];

  constructor(warnings: CddlWarning[]) {
    const head = warnings[0];
    const rest =
      warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : '';
    super(`CDDL semantic error: ${head?.message ?? 'unknown'}${rest}`);
    this.name = 'CddlSemanticError';
    this.warnings = warnings;
  }
}
