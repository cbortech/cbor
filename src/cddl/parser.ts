/**
 * CDDL recursive-descent parser (internal).
 *
 * Implements the grammar of RFC 8610 as updated by RFC 9682 Appendix A.
 * Produces the plain AST defined in ast.ts; all semantic processing
 * (prelude merging, name resolution, /= and //= extension) happens in
 * schema.ts.
 */

import { CddlTokenizer, type CddlComment, type CddlToken } from './tokenizer';
import { CddlSyntaxError } from './errors';
import { parseHexFloat } from '../utils/hexfloat';
import type {
  CddlEntryValue,
  CddlGroup,
  CddlGroupEntry,
  CddlMemberKey,
  CddlOccur,
  CddlRef,
  CddlRule,
  CddlType,
  CddlType1,
  CddlType2,
  CddlValue,
} from './ast';

export interface ParseCddlResult {
  /** Rules in source order (unmerged; `/=` and `//=` appear as-is). */
  rules: CddlRule[];
  /** `;` comments encountered while scanning, in source order. */
  comments: CddlComment[];
}

/**
 * Parse CDDL text into rule ASTs.
 * Throws {@link CddlSyntaxError} on invalid input.
 */
export function parseCDDL(text: string): ParseCddlResult {
  const tokenizer = new CddlTokenizer(text);
  const parser = new CddlParser(tokenizer);
  const rules = parser.parse();
  return { rules, comments: tokenizer.comments };
}

/** Token types that continue a type1/type/memberkey after a closing paren. */
const TYPE_CONTINUATION: ReadonlySet<string> = new Set([
  'SLASH',
  'RANGE_INCL',
  'RANGE_EXCL',
  'CTLOP',
  'ARROW',
  'CARET',
]);

class CddlParser {
  private readonly t: CddlTokenizer;
  private readonly buf: CddlToken[] = [];

  constructor(tokenizer: CddlTokenizer) {
    this.t = tokenizer;
  }

  // ─── Token plumbing ─────────────────────────────────────────────────────────

  private peek(i = 0): CddlToken {
    while (this.buf.length <= i) this.buf.push(this.t.consume());
    return this.buf[i]!;
  }

  private consume(): CddlToken {
    return this.buf.shift() ?? this.t.consume();
  }

  private expect(type: CddlToken['type'], what: string): CddlToken {
    const tok = this.peek();
    if (tok.type !== type) this._fail(`expected ${what}`, tok);
    return this.consume();
  }

  private _fail(message: string, tok: CddlToken): never {
    const got =
      tok.type === 'EOF' ? 'end of input' : `${JSON.stringify(tok.raw)}`;
    throw new CddlSyntaxError(`${message}, got ${got}`, {
      offset: tok.offset,
      endOffset: tok.endOffset,
      line: tok.line,
      column: tok.col,
    });
  }

  // ─── cddl = S *(rule S) ─────────────────────────────────────────────────────

  parse(): CddlRule[] {
    const rules: CddlRule[] = [];
    while (this.peek().type !== 'EOF') rules.push(this.parseRule());
    return rules;
  }

  /**
   * rule = typename [genericparm] S assignt S type
   *      / groupname [genericparm] S assigng S grpent
   *
   * For '=' (shared by assignt and assigng) the body is parsed as a group
   * entry, which subsumes a plain type. '/=' is assignt only, so its
   * right-hand side must be a plain type; '//=' (assigng) takes a grpent.
   */
  private parseRule(): CddlRule {
    const nameTok = this.expect('ID', 'a rule name');
    let generics: string[] | undefined;
    if (this.peek().type === 'LT') {
      this.consume();
      generics = [this.expect('ID', 'a generic parameter name').value];
      while (this.peek().type === 'COMMA') {
        this.consume();
        generics.push(this.expect('ID', 'a generic parameter name').value);
      }
      this.expect('GT', `'>' after generic parameters`);
    }
    const assignTok = this.peek();
    let assign: CddlRule['assign'];
    if (assignTok.type === 'ASSIGN') assign = '=';
    else if (assignTok.type === 'SLASH_EQ') assign = '/=';
    else if (assignTok.type === 'DSLASH_EQ') assign = '//=';
    else this._fail(`expected '=', '/=' or '//=' after rule name`, assignTok);
    this.consume();
    const body =
      assign === '/=' ? this.parseTypeAsEntry() : this.parseGroupEntry();
    return {
      kind: 'rule',
      name: nameTok.value,
      ...(generics ? { generics } : {}),
      assign,
      body,
      start: nameTok.offset,
      end: body.end,
    };
  }

  /** A plain type in rule-body position, wrapped as an entry AST node. */
  private parseTypeAsEntry(): CddlEntryValue {
    const value = this.parseType();
    return {
      kind: 'entry',
      value,
      start: value.start,
      end: value.end,
    };
  }

  // ─── Groups ─────────────────────────────────────────────────────────────────

  /** group = grpchoice *(S "//" S grpchoice), up to (not including) `closer`. */
  private parseGroup(closer: CddlToken['type']): CddlGroup {
    const start = this.peek().offset;
    const choices: CddlGroupEntry[][] = [[]];
    let lastWasComma = false;
    for (;;) {
      const tok = this.peek();
      if (tok.type === closer) break;
      if (tok.type === 'EOF')
        this._fail(
          `unterminated group; expected ${JSON.stringify(closer)}`,
          tok
        );
      if (tok.type === 'DSLASH') {
        this.consume();
        choices.push([]);
        lastWasComma = false;
        continue;
      }
      choices[choices.length - 1]!.push(this.parseGroupEntry());
      // optcom = S ["," S] — the comma after an entry is optional.
      lastWasComma = this.peek().type === 'COMMA';
      if (lastWasComma) this.consume();
    }
    const endTok = this.peek(); // the closer, consumed by the caller
    return {
      kind: 'group',
      choices,
      ...(lastWasComma ? { trailingComma: true } : {}),
      start,
      end: endTok.offset,
    };
  }

  /**
   * grpent = [occur S] [memberkey S] type
   *        / [occur S] groupname [genericarg]   ; covered by the type branch
   *        / [occur S] "(" S group S ")"
   */
  private parseGroupEntry(): CddlGroupEntry {
    const start = this.peek().offset;
    const occur = this.tryParseOccur();

    // Inline parenthesized group — unless what follows the ')' pulls the
    // parenthesized expression back into type position (e.g. `("a"/"b") .size 1`
    // is a paren *type* with a control operator, not a group entry).
    if (this.peek().type === 'LPAREN') {
      const lparen = this.consume();
      const group = this.parseGroup('RPAREN');
      const rparen = this.consume();
      if (TYPE_CONTINUATION.has(this.peek().type)) {
        const paren = this.groupAsParenType(group, lparen, rparen);
        const type1 = this.continueType1(paren);
        return this.finishEntryFromType1(start, occur, type1);
      }
      return {
        kind: 'entry-group',
        ...(occur ? { occur } : {}),
        group,
        start,
        end: rparen.endOffset,
      };
    }

    // memberkey shortcuts: bareword ":" and value ":"
    const t0 = this.peek(0);
    const t1 = this.peek(1);
    if (t1.type === 'COLON' && (t0.type === 'ID' || this.isValueToken(t0))) {
      let memberKey: CddlMemberKey;
      if (t0.type === 'ID') {
        this.consume();
        const colon = this.consume();
        memberKey = {
          kind: 'bareword',
          key: t0.value,
          cut: true,
          start: t0.offset,
          end: colon.endOffset,
        };
      } else {
        const key = this.parseValue();
        const colon = this.consume();
        memberKey = {
          kind: 'value',
          key,
          cut: true,
          start: key.start,
          end: colon.endOffset,
        };
      }
      const value = this.parseType();
      return {
        kind: 'entry',
        ...(occur ? { occur } : {}),
        memberKey,
        value,
        start,
        end: value.end,
      };
    }

    // General case: parse a type1, then decide whether it was a member key.
    const type1 = this.parseType1();
    return this.finishEntryFromType1(start, occur, type1);
  }

  /**
   * After parsing an initial type1 in entry position: `^`/`=>` make it a
   * member key (memberkey = type1 S ["^" S] "=>"); otherwise it starts the
   * entry's type and further `/` alternatives may follow.
   */
  private finishEntryFromType1(
    start: number,
    occur: CddlOccur | undefined,
    type1: CddlType1
  ): CddlEntryValue {
    let memberKey: CddlMemberKey | undefined;
    if (this.peek().type === 'CARET' || this.peek().type === 'ARROW') {
      let cut = false;
      if (this.peek().type === 'CARET') {
        this.consume();
        cut = true;
      }
      const arrow = this.expect('ARROW', `'=>' after member key`);
      memberKey = {
        kind: 'type1',
        key: type1,
        cut,
        start: type1.start,
        end: arrow.endOffset,
      };
    }
    const value = memberKey
      ? this.parseType()
      : this.continueTypeAlternatives(type1);
    return {
      kind: 'entry',
      ...(occur ? { occur } : {}),
      ...(memberKey ? { memberKey } : {}),
      value,
      start,
      end: value.end,
    };
  }

  /** occur = [uint] "*" [uint] / "+" / "?" — components must be adjacent. */
  private tryParseOccur(): CddlOccur | undefined {
    const t0 = this.peek(0);
    if (t0.type === 'QUEST') {
      this.consume();
      return {
        kind: 'occur',
        marker: '?',
        start: t0.offset,
        end: t0.endOffset,
      };
    }
    if (t0.type === 'PLUS') {
      this.consume();
      return {
        kind: 'occur',
        marker: '+',
        start: t0.offset,
        end: t0.endOffset,
      };
    }
    if (t0.type === 'STAR') {
      this.consume();
      let max: number | undefined;
      let end = t0.endOffset;
      const next = this.peek();
      if (next.type === 'INT' && next.offset === t0.endOffset) {
        max = this.occurBound(this.consume());
        end = next.endOffset;
      }
      return {
        kind: 'occur',
        marker: '*',
        ...(max !== undefined ? { max } : {}),
        start: t0.offset,
        end,
      };
    }
    // `n*` / `n*m` — only when INT and '*' are adjacent (per the ABNF, occur
    // has no interior whitespace; adjacency is what distinguishes the
    // occurrence `1*2` from the value 1 followed by the occurrence `*2`).
    if (
      t0.type === 'INT' &&
      !t0.value.startsWith('-') &&
      this.peek(1).type === 'STAR' &&
      this.peek(1).offset === t0.endOffset
    ) {
      const min = this.occurBound(this.consume());
      const star = this.consume();
      let max: number | undefined;
      let end = star.endOffset;
      const next = this.peek();
      if (next.type === 'INT' && next.offset === star.endOffset) {
        max = this.occurBound(this.consume());
        end = next.endOffset;
      }
      return { kind: 'occur', marker: '*', min, max, start: t0.offset, end };
    }
    return undefined;
  }

  private occurBound(tok: CddlToken): number {
    if (tok.value.startsWith('-'))
      this._fail('occurrence bounds must be unsigned integers', tok);
    const n = Number(tok.value);
    if (!Number.isSafeInteger(n))
      this._fail('occurrence bound is too large', tok);
    return n;
  }

  // ─── Types ──────────────────────────────────────────────────────────────────

  /** type = type1 *(S "/" S type1) */
  private parseType(): CddlType {
    return this.continueTypeAlternatives(this.parseType1());
  }

  private continueTypeAlternatives(first: CddlType1): CddlType {
    const alternatives = [first];
    while (this.peek().type === 'SLASH') {
      this.consume();
      alternatives.push(this.parseType1());
    }
    return {
      kind: 'type',
      alternatives,
      start: first.start,
      end: alternatives[alternatives.length - 1]!.end,
    };
  }

  /** type1 = type2 [S (rangeop / ctlop) S type2] */
  private parseType1(): CddlType1 {
    return this.continueType1(this.parseType2());
  }

  private continueType1(target: CddlType2): CddlType1 {
    const opTok = this.peek();
    let op: CddlType1['op'];
    if (opTok.type === 'RANGE_INCL' || opTok.type === 'RANGE_EXCL')
      op = { kind: 'range', inclusive: opTok.type === 'RANGE_INCL' };
    else if (opTok.type === 'CTLOP') op = { kind: 'ctl', name: opTok.value };
    if (!op)
      return { kind: 'type1', target, start: target.start, end: target.end };
    this.consume();
    const controller = this.parseType2();
    return {
      kind: 'type1',
      target,
      op,
      controller,
      start: target.start,
      end: controller.end,
    };
  }

  private parseType2(): CddlType2 {
    const tok = this.peek();
    switch (tok.type) {
      case 'INT':
      case 'FLOAT':
      case 'TSTR':
      case 'BYTES':
        return this.parseValue();

      case 'ID': {
        this.consume();
        return this.parseRefTail(tok);
      }

      case 'LPAREN': {
        const lparen = this.consume();
        const type = this.parseType();
        const rparen = this.expect(
          'RPAREN',
          `')' to close the parenthesized type`
        );
        return {
          kind: 'paren',
          type,
          start: lparen.offset,
          end: rparen.endOffset,
        };
      }

      case 'LBRACE': {
        const open = this.consume();
        const group = this.parseGroup('RBRACE');
        const close = this.consume();
        return {
          kind: 'map',
          group,
          start: open.offset,
          end: close.endOffset,
        };
      }

      case 'LBRACKET': {
        const open = this.consume();
        const group = this.parseGroup('RBRACKET');
        const close = this.consume();
        return {
          kind: 'array',
          group,
          start: open.offset,
          end: close.endOffset,
        };
      }

      case 'TILDE': {
        const tilde = this.consume();
        const nameTok = this.expect('ID', `a type name after '~'`);
        const ref = this.parseRefTail(nameTok);
        return { kind: 'unwrap', ref, start: tilde.offset, end: ref.end };
      }

      case 'AMP': {
        const amp = this.consume();
        if (this.peek().type === 'LPAREN') {
          this.consume();
          const group = this.parseGroup('RPAREN');
          const rparen = this.consume();
          return {
            kind: 'enum',
            group,
            start: amp.offset,
            end: rparen.endOffset,
          };
        }
        const nameTok = this.expect('ID', `a group name or '(' after '&'`);
        const ref = this.parseRefTail(nameTok);
        return { kind: 'enum', group: ref, start: amp.offset, end: ref.end };
      }

      case 'HASH':
        return this.parseHashType(this.consume());

      default:
        this._fail('expected a type', tok);
    }
  }

  /** Generic arguments after a just-consumed ID token: [genericarg]. */
  private parseRefTail(nameTok: CddlToken): CddlRef {
    if (this.peek().type !== 'LT')
      return {
        kind: 'ref',
        name: nameTok.value,
        start: nameTok.offset,
        end: nameTok.endOffset,
      };
    this.consume();
    const genericArgs = [this.parseType1()];
    while (this.peek().type === 'COMMA') {
      this.consume();
      genericArgs.push(this.parseType1());
    }
    const gt = this.expect('GT', `'>' after generic arguments`);
    return {
      kind: 'ref',
      name: nameTok.value,
      genericArgs,
      start: nameTok.offset,
      end: gt.endOffset,
    };
  }

  /**
   * '#' family, from a HASH token produced by the tokenizer:
   *   "#"                                  → any
   *   "#" "6" ["." head-number] "(" type ")" → tagged
   *   "#" "7" ["." head-number]            → major 7 (simple/float)
   *   "#" DIGIT ["." uint]                 → major/ai
   * head-number = uint / "<" type ">"       (RFC 9682 §3.2)
   */
  private parseHashType(tok: CddlToken): CddlType2 {
    if (tok.hashMajor === undefined) {
      if (tok.hashAIExpr || tok.hashAI !== undefined)
        this._fail(`'#' without a major type cannot take a head-number`, tok);
      return { kind: 'any', start: tok.offset, end: tok.endOffset };
    }
    const major = tok.hashMajor;

    let head: bigint | CddlType | undefined = tok.hashAI;
    let headEnd = tok.endOffset;
    if (tok.hashAIExpr) {
      if (major !== 6 && major !== 7)
        this._fail(
          `a <type> head-number is only allowed for #6 and #7 (RFC 9682 §3.2)`,
          tok
        );
      this.expect('LT', `'<' for the head-number expression`);
      head = this.parseType();
      const gt = this.expect('GT', `'>' after the head-number expression`);
      headEnd = gt.endOffset;
    }

    // For a literal (or absent) head-number, keep the '#…' source text so the
    // formatter can preserve the number base (e.g. '#6.0x10').
    const raw = tok.hashAIExpr ? undefined : tok.raw;

    if (major === 6 && this.peek().type === 'LPAREN') {
      this.consume();
      const item = this.parseType();
      const rparen = this.expect('RPAREN', `')' to close the tagged type`);
      return {
        kind: 'tagged',
        ...(head !== undefined ? { tag: head } : {}),
        item,
        ...(raw !== undefined ? { raw } : {}),
        start: tok.offset,
        end: rparen.endOffset,
      };
    }
    if (tok.hashAIExpr && major === 6)
      this._fail(`#6.<…> must be followed by '(' type ')'`, this.peek());

    return {
      kind: 'major',
      major,
      ...(head !== undefined ? { ai: head } : {}),
      ...(raw !== undefined ? { raw } : {}),
      start: tok.offset,
      end: headEnd,
    };
  }

  // ─── Values ─────────────────────────────────────────────────────────────────

  private isValueToken(tok: CddlToken): boolean {
    return (
      tok.type === 'INT' ||
      tok.type === 'FLOAT' ||
      tok.type === 'TSTR' ||
      tok.type === 'BYTES'
    );
  }

  private parseValue(): CddlValue {
    const tok = this.consume();
    const base = { start: tok.offset, end: tok.endOffset, raw: tok.raw };
    switch (tok.type) {
      case 'INT': {
        // BigInt() rejects a sign on 0x/0b literals — apply it separately.
        const big = tok.value.startsWith('-')
          ? -BigInt(tok.value.slice(1))
          : BigInt(tok.value);
        const value =
          big >= BigInt(Number.MIN_SAFE_INTEGER) &&
          big <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(big)
            : big;
        return { kind: 'value', type: 'int', value, ...base };
      }
      case 'FLOAT': {
        const value = /^-?0[xX]/.test(tok.value)
          ? parseHexFloat(tok.value)
          : parseFloat(tok.value);
        return { kind: 'value', type: 'float', value, ...base };
      }
      case 'TSTR':
        return { kind: 'value', type: 'text', value: tok.value, ...base };
      case 'BYTES':
        return {
          kind: 'value',
          type: 'bytes',
          value: tok.bytes!,
          qualifier: tok.qualifier!,
          ...base,
        };
      default:
        this._fail('expected a literal value', tok);
    }
  }

  /**
   * Reinterpret a parsed parenthesized group as a parenthesized *type* —
   * needed when a range/control operator, '/', or '=>' follows the ')'.
   * Only a group of exactly one plain entry (no occurrence, no member key,
   * no trailing comma, single choice) is a valid type.
   */
  private groupAsParenType(
    group: CddlGroup,
    lparen: CddlToken,
    rparen: CddlToken
  ): CddlType2 {
    const only =
      group.choices.length === 1 && group.choices[0]!.length === 1
        ? group.choices[0]![0]!
        : undefined;
    if (
      !only ||
      only.kind !== 'entry' ||
      only.occur ||
      only.memberKey ||
      group.trailingComma
    )
      this._fail(
        'this parenthesized group is used as a type (an operator follows), but it contains group syntax',
        this.peek()
      );
    return {
      kind: 'paren',
      type: only.value,
      start: lparen.offset,
      end: rparen.endOffset,
    };
  }
}
