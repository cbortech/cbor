/**
 * CDDL AST node definitions.
 *
 * Unlike the CBOR side (class-based CborItem nodes), the CDDL AST is a plain
 * discriminated-union structure: nodes are produced by the parser, consumed
 * by the compiler/writer (and, in a later phase, the validator), and never
 * carry behavior of their own.
 *
 * All nodes carry `start`/`end` character offsets into the parsed source so
 * diagnostics and editor tooling can point at exact ranges.
 */

export interface CddlNodeBase {
  /** Character offset of the first character of this node in the source. */
  start: number;
  /** Character offset just past the last character of this node. */
  end: number;
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/**
 * rule = typename [genericparm] S assignt S type
 *      / groupname [genericparm] S assigng S grpent
 *
 * Both forms are parsed into the same shape: `body` is a group entry, which
 * subsumes a plain type (an entry with no occurrence and no member key).
 * Whether a rule is used as a type or as a group is resolved semantically at
 * validation time, not at parse time.
 */
export interface CddlRule extends CddlNodeBase {
  kind: 'rule';
  name: string;
  /** Generic parameter names from `name<A, B> = …`, if any. */
  generics?: string[];
  /** '=' defines; '/=' extends a type choice; '//=' extends a group choice. */
  assign: '=' | '/=' | '//=';
  body: CddlGroupEntry;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** type = type1 *(S "/" S type1) — always wrapped, even for one alternative. */
export interface CddlType extends CddlNodeBase {
  kind: 'type';
  alternatives: CddlType1[];
}

/** type1 = type2 [S (rangeop / ctlop) S type2] */
export interface CddlType1 extends CddlNodeBase {
  kind: 'type1';
  target: CddlType2;
  /** Present when a range or control operator follows the target. */
  op?: { kind: 'range'; inclusive: boolean } | { kind: 'ctl'; name: string };
  /** The right-hand operand; present exactly when `op` is present. */
  controller?: CddlType2;
}

export type CddlType2 =
  | CddlValue
  | CddlRef
  | CddlParenType
  | CddlMapType
  | CddlArrayType
  | CddlUnwrap
  | CddlEnum
  | CddlTagged
  | CddlMajor
  | CddlAny;

/** A literal value: number, text string, or byte string. */
export type CddlValue = CddlNodeBase & { kind: 'value'; raw: string } & (
    | { type: 'int'; value: number | bigint }
    | { type: 'float'; value: number }
    | { type: 'text'; value: string }
    | { type: 'bytes'; value: Uint8Array; qualifier: '' | 'h' | 'b64' }
  );

/** typename [genericarg] — also used for groupname references. */
export interface CddlRef extends CddlNodeBase {
  kind: 'ref';
  name: string;
  genericArgs?: CddlType1[];
}

/** "(" S type S ")" */
export interface CddlParenType extends CddlNodeBase {
  kind: 'paren';
  type: CddlType;
}

/** "{" S group S "}" */
export interface CddlMapType extends CddlNodeBase {
  kind: 'map';
  group: CddlGroup;
}

/** "[" S group S "]" */
export interface CddlArrayType extends CddlNodeBase {
  kind: 'array';
  group: CddlGroup;
}

/** "~" S typename [genericarg] */
export interface CddlUnwrap extends CddlNodeBase {
  kind: 'unwrap';
  ref: CddlRef;
}

/** "&" S "(" S group S ")" / "&" S groupname [genericarg] */
export interface CddlEnum extends CddlNodeBase {
  kind: 'enum';
  group: CddlGroup | CddlRef;
}

/**
 * "#" "6" ["." head-number] "(" S type S ")" — a tagged item.
 * `tag` is a literal tag number, a `<type>` head-number expression
 * (RFC 9682 §3.2), or absent for `#6(…)` (any tag number).
 */
export interface CddlTagged extends CddlNodeBase {
  kind: 'tagged';
  tag?: bigint | CddlType;
  item: CddlType;
  /**
   * Source text of the '#6[.head]' part (e.g. '#6.0x10') when the tag number
   * is literal or absent; lets the formatter preserve the number base.
   */
  raw?: string;
}

/**
 * "#" DIGIT ["." uint] and "#" "7" ["." head-number] — a major type,
 * optionally constrained by additional information (or, for major 7, the
 * simple value / float head-number, which may be a `<type>` expression).
 */
export interface CddlMajor extends CddlNodeBase {
  kind: 'major';
  major: number;
  ai?: bigint | CddlType;
  /**
   * Source text of the '#N[.ai]' expression (e.g. '#7.0b11001') when the
   * head-number is literal or absent; lets the formatter preserve the
   * number base.
   */
  raw?: string;
}

/** "#" — any data item. */
export interface CddlAny extends CddlNodeBase {
  kind: 'any';
}

// ─── Groups ───────────────────────────────────────────────────────────────────

/** group = grpchoice *(S "//" S grpchoice); each choice is an entry list. */
export interface CddlGroup extends CddlNodeBase {
  kind: 'group';
  choices: CddlGroupEntry[][];
  /**
   * True when the final entry is followed by a comma (optcom). Commas
   * between entries are cosmetic and not recorded, but the trailing comma is
   * syntactically significant: `(int,)` is a group, never a parenthesized
   * type, so e.g. it cannot be the root of a data model.
   */
  trailingComma?: boolean;
}

export type CddlGroupEntry = CddlEntryValue | CddlEntryGroup;

/** grpent = [occur S] [memberkey S] type — also covers bare group references. */
export interface CddlEntryValue extends CddlNodeBase {
  kind: 'entry';
  occur?: CddlOccur;
  memberKey?: CddlMemberKey;
  value: CddlType;
}

/** grpent = [occur S] "(" S group S ")" — an inline parenthesized group. */
export interface CddlEntryGroup extends CddlNodeBase {
  kind: 'entry-group';
  occur?: CddlOccur;
  group: CddlGroup;
}

/**
 * occur = [uint] "*" [uint] / "+" / "?"
 * marker '*' covers `*`, `n*`, `*m`, and `n*m` via min/max.
 */
export interface CddlOccur extends CddlNodeBase {
  kind: 'occur';
  marker: '?' | '+' | '*';
  min?: number;
  max?: number;
}

/**
 * memberkey = type1 S ["^" S] "=>"
 *           / bareword S ":"
 *           / value S ":"
 *
 * `cut` is true for the ':' forms (implicit cut, RFC 8610 §3.5.4) and for
 * the explicit `^ =>` form.
 */
export type CddlMemberKey = CddlNodeBase & { cut: boolean } & (
    | { kind: 'type1'; key: CddlType1 }
    | { kind: 'bareword'; key: string }
    | { kind: 'value'; key: CddlValue }
  );
