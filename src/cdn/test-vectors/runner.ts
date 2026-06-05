/**
 * Shared utilities for EDN CSV test vector runners.
 * Imported by edn-test-vectors.test.ts and edn-abnf-vectors.test.ts.
 */

import { test, expect } from 'vitest';
import { parseCDN } from '../parser';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Decode an h]-prefixed input: hex bytes → UTF-8 string (may contain control chars). */
export function decodeInput(raw: string): string {
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
export function parseCSV(text: string): [string, string, string][] {
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

// ─── Test runner ──────────────────────────────────────────────────────────────

/**
 * Register Vitest tests for one CSV file.
 *
 * @param text            - Raw CSV content (already read from disk).
 * @param knownSkip       - Map of test label → reason; matching tests are skipped.
 * @param strictNegative  - When true (default), a `-` test whose output field
 *                          cannot be parsed fails rather than passes silently.
 *                          Set to false only when the corpus is known to include
 *                          intentionally unparseable output values (corpus-conflict
 *                          cases should be listed in knownSkip instead).
 */
export function registerTests(
  text: string,
  knownSkip: Map<string, string> = new Map(),
  strictNegative = true
): void {
  const rows = parseCSV(text);

  for (const [op, rawInput, rawOutput] of rows) {
    const input = decodeInput(rawInput);
    const label =
      op === 'x'
        ? `${rawInput} → ${rawOutput}`
        : op === '='
          ? `${rawInput} = ${rawOutput}`
          : rawInput;

    const skipReason = knownSkip.get(label);
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
        // Parse failure of EITHER side also satisfies the assertion (they
        // can't be equal if one cannot be decoded at all).
        const negLabel = `${rawInput} ≠ ${rawOutput}`;
        test(negLabel, () => {
          let actual: Uint8Array;
          try {
            actual = parseCDN(input).toCBOR();
          } catch {
            return; // input parse failure → trivially different
          }
          let notExpected: Uint8Array;
          try {
            notExpected = parseCDN(decodeInput(rawOutput)).toCBOR();
          } catch (e) {
            if (!strictNegative) return; // corpus allows unparseable output
            throw e; // output should be parseable; propagate as test failure
          }
          expect(actual).not.toEqual(notExpected);
        });
      } else {
        test(label, () => {
          expect(() => parseCDN(input)).toThrow();
        });
      }
    }
  }
}
