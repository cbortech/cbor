// Option types and plugin interfaces
export type {
  CBOROptions,
  CborExtension,
  DecodeWarning,
  ParseWarning,
  FromCBOROptions,
  FromCBORSeqOptions,
  ToCBOROptions,
  FromCDNOptions,
  FromCDNSeqOptions,
  ToCDNOptions,
  FromEDNOptions,
  ToEDNOptions,
  FromJSOptions,
  ToJSOptions,
  FromHexDumpOptions,
  ToHexDumpOptions,
} from './types';

// Structured syntax error thrown by fromCDN/parse
export { CdnSyntaxError } from './cdn/errors';

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
export { dt_as_Date } from './extensions/dt';
export { t1, b1 } from './extensions/concat';
export { ilbs, ilts } from './extensions/ilstrings';

// Main CBOR class
export { CBOR } from './cbor';
export { CBOR as default } from './cbor';
