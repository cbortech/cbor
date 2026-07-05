export interface Sample {
  name: string;
  cdn: string;
}

export const SAMPLES: Sample[] = [
  {
    name: 'Hello CBOR',
    cdn: `{
  # Concise Diagnostic Notation (CDN / CBOR-EDN) — edit me!
  "name": "CBOR",
  "spec": 8949,
  "binary": h'001122deadbeef',
  "nested": { "list": [1, 2, 3], "ok": true },
  "nothing": null,
}`,
  },
  {
    name: 'Indefinite lengths',
    cdn: `[_
  "streamed array",
  (_ h'0011', h'2233'),     # chunked byte string
  (_ "chunked ", "text"),
  [_ 1, 2, 3],
]`,
  },
  {
    name: 'Tags & big numbers',
    cdn: `{
  "timestamp": 1(1749772800),
  "rfc3339": 0("2026-06-13T00:00:00Z"),
  "bignum": 18446744073709551616,
  "negative": -18446744073709551617,
  "embedded": <<1, [2, 3]>>,
}`,
  },
  {
    name: 'Numbers & precision',
    cdn: `{
  # Integers — try Format → Integers: Hex / Octal / Binary
  "decimal": 255,
  "hex":     0xff,
  "octal":   0o377,
  "binary":  0b11111111,
  "neg-hex": -0x10,
  "wide":    1_2,           # 1 encoded in 4 bytes (encoding indicator)

  # Floats — try Format → Floats: Hex (C99)
  "half":    1.5_1,         # float16
  "single":  0.25_2,        # float32
  "double":  1.1,           # float64
  "hex-f16": 0x1.8p+0_1,   # float16 via C99 hex: 1.5
  "hex-f32": 0x1.8p+0_2,   # float32 via C99 hex: 1.5
  "special": [Infinity, -Infinity, NaN],

  "simple":  simple(99),
  "undef":   undefined,
}`,
  },
  {
    name: 'String concatenation (+)',
    cdn: `{
  # Text and byte strings can be split with +.
  # Note: + concatenation was removed in draft-26; this is legacy syntax.
  # Try Format → Text strings: Newline or CDN to auto-split.
  "poem": "Roses are red,\\n" +
    "Violets are blue,\\n" +
    "CBOR is binary,\\n" +
    "CDN is for you.",
  "bytes": h'deadbeef' +
    h'cafebabe',

  # Strings containing JSON/CDN are split at brackets with 'CDN' mode.
  "array-json": "[" +
      "1, " +
      "2, " +
      "3" +
    "]",
  "object-json": "{" +
      "\\"key\\": \\"value\\"" +
    "}",
}`,
  },
  {
    name: 'JSON is valid CDN',
    cdn: `{
  // JSON and JSONC parse as-is — CDN is a superset.
  "menu": {
    "id": "file",
    "items": [
      { "label": "Open", "key": "ctrl+o" },
      { "label": "Save", "key": "ctrl+s" }
    ],
    "version": 2.1
  }
}`,
  },
  {
    name: 'App strings: UUID & datetime',
    cdn: `{
  # UUID (tag 37) — requires @cbortech/uuid-extension
  "id": UUID'550e8400-e29b-41d4-a716-446655440000',
  # DT wraps the epoch in tag(1); dt gives a bare epoch number
  "created": DT'2026-06-14T00:00:00Z',
  "expires": dt'2027-01-01T00:00:00Z',
}`,
  },
  {
    name: 'App strings: network & URI',
    cdn: `{
  "ipv4":   ip'192.0.2.1',
  "ipv6":   ip'2001:db8::1',
  "prefix": ip'10.0.0.0/8',
  "url":    cri'https://example.com/api/v1?q=cbor',
  # IP / CRI wrap the value in a CBOR tag
  "tagged-ip":  IP'192.0.2.1',
  "tagged-url": CRI'https://example.com',
}`,
  },
  {
    name: 'App strings: encoding & hash',
    cdn: `[
  b32'AEBAGBAF',          # base32 byte string
  h32'01A0C294',          # base32hex byte string
  float'3c00',            # float16 bits: 1.0
  float'3f800000',        # float32 bits: 1.0
  same<<h'cafe', b32'ZL7A'>>,   # assertion: two encodings of the same bytes
  # hash'...' — requires @cbortech/hash-extension
  hash'SHA-256;base64url:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
]`,
  },
  {
    name: 'App sequences: Set & Map',
    cdn: `{
  # SET / MAP require @cbortech/set-map-extensions.
  # SET uses tag 258 over an array; MAP uses tag 259 over a map.
  "roles": SET<<["admin", "editor", "viewer"]>>,
  "scores": MAP<<{
    "alice": 98,
    "bob": 72,
    "carol": 85,
  }>>,
}`,
  },
  {
    name: 'App strings: t1/b1 & ilbs/ilts',
    cdn: `{
  # draft-26 extensions t1 / b1 join (text or byte) strings into one.
  "text":  t1<<"Hello ", "world">>,
  "mixed": t1<<"Hello", h'20', "world">>,
  "bytes": b1<<'Hello ', h'776f726c64'>>,
  # An ellipsis elides part of a string (tag 888)
  "elided": t1<<"Herewith I buy", ..., "signed: Alice & Bob">>,

  # ilbs / ilts build indefinite-length strings, one chunk per argument
  "il-bytes": ilbs<<h'0011', h'2233'>>,
  "il-text":  ilts<<"chunked ", "text">>,
  "il-ei":    ilbs<<'Hello '_0, 'world'>>,  # per-chunk encoding indicator
}`,
  },
  {
    name: 'CDN Sequence',
    cdn: `# CDN Sequence — multiple items separated by whitespace, comma, or comment.
# Output is a CBOR Sequence (RFC 8742): concatenated CBOR items.

{ "event": "start", "ts": DT'2026-06-01T00:00:00Z' }
{ "event": "data",  "value": 42 }
{ "event": "end",   "ts": DT'2026-06-01T00:01:00Z' }`,
  },
  {
    name: 'JSONL / NDJSON',
    cdn: `{"id": 1, "name": "Alice", "score": 98.5}
{"id": 2, "name": "Bob",   "score": 72.0}
{"id": 3, "name": "Carol", "score": 85.3}`,
  },
];

export const DEFAULT_SAMPLE = SAMPLES[0]!.cdn;
