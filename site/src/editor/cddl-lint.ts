/**
 * Inline diagnostics from the real CDDL compiler: syntax errors as error
 * squiggles, semantic problems (undefined names, duplicate rules, generic
 * arity, group roots) as warnings — mirroring cdn-lint.ts.
 */
import { linter, type Diagnostic } from '@codemirror/lint';
import { CDDL, CddlSyntaxError } from '@cbortech/cbor/cddl';

export const cddlLinter = linter((view) => {
  const text = view.state.doc.toString();
  if (text.trim() === '') return [];
  const clamp = (n: number) => Math.max(0, Math.min(n, text.length));
  const diagnostics: Diagnostic[] = [];
  try {
    const schema = CDDL.compile(text, { strict: false });
    for (const w of schema.warnings ?? []) {
      const from = clamp(w.start ?? 0);
      let to = clamp(w.end ?? from + 1);
      if (to <= from) to = clamp(from + 1);
      diagnostics.push({
        from,
        to,
        severity: 'warning',
        message: w.message,
      });
    }
  } catch (e) {
    if (e instanceof CddlSyntaxError) {
      let from = clamp(e.offset ?? 0);
      let to = clamp(e.endOffset ?? from + 1);
      if (to <= from) {
        from = Math.max(0, from - 1);
        to = from + 1;
      }
      diagnostics.push({
        from,
        to,
        severity: 'error',
        message: e.message,
      });
    } else {
      diagnostics.push({
        from: 0,
        to: text.length,
        severity: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return diagnostics;
});
