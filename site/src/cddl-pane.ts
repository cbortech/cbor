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
  type CddlFormatOptions,
  type CddlSchema,
  type CddlValidationWarning,
} from '@cbortech/cbor/cddl';
import type { Conversion } from './convert';
import { createEditor, setEditorText } from './editor/editor';
import { cddlHighlight } from './editor/cddl-highlight';
import { cddlLinter } from './editor/cddl-lint';
import { setValidationRange } from './editor/validation-deco';
import { rangeAtChar } from './mapping/lockstep';
import {
  copyWithFeedback,
  initFileDrop,
  wirePopoverToggle,
} from './ui/toolbar';

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
  /** Open the pane (normally closed on load) for share links that carry
   *  a CDDL schema. */
  forceOpen?: boolean;
  /** Called after a schema file is imported (button or drag & drop). */
  onImported?: () => void;
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

  function setOpen(open: boolean): void {
    paneEl.hidden = !open;
    dividerEl.hidden = !open;
    toggleBtn.setAttribute('aria-pressed', String(open));
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

  wirePopoverToggle('cddl-format-opts-btn', 'cddl-format-popover');

  function readCddlFormatOptions(): CddlFormatOptions {
    const options: CddlFormatOptions = {};
    const indentRaw = el<HTMLSelectElement>('cddl-opt-indent').value;
    if (indentRaw !== '')
      options.indent = indentRaw === 'tab' ? '\t' : Number(indentRaw);
    if (el<HTMLInputElement>('cddl-opt-comments').checked)
      options.preserveComments = true;
    return options;
  }

  el('cddl-format-btn').addEventListener('click', () => {
    const text = editor.state.doc.toString();
    if (text.trim() === '') return;
    try {
      setEditorText(
        editor,
        CDDL.compile(text, { strict: false }).format(readCddlFormatOptions())
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

  // ── Schema file import / export ─────────────────────────────────────────────

  const importInput = el<HTMLInputElement>('cddl-import-input');

  function importCddlFile(file: File): void {
    file
      .text()
      .then((text) => {
        opts.onImported?.();
        setEditorText(editor, text);
        // Compile now rather than waiting for the editor debounce so the
        // status line reflects the imported schema immediately.
        compile(text);
        revalidate(opts.getConversion());
      })
      .catch((e: unknown) => {
        setStatus('error', e instanceof Error ? e.message : String(e));
      });
  }

  el('cddl-import-btn').addEventListener('click', () => importInput.click());

  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (!file) return;
    importInput.value = '';
    importCddlFile(file);
  });

  initFileDrop(el('cddl-editor'), importCddlFile);

  el('cddl-export-btn').addEventListener('click', () => {
    const text = editor.state.doc.toString().replace(/\r\n?|\n/g, '\r\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'schema.cddl';
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Initial state ───────────────────────────────────────────────────────────

  // Closed (validation off) by default; share links carrying a schema open it.
  compile(editor.state.doc.toString());
  if (opts.forceOpen) setOpen(true);

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
