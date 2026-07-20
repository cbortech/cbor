/**
 * Validation tests against the cabo/cddlc embedded test vectors.
 *
 * Each test/*.cddl file in the cddlc corpus (see test-vectors/cddlc/README.md
 * for download instructions — the files are NOT committed) may embed
 * validation vectors as comment lines:
 *
 *   ;;+ <EDN>   the instance must validate
 *   ;;- <EDN>   the instance must NOT validate
 *   ;;: <EDN>   continuation of the previous instance (multi-line payload)
 *
 * Payloads are classic CBOR diagnostic notation (including /…/ comments),
 * which our CDN parser reads natively. Mirroring the cddlc Rakefile, the
 * `ok` feature is enabled (CDDLC_FEATURE_OK=ok,^notok).
 *
 * Node-only (readFileSync) — excluded from the default and browser test runs.
 * Run with: npm run test:cddl-vectors
 */

import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { CDDL } from './index';
import { CBOR } from '../index';

const VECTORS_DIR = resolve(import.meta.dirname, 'test-vectors/cddlc/test');

/** Files whose vectors rely on control operators we deliberately do not
 *  implement yet (the unsupported-operator fallback matches the target only,
 *  which flips the expected outcome of the ';;-' vectors). */
const SKIP: Record<string, string> = {
  '6-bigint.cddl':
    "cddlc's Ruby decoder normalizes tags 2/3 to plain integers, so its " +
    'vectors expect untagged ints to match #6.2/#6.3; we match tagged ' +
    'items strictly per RFC 8610 §3.6',
  '15-default.cddl':
    'cddlc treats .default as annotation-only; RFC 8610 §3.8.6 says it ' +
    'implies .ne (the default value is not sent on the wire), which we follow',
  '18-abnf.cddl': '.abnf is not implemented (needs an ABNF engine)',
  '22-det.cddl': '.det is not implemented',
  '22a-det.cddl': '.det is not implemented',
  '22b-det.cddl': '.det is not implemented',
  '22c-det.cddl': '.det is not implemented',
  '22d-det.cddl': '.det is not implemented',
  '22e-det.cddl': '.det is not implemented',
};

interface Vector {
  expected: boolean;
  payload: string;
  line: number;
}

function extractVectors(text: string): Vector[] {
  const vectors: Vector[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^;;([-+:])\s?(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (m[1] === ':') {
      const last = vectors[vectors.length - 1];
      if (last) last.payload += '\n' + m[2]!;
      continue;
    }
    vectors.push({ expected: m[1] === '+', payload: m[2]!, line: i + 1 });
  }
  return vectors;
}

const files = (() => {
  try {
    return readdirSync(VECTORS_DIR)
      .filter((f) => f.endsWith('.cddl'))
      .sort();
  } catch {
    return [];
  }
})();

describe.skipIf(files.length === 0)('cddlc embedded validation vectors', () => {
  for (const file of files) {
    const text = readFileSync(resolve(VECTORS_DIR, file), 'utf-8');
    const vectors = extractVectors(text);
    if (vectors.length === 0) continue;
    const skip = SKIP[file];
    describe.skipIf(skip !== undefined)(
      `${file}${skip ? ` (${skip})` : ''}`,
      () => {
        const schema = CDDL.compile(text, { strict: false });
        test.each(vectors)(
          `line $line: $payload → ${'$expected'}`,
          ({ expected, payload }) => {
            const item = CBOR.fromCDN(payload);
            const result = schema.validate(item, { features: ['ok'] });
            expect(
              result.valid,
              `${payload}\nexpected ${expected ? 'valid' : 'invalid'}; ` +
                (result.errors[0]?.message ?? '')
            ).toBe(expected);
          }
        );
      }
    );
  }
});
