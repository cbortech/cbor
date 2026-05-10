/**
 * Shared IPv4 / IPv6 address parsing and formatting utilities.
 * Used by the "ip"/"IP" extension (RFC 9164) and the "cri"/"CRI" extension
 * (draft-ietf-core-href).
 */

// ─── Parsing ──────────────────────────────────────────────────────────────────

export function parseIPv4(str: string): Uint8Array {
  const parts = str.split('.');
  if (parts.length !== 4)
    throw new SyntaxError(`ip: invalid IPv4 address: ${JSON.stringify(str)}`);
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const s = parts[i];
    if (!/^\d+$/.test(s) || (s.length > 1 && s[0] === '0'))
      throw new SyntaxError(`ip: invalid IPv4 octet: ${JSON.stringify(s)}`);
    const n = parseInt(s, 10);
    if (n > 255) throw new SyntaxError(`ip: IPv4 octet out of range: ${n}`);
    bytes[i] = n;
  }
  return bytes;
}

export function parseIPv6(str: string): Uint8Array {
  const bytes = new Uint8Array(16);
  if (str === '::') return bytes;

  // Handle IPv4-mapped suffix, e.g. ::ffff:192.0.2.1
  let head = str;
  let ipv4Tail: Uint8Array | null = null;
  const ipv4Match = str.match(/^(.*):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4Match) {
    head = ipv4Match[1];
    if (head.endsWith(':')) head += ':'; // restore :: split by the regex
    ipv4Tail = parseIPv4(ipv4Match[2]);
  }

  const halves = head.split('::');
  if (halves.length > 2)
    throw new SyntaxError(`ip: invalid IPv6 address: ${JSON.stringify(str)}`);

  const doubleColon = halves.length === 2;
  const leftParts = halves[0] ? halves[0].split(':') : [];
  const rightParts = doubleColon && halves[1] ? halves[1].split(':') : [];
  const totalGroups = ipv4Tail ? 6 : 8;

  if (!doubleColon && leftParts.length !== totalGroups)
    throw new SyntaxError(`ip: invalid IPv6 address: ${JSON.stringify(str)}`);
  if (doubleColon && leftParts.length + rightParts.length >= totalGroups)
    throw new SyntaxError(`ip: invalid IPv6 address: ${JSON.stringify(str)}`);

  const zeroCount = totalGroups - leftParts.length - rightParts.length;
  const groups = [...leftParts, ...Array(zeroCount).fill('0'), ...rightParts];

  let offset = 0;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g))
      throw new SyntaxError(`ip: invalid IPv6 group: ${JSON.stringify(g)}`);
    const n = parseInt(g, 16);
    bytes[offset++] = (n >> 8) & 0xff;
    bytes[offset++] = n & 0xff;
  }
  if (ipv4Tail) bytes.set(ipv4Tail, 12);
  return bytes;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatIPv4(bytes: Uint8Array): string {
  return Array.from(bytes).join('.');
}

export function formatIPv6(bytes: Uint8Array): string {
  // RFC 5952 §5: IPv4-mapped (::ffff:a.b.c.d) — bytes 0-9 zero, 10-11 = 0xffff
  const isIpv4Mapped =
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;

  const ipv4Suffix = isIpv4Mapped ? formatIPv4(bytes.slice(12)) : null;

  const hexGroups = ipv4Suffix ? 6 : 8;
  const groups: number[] = [];
  for (let i = 0; i < hexGroups * 2; i += 2)
    groups.push((bytes[i] << 8) | bytes[i + 1]);

  // RFC 5952 §4.2.3: find longest run of consecutive zero groups (≥ 2) for ::
  let bestStart = -1,
    bestLen = 0;
  let i = 0;
  while (i < hexGroups) {
    if (groups[i] === 0) {
      let j = i + 1;
      while (j < hexGroups && groups[j] === 0) j++;
      if (j - i > bestLen) {
        bestStart = i;
        bestLen = j - i;
      }
      i = j;
    } else {
      i++;
    }
  }
  if (bestLen < 2) bestStart = -1;

  const fmt = (g: number) => g.toString(16);
  let hexPart: string;
  if (bestStart === -1) {
    hexPart = groups.map(fmt).join(':');
  } else {
    const left = groups.slice(0, bestStart).map(fmt).join(':');
    const right = groups
      .slice(bestStart + bestLen)
      .map(fmt)
      .join(':');
    hexPart = `${left}::${right}`;
  }

  return ipv4Suffix ? `${hexPart}:${ipv4Suffix}` : hexPart;
}
