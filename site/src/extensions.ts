import type { CborExtension } from '@cbortech/cbor';
import {
  dt,
  ip,
  cri,
  t1,
  b1,
  ilbs,
  ilts,
  float,
  b32,
  h32,
  same,
} from '@cbortech/cbor';
import { hash } from '@cbortech/hash-extension';

/**
 * 'builtin': bundled by @cbortech/cbor and active by default without an
 *   `extensions` option — disabling it in the playground requires passing
 *   it through the `builtinExtensions` option instead.
 * 'extra': not bundled by default — enabling it requires the `extensions`
 *   option (this playground enables all of them by default).
 */
export type ExtensionKind = 'builtin' | 'extra';

export interface ExtensionEntry {
  /** Stable key used for the checkbox id and localStorage persistence. */
  key: string;
  /** Human-readable label shown next to the checkbox. */
  label: string;
  ext: CborExtension;
  kind: ExtensionKind;
}

// `h`, `b64` are core CDN syntax (not extensions, cannot be disabled) and are
// shown in the popover as static locked checkboxes in index.html rather than
// entries here. `bignum` / `cbordata` are core RFC 8949 data-model features
// always active regardless of `builtinExtensions` and aren't shown at all.
export const EXTENSION_ENTRIES: ExtensionEntry[] = [
  // Bundled by @cbortech/cbor (draft-ietf-cbor-edn-literals-26 §2.1/§3) —
  // toggled via the `builtinExtensions` option.
  { key: 'dt', label: 'dt / DT', ext: dt, kind: 'builtin' },
  { key: 'ip', label: 'ip / IP', ext: ip, kind: 'builtin' },
  { key: 'cri', label: 'cri / CRI', ext: cri, kind: 'builtin' },
  { key: 'float', label: 'float', ext: float, kind: 'builtin' },
  { key: 'b1', label: 'b1', ext: b1, kind: 'builtin' },
  { key: 't1', label: 't1', ext: t1, kind: 'builtin' },
  { key: 'ilbs', label: 'ilbs', ext: ilbs, kind: 'builtin' },
  { key: 'ilts', label: 'ilts', ext: ilts, kind: 'builtin' },
  // Not bundled by default — toggled via the `extensions` option.
  { key: 'hash', label: 'hash', ext: hash, kind: 'extra' },
  { key: 'same', label: 'same', ext: same, kind: 'extra' },
  { key: 'b32', label: 'b32', ext: b32, kind: 'extra' },
  { key: 'h32', label: 'h32', ext: h32, kind: 'extra' },
];
