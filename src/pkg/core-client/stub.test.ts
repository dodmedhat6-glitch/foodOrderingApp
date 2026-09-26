import { describe, expect, it } from 'vitest';
import { StubCoreServiceClient } from './stub';

describe('StubCoreServiceClient', () => {
  const client = new StubCoreServiceClient();

  it('getProducts returns one fixture row per id in a single call', async () => {
    const ids = [1, 2, 3, 7, 14];
    const products = await client.getProducts(ids, 99);

    expect(products).toHaveLength(ids.length);
    products.forEach((product, index) => {
      expect(product.id).toBe(ids[index]);
      expect(product.branchId).toBe(99);
    });
  });

  it('marks stock-depleted fixtures as unavailable (id % 7 === 0)', async () => {
    const [depleted] = await client.getProducts([7], 1);
    const [available] = await client.getProducts([8], 1);

    expect(depleted.isAvailable).toBe(false);
    expect(depleted.stock).toBe(0);
    expect(available.isAvailable).toBe(true);
    expect(available.stock).toBeGreaterThan(0);
  });

  it('getBranch derives a deterministic country code from the branch id', async () => {
    const eg = await client.getBranch(2);
    const sa = await client.getBranch(3);

    expect(eg.countryCode).toBe('EG');
    expect(sa.countryCode).toBe('SA');
  });
});
