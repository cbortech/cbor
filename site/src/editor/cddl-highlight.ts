/**
 * CDDL syntax highlighting driven by the library's own lexer
 * (tokenizeLenient from @cbortech/cbor/cddl), mirroring cdn-highlight.ts.
 *
 * The color classes are the shared `cdn-*` palette tokens — they name
 * colors, not CDN constructs, so both highlighters reuse the same CSS.
 */
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tokenizeLenient, type CddlTokenType } from '@cbortech/cbor/cddl';

const TOKEN_CLASS: Partial<Record<CddlTokenType, string>> = {
  INT: 'num',
  FLOAT: 'num',
  TSTR: 'str',
  BYTES: 'bytes',
  HASH: 'atom',
  CTLOP: 'app',
  RANGE_INCL: 'mod',
  RANGE_EXCL: 'mod',
  STAR: 'mod',
  PLUS: 'mod',
  QUEST: 'mod',
  TILDE: 'mod',
  AMP: 'mod',
  CARET: 'mod',
  ASSIGN: 'punct',
  SLASH_EQ: 'punct',
  DSLASH_EQ: 'punct',
  SLASH: 'punct',
  DSLASH: 'punct',
  ARROW: 'punct',
  COLON: 'punct',
  COMMA: 'punct',
  LPAREN: 'punct',
  RPAREN: 'punct',
  LBRACE: 'punct',
  RBRACE: 'punct',
  LBRACKET: 'punct',
  RBRACKET: 'punct',
  LT: 'punct',
  GT: 'punct',
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

export const cddlHighlight = ViewPlugin.fromClass(
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
