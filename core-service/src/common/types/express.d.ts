declare namespace Express {
    interface Request {
        correlationId?: string;
        user?: {
            user_id: number;
            email: string;
            role: string;
        };
    }
}