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
      const rowEl = document.createElement('div');
      rowEl.className = 'hex-row';

      const bytesCell = document.createElement('span');
      bytesCell.className = 'hex-bytes';
      bytesCell.style.paddingLeft = `${row.depth * 3}ch`;
      for (const span of row.spans) {
        const spanEl = document.createElement('span');
        spanEl.className = `hex-span mt${span.majorType} role-${span.role}`;
        spanEl.textContent = hexPairs(bytes, span.byteStart, span.byteEnd);
        bytesCell.appendChild(spanEl);
        bytesCell.appendChild(document.createTextNode(' '));
      }

      const commentCell = document.createElement('span');
      commentCell.className = 'hex-comment';
      commentCell.textContent = `— ${row.comment}`;

      rowEl.appendChild(bytesCell);
      rowEl.appendChild(commentCell);
      rowEl.addEventListener('click', () =>
        this.callbacks.onSelectBytes(row.byteStart)
      );
      table.appendChild(rowEl);
      this.rendered.push({
        el: rowEl,
        byteStart: row.byteStart,
        byteEnd: row.byteEnd,
      });
    }
    this.container.appendChild(table);
  }

  private renderPlain(rows: HexRow[], bytes: Uint8Array): void {
    const pre = document.createElement('div');
    pre.className = 'hex-plain';
    // Rows are in byte order and their spans cover every byte exactly once,
    // so concatenating spans reproduces the full encoding.
    for (const row of rows) {
      for (const span of row.spans) {
        const spanEl = document.createElement('span');
        spanEl.className = `hex-span mt${span.majorType} role-${span.role}`;
        spanEl.textContent = hexPairs(bytes, span.byteStart, span.byteEnd);
        spanEl.addEventListener('click', () =>
          this.callbacks.onSelectBytes(span.byteStart)
        );
        pre.appendChild(spanEl);
        pre.appendChild(document.createTextNode(' '));
        this.rendered.push({
          el: spanEl,
          byteStart: span.byteStart,
          byteEnd: span.byteEnd,
        });
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
