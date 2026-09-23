import { describe, expect, test } from 'vitest';
import { CBOR } from '../cbor';
import { Tag } from '../tag';
import { CddlMismatchError } from './errors';
import { bytesToHex, hexToBytes } from '../utils/hex';

const EVENT_CDDL = `
event = {
  t: time
  ? either: time / number
  ? d: tdate
  ? anything: any
  ? times: [* time]
}
`;

const MOON = `DT'1969-07-21T02:56:16Z'`;

/** CBOR bytes → toJS() → fromJS() → CBOR bytes, all with `cddl`. */
function jsRoundTrip(hex: string, cddl: string): string {
  const js = CBOR.fromCBOR(hexToBytes(hex), { cddl }).toJS();
  return bytesToHex(CBOR.fromJS(js, { cddl }).toCBOR());
}

describe('toJS(): schema-implied tags are left off', () => {
  test('a time value converts to a plain number', () => {
    const v = CBOR.parse(`{"t": ${MOON}}`, { cddl: EVENT_CDDL }) as {
      t: unknown;
    };
    expect(v).toEqual({ t: -14159024 });
    expect(typeof v.t).toBe('number');
  });

  test('the same data keeps its tag without a schema', () => {
    const v = CBOR.parse(`{"t": ${MOON}}`) as { t: unknown };
    expect(typeof v.t).toBe('object');
    expect(Tag.get(v.t)).toBe(1n);
  });

  test('implicitTags: false keeps every tag', () => {
    const v = CBOR.parse(`{"t": ${MOON}}`, {
      cddl: EVENT_CDDL,
      implicitTags: false,
    }) as { t: unknown };
    expect(Tag.get(v.t)).toBe(1n);
    expect(Tag.getValue(v.t)).toBe(-14159024);
  });

  test('also applies to fromCBOR() input', () => {
    // {"t": 1(-14159024)}
    const item = CBOR.fromCBOR(hexToBytes('a16174c13a00d80caf'), {
      cddl: EVENT_CDDL,
    });
    expect(item.toJS()).toEqual({ t: -14159024 });
  });

  test('tdate and array elements', () => {
    const v = CBOR.parse(
      `{"t": 1(0), "d": 0("2020-01-01T00:00:00Z"), "times": [1(1), 1(2.5)]}`,
      { cddl: EVENT_CDDL }
    );
    expect(v).toEqual({
      t: 0,
      d: '2020-01-01T00:00:00Z',
      times: [1, 2.5],
    });
  });

  test('keeps a tag whose untagged content another alternative accepts', () => {
    // `time / number`: a plain 5 would convert back untagged.
    const v = CBOR.parse(`{"t": 1(0), "either": 1(5)}`, {
      cddl: EVENT_CDDL,
    }) as { either: unknown };
    expect(Tag.get(v.either)).toBe(1n);
  });

  test('keeps a tag the schema does not require', () => {
    const v = CBOR.parse(`{"t": 1(0), "anything": 1(7)}`, {
      cddl: EVENT_CDDL,
    }) as { anything: unknown };
    expect(Tag.get(v.anything)).toBe(1n);
  });

  test('keeps a tag when the untagged value would take another member', () => {
    // Untagged, "a" would be claimed by the wildcard instead.
    const cddl = `m = { ? "a" => time, * tstr => number }`;
    const v = CBOR.parse(`{"a": 1(5)}`, { cddl }) as { a: unknown };
    expect(Tag.get(v.a)).toBe(1n);
    expect(bytesToHex(CBOR.fromJS(v, { cddl }).toCBOR())).toBe(
      bytesToHex(CBOR.fromCDN(`{"a": 1(5)}`).toCBOR())
    );
  });

  test('a tagged root and nested implied tags', () => {
    expect(CBOR.parse(`1(5)`, { cddl: `r = time` })).toBe(5);
    expect(CBOR.parse(`100(1(5))`, { cddl: `r = #6.100(time)` })).toBe(5);
  });

  test('stripTags still strips every tag', () => {
    const v = CBOR.parse(`{"t": 1(0), "anything": 1(7)}`, {
      cddl: EVENT_CDDL,
      stripTags: true,
    });
    expect(v).toEqual({ t: 0, anything: 7 });
  });

  test('honors cddlValidationOptions.rule', () => {
    const cddl = `root = tstr\nstamp = time`;
    const opts = { cddl, cddlValidationOptions: { rule: 'stamp' } };
    expect(CBOR.parse(`1(5)`, opts)).toBe(5);
    expect(CBOR.fromJS(5, opts).toCDN()).toBe(`DT'1970-01-01T00:00:05Z'`);
  });
});

describe('fromJS(): schema-implied tags are added', () => {
  test('a plain number becomes a DT value', () => {
    const item = CBOR.fromJS({ t: -14159024 }, { cddl: EVENT_CDDL });
    expect(item.toCDN()).toBe(`{"t":${MOON}}`);
    expect(bytesToHex(item.toCBOR())).toBe('a16174c13a00d80caf');
  });

  test('stringify() infers too', () => {
    expect(CBOR.stringify({ t: -14159024 }, { cddl: EVENT_CDDL })).toBe(
      `{"t":${MOON}}`
    );
  });

  test('tdate, arrays and a tagged root', () => {
    expect(
      CBOR.fromJS(
        { t: 0, d: '2020-01-01T00:00:00Z', times: [1, 2.5] },
        { cddl: EVENT_CDDL }
      ).toCDN()
    ).toBe(
      `{"t":DT'1970-01-01T00:00:00Z',"d":0("2020-01-01T00:00:00Z"),"times":[DT'1970-01-01T00:00:01Z',DT'1970-01-01T00:00:02.500Z']}`
    );
    expect(CBOR.fromJS(5, { cddl: `r = time` }).toCDN()).toBe(
      `DT'1970-01-01T00:00:05Z'`
    );
    expect(CBOR.fromJS(5, { cddl: `r = #6.100(time)` }).toCDN()).toBe(
      `100(DT'1970-01-01T00:00:05Z')`
    );
  });

  test('an alternative the value matches as-is wins', () => {
    expect(CBOR.fromJS({ t: 0, either: 5 }, { cddl: EVENT_CDDL }).toCDN()).toBe(
      `{"t":DT'1970-01-01T00:00:00Z',"either":5}`
    );
    const cddl = `r = [time, tstr] / [number, number]`;
    expect(CBOR.fromJS([5, 6], { cddl }).toCDN()).toBe(`[5,6]`);
    expect(CBOR.fromJS([5, 'x'], { cddl }).toCDN()).toBe(
      `[DT'1970-01-01T00:00:05Z',"x"]`
    );
  });

  test('already valid data is never changed', () => {
    const cddl = `m = { ? "a" => time, * tstr => number }`;
    expect(CBOR.fromJS({ a: 5 }, { cddl }).toCDN()).toBe(`{"a":5}`);
  });

  test('a Tag.symbol-annotated value is used as given', () => {
    expect(
      CBOR.fromJS({ t: Tag.set(5, 1n) }, { cddl: EVENT_CDDL }).toCDN()
    ).toBe(`{"t":DT'1970-01-01T00:00:05Z'}`);
    expect(() =>
      CBOR.fromJS({ t: Tag.set(5, 2n) }, { cddl: EVENT_CDDL })
    ).toThrow(CddlMismatchError);
  });

  test('implicitTags: false requires the tag', () => {
    expect(() =>
      CBOR.fromJS({ t: 5 }, { cddl: EVENT_CDDL, implicitTags: false })
    ).toThrow(CddlMismatchError);
  });

  test('a value inference cannot fix reports the plain mismatch', () => {
    expect(() => CBOR.fromJS({ t: 'x' }, { cddl: EVENT_CDDL })).toThrow(/\/t/);
  });

  test('fromCDN()/fromCBOR() never infer', () => {
    expect(() => CBOR.fromCDN(`{"t": 5}`, { cddl: EVENT_CDDL })).toThrow(
      CddlMismatchError
    );
  });
});

describe('nested implied tags', () => {
  test('keeps tags whose order inference would change', () => {
    // Untagged, 5 infers 101(100(5)) (first alternative) — not the original.
    const cddl = 'r = #6.101(#6.100(int)) / #6.100(#6.101(int))';
    const js = CBOR.parse('100(101(5))', { cddl });
    expect(Tag.get(js)).toBe(100n);
    expect(CBOR.stringify(js, { cddl })).toBe('100(101(5))');
    // The order inference does produce is still omitted.
    expect(CBOR.parse('101(100(5))', { cddl })).toBe(5);
  });

  test('the same tag number nested twice', () => {
    const cddl = 'r = #6.100(#6.100(int))';
    expect(CBOR.stringify(5, { cddl })).toBe('100(100(5))');
    expect(CBOR.parse('100(100(5))', { cddl })).toBe(5);
  });

  test('a layer checked twice (.and) is still one tag', () => {
    const cddl = 'r = #6.100(int) .and #6.100(uint)';
    expect(CBOR.stringify(5, { cddl })).toBe('100(5)');
    expect(CBOR.parse('100(5)', { cddl })).toBe(5);
  });
});

describe('toJS() → fromJS() round trip', () => {
  test.each([
    ['a16174c13a00d80caf', EVENT_CDDL], // {"t": 1(-14159024)}
    // {"t": 1(0), "either": 1(5), "anything": 1(7), "times": [1(1), 1(2)]}
    [
      bytesToHex(
        CBOR.fromCDN(
          `{"t": 1(0), "either": 1(5), "anything": 1(7), "times": [1(1), 1(2)]}`
        ).toCBOR()
      ),
      EVENT_CDDL,
    ],
    [
      bytesToHex(CBOR.fromCDN(`{"a": 1(5)}`).toCBOR()),
      `m = { ? "a" => time, * tstr => number }`,
    ],
    [
      bytesToHex(CBOR.fromCDN(`[1(5), "x"]`).toCBOR()),
      `r = [time, tstr] / [number, number]`,
    ],
    [bytesToHex(CBOR.fromCDN(`100(1(5))`).toCBOR()), `r = #6.100(time)`],
    [
      bytesToHex(CBOR.fromCDN(`100(101(5))`).toCBOR()),
      `r = #6.101(#6.100(int)) / #6.100(#6.101(int))`,
    ],
    [
      bytesToHex(CBOR.fromCDN(`100(100(5))`).toCBOR()),
      `r = #6.100(#6.100(int))`,
    ],
    [bytesToHex(CBOR.fromCDN(`[1(5), 5]`).toCBOR()), `r = [* (time / number)]`],
  ])('%s', (hex, cddl) => {
    expect(jsRoundTrip(hex, cddl)).toBe(hex);
  });
});
