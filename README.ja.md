# @cbortech/cbor

[CBOR](#準拠している仕様)、[CBOR-EDN](#準拠している仕様)、JavaScript 値を相互変換するための TypeScript ライブラリです。

このパッケージは `CBOR` ファサードに加えて、extension の実装に必要な CBOR AST ノードクラス用の entrypoint を公開します。
低レベルのパーサー、エンコーダー内部は、ドキュメント上の公開 API には含めていません。

## インストール

```bash
npm install @cbortech/cbor
```

## インポート

```ts
import { CBOR } from '@cbortech/cbor';
```

default import も利用できます。

```ts
import CBOR from '@cbortech/cbor';
```

## クイック例

### JavaScript から CBOR バイト列へ

```ts
import { CBOR } from '@cbortech/cbor';

const bytes = CBOR.encode({ hello: 'world', n: 42 });

console.log(bytes);
// Uint8Array(...)
```

### CBOR バイト列から JavaScript へ

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

### CBOR バイト列から CBOR-EDN へ

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.fromCBOR(
  new Uint8Array([0x83, 0x01, 0x02, 0x03])
).toEDN();

console.log(text);
// [1,2,3]
```

### CBOR-EDN から CBOR バイト列へ

```ts
import { CBOR } from '@cbortech/cbor';

const bytes = CBOR.fromEDN('[1, 2, 3]').toCBOR();

console.log(bytes);
// Uint8Array([0x83, 0x01, 0x02, 0x03])
```

### JavaScript から CBOR-EDN へ

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.stringify({ a: 1, b: true, c: null });

console.log(text);
// {"a":1,"b":true,"c":null}
```

### 読みやすい CBOR-EDN を出力する

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

### CBOR-EDN から JavaScript へ

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse("[1, h'deadbeef', true, null]");

console.log(value);
// [1, Uint8Array(...), true, null]
```

### CBOR-EDN を正規化する

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

### テキスト文字列を分割して整形する

`textStringFormat` を使うと、長いテキスト文字列を EDN の文字列連結として分割できます。
このオプションは `indent` を指定したときに適用されます。

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

文字列の中身が CBOR-EDN や JSON 風の内容なら、`cboredn` を使えます。

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.format('{"edn": "[1,2,3]"}', {
  indent: 2,
  textStringFormat: ['cboredn'],
});

console.log(text);
// {
//   "edn": "[" +
//       "1," +
//       "2," +
//       "3" +
//     "]"
// }
```

## AST を扱う

`CBOR.fromCBOR()`、`CBOR.fromEDN()`、`CBOR.fromJS()` は CBOR item を返します。
`CborTextString`、`CborByteString`、`CborArray`、`CborTag` などの具体的なノードクラスは、
extension 向けに `@cbortech/cbor/ast` から export されています。すべての item は次のメソッドを持ちます。

```ts
import { CBOR } from '@cbortech/cbor';
import { CborItem } from '@cbortech/cbor/ast';

const item = CBOR.fromEDN('{ "x": 1 }');
item satisfies CborItem;

const bytes = item.toCBOR();
const text = item.toEDN();
const value = item.toJS();
```

### AST としてパースしてからシリアライズする

```ts
import { CBOR } from '@cbortech/cbor';

const item = CBOR.fromEDN('[_ 1, 2, 3]');

console.log(item.toEDN());
// [_ 1,2,3]

console.log(item.toCBOR());
// Uint8Array(...)
```

### CBOR を AST としてデコードし、EDN として確認する

```ts
import { CBOR } from '@cbortech/cbor';

const item = CBOR.fromCBOR(new Uint8Array([0x83, 0x01, 0x02, 0x03]));

console.log(item.toEDN());
// [1,2,3]

console.log(item.toJS());
// [1, 2, 3]
```

## JSON に近い API

`CBOR.parse()` と `CBOR.stringify()` は、`JSON.parse()` と `JSON.stringify()` に近い感覚で使えるようにしています。

JSON と違い、CBOR では `undefined` も値として表現できます。
reviver や replacer で object entry や map entry を明示的に取り除きたい場合は、
`undefined` を返す代わりに `CBOR.OMIT` を使います。

### Reviver 関数

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

### Replacer 関数

```ts
import { CBOR } from '@cbortech/cbor';

const text = CBOR.stringify({ id: 1, password: 'secret' }, (key, value) =>
  key === 'password' ? CBOR.OMIT : value
);

console.log(text);
// {"id":1}
```

### Replacer のキー一覧

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

## デフォルトオプション

同じオプションを繰り返し使いたい場合は、`CBOR` インスタンスを作成します。

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

## 日時

CBOR-EDN の `dt'...'` と `DT'...'` リテラルは、デフォルトでパースできます。
JavaScript の `Date` オブジェクトとして扱いたい場合は `CBOR.dt_as_Date` を追加します。

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

## オプション extension

追加の application extension は別パッケージとして公開されています。必要なものを
インストールし、`extensions` オプションに渡して使います。

`hash` は CBOR-EDN の仕様に含まれる application extension ですが、利用には
外部パッケージが必要です。そのため、このパッケージ本体には含めず、
`@cbortech/hash-extension` として提供しています。

`uuid` は CBOR-EDN の仕様には定められていない、このライブラリ独自の
application extension です。仕様上の標準機能と区別するため、
`@cbortech/uuid-extension` として別パッケージで提供しています。

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

const digest = cbor.fromEDN("hash'foo'");
console.log(digest.toEDN());
// hash'foo'

const id = cbor.fromEDN("uuid'550e8400-e29b-41d4-a716-446655440000'");
console.log(id.toEDN());
// uuid'550e8400-e29b-41d4-a716-446655440000'
```

## タグ

JavaScript 上で CBOR のタグ付き値を扱うには `CBOR.Tag` を使います。

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

タグ情報が不要で、中身だけを通常の JavaScript 値として扱いたい場合は
`stripTags: true` を指定できます。

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse('42("hello")', { stripTags: true });

console.log(value);
// "hello"
```

## Simple 値

`false`、`true`、`null`、`undefined` 以外の CBOR simple value には `CBOR.Simple` を使います。

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

## マップ

デフォルトでは、テキストキーだけを持つ CBOR map は通常の JavaScript オブジェクトになります。

```ts
import { CBOR } from '@cbortech/cbor';

const value = CBOR.parse('{"a": 1, "b": 2}');

console.log(value);
// { a: 1, b: 2 }
```

文字列ではないキーや重複キーを保持したい場合は、`mapAs: 'entries'` を使います。

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

`CBOR.MapEntries` は `CBOR.stringify()` や `CBOR.encode()` にそのまま渡せます。

```ts
import { CBOR } from '@cbortech/cbor';

const entries = new CBOR.MapEntries([1, 'one'], [1, 'uno']);

console.log(CBOR.stringify(entries));
// {1:"one",1:"uno"}
```

## Hex Dump

CBOR item は注釈付き hex dump の生成とパースに対応しています。

```ts
import { CBOR } from '@cbortech/cbor';

const item = CBOR.fromEDN('[_ 1, [2, 3]]');
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

console.log(item.toEDN());
// [1,2,3]
```

## 公開 API

ドキュメント化している公開 export は次のとおりです。

- `CBOR`

`CBOR` ファサードからは次にもアクセスできます。

- `CBOR.Tag`
- `CBOR.Simple`
- `CBOR.MapEntries`
- `CBOR.dt_as_Date`
- `CBOR.OMIT`

## 準拠している仕様

このライブラリは次の仕様を対象にしています。

- [CBOR, RFC 8949](https://www.rfc-editor.org/rfc/rfc8949)
- [CBOR Extended Diagnostic Notation (CBOR-EDN), draft-ietf-cbor-edn-literals-23](https://datatracker.ietf.org/doc/draft-ietf-cbor-edn-literals/23/)

CBOR-EDN は、CBOR データを人間が読み書きしやすいテキストとして表現するための記法です。
サンプル、テストベクター、デバッグ、fixture、設定ファイルに近い用途など、CBOR のバイト列をそのまま扱うと読みにくい場面で役立ちます。

通常の配列、マップ、文字列、数値、真偽値、null は JSON に近い見た目で書けます。
一方で、CBOR 固有の byte string、tag、simple value、不定長 item、文字列以外の map key、
`dt'2026-05-06T00:00:00Z'` のような application literal も表現できます。

CBOR-EDN は JSON / JSONC の上位互換なので、通常の JSON データやコメント付きの JSON 風データも、
特別な変換なしに CBOR-EDN としてパース・整形できます。

CBOR-EDN はまだ広く普及した RFC ではなく、Internet-Draft として策定中の仕様です。

## ライセンス

Apache-2.0
