import { bench, describe } from 'vitest';
import { parseCDN } from '../src/cdn/parser';
import { decodeCBOR } from '../src/cbor/decoder';
import { CborArray } from '../src/ast/CborArray';
import { CborUint } from '../src/ast/CborUint';
import { mixedDocumentCDN } from './fixtures';

const mixedItem = parseCDN(mixedDocumentCDN(2000));
const mixedBytes = mixedItem.toCBOR();

/** Nested arrays: `depth` levels, each holding `width` uints plus the next level. */
function deepArray(depth: number, width: number): CborArray {
  let node = new CborArray([new CborUint(1n)]);
  for (let d = 0; d < depth; d++) {
    const items: (CborUint | CborArray)[] = [];
    for (let w = 0; w < width; w++) items.push(new CborUint(BigInt(w)));
    items.push(node);
    node = new CborArray(items);
  }
  return node;
}

const deep = deepArray(500, 20);
const wide = new CborArray(
  Array.from({ length: 10000 }, (_, i) => new CborUint(BigInt(i)))
);

describe('decodeCBOR', () => {
  bench(`mixed document (${mixedBytes.length} bytes)`, () => {
    decodeCBOR(mixedBytes);
  });
});

describe('toCBOR', () => {
  bench('deep nesting (500 levels x 20 uints)', () => {
    deep.toCBOR();
  });

  bench('wide array (10000 uints)', () => {
    wide.toCBOR();
  });
});

describe('toCDN', () => {
  bench('mixed document, indent 2', () => {
    mixedItem.toCDN({ indent: 2 });
  });
});
