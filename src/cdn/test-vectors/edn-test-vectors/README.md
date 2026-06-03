# EDN Test Vectors

CSV test vector files in this directory are copied locally from
[hildjj/edn-test-vectors](https://github.com/hildjj/edn-test-vectors)
and are used as-is for optional integration testing of the CDN/EDN parser.

The CSV files are not committed to this repository because the upstream
licensing/citation terms are not yet explicit. Only this README and the test
driver are tracked.

| File                      | Source                          | Content                                                |
| ------------------------- | ------------------------------- | ------------------------------------------------------ |
| `basic.csv`               | edn-abnf (via edn-test-vectors) | Core values, strings, escape sequences, app-extensions |
| `encoding-indicators.csv` | edn-abnf (via edn-test-vectors) | `_i`/`_0`/`_1`/`_2`/`_3` encoding indicators           |
| `success.csv`             | cbor-edn (via edn-test-vectors) | Valid inputs — comprehensive success cases             |
| `failures.csv`            | cbor-edn (via edn-test-vectors) | Invalid inputs — must all throw a parse error          |

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

Clone the upstream fixture repository and copy the CSV files into this
directory:

```sh
git clone https://github.com/hildjj/edn-test-vectors.git /tmp/edn-test-vectors
cp /tmp/edn-test-vectors/*.csv src/cdn/test-vectors/edn-test-vectors/
```

Then run:

```sh
npm run test:edn-vectors
```

These tests are intentionally excluded from `npm run test`.

## Upstream rights

The upstream repository currently states that it is intended to be treated as
an IETF submission and points to RFC 5378 for the applicable rights framework.
Do not commit copied CSV files here until the upstream redistribution terms are
made explicit.
