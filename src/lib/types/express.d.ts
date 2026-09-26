declare namespace Express {
  interface Request {
    correlationId?: string;
    user?: {
      user_id: number;
      email: string;
      role: string;

      // restaurant-user tokens only (mirrors core-service's JwtPayload shape,
      // since access tokens are minted by core-service and only verified here)
      restaurantId?: number;
      restaurantRole?: string;
      branchIds?: number[];
    };
  }
}
