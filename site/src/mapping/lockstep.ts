/**
 * Bidirectional CDN-text ⇄ CBOR-byte position mapping.
 *
 * The CDN AST (parsed with character offsets) and the binary AST (decoded
 * with byte offsets) are structurally congruent, so walking them in lockstep
 * pairs each node's character range with its byte range.
 */
import {
  CborArray,
  CborBigNint,
  CborBigUint,
  CborIndefiniteByteString,
  CborIndefiniteTextString,
  CborItem,
  CborMap,
  CborTag,
} from '@cbortech/cbor/ast';

export interface NodeRange {
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
  depth: number;
}

/**
 * Direct children of a node, or null for leaves.
 *
 * Bignums are kept opaque: on the CDN side they are a single integer literal
 * with no sub-ranges, so descending into the tag content would desync.
 */
function children(node: CborItem): CborItem[] | null {
  if (node instanceof CborBigUint || node instanceof CborBigNint) return null;
  if (node instanceof CborArray) return node.items;
  if (node instanceof CborMap) return node.entries.flat();
  if (
    node instanceof CborIndefiniteByteString ||
    node instanceof CborIndefiniteTextString
  )
    return node.chunks;
  if (node instanceof CborTag) return [node.content];
  return null;
}

export function buildRangeMap(cdnAst: CborItem, binAst: CborItem): NodeRange[] {
  const ranges: NodeRange[] = [];
  const walk = (cdn: CborItem, bin: CborItem, depth: number): void => {
    const hasRange =
      cdn.start !== undefined &&
      cdn.end !== undefined &&
      bin.start !== undefined &&
      bin.end !== undefined;
    if (hasRange) {
      ranges.push({
        charStart: cdn.start!,
        charEnd: cdn.end!,
        byteStart: bin.start!,
        byteEnd: bin.end!,
        depth,
      });
    }
    const cdnKids = children(cdn);
    const binKids = children(bin);
    // Descend only while the trees agree; a synthesized or restructured
    // branch (e.g. unresolved app extensions) is mapped as a whole.
    if (!cdnKids || !binKids || cdnKids.length !== binKids.length) return;
    for (let i = 0; i < cdnKids.length; i++)
      walk(cdnKids[i]!, binKids[i]!, depth + 1);
  };
  walk(cdnAst, binAst, 0);
  return ranges;
}

/** Deepest range containing the given character position. */
export function rangeAtChar(
  ranges: NodeRange[],
  pos: number
): NodeRange | undefined {
  let best: NodeRange | undefined;
  for (const r of ranges) {
    if (pos < r.charStart || pos >= r.charEnd) continue;
    if (!best || r.depth > best.depth) best = r;
  }
  return best;
}

/** Deepest range containing the given byte position. */
export function rangeAtByte(
  ranges: NodeRange[],
  pos: number
): NodeRange | undefined {
  let best: NodeRange | undefined;
  for (const r of ranges) {
    if (pos < r.byteStart || pos >= r.byteEnd) continue;
    if (!best || r.depth > best.depth) best = r;
  }
  return best;
}
