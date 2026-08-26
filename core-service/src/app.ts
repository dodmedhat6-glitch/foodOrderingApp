import express from 'express';
import { router } from './routes.js';
import { errorHandler } from './common/error/errorHandler.js';
import {correlationIdMiddleware} from "./common/correlationId/correlationId";
import cookieParser from "cookie-parser"
export function createApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser())
    app.use(correlationIdMiddleware)
    app.use("/api", router);
    app.use(errorHandler);
    return app;
}

