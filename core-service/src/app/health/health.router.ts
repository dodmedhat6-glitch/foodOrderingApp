import {Router} from "express";
import {testDB} from "../../common/knex/kenx.js";

export const healthRouter = Router();     

healthRouter.get("/", async (req, res) => {
    try {
        await testDB();
        res.status(200).json({ status: "ok" });
    } catch (error) {
        res.status(500).json({message: "Database connection failed" });
    }
});