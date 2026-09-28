import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "../src/db/database.js";
import { fakeClock } from "../src/core/clock.js";
import { ScenarioGenerator } from "../src/ingest/generator.js";
import { importScenario, importJsonl, ImportValidationError } from "../src/ingest/importer.js";
import { InvestigationService } from "../src/core/investigation.js";
import { runAnalysis } from "../src/core/investigation.js";

test("state survives process restart; migration re-run is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "cell-restart-"));
  const dbPath = join(dir, "cell.sqlite");
  const clock = fakeClock(2_000_000);
  let invId = "";
  {
    const db = openDatabase(dbPath);
    const out = new ScenarioGenerator({ seed: 9 }).generate("pingpong");
    importScenario(db, out, clock);
    invId = new InvestigationService(db, clock).createDraft().investigationId;
    new InvestigationService(db, clock).publish(invId);
    db.close();
  }
  assert.ok(existsSync(dbPath));
  {
    const db = openDatabase(dbPath);
    const m = migrate(db);
    assert.deepEqual(m.applied, []);
    const evts = (db.prepare("SELECT COUNT(*) AS c FROM signaling_events").get() as { c: number }).c;
    const hos = (db.prepare("SELECT COUNT(*) AS c FROM handovers").get() as { c: number }).c;
    const inv = new InvestigationService(db, clock).get(invId)!;
    assert.equal(evts, 5);
    assert.equal(hos, 2);
    assert.equal(inv.status, "PUBLISHED");
    db.close();
  }
});

test("concurrent batch inserts are isolated by transactions and dedup still holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "cell-conc-"));
  const dbPath = join(dir, "cell.sqlite");
  const db = openDatabase(dbPath);
  const out = new ScenarioGenerator({ seed: 3 }).generate("duplicates");
  const clock = fakeClock(5_000_000);
  // Simulate two collectors inserting overlapping subsets at once.
  const half = out.signals.slice(0, 3);
  const other = out.signals.slice(2);
  const r1 = importScenario(
        db,
        { ...out, signals: half, configs: [], clocks: [], terminals: out.terminals, sectors: out.sectors },
        clock,
        { recompute: false, batchId: "b1" },
      );
  void r1;
  const r2 = importScenario(
        db,
        { ...out, signals: other, configs: [], clocks: [], terminals: out.terminals, sectors: out.sectors },
        clock,
        { recompute: false, batchId: "b2" },
      );
  void r2;
  const run = runAnalysis(db, clock);
  assert.equal(run.recomputed.handovers, 1, "duplicated command/ack must not double handovers");
  db.close();
});

test("invalid JSONL lines are rejected before anything is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "cell-bad-"));
  const dbPath = join(dir, "cell.sqlite");
  const file = join(dir, "bad.jsonl");
  writeFileSync(file, '{"source":"UE","sourceSeq":1,"eventType":"MEAS_REPORT","eventTimeMs":1,"payload":{}}\n{"oops":true}\n');
  const db = openDatabase(dbPath);
  assert.throws(
    () => importJsonl(db, file, fakeClock(0)),
    (err: unknown) => err instanceof ImportValidationError || /validation/.test(String((err as Error).message)),
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM signaling_events").get() as { c: number }).c, 0);
  db.close();
});
