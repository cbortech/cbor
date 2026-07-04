import type { CborExtension } from './types';
import dt from './dt';
import ip from './ip';
import bignum from './bignum';
import cri from './cri';
import cbordata from './cbordata';
import { t1, b1 } from './concat';
import { ilbs, ilts } from './ilstrings';
import float from './float';

export const BUILTIN_EXTENSIONS: CborExtension[] = [
  dt,
  ip,
  bignum,
  cri,
  cbordata,
  t1,
  b1,
  ilbs,
  ilts,
  float,
];
