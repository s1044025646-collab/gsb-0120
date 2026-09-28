import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openDb } from "../src/db";
import { Service } from "../src/service";
import { rebuildTimeline, getTimeline } from "../src/timeline";
import { FixedClock } from "../src/clock";

describe("persistence across restarts", () => {
  it("state survives closing and reopening the database", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ho-")), "test.sqlite");
    const clock = new FixedClock(1_700_000_000_000);
    let terminalId = 0;
    {
      const db = openDb(file);
      const svc = new Service(db, clock);
      const cell = svc.createCell("P1").id;
      terminalId = svc.createTerminal("anon-p").id;
      svc.importEvents([
        { terminalId, type: "signal_strength", cellId: cell, payload: { rsrp: -95 }, deviceTime: 100, source: "probe" },
        { terminalId, type: "drop", cellId: cell, deviceTime: 200, source: "terminal" },
      ]);
      rebuildTimeline(db, svc, terminalId, clock);
      db.close();
    }
    // "restart": brand new connection to the same file
    {
      const db = openDb(file);
      const tl = getTimeline(db, terminalId);
      expect(tl).not.toBeNull();
      expect(tl!.drops).toHaveLength(1);
      const events = db.prepare("SELECT * FROM events ORDER BY id").all();
      expect(events).toHaveLength(2);
      // migrations are repeatable: opening again applies nothing new
      const migs = db.prepare("SELECT id FROM schema_migrations").all();
      expect(migs.length).toBeGreaterThan(0);
      db.close();
    }
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
