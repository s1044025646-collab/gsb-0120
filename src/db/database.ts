import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.js";

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): { version: number; applied: number[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    );
  `);
  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as { version: number }[];
  const applied = new Set(appliedRows.map((r) => r.version));
  const newlyApplied: number[] = [];
  const now = Date.now();
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const tx = db.prepare(
      `INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, ?)`,
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      tx.run(migration.version, now);
      db.exec("COMMIT");
      newlyApplied.push(migration.version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  const current = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
  return { version: current, applied: newlyApplied };
}
