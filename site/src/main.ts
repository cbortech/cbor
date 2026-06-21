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

function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
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
    byteCountEl.textContent = '';
    hexView.renderEmpty('Type CDN on the left to see CBOR bytes.');
    jsViewEl.textContent = '';
    if (document.activeElement !== editTextarea) editTextarea.value = '';
    setStatus(null);
    return;
  }

  const { bytes, binAst, rows, warnings } = conversion;
  byteCountEl.textContent = `· ${bytes.length} byte${bytes.length === 1 ? '' : 's'}`;
  if (warnings.length > 0) {
    const first = warnings[0]!;
    setStatus(
      'warning',
      `${warnings.length} warning${warnings.length === 1 ? '' : 's'} — ${first.message}`
    );
  } else {
    setStatus(null);
  }

  if (mode === 'annotated' || mode === 'plain') {
    hexView.render(rows, bytes, mode);
  } else if (mode === 'js') {
    try {
      jsViewEl.textContent = inspectJS(binAst.toJS());
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
    if (text.trim() === '') resetSamples();
    debouncedUpdate(text);
  },
  onCursorMoved,
});

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
      setEditorText(editor, bytesToCdnText(text));
      setStatus(null);
    } catch (e) {
      setStatus('error', e instanceof Error ? e.message : String(e));
    }
  }, 300)
);

// Pasting hex/dump text directly onto the rendered hex view also converts.
hexviewEl.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  try {
    setEditorText(editor, bytesToCdnText(text));
  } catch (err) {
    setStatus('error', err instanceof Error ? err.message : String(err));
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
    setEditorText(
      editor,
      CBOR.format(text, { ...readFormatOptions(), extensions: SITE_EXTENSIONS })
    );
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
      const cdn = CBOR.fromCBOR(new Uint8Array(buf), {
        extensions: SITE_EXTENSIONS,
      }).toCDN({ indent: 2 });
      resetSamples();
      setEditorText(editor, cdn);
    })
    .catch((e: unknown) => {
      setStatus('error', e instanceof Error ? e.message : String(e));
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
  const text =
    mode === 'annotated'
      ? conversion.binAst.toHexDump()
      : bytesToHexString(conversion.bytes);
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
