import { describe, expect, it } from 'vitest';
import { SnowflakeIdGenerator } from './snowflake';

describe('SnowflakeIdGenerator', () => {
  it('rejects out-of-range region ids', () => {
    expect(() => new SnowflakeIdGenerator(-1)).toThrow();
    expect(() => new SnowflakeIdGenerator(256)).toThrow();
    expect(() => new SnowflakeIdGenerator(0)).not.toThrow();
    expect(() => new SnowflakeIdGenerator(255)).not.toThrow();
  });

  it('generates unique, monotonically increasing ids within one region', () => {
    const gen = new SnowflakeIdGenerator(3);
    const ids = new Set<bigint>();
    let previous = -1n;
    for (let i = 0; i < 5000; i++) {
      const id = gen.nextId();
      expect(id).toBeGreaterThan(previous);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      previous = id;
    }
    expect(ids.size).toBe(5000);
  });

  it('never collides across two different region generators', () => {
    const genA = new SnowflakeIdGenerator(0);
    const genB = new SnowflakeIdGenerator(1);
    const ids = new Set<bigint>();
    for (let i = 0; i < 2000; i++) {
      ids.add(genA.nextId());
      ids.add(genB.nextId());
    }
    expect(ids.size).toBe(4000);
  });

  it('round-trips through decode()', () => {
    const gen = new SnowflakeIdGenerator(42);
    const before = Date.now();
    const id = gen.nextId();
    const after = Date.now();
    const decoded = gen.decode(id);

    expect(decoded.regionId).toBe(42);
    expect(decoded.timestampMs).toBeGreaterThanOrEqual(before);
    expect(decoded.timestampMs).toBeLessThanOrEqual(after);
    expect(decoded.sequence).toBeGreaterThanOrEqual(0);
  });

  it('static decode() matches instance decode() for the same epoch', () => {
    const epoch = SnowflakeIdGenerator.DEFAULT_EPOCH_MS;
    const gen = new SnowflakeIdGenerator(7, epoch);
    const id = gen.nextId();
    expect(SnowflakeIdGenerator.decode(id, epoch)).toEqual(gen.decode(id));
  });
});
