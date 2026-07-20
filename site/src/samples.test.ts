/**
 * Every playground sample must carry a CDDL schema that its CDN instance
 * actually satisfies (the playground validates the pair live when the CDDL
 * pane is open). Parsing mirrors the playground's default extension set:
 * the bundled extensions plus the extra ones it enables by default
 * (`b32` / `h32` / `same` / `hash`).
 */
import { describe, expect, test } from 'vitest';
import { SAMPLES } from './samples';
import { CBOR, b32, h32, same, type CborExtension } from '../../src/index';
import { CDDL } from '../../src/cddl/index';
import { hash } from '@cbortech/hash-extension';

// `hash`'s own declaration file resolves `@cbortech/cbor` types through
// node_modules (a self-symlink to this repo's *built* dist), which are
// nominally distinct from the local `src` classes used everywhere else in
// this test — hence the cast, scoped to this one value.
const parseOptions = {
  extensions: [b32, h32, same, hash as CborExtension],
  silent: true,
};

describe('playground samples', () => {
  for (const sample of SAMPLES) {
    test(`'${sample.name}' CDN matches its CDDL`, () => {
      const schema = CDDL.compile(sample.cddl);
      const items = [...CBOR.fromCDNSeq(sample.cdn, parseOptions)];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        const result = schema.validate(item);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      }
    });
  }

  test('sample names are unique', () => {
    const names = SAMPLES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
