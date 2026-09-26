export interface BranchLookup {
  id: number;
  restaurantId: number;
  countryCode: string;
  currency: string;
}

export interface AddressLookup {
  id: number;
  customerId: number;
  lat: number;
  lng: number;
  addressText: string;
}

export interface UserLookup {
  id: number;
  name: string;
  email: string;
}

export interface ProductLookup {
  id: number;
  branchId: number;
  name: string;
  imageUrl: string | null;
  unitPriceMinor: number;
  isAvailable: boolean;
  stock: number;
}

export interface ICoreServiceClient {
  getBranch(branchId: number): Promise<BranchLookup>;
  getAddress(addressId: number): Promise<AddressLookup>;
  getUser(userId: number): Promise<UserLookup>;
  getProducts(productIds: number[], branchId: number): Promise<ProductLookup[]>;
}
