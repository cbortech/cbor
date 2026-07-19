/**
 * CDDL formatter: serialize rule ASTs back to CDDL text.
 *
 * Two layouts:
 * - Compact (default): one rule per line with single-space separators.
 * - Pretty (`indent` set): groups with more than one entry (or group
 *   choices) put each entry on its own indented line; multi-line rules are
 *   separated by blank lines.
 *
 * Literal values are emitted verbatim from their source text (`raw`), so
 * number bases, string escapes, and byte-string qualifiers survive a round
 * trip. With `preserveComments`, `;` comments are re-attached by position
 * and none is dropped: rule leading/trailing, before a rule body (after
 * `=`), on group entries, before a group's closing delimiter, and — for
 * comments inside inline-only positions such as type choices — on the
 * enclosing rule's line end. The compact layout cannot hold an interior
 * line comment (`;` runs to the end of the line), so it hoists body
 * comments above the rule and keeps only rule-level placements.
 */

import type { CddlComment } from './tokenizer';
import type {
  CddlGroup,
  CddlGroupEntry,
  CddlMemberKey,
  CddlOccur,
  CddlRef,
  CddlRule,
  CddlType,
  CddlType1,
  CddlType2,
} from './ast';

export interface CddlFormatOptions {
  /**
   * Pretty-print groups with one entry per line, indented by this many
   * spaces (or by the given string). Omit for compact single-line rules.
   */
  indent?: number | string;
  /**
   * Re-emit `;` comments. Rule-level comments are kept in both layouts;
   * comments attached to group entries require `indent` (the pretty
   * layout). Only effective when the formatter has the comment stream and
   * source text — i.e. when called through `CddlSchema.format()`.
   */
  preserveComments?: boolean;
}

/** @internal Extras supplied by CddlSchema.format(). */
export interface CddlFormatContext {
  source?: string;
  comments?: readonly CddlComment[];
}

interface Notes {
  leading: string[];
  trailing: string[];
}

interface Ctx {
  /** Indent unit; null = compact layout. */
  unit: string | null;
  notes: Map<object, Notes> | null;
  /** Comments emitted before a group's closing delimiter. */
  endNotes: Map<CddlGroup, string[]> | null;
  /** Comments after the last rule (emitted at the end). */
  tail: string[];
}

const EMPTY_NOTES: Notes = { leading: [], trailing: [] };

/** Format rules (in the given order) as CDDL text with a trailing newline. */
export function formatCddl(
  rules: readonly CddlRule[],
  options?: CddlFormatOptions & CddlFormatContext
): string {
  const unit =
    options?.indent === undefined
      ? null
      : typeof options.indent === 'string'
        ? options.indent
        : ' '.repeat(options.indent);
  const ctx: Ctx = { unit, notes: null, endNotes: null, tail: [] };
  if (
    options?.preserveComments &&
    options.comments !== undefined &&
    options.comments.length > 0 &&
    options.source !== undefined
  ) {
    const built = buildNotes(rules, options.comments, options.source);
    ctx.notes = built.notes;
    ctx.endNotes = built.endNotes;
    ctx.tail = built.tail;
  }

  const parts: string[] = [];
  let prevMultiline = false;
  rules.forEach((rule, i) => {
    const { text, multiline } = formatRule(rule, ctx);
    // Blank line around rules with multi-line bodies in the pretty layout
    // (leading comments alone do not count).
    if (i > 0 && ctx.unit !== null && (multiline || prevMultiline))
      parts.push('');
    parts.push(text);
    prevMultiline = multiline;
  });
  for (const text of ctx.tail) parts.push(`;${text}`);
  if (parts.length === 0) return '';
  return parts.join('\n') + '\n';
}

// ─── Comment attachment ──────────────────────────────────────────────────────

interface Anchor {
  node: object;
  start: number;
  end: number;
  isRule: boolean;
}

/**
 * Associate each comment with the position it will be emitted at, so that
 * `preserveComments` never drops one:
 * - trailing on the rule/entry ending on the comment's line;
 * - else leading on the next rule/entry — but only when that target stays
 *   inside every group/rule enclosing the comment;
 * - else, for a comment inside a group with nothing after it (including
 *   empty groups), on the group's end position (before the closer);
 * - else, for a comment inside a rule's type expression (e.g. between type
 *   choices, which format inline), trailing on the rule;
 * - comments after everything go to `tail`.
 */
function buildNotes(
  rules: readonly CddlRule[],
  comments: readonly CddlComment[],
  source: string
): {
  notes: Map<object, Notes>;
  endNotes: Map<CddlGroup, string[]>;
  tail: string[];
} {
  // Line-start offsets for offset→line lookups (comments carry their line).
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++)
    if (source.charCodeAt(i) === 0x0a) lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based, matching CddlComment.line
  };

  const anchors: Anchor[] = [];
  // Group containment uses the span of the *construct* holding the group
  // (including its delimiters) — an empty group's own span is zero-width.
  const groups: { group: CddlGroup; start: number; end: number }[] = [];
  const addGroup = (group: CddlGroup, start: number, end: number): void => {
    groups.push({ group, start, end });
    for (const choice of group.choices) choice.forEach(addEntry);
  };
  const addEntry = (entry: CddlGroupEntry): void => {
    anchors.push({
      node: entry,
      start: entry.start,
      end: entry.end,
      isRule: false,
    });
    if (entry.kind === 'entry-group') {
      addGroup(entry.group, entry.start, entry.end);
      return;
    }
    for (const t1 of entry.value.alternatives) addType1(t1);
  };
  const addType1 = (t1: CddlType1): void => {
    addType2(t1.target);
    if (t1.controller) addType2(t1.controller);
  };
  const addType2 = (t2: CddlType2): void => {
    switch (t2.kind) {
      case 'map':
      case 'array':
        addGroup(t2.group, t2.start, t2.end);
        return;
      case 'paren':
        for (const t1 of t2.type.alternatives) addType1(t1);
        return;
      case 'enum':
        if (t2.group.kind === 'group') addGroup(t2.group, t2.start, t2.end);
        return;
      case 'tagged':
        if (typeof t2.tag === 'object')
          for (const t1 of t2.tag.alternatives) addType1(t1);
        for (const t1 of t2.item.alternatives) addType1(t1);
        return;
      default:
        return;
    }
  };
  for (const rule of rules) {
    anchors.push({
      node: rule,
      start: rule.start,
      end: rule.end,
      isRule: true,
    });
    addEntry(rule.body);
  }

  // Trailing lookup: maximal end ≤ comment start; rules win end-ties so a
  // comment after `a = int` lands on the rule, not on its body entry.
  const byEnd = [...anchors].sort(
    (a, b) => a.end - b.end || Number(a.isRule) - Number(b.isRule)
  );
  // Leading lookup: minimal start ≥ comment end; rules win start-ties.
  const byStart = [...anchors].sort(
    (a, b) => a.start - b.start || Number(b.isRule) - Number(a.isRule)
  );

  const notes = new Map<object, Notes>();
  const endNotes = new Map<CddlGroup, string[]>();
  const tail: string[] = [];
  const notesFor = (node: object): Notes => {
    let n = notes.get(node);
    if (!n) {
      n = { leading: [], trailing: [] };
      notes.set(node, n);
    }
    return n;
  };

  for (const c of comments) {
    // Trailing: the anchor ending last at or before the comment, same line.
    let trailingTo: Anchor | undefined;
    for (let i = byEnd.length - 1; i >= 0; i--) {
      const a = byEnd[i]!;
      if (a.end > c.start) continue;
      if (lineOf(Math.max(a.start, a.end - 1)) === c.line) trailingTo = a;
      break;
    }
    if (trailingTo) {
      notesFor(trailingTo.node).trailing.push(c.text);
      continue;
    }

    // Innermost group / rule whose span encloses the comment.
    let containerGroup:
      { group: CddlGroup; start: number; end: number } | undefined;
    for (const g of groups)
      if (
        g.start <= c.start &&
        c.end <= g.end &&
        (!containerGroup || g.start >= containerGroup.start)
      )
        containerGroup = g;
    const containerRule = rules.find(
      (r) => r.start <= c.start && c.end <= r.end
    );

    // Leading on the next rule/entry — only when that target does not
    // escape an enclosing construct (which would move the comment outside).
    const leadingTo = byStart.find((a) => a.start >= c.end);
    const escapesGroup =
      containerGroup !== undefined &&
      (leadingTo === undefined || leadingTo.start > containerGroup.end);
    const escapesRule =
      containerRule !== undefined &&
      (leadingTo === undefined || leadingTo.start > containerRule.end);
    if (leadingTo && !escapesGroup && !escapesRule) {
      notesFor(leadingTo.node).leading.push(c.text);
    } else if (escapesGroup) {
      // Nothing follows inside the group (or it is empty): emit the
      // comment just before the group's closing delimiter.
      const list = endNotes.get(containerGroup!.group) ?? [];
      list.push(c.text);
      endNotes.set(containerGroup!.group, list);
    } else if (escapesRule) {
      // Inside the rule's type expression (choices format inline): keep it
      // on the rule line as a trailing comment.
      notesFor(containerRule!).trailing.push(c.text);
    } else if (leadingTo) {
      notesFor(leadingTo.node).leading.push(c.text);
    } else {
      tail.push(c.text);
    }
  }
  return { notes, endNotes, tail };
}

// ─── Emission ─────────────────────────────────────────────────────────────────

const notesOf = (ctx: Ctx, node: object): Notes =>
  ctx.notes?.get(node) ?? EMPTY_NOTES;

const trailingText = (notes: Notes): string =>
  notes.trailing.length === 0
    ? ''
    : ' ' + notes.trailing.map((t) => `;${t}`).join(' ');

function formatRule(
  rule: CddlRule,
  ctx: Ctx
): { text: string; multiline: boolean } {
  const notes = notesOf(ctx, rule);
  const bodyNotes = notesOf(ctx, rule.body);
  const generics = rule.generics ? `<${rule.generics.join(', ')}>` : '';
  const head = `${rule.name}${generics} ${rule.assign}`;
  const trailing = trailingText({
    leading: [],
    trailing: [...bodyNotes.trailing, ...notes.trailing],
  });

  let main: string;
  let leading = notes.leading;
  if (bodyNotes.leading.length > 0 && ctx.unit !== null) {
    // Comments between `=` and the body get their own indented lines:
    //   a =
    //     ; important
    //     int
    const pad = ctx.unit;
    main = [
      head,
      ...bodyNotes.leading.map((t) => `${pad};${t}`),
      `${pad}${formatEntry(rule.body, ctx, 1)}${trailing}`,
    ].join('\n');
  } else {
    // Compact layout cannot hold a mid-line comment: hoist body-leading
    // comments above the rule so they are never dropped.
    if (bodyNotes.leading.length > 0)
      leading = [...leading, ...bodyNotes.leading];
    main = `${head} ${formatEntry(rule.body, ctx, 0)}${trailing}`;
  }

  const multiline = main.includes('\n');
  if (leading.length === 0) return { text: main, multiline };
  return {
    text: [...leading.map((t) => `;${t}`), main].join('\n'),
    multiline,
  };
}

function formatEntry(entry: CddlGroupEntry, ctx: Ctx, depth: number): string {
  const occur = entry.occur ? `${formatOccur(entry.occur)} ` : '';
  if (entry.kind === 'entry-group')
    return `${occur}${formatGroupBody(entry.group, ctx, depth, '(', ')')}`;
  const key = entry.memberKey
    ? `${formatMemberKey(entry.memberKey, ctx, depth)} `
    : '';
  return `${occur}${key}${formatType(entry.value, ctx, depth)}`;
}

function formatOccur(occur: CddlOccur): string {
  if (occur.marker !== '*') return occur.marker;
  return `${occur.min ?? ''}*${occur.max ?? ''}`;
}

function formatMemberKey(key: CddlMemberKey, ctx: Ctx, depth: number): string {
  switch (key.kind) {
    case 'bareword':
      return `${key.key}:`;
    case 'value':
      return `${key.key.raw}:`;
    case 'type1':
      return `${formatType1(key.key, ctx, depth)} ${key.cut ? '^ ' : ''}=>`;
  }
}

/**
 * A group between `open`/`close` delimiters. In the pretty layout, groups
 * with more than one entry (or more than one choice) are laid out one entry
 * per line; group choices are separated by a `//` line.
 */
function formatGroupBody(
  group: CddlGroup,
  ctx: Ctx,
  depth: number,
  open: string,
  close: string
): string {
  const entryCount = group.choices.reduce((n, c) => n + c.length, 0);
  const endComments = ctx.endNotes?.get(group) ?? [];
  // Any comment inside the group forces the multi-line layout — an inline
  // group cannot hold a `;` comment (it runs to the end of the line).
  const hasNotes =
    endComments.length > 0 ||
    (ctx.notes !== null &&
      group.choices.some((c) => c.some((e) => ctx.notes!.has(e))));
  const multiline =
    ctx.unit !== null &&
    (entryCount > 1 || group.choices.length > 1 || hasNotes);

  if (!multiline) {
    const body =
      group.choices
        .map((entries) =>
          entries.map((e) => formatEntry(e, ctx, depth)).join(', ')
        )
        .join(' // ') + (group.trailingComma ? ',' : '');
    return `${open}${body}${close}`;
  }

  const unit = ctx.unit!;
  const pad = unit.repeat(depth + 1);
  const lines: string[] = [open];
  group.choices.forEach((entries, ci) => {
    if (ci > 0) lines.push(`${pad}//`);
    entries.forEach((entry, ei) => {
      const notes = notesOf(ctx, entry);
      for (const t of notes.leading) lines.push(`${pad};${t}`);
      const isLast =
        ci === group.choices.length - 1 && ei === entries.length - 1;
      const comma = !isLast || group.trailingComma ? ',' : '';
      lines.push(
        `${pad}${formatEntry(entry, ctx, depth + 1)}${comma}${trailingText(notes)}`
      );
    });
  });
  // Comments with nothing after them inside the group (including comments
  // in empty groups) sit just before the closing delimiter.
  for (const t of endComments) lines.push(`${pad};${t}`);
  lines.push(`${unit.repeat(depth)}${close}`);
  return lines.join('\n');
}

function formatType(type: CddlType, ctx: Ctx, depth: number): string {
  return type.alternatives.map((t1) => formatType1(t1, ctx, depth)).join(' / ');
}

function formatType1(type1: CddlType1, ctx: Ctx, depth: number): string {
  const target = formatType2(type1.target, ctx, depth);
  if (!type1.op || !type1.controller) return target;
  const controller = formatType2(type1.controller, ctx, depth);
  if (type1.op.kind === 'range')
    return `${target}${type1.op.inclusive ? '..' : '...'}${controller}`;
  return `${target} .${type1.op.name} ${controller}`;
}

function formatRef(ref: CddlRef, ctx: Ctx, depth: number): string {
  const args = ref.genericArgs
    ? `<${ref.genericArgs.map((a) => formatType1(a, ctx, depth)).join(', ')}>`
    : '';
  return `${ref.name}${args}`;
}

function formatType2(type2: CddlType2, ctx: Ctx, depth: number): string {
  switch (type2.kind) {
    case 'value':
      return type2.raw;
    case 'ref':
      return formatRef(type2, ctx, depth);
    case 'paren':
      return `(${formatType(type2.type, ctx, depth)})`;
    case 'map':
      return formatGroupBody(type2.group, ctx, depth, '{', '}');
    case 'array':
      return formatGroupBody(type2.group, ctx, depth, '[', ']');
    case 'unwrap':
      return `~${formatRef(type2.ref, ctx, depth)}`;
    case 'enum':
      return type2.group.kind === 'ref'
        ? `&${formatRef(type2.group, ctx, depth)}`
        : `&${formatGroupBody(type2.group, ctx, depth, '(', ')')}`;
    case 'tagged': {
      const head =
        type2.raw ??
        (typeof type2.tag === 'object'
          ? `#6.<${formatType(type2.tag, ctx, depth)}>`
          : `#6${type2.tag === undefined ? '' : `.${type2.tag}`}`);
      return `${head}(${formatType(type2.item, ctx, depth)})`;
    }
    case 'major': {
      if (type2.raw !== undefined) return type2.raw;
      return typeof type2.ai === 'object'
        ? `#${type2.major}.<${formatType(type2.ai, ctx, depth)}>`
        : `#${type2.major}${type2.ai === undefined ? '' : `.${type2.ai}`}`;
    }
    case 'any':
      return '#';
  }
}
