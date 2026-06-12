import { describe, it, expect, vi } from 'vitest';
import { bytesToHex, hexToBytes } from './hex';

describe('bytesToHex', () => {
  it('encodes bytes as lowercase hex', () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xab, 0xff]))).toBe(
      '000fabff'
    );
  });

  it('encodes an empty array as an empty string', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });
});

describe('hexToBytes', () => {
  it('decodes lowercase hex', () => {
    expect(hexToBytes('000fabff')).toEqual(
      new Uint8Array([0x00, 0x0f, 0xab, 0xff])
    );
  });

  it('decodes uppercase and mixed-case hex', () => {
    expect(hexToBytes('ABCDef01')).toEqual(
      new Uint8Array([0xab, 0xcd, 0xef, 0x01])
    );
  });

  it('decodes an empty string to an empty array', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('throws on odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow(SyntaxError);
    expect(() => hexToBytes('abc')).toThrow(/odd length: 3/);
  });

  it('throws on non-hex characters (small / LUT path)', () => {
    expect(() => hexToBytes('zz')).toThrow(SyntaxError);
    expect(() => hexToBytes('0g')).toThrow(/invalid character "g"/);
    expect(() => hexToBytes('00あ0')).toThrow(SyntaxError);
  });

  it('throws on non-hex characters regardless of input size', () => {
    // 300 digits — above NATIVE_FROM_HEX_MIN_DIGITS, so this exercises the
    // native path when Uint8Array.fromHex exists, the LUT path otherwise.
    const big = '00'.repeat(149) + 'g0';
    expect(() => hexToBytes(big)).toThrow(SyntaxError);
  });

  it('round-trips a large input', () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });
});

describe('hexToBytes native fromHex threshold', () => {
  // The native-availability check runs at module load, so swap in a spy
  // before re-importing a fresh copy of the module.
  async function withFakeNative(
    fn: (
      hexToBytes: (hex: string) => Uint8Array,
      calls: string[]
    ) => void | Promise<void>
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const U8 = Uint8Array as any;
    const original = U8.fromHex;
    const calls: string[] = [];
    U8.fromHex = (hex: string): Uint8Array => {
      calls.push(hex);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        const v = parseInt(hex.slice(i, i + 2), 16);
        if (Number.isNaN(v)) throw new SyntaxError('invalid hex');
        out[i / 2] = v;
      }
      return out;
    };
    try {
      vi.resetModules();
      const fresh = await import('./hex');
      await fn(fresh.hexToBytes, calls);
    } finally {
      if (original === undefined) delete U8.fromHex;
      else U8.fromHex = original;
      vi.resetModules();
    }
  }

  it('routes inputs of >= 256 digits to native fromHex', async () => {
    await withFakeNative((hexToBytes, calls) => {
      const hex = 'ab'.repeat(128); // 256 digits
      expect(hexToBytes(hex)).toEqual(new Uint8Array(128).fill(0xab));
      expect(calls).toEqual([hex]);
    });
  });

  it('keeps inputs below the threshold on the LUT path', async () => {
    await withFakeNative((hexToBytes, calls) => {
      expect(hexToBytes('ab'.repeat(127))).toEqual(
        new Uint8Array(127).fill(0xab)
      );
      expect(calls).toEqual([]);
    });
  });
});
