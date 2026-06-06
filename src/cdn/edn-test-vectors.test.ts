/**
 * Integration tests against the hildjj/edn-test-vectors corpus.
 *
 * CSV files live in src/cdn/test-vectors/edn-test-vectors/ and are NOT
 * committed to this repository.  See that directory's README for download
 * instructions.
 *
 * op = "x": fromCDN(input).toCBOR() hex must equal output
 * op = "=": fromCDN(input).toCBOR() must equal fromCDN(output).toCBOR()
 * op = "-": No output: fromCDN(input) must throw.
 *           With output (CDN): fromCDN(input).toCBOR() must differ from fromCDN(output).toCBOR()
 *           (parse failure of the input also satisfies the assertion).
 *
 * Node-only (readFileSync) — excluded from the browser test run.
 * Run with: npm run test:edn-vectors
 */

import { describe } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { registerTests } from './test-vectors/runner';

const VECTORS_DIR = resolve(
  import.meta.dirname,
  'test-vectors/edn-test-vectors'
);

// ─── Known differences from the reference corpus ─────────────────────────────

/**
 * ip'192.168.1.2/13': The reference test expects h'C0A0' (192.160) but the
 *   mathematically correct /13 network for 192.168.1.2 is 192.168.0.0 (h'C0A8').
 *   Our implementation matches the RFC 9164 §2.3 definition; the test vector
 *   appears to contain an error.
 *
 * b64'Zm9v # \'\r': draft-ietf-cbor-edn-literals-25 §5.3.2 defines an
 *   integrated parser grammar for base64 content where `#` introduces a line
 *   comment, making `# '\r` a comment that is stripped before decoding.
 *   Accepting `Zm9v` is therefore correct per draft-25.  The test vector is
 *   sourced from cbor-edn which referenced draft-16, where this comment
 *   grammar was not yet specified.
 *
 * Single-quoted `\/` and `\u{5C}` tests:
 *   `\/` in `'...'` is invalid per draft-25 §5.1 (not in escapable-s), so
 *   `'foo\/bar' = 'foo/bar'` fails.
 *   `\u{5C}` / `\` in `'...'` is invalid per §5.1 hexchar-s (printable
 *   ASCII is forbidden in `\u` escapes in single-quoted strings).  Use `\\`
 *   instead.  Tests that compare `'foo\u{5C}bar'` against `'foo\\bar'` fail
 *   because the input throws.  hildjj treats `\u{5C}` = `\\` as equivalent.
 */
const KNOWN_SKIP = new Map<string, string>([
  [
    "ip'192.168.1.2/13' → 820d42c0a0",
    'reference test vector has incorrect expected bytes (C0A0 vs correct C0A8)',
  ],
  [
    "b64'Zm9v # \\'\\r'",
    'correct per draft-25 §5.3.2 (# comment strips the CR); test vector is draft-16',
  ],
  // \/ in single-quoted strings — not in escapable-s (§5.1)
  [
    "'foo\\/bar' = 'foo/bar'",
    '\\/ is not in escapable-s (§5.1); hildjj corpus accepts it but draft-25 does not',
  ],
  // \u{5C} / \ in single-quoted — printable ASCII forbidden by hexchar-s (§5.1)
  // input throws; hildjj treats \u{5C} as equivalent to \\
  [
    "'foo\\u{5C}bar' = 'foo\\\\bar'",
    '\\u{5C} is printable ASCII, forbidden in single-quoted \\u escapes (§5.1 hexchar-s)',
  ],
  [
    "'foo\\u{5c}bar' = 'foo\\\\bar'",
    '\\u{5c} is printable ASCII, forbidden in single-quoted \\u escapes (§5.1 hexchar-s)',
  ],
  [
    "'foo\\u{05c}bar' = 'foo\\\\bar'",
    '\\u{05c} is printable ASCII, forbidden in single-quoted \\u escapes (§5.1 hexchar-s)',
  ],
  [
    "'foo\\u{005c}bar' = 'foo\\\\bar'",
    '\\u{005c} is printable ASCII, forbidden in single-quoted \\u escapes (§5.1 hexchar-s)',
  ],
  [
    "'foo\\u{0005c}bar' = 'foo\\\\bar'",
    '\\u{0005c} is printable ASCII, forbidden in single-quoted \\u escapes (§5.1 hexchar-s)',
  ],
  [
    "'foo\\u{00000000000005c}bar' = 'foo\\\\bar'",
    '\\u{00000000000005c} is printable ASCII, forbidden in single-quoted \\u escapes (§5.1 hexchar-s)',
  ],
  [
    "'foo\\u005cbar' = 'foo\\\\bar'",
    '\\u005c is printable ASCII, forbidden in single-quoted \\u escapes (§5.1 hexchar-s)',
  ],
]);

// ─── Test runner ──────────────────────────────────────────────────────────────

function runVectors(filename: string): void {
  const text = readFileSync(resolve(VECTORS_DIR, filename), 'utf-8');
  describe(filename.replace('.csv', ''), () => {
    registerTests(text, KNOWN_SKIP);
  });
}

describe('EDN test vectors (hildjj/edn-test-vectors)', () => {
  runVectors('encoding-indicators.csv');
  runVectors('basic.csv');
  runVectors('success.csv');
  runVectors('failures.csv');
});
