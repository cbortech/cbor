# EDN Test Vectors — edn-abnf

CSV test vector files in this directory are copied locally from
[cabo/edn-abnf](https://github.com/cabo/edn-abnf) (`tests/` subdirectory)
and are used as-is for optional integration testing of the CDN/EDN parser.

The CSV files are not committed to this repository because the upstream
licensing/citation terms are not yet explicit. Only this README and the test
driver are tracked.

| File                      | Source        | Content                                                                                     |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `basic.csv`               | cabo/edn-abnf | Core values, escapes, surrogates, hex/b64 comments                                          |
| `level-shifter.csv`       | cabo/edn-abnf | app-string content validation (dt/h/ip + Unicode)                                           |
| `float.csv`               | cabo/edn-abnf | `float'...'` / `float<<...>>`, `same<<...>>`, b64 padding rules                             |
| `rawstrings.csv`          | cabo/edn-abnf | Multi-level backtick raw strings (N=1,2,3+), h/b64/dt/ip extensions                         |
| `encoding-indicators.csv` | cabo/edn-abnf | `_0/_1/_2/_3/_i/_` encoding indicators on integers, floats, strings, arrays, maps, and tags |

## CSV format

Each row has three comma-separated fields: `op,input,output`

| op  | Meaning                                                                       |
| --- | ----------------------------------------------------------------------------- |
| `x` | `fromCDN(input).toCBOR()` must equal `hexToBytes(output)`                     |
| `=` | `fromCDN(input).toCBOR()` must equal `fromCDN(output).toCBOR()`               |
| `-` | No output: `fromCDN(input)` must throw. With output (CDN): bytes must differ. |

Inputs beginning with `h]` are hex-encoded UTF-8: decode the hex to obtain the
actual CDN text (used to embed inputs with control characters).

## Running the optional tests

Fetch the CSV files with:

```sh
npm run fetch-test-vectors -- edn-abnf
```

This clones the upstream repository into a temporary directory and copies
the relevant `tests/*.csv` files into this directory. (Equivalent to cloning
https://github.com/cabo/edn-abnf.git and copying its `tests/` CSV files here
by hand.)

Then run:

```sh
npm run test:edn-abnf
```

These tests are intentionally excluded from `npm run test`.

## Upstream rights

The upstream repository is part of the CBOR EDN specification work (IETF).
Do not commit copied CSV files here until the upstream redistribution terms are
made explicit.
