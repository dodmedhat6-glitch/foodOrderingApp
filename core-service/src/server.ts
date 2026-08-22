import http from "http";
import {createApp} from "./app.js";
import {env} from "./common/config/env.js";
import {db} from "./common/knex/kenx.js";


const app = createApp();
const server = http.createServer(app);

server.listen(env.port, () =>{
    console.log(`Server is running on port ${env.port}`);
}
);

async function shutdown() {
    console.log("Shutting down server...");
    server.close(async () => {
        console.log("Server closed.");
        await db.destroy();
        console.log("Database connection closed.");
        process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
