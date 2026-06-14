/**
 * Inline diagnostics from the real parser: syntax errors as error squiggles,
 * strict-mode (preferred serialization) violations as warnings.
 */
import { linter, type Diagnostic } from '@codemirror/lint';
import { CBOR, CdnSyntaxError } from '@cbortech/cbor';

export const cdnLinter = linter((view) => {
  const text = view.state.doc.toString();
  if (text.trim() === '') return [];
  const clamp = (n: number) => Math.max(0, Math.min(n, text.length));
  const diagnostics: Diagnostic[] = [];
  try {
    CBOR.fromCDN(text, {
      strict: false,
      onWarning: (w) => {
        const from = clamp(w.offset ?? 0);
        diagnostics.push({
          from,
          to: clamp(from + 1),
          severity: 'warning',
          message: w.message,
        });
      },
    });
  } catch (e) {
    if (e instanceof CdnSyntaxError) {
      let from = clamp(e.offset ?? 0);
      let to = clamp(e.endOffset ?? from + 1);
      // An error at end-of-input would produce an invisible empty range;
      // widen it to cover the last character instead.
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
