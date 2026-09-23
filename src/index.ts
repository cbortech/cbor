// Option types and plugin interfaces
export type {
  CBOROptions,
  CborExtension,
  CborComment,
  CborComments,
  DecodeWarning,
  ParseWarning,
  FromCBOROptions,
  FromCBORSeqOptions,
  ToCBOROptions,
  FromCDNOptions,
  FromCDNSeqOptions,
  ToCDNOptions,
  ReadonlyToCDNOptions,
  FromEDNOptions,
  ToEDNOptions,
  FromJSOptions,
  ToJSOptions,
  ToJSNodeOptions,
  ReadonlyToJSNodeOptions,
  ItemContext,
  CdnItemContext,
  FromHexDumpOptions,
  ToHexDumpOptions,
  ValidateOptions,
  ValidateResult,
} from './types';

// Encoding-width type used by `encodingWidth` fields on CborItem subclasses,
// and by the `preserveAppSeqSource` primitives exposed from `@cbortech/cbor/cdn`.
export type { EncodingWidth } from './cbor/encode';

// Structured syntax error thrown by fromCDN/parse
export { CdnSyntaxError } from './cdn/errors';

// CDDL schema mismatch error thrown by the `cddl` option of the decode/parse
// entry points. The option accepts CDDL source text or a schema compiled
// with `CDDL.compile()` from the `@cbortech/cbor/cddl` subpath entry.
export { CddlMismatchError } from './cddl/errors';
export type { CddlValidationError, CddlValidationWarning } from './cddl/errors';

// Tag annotation utilities
export { CBOR_TAG, Null, Tag, Undefined } from './tag';

// Sentinel symbols
export { CBOR_OMIT } from './types';

// Simple value utilities
export { Simple } from './simple';

// Map entries (round-trip support for mapAs: 'entries')
export { MapEntries } from './mapEntries';

// Extensions
export { b32, h32 } from './extensions/b32';
export { float } from './extensions/float';
export { same } from './extensions/same';
export { dt, dt_as_Date } from './extensions/dt';
export { ip } from './extensions/ip';
export { cri } from './extensions/cri';
export { t1, b1 } from './extensions/concat';
export { ilbs, ilts } from './extensions/ilstrings';

// `e'...'` external-reference extension (draft-ietf-cbor-edn-e-ref) — unlike
// the other bundled extensions, this one is schema-specific; build one with
// `createERefExtension(schema)`. `CBOR.fromCDN()`/`fromCBOR()`/`fromJS()`
// register it automatically whenever the `cddl` option is set, so most
// callers never need either of these directly. `annotateERefKeys()` is
// exposed for a caller that validates separately from parsing/decoding —
// e.g. a UI that must keep converting input that doesn't match the open
// schema instead of throwing, so it can't use the `cddl` option's own
// validate-and-annotate behavior, but still wants `e'name'` annotation
// applied whenever the input *does* happen to validate.
export {
  createERefExtension,
  annotateERefKeys,
  CborERefUint,
  CborERefNint,
} from './extensions/eref';

// The default set of bundled app-extensions, for use with
// the `builtinExtensions` option (e.g. to build a filtered subset).
export { BUILTIN_EXTENSIONS } from './extensions/builtins';

// Main CBOR class
export { CBOR } from './cbor';
export { CBOR as default } from './cbor';
