import './styles.css';
import { CBOR } from '@cbortech/cbor';
import { forceLinting } from '@codemirror/lint';
import { placeholder } from '@codemirror/view';
import {
  annotateIfValid,
  bytesToCdnText,
  bytesToHexString,
  convertCdn,
  formatCdnText,
  type Conversion,
} from './convert';
import { createEditor, selectRange, setEditorText } from './editor/editor';
import { cdnHighlight } from './editor/cdn-highlight';
import { createCdnLinter, refreshCdnLint } from './editor/cdn-lint';
import {
  hexEditHighlight,
  hexEditHoverTooltip,
  hexEditModelField,
  setHexEditModel,
} from './editor/hex-edit-highlight';
import { HexView } from './hexview/hexview';
import type { CddlSchema } from '@cbortech/cbor/cddl';
import { rangeAtByte, rangeAtChar } from './mapping/lockstep';
import { appendJSChunks, tokenizeJS } from './js-preview';
import { DEFAULT_SAMPLE, SAMPLES } from './samples';
import { initCddlPane, type CddlPane } from './cddl-pane';
import {
  type BytesMode,
  copyWithFeedback,
  decodeShareHash,
  encodeShareHash,
  getEnabledExtensions,
  initExtensionsPopover,
  initFileDrop,
  initFormatPopover,
  initModeTabs,
  initSamples,
  initTheme,
  readCddlOpenParam,
  readFormatOptions,
  writeCddlOpenParam,
} from './ui/toolbar';

type Debounced<A extends unknown[]> = ((...args: A) => void) & {
  cancel: () => void;
};

function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const d = (...args: A): void => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  d.cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return d;
}

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const hexviewEl = el<HTMLDivElement>('hexview');
const jsViewEl = el<HTMLPreElement>('js-view');
const editWrapEl = el<HTMLDivElement>('bytes-edit-wrap');
const bytesEditHostEl = el<HTMLDivElement>('bytes-edit-host');
const statusEl = el<HTMLDivElement>('bytes-status');
const byteCountEl = el<HTMLSpanElement>('byte-count');
const exportBtnEl = el<HTMLButtonElement>('export-btn');
const copyBytesBtn = el('copy-bytes');

// Declared this early (rather than alongside the other bytes-pane toolbar
// wiring further down) because `update()` below calls `updateCopyBytesBtn()`
// synchronously, and — since `cddlPane`'s own construction can itself
// synchronously call back into `update()` via `onSchemaChanged` when the
// initial share/`?cddl=` state opens the pane — that can happen during this
// module's own top-level setup, before a later declaration would exist yet.
function updateCopyBytesBtn(): void {
  const active = mode === 'annotated' || mode === 'plain';
  copyBytesBtn.toggleAttribute(
    'disabled',
    !active || !conversion.ok || conversion.empty
  );
}

let mode: BytesMode = 'annotated';
let conversion: Conversion = { ok: true, empty: true };
// Warning message originating from hex/file CBOR input (not the CDN parse).
// Shown in the status bar when there are no CDN-conversion warnings.
let hexParseWarning: string | null = null;
// Set to true while setEditorText is called programmatically from hex input so
// that onDocChanged does not prematurely clear hexParseWarning.
let _programmaticEdit = false;
// Set to true while renderBytesPane() syncs hexEditEditor's document from
// `bytes` (i.e. the Edit tab isn't focused, so nothing the user typed is
// being echoed back). Without this, that sync — a real CodeMirror doc
// change, unlike assigning a plain <textarea>.value — would itself trigger
// hexEditEditor's onDocChanged, reconvert the very bytes it was just set
// from, and overwrite the main CDN editor: a feedback loop with no
// informational value (see hexEditEditor's onDocChanged below).
let _programmaticHexEdit = false;

const hexView = new HexView(hexviewEl, {
  onSelectBytes(byteStart) {
    if (!conversion.ok || conversion.empty) return;
    const range = rangeAtByte(conversion.ranges, byteStart);
    if (range) selectRange(editor, range.charStart, range.charEnd);
  },
});

function setStatus(kind: 'error' | 'warning' | null, message = ''): void {
  statusEl.hidden = kind === null;
  statusEl.className = `bytes-status ${kind ?? ''}`;
  statusEl.textContent = message;
}

function renderBytesPane(): void {
  hexviewEl.hidden = mode !== 'annotated' && mode !== 'plain';
  jsViewEl.hidden = mode !== 'js';
  editWrapEl.hidden = mode !== 'edit';

  if (!conversion.ok) {
    const e = conversion.error;
    byteCountEl.textContent = '';
    exportBtnEl.title = 'Save as a .cbor file';
    setStatus('error', e instanceof Error ? e.message : String(e));
    hexView.renderEmpty('');
    jsViewEl.textContent = '';
    if (!hexEditEditor.hasFocus) syncHexEditText('');
    hexEditEditor.dispatch({ effects: setHexEditModel.of(null) });
    return;
  }
  if (conversion.empty) {
    hexParseWarning = null;
    byteCountEl.textContent = '';
    exportBtnEl.title = 'Save as a .cbor file';
    hexView.renderEmpty('Type CDN on the left to see CBOR bytes.');
    jsViewEl.textContent = '';
    if (!hexEditEditor.hasFocus) syncHexEditText('');
    hexEditEditor.dispatch({ effects: setHexEditModel.of(null) });
    setStatus(null);
    return;
  }

  const { bytes, binAst, rows, warnings, seqLength, binAsts } = conversion;
  // Kept fresh regardless of the active tab, so the coloring/hints in the
  // Edit tab (see hex-edit-highlight.ts) are ready the moment it's shown.
  hexEditEditor.dispatch({ effects: setHexEditModel.of({ rows, bytes }) });
  byteCountEl.textContent =
    `· ${bytes.length} byte${bytes.length === 1 ? '' : 's'}` +
    (seqLength > 1 ? ` (${seqLength} items)` : '');
  exportBtnEl.title =
    seqLength > 1 ? 'Save as a .cborseq file' : 'Save as a .cbor file';
  if (warnings.length > 0) {
    const first = warnings[0]!;
    setStatus(
      'warning',
      `${warnings.length} warning${warnings.length === 1 ? '' : 's'} — ${first.message}`
    );
  } else if (hexParseWarning !== null) {
    setStatus('warning', hexParseWarning);
  } else {
    setStatus(null);
  }

  if (mode === 'annotated' || mode === 'plain') {
    hexView.render(rows, bytes, mode);
  } else if (mode === 'js') {
    jsViewEl.textContent = '';
    try {
      if (seqLength > 1) {
        binAsts.forEach((ast, i) => {
          if (i > 0) jsViewEl.appendChild(document.createTextNode('\n─────\n'));
          appendJSChunks(jsViewEl, tokenizeJS(ast.toJS()));
        });
      } else {
        appendJSChunks(jsViewEl, tokenizeJS(binAst.toJS()));
      }
    } catch (e) {
      jsViewEl.textContent = e instanceof Error ? e.message : String(e);
    }
  } else if (mode === 'edit' && !hexEditEditor.hasFocus) {
    syncHexEditText(bytesToHexString(bytes));
  }
}

/**
 * The schema every CDDL-aware conversion in this file should treat as
 * active right now: the CDDL pane's own compiled schema while it's open,
 * `null` while it's closed — matches "validation only runs while the pane
 * is open" for the same reason: closing the pane should make every one of
 * these forget the schema entirely, not just stop checking it.
 */
function activeCddlSchema(): CddlSchema | null {
  return cddlPane?.isOpen() ? cddlPane.getSchema() : null;
}

const update = (text: string): void => {
  // See activeCddlSchema()'s own doc for why this is `null`, not just
  // absent, while the pane is closed.
  conversion = convertCdn(text, activeCddlSchema());
  renderBytesPane();
  updateCopyBytesBtn();
  cddlPane?.revalidate(conversion);
};

const debouncedUpdate = debounce(update, 200);

const onCursorMoved = debounce((pos: number): void => {
  if (!conversion.ok || conversion.empty) return;
  if (mode !== 'annotated' && mode !== 'plain') return;
  const range = rangeAtChar(conversion.ranges, pos);
  hexView.highlightBytes(
    range ? { byteStart: range.byteStart, byteEnd: range.byteEnd } : null
  );
}, 100);

const shared = decodeShareHash(location.hash);
const initialText = shared?.cdn ?? DEFAULT_SAMPLE;
let resetSamples = (): void => {};
let cddlPane: CddlPane | undefined;

const editor = createEditor(
  el('editor'),
  initialText,
  {
    onDocChanged(text) {
      if (!_programmaticEdit) hexParseWarning = null;
      if (text.trim() === '') resetSamples();
      debouncedUpdate(text);
    },
    onCursorMoved,
  },
  // Same [highlight, linter] pair createEditor() defaults to, except the
  // linter also registers `e'...'` — mirroring update()'s own conversion —
  // so a name the open CDDL schema resolves doesn't show a stale
  // missing-extension squiggle. `cddlPane` is assigned after this call but
  // read only when the linter callback actually runs (on a doc change),
  // by which point it's set — same forward-reference pattern `update()`
  // itself relies on.
  [cdnHighlight, createCdnLinter(activeCddlSchema)]
);

/** Set editor text from an external hex/file source, preserving hexParseWarning. */
function applyHexResult(cdn: string, warnings: string[]): void {
  hexParseWarning =
    warnings.length > 0
      ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'} — ${warnings[0]!}`
      : null;
  _programmaticEdit = true;
  setEditorText(editor, cdn);
  _programmaticEdit = false;
}

// ── Pane resize ──────────────────────────────────────────────────────────────

const playgroundEl = document.querySelector<HTMLElement>('.playground')!;
const cddlPaneEl = playgroundEl.querySelector<HTMLElement>('.pane-cddl')!;
const cdnPane = playgroundEl.querySelector<HTMLElement>('.pane-cdn')!;
const bytesPane = playgroundEl.querySelector<HTMLElement>('.pane-bytes')!;

/** Make a divider resize its two adjacent panes by dragging. */
function initPaneDivider(
  divider: HTMLElement,
  left: HTMLElement,
  right: HTMLElement
): void {
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('is-dragging');
    const startX = e.clientX;
    const startLeft = left.getBoundingClientRect().width;
    const startRight = right.getBoundingClientRect().width;
    const total = startLeft + startRight;
    // The two flex weights being redistributed between the two panes.
    const leftFlex = parseFloat(left.style.flex) || 1;
    const rightFlex = parseFloat(right.style.flex) || 1;
    const flexTotal = leftFlex + rightFlex;

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const newLeft = Math.max(200, Math.min(total - 200, startLeft + delta));
      const ratio = newLeft / total;
      left.style.flex = `${flexTotal * ratio} 1 0`;
      right.style.flex = `${flexTotal * (1 - ratio)} 1 0`;
    };
    const onUp = () => {
      divider.classList.remove('is-dragging');
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp);
  });
}

initPaneDivider(el('pane-divider'), cdnPane, bytesPane);
initPaneDivider(el('cddl-divider'), cddlPaneEl, cdnPane);

// ── Bytes edit mode: hex / annotated dump → CDN ──────────────────────────────

// Editable hex dump, colored and hover-hinted the same way as the read-only
// Hex tab once it parses (see hex-edit-highlight.ts) — the coloring model
// is kept fresh independently, in renderBytesPane().
function runHexEditConversion(text: string): void {
  if (text.trim() === '') {
    setEditorText(editor, '');
    return;
  }
  try {
    const { cdn, warnings } = bytesToCdnText(
      text,
      readFormatOptions(),
      activeCddlSchema()
    );
    applyHexResult(cdn, warnings);
  } catch (e) {
    debouncedUpdate.cancel();
    conversion = { ok: false, error: e };
    renderBytesPane();
    updateCopyBytesBtn();
  }
}
const convertHexEditText = debounce(runHexEditConversion, 300);

const hexEditEditor = createEditor(
  bytesEditHostEl,
  '',
  {
    onDocChanged(text) {
      // A programmatic sync from `bytes` (renderBytesPane, via
      // syncHexEditText below), not something the user typed — converting
      // it back would just reproduce the bytes it came from. See
      // _programmaticHexEdit's own comment for why this guard exists at
      // all (a plain <textarea> wouldn't have needed it).
      if (_programmaticHexEdit) return;
      convertHexEditText(text);
    },
    onCursorMoved: () => {},
  },
  [
    hexEditModelField,
    hexEditHighlight,
    hexEditHoverTooltip,
    placeholder('83 01 02 03'),
  ]
);

/** Set hexEditEditor's document without triggering its own onDocChanged
 * reconversion — see _programmaticHexEdit. */
function syncHexEditText(text: string): void {
  _programmaticHexEdit = true;
  setEditorText(hexEditEditor, text);
  _programmaticHexEdit = false;
}

// Pasting hex/dump text directly onto the rendered hex view also converts.
hexviewEl.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  try {
    const { cdn, warnings } = bytesToCdnText(
      text,
      readFormatOptions(),
      activeCddlSchema()
    );
    applyHexResult(cdn, warnings);
  } catch (err) {
    debouncedUpdate.cancel();
    conversion = { ok: false, error: err };
    renderBytesPane();
    updateCopyBytesBtn();
  }
});

// ── Toolbar ──────────────────────────────────────────────────────────────────

initTheme();
initFormatPopover();
initExtensionsPopover(() => {
  // Extension toggles change parse/decode results without editing the
  // document, so force both the bytes-pane conversion and the CDN editor's
  // lint diagnostics to refresh immediately (no debounce). `forceLinting()`
  // alone is a no-op unless a lint run is already pending — dispatch
  // `refreshCdnLint` first so it actually has one to run — see
  // `cdn-lint.ts`'s doc (same pattern `onSchemaChanged` below uses).
  update(editor.state.doc.toString());
  editor.dispatch({ effects: refreshCdnLint.of(null) });
  forceLinting(editor);
});
resetSamples = initSamples((sample) => {
  // A sample is a CDN/CDDL pair: load both. The schema compiles right
  // away, but validation only runs while the CDDL pane is open. Convert
  // immediately (skipping the editor debounce) so the pane never shows
  // the previous sample's data validated against the new schema.
  cddlPane?.setText(sample.cddl);
  // A sample whose CDN relies on the schema being active (e.g. `e'...'`
  // external references, which have no meaning without one) opens the pane
  // itself rather than leaving the reader to notice why the sample doesn't
  // convert as shown — see Sample.requiresCddl. A sample merely *about*
  // CDDL, but that converts fine either way, opens it only as long as the
  // reader hasn't made their own explicit choice yet this session — see
  // Sample.showsCddl. Every other sample leaves the pane's open state
  // alone entirely.
  //
  // requiresCddl is persisted the same way an explicit click would be
  // (`writeCddlOpenParam`, normally `onToggle`'s job — `setOpen()` alone
  // doesn't call it, see its own doc): selecting a sample is itself a user
  // action, so a `?cddl=0` left over from an earlier manual close must not
  // silently override this and reopen the pane closed again on reload, and
  // Share right after selecting this sample must capture the pane as
  // actually shown. showsCddl is deliberately *not* persisted this way —
  // it's a suggestion, not a decision made on the reader's behalf.
  if (sample.requiresCddl && !cddlPane?.isOpen()) {
    cddlPane?.setOpen(true);
    writeCddlOpenParam(true);
  } else if (
    sample.showsCddl &&
    !cddlPane?.isOpen() &&
    readCddlOpenParam(location.search) === undefined
  ) {
    // Weaker than requiresCddl: only while the reader hasn't made an
    // explicit choice about the pane yet this session — an existing
    // `?cddl=` (open *or* closed) means they already have, and this leaves
    // it alone. Not persisted to `?cddl=` either — see Sample.showsCddl.
    cddlPane?.setOpen(true);
  }
  setEditorText(editor, sample.cdn);
  debouncedUpdate.cancel();
  update(sample.cdn);
});
initModeTabs((next) => {
  mode = next;
  renderBytesPane();
  updateCopyBytesBtn();
  // Re-render rebuilds the hex rows, dropping any validation highlight.
  cddlPane?.revalidate(conversion);
});

// ── CDDL pane ────────────────────────────────────────────────────────────────

cddlPane = initCddlPane({
  cdnEditor: editor,
  getConversion: () => conversion,
  hexHighlight: (range) => hexView.highlightValidation(range),
  // Fresh visit: the default sample's schema, matching the default CDN.
  // Share link: the shared schema, or — since a schema matching foreign
  // CDN cannot be guessed — an empty editor.
  initialCddl: shared ? (shared.cddl ?? '') : SAMPLES[0]!.cddl,
  // `?cddl=1`/`?cddl=0` (etc.) explicitly overrides whether the pane opens;
  // absent that, fall back to the share-hash heuristic (schema → open).
  initiallyOpen:
    readCddlOpenParam(location.search) ?? shared?.cddl !== undefined,
  // A loaded sample is a CDN/CDDL pair; importing a foreign schema makes
  // the samples selection stale, same as importing CDN or CBOR.
  onImported: () => resetSamples(),
  onToggle: writeCddlOpenParam,
  // The CDN pane's own conversion *and* its linter (see `createCdnLinter()`
  // above) both consult `cddlPane.isOpen()`/`getSchema()` to register
  // `e'...'`; refresh both whenever either could have changed, even though
  // the CDN text itself didn't — otherwise the editor's own squiggle for an
  // unresolved `e'name'` would go stale the moment the schema that resolves
  // it becomes active (or inactive). `forceLinting()` alone doesn't do this
  // reliably (it's a no-op unless a lint run is already pending) — dispatch
  // `refreshCdnLint` first so the CDN editor's linter actually schedules one
  // for `forceLinting()` to then run immediately — see `cdn-lint.ts`'s doc.
  onSchemaChanged: () => {
    // Captured *before* update() below: while the Edit tab is active and
    // unfocused, renderBytesPane() (called from inside update()) syncs
    // hexEditEditor's own text from the *new* conversion's bytes — e.g. the
    // cpa999 fallback bytes a schema that just went away leaves behind, not
    // what the reader actually typed. Reading hexEditEditor's text only
    // *after* update() would already be reading that overwritten value,
    // silently replacing the reader's real input with it. So this is read
    // first, and used (not re-read) below regardless of what update() did
    // to the editor in between.
    const preservedHexText =
      mode === 'edit' ? hexEditEditor.state.doc.toString() : null;
    update(editor.state.doc.toString());
    editor.dispatch({ effects: refreshCdnLint.of(null) });
    forceLinting(editor);
    // The Edit tab's own hex → CDN conversion (bytesToCdnText, driven by
    // hexEditEditor's text, not the CDN editor's) has the same `e'...'`
    // annotation dependency but isn't reached by anything above — refresh
    // it too, immediately rather than through its usual debounce. Only
    // while it's the active tab: hexEditEditor's text is otherwise stale
    // (renderBytesPane() only keeps it in sync with `bytes` while it *is*
    // the active tab — see its own `mode === 'edit'` branch), so reconverting
    // it here regardless of `mode` could stomp the CDN editor with a
    // reconversion of hex the reader isn't even looking at anymore.
    if (preservedHexText !== null) {
      // Undo whatever update() above just did to hexEditEditor's own text
      // (see preservedHexText's own comment) before reconverting it — the
      // reader's real input, not a stale reflection of the old schema's
      // conversion result, is what the new schema state must be applied to.
      // Empty is a legitimate value of that input too (runHexEditConversion
      // has its own branch for it, clearing the CDN editor to match) — not
      // exempted here, or a reader who'd just cleared the field right
      // before toggling would see it silently repopulated instead.
      syncHexEditText(preservedHexText);
      runHexEditConversion(preservedHexText);
    }
  },
});

el('format-btn').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (text.trim() === '') return;
  try {
    // formatCdnText()'s own `cddlSchema` parameter validates and annotates
    // (a mismatch throws, caught below like any other formatting error)
    // while still respecting the `e'...'` checkbox — unlike the library's
    // own `cddl` option, which would register/annotate `e'...'`
    // unconditionally; see formatCdnText()'s own doc.
    const schema = activeCddlSchema();
    const opts = {
      ...readFormatOptions(),
      ...getEnabledExtensions(),
    };
    setEditorText(editor, formatCdnText(text, opts, schema));
  } catch {
    // Invalid CDN, or CDN that doesn't validate against an open CDDL
    // schema: the lint squiggle (or the CDDL pane's own status) already
    // explains the problem.
  }
});

el('copy-cdn').addEventListener('click', (e) => {
  void copyWithFeedback(
    e.currentTarget as HTMLElement,
    editor.state.doc.toString()
  );
});

// ── CDN text file import / export ────────────────────────────────────────────

const cdnImportInput = el<HTMLInputElement>('cdn-import-input');

function importCdnFile(file: File): void {
  file
    .text()
    .then((text) => {
      resetSamples();
      setEditorText(editor, text);
    })
    .catch((e: unknown) => {
      setStatus('error', e instanceof Error ? e.message : String(e));
    });
}

el('cdn-import-btn').addEventListener('click', () => cdnImportInput.click());

cdnImportInput.addEventListener('change', () => {
  const file = cdnImportInput.files?.[0];
  if (!file) return;
  cdnImportInput.value = '';
  importCdnFile(file);
});

initFileDrop(el('editor'), importCdnFile);

el('cdn-export-btn').addEventListener('click', () => {
  const text = editor.state.doc.toString().replace(/\r\n?|\n/g, '\r\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'data.cdn';
  a.click();
  URL.revokeObjectURL(url);
});

// ── CBOR file import ─────────────────────────────────────────────────────────

const importInput = el<HTMLInputElement>('import-input');

function importCborFile(file: File): void {
  file
    .arrayBuffer()
    .then((buf) => {
      const warnings: string[] = [];
      const items = [
        ...CBOR.fromCBORSeq(new Uint8Array(buf), {
          ...getEnabledExtensions(),
          strict: false,
          onWarning: (w) => warnings.push(w.message),
        }),
      ];
      const schema = activeCddlSchema();
      for (const item of items) annotateIfValid(item, schema);
      const cdn = items
        .map((item) => item.toCDN(readFormatOptions()))
        .join('\n');
      resetSamples();
      applyHexResult(cdn, warnings);
    })
    .catch((e: unknown) => {
      debouncedUpdate.cancel();
      conversion = { ok: false, error: e };
      renderBytesPane();
      updateCopyBytesBtn();
    });
}

el('import-btn').addEventListener('click', () => importInput.click());

importInput.addEventListener('change', () => {
  const file = importInput.files?.[0];
  if (!file) return;
  importInput.value = '';
  importCborFile(file);
});

[hexviewEl, jsViewEl, editWrapEl].forEach((target) =>
  initFileDrop(target, importCborFile)
);

// ── CBOR file export ─────────────────────────────────────────────────────────

el('export-btn').addEventListener('click', () => {
  if (!conversion.ok || conversion.empty) return;
  const isSeq = conversion.seqLength > 1;
  const blob = new Blob([conversion.bytes.buffer as ArrayBuffer], {
    type: isSeq ? 'application/cbor-seq' : 'application/cbor',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = isSeq ? 'data.cborseq' : 'data.cbor';
  a.click();
  URL.revokeObjectURL(url);
});

copyBytesBtn.addEventListener('click', (e) => {
  if (!conversion.ok || conversion.empty) return;
  let text: string;
  if (mode === 'annotated') {
    text =
      conversion.seqLength > 1
        ? conversion.binAsts.map((ast) => ast.toHexDump()).join('\n')
        : conversion.binAst.toHexDump();
  } else {
    text = bytesToHexString(conversion.bytes);
  }
  void copyWithFeedback(e.currentTarget as HTMLElement, text);
});

el('share-btn').addEventListener('click', (e) => {
  const hash = encodeShareHash({
    cdn: editor.state.doc.toString(),
    ...(cddlPane?.isOpen() ? { cddl: cddlPane.getText() } : {}),
  });
  history.replaceState(null, '', hash);
  void copyWithFeedback(e.currentTarget as HTMLElement, location.href);
});

el('copy-install').addEventListener('click', (e) => {
  void copyWithFeedback(
    e.currentTarget as HTMLElement,
    'npm install @cbortech/cbor'
  );
});

// Initial render.
update(initialText);
