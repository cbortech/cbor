/**
 * Wiring for the static chrome: theme toggle, copy buttons, samples
 * dropdown, format-options popover, bytes-pane mode tabs, and share links.
 */
import type { FromCDNOptions, ToCDNOptions } from '@cbortech/cbor';
import { SAMPLES } from '../samples';

export type BytesMode = 'annotated' | 'plain' | 'js' | 'edit';

const THEME_KEY = 'cbor-site-theme';
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

export function initFormatPopover(): void {
  const button = document.getElementById('format-opts-btn')!;
  const popover = document.getElementById('format-popover')!;
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
  const tsfmt = sel('opt-tsfmt');
  if (tsfmt !== '')
    options.textStringFormat = tsfmt.split(
      ','
    ) as ToCDNOptions['textStringFormat'];
  if ((document.getElementById('opt-comments') as HTMLInputElement).checked)
    options.preserveComments = true;
  return options;
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
