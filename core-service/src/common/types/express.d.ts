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
        };
    }
}