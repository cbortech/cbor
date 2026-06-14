/**
 * Renders the CBOR bytes pane: RFC 8949 §3 style annotated dump or plain
 * hex, with per-byte coloring by major type and click-to-select mapping.
 */
import type { HexRow } from './build-rows';

export interface HexViewCallbacks {
  /** User clicked a row/span; byte range of the clicked node. */
  onSelectBytes: (byteStart: number) => void;
}

interface RenderedRow {
  el: HTMLElement;
  byteStart: number;
  byteEnd: number;
}

function hexPairs(bytes: Uint8Array, start: number, end: number): string {
  const parts: string[] = [];
  for (let i = start; i < end; i++)
    parts.push(bytes[i]!.toString(16).toUpperCase().padStart(2, '0'));
  return parts.join(' ');
}

export class HexView {
  private rendered: RenderedRow[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: HexViewCallbacks
  ) {}

  render(rows: HexRow[], bytes: Uint8Array, mode: 'annotated' | 'plain'): void {
    this.container.textContent = '';
    this.rendered = [];
    if (mode === 'annotated') this.renderAnnotated(rows, bytes);
    else this.renderPlain(rows, bytes);
  }

  renderEmpty(message: string): void {
    this.container.textContent = '';
    this.rendered = [];
    const p = document.createElement('p');
    p.className = 'hex-placeholder';
    p.textContent = message;
    this.container.appendChild(p);
  }

  private renderAnnotated(rows: HexRow[], bytes: Uint8Array): void {
    const table = document.createElement('div');
    table.className = 'hex-table';
    for (const row of rows) {
      const bytesCell = document.createElement('span');
      bytesCell.className = 'hex-bytes';
      bytesCell.style.paddingLeft = `${row.depth * 3}ch`;
      for (const span of row.spans) {
        const spanEl = document.createElement('span');
        spanEl.className = `hex-span mt${span.majorType} role-${span.role}`;
        const displayEnd = Math.min(span.byteEnd, span.byteStart + 16);
        spanEl.textContent = hexPairs(bytes, span.byteStart, displayEnd);
        bytesCell.appendChild(spanEl);
        if (displayEnd < span.byteEnd)
          bytesCell.appendChild(document.createTextNode('… '));
        else bytesCell.appendChild(document.createTextNode(' '));
      }

      const commentCell = document.createElement('span');
      commentCell.className = 'hex-comment';
      commentCell.textContent = `— ${row.comment}`;

      // Flat grid children — both cells get the click listener.
      const onClick = () => this.callbacks.onSelectBytes(row.byteStart);
      bytesCell.addEventListener('click', onClick);
      commentCell.addEventListener('click', onClick);

      table.appendChild(bytesCell);
      table.appendChild(commentCell);
      // Track the bytes cell; CSS handles the comment via adjacent sibling.
      this.rendered.push({
        el: bytesCell,
        byteStart: row.byteStart,
        byteEnd: row.byteEnd,
      });
    }
    this.container.appendChild(table);
  }

  private renderPlain(rows: HexRow[], bytes: Uint8Array): void {
    const pre = document.createElement('div');
    pre.className = 'hex-plain';
    const addrWidth = bytes.length > 0xffff ? 6 : 4;
    let needAddr = true;

    const addAddr = (offset: number) => {
      const el = document.createElement('span');
      el.className = 'hex-addr';
      el.textContent =
        offset.toString(16).toUpperCase().padStart(addrWidth, '0') + ':';
      pre.appendChild(el);
      needAddr = false;
    };

    for (const row of rows) {
      for (const span of row.spans) {
        let cursor = span.byteStart;
        while (cursor < span.byteEnd) {
          // Break to a new line at every 16-byte boundary.
          if (cursor > 0 && cursor % 16 === 0) {
            pre.appendChild(document.createElement('br'));
            needAddr = true;
          }
          if (needAddr) addAddr(cursor);
          // Emit bytes up to the next line boundary or end of span.
          const lineEnd = Math.min(span.byteEnd, cursor + (16 - (cursor % 16)));
          const spanEl = document.createElement('span');
          spanEl.className = `hex-span mt${span.majorType} role-${span.role}`;
          spanEl.textContent = hexPairs(bytes, cursor, lineEnd);
          spanEl.addEventListener('click', () =>
            this.callbacks.onSelectBytes(span.byteStart)
          );
          pre.appendChild(spanEl);
          pre.appendChild(document.createTextNode(' '));
          this.rendered.push({
            el: spanEl,
            byteStart: cursor,
            byteEnd: lineEnd,
          });
          cursor = lineEnd;
        }
      }
    }
    this.container.appendChild(pre);
  }

  /** Highlight everything overlapping [byteStart, byteEnd); pass null to clear. */
  highlightBytes(range: { byteStart: number; byteEnd: number } | null): void {
    let scrolled = false;
    for (const r of this.rendered) {
      const active =
        range !== null &&
        r.byteStart < range.byteEnd &&
        r.byteEnd > range.byteStart;
      r.el.classList.toggle('is-active', active);
      if (active && !scrolled) {
        r.el.scrollIntoView({ block: 'nearest' });
        scrolled = true;
      }
    }
  }
}
