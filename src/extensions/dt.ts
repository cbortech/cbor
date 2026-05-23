/**
 * Standard EDN "dt" / "DT" application-extension (§3.1 draft-ietf-cbor-edn-literals-20).
 *
 * Parses RFC 3339 date-time app-strings into epoch-based numeric CBOR values.
 * The resulting CborItem subclasses override toCDN() so the value round-trips
 * back to dt'...' / DT'...' notation.
 *
 * For a richer variant that makes toJS() return Date objects, use dt_as_Date
 * from ./date instead.
 */

import type { ToCDNOptions, ToJSOptions, FromJSOptions } from '../types';
import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborFloat } from '../ast/CborFloat';
import { CborTag } from '../ast/CborTag';
import type { EncodingWidth } from '../cbor/encode';
import { CborTextString } from '../ast/CborTextString';
import { CborByteString } from '../ast/CborByteString';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert epoch seconds to an RFC 3339 string with appropriate precision.
 *
 * - Integer epoch          → "…Z"           (no fractional part)
 * - Millisecond-precision  → "….SSSZ"       (3 decimal places, e.g. ".500Z")
 * - Sub-millisecond        → "….S…Z"        (minimal digits, e.g. ".0001Z")
 *
 * Millisecond precision is used whenever `Math.round(epochSeconds * 1000)`
 * round-trips back to the same float64 value, which is the common case for
 * timestamps stored as integer milliseconds (the JavaScript Date range).
 * Otherwise the shortest decimal representation of the fractional seconds is
 * used so that the float64 value is faithfully represented.
 */
export function epochToRfc3339(epochSeconds: number): string {
  if (Number.isInteger(epochSeconds))
    return new Date(epochSeconds * 1000).toISOString().replace(/\.000Z$/, 'Z');

  // Check if millisecond precision suffices (the common case).
  const roundedMs = Math.round(epochSeconds * 1000);
  if (roundedMs / 1000 === epochSeconds)
    return new Date(roundedMs).toISOString().replace(/\.000Z$/, 'Z');

  // Sub-millisecond precision: decompose into whole seconds + fractional part.
  // Math.floor ensures the fractional part is always in [0, 1), which is
  // correct for negative epochs too (e.g. -0.5 → floor=-1, frac=0.5).
  const wholeSeconds = Math.floor(epochSeconds);
  const frac = epochSeconds - wholeSeconds;

  // Base timestamp formatted to the second, without any fractional part.
  const base = new Date(wholeSeconds * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, '');

  // Minimal decimal representation of the fractional seconds (JavaScript's
  // Number.prototype.toString uses the shortest round-trip string).
  const fracStr = frac.toString(); // e.g. "0.0001" or "0.123456"
  const dotIdx = fracStr.indexOf('.');
  let decDigits = dotIdx >= 0 ? fracStr.slice(dotIdx + 1) : '0';
  // Ensure at least 3 decimal places for conventional readability.
  while (decDigits.length < 3) decDigits += '0';

  return `${base}.${decDigits}Z`;
}

/**
 * Extract a date-time string from a single-item app-sequence.
 * Accepts CborTextString (dt<<"...">> ) and CborByteString (dt<<'...'>> , UTF-8).
 */
function stringFromAppSequence(items: CborItem[]): string {
  if (items.length !== 1)
    throw new SyntaxError('dt<<...>>: expected exactly one item');
  const item = items[0];
  if (item instanceof CborTextString) return item.value;
  if (item instanceof CborByteString)
    return new TextDecoder('utf-8', { fatal: true }).decode(item.value);
  throw new SyntaxError('dt<<...>>: expected a text string or byte string');
}

/**
 * Parse an RFC 3339 string and produce the appropriate epoch CborItem subclass.
 * Integer seconds → CborEpochDtExtUint or CborEpochDtExtNint.
 * Fractional seconds → CborEpochDtExtFloat.
 *
 * Fractional seconds are extracted from the string directly (via parseFloat)
 * before passing the remainder to Date.parse, so sub-millisecond precision
 * is preserved rather than being rounded to the nearest millisecond.
 */
export function parseDtAppString(
  str: string
): CborEpochDtExtUint | CborEpochDtExtNint | CborEpochDtExtFloat {
  // Separate the fractional-seconds part (if any) from the rest of the string.
  // This avoids Date.parse() truncating to millisecond precision.
  // Pattern: ...THH:MM:SS(.frac)(Z|±HH:MM)
  const fracMatch = str.match(
    /^(.+T\d{2}:\d{2}:\d{2})(\.\d+)(Z|[+-]\d{2}:\d{2})$/i
  );

  let wholeStr: string;
  let fracValue: number | undefined;

  if (fracMatch) {
    // Parse the integer-seconds part (without the fractional digits).
    wholeStr = fracMatch[1] + fracMatch[3];
    // Parse the fractional seconds string with full float64 precision.
    fracValue = parseFloat('0' + fracMatch[2]); // e.g. parseFloat("0.0001")
  } else {
    wholeStr = str;
    fracValue = undefined;
  }

  const ms = Date.parse(wholeStr);
  if (isNaN(ms))
    throw new SyntaxError(
      `dt: invalid RFC 3339 date-time: ${JSON.stringify(str)}`
    );

  if (fracValue === undefined) {
    const seconds = ms / 1000;
    if (seconds >= 0) return new CborEpochDtExtUint(BigInt(seconds));
    return new CborEpochDtExtNint(BigInt(seconds));
  }

  return new CborEpochDtExtFloat(ms / 1000 + fracValue);
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const PREFIX_DT = 'dt';
export const PREFIX_DT_TAGGED = 'DT';
export const TAG_EPOCH = 1n;

// ─── CborItem subclasses ─────────────────────────────────────────────────────

/**
 * Unsigned epoch timestamp whose toCDN() emits dt'…' notation.
 * The RFC 3339 string is re-derived from the numeric value on each call.
 */
export class CborEpochDtExtUint extends CborUint {
  constructor(
    value: number | bigint,
    options?: { encodingWidth?: EncodingWidth }
  ) {
    super(value, options);
  }

  override _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, _depth);
    return `${PREFIX_DT}'${epochToRfc3339(Number(this.value))}'`;
  }
}

/**
 * Negative epoch timestamp whose toCDN() emits dt'…' notation.
 * The RFC 3339 string is re-derived from the numeric value on each call.
 */
export class CborEpochDtExtNint extends CborNint {
  constructor(
    value: number | bigint,
    options?: { encodingWidth?: EncodingWidth }
  ) {
    super(value, options);
  }

  override _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, _depth);
    return `${PREFIX_DT}'${epochToRfc3339(Number(this.value))}'`;
  }
}

/**
 * Float epoch timestamp whose toCDN() emits dt'…' notation.
 * The RFC 3339 string is re-derived from the numeric value on each call.
 */
export class CborEpochDtExtFloat extends CborFloat {
  constructor(
    value: number,
    options?: { precision?: 'half' | 'single' | 'double' }
  ) {
    super(value, options);
  }

  override _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, _depth);
    return `${PREFIX_DT}'${epochToRfc3339(this.value)}'`;
  }
}

/**
 * CBOR tag(1, epoch) whose toCDN() emits DT'…' notation.
 * The RFC 3339 string is re-derived from the numeric content on each call.
 */
export class CborTaggedEpochDtExt extends CborTag {
  constructor(datetime: string, options?: { encodingWidth?: EncodingWidth }) {
    super(TAG_EPOCH, parseDtAppString(datetime), options);
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, depth);
    const c = this.content as
      | CborEpochDtExtUint
      | CborEpochDtExtNint
      | CborEpochDtExtFloat;
    const epochSeconds = c instanceof CborFloat ? c.value : Number(c.value);
    return `${PREFIX_DT_TAGGED}'${epochToRfc3339(epochSeconds)}'`;
  }
}

/**
 * CBOR tag(1, epoch) whose toJS() returns a plain Date object.
 * Use dt_as_Date (or createDtExtension({ jsDate: true })) to produce these nodes.
 */
export class CborTaggedEpochDtAsDateExt extends CborTaggedEpochDtExt {
  constructor(datetime: string, options?: { encodingWidth?: EncodingWidth }) {
    super(datetime, options);
  }

  override _toJS(_options?: ToJSOptions): Date {
    const c = this.content as
      | CborEpochDtExtUint
      | CborEpochDtExtNint
      | CborEpochDtExtFloat;
    const epochMs =
      c instanceof CborFloat ? c.value * 1000 : Number(c.value) * 1000;
    return new Date(epochMs);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a dt/DT CborExtension.
 *
 * - `createDtExtension()` — tagged DT values produce `CborTaggedEpochDtExt`;
 *   toJS() returns a number (epoch seconds).
 * - `createDtExtension({ jsDate: true })` — tagged DT values produce
 *   `CborTaggedEpochDtAsDateExt`; toJS() returns a `Date` object, and
 *   `fromJS(Date)` converts `Date` instances back to tagged epoch values.
 */
export function createDtExtension(options?: {
  jsDate?: boolean;
}): CborExtension {
  const useDate = options?.jsDate ?? false;

  function makeTagged(
    datetime: string
  ): CborTaggedEpochDtExt | CborTaggedEpochDtAsDateExt {
    return useDate
      ? new CborTaggedEpochDtAsDateExt(datetime)
      : new CborTaggedEpochDtExt(datetime);
  }

  const ext: CborExtension = {
    appStringPrefixes: [PREFIX_DT, PREFIX_DT_TAGGED],
    tagNumbers: [TAG_EPOCH],

    parseAppString(prefix: string, content: string): CborItem {
      if (prefix === PREFIX_DT_TAGGED) return makeTagged(content);
      return parseDtAppString(content);
    },

    parseAppSequence(prefix: string, items: CborItem[]): CborItem {
      const str = stringFromAppSequence(items);
      if (prefix === PREFIX_DT_TAGGED) return makeTagged(str);
      return parseDtAppString(str);
    },

    parseTag(tag: bigint, value: CborItem): CborItem | undefined {
      if (tag !== TAG_EPOCH) return undefined;
      let epochSeconds: number;
      if (value instanceof CborUint) epochSeconds = Number(value.value);
      else if (value instanceof CborNint) epochSeconds = Number(value.value);
      else if (value instanceof CborFloat) epochSeconds = value.value;
      else return undefined;
      return makeTagged(epochToRfc3339(epochSeconds));
    },
  };

  if (useDate) {
    ext.fromJS = (
      value: unknown,
      _options: FromJSOptions
    ): CborItem | undefined => {
      if (value instanceof Date)
        return new CborTaggedEpochDtAsDateExt(
          epochToRfc3339(value.getTime() / 1000)
        );
      return undefined;
    };
    ext.isJSType = (value: unknown): value is Date => value instanceof Date;
  }

  return ext;
}

// ─── Extension objects ────────────────────────────────────────────────────────

/**
 * Standard dt/DT CborExtension.
 * Tagged DT values produce CborTaggedEpochDtExt; toJS() returns a number.
 * For Date-based toJS() use dt_as_Date or createDtExtension({ jsDate: true }).
 */
export const dt: CborExtension = createDtExtension();

/**
 * Full-featured dt/DT CborExtension with Date support.
 * Tagged DT values produce CborTaggedEpochDtAsDateExt; toJS() returns a Date.
 * fromJS(Date) converts Date instances to tagged epoch values.
 */
export const dt_as_Date: CborExtension = createDtExtension({ jsDate: true });

export default dt;
