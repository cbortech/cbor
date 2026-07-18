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
import { SAMPLES } from '../samples';
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

export function initSamples(onSelect: (cdn: string) => void): () => void {
  const select = document.getElementById('samples') as HTMLSelectElement;
  for (const sample of SAMPLES) {
    const option = document.createElement('option');
    option.value = sample.name;
    option.textContent = sample.name;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    const sample = SAMPLES.find((s) => s.name === select.value);
    if (sample) onSelect(sample.cdn);
  });
  return () => {
    select.selectedIndex = 0;
  };
}

/** Wire a toolbar icon button to show/hide its popover, closing on outside click. */
function wirePopoverToggle(buttonId: string, popoverId: string): void {
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

export function initFormatPopover(): void {
  wirePopoverToggle('format-opts-btn', 'format-popover');
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
  const tabs = document.querySelectorAll<HTMLButtonElement>('.mode-tabs .tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('is-active', t === tab));
      onChange(tab.dataset.mode as BytesMode);
    });
  });
}

// ── Share-link fragment codec ────────────────────────────────────────────────

export function encodeShareHash(cdnText: string): string {
  const bytes = new TextEncoder().encode(cdnText);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `#cdn=${b64}`;
}

export function decodeShareHash(hash: string): string | null {
  const match = /^#cdn=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) return null;
  try {
    const b64 = match[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
