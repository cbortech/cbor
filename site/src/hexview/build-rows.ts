/**
 * Builds the annotated hex dump row model from a binary AST (decoded with
 * `CBOR.fromCBOR`, so every node carries byte offsets) and the raw bytes.
 *
 * Mirrors the traversal of `CborItem.toHexDump()` but keeps byte ranges and
 * major-type information per row so the view can colorize and map clicks.
 */
import {
  CborArray,
  CborIndefiniteByteString,
  CborIndefiniteTextString,
  CborItem,
  CborMap,
  CborTag,
} from '@cbortech/cbor/ast';

export interface HexSpan {
  byteStart: number;
  byteEnd: number;
  /** head = initial byte + argument, payload = string content, break = 0xFF */
  role: 'head' | 'payload' | 'break';
  majorType: number;
}

export interface HexRow {
  depth: number;
  spans: HexSpan[];
  comment: string;
  byteStart: number;
  byteEnd: number;
}

/** Length of the head (initial byte + argument) at the given offset. */
function headLength(initialByte: number): number {
  const ai = initialByte & 0x1f;
  if (ai < 24 || ai === 31) return 1;
  if (ai === 24) return 2;
  if (ai === 25) return 3;
  if (ai === 26) return 5;
  return 9; // ai === 27
}

const MAX_COMMENT = 72;

function leafComment(node: CborItem): string {
  let cdn: string;
  try {
    cdn = node.toCDN();
  } catch {
    cdn = '(unrepresentable)';
  }
  return cdn.length > MAX_COMMENT ? cdn.slice(0, MAX_COMMENT - 1) + '…' : cdn;
}

export function buildRows(binAst: CborItem, bytes: Uint8Array): HexRow[] {
  const rows: HexRow[] = [];

  const push = (depth: number, spans: HexSpan[], comment: string): void => {
    rows.push({
      depth,
      spans,
      comment,
      byteStart: spans[0]!.byteStart,
      byteEnd: spans[spans.length - 1]!.byteEnd,
    });
  };

  const walk = (node: CborItem, depth: number): void => {
    const start = node.start;
    const end = node.end;
    if (start === undefined || end === undefined) return;
    const ib = bytes[start]!;
    const mt = ib >> 5;
    const head = headLength(ib);

    const headSpan: HexSpan = {
      byteStart: start,
      byteEnd: start + head,
      role: 'head',
      majorType: mt,
    };
    const breakSpan = (): HexSpan => ({
      byteStart: end - 1,
      byteEnd: end,
      role: 'break',
      majorType: mt,
    });

    if (node instanceof CborArray) {
      push(
        depth,
        [headSpan],
        node.indefiniteLength
          ? 'Start indefinite-length array'
          : `Array of length ${node.items.length}`
      );
      for (const item of node.items) walk(item, depth + 1);
      if (node.indefiniteLength) push(depth, [breakSpan()], '"break"');
      return;
    }
    if (node instanceof CborMap) {
      push(
        depth,
        [headSpan],
        node.indefiniteLength
          ? 'Start indefinite-length map'
          : `Map of length ${node.entries.length}`
      );
      for (const [k, v] of node.entries) {
        walk(k, depth + 1);
        walk(v, depth + 1);
      }
      if (node.indefiniteLength) push(depth, [breakSpan()], '"break"');
      return;
    }
    if (
      node instanceof CborIndefiniteByteString ||
      node instanceof CborIndefiniteTextString
    ) {
      push(
        depth,
        [headSpan],
        node instanceof CborIndefiniteByteString
          ? 'Start indefinite-length byte string'
          : 'Start indefinite-length text string'
      );
      for (const chunk of node.chunks) walk(chunk, depth + 1);
      push(depth, [breakSpan()], '"break"');
      return;
    }
    if (node instanceof CborTag) {
      // Bignums and other tag subclasses whose content was synthesized
      // (no byte offsets) render as a single row instead.
      const content = node.content;
      if (content.start !== undefined && content.end !== undefined) {
        push(depth, [headSpan], `Tag ${node.tag}`);
        walk(content, depth + 1);
        return;
      }
    }

    // Leaf: head plus, for definite-length strings, the content payload.
    const spans: HexSpan[] = [headSpan];
    if (end > start + head) {
      spans.push({
        byteStart: start + head,
        byteEnd: end,
        role: 'payload',
        majorType: mt,
      });
    }
    push(depth, spans, leafComment(node));
  };

  walk(binAst, 0);
  return rows;
}
