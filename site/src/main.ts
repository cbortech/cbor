import './styles.css';
import { CBOR } from '@cbortech/cbor';
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
    return;
  }
  if (conversion.empty) {
    byteCountEl.textContent = '';
    hexView.renderEmpty('Type CDN on the left to see CBOR bytes.');
    jsViewEl.textContent = '';
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

const editor = createEditor(el('editor'), initialText, {
  onDocChanged: debouncedUpdate,
  onCursorMoved,
});

// ── Bytes edit mode: hex / annotated dump → CDN ──────────────────────────────

editTextarea.addEventListener(
  'input',
  debounce(() => {
    const text = editTextarea.value;
    if (text.trim() === '') return;
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
initSamples((cdn) => setEditorText(editor, cdn));
initModeTabs((next) => {
  mode = next;
  renderBytesPane();
});

el('format-btn').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (text.trim() === '') return;
  try {
    setEditorText(editor, CBOR.format(text, readFormatOptions()));
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

el('copy-bytes').addEventListener('click', (e) => {
  if (!conversion.ok || conversion.empty) return;
  void copyWithFeedback(
    e.currentTarget as HTMLElement,
    bytesToHexString(conversion.bytes)
  );
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
