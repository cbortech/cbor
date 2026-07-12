/**
 * Integration tests against the cabo/cddlc CDDL corpus.
 *
 * CDDL files live in src/cddl/test-vectors/cddlc/{data,test}/ and are NOT
 * committed to this repository. See that directory's README for download
 * instructions.
 *
 * Every corpus file must:
 *  - parse without a syntax error,
 *  - survive a format → re-parse round trip with an identical AST
 *    (modulo source offsets), and
 *  - compile with `strict: false` (standalone RFC modules may reference
 *    names defined elsewhere, so warnings are allowed; crashes are not).
 *
 * Node-only (readFileSync) — excluded from the default and browser test runs.
 * Run with: npm run test:cddl-corpus
 */

import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { CDDL, parseCDDL, PRELUDE_CDDL } from './index';

const VECTORS_DIR = resolve(import.meta.dirname, 'test-vectors/cddlc');

const listCddl = (subdir: string): string[] => {
  try {
    return readdirSync(resolve(VECTORS_DIR, subdir))
      .filter((f) => f.endsWith('.cddl'))
      .sort();
  } catch {
    return [];
  }
};

/** Deep-copy an AST value with `start`/`end` offsets removed. */
const stripPositions = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'start' || k === 'end') continue;
      out[k] = stripPositions(v);
    }
    return out;
  }
  return value;
};

for (const subdir of ['data', 'test']) {
  const files = listCddl(subdir);
  describe.skipIf(files.length === 0)(`cddlc corpus: ${subdir}/`, () => {
    test.each(files)('%s', (file) => {
      const text = readFileSync(resolve(VECTORS_DIR, subdir, file), 'utf-8');

      // 1. Parses.
      const { rules } = parseCDDL(text);
      expect(rules.length).toBeGreaterThan(0);

      // 2. Round-trips through the formatter.
      const schema = CDDL.compile(text, { strict: false });
      const reparsed = parseCDDL(schema.format()).rules;
      expect(stripPositions(reparsed)).toEqual(stripPositions(rules));

      // 3. No syntax-level surprises from compile: semantic warnings are
      //    expected for standalone RFC fragments and are only shape-checked.
      for (const w of schema.warnings ?? []) {
        expect(w.code, w.message).toBeTruthy();
        expect(w.message).toBeTruthy();
      }
    });
  });
}

describe.skipIf(listCddl('data').length === 0)('prelude cross-check', () => {
  test('embedded prelude matches cddlc data/prelude.cddl', () => {
    const upstream = readFileSync(
      resolve(VECTORS_DIR, 'data/prelude.cddl'),
      'utf-8'
    );
    const norm = (s: string): unknown => stripPositions(parseCDDL(s).rules);
    expect(norm(PRELUDE_CDDL)).toEqual(norm(upstream));
  });
});
