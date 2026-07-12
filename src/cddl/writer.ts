/**
 * CDDL formatter: serialize rule ASTs back to CDDL text.
 *
 * v1 formatting is deliberately simple: one rule per line with single-space
 * separators, no line wrapping, and no comment re-emission. Literal values
 * are emitted verbatim from their source text (`raw`), so number bases,
 * string escapes, and byte-string qualifiers survive a round trip.
 */

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

/** Format rules (in the given order) as CDDL text with a trailing newline. */
export function formatCddl(rules: readonly CddlRule[]): string {
  return rules.map(formatRule).join('\n') + (rules.length > 0 ? '\n' : '');
}

function formatRule(rule: CddlRule): string {
  const generics = rule.generics ? `<${rule.generics.join(', ')}>` : '';
  return `${rule.name}${generics} ${rule.assign} ${formatEntry(rule.body)}`;
}

function formatEntry(entry: CddlGroupEntry): string {
  const occur = entry.occur ? `${formatOccur(entry.occur)} ` : '';
  if (entry.kind === 'entry-group')
    return `${occur}(${formatGroup(entry.group)})`;
  const key = entry.memberKey ? `${formatMemberKey(entry.memberKey)} ` : '';
  return `${occur}${key}${formatType(entry.value)}`;
}

function formatOccur(occur: CddlOccur): string {
  if (occur.marker !== '*') return occur.marker;
  return `${occur.min ?? ''}*${occur.max ?? ''}`;
}

function formatMemberKey(key: CddlMemberKey): string {
  switch (key.kind) {
    case 'bareword':
      return `${key.key}:`;
    case 'value':
      return `${key.key.raw}:`;
    case 'type1':
      return `${formatType1(key.key)} ${key.cut ? '^ ' : ''}=>`;
  }
}

function formatGroup(group: CddlGroup): string {
  // The trailing comma is syntactically significant (it marks the expression
  // as a group, not a parenthesized type) and must survive formatting.
  return (
    group.choices
      .map((entries) => entries.map(formatEntry).join(', '))
      .join(' // ') + (group.trailingComma ? ',' : '')
  );
}

function formatType(type: CddlType): string {
  return type.alternatives.map(formatType1).join(' / ');
}

function formatType1(type1: CddlType1): string {
  const target = formatType2(type1.target);
  if (!type1.op || !type1.controller) return target;
  const controller = formatType2(type1.controller);
  if (type1.op.kind === 'range')
    return `${target}${type1.op.inclusive ? '..' : '...'}${controller}`;
  return `${target} .${type1.op.name} ${controller}`;
}

function formatRef(ref: CddlRef): string {
  const args = ref.genericArgs
    ? `<${ref.genericArgs.map(formatType1).join(', ')}>`
    : '';
  return `${ref.name}${args}`;
}

function formatType2(type2: CddlType2): string {
  switch (type2.kind) {
    case 'value':
      return type2.raw;
    case 'ref':
      return formatRef(type2);
    case 'paren':
      return `(${formatType(type2.type)})`;
    case 'map':
      return `{${formatGroup(type2.group)}}`;
    case 'array':
      return `[${formatGroup(type2.group)}]`;
    case 'unwrap':
      return `~${formatRef(type2.ref)}`;
    case 'enum':
      return type2.group.kind === 'ref'
        ? `&${formatRef(type2.group)}`
        : `&(${formatGroup(type2.group)})`;
    case 'tagged': {
      // `raw` (set for literal/absent heads) preserves the number base.
      const head =
        type2.raw ??
        (typeof type2.tag === 'object'
          ? `#6.<${formatType(type2.tag)}>`
          : `#6${type2.tag === undefined ? '' : `.${type2.tag}`}`);
      return `${head}(${formatType(type2.item)})`;
    }
    case 'major': {
      if (type2.raw !== undefined) return type2.raw;
      return typeof type2.ai === 'object'
        ? `#${type2.major}.<${formatType(type2.ai)}>`
        : `#${type2.major}${type2.ai === undefined ? '' : `.${type2.ai}`}`;
    }
    case 'any':
      return '#';
  }
}
