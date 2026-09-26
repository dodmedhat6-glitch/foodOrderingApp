import {
  AddressLookup,
  BranchLookup,
  ICoreServiceClient,
  ProductLookup,
  UserLookup,
} from './core-client.interface';

/**
 * Deterministic fixture data standing in for real HTTP calls to core-service
 * until its endpoint contracts stabilize - see 01-system-design.md §3.1.
 * Swap target: a future pkg/core-client/http.ts, wired in lib/core-client/init.ts.
 */
export class StubCoreServiceClient implements ICoreServiceClient {
  async getBranch(branchId: number): Promise<BranchLookup> {
    return {
      id: branchId,
      restaurantId: 1000 + (branchId % 50),
      countryCode: branchId % 2 === 0 ? 'EG' : 'SA',
      currency: branchId % 2 === 0 ? 'EGP' : 'SAR',
    };
  }

  async getAddress(addressId: number): Promise<AddressLookup> {
    return {
      id: addressId,
      customerId: 2000 + (addressId % 50),
      lat: 30.0 + (addressId % 100) / 1000,
      lng: 31.0 + (addressId % 100) / 1000,
      addressText: `Fixture address #${addressId}`,
    };
  }

  async getUser(userId: number): Promise<UserLookup> {
    return {
      id: userId,
      name: `Fixture User #${userId}`,
      email: `user${userId}@example.test`,
    };
  }

  async getProducts(productIds: number[], branchId: number): Promise<ProductLookup[]> {
    // one batched call regardless of productIds.length - never N sequential lookups
    return productIds.map((id) => ({
      id,
      branchId,
      name: `Fixture Product #${id}`,
      imageUrl: null,
      unitPriceMinor: 500 + id * 25,
      isAvailable: id % 7 !== 0,
      stock: id % 7 === 0 ? 0 : 10 + (id % 20),
    }));
  }
}
