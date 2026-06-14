import type { CborExtension } from '@cbortech/cbor';
import { b32, h32, float, same } from '@cbortech/cbor';
import { uuid } from '@cbortech/uuid-extension';
import { hash } from '@cbortech/hash-extension';

export const SITE_EXTENSIONS: CborExtension[] = [
  b32,
  h32,
  float,
  same,
  uuid,
  hash,
];
