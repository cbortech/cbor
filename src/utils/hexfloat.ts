/**
 * Hex float (C99-style, e.g. `0x1.8p+0`) encode/decode utilities.
 *
 * Hex float format:
 *   [-] 0x [hex digits] [. [hex digits]] p [+-] [decimal exponent]
 *
 * This notation appears in CDN (draft-ietf-cbor-edn-literals-27) as an
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
 * CDN diagnostic notation.
 *
 * - Every nonzero finite value: `0x1.[hex fraction]p[+-][exp]` (e.g.
 *   `0x1.8p+0` for 1.5) — including a *subnormal* double, renormalized
 *   into this same leading-`1` form rather than spelled out anchored to
 *   its own stored field layout (`0x0.[hex fraction]p-1022`, still a
 *   correct spelling of the same value, but needlessly longer: e.g.
 *   `Number.MIN_VALUE` used to read `0x0.0000000000001p-1022`, equal to
 *   but far longer than the normalized `0x1p-1074`. A hex-float literal
 *   is just `significand * 2^exponent` — there's no reason its spelling
 *   should vary by whether the *double* happened to run out of exponent
 *   range, once it's just text.)
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

  let mantissa52: bigint; // the 52 fraction bits that go after "1."
  let exp: number;
  if (biasedExp === 0) {
    // Subnormal: value = 0.[52-bit mantissa] * 2^-1022, with no implicit
    // leading 1 of its own. Renormalize by finding the mantissa's own
    // leading set bit (`mantHi`/`mantLo` can't both be zero here — that
    // combination, with `biasedExp === 0`, would mean `abs === 0`,
    // already returned above) and shifting it up to become the implicit
    // "1", the same renormalization step CPU hardware performs when it
    // promotes a subnormal operand.
    const mantissa = (BigInt(mantHi) << 32n) | BigInt(mantLo);
    const bitLength = mantissa.toString(2).length; // 1..52
    const leadingBit = 1n << BigInt(bitLength - 1);
    mantissa52 = (mantissa - leadingBit) << BigInt(52 - (bitLength - 1));
    // value = (leadingBit + r)/2^52 * 2^-1022, with leadingBit = 2^(bitLength-1)
    // and r = mantissa - leadingBit — factor out leadingBit/2^52 to land on
    // the normalized `1.[mantissa52/2^52] * 2^exp` form: exp is the *true*
    // exponent of that leading bit, `bitLength - 1 - 52 - 1022`, not just
    // `bitLength - 1 - 1022` (that's `2^-1022`'s own exponent, before
    // dividing by the mantissa field's `2^52` scale — still needed here,
    // unlike the normal branch below, whose `biasedExp - 1023` already *is*
    // the final exponent by definition of the bias).
    exp = bitLength - 1075;
  } else {
    // Normal: value = 1.[52-bit mantissa] * 2^(biasedExp-1023)
    mantissa52 = (BigInt(mantHi) << 32n) | BigInt(mantLo);
    exp = biasedExp - 1023;
  }

  // Format mantissa as 13 hex digits (52 bits / 4), strip trailing zeros
  const hexMant = mantissa52.toString(16).padStart(13, '0');
  const trimmed = hexMant.replace(/0+$/, '');
  const mantPart = trimmed === '' ? '' : `.${trimmed}`;

  const expStr = exp >= 0 ? `+${exp}` : `${exp}`;
  const result = `0x1${mantPart}p${expStr}`;
  return neg ? `-${result}` : result;
}
