# @cbortech/cbor

TypeScript library for converting between [CBOR](#specifications),
[CDN](#specifications), and JavaScript values.

This package exposes the `CBOR` facade plus a separate AST entrypoint for the
CBOR node classes needed by extensions. Lower-level parser and encoder internals
are not part of the documented public API.

## Install

```bash
npm install @cbortech/cbor
```

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

### CBOR bytes to CDN

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.fromCBOR(new Uint8Array([0x83, 0x01, 0x02, 0x03])).toCDN();

console.log(text);
// [1,2,3]
```

### CDN to CBOR bytes

```ts
import { CBOR } from '@cbortech/cbor';

const bytes = CBOR.fromCDN('[1, 2, 3]').toCBOR();

console.log(bytes);
// Uint8Array([0x83, 0x01, 0x02, 0x03])
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

### Split text strings while formatting

`textStringFormat` can split long text strings with CDN string concatenation.
It is applied when `indent` is specified.

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.format('{"text": "line1\\nline2\\nline3"}', {
  indent: 2,
  textStringFormat: ['newline'],
});

console.log(text);
// {
//   "text": "line1\n" +
//     "line2\n" +
//     "line3"
// }
```

For strings that contain CDN or JSON-like content, use `cdn`.

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.format('{"cdn": "[1,2,3]"}', {
  indent: 2,
  textStringFormat: ['cdn'],
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

## Optional Extensions

Additional application extensions are published as separate packages. Install
the ones you need and pass them through the `extensions` option.

`hash` is an application extension defined by the CDN specification, but
it requires an external package. For that reason, it is not bundled with this
package and is provided separately as `@cbortech/hash-extension`.

`uuid` is a library-specific application extension that is not defined by the
CDN specification. To keep it distinct from standard CDN features, it
is provided separately as `@cbortech/uuid-extension`.

```bash
npm install @cbortech/hash-extension @cbortech/uuid-extension
```

```ts
import { CBOR } from '@cbortech/cbor';
import hashExtension from '@cbortech/hash-extension';
import uuidExtension from '@cbortech/uuid-extension';

const cbor = new CBOR({
  extensions: [hashExtension, uuidExtension],
});

const digest = cbor.fromCDN("hash'foo'");
console.log(digest.toCDN());
// hash'foo'

const id = cbor.fromCDN("uuid'550e8400-e29b-41d4-a716-446655440000'");
console.log(id.toCDN());
// uuid'550e8400-e29b-41d4-a716-446655440000'
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

CBOR items can produce and parse annotated hex dumps.

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

## Public API

The documented public export is:

- `CBOR`

The `CBOR` facade also exposes:

- `CBOR.Tag`
- `CBOR.Simple`
- `CBOR.MapEntries`
- `CBOR.dt_as_Date`
- `CBOR.OMIT`

## Specifications

This library targets:

- [CBOR, RFC 8949](https://www.rfc-editor.org/rfc/rfc8949)
- [Concise Diagnostic Notation (CDN), draft-ietf-cbor-edn-literals-25](https://datatracker.ietf.org/doc/draft-ietf-cbor-edn-literals/25/)

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

CDN is still an Internet-Draft rather than a widely deployed RFC.

## License

Apache-2.0
