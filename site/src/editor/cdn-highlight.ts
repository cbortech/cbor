/**
 * Syntax highlighting driven by the library's own lexer (tokenizeLenient),
 * so colors always agree with what the parser accepts.
 *
 * The whole document is re-tokenized on change; CDN documents in a playground
 * are small, and the scanner handles ~100 KB in about a millisecond.
 */
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tokenizeLenient, type TokenType } from '@cbortech/cbor/cdn';

const TOKEN_CLASS: Partial<Record<TokenType, string>> = {
  INTEGER: 'num',
  FLOAT: 'num',
  TSTR: 'str',
  RAWSTRING: 'str',
  EMPTY_INDEF_TEXT: 'str',
  SQSTR: 'bytes',
  BYTES_HEX: 'bytes',
  BYTES_HEX_ELIDED: 'bytes',
  BYTES_B64: 'bytes',
  EMPTY_INDEF_BYTES: 'bytes',
  APP_STRING: 'app',
  APP_SEQUENCE: 'app',
  TRUE: 'atom',
  FALSE: 'atom',
  NULL: 'atom',
  UNDEFINED: 'atom',
  SIMPLE: 'atom',
  ENCODING_INDICATOR: 'mod',
  UNDERSCORE: 'mod',
  ELLIPSIS: 'mod',
  PLUS: 'punct',
  COLON: 'punct',
  COMMA: 'punct',
  LBRACKET: 'punct',
  RBRACKET: 'punct',
  LBRACE: 'punct',
  RBRACE: 'punct',
  LPAREN: 'punct',
  RPAREN: 'punct',
  LT_LT: 'punct',
  GT_GT: 'punct',
  ERROR: 'invalid',
};

const decoCache = new Map<string, Decoration>();
function mark(cls: string): Decoration {
  let deco = decoCache.get(cls);
  if (!deco) {
    deco = Decoration.mark({ class: `cdn-${cls}` });
    decoCache.set(cls, deco);
  }
  return deco;
}

function buildDecorations(text: string): DecorationSet {
  const { tokens, comments } = tokenizeLenient(text);
  // Merge the two already-sorted streams; RangeSetBuilder requires sorted adds.
  const builder = new RangeSetBuilder<Decoration>();
  let ti = 0;
  let ci = 0;
  while (ti < tokens.length || ci < comments.length) {
    const tok = tokens[ti];
    const com = comments[ci];
    if (com && (!tok || com.start <= tok.offset)) {
      if (com.end > com.start) builder.add(com.start, com.end, mark('comment'));
      ci++;
    } else if (tok) {
      const cls = TOKEN_CLASS[tok.type];
      if (cls && tok.endOffset > tok.offset)
        builder.add(tok.offset, tok.endOffset, mark(cls));
      ti++;
    }
  }
  return builder.finish();
}

export const cdnHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state.doc.toString());
    }
    update(update: ViewUpdate) {
      if (update.docChanged)
        this.decorations = buildDecorations(update.state.doc.toString());
    }
  },
  { decorations: (v) => v.decorations }
);
