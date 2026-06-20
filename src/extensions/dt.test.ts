import { describe, test, expect } from 'vitest';
import { CBOR } from '../cbor';
import { CborUint } from '../ast/CborUint';
import { CborNint } from '../ast/CborNint';
import { CborFloat } from '../ast/CborFloat';
import { CborTag } from '../ast/CborTag';
import {
  CborEpochDtExtUint,
  CborEpochDtExtNint,
  CborEpochDtExtFloat,
  CborTaggedEpochDtExt,
  CborTaggedEpochDtAsDateExt,
  dt_as_Date,
  epochToRfc3339,
} from './dt';
import { decodeCBOR } from '../cbor/decoder';
import { fromJS } from '../js/fromJS';
import { Tag } from '../tag';

// ─── dt / DT extension (§3.1) ─────────────────────────────────────────────────
// Table 4 from draft-ietf-cbor-edn-literals-25 §3.1

describe('dt — dt app-string', () => {
  test("dt'1969-07-21T02:56:16Z' → CborEpochDtExtNint(-14159024n)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtNint);
    expect((n as CborNint).value).toBe(-14159024n);
  });

  test("dt'1969-07-21T02:56:16.0Z' → CborEpochDtExtFloat(-14159024.0)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16.0Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(-14159024.0);
  });

  test("dt'1969-07-21T02:56:16.5Z' → CborEpochDtExtFloat(-14159023.5)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16.5Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(-14159023.5);
  });

  test("dt'1970-01-01T00:00:00Z' → CborEpochDtExtUint(0n)", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtUint);
    expect((n as CborUint).value).toBe(0n);
  });

  test('dt double-quoted form dt"..." → SyntaxError', () => {
    expect(() => CBOR.fromCDN('dt"1970-01-01T00:00:00Z"')).toThrow(SyntaxError);
  });

  test('dt invalid datetime throws SyntaxError', () => {
    expect(() => CBOR.fromCDN("dt'not-a-date'")).toThrow(SyntaxError);
  });
});

// ─── dt<<…>> — app-sequence form ──────────────────────────────────────────────

describe('dt — dt<<…>> / DT<<…>> (app-sequence form)', () => {
  test("dt<<'1969-07-21T02:56:16.5Z'>> → float (single-quoted bytes form)", () => {
    const n = CBOR.fromCDN("dt<<'1969-07-21T02:56:16.5Z'>>");
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(-14159023.5);
  });

  test('dt<<"1969-07-21T02:56:16.5Z">> → float (double-quoted text form)', () => {
    const n = CBOR.fromCDN('dt<<"1969-07-21T02:56:16.5Z">>');
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(-14159023.5);
  });

  test("DT<<'1969-07-21T02:56:16Z'>> → CborTaggedEpochDtExt", () => {
    const n = CBOR.fromCDN("DT<<'1969-07-21T02:56:16Z'>>");
    expect(n).toBeInstanceOf(CborTaggedEpochDtExt);
    expect((n as CborTag).tag).toBe(1n);
    expect(((n as CborTag).content as CborNint).value).toBe(-14159024n);
  });
});

// ─── DT app-string ────────────────────────────────────────────────────────────

describe('dt — DT app-string', () => {
  test("DT'1969-07-21T02:56:16Z' → CborTaggedEpochDtExt, tag(1, -14159024)", () => {
    const n = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    expect(n).toBeInstanceOf(CborTaggedEpochDtExt);
    expect((n as CborTag).tag).toBe(1n);
    expect(((n as CborTag).content as CborNint).value).toBe(-14159024n);
  });
});

// ─── toCDN round-trips ────────────────────────────────────────────────────────

describe('dt — toCDN', () => {
  test("dt'…' round-trips through toCDN (integer)", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00Z'");
    expect(n.toCDN()).toBe("dt'1970-01-01T00:00:00Z'");
  });

  test("dt'…' round-trips through toCDN (negative integer)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16Z'");
    expect(n.toCDN()).toBe("dt'1969-07-21T02:56:16Z'");
  });

  test("DT'…' round-trips through toCDN", () => {
    const n = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    expect(n.toCDN()).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test("appStrings:false — dt'…' falls back to plain integer", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16Z'");
    expect(n.toCDN({ appStrings: false })).toBe('-14159024');
  });

  test("appStrings:false — dt'…' (float) falls back to plain float", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16.5Z'");
    expect(n.toCDN({ appStrings: false })).toBe('-14159023.5');
  });

  test("appStrings:false — DT'…' falls back to integer tag notation", () => {
    const n = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    expect(n.toCDN({ appStrings: false })).toBe('1(-14159024)');
  });
});

// ─── fromCBOR round-trip (DT_EXT built-in, no extensions option needed) ───────

describe('dt — fromCBOR round-trip', () => {
  test("DT'…' → toCBOR → fromCBOR → toCDN round-trips (negative integer)", () => {
    const original = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test("DT'…' → toCBOR → fromCBOR → toCDN round-trips (positive integer)", () => {
    const original = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'");
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test("DT'…' → toCBOR → fromCBOR → toCDN round-trips (fractional seconds)", () => {
    const original = CBOR.fromCDN("DT'1969-07-21T02:56:16.500Z'");
    const decoded = decodeCBOR(original.toCBOR());
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });

  test('tag(1, uint) without extensions → CborTaggedEpochDtExt', () => {
    const cbor = new CborTag(1n, new CborUint(1672574400n)).toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test('tag(1, nint) without extensions → CborTaggedEpochDtExt', () => {
    const cbor = new CborTag(1n, new CborNint(-14159024n)).toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test('tag(1, float) without extensions → CborTaggedEpochDtExt', () => {
    const cbor = new CborTag(1n, new CborFloat(-14159023.5)).toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });

  test('tag(5, …) is not intercepted by DT_EXT', () => {
    const cbor = new CborTag(5n, new CborUint(42n)).toCBOR();
    const decoded = decodeCBOR(cbor);
    expect(decoded).toBeInstanceOf(CborTag);
    expect(decoded).not.toBeInstanceOf(CborTaggedEpochDtExt);
  });
});

// ─── parseTag byte-offset propagation ────────────────────────────────────────

describe('dt — parseTag byte-offset propagation', () => {
  test('fromCBOR: result.content carries start/end byte offsets from original value', () => {
    // Bug: parseTag created a new content node without copying value.start/end,
    // so buildRows() could not split the hex view into separate tag + content rows.
    // Encoding: C1 (tag 1, 1 byte) + 1A 6A 2D EF 00 (uint 1781395200, 5 bytes).
    const cbor = new CborTag(1n, new CborUint(1781395200n)).toCBOR();
    const decoded = decodeCBOR(cbor) as CborTaggedEpochDtExt;
    expect(decoded).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(decoded.content.start).toBe(1); // tag header is 1 byte (C1)
    expect(decoded.content.end).toBe(6); // total: 1 + 5 = 6 bytes
  });
});

// ─── fromJS round-trip (DT_EXT built-in, no extensions option needed) ─────────

describe('dt — fromJS round-trip', () => {
  test("DT'…' → toJS → fromJS → toCDN round-trips (negative integer)", () => {
    const original = CBOR.fromCDN("DT'1969-07-21T02:56:16Z'");
    const js = original.toJS();
    const restored = fromJS(js);
    expect(restored).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(restored.toCDN()).toBe("DT'1969-07-21T02:56:16Z'");
  });

  test("DT'…' → toJS → fromJS → toCDN round-trips (positive integer)", () => {
    const original = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'");
    const js = original.toJS();
    const restored = fromJS(js);
    expect(restored).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(restored.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test("DT'…' → toJS → fromJS → toCDN round-trips (fractional seconds)", () => {
    const original = CBOR.fromCDN("DT'1969-07-21T02:56:16.500Z'");
    const js = original.toJS();
    const restored = fromJS(js);
    expect(restored).toBeInstanceOf(CborTaggedEpochDtExt);
    expect(restored.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });
});

// ─── epochToRfc3339 ───────────────────────────────────────────────────────────

describe('epochToRfc3339', () => {
  test('integer epoch → no fractional seconds', () => {
    expect(epochToRfc3339(0)).toBe('1970-01-01T00:00:00Z');
    expect(epochToRfc3339(1672574400)).toBe('2023-01-01T12:00:00Z');
    expect(epochToRfc3339(-14159024)).toBe('1969-07-21T02:56:16Z');
  });
  test('millisecond-precision epoch → 3 decimal places', () => {
    expect(epochToRfc3339(-14159023.5)).toBe('1969-07-21T02:56:16.500Z');
    expect(epochToRfc3339(1.5)).toBe('1970-01-01T00:00:01.500Z');
    expect(epochToRfc3339(0.001)).toBe('1970-01-01T00:00:00.001Z');
    expect(epochToRfc3339(0.123)).toBe('1970-01-01T00:00:00.123Z');
  });
  test('sub-millisecond epoch → minimal decimal places (≥3)', () => {
    expect(epochToRfc3339(0.0001)).toBe('1970-01-01T00:00:00.0001Z');
    expect(epochToRfc3339(0.0005)).toBe('1970-01-01T00:00:00.0005Z');
    expect(epochToRfc3339(0.123456)).toBe('1970-01-01T00:00:00.123456Z');
    expect(epochToRfc3339(-0.0001)).toBe('1969-12-31T23:59:59.9999Z');
  });
});

describe('parseDtAppString — sub-millisecond precision', () => {
  test("dt'…0.0001Z' → CborEpochDtExtFloat with value 0.0001", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00.0001Z'");
    expect(n).toBeInstanceOf(CborEpochDtExtFloat);
    expect((n as CborFloat).value).toBe(0.0001);
  });
  test("dt'…0.0001Z' round-trips through toCDN", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00.0001Z'");
    expect(n.toCDN()).toBe("dt'1970-01-01T00:00:00.0001Z'");
  });
  test("dt'…0.123456Z' round-trips through toCDN", () => {
    const n = CBOR.fromCDN("dt'1970-01-01T00:00:00.123456Z'");
    expect(n.toCDN()).toBe("dt'1970-01-01T00:00:00.123456Z'");
  });
  test("dt'…16.5Z' still round-trips with .500Z (ms-precision path)", () => {
    const n = CBOR.fromCDN("dt'1969-07-21T02:56:16.5Z'");
    expect(n.toCDN()).toBe("dt'1969-07-21T02:56:16.500Z'");
  });
});

// ─── dt_as_Date — fromCDN ───────────────────────────────────────────────────────

const DATE_OPTS = { extensions: [dt_as_Date] };

describe('dt_as_Date — fromCDN', () => {
  test("dt'...' (positive integer) → CborEpochDtExtUint, toJS=number (not Date)", () => {
    const v = CBOR.fromCDN("dt'1970-01-01T00:00:00Z'", DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtUint);
    expect(v.toCDN()).toBe("dt'1970-01-01T00:00:00Z'");
    expect(v.toJS()).not.toBeInstanceOf(Date);
  });

  test("dt'...' (negative integer) → CborEpochDtExtNint, toJS=number (not Date)", () => {
    const v = CBOR.fromCDN("dt'1969-07-21T02:56:16Z'", DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtNint);
    expect(v.toCDN()).toBe("dt'1969-07-21T02:56:16Z'");
    expect(v.toJS()).not.toBeInstanceOf(Date);
  });

  test("dt'...' (fractional) → CborEpochDtExtFloat, toJS=number (not Date)", () => {
    const v = CBOR.fromCDN("dt'1969-07-21T02:56:16.5Z'", DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtFloat);
    expect(v.toCDN()).toBe("dt'1969-07-21T02:56:16.500Z'");
    expect(v.toJS()).not.toBeInstanceOf(Date);
  });

  test("DT'...' → CborTaggedEpochDtAsDateExt, toCDN()=DT'...'", () => {
    const v = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'", DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect(v.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test("DT'...' toJS() → plain Date", () => {
    const v = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'", DATE_OPTS);
    const d = v.toJS() as Date;
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe('2023-01-01T12:00:00.000Z');
  });

  test("DT'...' toCBOR() produces tag(1, integer)", () => {
    const v = CBOR.fromCDN("DT'2023-01-01T12:00:00Z'", DATE_OPTS);
    const decoded = decodeCBOR(v.toCBOR());
    expect(decoded).toBeInstanceOf(CborTag);
    expect((decoded as CborTag).tag).toBe(1n);
    expect((decoded as CborTag).content).toBeInstanceOf(CborUint);
  });

  test('1(epoch) in EDN → CborTaggedEpochDtAsDateExt via parseTag hook', () => {
    const v = CBOR.fromCDN('1(1672574400)', DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).toISOString()).toBe('2023-01-01T12:00:00.000Z');
  });

  test('1(negative epoch) in EDN → CborTaggedEpochDtAsDateExt', () => {
    const v = CBOR.fromCDN('1(-14159024)', DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).toISOString()).toBe('1969-07-21T02:56:16.000Z');
  });

  test('1(float epoch) in EDN → CborTaggedEpochDtAsDateExt', () => {
    const v = CBOR.fromCDN('1(-14159023.5)', DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).getTime()).toBeCloseTo(-14159023500, -1);
  });

  test("dt<<'...'>> (bytes form) → CborEpochDtExtUint", () => {
    const v = CBOR.fromCDN("dt<<'2023-01-01T12:00:00Z'>>", DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtUint);
  });

  test('dt<<"...">> (text form) → CborEpochDtExtUint', () => {
    const v = CBOR.fromCDN('dt<<"2023-01-01T12:00:00Z">>', DATE_OPTS);
    expect(v).toBeInstanceOf(CborEpochDtExtUint);
  });
});

// ─── dt_as_Date — fromCBOR ──────────────────────────────────────────────────────

describe('dt_as_Date — fromCBOR', () => {
  test('tag(1, uint) → CborTaggedEpochDtAsDateExt', () => {
    const cbor = new CborTag(1n, new CborUint(1672574400n)).toCBOR();
    const v = decodeCBOR(cbor, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).toISOString()).toBe('2023-01-01T12:00:00.000Z');
  });

  test('tag(1, nint) → CborTaggedEpochDtAsDateExt', () => {
    const cbor = new CborTag(1n, new CborNint(-14159024n)).toCBOR();
    const v = decodeCBOR(cbor, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).toISOString()).toBe('1969-07-21T02:56:16.000Z');
  });

  test('tag(1, float) → CborTaggedEpochDtAsDateExt', () => {
    const cbor = new CborTag(1n, new CborFloat(-14159023.5)).toCBOR();
    const v = decodeCBOR(cbor, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect((v.toJS() as Date).getTime()).toBeCloseTo(-14159023500, -1);
  });

  test('tag(5, …) is not intercepted by dt_as_Date', () => {
    const cbor = new CborTag(5n, new CborUint(42n)).toCBOR();
    const v = decodeCBOR(cbor, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTag);
    expect(v).not.toBeInstanceOf(CborTaggedEpochDtAsDateExt);
  });
});

// ─── dt_as_Date — fromJS ────────────────────────────────────────────────────────

describe('dt_as_Date — fromJS', () => {
  test('Date → CborTaggedEpochDtAsDateExt', () => {
    const d = new Date('2023-01-01T12:00:00.000Z');
    const v = fromJS(d, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect(v.toCDN()).toBe("DT'2023-01-01T12:00:00Z'");
  });

  test('Date with fractional seconds', () => {
    const d = new Date('1969-07-21T02:56:16.500Z');
    const v = fromJS(d, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
    expect(v.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });

  test('{ [Tag.symbol]: 1n } → CborTaggedEpochDtAsDateExt', () => {
    const tagged = Object.assign(Object(1672574400), { [Tag.symbol]: 1n });
    const v = fromJS(tagged, DATE_OPTS);
    expect(v).toBeInstanceOf(CborTaggedEpochDtAsDateExt);
  });

  test('non-Date objects are not intercepted', () => {
    const v = fromJS({ x: 1 }, DATE_OPTS);
    expect(v).not.toBeInstanceOf(CborTaggedEpochDtAsDateExt);
  });
});

// ─── dt_as_Date — round-trip ────────────────────────────────────────────────────

describe('dt_as_Date — round-trip', () => {
  test('EDN → CBOR → fromCBOR → toJS → fromJS → toCBOR', () => {
    const original = CBOR.fromCDN("DT'2023-06-15T09:30:00Z'", DATE_OPTS);
    const cbor = original.toCBOR();
    const decoded = decodeCBOR(cbor, DATE_OPTS);
    const date = decoded.toJS() as Date;
    const restored = fromJS(date, DATE_OPTS);
    expect(restored.toCBOR()).toEqual(cbor);
  });

  test('DT with fractional seconds round-trips through toJS/fromJS', () => {
    const v = CBOR.fromCDN("DT'1969-07-21T02:56:16.500Z'", DATE_OPTS);
    const date = v.toJS() as Date;
    const restored = fromJS(date, DATE_OPTS) as CborTaggedEpochDtAsDateExt;
    expect(restored.toCDN()).toBe("DT'1969-07-21T02:56:16.500Z'");
  });
});
