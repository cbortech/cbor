import type { CborExtension } from './types';
import dt from './dt';
import ip from './ip';
import bignum from './bignum';
import cri from './cri';
import cbordata from './cbordata';

export const BUILTIN_EXTENSIONS: CborExtension[] = [
  dt,
  ip,
  bignum,
  cri,
  cbordata,
];
