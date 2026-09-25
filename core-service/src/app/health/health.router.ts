import {Router} from "express";
import {testDB} from "../../lib/knex/kenx.js";
import {sendError, sendSuccess} from "../../lib/http/response";

export const healthRouter = Router();     

healthRouter.get("/", async (req, res) => {
    try {
        await testDB();
        sendSuccess(res, {status: "ok"});
    } catch (error) {
        sendError(res, "Database connection failed", 500);
    }
});