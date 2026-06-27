import './styles.css';
import { CBOR } from '@cbortech/cbor';
import { SITE_EXTENSIONS } from './extensions';
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
import { DEFAULT_SAMPLE } from './samples';
import {
  type BytesMode,
  copyWithFeedback,
  decodeShareHash,
  encodeShareHash,
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
    setStatus('error', e instanceof Error ? e.message : String(e));
    hexView.renderEmpty('');
    jsViewEl.textContent = '';
    if (document.activeElement !== editTextarea) editTextarea.value = '';
    return;
  }
  if (conversion.empty) {
    hexParseWarning = null;
    byteCountEl.textContent = '';
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

const initialText = decodeShareHash(location.hash) ?? DEFAULT_SAMPLE;
let resetSamples = (): void => {};

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

const divider = el<HTMLDivElement>('pane-divider');
const playgroundEl = divider.parentElement!;
const cdnPane = playgroundEl.querySelector<HTMLElement>('.pane-cdn')!;
const bytesPane = playgroundEl.querySelector<HTMLElement>('.pane-bytes')!;

divider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  divider.classList.add('is-dragging');
  const startX = e.clientX;
  const startCdn = cdnPane.getBoundingClientRect().width;
  const startBytes = bytesPane.getBoundingClientRect().width;
  const total = startCdn + startBytes;

  const onMove = (ev: PointerEvent) => {
    const delta = ev.clientX - startX;
    const newCdn = Math.max(200, Math.min(total - 200, startCdn + delta));
    const ratio = newCdn / total;
    cdnPane.style.flex = `${ratio} 1 0`;
    bytesPane.style.flex = `${1 - ratio} 1 0`;
  };
  const onUp = () => {
    divider.classList.remove('is-dragging');
    divider.removeEventListener('pointermove', onMove);
    divider.removeEventListener('pointerup', onUp);
  };
  divider.addEventListener('pointermove', onMove);
  divider.addEventListener('pointerup', onUp);
});

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
resetSamples = initSamples((cdn) => setEditorText(editor, cdn));
initModeTabs((next) => {
  mode = next;
  renderBytesPane();
  updateCopyBytesBtn();
});

el('format-btn').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (text.trim() === '') return;
  try {
    const opts = { ...readFormatOptions(), extensions: SITE_EXTENSIONS };
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
          extensions: SITE_EXTENSIONS,
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
  const blob = new Blob([conversion.bytes.buffer as ArrayBuffer], {
    type: 'application/cbor',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'data.cbor';
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
  const hash = encodeShareHash(editor.state.doc.toString());
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
