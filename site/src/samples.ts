export interface Sample {
  name: string;
  /** CDN instance loaded into the CDN editor. */
  cdn: string;
  /**
   * Matching CDDL schema. Loaded into the CDDL pane alongside the CDN;
   * validation runs only while the CDDL pane is open.
   */
  cddl: string;
}

export const SAMPLES: Sample[] = [
  {
    name: 'All CBOR types',
    cdn: `{
  # Concise Diagnostic Notation (CDN / CBOR-EDN) — edit me!
  # One value of each CBOR major type / simple value below.
  "unsigned":  8949,                # major type 0: unsigned integer
  "negative":  -18,                 # major type 1: negative integer
  "bytes":     h'001122deadbeef',   # major type 2: byte string
  "text":      "CBOR",              # major type 3: text string
  "array":     [1, 2, 3],           # major type 4: array
  "map":       { "ok": true },      # major type 5: map
  "tagged":    1(1749772800),       # major type 6: tag
  "simple":    simple(99),          # major type 7: simple value
  "float":     3.14,                # major type 7: float
  "true":      true,                # major type 7
  "false":     false,               # major type 7
  "null":      null,                # major type 7
  "undefined": undefined,           # major type 7
}`,
    cddl: `; CDDL (RFC 8610) — the schema language for CBOR. Edit me!
cbor-types = {
  "unsigned": uint,
  "negative": nint,
  "bytes": bstr,
  "text": tstr .size (1..32),
  "array": [* int],
  "map": { "ok": bool },
  "tagged": time,          ; tag 1 = epoch-based date/time
  "simple": #7.99,
  "float": float,
  "true": true,
  "false": false,
  "null": null,
  "undefined": undefined,
}`,
  },
  {
    name: 'Comments (§2.2)',
    cdn: `{
  # Comments (§2.2) — four forms, all ignored while parsing.
  "hash-comment":  1,   # end-of-line, starting with #
  "slash-slash":   2,   // end-of-line, starting with //
  /* a block comment
     can span multiple lines */
  "block-star":    3,
  / a single-slash block comment /
  "block-slash":   4,

  # Byte strings can carry comments *inside* the quotes too.
  "hex": h'0011  # a hash comment right inside the byte string
              2233 / and a slash comment / 4455',

  # b64'...' only recognizes # inside the quotes — / is itself a valid
  # base64 digit (e.g. 0xff 0xff encodes to //8=, not a "//" comment).
  "b64": b64'//8=   # this trailing bit really is a comment
              ',
}`,
    cddl: `comments = {
  "hash-comment": uint,
  "slash-slash": uint,
  "block-star": uint,
  "block-slash": uint,
  "hex": bstr,
  "b64": bstr,
}`,
  },
  {
    name: 'Encoding indicators (§2.3)',
    cdn: `{
  # Encoding Indicators (§2.3) force a specific (often non-shortest) CBOR
  # header width for a value, independent of what the value itself needs.
  # AI = 24 + N, so _0/_1/_2/_3 pick a 1/2/4/8-byte header; _i forces the
  # immediate (in-header) form for small values. Open the bytes pane to
  # see each header widen as the value below grows.
  "int-short": 1,      # shortest form CDN would pick on its own
  "int-0":     1_0,    # 1-byte header (AI 24)
  "int-1":     1_1,    # 2-byte header (AI 25)
  "int-2":     1_2,    # 4-byte header (AI 26)
  "int-3":     1_3,    # 8-byte header (AI 27)
  "int-i":     1_i,    # forces the immediate/in-header form explicitly

  "float-16":  1.5_1,  # _1 / _2 / _3 select float16 / float32 / float64
  "float-32":  1.5_2,
  "float-64":  1.5_3,

  "text":  "A"_1,      # 2-byte text-string length header
  "bytes": h'ff'_2,    # 4-byte byte-string length header
  "tag":   5_1(42),    # 2-byte tag-number header

  "array": [_1 1, 2],    # 2-byte array-length header
  "map":   {_i "a": 1},  # _i forces the immediate map-length header
}`,
    cddl: `encoding-indicators = {
  "int-short": uint,
  "int-0": uint,
  "int-1": uint,
  "int-2": uint,
  "int-3": uint,
  "int-i": uint,
  "float-16": float16,
  "float-32": float32,
  "float-64": float64,
  "text": tstr,
  "bytes": bstr,
  "tag": #6.5(uint),
  "array": [* uint],
  "map": { "a": uint },
}`,
  },
  {
    name: 'Numbers (§2.4)',
    cdn: `{
  # Numbers (§2.4) — integer bases, sign quirks, and float forms.
  "decimal": 255,
  "hex":     0xff,
  "octal":   0o377,
  "binary":  0b11111111,
  "neg-hex": -0x10,

  # 0, +0, and -0 are all the *same* unsigned integer — signed zero only
  # exists for floats, not integers.
  "zero":      0,
  "zero-plus": +0,
  "zero-neg":  -0,

  "leading-dot":    .5,        # same as 0.5
  "exponent":       3.14e-2,   # 0.0314
  "neg-zero-float": -0.0,      # unlike integer -0, this DOES keep its sign

  "nan":          NaN,
  "infinity":     Infinity,
  "neg-infinity": -Infinity,

  "hex-float": 0x1.8p+0,    # C99 hex float syntax: 1.5
}`,
    cddl: `numbers = {
  "decimal": uint,
  "hex": uint,
  "octal": uint,
  "binary": uint,
  "neg-hex": nint,
  "zero": uint,
  "zero-plus": uint,
  "zero-neg": uint,
  "leading-dot": float,
  "exponent": float,
  "neg-zero-float": float,
  "nan": float,
  "infinity": float,
  "neg-infinity": float,
  "hex-float": float,
}`,
  },
  {
    name: 'Strings (§2.5)',
    cdn: `{
  # Strings (§2.5) — double-quoted text, single-quoted bytes, and raw
  # (backtick) literals that skip escaping altogether.
  "text":  "Hello",              # double-quoted -> text string (UTF-8)
  "bytes": 'Hello',               # single-quoted -> byte string (raw UTF-8 bytes)

  # Escapes work in both quote styles; a few examples:
  "escaped": "line one\\nline two\\t\\"quoted\\"\\\\backslash",
  "unicode": "caf\\u00e9",         # \\uXXXX -> e-acute

  # Raw string literals (backtick-delimited) need no escaping at all.
  "raw":       \`no \\n escapes here, this is literal backslash-n\`,
  "raw-quote": \`\`a literal \` backtick, using a longer delimiter\`\`,

  # A leading newline right after the opening backtick is stripped --
  # handy for multi-line literals that start on their own line.
  "raw-multiline": \`
    first line
    second line\`,

  # Byte strings can also be spelled as hex or base64.
  "hex": h'48656c6c6f',
  "b64": b64'SGVsbG8=',

  # ...and those have raw (backtick) forms too, still with no escaping.
  "hex-raw": h\`48 65 6c 6c 6f\`,
  "b64-raw": b64\`SGVsbG8=\`,
}`,
    cddl: `strings = {
  "text": tstr,
  "bytes": bstr,
  "escaped": tstr,
  "unicode": tstr,
  "raw": tstr,
  "raw-quote": tstr,
  "raw-multiline": tstr,
  "hex": bstr,
  "b64": bstr,
  "hex-raw": bstr,
  "b64-raw": bstr,
}`,
  },
  {
    name: 'Arrays, Maps, Tags & Simple values (§2.6–§2.8)',
    cdn: `{
  # Arrays and Maps (§2.6) — commas are optional; §2.7 Tags: n(item);
  # §2.8 Simple values: true/false/null/undefined/simple(N) (see also
  # the "All CBOR types" sample).
  "array":          [1, 2, 3],
  "array-nested":   [1, [2, 3]],
  "no-commas":      [1 2 3],       # whitespace alone separates items
  "trailing-comma": [1, 2, 3,],

  "map":        {1: "one", true: "yes"},   # keys can be any CBOR value
  "map-nested": {"a": {"b": 1}},

  "tag":        1(1749772800),
  "tag-nested": 6(["a", "b"]),

  "simple": simple(255),   # the general form; true/false/null/undefined
                            # are simple values too, with dedicated keywords
}`,
    cddl: `arrays-maps-tags-simple = {
  "array": [3*3 uint],
  "array-nested": [uint, [2*2 uint]],
  "no-commas": [3*3 uint],
  "trailing-comma": [3*3 uint],
  ; "true" as a bareword key would mean the literal text string "true";
  ; => forces it to be read as the boolean value true instead.
  "map": { 1: tstr, true => tstr },
  "map-nested": { "a": { "b": uint } },
  "tag": time,
  "tag-nested": #6.6([* tstr]),
  "simple": #7.255,
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
    cddl: `; Indefinite-length encoding is invisible to CDDL: chunked strings
; are just strings, and [_ …] is just an array.
streamed = [
  tstr,
  bstr,
  tstr,
  [* uint],
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
    cddl: `tagged = {
  "timestamp": time,       ; prelude: #6.1(number)
  "rfc3339": tdate,        ; prelude: #6.0(tstr)
  "bignum": biguint,       ; > 2^64-1 → tag 2 on the wire
  "negative": bignint,
  "embedded": bstr .cborseq [uint, [2*2 uint]],
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
    cddl: `; Concatenation is CDN spelling only: each value is one string.
concat = {
  "poem": tstr .size (1..128),
  "bytes": bstr .size 8,
  "array-json": tstr,
  "object-json": tstr,
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
    cddl: `doc = { "menu": menu }
menu = {
  "id": tstr,
  "items": [* { "label": tstr, "key": tstr }],
  "version": float,
}`,
  },
  {
    // Values follow the draft's own examples (draft-ietf-cbor-edn-literals
    // §7.2/§7.3) — including its Apollo 11 splashdown timestamp for dt/DT.
    name: 'App extensions: dt & ip (draft-25)',
    cdn: `{
  # dt gives a bare epoch number; an explicit .0/.N fraction forces float
  # even when the value is whole; DT wraps the epoch in tag(1)
  "epoch":    dt'1969-07-21T02:56:16Z',
  "epoch-f":  dt'1969-07-21T02:56:16.0Z',
  "epoch-fs": dt'1969-07-21T02:56:16.5Z',
  "tagged":   DT'1969-07-21T02:56:16Z',

  # ip gives the bare address bytes; IP adds the CBOR tag (52 = IPv4,
  # 54 = IPv6); a /N suffix produces a [prefix-length, bytes] pair
  "v4":        ip'192.0.2.42',
  "v4-tagged": IP'192.0.2.42',
  "v4-prefix": IP'192.0.2.0/24',
  "v6":        ip'2001:db8::42',
  "v6-tagged": IP'2001:db8::42',
  "v6-prefix": IP'2001:db8::/64',
}`,
    cddl: `; App extensions are CDN spelling for ordinary CBOR data — CDDL types
; describe what actually goes on the wire.
app-extensions-dt-ip = {
  "epoch": int,               ; whole seconds → plain integer
  "epoch-f": float,           ; explicit fraction → float, even when whole
  "epoch-fs": float,          ; fractional seconds → float
  "tagged": time,             ; DT → #6.1(number)
  "v4": bstr .size 4,
  "v4-tagged": #6.52(bstr .size 4),
  "v4-prefix": #6.52([uint, bstr]),
  "v6": bstr .size 16,
  "v6-tagged": #6.54(bstr .size 16),
  "v6-prefix": #6.54([uint, bstr]),
}`,
  },
  {
    name: 'App extensions: hash & cri (draft-25)',
    cdn: `{
  # hash'...' computes SHA-256 over UTF-8 text — shorthand for
  # hash<<'foo'>>, whose << >> form also accepts raw bytes and an
  # explicit algorithm by COSE ID or name
  "sha256-text":  hash'foo',
  "sha256-bytes": hash<<'foo'>>,
  "sha256-id":    hash<<'foo', -16>>,
  "sha256-name":  hash<<'foo', "SHA-256">>,
  "sha512-id":    hash<<'foo', -44>>,
  "sha512-name":  hash<<'foo', "SHA-512">>,

  # cri decomposes a URI into [scheme, host, path?, query?]; CRI wraps
  # that array in a tag
  "url":        cri'https://example.com/bottarga/shaved',
  "tagged-url": CRI'https://example.com/bottarga/shaved',

  # An app-string prefix the parser doesn't recognize is not an error:
  # it round-trips as tag 999 (CPA999) — the prefix plus its content —
  # exactly what a not-yet-registered extension identifier becomes.
  "unknown-single":   nosuchext'some value',
  "unknown-sequence": nosuchext<<1, "two", 3>>,
}`,
    cddl: `; hash'...' — requires @cbortech/hash-extension (bstr; without it,
; an unrecognised app-string becomes tag 999(["hash", "..."]) instead)
app-extensions-hash-cri = {
  "sha256-text": bstr .size 32,
  "sha256-bytes": bstr .size 32,
  "sha256-id": bstr .size 32,
  "sha256-name": bstr .size 32,
  "sha512-id": bstr .size 64,
  "sha512-name": bstr .size 64,
  "url": cri-array,            ; cri → [scheme, host, ? path, ? query]
  "tagged-url": #6.99(cri-array),
  "unknown-single": #6.999([tstr, tstr]),
  "unknown-sequence": #6.999([tstr, [* any]]),
}
cri-array = [int, [* tstr], *[* tstr]]`,
  },
  {
    name: 'App extensions: t1/b1, ilbs/ilts, float & others (draft-26)',
    cdn: `{
  # t1 / b1 join (text or byte) strings into one
  "text":  t1<<"Hello ", "world">>,
  "mixed": t1<<"Hello", h'20', "world">>,
  "bytes": b1<<'Hello ', h'776f726c64'>>,
  # An ellipsis elides part of a string (tag 888)
  "elided": t1<<"Herewith I buy", ..., "signed: Alice & Bob">>,

  # ilbs / ilts build indefinite-length strings, one chunk per argument
  "il-bytes": ilbs<<h'0011', h'2233'>>,
  "il-text":  ilts<<"chunked ", "text">>,

  # float'...' — raw float bits
  "f16": float'3c00',            # float16 bits: 1.0

  # Other app strings: encodings and a cross-encoding assertion
  "b32":  b32'AEBAGBAF',          # base32 byte string
  "h32":  h32'01A0C294',          # base32hex byte string
  "same": same<<h'cafe', b32'ZL7A'>>,   # same bytes, two spellings
}`,
    cddl: `app-extensions-26 = {
  "text": tstr,
  "mixed": tstr,
  "bytes": bstr,
  "elided": any,                ; ... elides the value
  "il-bytes": bstr,
  "il-text": tstr,
  "f16": float16,
  "b32": bstr,
  "h32": bstr,
  "same": bstr .size 2,
}`,
  },
  {
    name: 'CDN Sequence & JSONL',
    cdn: `# CDN Sequence — multiple items separated by whitespace, comma, or comment.
# Output is a CBOR Sequence (RFC 8742): concatenated CBOR items.

{ "event": "start", "ts": DT'2026-06-01T00:00:00Z' }
{ "event": "data",  "value": 42 }
{ "event": "end",   "ts": DT'2026-06-01T00:01:00Z' }

# JSONL / NDJSON is a CDN Sequence too:
{"id": 1, "name": "Alice", "score": 98.5}
{"id": 2, "name": "Bob",   "score": 72.0}`,
    cddl: `; Each item of the sequence is validated against the root rule —
; here a choice between the two record shapes.
item = event / row
event = {
  "event": tstr,
  ? "ts": time,
  ? "value": int,
}
row = {
  "id": uint,
  "name": tstr,
  "score": float,
}`,
  },
  {
    name: 'Groups, choices & ranges',
    cdn: `[
  {"name": "Kudo"},
  {"name": "Ada", "vip": true},
  512,
  "late check-in",
]`,
    cddl: `reservation = [
  1*4 guests: guest,
  room: room-number,
  ? note: tstr .size (1..64),
]
guest = { name: tstr, ? vip: bool }
room-number = 100..699 / "penthouse"`,
  },
  {
    name: 'COSE_Sign1 (RFC 9052)',
    cdn: `[
  / protected   / << {1: -7} >>,
  / unprotected / {4: '11'},
  / payload     / 'This is the content.',
  / signature   / h'8eb33e4ca31d1c465ab05aac34cc6b23
                    d58fef5c083106c4d25a91aef0b0117e',
]`,
    cddl: `COSE_Sign1 = [
  protected: bstr .cbor header_map / bstr .size 0,
  unprotected: header_map,
  payload: bstr / nil,
  signature: bstr,
]
header_map = {
  ? 1 => int / tstr,   ; alg
  ? 4 => bstr,         ; kid
  * label => any,
}
label = int / tstr`,
  },
];

export const DEFAULT_SAMPLE = SAMPLES[0]!.cdn;
