/**
 * Inline diagnostics from the real parser: syntax errors as error squiggles,
 * strict-mode (preferred serialisation) violations as warnings.
 *
 * Multi-item CDN Sequences are handled by fromCDNSeq so that valid sequences
 * produce no spurious "unexpected trailing content" diagnostic.
 */
import { linter, type Diagnostic } from '@codemirror/lint';
import { StateEffect } from '@codemirror/state';
import { CBOR, createERefExtension, CdnSyntaxError } from '@cbortech/cbor';
import type { CddlSchema } from '@cbortech/cbor/cddl';
import { getEnabledExtensions, isERefEnabled } from '../ui/toolbar';

/**
 * Dispatch `{ effects: refreshCdnLint.of(null) }` on the CDN editor to make
 * its linter re-run even though the document itself hasn't changed — e.g.
 * whenever the CDDL schema `createCdnLinter()`'s `getCddlSchema` reads
 * becomes active or inactive (see `main.ts`'s `onSchemaChanged`).
 *
 * This exists because CodeMirror's own `forceLinting()` is *not* a general
 * "re-lint right now" API despite its name: internally it's a no-op unless
 * a lint run is already pending (`LintState.force()`'s own `if (this.set)`
 * guard — nothing schedules one just because unrelated external state
 * changed). The officially supported hook for exactly this case is the
 * `needsRefresh` linter config below, which only fires for an update that
 * carries this effect — a plain `forceLinting()` call right afterwards then
 * *does* work, since dispatching the effect is itself what puts a run into
 * the pending state `force()` requires.
 */
export const refreshCdnLint = StateEffect.define<null>();

/**
 * Build the CDN linter. `getCddlSchema`, when it returns a schema *and* the
 * `e'...'` checkbox in the Extensions popover is checked (`isERefEnabled()`),
 * registers the `e'...'` external-reference app-extension for this lint pass
 * — same as `convertCdn()`'s own conversion pipeline (see its doc for why
 * that's `extensions`, never the validating/throwing `cddl` option). Without
 * this, a name the CDDL pane's schema *does* resolve — so the bytes pane
 * already converts it correctly — would still show a stale "missing
 * extension" squiggle here, because this lint pass parses independently of
 * that pipeline and had no way to know a schema was active at all.
 */
export function createCdnLinter(
  getCddlSchema: () => CddlSchema | null | undefined = () => undefined
) {
  return linter(
    (view) => {
      const text = view.state.doc.toString();
      if (text.trim() === '') return [];
      const clamp = (n: number) => Math.max(0, Math.min(n, text.length));
      const diagnostics: Diagnostic[] = [];
      const { extensions, builtinExtensions } = getEnabledExtensions();
      const cddlSchema = getCddlSchema();
      try {
        // Exhaust the generator so every item is parsed and every warning collected.
        for (const _item of CBOR.fromCDNSeq(text, {
          strict: false,
          extensions:
            cddlSchema && isERefEnabled()
              ? [createERefExtension(cddlSchema), ...extensions]
              : extensions,
          builtinExtensions,
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
    },
    {
      needsRefresh: (update) =>
        update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshCdnLint))
        ),
    }
  );
}

/** Default CDN linter, with no CDDL schema awareness — used wherever the
 * caller doesn't associate the editor with a CDDL pane (`createEditor`'s
 * own default). The main playground's CDN editor instead builds its own via
 * `createCdnLinter()`, passing a live `cddlPane` lookup (see `main.ts`). */
export const cdnLinter = createCdnLinter();
