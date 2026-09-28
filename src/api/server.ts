import { openDatabase } from "../db/database.js";
import { systemClock } from "../core/clock.js";
import { createApp, listen } from "./app.js";

const dbPath = process.env.CELL_DB_PATH ?? "data/cellular.sqlite";
const port = Number(process.env.PORT ?? "0");
const db = openDatabase(dbPath);
const server = createApp({ db, clock: systemClock });
const bound = await listen(server, port);
console.log(JSON.stringify({ status: "listening", host: "127.0.0.1", port: bound.port, dbPath }));

const shutdown = (): void => {
  console.log(JSON.stringify({ status: "stopping" }));
  void bound.close().then(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
