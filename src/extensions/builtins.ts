import type { CborExtension } from './types';
import dt from './dt';
import ip from './ip';
import cri from './cri';
import bignum from './bignum';
import cbordata from './cbordata';
import { t1, b1 } from './concat';
import { ilbs, ilts } from './ilstrings';
import float from './float';

/**
 * Core RFC 8949 data-model extensions (bignum tags 2/3, embedded-CBOR tag
 * 24). These implement base CBOR representation rather than an
 * application-oriented extension, so they are always active and are not
 * affected by the `builtinExtensions` option.
 */
export const CORE_EXTENSIONS: readonly CborExtension[] = [bignum, cbordata];

/**
 * Default application-oriented extensions bundled with the library.
 * Overridable per call via `builtinExtensions` (an array to use instead, or
 * `false` to disable all of them).
 *
 * `dt`, `ip`, `t1`, and `b1` are mandatory-to-implement per §2.1 of
 * draft-ietf-cbor-edn-literals-26; `cri`, `ilbs`, `ilts`, and `float` are
 * bundled but not mandatory.
 */
export const BUILTIN_EXTENSIONS: readonly CborExtension[] = [
  dt,
  ip,
  cri,
  t1,
  b1,
  ilbs,
  ilts,
  float,
];

let _defaultResolved: readonly CborExtension[] | undefined;

/**
 * Resolve the `builtinExtensions` option to the full list of built-in
 * extensions that should be active: `CORE_EXTENSIONS` plus either the
 * default `BUILTIN_EXTENSIONS` set (`undefined`), a caller-supplied
 * replacement array, or nothing beyond core (`false`).
 */
export function resolveBuiltinExtensions(
  builtinExtensions?: CborExtension[] | false
): readonly CborExtension[] {
  if (builtinExtensions === undefined)
    return (_defaultResolved ??= [...CORE_EXTENSIONS, ...BUILTIN_EXTENSIONS]);
  if (builtinExtensions === false) return CORE_EXTENSIONS;
  return [...CORE_EXTENSIONS, ...builtinExtensions];
}
