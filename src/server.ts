import { openDb } from "./db";
import { createApp } from "./api";

const dbPath = process.env.DB_PATH ?? "data.sqlite";
const db = openDb(dbPath);
const app = createApp(db);
// port 0 => OS assigns a free local port
const port = Number(process.env.PORT ?? 0);
const server = app.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  console.log(`listening on http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
