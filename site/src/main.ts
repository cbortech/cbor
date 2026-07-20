import './styles.css';
import { CBOR } from '@cbortech/cbor';
import { forceLinting } from '@codemirror/lint';
import {
  bytesToCdnText,
  bytesToHexString,
  convertCdn,
  type Conversion,
} from './convert';
import { createEditor, selectRange, setEditorText } from './editor/editor';
import { HexView } from './hexview/hexview';
import { rangeAtByte, rangeAtChar } from './mapping/lockstep';
import { inspectJS } from './js-preview';
import { DEFAULT_SAMPLE, SAMPLES } from './samples';
import { initCddlPane, type CddlPane } from './cddl-pane';
import {
  type BytesMode,
  copyWithFeedback,
  decodeShareHash,
  encodeShareHash,
  getEnabledExtensions,
  initExtensionsPopover,
  initFormatPopover,
  initModeTabs,
  initSamples,
  initTheme,
  readFormatOptions,
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
const editTextarea = el<HTMLTextAreaElement>('bytes-edit');
const statusEl = el<HTMLDivElement>('bytes-status');
const byteCountEl = el<HTMLSpanElement>('byte-count');
const exportBtnEl = el<HTMLButtonElement>('export-btn');

let mode: BytesMode = 'annotated';
let conversion: Conversion = { ok: true, empty: true };
// Warning message originating from hex/file CBOR input (not the CDN parse).
// Shown in the status bar when there are no CDN-conversion warnings.
let hexParseWarning: string | null = null;
// Set to true while setEditorText is called programmatically from hex input so
// that onDocChanged does not prematurely clear hexParseWarning.
let _programmaticEdit = false;

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
    if (document.activeElement !== editTextarea) editTextarea.value = '';
    return;
  }
  if (conversion.empty) {
    hexParseWarning = null;
    byteCountEl.textContent = '';
    exportBtnEl.title = 'Save as a .cbor file';
    hexView.renderEmpty('Type CDN on the left to see CBOR bytes.');
    jsViewEl.textContent = '';
    if (document.activeElement !== editTextarea) editTextarea.value = '';
    setStatus(null);
    return;
  }

  const { bytes, binAst, rows, warnings, seqLength, binAsts } = conversion;
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
    try {
      jsViewEl.textContent =
        seqLength > 1
          ? binAsts.map((ast) => inspectJS(ast.toJS())).join('\n─────\n')
          : inspectJS(binAst.toJS());
    } catch (e) {
      jsViewEl.textContent = e instanceof Error ? e.message : String(e);
    }
  } else if (mode === 'edit' && document.activeElement !== editTextarea) {
    editTextarea.value = bytesToHexString(bytes);
  }
}

const update = (text: string): void => {
  conversion = convertCdn(text);
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

const editor = createEditor(el('editor'), initialText, {
  onDocChanged(text) {
    if (!_programmaticEdit) hexParseWarning = null;
    if (text.trim() === '') resetSamples();
    debouncedUpdate(text);
  },
  onCursorMoved,
});

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

function initFileDrop(target: HTMLElement, onFile: (file: File) => void): void {
  const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  target.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    target.classList.add('is-file-dragover');
  });
  target.addEventListener('dragleave', (event) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !target.contains(next)) {
      target.classList.remove('is-file-dragover');
    }
  });
  target.addEventListener(
    'drop',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      target.classList.remove('is-file-dragover');
      const file = event.dataTransfer?.files[0];
      if (!file) return;
      onFile(file);
    },
    true
  );
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

editTextarea.addEventListener(
  'input',
  debounce(() => {
    const text = editTextarea.value;
    if (text.trim() === '') {
      setEditorText(editor, '');
      return;
    }
    try {
      const { cdn, warnings } = bytesToCdnText(text);
      applyHexResult(cdn, warnings);
    } catch (e) {
      debouncedUpdate.cancel();
      conversion = { ok: false, error: e };
      renderBytesPane();
      updateCopyBytesBtn();
    }
  }, 300)
);

// Pasting hex/dump text directly onto the rendered hex view also converts.
hexviewEl.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  try {
    const { cdn, warnings } = bytesToCdnText(text);
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
  // lint diagnostics to refresh immediately (no debounce).
  update(editor.state.doc.toString());
  forceLinting(editor);
});
resetSamples = initSamples((sample) => {
  // A sample is a CDN/CDDL pair: load both. The schema compiles right
  // away, but validation only runs while the CDDL pane is open. Convert
  // immediately (skipping the editor debounce) so the pane never shows
  // the previous sample's data validated against the new schema.
  cddlPane?.setText(sample.cddl);
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
  forceOpen: shared?.cddl !== undefined,
});

el('format-btn').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (text.trim() === '') return;
  try {
    const opts = { ...readFormatOptions(), ...getEnabledExtensions() };
    const items = [...CBOR.fromCDNSeq(text, opts)];
    setEditorText(editor, items.map((item) => item.toCDN(opts)).join('\n'));
  } catch {
    // Invalid CDN: the lint squiggle already explains the problem.
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
      const cdn = items.map((item) => item.toCDN({ indent: 2 })).join('\n');
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

const copyBytesBtn = el('copy-bytes');

function updateCopyBytesBtn(): void {
  const active = mode === 'annotated' || mode === 'plain';
  copyBytesBtn.toggleAttribute(
    'disabled',
    !active || !conversion.ok || conversion.empty
  );
}

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
