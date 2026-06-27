/**
 * Inline diagnostics from the real parser: syntax errors as error squiggles,
 * strict-mode (preferred serialisation) violations as warnings.
 *
 * Multi-item CDN Sequences are handled by fromCDNSeq so that valid sequences
 * produce no spurious "unexpected trailing content" diagnostic.
 */
import { linter, type Diagnostic } from '@codemirror/lint';
import { CBOR, CdnSyntaxError } from '@cbortech/cbor';
import { SITE_EXTENSIONS } from '../extensions';

export const cdnLinter = linter((view) => {
  const text = view.state.doc.toString();
  if (text.trim() === '') return [];
  const clamp = (n: number) => Math.max(0, Math.min(n, text.length));
  const diagnostics: Diagnostic[] = [];
  try {
    // Exhaust the generator so every item is parsed and every warning collected.
    for (const _item of CBOR.fromCDNSeq(text, {
      strict: false,
      extensions: SITE_EXTENSIONS,
      onWarning: (w) => {
        const from = clamp(w.offset ?? 0);
        diagnostics.push({
          from,
          to: clamp(from + 1),
          severity: 'warning',
          message: w.message,
        });
      },
    })) {
      /* consume */
    }
  } catch (e) {
    if (e instanceof CdnSyntaxError) {
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
