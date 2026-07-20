/**
 * Wiring for the static chrome: theme toggle, copy buttons, samples
 * dropdown, format-options popover, extensions popover, bytes-pane mode
 * tabs, and share links.
 */
import type {
  CborExtension,
  FromCDNOptions,
  ToCDNOptions,
} from '@cbortech/cbor';
import { SAMPLES, type Sample } from '../samples';
import { EXTENSION_ENTRIES } from '../extensions';

export type BytesMode = 'annotated' | 'plain' | 'js' | 'edit';

const THEME_KEY = 'cbor-site-theme';
const EXT_DISABLED_KEY = 'cbor-site-ext-disabled';
const copyFeedback = new WeakMap<
  HTMLElement,
  { html: string; timer: ReturnType<typeof setTimeout> }
>();

function createCheckIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm5 12 4 4L19 6');
  svg.appendChild(path);
  return svg;
}

export function initTheme(): void {
  const stored = localStorage.getItem(THEME_KEY);
  const theme =
    stored ??
    (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  document.getElementById('theme-toggle')!.addEventListener('click', () => {
    const next =
      document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  });
}

/** Copy text and flash a ✓ on the trigger button. */
export async function copyWithFeedback(
  button: HTMLElement,
  text: string
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const active = copyFeedback.get(button);
    if (active) clearTimeout(active.timer);
    const html = active?.html ?? button.innerHTML;
    button.replaceChildren(createCheckIcon());
    const timer = setTimeout(() => {
      button.innerHTML = html;
      copyFeedback.delete(button);
    }, 1200);
    copyFeedback.set(button, { html, timer });
  } catch {
    // Clipboard unavailable (permissions); nothing sensible to do.
  }
}

/** Accept files dropped onto `target`, with a visual drop-zone cue. */
export function initFileDrop(
  target: HTMLElement,
  onFile: (file: File) => void
): void {
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

export function initSamples(onSelect: (sample: Sample) => void): () => void {
  const select = document.getElementById('samples') as HTMLSelectElement;
  for (const sample of SAMPLES) {
    const option = document.createElement('option');
    option.value = sample.name;
    option.textContent = sample.name;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    const sample = SAMPLES.find((s) => s.name === select.value);
    if (sample) onSelect(sample);
  });
  return () => {
    select.selectedIndex = 0;
  };
}

/** Wire a toolbar icon button to show/hide its popover, closing on outside click. */
export function wirePopoverToggle(buttonId: string, popoverId: string): void {
  const button = document.getElementById(buttonId)!;
  const popover = document.getElementById(popoverId)!;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = popover.hidden;
    popover.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
  popover.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  });
}

/**
 * Checkboxes for layout-dependent `ToCDNOptions` that the library ignores in
 * single-line output (Indent: Compact); they are greyed out to make that
 * visible. `opt-raw-string` is deliberately excluded: single-line raw
 * spellings are still kept in compact mode, only multi-line ones fall back.
 */
const LAYOUT_OPTION_IDS = [
  'opt-split-newline',
  'opt-split-cdn',
  'opt-inline-leaf',
  'opt-comments',
  'opt-concat',
] as const;

export function initFormatPopover(): void {
  wirePopoverToggle('format-opts-btn', 'format-popover');
  const indentSelect = document.getElementById(
    'opt-indent'
  ) as HTMLSelectElement;
  const syncLayoutOptions = () => {
    const compact = indentSelect.value === '';
    for (const id of LAYOUT_OPTION_IDS) {
      (document.getElementById(id) as HTMLInputElement).disabled = compact;
    }
  };
  indentSelect.addEventListener('change', syncLayoutOptions);
  syncLayoutOptions();
}

export function readFormatOptions(): FromCDNOptions & ToCDNOptions {
  const sel = (id: string) =>
    (document.getElementById(id) as HTMLSelectElement).value;
  const indentRaw = sel('opt-indent');
  const options: FromCDNOptions & ToCDNOptions = {
    commas: sel('opt-commas') as ToCDNOptions['commas'],
    intFormat: sel('opt-int') as ToCDNOptions['intFormat'],
    floatFormat: sel('opt-float') as ToCDNOptions['floatFormat'],
    bstrEncoding: sel('opt-bstr') as ToCDNOptions['bstrEncoding'],
  };
  if (indentRaw !== '')
    options.indent = indentRaw === 'tab' ? '\t' : Number(indentRaw);
  const encInd = sel('opt-enc-ind') as ToCDNOptions['encodingIndicators'];
  if (encInd !== 'auto') options.encodingIndicators = encInd;
  if (
    (document.getElementById('opt-split-newline') as HTMLInputElement).checked
  )
    options.splitNewline = true;
  if ((document.getElementById('opt-split-cdn') as HTMLInputElement).checked)
    options.splitCdn = true;
  if ((document.getElementById('opt-inline-leaf') as HTMLInputElement).checked)
    options.inlineLeafContainers = true;
  if ((document.getElementById('opt-comments') as HTMLInputElement).checked)
    options.preserveComments = true;
  if ((document.getElementById('opt-concat') as HTMLInputElement).checked)
    options.preserveConcatenation = true;
  if ((document.getElementById('opt-raw-string') as HTMLInputElement).checked)
    options.preserveRawString = true;
  if (!(document.getElementById('opt-app-strings') as HTMLInputElement).checked)
    options.appStrings = false;
  return options;
}

// ── Extensions popover ───────────────────────────────────────────────────────

function extCheckboxId(key: string): string {
  return `ext-${key}`;
}

function loadDisabledExtKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(EXT_DISABLED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveDisabledExtKeys(disabled: Set<string>): void {
  localStorage.setItem(EXT_DISABLED_KEY, JSON.stringify([...disabled]));
}

/**
 * Populate the built-in / additional extension checkbox groups from
 * `EXTENSION_ENTRIES`, restore persisted on/off state (default: all on),
 * and call `onChange` whenever a checkbox is toggled.
 */
export function initExtensionsPopover(onChange: () => void): void {
  wirePopoverToggle('ext-opts-btn', 'ext-popover');
  const builtinGroup = document.getElementById('ext-popover-builtin')!;
  const extraGroup = document.getElementById('ext-popover-extra')!;
  const disabled = loadDisabledExtKeys();

  for (const entry of EXTENSION_ENTRIES) {
    const label = document.createElement('label');
    label.className = 'check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = extCheckboxId(entry.key);
    checkbox.checked = !disabled.has(entry.key);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) disabled.delete(entry.key);
      else disabled.add(entry.key);
      saveDisabledExtKeys(disabled);
      onChange();
    });
    label.append(checkbox, ` ${entry.label}`);
    (entry.kind === 'builtin' ? builtinGroup : extraGroup).appendChild(label);
  }
}

/**
 * Read the current extensions popover checkbox state into the two option
 * arrays consumed by `fromCDN`/`fromCBOR`/`fromHexDump`: bundled extensions
 * that were unchecked go through `builtinExtensions` (an explicit subset of
 * the default set), and non-bundled ones that were checked go through
 * `extensions` as usual.
 */
export function getEnabledExtensions(): {
  extensions: CborExtension[];
  builtinExtensions: CborExtension[];
} {
  const extensions: CborExtension[] = [];
  const builtinExtensions: CborExtension[] = [];
  for (const entry of EXTENSION_ENTRIES) {
    const checkbox = document.getElementById(
      extCheckboxId(entry.key)
    ) as HTMLInputElement | null;
    if (checkbox && !checkbox.checked) continue;
    if (entry.kind === 'builtin') builtinExtensions.push(entry.ext);
    else extensions.push(entry.ext);
  }
  return { extensions, builtinExtensions };
}

export function initModeTabs(onChange: (mode: BytesMode) => void): void {
  const tabs = [
    ...document.querySelectorAll<HTMLButtonElement>('.mode-tabs .tab'),
  ];

  const selectTab = (selected: HTMLButtonElement): void => {
    tabs.forEach((tab) => {
      const active = tab === selected;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    onChange(selected.dataset.mode as BytesMode);
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      let nextIndex: number | undefined;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft')
        nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === undefined) return;

      event.preventDefault();
      const nextTab = tabs[nextIndex];
      nextTab.focus();
      selectTab(nextTab);
    });
  });
}

// ── Share-link fragment codec ────────────────────────────────────────────────

export interface ShareState {
  cdn: string;
  /** CDDL schema text; present when the CDDL pane is open and non-empty. */
  cddl?: string;
}

function encodeB64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeB64url(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function encodeShareHash(state: ShareState): string {
  let hash = `#cdn=${encodeB64url(state.cdn)}`;
  if (state.cddl !== undefined && state.cddl.trim() !== '')
    hash += `&cddl=${encodeB64url(state.cddl)}`;
  return hash;
}

/** Decode `#cdn=…` (legacy) or `#cdn=…&cddl=…` share fragments. */
export function decodeShareHash(hash: string): ShareState | null {
  const match = /^#cdn=([A-Za-z0-9_-]*)(?:&cddl=([A-Za-z0-9_-]+))?$/.exec(hash);
  if (!match) return null;
  try {
    const cdn = decodeB64url(match[1]!);
    return match[2] !== undefined
      ? { cdn, cddl: decodeB64url(match[2]) }
      : { cdn };
  } catch {
    return null;
  }
}

/**
 * Explicit override for whether the CDDL pane should be open on load, from
 * a `?cddl=` query parameter (e.g. `?cddl=1`, `?cddl=off`). Takes precedence
 * over the share-hash heuristic (schema present in the hash → open).
 * Returns `undefined` when the parameter is absent or unrecognized, so the
 * caller can fall back to that heuristic.
 */
export function readCddlOpenParam(search: string): boolean | undefined {
  const value = new URLSearchParams(search).get('cddl');
  if (value === null) return undefined;
  if (/^(1|true|on)$/i.test(value)) return true;
  if (/^(0|false|off)$/i.test(value)) return false;
  return undefined;
}

/**
 * Reflect the CDDL pane's open/closed state into the `?cddl=` query
 * parameter, so reloading or copying the URL reproduces it. Uses
 * `replaceState` (no new history entry per toggle) and preserves the
 * share-hash fragment and any other query parameters.
 */
export function writeCddlOpenParam(open: boolean): void {
  const url = new URL(location.href);
  url.searchParams.set('cddl', open ? '1' : '0');
  history.replaceState(null, '', url);
}
