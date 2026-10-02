declare namespace Express {
    interface Request {
        correlationId?: string;
        user?: {
            user_id: number;
            email: string;
            role: string;

            // for restaurant user only
            restaurantId?:number;
            restaurantRole?:string;
            branchIds?:number[];

            // for SystemRole.SERVICE_ACCOUNT only (lib/auth/api-key.guard.ts) -
            // the role name attached to the api_keys row, used to look up
            // permissions the same way a restaurant user's role would
            serviceName?:string;
            serviceRole?:string;
        };
    }
}