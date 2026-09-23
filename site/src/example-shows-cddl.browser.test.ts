/**
 * `Example.showsCddl` behavior: unlike `requiresCddl` (which always forces
 * the CDDL pane open, even overriding an earlier explicit close — see
 * eref-shared-boot.browser.test.ts and playground.browser.test.ts's own
 * "selecting an example that requires CDDL..." tests), `showsCddl` only opens
 * the pane while the reader hasn't made an explicit choice about it *at
 * all* yet this session (no `?cddl=` in the URL). Needs its own fresh boot
 * — `readCddlOpenParam(location.search)` must still be `undefined` at the
 * moment the example is selected, which no other test file's shared session
 * can guarantee once any of its own tests have touched the CDDL toggle.
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { EXAMPLES } from './examples';

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

describe('a showsCddl example, selected before the reader has touched the CDDL toggle', () => {
  beforeAll(async () => {
    vi.spyOn(Clipboard.prototype, 'writeText').mockResolvedValue(undefined);
    const html = await (await fetch('/index.html')).text();
    document.body.innerHTML = new DOMParser().parseFromString(
      html,
      'text/html'
    ).body.innerHTML;
    await import('./main');
    await vi.waitFor(() => {
      if (byId('editor').querySelectorAll('.cm-line').length === 0)
        throw new Error('CDN editor has not rendered yet');
    });
  });

  test('opens the pane, without persisting it to ?cddl=', () => {
    expect(new URLSearchParams(location.search).get('cddl')).toBeNull();
    expect(byId('cddl-toggle-btn').getAttribute('aria-pressed')).toBe('false');

    const example = EXAMPLES.find((s) => s.showsCddl);
    expect(example).toBeDefined();
    byId<HTMLSelectElement>('examples').value = example!.name;
    byId<HTMLSelectElement>('examples').dispatchEvent(new Event('change'));

    expect(byId('cddl-toggle-btn').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.pane-cddl')!.hasAttribute('hidden')).toBe(
      false
    );
    // showsCddl is a suggestion, not a decision made on the reader's
    // behalf — unlike requiresCddl, opening this way must not write ?cddl=.
    expect(new URLSearchParams(location.search).get('cddl')).toBeNull();
  });

  test("a reader's own explicit close is respected on every later showsCddl example", () => {
    // Explicit choice #1: close it themselves.
    byId('cddl-toggle-btn').click();
    expect(byId('cddl-toggle-btn').getAttribute('aria-pressed')).toBe('false');
    expect(new URLSearchParams(location.search).get('cddl')).toBe('0');

    // Browse elsewhere, then back to the same showsCddl example.
    byId<HTMLSelectElement>('examples').value = EXAMPLES[0]!.name;
    byId<HTMLSelectElement>('examples').dispatchEvent(new Event('change'));
    const example = EXAMPLES.find((s) => s.showsCddl)!;
    byId<HTMLSelectElement>('examples').value = example.name;
    byId<HTMLSelectElement>('examples').dispatchEvent(new Event('change'));

    // Stays closed — an explicit choice already exists this session.
    expect(byId('cddl-toggle-btn').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.pane-cddl')!.hasAttribute('hidden')).toBe(
      true
    );
  });
});
