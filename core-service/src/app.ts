import express from 'express';
import { router } from './routes.js';
import { errorHandler } from './lib/error/errorHandler.js';
import {correlationIdMiddleware} from "./lib/correlationId/correlationId";
import cookieParser from "cookie-parser"
import cors from 'cors'
import {env} from "./lib/config/env";
import helmet from "helmet";


export function createApp() {
    const app = express();
    app.use(helmet());
    app.use(cors({origin: env.cors.origin , credentials: true}));
    app.set('query parser', 'extended');
    app.use(express.json());
    app.use(cookieParser())
    app.use(correlationIdMiddleware)
    app.use("/api", router);
    app.use(errorHandler);
    return app;
}

