import { describe, expect, it } from 'vitest';
import { env } from './env';

describe('env (multi-region config)', () => {
  it('parses REGIONS into regionCodes with stable numeric ids by list order', () => {
    expect(env.regionCodes).toEqual(['EG', 'SA']);
    expect(env.regions.EG.id).toBe(0);
    expect(env.regions.SA.id).toBe(1);
  });

  it('builds a distinct hot + archive connection per region', () => {
    for (const code of env.regionCodes) {
      const region = env.regions[code];
      expect(region.hot.database).not.toBe(region.archive.database);
      expect(region.hot.database).toContain(code.toLowerCase());
      expect(region.archive.database).toContain('archive');
    }
  });

  it('has no entry for an unconfigured region code', () => {
    expect(env.regions.FR).toBeUndefined();
  });
});
