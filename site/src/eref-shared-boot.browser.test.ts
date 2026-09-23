/**
 * Regression test for a real reported bug: opening a *shared link* whose
 * schema opens the CDDL pane on load (`initiallyOpen: true` — see
 * `main.ts`'s own `initCddlPane()` call) synchronously invokes `update()`
 * during `main.ts`'s own top-level module evaluation, via
 * `CddlPaneOptions.onSchemaChanged`'s `setOpen(true)` callback — *before*
 * later-declared module state (`copyBytesBtn`) existed, throwing a
 * `ReferenceError` ("Cannot access 'copyBytesBtn' before initialization")
 * that aborted the rest of module setup. `playground.browser.test.ts`'s own
 * shared `beforeAll` always boots with a plain, param-free URL, so it never
 * exercised this `initiallyOpen: true` path — hence the separate file (and
 * boot) here, with the URL set *before* importing `main.ts` the way a real
 * navigation to a shared link would already have it.
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { EXAMPLES } from './examples';
import { encodeShareHash } from './ui/toolbar';

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

describe('booting straight from a shared e-ref link', () => {
  beforeAll(async () => {
    const example = EXAMPLES.find((s) => s.requiresCddl)!;
    // Exactly what a real click on a shared link (built by main.ts's own
    // share-btn handler) lands the browser on — present *before* main.ts is
    // ever imported, as opposed to the example-selection flow (also
    // requiresCddl-driven, but from an already-running page, covered
    // separately in playground.browser.test.ts).
    const hash = encodeShareHash({ cdn: example.cdn, cddl: example.cddl });
    history.replaceState(null, '', hash);

    const html = await (await fetch('/index.html')).text();
    document.body.innerHTML = new DOMParser().parseFromString(
      html,
      'text/html'
    ).body.innerHTML;
    // The bug under test threw synchronously from this very import — an
    // uncaught error here fails `beforeAll` (and every test below) instead
    // of silently continuing, so no `expect` around the import itself is
    // needed for that half of the regression.
    await import('./main');
    await vi.waitFor(() => {
      if (byId('editor').querySelectorAll('.cm-line').length === 0)
        throw new Error('CDN editor has not rendered yet');
    });
  });

  test('loads without throwing, with the CDDL pane already open and bytes rendered', () => {
    expect(document.querySelector('.pane-cddl')!.hasAttribute('hidden')).toBe(
      false
    );
    expect(byId('cddl-toggle-btn').getAttribute('aria-pressed')).toBe('true');
    // The exact symptom: updateCopyBytesBtn() (called from the update() the
    // crash happened inside) never got to run, leaving this stale/wrong.
    expect(byId('byte-count').textContent).toMatch(/\d+ bytes?/);
    expect(byId<HTMLButtonElement>('copy-bytes').disabled).toBe(false);
  });
});
