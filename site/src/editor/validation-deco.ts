/**
 * Highlighting for CDDL validation results: a single marked range per
 * editor, driven externally by the validation orchestration (unlike lint
 * squiggles, which the editors compute from their own text).
 *
 * The same field serves both sides: instance-side offsets in the CDN
 * editor and schema-side offsets in the CDDL editor.
 */
import { RangeSet, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

const setValidation = StateEffect.define<{ from: number; to: number } | null>();

const validationMark = Decoration.mark({ class: 'validation-error' });

export const validationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    // Any edit invalidates the range; revalidation re-sets it right after.
    if (tr.docChanged) deco = Decoration.none;
    for (const e of tr.effects) {
      if (!e.is(setValidation)) continue;
      deco =
        e.value === null || e.value.to <= e.value.from
          ? Decoration.none
          : RangeSet.of([validationMark.range(e.value.from, e.value.to)]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Set (or clear, with null) the validation-error range of an editor. */
export function setValidationRange(
  view: EditorView,
  range: { from: number; to: number } | null
): void {
  let value: { from: number; to: number } | null = null;
  if (range !== null) {
    const len = view.state.doc.length;
    const from = Math.max(0, Math.min(range.from, len));
    const to = Math.max(from, Math.min(range.to, len));
    value = { from, to };
  }
  view.dispatch({ effects: setValidation.of(value) });
}
