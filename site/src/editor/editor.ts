import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { lintGutter, lintKeymap } from '@codemirror/lint';
import { cdnHighlight } from './cdn-highlight';
import { cdnLinter } from './cdn-lint';
import { editorTheme } from './theme';

export interface EditorCallbacks {
  /** Fired on every document change (callers debounce as needed). */
  onDocChanged: (text: string) => void;
  /** Fired when the primary cursor moves. */
  onCursorMoved: (pos: number) => void;
}

export function createEditor(
  parent: HTMLElement,
  initialText: string,
  callbacks: EditorCallbacks
): EditorView {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initialText,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...lintKeymap,
          indentWithTab,
        ]),
        cdnHighlight,
        cdnLinter,
        lintGutter(),
        editorTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged)
            callbacks.onDocChanged(update.state.doc.toString());
          if (update.selectionSet)
            callbacks.onCursorMoved(update.state.selection.main.head);
        }),
      ],
    }),
  });
  return view;
}

/** Replace the whole document (e.g. sample load, Format, bytes paste). */
export function setEditorText(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}

/** Select a range and scroll it into view (hex row click). */
export function selectRange(view: EditorView, from: number, to: number): void {
  const len = view.state.doc.length;
  const f = Math.min(from, len);
  const t = Math.min(to, len);
  view.dispatch({
    selection: { anchor: f, head: t },
    scrollIntoView: true,
  });
  view.focus();
}
