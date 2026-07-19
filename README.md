# @cbortech/cbor

[![npm version](https://img.shields.io/npm/v/%40cbortech%2Fcbor)](https://www.npmjs.com/package/@cbortech/cbor)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![types](https://img.shields.io/npm/types/%40cbortech%2Fcbor)](https://www.npmjs.com/package/@cbortech/cbor)
[![license](https://img.shields.io/npm/l/%40cbortech%2Fcbor)](./LICENSE)
![platform](https://img.shields.io/badge/platform-Node.js%20%7C%20Browser-blue)

TypeScript library for converting between [CBOR](#specifications),
[CDN (CBOR-EDN)](#specifications), and JavaScript values.

![Relationship between CBOR, CDN, and JavaScript values](./assets/cbor-cdn-js.png)

A live playground is available at **https://cbor.tech/cbor/**.

This package exposes the `CBOR` facade plus a separate AST entrypoint for the
CBOR node classes needed by extensions. Lower-level parser and encoder internals
are not part of the documented public API.

## Install

```bash
npm install @cbortech/cbor
```

For command-line conversion and inspection, a companion CLI package is
available as [@cbortech/cbor-cli](https://www.npmjs.com/package/@cbortech/cbor-cli).

```bash
npm install -g @cbortech/cbor-cli
```

For editor integration, try the companion
[VS Code extension](https://marketplace.visualstudio.com/items?itemName=cbortech.vscode-cdn-extension),
which is built with this package.

## Import

```ts
import { CBOR } from '@cbortech/cbor';
```

Default import is also supported:

```ts
import CBOR from '@cbortech/cbor';
```

## Quick Examples

### JavaScript to CBOR bytes

```ts
import { CBOR } from '@cbortech/cbor';

const bytes = CBOR.encode({ hello: 'world', n: 42 });

console.log(bytes);
// Uint8Array(...)
```

### CBOR bytes to JavaScript

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.decode(
  new Uint8Array([
    0xa2, 0x65, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x65, 0x77, 0x6f, 0x72, 0x6c,
    0x64, 0x61, 0x6e, 0x18, 0x2a,
  ])
);

console.log(value);
// { hello: 'world', n: 42 }
```

### CBOR Sequence to JavaScript values

`decodeSeq` reads concatenated CBOR items as a CBOR Sequence and yields each item as a JavaScript value.

```ts
import { CBOR } from '@cbortech/cbor';

const a = CBOR.encode({ id: 1 });
const b = CBOR.encode({ id: 2 });
const seq = new Uint8Array([...a, ...b]);

const values = [...CBOR.decodeSeq(seq)];
// [{ id: 1 }, { id: 2 }]
```

### CBOR bytes to CDN

`decompile` converts CBOR binary data to a CDN text string. It handles CBOR Sequences automatically: multiple concatenated items produce newline-separated CDN output.

```ts
import { CBOR } from '@cbortech/cbor';

// Single item
const text = CBOR.decompile(new Uint8Array([0x83, 0x01, 0x02, 0x03]));
console.log(text);
// [1,2,3]

// CBOR Sequence — each item on its own line
const seq = new Uint8Array([...CBOR.encode(1), ...CBOR.encode('two')]);
console.log(CBOR.decompile(seq));
// 1
// "two"
```

### CDN to CBOR bytes

`compile` converts a CDN text string to CBOR binary data. Multi-item CDN Sequences automatically produce a CBOR Sequence (RFC 8742): concatenated items.

```ts
import { CBOR } from '@cbortech/cbor';

// Single item
const bytes = CBOR.compile('[1, 2, 3]');
console.log(bytes);
// Uint8Array([0x83, 0x01, 0x02, 0x03])

// CDN Sequence — output is a CBOR Sequence
const seq = CBOR.compile('{"id":1}\n{"id":2}');
console.log([...CBOR.decodeSeq(seq)]);
// [{ id: 1 }, { id: 2 }]
```

### CBOR bytes to hex dump

`toHex` converts CBOR binary data to an annotated hex dump string. CBOR Sequences are handled automatically: each item produces its own dump, separated by newlines.

```ts
import { CBOR } from '@cbortech/cbor';

const bytes = CBOR.encode([1, 2, 3]);
console.log(CBOR.toHex(bytes));
// 83        -- Array of length 3
//    01     -- 1
//    02     -- 2
//    03     -- 3
```

### Hex dump to CBOR bytes

`fromHex` parses an annotated hex dump back to CBOR binary data. Multi-item dumps produce a CBOR Sequence (RFC 8742): concatenated items.

```ts
import { CBOR } from '@cbortech/cbor';

const bytes = CBOR.fromHex(`
83        -- Array of length 3
   01     -- 1
   02     -- 2
   03     -- 3
`);
console.log([...CBOR.decodeSeq(bytes)]);
// [[1, 2, 3]]
```

### JavaScript to CDN

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.stringify({ a: 1, b: true, c: null });

console.log(text);
// {"a":1,"b":true,"c":null}
```

### Pretty CDN

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.stringify({ items: [1, 2, 3], ok: true }, { indent: 2 });

console.log(text);
// {
//   "items": [
//     1,
//     2,
//     3
//   ],
//   "ok": true
// }
```

### CDN to JavaScript

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse("[1, h'deadbeef', true, null]");

console.log(value);
// [1, Uint8Array(...), true, null]
```

### CDN Sequence to JavaScript values

`parseSeq` parses multiple CDN items separated by whitespace, commas, or comments, and also accepts JSONL / NDJSON input.

```ts
import { CBOR } from '@cbortech/cbor';

const values = [...CBOR.parseSeq('1  "two"  [3]')];
// [1, 'two', [3]]

const jsonl = '{"id":1}\n{"id":2}\n{"id":3}';
const rows = [...CBOR.parseSeq(jsonl)];
// [{ id: 1 }, { id: 2 }, { id: 3 }]
```

### Normalize CDN

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.format('{ "b" : [ 1,2 ], "a" : true }', { indent: 2 });

console.log(text);
// {
//   "b": [
//     1,
//     2
//   ],
//   "a": true
// }
```

### Keep leaf containers on one line

`inlineLeafContainers` keeps a container on a single line when none of its
entries contains an array or map (even wrapped in a tag) and every entry
serializes without a line break. Nested leaf containers still collapse
individually, so matrix-like data stays readable. It is applied when
`indent` is specified.

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.format('{"m": [[1,2],[3,4]], "s": (_ "a", "b")}', {
  indent: 2,
  inlineLeafContainers: true,
});

console.log(text);
// {
//   "m": [
//     [1, 2],
//     [3, 4]
//   ],
//   "s": (_ "a", "b")
// }
```

### Split text strings while formatting

`splitNewline` splits long text strings at newline characters using CDN
string concatenation. It is applied when `indent` is specified.

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.format('{"text": "line1\\nline2\\nline3"}', {
  indent: 2,
  splitNewline: true,
});

console.log(text);
// {
//   "text": "line1\n" +
//     "line2\n" +
//     "line3"
// }
```

For strings that contain CDN or JSON-like content, `splitCdn` formats the
string content with structure-aware line breaks and indentation, the same
way the surrounding CDN is formatted. Both options can be combined, and they
replace the deprecated array-valued `textStringFormat` option.

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.format('{"cdn": "[1,2,3]"}', {
  indent: 2,
  splitCdn: true,
});

console.log(text);
// {
//   "cdn": "[" +
//       "1," +
//       "2," +
//       "3" +
//     "]"
// }
```

### Preserve raw text strings

By default, `CBOR.format()` converts raw backtick string literals
(`` `...` ``, ` ``...`` `, …) to double-quoted form. `preserveRawString`
re-emits them using their original source text instead. Preserved raw
strings are emitted verbatim: they are never re-escaped, re-indented, or
split by `splitCdn` / `splitNewline`. (Raw byte string forms such as
`` h`...` `` are covered by `preserveByteString`.)

```ts
import { CBOR } from '@cbortech/cbor';

CBOR.format('`\\d+`');
// '"\\\\d+"'

CBOR.format('`\\d+`', { preserveRawString: true });
// '`\\d+`'
```

### Preserve `+` string concatenation

Note: `+` string concatenation was removed in draft-26. This section is for
handling legacy syntax.

By default, `CBOR.format()` joins `+` string concatenation into a single
literal. `preserveConcatenation` keeps the original part boundaries for both
text strings and byte strings; add `preserveByteString` to also keep the
original spelling of byte string parts.

`preserveConcatenation` interacts with the split options: `splitCdn` takes
precedence when the string content parses as CDN, while `splitNewline`
combines with it by further splitting the preserved parts at newline
characters.

```ts
import { CBOR } from '@cbortech/cbor';

CBOR.format('"a" + "b"');
// '"ab"'

CBOR.format('"a" + "b"', { preserveConcatenation: true });
// '"a" + "b"'

CBOR.format("h'68' + b64'aQ'", {
  preserveConcatenation: true,
  preserveByteString: true,
});
// "h'68' + b64'aQ'"
```

### Validate CBOR / CDN / hex dump

`validate` checks input for well-formedness and validity without throwing.
Recoverable violations (e.g. duplicate map keys) are collected into
`warnings` instead of stopping decoding; truly malformed data is reported via
`error` instead. `type` selects the input format: `'cbor'` (default),
`'cdn'`, or `'hex'`.

```ts
import { CBOR } from '@cbortech/cbor';

// CBOR bytes — duplicate map key "a" is a recoverable violation
CBOR.validate(new Uint8Array([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]), {
  type: 'cbor',
});
// { valid: false, count: 1, warnings: [{ message: 'duplicate map key at offset 4', offset: 4 }] }

// CDN text — well-formed input
CBOR.validate('{"a": 1}', { type: 'cdn' });
// { valid: true, count: 1, warnings: [] }

// Annotated hex dump text — truncated array (length 3, only 2 elements present)
CBOR.validate('83  -- Array of length 3\n   01     -- 1\n   02     -- 2', {
  type: 'hex',
});
// { valid: false, count: 0, warnings: [], error: Error(...) }
```

## Working With The AST

`CBOR.fromCBOR()`, `CBOR.fromCDN()`, and `CBOR.fromJS()` return a CBOR item.
Concrete node classes such as `CborTextString`, `CborByteString`, `CborArray`,
and `CborTag` are exported from `@cbortech/cbor/ast` for extensions. Every item
supports these methods:

```ts
import { CBOR } from '@cbortech/cbor';
import { CborItem } from '@cbortech/cbor/ast';

const item = CBOR.fromCDN('{ "x": 1 }');
item satisfies CborItem;

const bytes = item.toCBOR();
const text = item.toCDN();
const value = item.toJS();
```

### Parse to AST, then serialize

```ts
import { CBOR } from '@cbortech/cbor';

const item = CBOR.fromCDN('[_ 1, 2, 3]');

console.log(item.toCDN());
// [_ 1,2,3]

console.log(item.toCBOR());
// Uint8Array(...)
```

### Decode to AST, then inspect as CDN

```ts
import { CBOR } from '@cbortech/cbor';

const item = CBOR.fromCBOR(new Uint8Array([0x83, 0x01, 0x02, 0x03]));

console.log(item.toCDN());
// [1,2,3]

console.log(item.toJS());
// [1, 2, 3]
```

## JSON-like API

`CBOR.parse()` and `CBOR.stringify()` intentionally feel similar to
`JSON.parse()` and `JSON.stringify()`.

Unlike JSON, CBOR can represent `undefined` as a value. Use `CBOR.OMIT` from a
reviver or replacer when you want to remove an object entry or map entry
explicitly, instead of producing an `undefined` value.

### Reviver function

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse(
  '{"createdAt": "2026-05-06T00:00:00Z"}',
  (key, value) => {
    if (key === 'createdAt') return new Date(value);
    return value;
  }
);

console.log(value);
// { createdAt: 2026-05-06T00:00:00.000Z }
```

### Replacer function

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.stringify({ id: 1, password: 'secret' }, (key, value) =>
  key === 'password' ? CBOR.OMIT : value
);

console.log(text);
// {"id":1}
```

### Replacer key list

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.stringify(
  { id: 1, name: 'Alice', password: 'secret' },
  ['id', 'name'],
  2
);

console.log(text);
// {
//   "id": 1,
//   "name": "Alice"
// }
```

## Default Options

Create a `CBOR` instance when you want to reuse the same options.

```ts
import { CBOR } from '@cbortech/cbor';

const cbor = new CBOR({
  extensions: [CBOR.dt_as_Date],
  indent: 2,
});

const value = cbor.parse("DT'2026-05-06T00:00:00Z'");

console.log(value);
// Date(...)

console.log(cbor.stringify({ value }));
// {
//   "value": DT'2026-05-06T00:00:00Z'
// }
```

## Dates

CDN `dt'...'` and `DT'...'` literals are parsed by default. Add `CBOR.dt_as_Date`
when you want JavaScript `Date` objects.

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse("DT'2026-05-06T00:00:00Z'", {
  extensions: [CBOR.dt_as_Date],
});

console.log(value instanceof Date);
// true
```

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.stringify(new Date('2026-05-06T00:00:00Z'), {
  extensions: [CBOR.dt_as_Date],
});

console.log(text);
// DT'2026-05-06T00:00:00Z'
```

## String Concatenation and Indefinite-Length Strings

The `t1` / `b1` / `ilbs` / `ilts` application extensions from
draft-ietf-cbor-edn-literals-26 (§3.4 / §3.5) are enabled by default.

`t1<<...>>` and `b1<<...>>` join (text or byte) string arguments from left to
right into a single text string (`t1`) or byte string (`b1`). Arguments may
also be ellipses (`...`) to elide parts of a string.

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.fromCDN('t1<<"Hello ", "world">>');
console.log(text.toCDN({ appStrings: false }));
// "Hello world"

const bytes = CBOR.fromCDN("b1<<'Hello ', h'776f726c64'>>");
console.log(bytes.toCDN({ appStrings: false }));
// 'Hello world'
```

`ilbs<<...>>` / `ilts<<...>>` build an indefinite-length byte / text string
with one chunk per argument, honoring encoding indicators on each argument.
They replace the deprecated `(_ chunk, ...)` streamstring syntax for new CDN
documents; this library keeps accepting the legacy syntax on input.

```ts
import { CBOR } from '@cbortech/cbor';

const v = CBOR.fromCDN("ilbs<<'Hello ', 'world'>>");
console.log(v.toCDN({ appStrings: false }));
// (_ 'Hello ','world')
```

> [!NOTE]
> The identifiers `t1` and `b1` are explicitly provisional in draft-26 and
> may be renamed by the CBOR working group.

## float

Interprets a hex bit-pattern as an IEEE 754 floating-point value
(draft-ietf-cbor-edn-literals-26 §3.7). Enabled by default.

```ts
import { CBOR } from '@cbortech/cbor';

const v = CBOR.fromCDN("float'7e00'");
console.log(v.toCDN({ appStrings: false }));
// NaN

// Interpret bytes as float bits
const v2 = CBOR.fromCDN("float<<h'3f800000'>>");
console.log(v2.toCDN({ appStrings: false }));
// 1.0_2
```

## Optional Extensions

This package includes several bundled extensions that are not enabled by
default. Import what you need and pass it through the `extensions` option.

### b32 / h32

Byte-string literals using [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648)
Base32 encoding. These prefixes are described in §8 of
[RFC 8949](https://www.rfc-editor.org/rfc/rfc8949) and also mentioned in
[draft-ietf-cbor-edn-literals](https://datatracker.ietf.org/doc/draft-ietf-cbor-edn-literals/25/).

- `b32` — §6 Base32 (`A–Z 2–7` alphabet)
- `h32` — §7 Base32Hex (`0–9 A–V` alphabet)

```ts
import { CBOR, b32, h32 } from '@cbortech/cbor';

const v1 = CBOR.fromCDN("b32'AEBAGBA'", { extensions: [b32] });
console.log(v1.toCDN({ appStrings: false }));
// h'01020304'

const v2 = CBOR.fromCDN("h32'00P00'", { extensions: [h32] });
console.log(v2.toCDN({ appStrings: false }));
// h'003200'
```

### same

`same<<expr, expr, ...>>` verifies that every item in the sequence encodes to
identical CBOR bytes and returns the first item. This extension is described in
[draft-bormann-cbor-edn-app-ext](https://datatracker.ietf.org/doc/draft-bormann-cbor-edn-app-ext/).

```ts
import { CBOR, same } from '@cbortech/cbor';

const v = CBOR.fromCDN("same<<h'0102', h'0102'>>", { extensions: [same] });
console.log(v.toCDN({ appStrings: false }));
// h'0102'

// A single-item sequence always passes
const v2 = CBOR.fromCDN('same<<42>>', { extensions: [same] });
console.log(v2.toCDN({ appStrings: false }));
// 42
```

---

Additional application extensions are published as separate packages. Install
the ones you need and pass them through the `extensions` option.

### hash

`hash` is an application extension defined in §3.3 of
[draft-ietf-cbor-edn-literals](https://datatracker.ietf.org/doc/draft-ietf-cbor-edn-literals/25/).
It represents cryptographic hash values in the form `hash'algorithm:value'`.
Because it requires an external cryptographic library, it is provided separately
as [@cbortech/hash-extension](https://www.npmjs.com/package/@cbortech/hash-extension).

```bash
npm install @cbortech/hash-extension
```

```ts
import { CBOR } from '@cbortech/cbor';
import { hash } from '@cbortech/hash-extension';

const cbor = new CBOR({ extensions: [hash] });

const digest = cbor.parse(
  "hash'sha-256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"
);
// Uint8Array(32) [227, 176, 196, 66, 152, 252, 28, 20, 154, 251, 244, 200,
//                 153, 111, 185, 36, 39, 174, 65, 228, 100, 155, 147, 76,
//                 164, 149, 153, 27, 120, 82, 184, 85]
```

### uuid

`uuid` is a library-specific application extension, provided separately as
[@cbortech/uuid-extension](https://www.npmjs.com/package/@cbortech/uuid-extension).

```bash
npm install @cbortech/uuid-extension
```

```ts
import { CBOR } from '@cbortech/cbor';
import { uuid } from '@cbortech/uuid-extension';

const cbor = new CBOR({ extensions: [uuid] });

const id = cbor.parse("uuid'550e8400-e29b-41d4-a716-446655440000'");
// Uint8Array(16) [85, 14, 132, 0, 226, 155, 65, 212, 167, 22, 68, 102, 85, 68, 0, 0]
```

### set / map

`SET` and `MAP` are library-specific application extensions for tagged Set and
Map values. They are provided together as
[@cbortech/set-map-extensions](https://www.npmjs.com/package/@cbortech/set-map-extensions).
`SET<<[...]>>` produces CBOR tag 258 over an array, and `MAP<<{...}>>` produces
CBOR tag 259 over a map.

```bash
npm install @cbortech/set-map-extensions
```

```ts
import { CBOR } from '@cbortech/cbor';
import { set, map } from '@cbortech/set-map-extensions';

const cbor = new CBOR({ extensions: [set, map] });

const roles = cbor.parse('SET<<["admin", "editor"]>>');
// Set { 'admin', 'editor' }

const scores = cbor.parse('MAP<<{"alice": 98, "bob": 72}>>');
// Map { 'alice' => 98, 'bob' => 72 }
```

## Tags

Use `CBOR.Tag` for CBOR tagged values in JavaScript.

```ts
import { CBOR } from '@cbortech/cbor';

const tagged = CBOR.Tag.set('hello', 42n);
const text = CBOR.stringify(tagged);

console.log(text);
// 42("hello")
```

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse('42("hello")');

console.log(CBOR.Tag.get(value));
// 42n

console.log(CBOR.Tag.getValue(value));
// "hello"
```

Use `stripTags: true` when you only need the tagged content as a plain
JavaScript value.

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse('42("hello")', { stripTags: true });

console.log(value);
// "hello"
```

## Simple Values

Use `CBOR.Simple` for CBOR simple values other than `false`, `true`, `null`, and
`undefined`.

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.stringify(new CBOR.Simple(16));

console.log(text);
// simple(16)
```

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse('simple(16)');

console.log(value instanceof CBOR.Simple);
// true

console.log(value.value);
// 16
```

## Maps

By default, CBOR maps with text keys become plain JavaScript objects.

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse('{"a": 1, "b": 2}');

console.log(value);
// { a: 1, b: 2 }
```

Use `mapAs: 'entries'` when you need to preserve non-string keys or duplicate
keys.

```ts
import { CBOR } from '@cbortech/cbor';

const entries = CBOR.parse('{1: "one", 1: "uno"}', {
  mapAs: 'entries',
});

console.log(entries instanceof CBOR.MapEntries);
// true

console.log(entries);
// [[1, "one"], [1, "uno"]]
```

`CBOR.MapEntries` can be passed back to `CBOR.stringify()` or `CBOR.encode()`.

```ts
import { CBOR } from '@cbortech/cbor';

const entries = new CBOR.MapEntries([1, 'one'], [1, 'uno']);

console.log(CBOR.stringify(entries));
// {1:"one",1:"uno"}
```

## Hex Dumps

`CBOR.toHex()` and `CBOR.fromHex()` are the shortcut entry points (see [Quick Examples](#cbor-bytes-to-hex-dump)).
For full AST access — byte ranges, re-encoding, selective inspection — use `item.toHexDump()` and `CBOR.fromHexDump()` directly:

```ts
import { CBOR } from '@cbortech/cbor';

const item = CBOR.fromCDN('[_ 1, [2, 3]]');
const dump = item.toHexDump();

console.log(dump);
// 9F        -- Start indefinite-length array
// ...
```

```ts
import { CBOR } from '@cbortech/cbor';

const item = CBOR.fromHexDump(`
83        -- Array of length 3
   01     -- 1
   02     -- 2
   03     -- 3
`);

console.log(item.toCDN());
// [1,2,3]
```

## Tokenization

The `@cbortech/cbor/cdn` subpath exposes the same lexer the parser uses, for
tooling such as syntax highlighters that must stay in exact agreement with
parsing behavior:

```ts
import { tokenize, tokenizeLenient } from '@cbortech/cbor/cdn';

const { tokens, comments } = tokenize('[1, "ab"] # note');
// tokens: [{ type: 'LBRACKET', offset: 0, endOffset: 1, ... }, ...]

const lenient = tokenizeLenient('[1, "ab');
// Never throws: clean tokens, then one ERROR token covering the
// unscannable tail, plus the failure in lenient.error.
```

Syntax errors thrown by `fromCDN`/`parse`/`tokenize` are `CdnSyntaxError`
instances (a `SyntaxError` subclass, also exported from the main entry) and
carry `offset`, `line`, `column`, and — where known — `endOffset`.

## Public API

The documented public exports are:

- `CBOR`
- `CdnSyntaxError`

The `CBOR` facade also exposes:

- `CBOR.Tag`
- `CBOR.Simple`
- `CBOR.MapEntries`
- `CBOR.dt_as_Date`
- `CBOR.OMIT`

Lower-level CDN tokenization lives in `@cbortech/cbor/cdn`
(`tokenize`, `tokenizeLenient`, `Token`, `TokenType`, `EdnComment`),
and AST node classes in `@cbortech/cbor/ast`.

## Specifications

This library targets:

- [CBOR, RFC 8949](https://www.rfc-editor.org/rfc/rfc8949)
- [Concise Diagnostic Notation (CDN), draft-ietf-cbor-edn-literals-25](https://datatracker.ietf.org/doc/draft-ietf-cbor-edn-literals/25/)

On top of draft -25, this library already incorporates parts of
[draft -26](https://datatracker.ietf.org/doc/draft-ietf-cbor-edn-literals/26/):

- the `t1` / `b1` string-concatenation extensions (§3.4)
- the `ilbs` / `ilts` indefinite-length string extensions (§3.5)
- the `float` extension as a default extension (§3.7)
- the draft-26 raw-string delimiter and trimming rules (§2.5.4): the closing
  delimiter must have exactly as many backquotes as the opening one, and the
  space-trimming rule applies to all delimiter lengths

The legacy `+` string-concatenation syntax (removed in draft -26) and the
`(_ ...)` streamstring syntax (deprecated in draft -26) are still accepted.
Note that the CDN specification is still an Internet-Draft and may continue
to change (for example, the extension names `t1` and `b1` are explicitly
provisional).

CDN is a human-readable text notation for CBOR data. It is useful for
examples, test vectors, debugging, fixtures, and configuration-like files where
raw CBOR bytes would be hard to read.

It looks similar to JSON for ordinary arrays, maps, strings, numbers, booleans,
and null values, but it can also represent CBOR-specific features such as byte
strings, tags, simple values, indefinite-length items, non-string map keys, and
application literals like `dt'2026-05-06T00:00:00Z'`.

CDN is a superset of JSON and JSONC, so ordinary JSON data and
commented JSON-style data can be parsed and formatted as CDN without
special handling.

## License

Apache-2.0
