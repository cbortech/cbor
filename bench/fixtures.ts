/**
 * Deterministic fixture generators shared by the benchmark suites.
 * No randomness — every run benchmarks identical inputs.
 */

/** CDN array of `count` negative integers, e.g. `[-1, -7920, ...]`. */
export function negativeIntegersCDN(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(String(-(i * 7919 + 1)));
  return `[${parts.join(', ')}]`;
}

/** CDN map with `entries` entries cycling through arrays, strings, bytes, nested maps, and tags. */
export function mixedDocumentCDN(entries: number): string {
  const lines: string[] = [];
  for (let i = 0; i < entries; i++) {
    const key = `"key-${i}"`;
    switch (i % 5) {
      case 0:
        lines.push(`${key}: [1, -22, 333, -4444, 55555]`);
        break;
      case 1:
        lines.push(`${key}: "string value number ${i}"`);
        break;
      case 2:
        lines.push(
          `${key}: h'deadbeef${(i & 0xff).toString(16).padStart(2, '0')}'`
        );
        break;
      case 3:
        lines.push(`${key}: {1: true, 2: false, 3: null, 4: ${i}.5}`);
        break;
      case 4:
        lines.push(`${key}: 1(${1700000000 + i})`);
        break;
    }
  }
  return `{${lines.join(', ')}}`;
}

/** CDN array of `count` text strings, each containing one escape sequence. */
export function stringHeavyCDN(count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(`"item ${i} with some longer text content\\nsecond line"`);
  }
  return `[${parts.join(', ')}]`;
}

/**
 * CDN map whose keys are short ASCII strings (≤ 16 bytes) and whose values
 * are small integers.  Targets the tryDecodeAscii fast path directly: a
 * real-world payload of e.g. JSON-like objects with short property names.
 */
export function shortAsciiKeysCDN(entries: number): string {
  // Keys cycle through a handful of realistic short names so the map is
  // plausible, but each entry gets a unique index suffix to keep them distinct.
  const prefixes = ['id', 'type', 'name', 'val', 'ok', 'ts', 'src', 'dst'];
  const parts: string[] = [];
  for (let i = 0; i < entries; i++) {
    const key = `"${prefixes[i % prefixes.length]}${i}"`;
    parts.push(`${key}: ${i}`);
  }
  return `{${parts.join(', ')}}`;
}

/**
 * CDN map whose keys are long (> 64 byte) ASCII strings.  Exercises the
 * TextDecoder path so we can confirm tryDecodeAscii is correctly skipped
 * and long-ASCII performance is not regressed.
 */
export function longAsciiKeysCDN(entries: number): string {
  const parts: string[] = [];
  for (let i = 0; i < entries; i++) {
    // 68-character key — just above the 64-byte threshold
    const key = `"long-ascii-key-that-exceeds-sixty-four-bytes-threshold-${String(i).padStart(8, '0')}"`;
    parts.push(`${key}: ${i}`);
  }
  return `{${parts.join(', ')}}`;
}
