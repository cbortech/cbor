/**
 * Hex float (C99-style, e.g. `0x1.8p+0`) encode/decode utilities.
 *
 * Hex float format:
 *   [-] 0x [hex digits] [. [hex digits]] p [+-] [decimal exponent]
 *
 * This notation appears in CBOR-EDN (draft-ietf-cbor-edn-literals) as an
 * alternative representation for floating-point values (major type 7).
 */

// Reusable 8-byte buffer for float64 bit extraction
const _buf8 = new ArrayBuffer(8);
const _dv8 = new DataView(_buf8);

/**
 * Parse a hex float literal (e.g. `0x4711p+03`, `0x1.8p+0`, `-0x1.fp-2`)
 * to a JS number.
 *
 * Assumes the string has already been stripped of any encoding-indicator
 * suffix (`_1`, `_2`, `_3`).
 */
export function parseHexFloat(s: string): number {
  const neg = s.startsWith('-');
  const body = s.slice(neg ? 3 : 2); // strip optional '-' and '0x'/'0X'

  const pIdx = body.search(/[pP]/);
  if (pIdx === -1)
    throw new SyntaxError(
      `EDN parse error: hex float missing 'p' exponent: ${s}`
    );

  const mantissaStr = body.slice(0, pIdx);
  const expStr = body.slice(pIdx + 1);

  // Exponent must be a non-empty decimal integer (optional sign + digits)
  if (!/^[+-]?\d+$/.test(expStr))
    throw new SyntaxError(
      `EDN parse error: hex float has invalid or missing exponent: ${s}`
    );

  const exp = parseInt(expStr, 10);

  const dotIdx = mantissaStr.indexOf('.');
  let mantissa: number;
  if (dotIdx === -1) {
    // No decimal point: must have at least one hex digit
    if (!/^[0-9a-fA-F]+$/.test(mantissaStr))
      throw new SyntaxError(
        `EDN parse error: hex float has no mantissa digits: ${s}`
      );
    mantissa = parseInt(mantissaStr, 16);
  } else {
    const intPart = mantissaStr.slice(0, dotIdx);
    const fracStr = mantissaStr.slice(dotIdx + 1);
    // At least one hex digit required on either side of the decimal point
    if (intPart === '' && fracStr === '')
      throw new SyntaxError(
        `EDN parse error: hex float has no mantissa digits: ${s}`
      );
    if (intPart !== '' && !/^[0-9a-fA-F]+$/.test(intPart))
      throw new SyntaxError(
        `EDN parse error: hex float has invalid mantissa: ${s}`
      );
    if (fracStr !== '' && !/^[0-9a-fA-F]+$/.test(fracStr))
      throw new SyntaxError(
        `EDN parse error: hex float has invalid mantissa: ${s}`
      );
    const intVal = intPart === '' ? 0 : parseInt(intPart, 16);
    const fracVal =
      fracStr === '' ? 0 : parseInt(fracStr, 16) / Math.pow(16, fracStr.length);
    mantissa = intVal + fracVal;
  }

  const result = mantissa * Math.pow(2, exp);
  return neg ? -result : result;
}

/**
 * Convert a JS number to a normalized hex float string compatible with
 * CBOR-EDN diagnostic notation.
 *
 * - Normal values: `0x1.[hex fraction]p[+-][exp]`  (e.g. `0x1.8p+0` for 1.5)
 * - Subnormal values: `0x0.[hex fraction]p-1022`
 * - Zero: `0x0p+0` / `-0x0p+0`
 * - Non-finite values (NaN, ±Infinity) are returned unchanged as EDN tokens.
 */
export function floatToHexFloat(v: number): string {
  if (isNaN(v)) return 'NaN';
  if (!isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';

  const neg = Object.is(v, -0) || v < 0;
  const abs = Math.abs(v);

  if (abs === 0) return neg ? '-0x0p+0' : '0x0p+0';

  _dv8.setFloat64(0, abs, false); // big-endian
  const hi = _dv8.getUint32(0, false);
  const lo = _dv8.getUint32(4, false);

  // bits [30:20] of hi = biased exponent (11 bits)
  const biasedExp = (hi >>> 20) & 0x7ff;
  // bits [19:0] of hi = upper 20 bits of 52-bit mantissa
  const mantHi = hi & 0xfffff;
  // lo = lower 32 bits of mantissa
  const mantLo = lo;

  // Format mantissa as 13 hex digits (52 bits / 4), strip trailing zeros
  const hexMant =
    mantHi.toString(16).padStart(5, '0') + mantLo.toString(16).padStart(8, '0');
  const trimmed = hexMant.replace(/0+$/, '');
  const mantPart = trimmed === '' ? '' : `.${trimmed}`;

  let intPart: string;
  let exp: number;
  if (biasedExp === 0) {
    // Subnormal: value = 0.[mantissa] * 2^-1022
    intPart = '0';
    exp = -1022;
  } else {
    // Normal: value = 1.[mantissa] * 2^(biasedExp-1023)
    intPart = '1';
    exp = biasedExp - 1023;
  }

  const expStr = exp >= 0 ? `+${exp}` : `${exp}`;
  const result = `0x${intPart}${mantPart}p${expStr}`;
  return neg ? `-${result}` : result;
}
