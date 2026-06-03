/**
 * Integration tests against the hildjj/edn-test-vectors corpus.
 *
 * CSV files live in src/cdn/test-vectors/edn-test-vectors/ and are used
 * verbatim.  Each row has three fields: op, input, output.
 *
 * op = "x": fromCDN(input).toCBOR() hex must equal output
 * op = "=": fromCDN(input).toCBOR() must equal fromCDN(output).toCBOR()
 * op = "-": No output: fromCDN(input) must throw.
 *           With output (CDN): fromCDN(input).toCBOR() must differ from fromCDN(output).toCBOR()
 *           (parse failure of the input also satisfies the assertion).
 *
 * Inputs beginning with h] are hex-encoded: decode the hex bytes as UTF-8 to
 * obtain the actual CDN text (used to embed control characters in inputs).
 *
 * Node-only (readFileSync) — excluded from the browser test run.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseCDN } from './parser';

const VECTORS_DIR = resolve(
  import.meta.dirname,
  'test-vectors/edn-test-vectors'
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decode an h]-prefixed input: hex bytes → UTF-8 string (may contain control chars). */
function decodeInput(raw: string): string {
  if (raw.startsWith('h]'))
    return new TextDecoder('utf-8', { fatal: false }).decode(
      hexToBytes(raw.slice(2))
    );
  return raw;
}

/**
 * Minimal RFC 4180 CSV parser.
 * Returns rows as [op, input, output] triples; comment rows (op starts with #)
 * and the header row are excluded.
 */
function parseCSV(text: string): [string, string, string][] {
  const rows: [string, string, string][] = [];
  let i = 0;

  while (i < text.length) {
    const fields: string[] = [];

    // Parse fields until an unquoted newline or EOF.
    while (i < text.length) {
      let field = '';
      if (text[i] === '"') {
        // Quoted field — newlines inside are part of the value.
        i++;
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            // Preserve CR inside quoted fields (RFC 4180: CR is part of value).
            field += text[i];
            i++;
          }
        }
      } else {
        // Unquoted field — stops at comma or newline; strip CR (CRLF endings).
        while (i < text.length && text[i] !== ',' && text[i] !== '\n') {
          if (text[i] !== '\r') field += text[i];
          i++;
        }
      }
      fields.push(field);
      if (i < text.length && text[i] === ',') {
        i++;
      } else {
        break; // newline or EOF ends the row
      }
    }
    if (i < text.length && text[i] === '\n') i++;

    const [op = '', input = '', output = ''] = fields;
    if (op && op !== 'op' && !op.startsWith('#'))
      rows.push([op, input, output]);
  }

  return rows;
}

// ─── Known differences from the reference corpus ─────────────────────────────

/**
 * Test labels that are skipped with the reason why.
 *
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
]);

// ─── Test runner ──────────────────────────────────────────────────────────────

function runVectors(filename: string): void {
  const text = readFileSync(resolve(VECTORS_DIR, filename), 'utf-8');
  const rows = parseCSV(text);

  describe(filename.replace('.csv', ''), () => {
    for (const [op, rawInput, rawOutput] of rows) {
      const input = decodeInput(rawInput);
      const label =
        op === 'x'
          ? `${rawInput} → ${rawOutput}`
          : op === '='
            ? `${rawInput} = ${rawOutput}`
            : rawInput;

      const skipReason = KNOWN_SKIP.get(label);
      if (skipReason) {
        test.skip(`${label} [skip: ${skipReason}]`, () => {});
        continue;
      }

      if (op === 'x') {
        test(label, () => {
          expect(parseCDN(input).toCBOR()).toEqual(hexToBytes(rawOutput));
        });
      } else if (op === '=') {
        test(label, () => {
          expect(parseCDN(input).toCBOR()).toEqual(
            parseCDN(decodeInput(rawOutput)).toCBOR()
          );
        });
      } else if (op === '-') {
        if (rawOutput) {
          // Negative assertion: input and output must produce DIFFERENT bytes.
          // (output is CDN, same as "=" — parse failure also satisfies this.)
          const negLabel = `${rawInput} ≠ ${rawOutput}`;
          test(negLabel, () => {
            let actual: Uint8Array;
            try {
              actual = parseCDN(input).toCBOR();
            } catch {
              return; // parse failure satisfies the assertion
            }
            const notExpected = parseCDN(decodeInput(rawOutput)).toCBOR();
            expect(actual).not.toEqual(notExpected);
          });
        } else {
          test(label, () => {
            expect(() => parseCDN(input)).toThrow();
          });
        }
      }
    }
  });
}

describe('EDN test vectors (hildjj/edn-test-vectors)', () => {
  runVectors('encoding-indicators.csv');
  runVectors('basic.csv');
  runVectors('success.csv');
  runVectors('failures.csv');
});
