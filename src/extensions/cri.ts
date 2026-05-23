/**
 * Standard EDN "cri" / "CRI" application-extension (§5.2.5 draft-ietf-cbor-edn-literals-20).
 *
 * Converts URI references (RFC 3986) to CRI (Constrained Resource Identifier,
 * draft-ietf-core-href) CBOR array format and back.
 *
 * Syntax:
 *   cri'https://example.com/path'   → bare CRI array (no CBOR tag)
 *   CRI'https://example.com/path'   → tag(99, CRI array)
 *
 * CRI array structures (trailing defaults removed):
 *   Absolute:       [scheme, authority, path, ?query, ?fragment]
 *   Network-path:   [false, authority, path, ?query, ?fragment]
 *   Absolute-path:  [true, path, ?query, ?fragment]
 *   Relative-path:  [uint(discard), path, ?query, ?fragment]
 *   Same-document:  [0, ?query, ?fragment]
 *
 * where:
 *   scheme    = scheme-id (nint, e.g. -4 for https) or scheme-name (text)
 *   authority = [?userinfo, host, ?port]  — host is text labels or IP bytes
 *   path      = ["seg1", "seg2", ...]
 *   query     = ["k=v", ...]
 *   fragment  = text
 *   discard   = uint — number of path segments to remove from base before appending
 *               (1 = same directory, 2 = one level up "../", N = (N-1) levels up)
 *
 * Tag number 99 is used for the tagged "CRI" variant (draft-ietf-cbor-edn-literals-21 §3.4).
 */

import type { ToCDNOptions } from '../types';
import type { CborExtension } from './types';
import type { CborItem } from '../ast/CborItem';
import { CborArray } from '../ast/CborArray';
import { CborTag } from '../ast/CborTag';
import { CborNint } from '../ast/CborNint';
import { CborUint } from '../ast/CborUint';
import { CborTextString } from '../ast/CborTextString';
import { CborByteString } from '../ast/CborByteString';
import { CborSimple } from '../ast/CborSimple';
import { parseIPv4, parseIPv6, formatIPv4, formatIPv6 } from '../utils/ip';

// ─── Constants ────────────────────────────────────────────────────────────────

const PREFIX_CRI = 'cri';
const PREFIX_CRI_TAGGED = 'CRI';

/**
 * CBOR tag number for the tagged CRI variant (draft-ietf-cbor-edn-literals-21 §3.4 / §5.2.5).
 */
export const TAG_CRI = 99n;

// ─── Scheme-ID table ──────────────────────────────────────────────────────────

/**
 * Scheme-id values from the IANA URI Schemes Registry.
 * Formula: scheme-id = -(scheme-number + 1)
 * https://www.iana.org/assignments/uri-schemes/uri-schemes.xhtml
 */
const SCHEME_ID_BY_NAME = new Map<string, bigint>([
  ['coap', -1n],
  ['coaps', -2n],
  ['http', -3n],
  ['https', -4n],
  ['urn', -5n],
  ['did', -6n],
  ['coap+tcp', -7n],
  ['coaps+tcp', -8n],
  ['coap+ws', -25n],
  ['coaps+ws', -26n],
]);

const SCHEME_NAME_BY_ID = new Map<bigint, string>(
  [...SCHEME_ID_BY_NAME.entries()].map(([name, id]) => [id, name])
);

// ─── Percent-encoding helpers ─────────────────────────────────────────────────

function pctDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function pctEncodeChar(c: string): string {
  return Array.from(
    new TextEncoder().encode(c),
    (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  ).join('');
}

function encodePct(s: string, isAllowed: (c: string) => boolean): string {
  let out = '';
  for (const c of s) {
    out += isAllowed(c) ? c : pctEncodeChar(c);
  }
  return out;
}

// unreserved  = A-Za-z0-9 "-" "." "_" "~"
// sub-delims  = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "="
function isUnreserved(c: string): boolean {
  return /[A-Za-z0-9\-._~]/.test(c);
}
function isSubDelim(c: string): boolean {
  return /[!$&'()*+,;=]/.test(c);
}

// path segment: unreserved | sub-delims | ":" | "@"
function isPathAllowed(c: string): boolean {
  return isUnreserved(c) || isSubDelim(c) || c === ':' || c === '@';
}

// query item: path chars | "/" | "?" — but NOT "&" (used as item separator between items)
function isQueryItemAllowed(c: string): boolean {
  return (isPathAllowed(c) || c === '/' || c === '?') && c !== '&';
}

// fragment: same as query
function isFragmentAllowed(c: string): boolean {
  return isPathAllowed(c) || c === '/' || c === '?';
}

// userinfo: unreserved | sub-delims | ":" (RFC 3986 §3.2.1: ":" is allowed in userinfo)
function isUserinfoAllowed(c: string): boolean {
  return isUnreserved(c) || isSubDelim(c) || c === ':';
}

// registered name label: unreserved | sub-delims
function isRegNameAllowed(c: string): boolean {
  return isUnreserved(c) || isSubDelim(c);
}

// ─── Authority conversion ──────────────────────────────────────────────────────

/**
 * Parse URI authority string → CRI authority array.
 *
 * CRI authority = [?userinfo, host, ?port]
 *   userinfo = (false, text)          — two inline elements
 *   host-name = *text                 — zero-or-more text labels, inline
 *   host-ip   = bytes (4 or 16 bytes) — single inline element
 *   port      = uint 0..65535         — trailing optional element
 */
function parseAuthorityStr(authStr: string): CborArray {
  const items: CborItem[] = [];
  let str = authStr;

  // Strip userinfo (everything up to the last '@')
  const atIdx = str.indexOf('@');
  if (atIdx >= 0) {
    items.push(CborSimple.FALSE);
    items.push(new CborTextString(pctDecode(str.slice(0, atIdx))));
    str = str.slice(atIdx + 1);
  }

  // IPv6 bracket literal: [addr]:port
  let hostStr: string;
  let portStr: string | null = null;

  if (str.startsWith('[')) {
    const close = str.indexOf(']');
    if (close < 0)
      throw new SyntaxError('cri: unterminated IPv6 bracket in authority');
    hostStr = str.slice(1, close);
    const after = str.slice(close + 1);
    if (after.startsWith(':')) portStr = after.slice(1);
    else if (after.length > 0)
      throw new SyntaxError(
        `cri: unexpected characters after ']' in authority`
      );
    items.push(new CborByteString(parseIPv6(hostStr)));
  } else {
    // IPv4 address or registered name — find port via last ':'
    const colonIdx = str.lastIndexOf(':');
    if (colonIdx >= 0) {
      hostStr = str.slice(0, colonIdx);
      portStr = str.slice(colonIdx + 1);
    } else {
      hostStr = str;
    }

    if (hostStr === '') {
      // Empty host (e.g. file:///path) — zero labels, nothing pushed
    } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostStr)) {
      items.push(new CborByteString(parseIPv4(hostStr)));
    } else {
      // Registered name: split by '.' into lowercase labels
      for (const label of hostStr.toLowerCase().split('.')) {
        items.push(new CborTextString(label));
      }
    }
  }

  // Optional port
  if (portStr !== null && portStr !== '') {
    if (!/^\d+$/.test(portStr))
      throw new SyntaxError(`cri: invalid port: ${JSON.stringify(portStr)}`);
    const port = parseInt(portStr, 10);
    if (port > 65535) throw new SyntaxError(`cri: port ${port} out of range`);
    items.push(new CborUint(BigInt(port)));
  }

  return new CborArray(items);
}

/**
 * Convert CRI authority array → URI authority string.
 */
function criAuthorityToUri(auth: CborArray): string {
  const items = auth.items;
  let idx = 0;
  let result = '';

  // Userinfo: (false, text) as two consecutive elements
  if (
    idx < items.length &&
    items[idx] instanceof CborSimple &&
    (items[idx] as CborSimple).value === 20
  ) {
    idx++; // skip false sentinel
    const user = items[idx++] as CborTextString;
    result += encodePct(user.value, isUserinfoAllowed) + '@';
  }

  if (idx >= items.length) return result; // empty host

  const hostFirst = items[idx];
  if (hostFirst instanceof CborByteString) {
    idx++;
    const { length } = hostFirst.value;
    if (length === 4) {
      result += formatIPv4(hostFirst.value);
    } else if (length === 16) {
      result += '[' + formatIPv6(hostFirst.value) + ']';
    } else {
      throw new Error(`cri: unexpected host-ip byte length: ${length}`);
    }
    // Optional zone-id (text string immediately after the IP bytes)
    if (idx < items.length && items[idx] instanceof CborTextString) {
      result += `%25${encodePct((items[idx++] as CborTextString).value, isRegNameAllowed)}`;
    }
  } else {
    // Registered name: consecutive text strings up to the optional uint port
    const labels: string[] = [];
    while (idx < items.length && items[idx] instanceof CborTextString) {
      labels.push(
        encodePct((items[idx++] as CborTextString).value, isRegNameAllowed)
      );
    }
    result += labels.join('.');
  }

  // Optional port
  if (idx < items.length && items[idx] instanceof CborUint) {
    result += ':' + (items[idx] as CborUint).value.toString();
  }

  return result;
}

// ─── CRI array ↔ URI string ───────────────────────────────────────────────────

/**
 * Parse `//authority/path` from a string starting with `//`.
 * Returns the CRI authority array and path segments.
 */
function _parseHierarchicalPart(rest: string): {
  authority: CborArray;
  pathSegments: CborTextString[];
} {
  const afterSlashes = rest.slice(2);
  const slashIdx = afterSlashes.indexOf('/');
  let authStr: string;
  let pathSegments: CborTextString[];
  if (slashIdx >= 0) {
    authStr = afterSlashes.slice(0, slashIdx);
    const pathStr = afterSlashes.slice(slashIdx + 1);
    pathSegments = pathStr
      .split('/')
      .map((s) => new CborTextString(pctDecode(s)));
  } else {
    authStr = afterSlashes;
    pathSegments = [];
  }
  return { authority: parseAuthorityStr(authStr), pathSegments };
}

/**
 * Parse a URI or URI-reference string into CRI array items.
 *
 * Supports all RFC 3986 reference forms:
 *   Absolute URI:       https://example.com/path  → [scheme, authority, path, ...]
 *   Network-path ref:   //other.example.com/path  → [false, authority, path, ...]
 *   Absolute-path ref:  /abs/path                 → [true, path, ...]
 *   Relative-path ref:  foo, ../bar               → [uint(discard), path, ...]
 *   Same-document ref:  #frag, ?q=1, (empty)      → [0, ...]
 *
 * Produces a compact representation with trailing defaults removed.
 */
function uriToCriItems(str: string): CborItem[] {
  // ── 1. Fragment ────────────────────────────────────────────────────────────
  let rest = str;
  let fragment: string | null = null;
  const hashIdx = rest.indexOf('#');
  if (hashIdx >= 0) {
    fragment = pctDecode(rest.slice(hashIdx + 1));
    rest = rest.slice(0, hashIdx);
  }

  // ── 2. Query ───────────────────────────────────────────────────────────────
  let queryItems: CborTextString[] | null = null;
  const qIdx = rest.indexOf('?');
  if (qIdx >= 0) {
    const qs = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
    // Per draft-ietf-core-href §5.1:
    //   [] (empty array) = absent query (no "?")  — this is the trailing default
    //   [""] (one empty string) = present but empty query ("?")
    //   ["k=v", ...] = query with parameters
    queryItems = qs.split('&').map((s) => new CborTextString(pctDecode(s)));
  }

  // ── 3. Detect reference form and build leading items ───────────────────────
  const items: CborItem[] = [];

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):([\s\S]*)$/.exec(rest);
  if (schemeMatch) {
    // Absolute URI: scheme + hier-part
    const schemeName = schemeMatch[1].toLowerCase();
    const hierPart = schemeMatch[2];
    const schemeId = SCHEME_ID_BY_NAME.get(schemeName);
    items.push(
      schemeId !== undefined
        ? new CborNint(schemeId)
        : new CborTextString(schemeName)
    );
    if (hierPart.startsWith('//')) {
      const { authority, pathSegments } = _parseHierarchicalPart(hierPart);
      items.push(authority, new CborArray(pathSegments));
    } else if (hierPart.startsWith('/')) {
      const pathSegments = hierPart
        .slice(1)
        .split('/')
        .map((s) => new CborTextString(pctDecode(s)));
      items.push(CborSimple.NULL, new CborArray(pathSegments));
    } else {
      const pathSegments = hierPart
        .split('/')
        .map((s) => new CborTextString(pctDecode(s)));
      items.push(CborSimple.TRUE, new CborArray(pathSegments));
    }
  } else if (rest.startsWith('//')) {
    // Network-path reference: //authority/path
    const { authority, pathSegments } = _parseHierarchicalPart(rest);
    items.push(CborSimple.FALSE, authority, new CborArray(pathSegments));
  } else if (rest.startsWith('/')) {
    // Absolute-path reference: /path
    const pathSegments = rest
      .slice(1)
      .split('/')
      .map((s) => new CborTextString(pctDecode(s)));
    items.push(CborSimple.TRUE, new CborArray(pathSegments));
  } else if (rest === '') {
    // Same-document reference (only query/fragment differ from base)
    items.push(new CborUint(0n));
  } else {
    // Relative-path reference: count leading ../ sequences
    let discard = 1n;
    let pathRest = rest;
    let hasDotSlash = false;
    if (pathRest.startsWith('./')) {
      hasDotSlash = true;
      pathRest = pathRest.slice(2);
    }
    while (pathRest.startsWith('../')) {
      discard++;
      pathRest = pathRest.slice(3);
    }
    // Handle lone '..' or '.' at end
    if (pathRest === '..') {
      discard++;
      pathRest = '';
    } else if (pathRest === '.') {
      pathRest = '';
    }
    // RFC 3986 §3.3 path-noscheme: the first segment of a relative-path reference
    // must not contain ':' unless the path was explicitly prefixed with "./"
    // (which disambiguates it from a scheme). Without "./" the colon makes the
    // reference look like an absolute URI to parsers, and is most likely a typo.
    // This check applies only when discard=1 (same-directory) and no "./" was given.
    // For discard≥2 (e.g. "../foo:bar") the leading "../" already disambiguates.
    if (discard === 1n && !hasDotSlash && pathRest !== '') {
      const firstSeg = pathRest.split('/')[0];
      if (firstSeg.includes(':'))
        throw new SyntaxError(
          `cri: invalid relative-path reference — first segment must not contain ':' without a './' prefix (RFC 3986 §3.3): ${JSON.stringify(str)}`
        );
    }
    const pathSegments =
      pathRest === ''
        ? []
        : pathRest.split('/').map((s) => new CborTextString(pctDecode(s)));
    items.push(new CborUint(discard), new CborArray(pathSegments));
  }

  // ── 4. Append query and fragment ──────────────────────────────────────────
  if (queryItems !== null) items.push(new CborArray(queryItems));
  if (fragment !== null) {
    // When fragment is present but query is absent, use null as placeholder so that
    // "no query" is distinguishable from "empty query []" at the query position.
    if (queryItems === null) items.push(CborSimple.NULL);
    items.push(new CborTextString(fragment));
  }

  // ── 5. Trim trailing defaults ─────────────────────────────────────────────
  // Remove null placeholder for absent query (always at items.length - 2 when present)
  if (fragment !== null && queryItems === null) {
    items.splice(items.length - 2, 1);
  }
  // Remove trailing empty PATH array — but only when it is truly the last element
  // (i.e., neither a query nor a fragment follows it). An empty QUERY array []
  // means "query is present but empty" (?), which must be preserved.
  if (queryItems === null && fragment === null) {
    const last = items[items.length - 1];
    if (last instanceof CborArray && last.items.length === 0) {
      items.pop();
    }
  }

  // ── 6. Canonical same-document form ──────────────────────────────────────
  // Per §5.2: [discard=0] with no other items is sent as [] (empty array).
  if (
    items.length === 1 &&
    items[0] instanceof CborUint &&
    (items[0] as CborUint).value === 0n
  ) {
    return [];
  }

  return items;
}

/**
 * Encode query and fragment items from `items[startIdx..]` into a URI suffix string.
 * Handles both the `[] = empty query`, `[items] = query params`, `null = absent query`,
 * and optional trailing text fragment.
 */
function _criSuffix(items: readonly CborItem[], startIdx: number): string {
  let idx = startIdx;
  let result = '';

  if (idx < items.length) {
    const qi = items[idx];
    if (qi instanceof CborArray) {
      idx++;
      // Per §5.1 / draft-ietf-core-href:
      //   [] (empty array) = absent query — omit "?" entirely (trailing default)
      //   [""] = present but empty query — emit "?"
      //   ["k=v", ...] = query with parameters — emit "?k=v&..."
      if (qi.items.length > 0) {
        const params = qi.items.map((s) => {
          if (!(s instanceof CborTextString))
            throw new Error('cri: query item must be a text string');
          return encodePct(s.value, isQueryItemAllowed);
        });
        result += '?' + params.join('&');
      }
      // [] = absent query → no '?' emitted
    } else if (qi instanceof CborSimple && qi.value === 22) {
      idx++; // explicit null = absent query component
    }
    // else: not a query item (text fragment follows); leave idx unchanged
  }

  if (idx < items.length && items[idx] instanceof CborTextString) {
    result +=
      '#' + encodePct((items[idx] as CborTextString).value, isFragmentAllowed);
  }

  return result;
}

/**
 * Encode a CRI path array into URI path segments.
 */
function _criPathSegs(pathArr: CborArray): string[] {
  return pathArr.items.map((s) => {
    if (!(s instanceof CborTextString))
      throw new Error('cri: path segment must be a text string');
    return encodePct(s.value, isPathAllowed);
  });
}

/**
 * Convert CRI array items → URI string.
 *
 * Handles all CRI reference forms:
 *   Absolute:       first element is CborNint or CborTextString (scheme)
 *   Network-path:   first element is false (CborSimple(20))
 *   Absolute-path:  first element is true (CborSimple(21))
 *   Relative-path:  first element is CborUint (discard count ≥ 1)
 *   Same-document:  first element is CborUint(0)
 */
function criItemsToUri(items: readonly CborItem[]): string {
  // Per §5.2: [] (empty array) is the canonical form of the same-document
  // reference [discard=0] with no query or fragment.
  if (items.length === 0) return '';

  let idx = 0;
  const first = items[idx++];

  // ── Absolute URI ──────────────────────────────────────────────────────────
  if (first instanceof CborNint || first instanceof CborTextString) {
    let schemePart: string;
    if (first instanceof CborNint) {
      const name = SCHEME_NAME_BY_ID.get(first.value);
      if (name === undefined)
        throw new Error(`cri: unrecognised scheme-id ${first.value}`);
      schemePart = name + ':';
    } else {
      schemePart = (first as CborTextString).value + ':';
    }

    if (idx >= items.length) return schemePart;

    const second = items[idx++];
    let authorityPart = '';
    let rootedPath = false;

    if (second instanceof CborArray) {
      authorityPart = '//' + criAuthorityToUri(second);
      rootedPath = true;
    } else if (second instanceof CborSimple) {
      if (second.value === 22)
        rootedPath = true; // null = NOAUTH-ROOTBASED
      else if (second.value === 21)
        rootedPath = false; // true = NOAUTH-ROOTLESS
      else
        throw new Error(
          `cri: unexpected no-authority value: simple(${second.value})`
        );
    } else {
      throw new Error('cri: unexpected type for authority element');
    }

    let pathPart = '';
    if (idx < items.length && items[idx] instanceof CborArray) {
      const pathArr = items[idx++] as CborArray;
      if (pathArr.items.length > 0) {
        pathPart = (rootedPath ? '/' : '') + _criPathSegs(pathArr).join('/');
      }
    }

    return schemePart + authorityPart + pathPart + _criSuffix(items, idx);
  }

  // ── Network-path reference: [false, authority-array, path-array, ...] ─────
  if (first instanceof CborSimple && first.value === 20) {
    if (idx >= items.length || !(items[idx] instanceof CborArray))
      throw new Error(
        'cri: network-path reference requires an authority array'
      );
    const authority = criAuthorityToUri(items[idx++] as CborArray);
    let pathPart = '';
    if (idx < items.length && items[idx] instanceof CborArray) {
      const pathArr = items[idx++] as CborArray;
      if (pathArr.items.length > 0) {
        pathPart = '/' + _criPathSegs(pathArr).join('/');
      }
    }
    return '//' + authority + pathPart + _criSuffix(items, idx);
  }

  // ── Absolute-path reference: [true, path-array, ...] ─────────────────────
  if (first instanceof CborSimple && first.value === 21) {
    let pathPart = '/';
    if (idx < items.length && items[idx] instanceof CborArray) {
      const pathArr = items[idx++] as CborArray;
      pathPart = '/' + _criPathSegs(pathArr).join('/');
    }
    return pathPart + _criSuffix(items, idx);
  }

  // ── Relative-path / same-document: [uint(discard), ...] ──────────────────
  if (first instanceof CborUint) {
    const discard = first.value;

    if (discard === 0n) {
      // Same-document reference: path unchanged, only query/fragment differ
      return _criSuffix(items, idx);
    }

    // discard=1 → same directory (no "../" prefix)
    // discard=N → (N-1) "../" prefixes
    const dotdots = discard === 1n ? '' : '../'.repeat(Number(discard) - 1);

    let pathPart: string;
    if (idx < items.length && items[idx] instanceof CborArray) {
      const pathArr = items[idx++] as CborArray;
      if (pathArr.items.length > 0) {
        const segs = _criPathSegs(pathArr);
        // §6.1: when discard=1, prefix with "./" if the first segment contains ":"
        // to prevent URI parsers from misreading it as a scheme (RFC 3986 §3.3).
        const needsDotSlash = discard === 1n && segs[0].includes(':');
        pathPart = (needsDotSlash ? './' : dotdots) + segs.join('/');
      } else {
        // Empty path array (should be trimmed, but handle defensively)
        pathPart = dotdots === '' ? './' : dotdots;
      }
    } else {
      // No path array (trimmed away)
      pathPart = dotdots === '' ? './' : dotdots;
    }

    return pathPart + _criSuffix(items, idx);
  }

  throw new Error(`cri: unrecognised first element type in CRI array`);
}

// ─── CborItem subclasses ──────────────────────────────────────────────────────

/**
 * Bare CRI array whose toCDN() emits cri'…' notation.
 * Falls back to generic array notation if the content cannot be expressed as a URI.
 */
export class CborCriExt extends CborArray {
  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, depth);
    try {
      return `${PREFIX_CRI}'${criItemsToUri(this.items)}'`;
    } catch {
      return super._toCDN(options, depth);
    }
  }
}

/**
 * tag(99, CRI array) whose toCDN() emits CRI'…' notation.
 * Falls back to generic tag notation if the content cannot be expressed as a URI.
 */
export class CborTaggedCriExt extends CborTag {
  constructor(content: CborArray) {
    super(TAG_CRI, content);
  }

  override _toCDN(options: ToCDNOptions | undefined, depth: number): string {
    if (options?.appStrings === false) return super._toCDN(options, depth);
    try {
      return `${PREFIX_CRI_TAGGED}'${criItemsToUri((this.content as CborArray).items)}'`;
    } catch {
      return super._toCDN(options, depth);
    }
  }
}

// ─── Builder ──────────────────────────────────────────────────────────────────

function stringFromAppSequence(items: CborItem[]): string {
  if (items.length !== 1)
    throw new SyntaxError('cri<<...>>: expected exactly one item');
  const item = items[0];
  if (item instanceof CborTextString) return item.value;
  if (item instanceof CborByteString)
    return new TextDecoder('utf-8', { fatal: true }).decode(item.value);
  throw new SyntaxError('cri<<...>>: expected a text string or byte string');
}

function buildCriValue(prefix: string, uri: string): CborItem {
  const criItems = uriToCriItems(uri);
  const arr = new CborCriExt(criItems);
  if (prefix === PREFIX_CRI_TAGGED) return new CborTaggedCriExt(arr);
  return arr;
}

// ─── Extension factory ────────────────────────────────────────────────────────

/**
 * Create the cri/CRI CborExtension (§5.2.5 draft-ietf-cbor-edn-literals-20).
 *
 * - `cri'uri'`        → CborCriExt (bare CRI array, no CBOR tag)
 * - `CRI'uri'`        → CborTaggedCriExt tag(99, CRI array)
 * - parseTag(99n, …)  → CborTaggedCriExt (roundtrip from CBOR binary)
 */
export const cri: CborExtension = {
  appStringPrefixes: [PREFIX_CRI, PREFIX_CRI_TAGGED],
  tagNumbers: [TAG_CRI],

  parseAppString(prefix: string, content: string): CborItem {
    return buildCriValue(prefix, content);
  },

  parseAppSequence(prefix: string, items: CborItem[]): CborItem {
    return buildCriValue(prefix, stringFromAppSequence(items));
  },

  parseTag(tag: bigint, value: CborItem): CborItem | undefined {
    if (tag !== TAG_CRI) return undefined;
    if (!(value instanceof CborArray)) return undefined;
    const inner = new CborCriExt(value.items, {
      indefiniteLength: value.indefiniteLength,
      encodingWidth: value.encodingWidth,
    });
    return new CborTaggedCriExt(inner);
  },
};

export default cri;
