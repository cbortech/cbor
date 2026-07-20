/**
 * The toggleable CDDL pane: schema editor plus live validation of the CDN
 * pane's content against it.
 *
 * Validation runs against the CDN-side AST items (char offsets), so an
 * instance-side failure highlights the offending range in the CDN editor
 * and — via the existing char→byte range map — the matching bytes in the
 * hex view. Schema-side offsets highlight the failing rule in this pane's
 * editor.
 */
import type { EditorView } from '@codemirror/view';
import {
  CDDL,
  CddlSyntaxError,
  type CddlSchema,
  type CddlValidationWarning,
} from '@cbortech/cbor/cddl';
import type { Conversion } from './convert';
import { createEditor, setEditorText } from './editor/editor';
import { cddlHighlight } from './editor/cddl-highlight';
import { cddlLinter } from './editor/cddl-lint';
import { setValidationRange } from './editor/validation-deco';
import { rangeAtChar } from './mapping/lockstep';
import { copyWithFeedback, readFormatOptions } from './ui/toolbar';

const OPEN_KEY = 'cbor-site-cddl';

export interface CddlPane {
  isOpen(): boolean;
  getText(): string;
  /**
   * Replace the schema text (sample selection from the CDN pane). Compiles
   * immediately; validation still only runs while the pane is open.
   */
  setText(text: string): void;
  /** Re-run validation against the given conversion result. */
  revalidate(conversion: Conversion): void;
}

export interface CddlPaneOptions {
  cdnEditor: EditorView;
  getConversion(): Conversion;
  /** Set/clear the hex view's validation-failure byte range. */
  hexHighlight(range: { byteStart: number; byteEnd: number } | null): void;
  /** Schema shown initially: from the share hash, or the default sample. */
  initialCddl: string;
  /** Open the pane on load regardless of the persisted toggle state
   *  (share links that carry a CDDL schema). */
  forceOpen?: boolean;
}

export function initCddlPane(opts: CddlPaneOptions): CddlPane {
  const el = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
  const paneEl = document.querySelector<HTMLElement>('.pane-cddl')!;
  const dividerEl = el<HTMLDivElement>('cddl-divider');
  const toggleBtn = el<HTMLButtonElement>('cddl-toggle-btn');
  const statusEl = el<HTMLDivElement>('cddl-status');

  let schema: CddlSchema | null = null;
  let schemaError: Error | null = null;

  function setStatus(
    kind: 'ok' | 'info' | 'warning' | 'error' | null,
    message = ''
  ): void {
    statusEl.hidden = kind === null;
    statusEl.className = `bytes-status ${kind ?? ''}`;
    statusEl.textContent = message;
  }

  function clearMarks(): void {
    setValidationRange(opts.cdnEditor, null);
    setValidationRange(editor, null);
    opts.hexHighlight(null);
  }

  function compile(text: string): void {
    schema = null;
    schemaError = null;
    if (text.trim() === '') return;
    try {
      schema = CDDL.compile(text, { strict: false });
    } catch (e) {
      schemaError = e instanceof Error ? e : new Error(String(e));
    }
  }

  function revalidate(conversion: Conversion): void {
    if (paneEl.hidden) return;
    const text = editor.state.doc.toString();
    if (text.trim() === '') {
      clearMarks();
      setStatus(null);
      return;
    }
    if (schemaError !== null || schema === null) {
      clearMarks();
      setStatus(
        'error',
        schemaError instanceof CddlSyntaxError
          ? schemaError.message
          : `schema error — ${schemaError?.message ?? 'not compiled'}`
      );
      return;
    }
    if (!conversion.ok) {
      clearMarks();
      setStatus('info', 'Fix the CDN input on the right to validate it.');
      return;
    }
    if (conversion.empty) {
      clearMarks();
      setStatus(
        'info',
        'Type CDN on the right to validate it against this schema.'
      );
      return;
    }

    const items = conversion.cdnAsts;
    const warnings: CddlValidationWarning[] = [];
    for (let i = 0; i < items.length; i++) {
      const result = schema.validate(items[i]!);
      warnings.push(...(result.warnings ?? []));
      if (result.valid) continue;

      const err = result.errors[0]!;
      const prefix = items.length > 1 ? `item ${i + 1}/${items.length}: ` : '';
      setStatus('error', `${prefix}${err.message} — at ${err.path}`);
      setValidationRange(
        opts.cdnEditor,
        err.start !== undefined
          ? { from: err.start, to: err.end ?? err.start + 1 }
          : null
      );
      setValidationRange(
        editor,
        err.schemaStart !== undefined
          ? { from: err.schemaStart, to: err.schemaEnd ?? err.schemaStart + 1 }
          : null
      );
      const byteRange =
        err.start !== undefined
          ? rangeAtChar(conversion.ranges, err.start)
          : null;
      opts.hexHighlight(
        byteRange
          ? { byteStart: byteRange.byteStart, byteEnd: byteRange.byteEnd }
          : null
      );
      return;
    }

    clearMarks();
    const itemsNote = items.length > 1 ? ` — ${items.length} items` : '';
    if (warnings.length > 0) {
      setStatus(
        'warning',
        `✓ valid${itemsNote} (${warnings.length} validator warning${warnings.length === 1 ? '' : 's'}: ${warnings[0]!.message})`
      );
    } else {
      setStatus('ok', `✓ valid${itemsNote}`);
    }
  }

  // ── Editor ──────────────────────────────────────────────────────────────────

  let revalidateTimer: ReturnType<typeof setTimeout> | undefined;

  const editor = createEditor(
    el('cddl-editor'),
    opts.initialCddl,
    {
      onDocChanged(text) {
        clearTimeout(revalidateTimer);
        revalidateTimer = setTimeout(() => {
          compile(text);
          revalidate(opts.getConversion());
        }, 200);
      },
      onCursorMoved() {},
    },
    [cddlHighlight, cddlLinter]
  );

  // ── Toggle ──────────────────────────────────────────────────────────────────

  function setOpen(open: boolean, persist = true): void {
    paneEl.hidden = !open;
    dividerEl.hidden = !open;
    toggleBtn.setAttribute('aria-pressed', String(open));
    if (persist) localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    if (open) {
      compile(editor.state.doc.toString());
      revalidate(opts.getConversion());
    } else {
      // Leave no stale validation marks on the CDN/CBOR side.
      clearMarks();
      setStatus(null);
    }
  }

  toggleBtn.addEventListener('click', () => {
    setOpen(paneEl.hidden);
  });

  // ── Toolbar ─────────────────────────────────────────────────────────────────

  el('cddl-format-btn').addEventListener('click', () => {
    const text = editor.state.doc.toString();
    if (text.trim() === '') return;
    try {
      // Share the Indent setting from the CDN Format-options popover;
      // "Compact" (no indent) yields single-line rules.
      const { indent } = readFormatOptions();
      setEditorText(
        editor,
        CDDL.compile(text, { strict: false }).format({
          ...(indent !== undefined ? { indent } : {}),
          preserveComments: true,
        })
      );
    } catch {
      // Invalid CDDL: the lint squiggle already explains the problem.
    }
  });

  el('copy-cddl').addEventListener('click', (e) => {
    void copyWithFeedback(
      e.currentTarget as HTMLElement,
      editor.state.doc.toString()
    );
  });

  // ── Initial state ───────────────────────────────────────────────────────────

  compile(editor.state.doc.toString());
  if (opts.forceOpen || localStorage.getItem(OPEN_KEY) === '1')
    setOpen(true, false);

  return {
    isOpen: () => !paneEl.hidden,
    getText: () => editor.state.doc.toString(),
    setText: (text) => {
      setEditorText(editor, text);
      // Compile now rather than waiting for the editor's debounce, so a
      // conversion update racing in from the CDN side validates against
      // the new schema, not the previous one.
      compile(text);
      revalidate(opts.getConversion());
    },
    revalidate,
  };
}
