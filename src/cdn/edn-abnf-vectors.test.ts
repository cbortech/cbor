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
import { float } from '../extensions/float';
import { same } from '../extensions/same';

const VECTORS_DIR = resolve(import.meta.dirname, 'test-vectors/edn-abnf');

const FLOAT_EXTENSIONS = [float, same];

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

/**
 * rawstrings.csv corpus differences
 *
 * The cabo/edn-abnf grammar (rawchars = 1*(%x0a/%x0d/%x20-5f/%x61-7e/NONASCII))
 * allows LF in raw-string content for any N.  The cabo runner's `-` (negative)
 * assertion handler does not verify that parse-succeds inputs actually throw;
 * it only errors when a parse-failure input produces output equal to `diag`.
 * For `-` tests with no output field the assertion is therefore vacuously true,
 * so these cases "pass" in the reference suite without actually being checked.
 *
 * Our runner does verify them (expect(() => parse(input)).toThrow()), so we
 * skip the three assertions whose grammar permits a valid result.
 *
 * 1#\<CRLF>2 = 1, 2: The cabo/edn-abnf runner uses a `seq` top-level that
 * allows comma-/newline-separated sequences of CBOR items ("1, 2" = two items).
 * Our parseCDN accepts exactly one item, so both sides throw.  Implementing
 * CBOR-sequence top-level is out of scope.
 */
const RAWSTRINGS_SKIP = new Map<string, string>([
  // "`\npoem\n`" — N=1, leading LF stripped, content "poem\n"; grammar allows
  // LF in rawchars for all N; cabo runner does not verify this negative case.
  [
    '`\npoem\n`',
    'grammar permits LF in N=1 raw strings; cabo runner does not verify this negative assertion',
  ],
  // "``\npoem``" — N=2, leading LF stripped, content "poem"; same situation.
  [
    '``\npoem``',
    'grammar permits N≥2 raw strings with leading newline and LF-free content; cabo runner does not verify',
  ],
  // "`leading backquote\npoem``" — N=1, content contains LF; same situation.
  [
    '`leading backquote\npoem``',
    'grammar permits LF in N=1 raw strings; cabo runner does not verify this negative assertion',
  ],
  // "1#\<CRLF>2 = 1, 2" — requires CBOR-sequence top-level.
  [
    '1#\\\r\n2 = 1, 2',
    'requires CBOR-sequence top-level support (parseCDN accepts exactly one item)',
  ],
]);

describe('EDN test vectors (cabo/edn-abnf)', () => {
  runVectors('level-shifter.csv', new Map());
  runVectors('basic.csv', BASIC_SKIP);
  describe('float', () => {
    const text = readFileSync(resolve(VECTORS_DIR, 'float.csv'), 'utf-8');
    registerTests(text, new Map(), true, FLOAT_EXTENSIONS);
  });
  runVectors('rawstrings.csv', RAWSTRINGS_SKIP);
});
