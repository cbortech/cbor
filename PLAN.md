# 実装計画

## プロジェクト設定（既存）

| ツール                 | バージョン | 役割                                        |
| ---------------------- | ---------- | ------------------------------------------- |
| TypeScript             | 5.9        | 言語（strict mode）                         |
| Vite + vite-plugin-dts | 7.x        | ESM/CJSデュアルビルド + 型定義生成          |
| Vitest                 | 4.x        | テストランナー（Node + Playwrightブラウザ） |
| Prettier               | 3.x        | コードフォーマット                          |

`tsconfig.json` の `target: "ES2020"` により `bigint`・`DataView`・`TextEncoder`/`TextDecoder` がネイティブ利用可能。外部依存パッケージの追加は不要。

---

## ディレクトリ構成

```
src/
├── index.ts                          # 公開APIの再エクスポート（エントリポイント）
├── types.ts                          # オプション型・プラグイン型定義
├── float16.ts                        # float16エンコード・デコードユーティリティ（実装済み）
├── float16.test.ts                   # float16テスト（実装済み）
│
├── ast/                              # フェーズ2: ASTノード群
│   ├── CborValue.ts                  # 抽象基底クラス
│   ├── CborUint.ts
│   ├── CborNint.ts
│   ├── CborByteString.ts
│   ├── CborIndefiniteByteString.ts
│   ├── CborTextString.ts
│   ├── CborIndefiniteTextString.ts
│   ├── CborArray.ts
│   ├── CborMap.ts
│   ├── CborTag.ts
│   ├── CborFloat.ts
│   ├── CborSimple.ts
│   ├── index.ts
│   └── ast.test.ts
│
├── cbor/                             # フェーズ3・4: CBORバイナリ処理
│   ├── constants.ts                  # Major Type定数・half-float変換ユーティリティ
│   ├── decoder.ts                    # バイナリ → AST
│   ├── encoder.ts                    # AST → バイナリ
│   ├── decoder.test.ts
│   └── encoder.test.ts
│
├── edn/                              # フェーズ5・7: EDN処理
│   ├── serializer.ts                 # AST → EDNテキスト
│   ├── tokenizer.ts                  # EDNレキサー（parserの内部モジュール）
│   ├── parser.ts                     # EDNテキスト → AST
│   ├── serializer.test.ts
│   └── parser.test.ts
│
├── js/                               # フェーズ6: JS値変換
│   ├── fromJS.ts                     # JS値 → AST
│   ├── toJS.ts                       # AST → JS値（共通ロジック）
│   └── js.test.ts
│
├── CBOR.ts                           # フェーズ8: メインCBORクラス
└── CBOR.test.ts
```

---

## 実装フェーズ一覧

| #   | フェーズ                 | 成果物                              | 依存 |
| --- | ------------------------ | ----------------------------------- | ---- |
| 1   | プロジェクトセットアップ | 骨格ファイル群・型定義              | —    |
| 2   | ASTノードクラス群        | `src/ast/`                          | 1    |
| 3   | CBORデコーダ             | `src/cbor/decoder.ts`               | 2    |
| 4   | CBORエンコーダ           | `src/cbor/encoder.ts`               | 2, 3 |
| 5   | EDNシリアライザ          | `src/edn/serializer.ts`             | 2    |
| 6   | JS値変換                 | `src/js/fromJS.ts`, `toJS.ts`       | 2    |
| 7   | EDNパーサ                | `src/edn/tokenizer.ts`, `parser.ts` | 2, 5 |
| 8   | メインCBORクラス         | `src/CBOR.ts`, `src/index.ts`       | 3〜7 |
| 9   | 総合テスト               | —                                   | 8    |

推奨着手順序: **2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**
（フェーズ5が揃うと3・4のデバッグが容易になるため早めに実装する）

---

## フェーズ1: プロジェクトセットアップ

### 目的

既存のスケルトン（`greet` 関数）を削除し、ライブラリとしての骨格を整える。

### タスク

- `src/index.ts` をエントリポイントとして書き直す（各フェーズで追記していく）
- `src/types.ts` を作成し、以下の型を定義する
  - `FromCBOROptions`, `FromEDNOptions`, `FromJSOptions`, `EDNOptions`
  - `TagConverter<T>` インターフェース（v1では未使用、設計のみ）
  - `AppStringConverter` インターフェース（v1では未使用、設計のみ）
- `src/ast/`, `src/cbor/`, `src/edn/`, `src/js/` ディレクトリを作成する
- `src/index.test.ts` のgreetテストを削除し、smoke testを置く

### 確認

- `npm run build` が通ること
- `npm run typecheck` が通ること

---

## フェーズ2: ASTノードクラス群

### 目的

全11クラスを実装し、ASTを直接構築・操作できる状態にする。
`toCBOR()`/`toEDN()`/`toJS()` はこのフェーズでは `throw new Error('not implemented')` のスタブでよい。

### 実装ポイント

**`CborValue` 抽象基底クラス**

```typescript
abstract class CborValue {
  abstract toCBOR(): Uint8Array;
  abstract toEDN(options?: EDNOptions): string;
  abstract toJS(): unknown;
}
```

**各クラスの注意点**

| クラス           | 注意点                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `CborUint`       | `number \| bigint` を受け取り、常に `bigint` で保持                                                           |
| `CborNint`       | コンストラクタは「実際の負の値」を受け取る（例: `-5n`）。内部では CBORのraw値 `n = -1 - value` に変換して保持 |
| `CborFloat`      | `precision` 未指定時は `'double'` をデフォルトとし、エンコーダ側で最小精度を自動選択する設計                  |
| `CborByteString` | `ednEncoding` プロパティのデフォルトは `'hex'`                                                                |
| `CborSimple`     | `static readonly TRUE = new CborSimple(21)` 等の定数を定義                                                    |

### テスト（`src/ast/ast.test.ts`）

- コンストラクタで値が正しく保持されること
- `CborNint` の実際値 ↔ raw値変換が正しいこと
- `CborSimple.TRUE.value === 21` 等の静的定数確認
- `instanceof` チェックの動作確認

---

## フェーズ3: CBORデコーダ（バイナリ → AST）

### 目的

RFC 8949の全 Major Type（0〜7）と不定長エンコーディングをデコードする。

### 実装ポイント

**コアロジック**

```typescript
// 内部関数
function decodeItem(
  view: DataView,
  offset: number
): { value: CborValue; nextOffset: number };
```

再帰的な設計。現在オフセットから1アイテムを読み取って返す。

**追加情報（additional info）の処理**

| AI値  | 処理                                                 |
| ----- | ---------------------------------------------------- |
| 0〜23 | 値がそのまま                                         |
| 24    | 次の1バイト                                          |
| 25    | 次の2バイト（big-endian）                            |
| 26    | 次の4バイト                                          |
| 27    | 次の8バイト → `DataView.getBigUint64(offset, false)` |
| 31    | 不定長（break code）                                 |

**half-precision float（float16）のデコード**
`src/float16.ts` の `readFloat16(view, offset, littleEndian)` を使用する（実装済み）。
CBORはビッグエンディアン固定なので `littleEndian = false` で呼び出す。

**`(_ ...)` 不定長バイト列・テキスト列**

- `0x5f` → breakまで `CborByteString` チャンクを蓄積 → `CborIndefiniteByteString`
- `0x7f` → breakまで `CborTextString` チャンクを蓄積 → `CborIndefiniteTextString`

### テスト（`src/cbor/decoder.test.ts`）

- **RFC 8949 Appendix A の全テストベクタ**（約70件）を使用
- 不定長配列・マップ・バイト列・テキスト列のデコード
- truncated input でのエラーハンドリング
- half-precision float の特殊値（NaN, Infinity, -Infinity, 0.0）

---

## フェーズ4: CBORエンコーダ（AST → バイナリ）

### 目的

各 `CborValue` の `toCBOR()` メソッドを実装する。
エンコーダの共通ロジックは `src/cbor/encoder.ts` の `CborEncoder` クラスに集約する。

### 実装ポイント

**バッファ管理**

```typescript
class CborEncoder {
  private buffer: number[] = [];
  writeHead(majorType: number, value: bigint): void; // AI選択を自動化
  writeBytes(bytes: Uint8Array): void;
  finish(): Uint8Array;
}
```

**`writeHead` のAI選択ロジック**

| 値の範囲          | エンコード方法            |
| ----------------- | ------------------------- |
| 0〜23             | 初期バイトのみ（1バイト） |
| 24〜255           | AI=24 + 1バイト           |
| 256〜65535        | AI=25 + 2バイト           |
| 65536〜4294967295 | AI=26 + 4バイト           |
| 4294967296〜      | AI=27 + 8バイト           |

**不定長エンコーディングの再現**

- `CborArray.indefiniteLength === true` → `0x9f` + items + `0xff`
- `CborMap.indefiniteLength === true` → `0xbf` + entries + `0xff`
- `CborIndefiniteByteString` → `0x5f` + chunks + `0xff`
- `CborIndefiniteTextString` → `0x7f` + chunks + `0xff`

**half-precision エンコード**
`src/float16.ts` の `writeFloat16(view, offset, value, littleEndian)` および
`float64ToFloat16Bits` / `float16BitsToFloat64` を使用する（実装済み）。

精度損失チェック（`canEncodeAsFloat16` / `canEncodeAsFloat32`）は `constants.ts` に実装：

```typescript
// float64 → float16 に変換したとき精度損失がないか
function canEncodeAsFloat16(value: number): boolean {
  return (
    float16BitsToFloat64(float64ToFloat16Bits(value)) === value ||
    Object.is(float16BitsToFloat64(float64ToFloat16Bits(value)), value)
  ); // -0対応
}
// float64 → float32 に変換したとき精度損失がないか
function canEncodeAsFloat32(value: number): boolean {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, value, false);
  return (
    buf.getFloat32(0, false) === value ||
    Object.is(buf.getFloat32(0, false), value)
  );
}
```

### テスト（`src/cbor/encoder.test.ts`）

- RFC 8949 Appendix A のテストベクタ（エンコード方向）
- 往復テスト: `decode(encode(ast))` が元の AST と等価
- **ロスレステスト**: `encode(decode(bytes))` が元のバイト列と完全一致
- `CborFloat` の最小精度自動選択の確認

---

## フェーズ5: EDNシリアライザ（AST → EDNテキスト）

### 目的

各 `CborValue` の `toEDN(options?: EDNOptions)` を実装する。
デバッグ用途としてもすぐに使えるため、フェーズ3・4のデバッグ効率が上がる。

### 各ノードのEDN表現

| ノード                            | EDN出力例                   |
| --------------------------------- | --------------------------- |
| `CborUint(42n)`                   | `42`                        |
| `CborNint(-5)`                    | `-5`                        |
| `CborByteString(...)` (hex)       | `h'deadbeef'`               |
| `CborByteString(...)` (base64)    | `b64'3q0='`                 |
| `CborByteString(...)` (base64url) | `b64url'3q0'`               |
| `CborIndefiniteByteString(...)`   | `(_ h'de', h'ad')`          |
| `CborTextString("hi")`            | `"hi"`                      |
| `CborIndefiniteTextString(...)`   | `(_ "h", "i")`              |
| `CborArray([1,2], indef=false)`   | `[1, 2]`                    |
| `CborArray([1,2], indef=true)`    | `[_ 1, 2]`                  |
| `CborMap([...], indef=false)`     | `{"key": "val"}`            |
| `CborMap([...], indef=true)`      | `{_ "key": "val"}`          |
| `CborTag(1n, ...)`                | `1("2013-03-21T20:04:00Z")` |
| `CborFloat(1.5, 'double')`        | `1.5`                       |
| `CborFloat(NaN)`                  | `NaN`                       |
| `CborFloat(Infinity)`             | `Infinity`                  |
| `CborSimple.TRUE`                 | `true`                      |
| `CborSimple.NULL`                 | `null`                      |
| `CborSimple.UNDEFINED`            | `undefined`                 |
| `CborSimple(99)`                  | `simple(99)`                |

### 実装ポイント

**インデント処理**
`indent` オプション指定時は `depth` を引き回して再帰的に整形：

```typescript
function serializeEDN(
  value: CborValue,
  options: EDNOptions,
  depth: number
): string;
```

**文字列エスケープ**
JSONのエスケープルール（`\"`・`\\`・`\n`・`\r`・`\t`・`\uXXXX`）に準拠。
制御文字（U+0000〜U+001F）はすべてエスケープ。

**floatの文字列化**

- 整数値の float（例: `1.0`）は必ず小数点付きで出力（`CborUint` と区別するため）
- `NaN`・`Infinity`・`-Infinity` はそのままキーワードとして出力

### テスト（`src/edn/serializer.test.ts`）

- 全ノード型の基本出力確認
- 不定長表現の正しい出力
- インデント付き出力のフォーマット確認
- バイト列の hex/base64/base64url 切り替え
- ネスト構造のインデント

---

## フェーズ6: JS値変換（fromJS / toJS）

### 目的

`src/js/fromJS.ts` と `src/js/toJS.ts` を実装し、
各ASTノードの `toJS()` メソッドを完成させる。

### fromJS の型判定順序

```typescript
function fromJS(value: unknown, options?: FromJSOptions): CborValue {
  if (value === null)              return CborSimple.NULL
  if (value === undefined)         return CborSimple.UNDEFINED
  if (value === true)              return CborSimple.TRUE
  if (value === false)             return CborSimple.FALSE
  if (typeof value === 'bigint')   → CborUint / CborNint
  if (typeof value === 'number')   → CborFloat or CborUint/CborNint (integerAs オプション)
  if (typeof value === 'string')   → CborTextString
  if (value instanceof Uint8Array) → CborByteString or CborArray (uint8ArrayAs オプション)
  if (Array.isArray(value))        → CborArray (再帰)
  if (value instanceof Map)        → CborMap (キーも再帰変換)
  if (typeof value === 'object')   → CborMap (string keys → CborTextString)
  throw TypeError
}
```

### toJS のマッピング

- `CborUint`/`CborNint`: 値 ≤ `Number.MAX_SAFE_INTEGER` → `number`、超過 → `bigint`
- `CborIndefiniteByteString`: チャンクを結合して単一の `Uint8Array` を返す
- `CborIndefiniteTextString`: チャンクを結合して単一の `string` を返す
- `CborMap` (全キーが `CborTextString`) → `Record<string, unknown>`
- `CborMap` (それ以外) → `Map<unknown, unknown>`
- `CborTag` → `{ tag: bigint, value: unknown }`（v1ではTagConverter未適用）
- `CborSimple(n)` (20/21/22/23以外) → `{ simple: number }`

### テスト（`src/js/js.test.ts`）

- 各JS型からのCborValue変換確認
- `toJS(fromJS(x)) === x` の往復等価性（プリミティブ・配列・Map）
- `Number.MAX_SAFE_INTEGER` 境界での `number`/`bigint` 切り替え
- `integerAs: 'float'` / `uint8ArrayAs: 'array'` オプション動作

---

## フェーズ7: EDNパーサ（EDNテキスト → AST）

### 目的

CBOR-EDNテキストをASTに変換する。最も複雑なフェーズ。
字句解析（tokenizer）と構文解析（parser）に分離して実装する。

### トークン定義（`src/edn/tokenizer.ts`）

```
INTEGER     // 整数リテラル: 42, -5, 0xFF, 0o77, 0b1010
FLOAT       // 浮動小数点: 1.5, 3.14e-2, NaN, Infinity, -Infinity
STRING      // テキスト文字列: "..."
BYTES_HEX   // h'...' または h"..."
BYTES_B64   // b64'...' または b64"..."
BYTES_B64URL// b64url'...' または b64url"..."
TRUE / FALSE / NULL / UNDEFINED
SIMPLE      // simple キーワード
LBRACKET / RBRACKET  // [ ]
LBRACE / RBRACE      // { }
LPAREN / RPAREN      // ( )
COLON       // :
COMMA       // ,
PLUS        // + (文字列連結)
UNDERSCORE  // _ (不定長マーカー)
TAG_NUMBER  // タグ番号（直後に ( が続く整数）
EOF
```

### パーサー設計（`src/edn/parser.ts`）

再帰降下パーサー（Recursive Descent Parser）を採用：

```typescript
class EDNParser {
  parseValue(): CborValue;
  parseArray(): CborArray; // [_ ...] or [...]
  parseMap(): CborMap; // {_ ...} or {...}
  parseParenGroup():
    | CborTag
    | CborIndefiniteByteString
    | CborIndefiniteTextString;
  parseNumber(token: Token): CborUint | CborNint | CborFloat;
  parseString(): CborTextString; // "..." + "..." の連結も処理
}
```

**`(_ ...)` の型決定**
最初のチャンクが `CborByteString` → `CborIndefiniteByteString`
最初のチャンクが `CborTextString` → `CborIndefiniteTextString`

**数値リテラルの処理**

- `0x` プレフィックス → 16進整数
- `0o` プレフィックス → 8進整数
- `0b` プレフィックス → 2進整数
- 小数点 or 指数 → `CborFloat`
- `NaN`, `Infinity`, `-Infinity` → `CborFloat`

**エラーレポート**
パースエラー時は行番号・列番号を含むメッセージを出力：

```
CBORError: Unexpected token '}' at line 3, column 5
```

### テスト（`src/edn/parser.test.ts`）

- 全ノード型の基本パース
- 不定長 `[_ ...]`, `{_ ...}`, `(_ h'...')`, `(_ "...")` のパース
- 整数の各進数表記（0x, 0o, 0b）
- ネスト構造・複雑な組み合わせ
- エラーケース（不正構文での例外）
- **往復テスト**: `parse(serialize(ast))` が元のASTと等価
- EDN仕様のサンプル文字列

---

## フェーズ8: メインCBORクラス + ショートカットAPI

### 目的

全フェーズの成果物を統合するファサードクラスを実装する。

### 実装

```typescript
// src/CBOR.ts
export class CBOR {
  private constructor() {} // インスタンス化禁止

  static fromCBOR(bytes: Uint8Array, options?: FromCBOROptions): CborValue;
  static fromEDN(text: string, options?: FromEDNOptions): CborValue;
  static fromJS(value: unknown, options?: FromJSOptions): CborValue;

  static decode(bytes: Uint8Array, options?: FromCBOROptions): unknown;
  static encode(value: unknown, options?: FromJSOptions): Uint8Array;
  static parse(text: string, options?: FromEDNOptions): unknown;
  static stringify(
    value: unknown,
    options?: FromJSOptions & EDNOptions
  ): string;
}
```

**`src/index.ts` の公開API**

```typescript
export { CborValue, CborUint, CborNint, ... } from './ast'
export type { FromCBOROptions, FromEDNOptions, FromJSOptions, EDNOptions, TagConverter } from './types'
export { CBOR } from './CBOR'
```

### テスト（`src/CBOR.test.ts`）

- SPEC.md「使用例」セクションの全コード例が動作すること
- ショートカットAPIの動作確認
- `encode(decode(bytes))` のロスレス確認
- `fromEDN → toCBOR → fromCBOR → toEDN` の完全往復

---

## フェーズ9: 総合テスト・整合性確認

### 目的

RFC 8949仕様への準拠と全方向のロスレス往復変換を最終確認する。

### テスト項目

**RFC 8949 Appendix A 全ベクタ確認**
付録A約70件のテストベクタで以下のカテゴリを網羅：

- 整数（uint/nint、1〜8バイト表現）
- 浮動小数点（half/single/double、NaN/Infinity含む）
- バイト列・テキスト列（空文字列含む）
- 配列・マップ（空・ネスト・不定長）
- タグ・単純値

**3方向往復テスト**

```
CBOR binary → AST → CBOR binary    （バイト完全一致）
CBOR binary → AST → EDN → AST → CBOR binary    （バイト完全一致）
JS value → AST → CBOR → AST → JS value    （値の等価性）
```

**ブラウザ環境テスト**
`npm run test:browser` で Chromium 上でも全テストがパスすることを確認。
`Buffer.from()` は使用禁止（`Uint8Array` + `TextEncoder`/`TextDecoder` のみ使用）。

---

## ブラウザ互換性の注意事項

実装全体を通じて以下を守ること：

- `Buffer`（Node.js専用）は使用しない → `Uint8Array` を使う
- `node:*` モジュールは使用しない
- `DataView.getFloat16()` は ES2025 のため使用不可 → 手動実装
- `TextEncoder`/`TextDecoder` を使用（ブラウザ・Node.js両対応）
