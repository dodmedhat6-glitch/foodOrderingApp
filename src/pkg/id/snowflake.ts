/**
 * Snowflake-style application-generated id: [41-bit ms timestamp][8-bit region
 * id][14-bit sequence] - see 02-database-design.md §4. Pure: no env/DI awareness.
 */
export class SnowflakeIdGenerator {
  private static readonly SEQUENCE_BITS = 14n;
  private static readonly REGION_BITS = 8n;
  private static readonly SEQUENCE_MASK = (1n << SnowflakeIdGenerator.SEQUENCE_BITS) - 1n;
  private static readonly REGION_MASK = (1n << SnowflakeIdGenerator.REGION_BITS) - 1n;
  static readonly MAX_REGION_ID = Number(SnowflakeIdGenerator.REGION_MASK);
  static readonly DEFAULT_EPOCH_MS = Date.UTC(2026, 0, 1);

  private readonly regionId: number;
  private readonly epochMs: number;
  private lastTimestamp = -1;
  private sequence = 0;

  constructor(regionId: number, epochMs: number = SnowflakeIdGenerator.DEFAULT_EPOCH_MS) {
    if (regionId < 0 || regionId > SnowflakeIdGenerator.MAX_REGION_ID) {
      throw new Error(
        `regionId must be between 0 and ${SnowflakeIdGenerator.MAX_REGION_ID}, got ${regionId}`,
      );
    }
    this.regionId = regionId;
    this.epochMs = epochMs;
  }

  nextId(): bigint {
    let timestamp = Date.now();

    if (timestamp < this.lastTimestamp) {
      throw new Error('clock moved backwards - refusing to generate id');
    }

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1) & Number(SnowflakeIdGenerator.SEQUENCE_MASK);
      if (this.sequence === 0) {
        // sequence exhausted within this millisecond - spin to the next one
        while (timestamp <= this.lastTimestamp) {
          timestamp = Date.now();
        }
      }
    } else {
      this.sequence = 0;
    }

    this.lastTimestamp = timestamp;

    const timestampPart = BigInt(timestamp - this.epochMs);
    const regionPart = BigInt(this.regionId);
    const sequencePart = BigInt(this.sequence);
    const shift = SnowflakeIdGenerator.REGION_BITS + SnowflakeIdGenerator.SEQUENCE_BITS;

    return (
      (timestampPart << shift) | (regionPart << SnowflakeIdGenerator.SEQUENCE_BITS) | sequencePart
    );
  }

  decode(id: bigint): { timestampMs: number; regionId: number; sequence: number } {
    return SnowflakeIdGenerator.decode(id, this.epochMs);
  }

  static decode(
    id: bigint,
    epochMs: number = SnowflakeIdGenerator.DEFAULT_EPOCH_MS,
  ): { timestampMs: number; regionId: number; sequence: number } {
    const shift = SnowflakeIdGenerator.REGION_BITS + SnowflakeIdGenerator.SEQUENCE_BITS;
    const sequence = Number(id & SnowflakeIdGenerator.SEQUENCE_MASK);
    const regionId = Number(
      (id >> SnowflakeIdGenerator.SEQUENCE_BITS) & SnowflakeIdGenerator.REGION_MASK,
    );
    const timestampMs = Number(id >> shift) + epochMs;
    return { timestampMs, regionId, sequence };
  }
}
