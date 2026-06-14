/**
 * Structured syntax error thrown by the CDN tokenizer and parser.
 *
 * Carries the source position of the failure so tooling (editors, linters,
 * playgrounds) can point at the offending range without parsing the message.
 * Position fields are present whenever the failure site knows them.
 */
export class CdnSyntaxError extends SyntaxError {
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
    super(`EDN parse error${loc}: ${message}`);
    this.name = 'CdnSyntaxError';
    this.offset = position?.offset;
    this.line = position?.line;
    this.column = position?.column;
    this.endOffset = position?.endOffset;
  }
}
