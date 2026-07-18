/**
 * Convert a character offset (as carried by CDDL AST nodes, CddlWarning,
 * and CddlValidationError.schemaStart/schemaEnd or start/end for CDN input)
 * into a 1-based line/column position, for CLI-style `file:line:col`
 * reporting.
 *
 * Offsets are JS string indices (UTF-16 code units), matching everything
 * else in this library. Offsets past the end of the text clamp to its end.
 */
export function positionAt(
  text: string,
  offset: number
): { line: number; column: number } {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}
