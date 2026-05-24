/**
 * CDN "ip" / "IP" application-extension (§3.2 of draft-ietf-cbor-edn-literals-25).
 *
 * Parses IPv4 / IPv6 address strings (RFC 3986 §3.2.2) into byte strings,
 * and optionally wraps them in CBOR tags per RFC 9164:
 *   - tag 52  IPv4 address or prefix
 *   - tag 54  IPv6 address or prefix
 *
 * Syntax:
 *   ip'192.0.2.42'          → CborIpExt       bare 4-byte string
 *   ip'2001:db8::1'         → CborIpExt       bare 16-byte string
 *   ip'192.0.2.0/24'        → CborIpPrefixExt bare [24, h'c00002']
 *   ip'2001:db8::/32'       → CborIpPrefixExt bare [32, h'20010db8']
 *   IP'192.0.2.42'          → CborTaggedIpExt tag(52, h'...')
 *   IP'2001:db8::1'         → CborTaggedIpExt tag(54, h'...')
 *   IP'192.0.2.0/24'        → CborTaggedIpExt tag(52, [24, h'c00002'])
 *   IP'2001:db8::/32'       → CborTaggedIpExt tag(54, [32, h'20010db8'])
 *
 * Lowercase ip produces the unwrapped content; uppercase IP additionally
 * wraps it in the IANA address family tag (52 for IPv4, 54 for IPv6).
 */

import type { ToCDNOptions } from '../types';
import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborByteString } from '../ast/CborByteString';
import { CborTag } from '../ast/CborTag';
import { CborArray } from '../ast/CborArray';
import { CborUint } from '../ast/CborUint';
import { CborTextString } from '../ast/CborTextString';
import { parseIPv4, parseIPv6, formatIPv4, formatIPv6 } from '../utils/ip';

const PREFIX_IP = 'ip';
const PREFIX_IP_TAGGED = 'IP';
const TAG_IPV4 = 52n;
const TAG_IPV6 = 54n;

function stringFromAppSequence(items: CborItem[]): string {
  if (items.length !== 1)
    throw new SyntaxError('ip<<...>>: expected exactly one item');
  const item = items[0];
  if (item instanceof CborTextString) return item.value;
  if (item instanceof CborByteString)
    return new TextDecoder('utf-8', { fatal: true }).decode(item.value);
  throw new SyntaxError('ip<<...>>: expected a text string or byte string');
}

// ─── Address parsing ──────────────────────────────────────────────────────────

function parseAddress(str: string): { bytes: Uint8Array; isV4: boolean } {
  if (/^\d/.test(str) && str.includes('.') && !str.includes(':'))
    return { bytes: parseIPv4(str), isV4: true };
  return { bytes: parseIPv6(str), isV4: false };
}

// ─── Address formatting ───────────────────────────────────────────────────────

function formatAddress(bytes: Uint8Array): string {
  if (bytes.length === 4) return formatIPv4(bytes);
  if (bytes.length === 16) return formatIPv6(bytes);
  throw new SyntaxError(`ip: unexpected byte length: ${bytes.length}`);
}

// ─── CIDR helpers ─────────────────────────────────────────────────────────────

function truncateToPrefix(bytes: Uint8Array, prefixLen: number): Uint8Array {
  // RFC 9164 §2.3: zero host bits, then strip trailing zero bytes.
  const masked = new Uint8Array(bytes.length);
  masked.set(bytes);
  const fullBytes = Math.floor(prefixLen / 8);
  const extraBits = prefixLen % 8;
  if (extraBits > 0 && fullBytes < bytes.length)
    masked[fullBytes] &= (0xff << (8 - extraBits)) & 0xff;
  for (let i = fullBytes + (extraBits > 0 ? 1 : 0); i < bytes.length; i++)
    masked[i] = 0;
  let end = Math.ceil(prefixLen / 8);
  while (end > 0 && masked[end - 1] === 0) end--;
  return masked.slice(0, end);
}

function expandToFull(truncated: Uint8Array, fullLen: number): Uint8Array {
  const full = new Uint8Array(fullLen);
  full.set(truncated);
  return full;
}

// ─── CborItem subclasses ─────────────────────────────────────────────────────

/**
 * Bare IP address byte string whose toCDN() emits ip'…' notation.
 */
export class CborIpExt extends CborByteString {
  override _toCDN(options: ToCDNOptions | undefined, _depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, _depth);
    return `${PREFIX_IP}'${formatAddress(this.value)}'`;
  }
}

/**
 * Bare IP address prefix (CIDR) whose toCDN() emits ip'…/prefix' notation.
 * Encoded as [prefixLen, truncatedBytes] per RFC 9164 §2.3, without a tag.
 */
export class CborIpPrefixExt extends CborArray {
  private readonly _isV4: boolean;

  constructor(prefixLen: number, truncated: Uint8Array, isV4: boolean) {
    super([new CborUint(BigInt(prefixLen)), new CborByteString(truncated)]);
    this._isV4 = isV4;
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, depth);
    const prefixLen = Number((this.items[0] as CborUint).value);
    const truncated = (this.items[1] as CborByteString).value;
    const full = expandToFull(truncated, this._isV4 ? 4 : 16);
    return `${PREFIX_IP}'${formatAddress(full)}/${prefixLen}'`;
  }
}

/**
 * CBOR tag(52/54, …) IP address whose toCDN() emits IP'…' notation.
 * Content may be a byte string (plain address) or an array [prefix, bytes]
 * (CIDR prefix per RFC 9164).
 */
export class CborTaggedIpExt extends CborTag {
  constructor(tag: bigint, content: CborItem) {
    super(tag, content);
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, depth);
    const fullLen = this.tag === TAG_IPV4 ? 4 : 16;
    const c = this.content as CborItem;
    if (c instanceof CborByteString) {
      return `${PREFIX_IP_TAGGED}'${formatAddress(c.value)}'`;
    }
    if (
      c instanceof CborArray &&
      c.items.length === 2 &&
      c.items[0] instanceof CborUint &&
      c.items[1] instanceof CborByteString
    ) {
      const prefixLen = Number((c.items[0] as CborUint).value);
      const full = expandToFull((c.items[1] as CborByteString).value, fullLen);
      return `${PREFIX_IP_TAGGED}'${formatAddress(full)}/${prefixLen}'`;
    }
    return super._toCDN(options, depth);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

function buildIpValue(prefix: string, content: string): CborItem {
  const slashIdx = content.indexOf('/');

  if (slashIdx === -1) {
    const { bytes, isV4 } = parseAddress(content);
    if (prefix === PREFIX_IP_TAGGED)
      return new CborTaggedIpExt(
        isV4 ? TAG_IPV4 : TAG_IPV6,
        new CborByteString(bytes)
      );
    return new CborIpExt(bytes);
  }

  // CIDR notation — supported with both lowercase ip and uppercase IP.
  // lowercase ip → bare [prefixLen, truncatedBytes] (no tag)
  // uppercase IP → tag(52/54, [prefixLen, truncatedBytes])
  const addrStr = content.slice(0, slashIdx);
  const lenStr = content.slice(slashIdx + 1);
  if (!/^\d+$/.test(lenStr))
    throw new SyntaxError(
      `ip: invalid prefix length: ${JSON.stringify(lenStr)}`
    );
  const prefixLen = parseInt(lenStr, 10);

  const { bytes, isV4 } = parseAddress(addrStr);
  const maxLen = isV4 ? 32 : 128;
  if (prefixLen > maxLen)
    throw new SyntaxError(
      `ip: prefix length ${prefixLen} exceeds maximum ${maxLen} for ${isV4 ? 'IPv4' : 'IPv6'}`
    );

  const truncated = truncateToPrefix(bytes, prefixLen);
  if (prefix === PREFIX_IP_TAGGED) {
    return new CborTaggedIpExt(
      isV4 ? TAG_IPV4 : TAG_IPV6,
      new CborArray([
        new CborUint(BigInt(prefixLen)),
        new CborByteString(truncated),
      ])
    );
  }
  return new CborIpPrefixExt(prefixLen, truncated, isV4);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an ip/IP CborExtension (RFC 9164 / §3.2 of draft-ietf-cbor-edn-literals-25).
 *
 * - `ip'addr'`          → CborIpExt (bare byte string, 4 or 16 bytes)
 * - `IP'addr'`          → CborTaggedIpExt  tag(52 or 54, bytes)
 * - `IP'addr/prefix'`   → CborTaggedIpExt  tag(52 or 54, [prefix_len, bytes])
 * - parseTag(52/54, …)  → CborTaggedIpExt  (reversible via fromCBOR)
 * - fromJS(tagged obj)  → CborTaggedIpExt  (reversible via fromJS)
 */
export const ip: CborExtension = {
  appStringPrefixes: [PREFIX_IP, PREFIX_IP_TAGGED],
  tagNumbers: [TAG_IPV4, TAG_IPV6],

  parseAppString(prefix: string, content: string): CborItem {
    return buildIpValue(prefix, content);
  },

  parseAppSequence(prefix: string, items: CborItem[]): CborItem {
    return buildIpValue(prefix, stringFromAppSequence(items));
  },

  parseTag(tag: bigint, value: CborItem): CborItem | undefined {
    if (tag !== TAG_IPV4 && tag !== TAG_IPV6) return undefined;
    if (value instanceof CborByteString || value instanceof CborArray)
      return new CborTaggedIpExt(tag, value);
    return undefined;
  },
};

export default ip;
