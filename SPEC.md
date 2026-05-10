# @cbortech/cbor ライブラリ仕様

## 概要

CBOR (RFC 8949) および CBOR-EDN (draft-ietf-cbor-edn-literals) を扱うJavaScript/TypeScriptライブラリ。

- **入力**: CBORバイナリ / CBOR-EDNテキスト / JavaScript値
- **内部表現**: CBORの全データ型を正確に表現するASTノード群
- **出力**: CBORバイナリ / CBOR-EDNテキスト / JavaScript値

### 設計方針

- **ロスレス往復変換**: CBOR binary → AST → CBOR binary は同一バイト列を保証
- **不定長エンコーディング保持**: EDN の `[_ ...]`, `{_ ...}`, `(_ ...)` と対応
- **拡張可能**: タグのセマンティクス変換はプラグイン方式（v1では未実装）

---

## ASTノード階層

```
CborValue (抽象基底クラス)
├── CborUint                    // Major Type 0: 符号なし整数 (0 〜 2^64-1)
├── CborNint                    // Major Type 1: 負の整数 (-2^64 〜 -1)
├── CborByteString              // Major Type 2: バイト列（定長）
├── CborIndefiniteByteString    // Major Type 2: バイト列（不定長・チャンク列）
├── CborTextString              // Major Type 3: テキスト文字列（定長）
├── CborIndefiniteTextString    // Major Type 3: テキスト文字列（不定長・チャンク列）
├── CborArray                   // Major Type 4: 配列（定長・不定長共通）
├── CborMap                     // Major Type 5: マップ（定長・不定長共通）
├── CborTag                     // Major Type 6: タグ付きデータ
├── CborFloat                   // Major Type 7: IEEE754浮動小数点
└── CborSimple                  // Major Type 7: 単純値 (true/false/null/undefined/other)
```

---

## 不定長エンコーディングの対応表

| CBOR エンコーディング | EDN 表記            | 意味                           |
| --------------------- | ------------------- | ------------------------------ |
| `5f 41 xx ... ff`     | `(_ h'xx', ...)`    | 不定長バイト列（チャンク列）   |
| `7f 61 xx ... ff`     | `(_ "xx", ...)`     | 不定長テキスト列（チャンク列） |
| `9f ... ff`           | `[_ item, ...]`     | 不定長配列                     |
| `bf ... ff`           | `{_ key: val, ...}` | 不定長マップ                   |

---

## ASTノード クラス定義

```typescript
// 全ノードの共通基底
abstract class CborValue {
  abstract toCBOR(): Uint8Array;
  abstract toEDN(options?: EDNOptions): string;
  abstract toJS(): unknown;
}

class CborUint extends CborValue {
  constructor(value: bigint | number);
  value: bigint; // 常に bigint で保持
}

class CborNint extends CborValue {
  constructor(value: bigint | number); // 例: -1 → value = 0n (CBORのraw引数値)
  value: bigint; // -1 - n の n を保持 (CBORのraw値)
}

class CborByteString extends CborValue {
  constructor(value: Uint8Array);
  readonly indefiniteLength: false;
  value: Uint8Array;
  ednEncoding: 'hex' | 'base64' | 'base64url'; // EDN出力形式 (デフォルト: 'hex')
}

class CborIndefiniteByteString extends CborValue {
  constructor(chunks: CborByteString[]);
  readonly indefiniteLength: true;
  chunks: CborByteString[]; // 各チャンクは定長 CborByteString
}

class CborTextString extends CborValue {
  constructor(value: string);
  readonly indefiniteLength: false;
  value: string;
}

class CborIndefiniteTextString extends CborValue {
  constructor(chunks: CborTextString[]);
  readonly indefiniteLength: true;
  chunks: CborTextString[]; // 各チャンクは定長 CborTextString
}

class CborArray extends CborValue {
  constructor(items: CborValue[], options?: { indefiniteLength?: boolean });
  items: CborValue[];
  indefiniteLength: boolean; // true → EDNで [_ ...] 出力、toCBOR()でも不定長エンコード
}

class CborMap extends CborValue {
  constructor(
    entries: [CborValue, CborValue][],
    options?: { indefiniteLength?: boolean }
  );
  entries: [CborValue, CborValue][];
  indefiniteLength: boolean; // true → EDNで {_ ...} 出力
}

class CborTag extends CborValue {
  constructor(tag: bigint | number, content: CborValue);
  tag: bigint;
  content: CborValue;
}

class CborFloat extends CborValue {
  constructor(
    value: number,
    options?: { precision?: 'half' | 'single' | 'double' }
  );
  value: number;
  precision: 'half' | 'single' | 'double'; // エンコーディングサイズ
}

class CborSimple extends CborValue {
  constructor(value: number); // 0-255
  value: number;

  static readonly TRUE: CborSimple; // simple(21) → true
  static readonly FALSE: CborSimple; // simple(20) → false
  static readonly NULL: CborSimple; // simple(22) → null
  static readonly UNDEFINED: CborSimple; // simple(23) → undefined
}
```

---

## メインAPI

```typescript
class CBOR {
  // ─── ファクトリメソッド (入力) ───────────────────────────────

  /** CBORバイナリ → AST */
  static fromCBOR(bytes: Uint8Array, options?: FromCBOROptions): CborValue;

  /** CBOR-EDNテキスト → AST */
  static fromEDN(text: string, options?: FromEDNOptions): CborValue;

  /** JavaScript値 → AST */
  static fromJS(value: unknown, options?: FromJSOptions): CborValue;

  // ─── ショートカットAPI (JSON互換) ────────────────────────────

  /** CBORバイナリ → JavaScript値 */
  static decode(
    bytes: Uint8Array,
    options?: FromCBOROptions & FromJSOptions
  ): unknown;

  /** JavaScript値 → CBORバイナリ */
  static encode(value: unknown, options?: FromJSOptions): Uint8Array;

  /** CBOR-EDNテキスト → JavaScript値 */
  static parse(text: string, options?: FromEDNOptions): unknown;

  /** JavaScript値 → CBOR-EDNテキスト */
  static stringify(
    value: unknown,
    options?: FromJSOptions & EDNOptions
  ): string;
}
```

---

## オプション型

```typescript
interface FromCBOROptions {
  /** タグ変換プラグイン (v1: 未実装) */
  tagConverters?: TagConverter[];
}

interface FromEDNOptions {
  /** app-string のサポート (v1: 未実装) */
  appStrings?: Record<string, AppStringConverter>;
}

interface FromJSOptions {
  /** 整数値の number を CborUint/CborNint にするか CborFloat にするか */
  integerAs?: 'int' | 'float'; // デフォルト: 'int'
  /** Uint8Array の扱い */
  uint8ArrayAs?: 'bytes' | 'array'; // デフォルト: 'bytes'
  /** タグ変換プラグイン (v1: 未実装) */
  tagConverters?: TagConverter[];
}

interface EDNOptions {
  /** インデント (未指定=1行出力) */
  indent?: number | string;
  /** バイト列のデフォルト出力形式 */
  byteStringEncoding?: 'hex' | 'base64' | 'base64url'; // デフォルト: 'hex'
  /**
   * 長い文字列を EDN の文字列連結構文 ("aaa" + "bbb") で整形するか
   * indent が指定されている場合のみ有効
   * 'newline' : 改行文字で分割して各行を個別の文字列リテラルにする
   * 'cboredn' : 値が CBOR-EDN (JSON上位互換) としてパース可能な場合、EDNの構造に合わせてインデントを付けて分割する
   * 両方指定した場合は cboredn を優先し、CBOR-EDN としてパースできない場合のみ newline を適用する
   */
  textStringFormat?: ('newline' | 'cboredn')[];
}
```

---

## タグ変換プラグイン（将来実装）

v1ではCborTagはrawのまま保持。将来バージョン向けにインターフェースを定義。

```typescript
interface TagConverter<T = unknown> {
  /** 対象タグ番号 */
  tag: bigint;

  /**
   * CborTag の content を JS値に変換する (toJS()時に呼ばれる)
   * 変換できない場合は undefined を返すと生の CborTag が使われる
   */
  toJS(content: CborValue, tag: bigint): T | undefined;

  /**
   * JS値から CborTag を生成する (fromJS()時に呼ばれる)
   * 対象外の値の場合は undefined を返す
   */
  fromJS?(value: T): CborTag | undefined;
}

// 使用例 (将来バージョン)
const DateTimeConverter: TagConverter<Date> = {
  tag: 1n,
  toJS(content) {
    if (content instanceof CborTextString) return new Date(content.value);
    if (content instanceof CborUint || content instanceof CborFloat)
      return new Date(Number(content.value) * 1000);
  },
  fromJS(value) {
    if (value instanceof Date)
      return new CborTag(1n, new CborTextString(value.toISOString()));
  },
};

// オプションに渡す
const ast = CBOR.fromCBOR(bytes, {
  tagConverters: [DateTimeConverter],
});
ast.toJS(); // tag 1 の値は Date 型になる
```

---

## 型マッピング詳細

### fromJS() — JS値 → CborValue

| JavaScript型            | CborValue               | 条件                            |
| ----------------------- | ----------------------- | ------------------------------- |
| `number` (整数値)       | `CborUint` / `CborNint` | `integerAs: 'int'` かつ整数値   |
| `number` (小数/NaN/Inf) | `CborFloat`             |                                 |
| `bigint` (≥0)           | `CborUint`              |                                 |
| `bigint` (<0)           | `CborNint`              |                                 |
| `string`                | `CborTextString`        |                                 |
| `true`                  | `CborSimple.TRUE`       |                                 |
| `false`                 | `CborSimple.FALSE`      |                                 |
| `null`                  | `CborSimple.NULL`       |                                 |
| `undefined`             | `CborSimple.UNDEFINED`  |                                 |
| `Uint8Array`            | `CborByteString`        | `uint8ArrayAs: 'bytes'`         |
| `Array`                 | `CborArray`             | 再帰的に変換                    |
| `Map`                   | `CborMap`               | キーも再帰的に CborValue に変換 |
| plain `object`          | `CborMap`               | キーは `CborTextString`         |

### toJS() — CborValue → JS値

| CborValue                             | JavaScript型                      | 条件                                |
| ------------------------------------- | --------------------------------- | ----------------------------------- |
| `CborUint` / `CborNint`               | `number`                          | 値が `Number.MAX_SAFE_INTEGER` 以下 |
| `CborUint` / `CborNint`               | `bigint`                          | 値が `Number.MAX_SAFE_INTEGER` 超   |
| `CborFloat`                           | `number`                          | NaN, Infinity も対応                |
| `CborByteString`                      | `Uint8Array`                      |                                     |
| `CborIndefiniteByteString`            | `Uint8Array`                      | チャンクを結合して返す              |
| `CborTextString`                      | `string`                          |                                     |
| `CborIndefiniteTextString`            | `string`                          | チャンクを結合して返す              |
| `CborArray`                           | `unknown[]`                       | 再帰的に変換                        |
| `CborMap` (全キーが `CborTextString`) | `Record<string, unknown>`         |                                     |
| `CborMap` (それ以外)                  | `Map<unknown, unknown>`           |                                     |
| `CborTag`                             | `{ tag: bigint, value: unknown }` | v1: タグ変換なし                    |
| `CborSimple(20)`                      | `false`                           |                                     |
| `CborSimple(21)`                      | `true`                            |                                     |
| `CborSimple(22)`                      | `null`                            |                                     |
| `CborSimple(23)`                      | `undefined`                       |                                     |
| `CborSimple(n)`                       | `{ simple: number }`              |                                     |

---

## 使用例

```typescript
// ─── CBORバイナリを操作 ─────────────────────────────────────
const ast = CBOR.fromCBOR(binaryData);
ast.toEDN(); // → CBOR-EDNテキスト
ast.toJS(); // → JavaScript値
ast.toCBOR(); // → 元と同一のバイナリ (ロスレス)

// ─── CBOR-EDNテキストを操作 ──────────────────────────────────
const ast = CBOR.fromEDN(`{1: "one", h'ff': [true, null]}`);
ast.toCBOR(); // → バイナリ
ast.toJS(); // → Map { ... }

// ─── 不定長エンコーディング ───────────────────────────────────
const ast = CBOR.fromEDN(`[_ 1, 2, 3]`)(ast as CborArray).indefiniteLength; // → true
ast.toCBOR(); // → 不定長配列としてエンコード
ast.toEDN(); // → [_ 1, 2, 3]

// ─── JavaScript値を操作 ──────────────────────────────────────
const ast = CBOR.fromJS({ name: 'Alice', age: 30 });
ast.toEDN(); // → {"name": "Alice", "age": 30}
ast.toCBOR(); // → バイナリ

// ─── ASTを直接構築 ───────────────────────────────────────────
const ast = new CborTag(1n, new CborTextString('2013-03-21T20:04:00Z'));
ast.toEDN(); // → 1("2013-03-21T20:04:00Z")
ast.toCBOR(); // → c1 74 323031332d...

// ─── ショートカットAPI ───────────────────────────────────────
CBOR.decode(bytes); // CBORバイナリ → JS値
CBOR.encode({ a: 1 }); // JS値 → CBORバイナリ
CBOR.parse(`[1, h'ff', true]`); // EDNテキスト → JS値
CBOR.stringify({ a: 1 }); // JS値 → EDNテキスト
```

---

## v1 実装スコープ

### 実装する

- [ ] CBORバイナリ パーサー（全Major Type + 不定長）
- [ ] CBORバイナリ シリアライザー（全Major Type + 不定長）
- [ ] CBOR-EDN パーサー（不定長 `[_ ...]`, `{_ ...}`, `(_ ...)` 含む）
- [ ] CBOR-EDN シリアライザー（不定長含む）
- [ ] JavaScript値 ↔ CborValue 相互変換
- [ ] 全ASTノードクラス
- [ ] ショートカットAPI (`encode` / `decode` / `parse` / `stringify`)

### 将来対応（設計のみ用意）

- [ ] `TagConverter` プラグイン機構（tag semantics の自動解釈）
- [ ] 正規化オプション（Canonical CBOR / Deterministic CBOR）
- [ ] app-string サポート（`dt'...'`, `ip'...'` 等）
- [x] `EDNOptions.textStringFormat` — 文字列連結構文による整形出力
  - `'newline'`: 改行文字で分割し、各行を `"line\n" + "line\n"` の形式で出力
  - `'cboredn'`: 値が CBOR-EDN (JSON上位互換) としてパース可能な場合、EDN構造に沿ってインデント付きで分割出力
  - 両方指定時は `cboredn` を優先し、CBOR-EDN としてパースできない場合のみ `newline` を適用
  - `indent` が未指定の場合は無効

---

## 参照仕様

- [RFC 8949 - Concise Binary Object Representation (CBOR)](https://www.rfc-editor.org/rfc/rfc8949)
- [draft-ietf-cbor-edn-literals - CBOR Extended Diagnostic Notation](https://datatracker.ietf.org/doc/draft-ietf-cbor-edn-literals/)
