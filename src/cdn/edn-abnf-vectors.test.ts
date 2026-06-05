/**
 * Integration tests against the cabo/edn-abnf test corpus.
 *
 * CSV files live in src/cdn/test-vectors/edn-abnf/ and are NOT committed to
 * this repository.  See that directory's README for download instructions.
 *
 * op = "x": fromCDN(input).toCBOR() hex must equal output
 * op = "=": fromCDN(input).toCBOR() must equal fromCDN(output).toCBOR()
 * op = "-": No output: fromCDN(input) must throw.
 *           With output (CDN): fromCDN(input).toCBOR() must differ from fromCDN(output).toCBOR()
 *           (parse failure of the input also satisfies the assertion).
 *
 * Node-only (readFileSync) — excluded from the browser test run.
 * Run with: npm run test:edn-abnf
 */

import { describe } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { registerTests } from './test-vectors/runner';

const VECTORS_DIR = resolve(import.meta.dirname, 'test-vectors/edn-abnf');

// ─── Known differences ────────────────────────────────────────────────────────

/**
 * Corpus conflict: `\\` in single-quoted byte strings
 *
 * edn-abnf encodes "`'foo\\bar'` is invalid" as a negative assertion
 * `'foo\\bar' ≠ 'foo\\bar'` (same expression on both sides — valid input
 * would produce equal bytes and fail; invalid input would throw and trivially
 * pass).  However, draft-25 §5.1 escapable1 includes `\` (0x5C), so `\\` is
 * a valid escape in single-quoted strings.  We follow draft-25 and skip this
 * assertion.
 */
// For "-" with output, knownSkip is keyed by rawInput alone — NOT "input ≠ output".
// For "=" and "x", the key includes the output (e.g. "input = output" / "input → hex").
const BASIC_SKIP = new Map<string, string>([
  // "-" op key = rawInput only
  [
    "'foo\\\\bar'",
    "corpus conflict: draft-25 §5.1 escapable1 includes \\\\ — 'foo\\\\bar' is valid",
  ],
]);

// ─── Test runner ──────────────────────────────────────────────────────────────

function runVectors(filename: string, knownSkip: Map<string, string>): void {
  const text = readFileSync(resolve(VECTORS_DIR, filename), 'utf-8');
  describe(filename.replace('.csv', ''), () => {
    registerTests(text, knownSkip);
  });
}

describe('EDN test vectors (cabo/edn-abnf)', () => {
  runVectors('level-shifter.csv', new Map());
  runVectors('basic.csv', BASIC_SKIP);
});
