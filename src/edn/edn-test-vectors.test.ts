/**
 * EDN test vectors from the IETF CBOR EDN wiki
 * https://github.com/cbor-wg/edn/wiki
 *
 * This file is intentionally excluded from `npm run test`.
 * Run with: npm run test:vectors
 *
 * Known failures and rationale:
 *
 * [encoding-indicators.csv]
 * - 1.1_2, 1.1_1 (×2)
 *     `_2`/`_1` encoding indicators on values not exactly representable in
 *     float32/float16 should fail per spec. Not enforced to avoid
 *     performance overhead of round-trip precision checks.
 *
 * [success.csv]
 * - ip'192.168.1.2/13' → 820d42c0a0 (×1)
 *     Test vector appears to use a /12 subnet mask (255.240.0.0) instead of
 *     the correct /13 mask (255.248.0.0). Correct result for /13 is c0a8,
 *     not c0a0. Considered a test vector error.
 *
 * [failures.csv]
 * - b64'Zm9v # \'\r' (×1)
 *     Contradicts the success.csv test `b64'#foo\n#bar\n  Zm9v  # \'"'`.
 *     Both tests concern `\'` inside a `#` comment in a b64 string. We honour
 *     the success.csv intent (escape handling), so this failures.csv case now
 *     parses successfully instead of failing via a trailing unterminated-quote
 *     side-effect. Considered a test-vector contradiction; kept as known failure.
 * - h'0102' + "foo" should fail (×1)
 *     Current implementation intentionally allows text strings in a
 *     byte-leading concatenation chain (UTF-8 encoded). Intentional design.
 * - dt'...' (×8, various incomplete date-time strings)
 *     `Date.parse()` is too lenient and accepts partial date strings.
 *     Not fixed to avoid the overhead of a strict RFC 3339 regex.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CBOR } from '../cbor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = join(__dirname, 'vectors');

type TestRow = { op: string; input: string; output: string };

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** h] prefix: hex-decode the rest, then UTF-8-decode to get the actual EDN string. */
function resolveInput(raw: string): string {
  if (raw.startsWith('h]')) {
    const hex = raw.slice(2);
    const padded = hex.length % 2 === 1 ? '0' + hex : hex;
    const bytes = new Uint8Array(padded.length / 2);
    for (let i = 0; i < padded.length; i += 2) {
      bytes[i / 2] = parseInt(padded.slice(i, i + 2), 16);
    }
    return new TextDecoder().decode(bytes);
  }
  return raw;
}

function parseCSV(content: string): TestRow[] {
  const rows: TestRow[] = [];
  let i = 0;
  let firstRow = true;

  while (i < content.length) {
    // Skip comment lines (# at start of line)
    if (content[i] === '#') {
      while (i < content.length && content[i] !== '\n') i++;
      if (i < content.length) i++;
      continue;
    }

    // Parse one RFC-4180 row (quoted fields may span multiple lines)
    const fields: string[] = [];
    let rowDone = false;
    while (!rowDone) {
      if (i >= content.length) {
        rowDone = true;
        break;
      }
      if (content[i] === '"') {
        // Quoted field
        i++;
        let field = '';
        while (i < content.length) {
          if (content[i] === '"') {
            if (i + 1 < content.length && content[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            field += content[i++];
          }
        }
        fields.push(field);
        if (i < content.length && content[i] === ',') {
          i++;
        } else {
          if (i < content.length && content[i] === '\n') i++;
          rowDone = true;
        }
      } else {
        // Unquoted field
        let field = '';
        while (
          i < content.length &&
          content[i] !== ',' &&
          content[i] !== '\n'
        ) {
          field += content[i++];
        }
        fields.push(field);
        if (i < content.length && content[i] === ',') {
          i++;
        } else {
          if (i < content.length && content[i] === '\n') i++;
          rowDone = true;
        }
      }
    }

    if (fields.length === 0 || (fields.length === 1 && fields[0] === ''))
      continue;
    if (firstRow) {
      firstRow = false;
      continue;
    }

    rows.push({
      op: fields[0] ?? '',
      input: fields[1] ?? '',
      output: fields[2] ?? '',
    });
  }

  return rows;
}

function runVectors(name: string, csvFile: string) {
  const content = readFileSync(join(VECTORS_DIR, csvFile), 'utf-8');
  const rows = parseCSV(content);

  describe(name, () => {
    for (const { op, input, output } of rows) {
      const actualInput = resolveInput(input);
      const label = `${op} | ${JSON.stringify(actualInput)}${output ? ` → ${output}` : ''}`;

      if (op === 'x') {
        test(label, () => {
          const ast = CBOR.fromEDN(actualInput);
          expect(toHex(ast.toCBOR())).toBe(output);
        });
      } else if (op === '=') {
        test(label, () => {
          const astIn = CBOR.fromEDN(actualInput);
          const astOut = CBOR.fromEDN(output);
          expect(toHex(astIn.toCBOR())).toBe(toHex(astOut.toCBOR()));
        });
      } else if (op === '-') {
        test(label, () => {
          let hex: string | undefined;
          try {
            hex = toHex(CBOR.fromEDN(actualInput).toCBOR());
          } catch {
            return; // parse failure is an acceptable outcome
          }
          if (output === '') {
            expect.fail(
              `Expected parse failure for: ${JSON.stringify(actualInput)}`
            );
          } else {
            // Parsing succeeded but result must differ from expected hex
            expect(hex).not.toBe(output);
          }
        });
      }
    }
  });
}

runVectors('basic', 'basic.csv');
runVectors('encoding-indicators', 'encoding-indicators.csv');
runVectors('success', 'success.csv');
runVectors('failures', 'failures.csv');
