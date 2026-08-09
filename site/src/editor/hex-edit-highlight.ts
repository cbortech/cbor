/**
 * Same per-byte major-type coloring and per-item hover hint as the
 * read-only Hex tab (see hexview.ts / build-rows.ts), but for the editable
 * hex-dump CodeMirror instance in the Edit tab.
 *
 * The read-only view colors byte ranges it renders itself, so byte offset
 * → screen position is trivial. Here the *document text* is user-editable —
 * plain hex (see bytesToHexString) when this app wrote it, but the Edit tab
 * also accepts a pasted *annotated* dump (e.g. copied from the Annotated
 * tab's own toHexDump()-style output), comments and all — so byte offset
 * has to be mapped to a *character* range in whichever of those the text
 * currently is. mapHexChars() does that by tokenizing the same way
 * CBOR.fromHexDumpSeq() does internally (skipping --/—/#///…/ and /* *\/
 * comments before splitting on whitespace) — mirrored here rather than
 * imported since that tokenizer isn't part of the library's public API.
 *
 * The `HexRow[]` + bytes to color against come from outside (the CDN →
 * CBOR conversion driving every other pane) and are pushed in via
 * setHexEditModel whenever a new conversion succeeds — this module only
 * consumes them.
 */
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import type { HexRow } from '../hexview/build-rows';

export interface HexEditModel {
  rows: HexRow[];
  bytes: Uint8Array;
}

export const setHexEditModel = StateEffect.define<HexEditModel | null>();

export const hexEditModelField = StateField.define<HexEditModel | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHexEditModel)) value = e.value;
    return value;
  },
});

interface HexCharRun {
  byteIndex: number;
  charStart: number;
  charEnd: number;
}

/** Index of the next newline at/after `start`, or `text.length` if none —
 * matches cbor.ts's own skipLineComment exactly (mirrored, not imported;
 * see this file's top comment). */
function skipLineComment(text: string, start: number): number {
  const end = text.indexOf('\n', start);
  return end < 0 ? text.length : end;
}

/**
 * Map each real hex-byte pair in `text` to a byte index and character
 * range, in document order. Tokenizes the same way CBOR.fromHexDumpSeq()
 * does — skip --/—/#/// line comments and /* *\/ / / block comments, split
 * the rest on whitespace, each remaining token is a run of hex-digit pairs
 * — so a pasted annotated dump maps correctly instead of also matching
 * hex-digit-looking characters inside comment text (e.g. a `"cafe"` string
 * value). A token that doesn't validate as one is dropped rather than
 * thrown on (unlike the real parser): this is used for best-effort
 * highlighting of possibly-mid-edit text, not validation — a mismatch
 * against `model.bytes.length` is exactly how callers already detect and
 * skip highlighting for text that hasn't reparsed yet.
 */
function mapHexChars(text: string): HexCharRun[] {
  const runs: HexCharRun[] = [];
  let tokenStart = -1;

  const flushToken = (end: number): void => {
    if (tokenStart < 0) return;
    const token = text.slice(tokenStart, end);
    if (/^[0-9a-fA-F]+$/.test(token) && token.length % 2 === 0) {
      for (let k = 0; k < token.length; k += 2)
        runs.push({
          byteIndex: runs.length,
          charStart: tokenStart + k,
          charEnd: tokenStart + k + 2,
        });
    }
    tokenStart = -1;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1] ?? '';

    // Same character-by-character branches, in the same order, as
    // stripHexDumpComments in cbor.ts — order matters: a lone '/' (the
    // last branch) must lose to '//' and '/*' being checked first.
    if (/\s/.test(ch)) {
      flushToken(i);
      i++;
    } else if (ch === '-' && next === '-') {
      flushToken(i);
      i = skipLineComment(text, i + 2);
    } else if (ch === '—') {
      flushToken(i);
      i = skipLineComment(text, i + 1);
    } else if (ch === '#') {
      flushToken(i);
      i = skipLineComment(text, i + 1);
    } else if (ch === '/' && next === '/') {
      flushToken(i);
      i = skipLineComment(text, i + 2);
    } else if (ch === '/' && next === '*') {
      flushToken(i);
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (ch === '/') {
      flushToken(i);
      const end = text.indexOf('/', i + 1);
      i = end < 0 ? text.length : end + 1;
    } else {
      if (tokenStart < 0) tokenStart = i;
      i++;
    }
  }
  flushToken(text.length);

  return runs;
}

/** The row (for its comment) and, within it, the span (for major type /
 * role) that byte `byteIndex` belongs to. */
function findByte(
  rows: HexRow[],
  byteIndex: number
): { row: HexRow; span: HexRow['spans'][number] } | null {
  for (const row of rows) {
    if (byteIndex < row.byteStart || byteIndex >= row.byteEnd) continue;
    for (const span of row.spans) {
      if (byteIndex >= span.byteStart && byteIndex < span.byteEnd)
        return { row, span };
    }
  }
  return null;
}

const decoCache = new Map<string, Decoration>();
function mark(cls: string): Decoration {
  let deco = decoCache.get(cls);
  if (!deco) {
    deco = Decoration.mark({ class: cls });
    decoCache.set(cls, deco);
  }
  return deco;
}

function buildDecorations(
  text: string,
  model: HexEditModel | null
): DecorationSet {
  if (!model) return Decoration.none;
  const runs = mapHexChars(text);
  if (runs.length !== model.bytes.length) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const row of model.rows) {
    for (const span of row.spans) {
      const startRun = runs[span.byteStart];
      const endRun = runs[span.byteEnd - 1];
      if (!startRun || !endRun) continue;
      // Same class names hexview.ts uses for the read-only tab, so the
      // .hex-span/.mtN/.role-* rules in styles.css color both identically.
      builder.add(
        startRun.charStart,
        endRun.charEnd,
        mark(`hex-span mt${span.majorType} role-${span.role}`)
      );
    }
  }
  return builder.finish();
}

export const hexEditHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(
        view.state.doc.toString(),
        view.state.field(hexEditModelField)
      );
    }
    update(update: ViewUpdate) {
      const modelChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setHexEditModel))
      );
      if (update.docChanged || modelChanged)
        this.decorations = buildDecorations(
          update.state.doc.toString(),
          update.state.field(hexEditModelField)
        );
    }
  },
  { decorations: (v) => v.decorations }
);

export const hexEditHoverTooltip = hoverTooltip((view, pos): Tooltip | null => {
  const model = view.state.field(hexEditModelField);
  if (!model) return null;
  const runs = mapHexChars(view.state.doc.toString());
  if (runs.length !== model.bytes.length) return null;
  const run = runs.find((r) => pos >= r.charStart && pos < r.charEnd);
  if (!run) return null;
  const found = findByte(model.rows, run.byteIndex);
  if (!found) return null;
  return {
    pos: run.charStart,
    end: run.charEnd,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-hex-tooltip';
      dom.textContent = found.row.comment;
      return { dom };
    },
  };
});
