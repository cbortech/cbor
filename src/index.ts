export { CborItem } from './ast/index';

// Option types and plugin interfaces
export type {
  CBOROptions,
  CborExtension,
  FromCBOROptions,
  ToCBOROptions,
  FromEDNOptions,
  ToEDNOptions,
  FromJSOptions,
  ToJSOptions,
  FromHexDumpOptions,
  ToHexDumpOptions,
} from './types';

// Tag annotation utilities
export { CBOR_TAG, Null, Tag, Undefined } from './tag';

// Sentinel symbols
export { CBOR_OMIT } from './types';

// Simple value utilities
export { Simple } from './simple';

// Map entries (round-trip support for mapAs: 'entries')
export { MapEntries } from './mapEntries';

// Extensions
export { dt_as_Date } from './extensions/dt';

// Main CBOR class
export { CBOR } from './cbor';
export { CBOR as default } from './cbor';
