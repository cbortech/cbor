/**
 * Strip whitespace and EDN §2.2 comments from app-string content.
 *
 * Used by extensions whose content allows the same comment syntax as byte
 * string literals (b32, h32, float, …):
 *   SP / LF / CR       — whitespace, skipped
 *   # … LF             — line comment
 *   // … LF            — line comment
 *   /* … *\/           — block comment (unterminated → SyntaxError)
 *   / … /              — block comment (unterminated → SyntaxError)
 */
export function stripComments(str: string): string {
  let out = '';
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ' ' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < str.length && str[i] !== '\n') i++;
      continue;
    }
    if (ch === '/') {
      const next = str[i + 1] ?? '';
      if (next === '/') {
        while (i < str.length && str[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        i += 2;
        while (
          i < str.length &&
          !(str[i] === '*' && (str[i + 1] ?? '') === '/')
        )
          i++;
        if (i >= str.length)
          throw new SyntaxError('unterminated block comment');
        i += 2; // consume */
        continue;
      }
      // / … / block comment
      i++;
      while (i < str.length && str[i] !== '/') i++;
      if (i >= str.length) throw new SyntaxError('unterminated block comment');
      i++; // consume closing /
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
