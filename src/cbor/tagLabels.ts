/**
 * Human-readable labels for tag numbers defined by RFC 9277 (On Stable
 * Storage for Items in CBOR), used to annotate `Tag N` hex-dump comments.
 */

/** RFC 9277 Appendix B: CoAP Content-Format tags, `0x63740101`..`0x6374FFFF`. */
const COAP_CT_TAG_MIN = 0x63740101n;
const COAP_CT_TAG_MAX = 0x6374ffffn;

/** RFC 9277 §2.1: protocol-specific (First Come First Served) 4-byte tags. */
const PROTOCOL_TAG_MIN = 0x01000000n;
const PROTOCOL_TAG_MAX = 0xffffffffn;

const NAMED_TAGS: ReadonlyMap<bigint, string> = new Map([
  [55799n, 'self-described CBOR'],
  [55800n, 'self-described CBOR Sequence'],
  [55801n, 'CBOR-labeled non-CBOR data'],
]);

/**
 * Inverse of RFC 9277 Appendix B's `TN(ct) = 0x63740101 + (ct / 255) *
 * 256 + ct % 255`: returns the CoAP Content-Format number `tag` stands for, or
 * `undefined` when `tag` isn't in that range. The mapping never produces a
 * zero byte, so a tag with a zero in either of its low two bytes isn't one.
 */
export function coapContentFormatOfTag(tag: bigint): number | undefined {
  if (tag < COAP_CT_TAG_MIN || tag > COAP_CT_TAG_MAX) return undefined;
  const hi = Number((tag >> 8n) & 0xffn);
  const lo = Number(tag & 0xffn);
  if (hi === 0 || lo === 0) return undefined;
  return (hi - 1) * 255 + (lo - 1);
}

/**
 * The four ASCII characters spelled by a protocol-specific tag number
 * (RFC 9277 §2.1 encourages a mnemonic of four ASCII codes, e.g.
 * `1330664270` = `0x4F50534E` = `"OPSN"`), or `undefined` when `tag` is
 * outside `0x01000000`..`0xFFFFFFFF` or any byte isn't printable ASCII
 * (`0x20`..`0x7E`).
 */
export function asciiMnemonicOfTag(tag: bigint): string | undefined {
  if (tag < PROTOCOL_TAG_MIN || tag > PROTOCOL_TAG_MAX) return undefined;
  let s = '';
  for (let shift = 24n; shift >= 0n; shift -= 8n) {
    const b = Number((tag >> shift) & 0xffn);
    if (b < 0x20 || b > 0x7e) return undefined;
    s += String.fromCharCode(b);
  }
  return s;
}

/**
 * RFC 9277 label for `tag`, for a hex-dump comment — `self-described CBOR`,
 * `CoAP Content-Format 112`, `"OPSN"` — or `undefined` when there's none.
 * The CoAP range is checked before the ASCII mnemonic: it is a specific
 * allocation, and its `"ct"` prefix would otherwise read as a mnemonic.
 */
export function rfc9277TagLabel(tag: bigint): string | undefined {
  const named = NAMED_TAGS.get(tag);
  if (named !== undefined) return named;
  const ct = coapContentFormatOfTag(tag);
  if (ct !== undefined) return `CoAP Content-Format ${ct}`;
  const ascii = asciiMnemonicOfTag(tag);
  if (ascii !== undefined) return JSON.stringify(ascii);
  return undefined;
}
