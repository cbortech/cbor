export interface Sample {
  name: string;
  cdn: string;
}

export const SAMPLES: Sample[] = [
  {
    name: 'Hello CBOR',
    cdn: `{
  # CBOR Diagnostic Notation — edit me!
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
  "half": 1.5_1,
  "single": 0.25_2,
  "double": 1.1,
  "special": [Infinity, -Infinity, NaN],
  "hex": 0xdeadbeef,
  "wide": 1_2,              # 1 encoded in 4 bytes
  "simple": simple(99),
  "undef": undefined,
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
];

export const DEFAULT_SAMPLE = SAMPLES[0]!.cdn;
