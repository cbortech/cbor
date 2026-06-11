import { bench, describe } from 'vitest';
import { parseCDN } from '../src/cdn/parser';
import {
  negativeIntegersCDN,
  mixedDocumentCDN,
  stringHeavyCDN,
} from './fixtures';

const negatives = negativeIntegersCDN(5000);
const mixed = mixedDocumentCDN(2000);
const strings = stringHeavyCDN(2000);

describe('parseCDN', () => {
  bench(`negative integers (5000 items, ${negatives.length} chars)`, () => {
    parseCDN(negatives);
  });

  bench(`mixed document (2000 entries, ${mixed.length} chars)`, () => {
    parseCDN(mixed);
  });

  bench(`string-heavy (2000 strings, ${strings.length} chars)`, () => {
    parseCDN(strings);
  });
});
