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
 * Corpus conflicts with hildjj/edn-test-vectors
 *
 * edn-abnf says `\\` and `\/` in single-quoted byte strings are invalid,
 * while hildjj/edn-test-vectors says they produce the same bytes as `\\` →
 * `\` and `\/` → `/`.  We follow hildjj here and skip the conflicting
 * edn-abnf assertions.  Note: `\u{5C}` is U+005C (backslash), so
 * `'foo\u{5C}bar'` = `'foo\\bar'` in hildjj but `'foo\\bar'` is invalid in
 * edn-abnf.
 *
 * Invalid surrogate pairs in hex-string comments
 *
 * `h'AA#foo\ud83eሴfoo'` uses an invalid surrogate pair inside a `#`
 * comment in a hex literal.  Validating surrogate correctness inside hex
 * comments is not yet implemented.
 */

// For "-" with output, knownSkip is keyed by rawInput alone (not "input ≠ output").
// For "=" and "x", the key includes the output (e.g. "input = output").
const BASIC_SKIP = new Map<string, string>([
  // \\ corpus conflict
  ["'foo\\\\bar'", "corpus conflict: hildjj accepts \\\\ → \\ in '...'"],
  // \u{5C} = backslash: hildjj says 'foo\u{5C}bar' = 'foo\\bar', edn-abnf says ≠
  [
    "'foo\\u{5C}bar'",
    'corpus conflict: hildjj accepts \\u{5C} and \\\\ producing same bytes',
  ],
  ["'foo\\u{5c}bar'", 'corpus conflict: same as \\u{5C}'],
  ["'foo\\u{05c}bar'", 'corpus conflict: same as \\u{5C}'],
  ["'foo\\u{005c}bar'", 'corpus conflict: same as \\u{5C}'],
  ["'foo\\u{0005c}bar'", 'corpus conflict: same as \\u{5C}'],
  ["'foo\\u{00000000000005c}bar'", 'corpus conflict: same as \\u{5C}'],
  ["'foo\\u005cbar'", 'corpus conflict: same as \\u{5C}'],
  ["'foo\\u005Cbar'", 'corpus conflict: same as \\u{5C}'],
  // \/ corpus conflict
  ["'foo\\/bar'", "corpus conflict: hildjj accepts \\/ → / in '...'"],
  // invalid surrogate pair in hex comment
  [
    "h'AA#foo\\ud83e\\u1234foo'",
    'surrogate pair validation in hex comments not yet implemented',
  ],
  [
    "h'AA#foo\\udd13\\ud83efoo'",
    'surrogate pair validation in hex comments not yet implemented',
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
