/**
 * Integration tests against the cbor-wg/cbor-test-vectors corpus, driven by
 * the human-readable .edn files rather than the binary .cbor files.
 *
 * Each .edn file is itself a valid CDN document, so parsing it exercises the
 * CDN parser end-to-end.  Each test case inside has a `decoded` field whose
 * value is the CDN representation of a CBOR value.  For roundtrip cases we
 * additionally verify that re-encoding that value produces the expected bytes.
 *
 * Test strategy:
 *   • Parse the whole .edn file with fromCDN — any parse error fails the suite.
 *   • For each test that has a `decoded` field:
 *       – The item's existence confirms parsing succeeded.
 *       – If roundtrip !== false AND decoded is not an unresolved app-extension:
 *         decoded.toCBOR() must equal the `encoded` bytes.
 *       – Otherwise: roundtrip comparison is skipped (non-preferred encoding or
 *         unresolved extension such as float'...' that requires a registered plugin).
 *   • Tests without a `decoded` field (bad.edn CBOR-failure entries) are test.skip.
 *
 * Node-only (readFileSync) — excluded from the browser test run.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseCDN } from './parser';
import { CborMap } from '../ast/CborMap';
import { CborArray } from '../ast/CborArray';
import { CborTextString } from '../ast/CborTextString';
import { CborByteString } from '../ast/CborByteString';
import { CborSimple } from '../ast/CborSimple';
import { CborUnresolvedAppExt } from '../ast/CborUnresolvedAppExt';
import type { CborItem } from '../ast/CborItem';
import type { CborExtension } from '../extensions/types';
import { float } from '../extensions/float';

const VECTORS_DIR = resolve(import.meta.dirname, '../cbor/test-vectors');

const CBOR_FALSE = 20; // simple(20) = false

function mapGet(m: CborMap, key: string): CborItem | undefined {
  for (const [k, v] of m.entries) {
    if (k instanceof CborTextString && k.value === key) return v;
  }
  return undefined;
}

function isCborSimple(v: CborItem | undefined, simpleValue: number): boolean {
  return v instanceof CborSimple && v.value === simpleValue;
}

function runVectors(relPath: string, extensions?: CborExtension[]): void {
  const text = readFileSync(resolve(VECTORS_DIR, relPath), 'utf-8');
  const top = parseCDN(text, { extensions }) as CborMap;
  const title = (mapGet(top, 'title') as CborTextString).value;
  const tests = (mapGet(top, 'tests') as CborArray).items;

  describe(title, () => {
    for (const item of tests) {
      const t = item as CborMap;
      const description = (mapGet(t, 'description') as CborTextString).value;
      const decodedItem = mapGet(t, 'decoded');
      const shouldRoundtrip = !isCborSimple(mapGet(t, 'roundtrip'), CBOR_FALSE);

      if (decodedItem === undefined) {
        // No decoded field — these tests are about CBOR binary failures, skip.
        test.skip(description, () => {});
        continue;
      }

      // Unresolved app-extension can't roundtrip without a registered plugin.
      const canRoundtrip =
        shouldRoundtrip && !(decodedItem instanceof CborUnresolvedAppExt);

      if (canRoundtrip) {
        test(description, () => {
          const encoded = (mapGet(t, 'encoded') as CborByteString).value;
          expect(decodedItem.toCBOR()).toEqual(encoded);
        });
      } else {
        // Roundtrip comparison skipped: either the encoding is non-preferred, or
        // the decoded value is an unresolved app-extension (e.g. float'7d1f')
        // that requires a registered plugin to produce the correct bytes.
        test(description, () => {
          expect(decodedItem).toBeDefined();
        });
      }
    }
  });
}

describe('CDN test vectors (cbor-wg/cbor-test-vectors)', () => {
  // RFC 8949 Appendix A — per major type
  runVectors('rfc8949-appendixA/mt0.edn');
  runVectors('rfc8949-appendixA/mt1.edn');
  runVectors('rfc8949-appendixA/mt2.edn');
  runVectors('rfc8949-appendixA/mt3.edn');
  runVectors('rfc8949-appendixA/mt4.edn');
  runVectors('rfc8949-appendixA/mt5.edn');
  runVectors('rfc8949-appendixA/mt6.edn');
  runVectors('rfc8949-appendixA/mt7-float.edn');
  runVectors('rfc8949-appendixA/mt7-simple.edn');
  runVectors('rfc8949-appendixA/streaming.edn');
  // RFC 8949 comprehensive good/bad
  runVectors('rfc8949/good.edn');
  runVectors('rfc8949/bad.edn');
  // Spike — extended map key/value tests; uses float'...' for NaN payloads
  runVectors('spike/spike.edn', [float]);
});
