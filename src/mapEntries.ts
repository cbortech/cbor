import { fromJS } from './js/fromJS';

export class MapEntries extends Array<[unknown, unknown]> {
  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of this) {
      const key = typeof k === 'string' ? k : fromJS(k).toCDN();
      if (key === '__proto__') {
        Object.defineProperty(result, key, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        result[key] = v;
      }
    }
    return result;
  }
}
