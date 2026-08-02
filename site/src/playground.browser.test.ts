/**
 * Playground UI smoke tests: boot the real index.html + main.ts in an
 * actual browser DOM (vitest browser mode, not jsdom — CodeMirror needs a
 * real layout engine) and drive every pane's toolbar the way a user would:
 * clicks, file uploads, drag & drop, popovers.
 *
 * The app (main.ts) wires everything as top-level side effects on import,
 * so it is booted exactly once for the whole file (`beforeAll`) and the
 * tests below run in sequence against that single, persistent session —
 * the same shape as a real playground visit, not independent unit tests.
 */
/// <reference types="vite/client" />
// The reference above is only for the root project's `tsc --noEmit` run
// (tsconfig.json), which typechecks this file directly but not main.ts —
// dynamically importing main.ts below pulls in its `./styles.css` side
// import, which needs vite/client's ambient `declare module '*.css'`.
// site/tsconfig.json already has this via its own `types` option.
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { page } from 'vitest/browser';
import { CBOR } from '@cbortech/cbor';
import { bytesToHexString } from './convert';
import { SAMPLES } from './samples';

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** Join a CodeMirror pane's rendered lines back into plain text. */
function cmText(hostId: string): string {
  const lines = byId(hostId).querySelectorAll('.cm-line');
  return [...lines].map((l) => l.textContent ?? '').join('\n');
}

/** Synthesize an OS-level file drop (real DataTransfer, not a file input). */
function dispatchDrop(target: Element, file: File): void {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  target.dispatchEvent(
    new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true })
  );
  target.dispatchEvent(
    new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true })
  );
}

/** Upload a File into a (possibly hidden) <input type=file> via real browser automation. */
async function uploadTo(inputId: string, file: File): Promise<void> {
  await page.elementLocator(byId(inputId)).upload(file);
}

/** Spy on the anchor-download pattern used by every Export button. */
function spyDownload(): { calls: { filename: string; blob: Blob }[] } {
  const calls: { filename: string; blob: Blob }[] = [];
  let lastBlob: Blob | null = null;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    lastBlob = blob as Blob;
    return 'blob:mock-url';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    calls.push({ filename: this.download, blob: lastBlob! });
  });
  return { calls };
}

describe('playground', () => {
  beforeAll(async () => {
    // navigator.clipboard.writeText needs document focus / permissions that
    // aren't reliably grantable in a headless test iframe; every copy
    // button funnels through this one method, so stub it once.
    vi.spyOn(Clipboard.prototype, 'writeText').mockResolvedValue(undefined);

    const html = await (await fetch('/index.html')).text();
    document.body.innerHTML = new DOMParser().parseFromString(
      html,
      'text/html'
    ).body.innerHTML;
    // main.ts wires up every element by id as a top-level side effect —
    // importing it boots the whole app against the DOM just injected.
    await import('./main');
    await vi.waitFor(() => {
      if (byId('editor').querySelectorAll('.cm-line').length === 0)
        throw new Error('CDN editor has not rendered yet');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clipboard spy is installed once in beforeAll; restoreAllMocks tears
    // it down too, so every test after the first would call the real API.
    vi.spyOn(Clipboard.prototype, 'writeText').mockResolvedValue(undefined);
  });

  describe('boot', () => {
    test('loads the default sample with the CDDL pane closed', () => {
      expect(cmText('editor')).toContain('"Image"');
      const paneCddl = document.querySelector('.pane-cddl')!;
      expect(paneCddl.hasAttribute('hidden')).toBe(true);
      expect(byId('cddl-toggle-btn').getAttribute('aria-pressed')).toBe(
        'false'
      );
    });

    test('renders CBOR bytes for the default sample', () => {
      expect(byId('byte-count').textContent).toMatch(/\d+ bytes?/);
      expect(
        byId('hexview').querySelectorAll('.hex-bytes').length
      ).toBeGreaterThan(0);
    });

    test('exposes playground navigation and live status regions', () => {
      const link = document.querySelector<HTMLAnchorElement>(
        '.hero-playground-link'
      )!;
      expect(link.getAttribute('href')).toBe('#playground');
      expect(byId('playground')).toBeTruthy();

      for (const id of ['cddl-status', 'bytes-status']) {
        const status = byId(id);
        expect(status.getAttribute('role')).toBe('status');
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.getAttribute('aria-atomic')).toBe('true');
      }
    });
  });

  describe('CDN pane', () => {
    test('Format + Compact/Pretty indent option reformats the text', () => {
      const prettyLines = cmText('editor').split('\n').length;
      expect(prettyLines).toBeGreaterThan(5);

      byId('format-opts-btn').click();
      byId<HTMLSelectElement>('opt-indent').value = '';
      byId('format-btn').click();
      expect(cmText('editor').split('\n').length).toBeLessThanOrEqual(2);

      byId('format-opts-btn').click();
      byId<HTMLSelectElement>('opt-indent').value = '2';
      byId('format-btn').click();
      expect(cmText('editor').split('\n').length).toBeGreaterThan(5);
    });

    test('Keep number spelling preserves original int/float literals', async () => {
      const importNums = () =>
        uploadTo(
          'cdn-import-input',
          new File(['{"a": 0xff, "b": 1.5_1}'], 'nums.cdn', {
            type: 'text/plain',
          })
        );

      // Default: "Keep number spelling" is on, so the literal spelling
      // survives Format.
      await importNums();
      await vi.waitFor(() => expect(cmText('editor')).toContain('0xff'));
      byId('format-opts-btn').click();
      byId<HTMLSelectElement>('opt-indent').value = '';
      expect(byId<HTMLInputElement>('opt-number-format').checked).toBe(true);
      byId('format-btn').click();
      expect(cmText('editor')).toBe('{"a":0xff,"b":1.5_1}');

      // Re-import (format-btn already reformatted the editor text above) and
      // reformat again with "Keep number spelling" disabled.
      await importNums();
      await vi.waitFor(() => expect(cmText('editor')).toContain('0xff'));
      byId<HTMLInputElement>('opt-number-format').checked = false;
      byId('format-btn').click();
      expect(cmText('editor')).toBe('{"a":255,"b":1.5}');
    });

    test('Keep byte strings preserves original byte string literal spelling', async () => {
      const importBytes = () =>
        uploadTo(
          'cdn-import-input',
          new File(["h'48656c6c6f'"], 'bytes.cdn', { type: 'text/plain' })
        );

      // Default: "Keep byte strings" is on, so the literal spelling survives
      // Format instead of being rewritten to the printable-string form.
      await importBytes();
      await vi.waitFor(() => expect(cmText('editor')).toContain("h'"));
      byId('format-opts-btn').click();
      byId<HTMLSelectElement>('opt-indent').value = '';
      expect(byId<HTMLInputElement>('opt-byte-string').checked).toBe(true);
      byId('format-btn').click();
      expect(cmText('editor')).toBe("h'48656c6c6f'");

      await importBytes();
      await vi.waitFor(() => expect(cmText('editor')).toContain("h'"));
      byId<HTMLInputElement>('opt-byte-string').checked = false;
      byId('format-btn').click();
      expect(cmText('editor')).toBe("'Hello'");
    });

    test('Keep blank lines preserves a blank line between array entries', async () => {
      const importArray = () =>
        uploadTo(
          'cdn-import-input',
          new File(['[\n  1,\n  2,\n\n  3\n]'], 'blank-lines.cdn', {
            type: 'text/plain',
          })
        );

      // Default: "Keep blank lines" is on and indent defaults to 2 spaces,
      // so the blank line between 2 and 3 survives Format.
      await importArray();
      await vi.waitFor(() => expect(cmText('editor')).toContain('3'));
      byId('format-opts-btn').click();
      byId<HTMLSelectElement>('opt-indent').value = '2';
      expect(byId<HTMLInputElement>('opt-blank-lines').checked).toBe(true);
      byId('format-btn').click();
      expect(cmText('editor')).toBe('[\n  1,\n  2,\n\n  3\n]');

      // Off: with no blank line and no comments left to preserve, the flat
      // array collapses onto one line via the (default-on) "Inline leaf
      // containers" option.
      await importArray();
      await vi.waitFor(() => expect(cmText('editor')).toContain('3'));
      byId<HTMLInputElement>('opt-blank-lines').checked = false;
      byId('format-btn').click();
      expect(cmText('editor')).toBe('[1, 2, 3]');
      byId<HTMLInputElement>('opt-blank-lines').checked = true; // restore
    });

    test('Keep blank lines preserves a blank line between CBOR Sequence items', async () => {
      // Includes the blank line, unlike any formatted output this test
      // produces below — `waitFor` on this exact text (not just a
      // substring like "line", which the pre-import editor content already
      // has) proves the async file import actually landed before Format
      // runs, and specifically the version *with* the blank line.
      const raw = '{ "line": 1 }\n\n{ "line": 2 }';
      const importSeq = () =>
        uploadTo(
          'cdn-import-input',
          new File([raw], 'seq-blank-lines.cdn', { type: 'text/plain' })
        );

      // Each item is a single-entry map, which the (default-on) "Inline leaf
      // containers" option renders on one line regardless of indent; only
      // the blank line *between* the two Sequence items is under test here.
      await importSeq();
      await vi.waitFor(() => expect(cmText('editor')).toBe(raw));
      byId('format-opts-btn').click();
      expect(byId<HTMLInputElement>('opt-blank-lines').checked).toBe(true);
      byId('format-btn').click();
      expect(cmText('editor')).toBe('{"line": 1}\n\n{"line": 2}');

      await importSeq();
      await vi.waitFor(() => expect(cmText('editor')).toBe(raw));
      byId<HTMLInputElement>('opt-blank-lines').checked = false;
      byId('format-btn').click();
      expect(cmText('editor')).toBe('{"line": 1}\n{"line": 2}');
      byId<HTMLInputElement>('opt-blank-lines').checked = true; // restore
    });

    test('Compact indent ignores Keep blank lines between CBOR Sequence items', async () => {
      const raw = '{ "line": 1 }\n\n{ "line": 2 }';
      await uploadTo(
        'cdn-import-input',
        new File([raw], 'seq-blank-lines.cdn', { type: 'text/plain' })
      );
      // Waiting for the exact raw (blank-line-containing) text, not just a
      // substring like "line" that the pre-import editor content already
      // contains, confirms the async import landed before Format runs.
      await vi.waitFor(() => expect(cmText('editor')).toBe(raw));
      byId('format-opts-btn').click();
      expect(byId<HTMLInputElement>('opt-blank-lines').checked).toBe(true);
      byId<HTMLSelectElement>('opt-indent').value = ''; // Compact
      byId('format-btn').click();
      // Compact mode ignores Keep blank lines, same as it does for blank
      // lines inside a single item's own containers — the blank line
      // between the two Sequence items does not survive.
      expect(cmText('editor')).toBe('{"line":1}\n{"line":2}');
      byId<HTMLSelectElement>('opt-indent').value = '2'; // restore
    });

    test('individual preserve options open in their own submenu popover', () => {
      byId('format-opts-btn').click();
      const preserveBtn = byId<HTMLButtonElement>('preserve-opts-btn');
      const preservePopover = byId('preserve-popover');

      // Starts closed; the individual checkboxes live inside it.
      expect(preservePopover.hidden).toBe(true);
      expect(preserveBtn.getAttribute('aria-expanded')).toBe('false');
      expect(preservePopover.contains(byId('opt-comments'))).toBe(true);

      preserveBtn.click();
      expect(preservePopover.hidden).toBe(false);
      expect(preserveBtn.getAttribute('aria-expanded')).toBe('true');

      // Clicking a checkbox inside the submenu doesn't close it or the
      // parent format-popover.
      byId('opt-comments').click();
      expect(preservePopover.hidden).toBe(false);
      expect(byId('format-popover').hidden).toBe(false);
      byId('opt-comments').click(); // restore

      // Clicking fully outside closes both.
      byId('editor').click();
      expect(preservePopover.hidden).toBe(true);
      expect(byId('format-popover').hidden).toBe(true);
    });

    test('closing format-popover also force-closes the preserve submenu', () => {
      byId('format-opts-btn').click();
      byId<HTMLButtonElement>('preserve-opts-btn').click();
      expect(byId('preserve-popover').hidden).toBe(false);

      // Toggling format-popover closed stops propagation before it can
      // reach the submenu's own document-level close listener, so
      // initFormatPopover() force-closes it explicitly instead.
      byId('format-opts-btn').click();
      expect(byId('format-popover').hidden).toBe(true);
      expect(byId('preserve-popover').hidden).toBe(true);
      expect(
        byId<HTMLButtonElement>('preserve-opts-btn').getAttribute(
          'aria-expanded'
        )
      ).toBe('false');
    });

    test('Preserve everything toggles all "Keep …" checkboxes together', () => {
      byId('format-opts-btn').click();
      const master = byId<HTMLInputElement>('opt-preserve-all');
      const ids = [
        'opt-comments',
        'opt-blank-lines',
        'opt-concat',
        'opt-byte-string',
        'opt-raw-string',
        'opt-number-format',
        'opt-app-sequence',
      ] as const;

      // Normalize to a known all-checked state first: earlier tests in this
      // file may have left individual boxes unchecked (the DOM is shared
      // across tests — see beforeAll above).
      for (const id of ids) {
        const box = byId<HTMLInputElement>(id);
        if (!box.checked) box.click();
      }
      expect(master.checked).toBe(true);
      expect(master.indeterminate).toBe(false);

      // Unchecking the master unchecks every "Keep …" checkbox.
      master.click();
      expect(master.checked).toBe(false);
      for (const id of ids)
        expect(byId<HTMLInputElement>(id).checked).toBe(false);

      // Checking the master re-checks every one.
      master.click();
      expect(master.checked).toBe(true);
      for (const id of ids)
        expect(byId<HTMLInputElement>(id).checked).toBe(true);

      // Unchecking a single option makes the master indeterminate.
      byId<HTMLInputElement>('opt-comments').click();
      expect(master.checked).toBe(false);
      expect(master.indeterminate).toBe(true);

      // Re-checking it makes the master fully checked again.
      byId<HTMLInputElement>('opt-comments').click();
      expect(master.checked).toBe(true);
      expect(master.indeterminate).toBe(false);
    });

    test('Copy button copies the CDN text to the clipboard', () => {
      const spy = vi.spyOn(Clipboard.prototype, 'writeText');
      byId('copy-cdn').click();
      expect(spy).toHaveBeenCalledWith(cmText('editor'));
    });

    test('Import replaces the editor text and resets the samples dropdown', async () => {
      byId<HTMLSelectElement>('samples').selectedIndex = 1;
      const file = new File(['{"greeting": "hi from import"}'], 'data.cdn', {
        type: 'text/plain',
      });
      await uploadTo('cdn-import-input', file);
      await vi.waitFor(
        () => expect(cmText('editor')).toContain('hi from import'),
        { timeout: 2000 }
      );
      expect(byId<HTMLSelectElement>('samples').selectedIndex).toBe(0);
    });

    test('Drag & drop a file onto the editor also imports it', async () => {
      const editorHost = byId('editor');
      const file = new File(['"dropped via drag and drop"'], 'dnd.cdn', {
        type: 'text/plain',
      });
      dispatchDrop(editorHost, file);
      await vi.waitFor(() =>
        expect(cmText('editor')).toContain('dropped via drag and drop')
      );
    });

    test('Export downloads a .cdn file with CRLF line endings', async () => {
      const dl = spyDownload();
      byId('cdn-export-btn').click();
      expect(dl.calls).toHaveLength(1);
      expect(dl.calls[0]!.filename).toBe('data.cdn');
      const text = await dl.calls[0]!.blob.text();
      expect(text).toBe(cmText('editor').replace(/\r\n?|\n/g, '\r\n'));
    });

    test('Share copies a #cdn= link that decodes back to the current text', () => {
      const spy = vi.spyOn(Clipboard.prototype, 'writeText');
      byId('share-btn').click();
      expect(location.hash).toMatch(/^#cdn=/);
      expect(spy).toHaveBeenCalledWith(location.href);
    });

    test('Extensions popover opens, locks built-ins, and persists a toggle', () => {
      const popover = byId('ext-popover');
      expect(popover.hidden).toBe(true);
      byId('ext-opts-btn').click();
      expect(popover.hidden).toBe(false);

      // Only the two static entries (h, b64 — core CDN syntax) are locked;
      // the rest of the "Built-in" group (dt, ip, cri, …) is togglable via
      // builtinExtensions, same as the "Additional" group.
      const builtinGroup = byId('ext-popover-builtin');
      const lockedChecks = builtinGroup.querySelectorAll(
        'input[type=checkbox][disabled]'
      );
      expect(lockedChecks.length).toBe(2);
      lockedChecks.forEach((c) =>
        expect((c as HTMLInputElement).checked).toBe(true)
      );
      expect(
        builtinGroup.querySelectorAll('input[type=checkbox]:not([disabled])')
          .length
      ).toBeGreaterThan(0);

      const hashCheckbox = byId<HTMLInputElement>('ext-hash');
      expect(hashCheckbox.checked).toBe(true);
      hashCheckbox.click();
      expect(hashCheckbox.checked).toBe(false);

      // Outside click closes the popover; state survives the close.
      document.body.click();
      expect(popover.hidden).toBe(true);
      byId('ext-opts-btn').click();
      expect(byId<HTMLInputElement>('ext-hash').checked).toBe(false);

      // Restore default state for later tests.
      byId<HTMLInputElement>('ext-hash').click();
      document.body.click();
    });
  });

  describe('CBOR pane', () => {
    // Earlier CDN-pane tests leave arbitrary content loaded (imports,
    // drag & drop); reload the default sample — a map, which several
    // assertions below depend on — before each test, back on Annotated.
    beforeEach(async () => {
      byId<HTMLSelectElement>('samples').value = SAMPLES[0]!.name;
      byId<HTMLSelectElement>('samples').dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(cmText('editor')).toBe(SAMPLES[0]!.cdn));
      document
        .querySelector<HTMLButtonElement>(
          '.mode-tabs .tab[data-mode=annotated]'
        )!
        .click();
    });

    test('mode tabs switch the visible view', () => {
      const tabs =
        document.querySelectorAll<HTMLButtonElement>('.mode-tabs .tab');
      const byMode = (mode: string) =>
        [...tabs].find((t) => t.dataset.mode === mode)!;

      expect(byMode('annotated').getAttribute('aria-selected')).toBe('true');
      expect(byMode('annotated').tabIndex).toBe(0);
      expect(byMode('plain').getAttribute('aria-selected')).toBe('false');
      expect(byMode('plain').tabIndex).toBe(-1);

      // The tab labeled "Hex" is the `plain` mode; hexview stays visible
      // for both `annotated` and `plain` (renderBytesPane switches its
      // rendering, not its visibility, between the two).
      byMode('annotated').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
      );
      expect(byId('hexview').hidden).toBe(false);
      expect(byId('js-view').hidden).toBe(true);
      expect(byMode('plain').classList.contains('is-active')).toBe(true);
      expect(byMode('plain').getAttribute('aria-selected')).toBe('true');
      expect(byMode('plain').tabIndex).toBe(0);
      expect(byMode('annotated').getAttribute('aria-selected')).toBe('false');
      expect(byMode('annotated').tabIndex).toBe(-1);

      byMode('js').click();
      expect(byId('js-view').hidden).toBe(false);
      expect(byId('hexview').hidden).toBe(true);
      expect(byMode('js').getAttribute('aria-selected')).toBe('true');

      byMode('edit').click();
      expect(byId('bytes-edit-wrap').hidden).toBe(false);
      expect(byId('copy-bytes').hasAttribute('disabled')).toBe(true);

      byMode('annotated').click();
      expect(byId('hexview').hidden).toBe(false);
      expect(byId('copy-bytes').hasAttribute('disabled')).toBe(false);
    });

    test('Copy bytes copies the annotated hex dump', () => {
      const spy = vi.spyOn(Clipboard.prototype, 'writeText');
      byId('copy-bytes').click();
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0]![0]).toContain('Map of length');
    });

    test('Import decodes a .cbor file into the CDN editor', async () => {
      const bytes = CBOR.encode({ imported: true, n: 7 });
      const file = new File([bytes.buffer as ArrayBuffer], 'data.cbor', {
        type: 'application/cbor',
      });
      await uploadTo('import-input', file);
      await vi.waitFor(() => expect(cmText('editor')).toContain('imported'), {
        timeout: 2000,
      });
      expect(cmText('editor')).toContain('true');
      await vi.waitFor(() =>
        expect(byId('byte-count').textContent).toMatch(
          new RegExp(`${bytes.length} bytes?`)
        )
      );
    });

    test('Drag & drop a .cbor file onto the hex view also imports it', async () => {
      const bytes = CBOR.encode('dropped bytes');
      const file = new File([bytes.buffer as ArrayBuffer], 'dnd.cbor', {
        type: 'application/cbor',
      });
      dispatchDrop(byId('hexview'), file);
      await vi.waitFor(() =>
        expect(cmText('editor')).toContain('dropped bytes')
      );
    });

    test('Export downloads a .cbor file matching the displayed byte count', () => {
      const dl = spyDownload();
      byId('export-btn').click();
      expect(dl.calls).toHaveLength(1);
      expect(dl.calls[0]!.filename).toBe('data.cbor');
      const displayed = byId('byte-count').textContent!;
      const expectedLength = Number(/(\d+) bytes?/.exec(displayed)![1]);
      expect(dl.calls[0]!.blob.size).toBe(expectedLength);
    });

    test('Edit mode decodes a typed hex dump back into CDN', async () => {
      document
        .querySelector<HTMLButtonElement>('.mode-tabs .tab[data-mode=edit]')!
        .click();
      const hex = bytesToHexString(CBOR.encode({ fromHex: 1 }));
      const textarea = byId<HTMLTextAreaElement>('bytes-edit');
      textarea.value = hex;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(cmText('editor')).toContain('fromHex'), {
        timeout: 2000,
      });
      document
        .querySelector<HTMLButtonElement>(
          '.mode-tabs .tab[data-mode=annotated]'
        )!
        .click();
    });

    test('Edit mode honors the CDN format options (inline leaf containers, Compact indent)', async () => {
      document
        .querySelector<HTMLButtonElement>('.mode-tabs .tab[data-mode=edit]')!
        .click();
      const textarea = byId<HTMLTextAreaElement>('bytes-edit');
      const hex = '84 18 74 19 03 af 18 ea 19 97 89';

      // A prior failed run of this test can leave opt-indent at Compact;
      // force the known starting state instead of assuming it.
      byId<HTMLSelectElement>('opt-indent').value = '2';

      // Default options have "Inline leaf containers" checked, so a flat
      // array of scalars decoded from pasted bytes must stay on one line.
      // (The default sample's "IDs" field already contains this same array,
      // so wait for the exact single-line replacement rather than a substring
      // match, which the stale pre-conversion text would also satisfy.)
      textarea.value = hex;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(
        () => expect(cmText('editor')).toBe('[116, 943, 234, 38793]'),
        { timeout: 2000 }
      );

      // Compact indent must also flow through to the bytes → CDN conversion.
      byId('format-opts-btn').click();
      byId<HTMLSelectElement>('opt-indent').value = '';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(
        () => expect(cmText('editor')).toBe('[116,943,234,38793]'),
        { timeout: 2000 }
      );

      byId<HTMLSelectElement>('opt-indent').value = '2';
      byId('format-opts-btn').click();
      document
        .querySelector<HTMLButtonElement>(
          '.mode-tabs .tab[data-mode=annotated]'
        )!
        .click();
    });
  });

  describe('CDDL pane', () => {
    test('the toggle switch opens the pane and validates the matching sample', async () => {
      const toggle = byId('cddl-toggle-btn');
      const pane = document.querySelector('.pane-cddl')!;
      // A prior test may have left non-default CDN loaded; the default
      // sample is what the initial CDDL schema was written to match.
      byId<HTMLSelectElement>('samples').value = SAMPLES[0]!.name;
      byId<HTMLSelectElement>('samples').dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(cmText('editor')).toBe(SAMPLES[0]!.cdn));

      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      toggle.click();
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(pane.hasAttribute('hidden')).toBe(false);
      // Toggling reflects into the URL, so reloading/copying it reproduces
      // the pane state.
      expect(new URLSearchParams(location.search).get('cddl')).toBe('1');

      const status = byId('cddl-status');
      expect(status.hidden).toBe(false);
      expect(status.className).toContain('ok');
      expect(status.textContent).toContain('valid');
    });

    test('Format + Compact/Pretty indent option reformats the schema', () => {
      const prettyLines = cmText('cddl-editor').split('\n').length;
      expect(prettyLines).toBeGreaterThan(3);

      byId('cddl-format-opts-btn').click();
      byId<HTMLSelectElement>('cddl-opt-indent').value = '';
      byId('cddl-format-btn').click();
      const compactLines = cmText('cddl-editor').split('\n').length;
      expect(compactLines).toBeLessThan(prettyLines);

      byId('cddl-format-opts-btn').click();
      byId<HTMLSelectElement>('cddl-opt-indent').value = '2';
      byId('cddl-format-btn').click();
      // Not necessarily the exact original line count: an inline comment
      // on a group entry (e.g. "; tag 1 = epoch-based date/time") can be
      // hoisted differently across a compact/pretty round trip (see
      // src/cddl/writer.ts's module doc) — only the direction matters here.
      expect(cmText('cddl-editor').split('\n').length).toBeGreaterThan(
        compactLines
      );
    });

    test('Copy button copies the schema text to the clipboard', () => {
      const spy = vi.spyOn(Clipboard.prototype, 'writeText');
      byId('copy-cddl').click();
      expect(spy).toHaveBeenCalledWith(cmText('cddl-editor'));
    });

    test('Import loads a new schema, resets samples, and re-validates', async () => {
      byId<HTMLSelectElement>('samples').selectedIndex = 2;
      const file = new File(
        ['root = { name: tstr, ? age: uint }'],
        'schema.cddl',
        { type: 'text/plain' }
      );
      await uploadTo('cddl-import-input', file);
      await vi.waitFor(
        () => expect(cmText('cddl-editor')).toContain('root ='),
        { timeout: 2000 }
      );
      expect(byId<HTMLSelectElement>('samples').selectedIndex).toBe(0);
      // The default sample's CDN no longer satisfies this unrelated schema.
      const status = byId('cddl-status');
      expect(status.className).toContain('error');
    });

    test('Drag & drop a .cddl file onto the editor also imports it', async () => {
      const file = new File(['dropped-rule = tstr'], 'dnd.cddl', {
        type: 'text/plain',
      });
      dispatchDrop(byId('cddl-editor'), file);
      await vi.waitFor(() =>
        expect(cmText('cddl-editor')).toContain('dropped-rule')
      );
    });

    test('Export downloads a .cddl file with CRLF line endings', async () => {
      const dl = spyDownload();
      byId('cddl-export-btn').click();
      expect(dl.calls).toHaveLength(1);
      expect(dl.calls[0]!.filename).toBe('schema.cddl');
      const text = await dl.calls[0]!.blob.text();
      expect(text).toBe(cmText('cddl-editor').replace(/\r\n?|\n/g, '\r\n'));
    });

    test('the toggle switch closes the pane and clears the status', () => {
      const toggle = byId('cddl-toggle-btn');
      const pane = document.querySelector('.pane-cddl')!;
      toggle.click();
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(pane.hasAttribute('hidden')).toBe(true);
      expect(byId('cddl-status').hidden).toBe(true);
      expect(new URLSearchParams(location.search).get('cddl')).toBe('0');
    });
  });
});
