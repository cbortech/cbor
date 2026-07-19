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

/**
 * A single validation failure. When a data item does not match the schema,
 * the reported error is the one recorded at the deepest point the matcher
 * reached (failures discarded by backtracking are noise and are not kept).
 */
export interface CddlValidationError {
  message: string;
  /** Location inside the instance, e.g. '/claims/2/name' ('' = root). */
  path: string;
  /** Instance-side source offsets (byte offsets for CBOR input, character
   *  offsets for CDN input), when the input carried them. */
  start?: number;
  end?: number;
  /** The CDDL rule being matched when the failure was recorded. */
  ruleName?: string;
  /** Schema-side source offsets of the CDDL construct that failed to match. */
  schemaStart?: number;
  schemaEnd?: number;
}

/** A non-fatal observation made while validating (e.g. unsupported control
 *  operators, whose targets are then matched without the constraint). */
export interface CddlValidationWarning {
  message: string;
  schemaStart?: number;
  schemaEnd?: number;
}

/** Result of {@link CddlSchema.validate}. */
export interface ValidationResult {
  valid: boolean;
  /** Empty when valid; otherwise the deepest-reach failure(s). */
  errors: CddlValidationError[];
  /** Present when the validator had to approximate or skip constraints. */
  warnings?: CddlValidationWarning[];
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
 * Error thrown when a data item does not match a CDDL schema supplied via
 * the `cddl` option of a throwing entry point (`CBOR.parse`, `CBOR.decode`,
 * `CBOR.fromCDN`, `CBOR.encode`, …). Non-throwing checks (`CBOR.validate`,
 * `CddlSchema.validate`) report the same failures in their result instead.
 */
export class CddlMismatchError extends Error {
  /** The deepest-reach validation failure(s). */
  readonly errors: CddlValidationError[];
  /** Non-fatal validator observations (approximated/skipped constraints). */
  readonly warnings: CddlValidationWarning[];

  constructor(
    errors: CddlValidationError[],
    warnings: CddlValidationWarning[] = []
  ) {
    const head = errors[0];
    const loc = head?.path ? ` at ${head.path}` : '';
    const rest = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
    super(`CDDL validation failed${loc}: ${head?.message ?? 'unknown'}${rest}`);
    this.name = 'CddlMismatchError';
    this.errors = errors;
    this.warnings = warnings;
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
