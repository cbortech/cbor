/**
 * Editor chrome theme. Colors come from CSS variables so the dark/light
 * switch is pure CSS (see styles.css); token classes added by cdn-highlight
 * are also styled there.
 */
import { EditorView } from '@codemirror/view';

export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--bg-editor)',
    color: 'var(--fg)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    lineHeight: '1.55',
  },
  '.cm-content': {
    caretColor: 'var(--fg)',
    padding: '8px 0',
  },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-editor)',
    color: 'var(--fg-faint)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--line-highlight)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--line-highlight)',
    color: 'var(--fg-dim)',
  },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--error) 1px',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--warning) 1px',
    textUnderlineOffset: '3px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-panel)',
    color: 'var(--fg)',
    border: '1px solid var(--border)',
  },
});
