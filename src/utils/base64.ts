/**
 * Decode base64 text (classic or URL-safe alphabet, padding optional) into
 * bytes, with strict RFC 4648 validation.
 *
 * Used by the CDN parser (b64'…' literals, §5.3.4) and the CDDL tokenizer
 * (b64'…' byte strings, RFC 8610 §3.1).
 *
 * Recoverable deviations (padding-count mismatches, non-zero trailing bits)
 * are reported through `onRecoverableError` when provided; otherwise they
 * throw a plain SyntaxError, which callers wrap with position information.
 */
export function base64ToBytes(
  b64: string,
  onRecoverableError?: (msg: string) => void
): Uint8Array {
  // Separate data characters from trailing '=' padding.
  const eqIdx = b64.indexOf('=');
  const data = eqIdx >= 0 ? b64.slice(0, eqIdx) : b64;
  const pad = eqIdx >= 0 ? b64.slice(eqIdx) : '';

  // draft-25 b64dig = ALPHA / DIGIT / "-" / "_" / "+" / "/"
  // Classic (+/) and URL-safe (-_) position-62/63 chars are both valid in the
  // same literal. Reject anything outside this set as a hard error.
  if (/[^A-Za-z0-9+/\-_]/.test(data)) {
    const bad = [...data].find((c) => !/[A-Za-z0-9+/\-_]/.test(c)) ?? '';
    throw new SyntaxError(
      `invalid character ${JSON.stringify(bad)} in base64 data`
    );
  }
  if (pad && !/^=+$/.test(pad))
    throw new SyntaxError(`invalid character after base64 '=' padding`);

  const rem = data.length % 4;

  // rem === 1 cannot arise from any valid byte sequence (always invalid).
  if (rem === 1)
    throw new SyntaxError(
      `invalid base64 length: ${data.length} data characters (length mod 4 = 1 is never valid)`
    );

  // Expected number of '=' characters for this data length.
  const expectedPad = rem === 0 ? 0 : 4 - rem;

  if (pad.length > expectedPad) {
    const msg = `base64 has ${pad.length} '=' character${pad.length > 1 ? 's' : ''} but the data length (${data.length}) requires at most ${expectedPad}`;
    if (onRecoverableError) onRecoverableError(msg);
    else throw new SyntaxError(msg);
  }

  // Partial padding: some '=' present but fewer than the full required amount.
  // draft-25 accommodates NO padding; any '=' present must be the full set.
  if (pad.length > 0 && pad.length < expectedPad) {
    const msg = `base64 has ${pad.length} '=' character${pad.length > 1 ? 's' : ''} but needs exactly ${expectedPad} — use full padding or no padding at all`;
    if (onRecoverableError) onRecoverableError(msg);
    else throw new SyntaxError(msg);
  }
  // Zero '=': draft-25 allows omitting padding entirely — always accepted.

  // Non-zero trailing bits in the last data character (RFC 4648 §3.5).
  // Normalize URL-safe chars first so the lookup is against the classic table.
  // rem=2 (1-byte quantum): bottom 4 bits of the final char must be zero.
  // rem=3 (2-byte quantum): bottom 2 bits of the final char must be zero.
  if (rem !== 0 && data.length > 0) {
    const ALPHA =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lastChar = data[data.length - 1]!.replace('-', '+').replace('_', '/');
    const lastVal = ALPHA.indexOf(lastChar);
    if (lastVal >= 0) {
      const mask = rem === 2 ? 0x0f : 0x03;
      if ((lastVal & mask) !== 0) {
        const msg = `base64 has non-zero trailing bits in the final quantum (RFC 4648 §3.5)`;
        if (onRecoverableError) onRecoverableError(msg);
        else throw new SyntaxError(msg);
      }
    }
  }

  // Normalize URL-safe chars to classic and add any missing padding so the
  // underlying decoder accepts the input regardless of what was originally used.
  const normalized =
    data.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(expectedPad);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (Uint8Array as any).fromBase64 === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Uint8Array as any).fromBase64(normalized, {
      alphabet: 'base64',
      lastChunkHandling: 'loose',
    });
  }
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
