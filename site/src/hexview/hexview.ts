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

/**
 * Drive every `.hex-bytes` cell's scroll position from one dedicated
 * scrollbar (`.hex-scroll-track`), instead of syncing the cells against
 * each other directly.
 *
 * An earlier version mirrored cells pairwise: on any cell's own `scroll`
 * event, copy its `scrollLeft` to every other cell. That's a feedback
 * loop waiting to happen — scrolling the widest row (say, a 128-byte span
 * whose max scrollLeft is 2803px) writes 2803 to a narrower row (say, 32
 * bytes, max 556px); the browser silently clamps that row's *own*
 * scrollLeft to 556 and fires its *own* `scroll` event for the change;
 * that event, arriving after the sync loop that triggered it had already
 * finished (so a same-tick re-entrancy guard doesn't catch it), then
 * mirrors the clamped 556 back onto every row, including the one actually
 * being dragged — so it could never reach its own end. One authoritative
 * source with only one-way propagation (track → cells) can't loop like
 * that, since nothing ever reads a cell's scrollLeft back.
 *
 * The track's own scroll range is set to the widest row's content width
 * (see renderAnnotated), so its scrollbar's thumb-to-range ratio reflects
 * the longest row; every other row's assignment is simply clamped to
 * whatever range *that* row actually has, same as scrolling it directly
 * would do — a row shorter than the current position just shows fully
 * scrolled, with nothing more to reveal.
 */
function driveHorizontalScrollFrom(
  track: HTMLElement,
  cells: readonly HTMLElement[]
): void {
  track.addEventListener('scroll', () => {
    for (const cell of cells) cell.scrollLeft = track.scrollLeft;
  });
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
    // Bytes cell immediately followed by its comment cell, one row per
    // item — same DOM order as what's visually selected, so drag-selecting
    // (and copying) a range of rows picks up exactly those rows and
    // nothing else. A version of this view that instead grouped "every
    // row's bytes, then every row's comments" into two separate columns
    // (so the bytes column could scroll as one shared unit without a
    // per-row scrollbar) seemed appealing, but a Range's two endpoints can
    // each land in either column; the browser's own selection would then,
    // in DOM tree order, straddle unrelated rows on both sides — no amount
    // of copy-event post-processing can recover which rows were actually
    // meant, because by the time 'copy' fires the Selection/Range itself
    // already spans more than intended. Keeping cells adjacent avoids the
    // problem entirely; each row keeps its own overflow-x (needed so a row
    // wider than the shared 50%-capped column can show any of its content
    // at all), but its scrollbar is hidden (.hex-bytes) and driven by one
    // shared, visible .hex-scroll-track instead — see
    // driveHorizontalScrollFrom for why that's one-way (track → rows), not
    // rows syncing each other.
    const table = document.createElement('div');
    table.className = 'hex-table';
    const bytesCells: HTMLElement[] = [];

    for (const row of rows) {
      const bytesCell = document.createElement('div');
      bytesCell.className = 'hex-bytes';
      bytesCell.style.paddingLeft = `${row.depth * 3}ch`;
      for (const span of row.spans) {
        const spanEl = document.createElement('span');
        spanEl.className = `hex-span mt${span.majorType} role-${span.role}`;
        // Full span, never truncated with an "…" placeholder: that used to
        // be real DOM text past 16 bytes, so selecting and copying the
        // rendered view (as opposed to the "Copy bytes" button, which goes
        // through toHexDump() and was never affected) produced a byte
        // sequence with a literal "…" spliced into it — CBOR.fromHexDumpSeq
        // then rejected it as an invalid hex token when pasted into the
        // Edit tab. A long span just makes its own row scroll (see
        // .hex-scroll-track below); it no longer affects any other row.
        spanEl.textContent = hexPairs(bytes, span.byteStart, span.byteEnd);
        bytesCell.appendChild(spanEl);
        bytesCell.appendChild(document.createTextNode(' '));
      }

      const commentCell = document.createElement('div');
      commentCell.className = 'hex-comment';
      commentCell.textContent = `— ${row.comment}`;

      // Flat grid children — both cells get the click listener; CSS
      // handles hover/active/invalid highlighting via adjacent-sibling and
      // :has() selectors, since the two cells are always DOM siblings.
      const onClick = () => this.callbacks.onSelectBytes(row.byteStart);
      bytesCell.addEventListener('click', onClick);
      commentCell.addEventListener('click', onClick);

      table.appendChild(bytesCell);
      table.appendChild(commentCell);
      bytesCells.push(bytesCell);
      // Track the bytes cell; CSS handles the comment via adjacent sibling.
      this.rendered.push({
        el: bytesCell,
        byteStart: row.byteStart,
        byteEnd: row.byteEnd,
      });
    }
    // The one visible, shared horizontal scrollbar for the whole bytes
    // column — a grid child of its own, placed in column 1 so it lines up
    // under every .hex-bytes cell (same shared, 50%-capped track — see
    // .hex-table), and sticky to the pane's bottom edge so it's reachable
    // without scrolling all the way down through however many rows there
    // are. Its own scroll range is the widest row's content, set below
    // once the cells are actually laid out (scrollWidth needs that).
    const scrollTrack = document.createElement('div');
    scrollTrack.className = 'hex-scroll-track';
    const scrollTrackInner = document.createElement('div');
    scrollTrackInner.className = 'hex-scroll-track-inner';
    scrollTrack.appendChild(scrollTrackInner);
    table.appendChild(scrollTrack);

    this.container.appendChild(table);

    const maxScrollWidth = bytesCells.reduce(
      (max, cell) => Math.max(max, cell.scrollWidth),
      0
    );
    scrollTrackInner.style.width = `${maxScrollWidth}px`;
    driveHorizontalScrollFrom(scrollTrack, bytesCells);
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
          // Same per-item description the Annotated tab shows inline (e.g.
          // "Array of length 3", a leaf's CDN spelling, "break") — Hex mode
          // has no room for a comment column, so surface it as a native
          // tooltip on hover instead.
          spanEl.title = row.comment;
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

  /**
   * Mark the byte range of a CDDL validation failure; pass null to clear.
   * Independent of the cursor-driven `highlightBytes` selection, so the
   * two never clobber each other. No auto-scroll: validation re-runs on
   * every edit and jumping the view around would be disruptive.
   */
  highlightValidation(
    range: { byteStart: number; byteEnd: number } | null
  ): void {
    for (const r of this.rendered) {
      const active =
        range !== null &&
        r.byteStart < range.byteEnd &&
        r.byteEnd > range.byteStart;
      r.el.classList.toggle('is-invalid', active);
    }
  }
}
