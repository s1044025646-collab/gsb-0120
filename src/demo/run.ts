// Repeatable end-to-end demonstration. Synthetic data only; no real network.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.js";
import { fakeClock } from "../core/clock.js";
import { ScenarioGenerator, SCENARIOS, type ScenarioOutput } from "../ingest/generator.js";
import { importScenario } from "../ingest/importer.js";
import { InvestigationService } from "../core/investigation.js";
import { compareConfigVersions } from "../core/config.js";
import { createApp, listen } from "../api/app.js";

const SEED = 20260928;
const clock = fakeClock(1_700_000_000_000);

console.log("=== cellular handover RCA demo (synthetic only) ===");

// 1) Each scenario in an isolated database.
console.log("\n[1] isolated scenario runs");
for (const name of SCENARIOS) {
  const db = openDatabase(":memory:");
  const out: ScenarioOutput = new ScenarioGenerator({ seed: SEED, startTimeMs: 1_000_000 }).generate(name);
  const report = importScenario(db, out, clock);
  const findings = report.analysis?.findings.map((f) => f.category).join(",") || "-";
  console.log(
    `  ${name.padEnd(17)} inserted=${String(report.inserted).padStart(2)} dup=${report.duplicates} ` +
      `ho=${report.analysis?.recomputed.handovers} drops=${report.analysis?.recomputed.drops} findings=${findings}`,
  );
  db.close();
}

// 2) Persistent database: late config repair triggers recompute; the earlier
//    published investigation remains reproducible and immutable.
console.log("\n[2] late config + recompute vs immutable published investigation");
const dir = mkdtempSync(join(tmpdir(), "cellular-demo-"));
const dbPath = join(dir, "demo.sqlite");
const db = openDatabase(dbPath);
const gen = new ScenarioGenerator({ seed: SEED, startTimeMs: 1_000_000 });
const beforeRepair = gen.generate("missing_neighbor");
const r1 = importScenario(db, beforeRepair, clock);
const svc = new InvestigationService(db, clock);
const first = svc.createDraft(r1.analysis);
const published = svc.publish(first.investigationId);
console.log(`  published ${published.investigationId}: ${published.findings[0]?.category}`);

const repair = new ScenarioGenerator({ seed: SEED, startTimeMs: 1_000_000 }).generate("config_repair");
importScenario(db, repair, clock);
const second = svc.createDraft();
const frozen = JSON.stringify(svc.get(published.investigationId)!.findings);
console.log(`  after repair -> new draft ${second.investigationId}`);
console.log(`  published report unchanged: ${JSON.stringify(svc.get(published.investigationId)!.findings) === frozen}`);
const diff = compareConfigVersions(db, "secA", 1, 2);
console.log(`  config diff secA v1->v2: added=${diff.added.join("|") || "-"} removed=${diff.removed.join("|") || "-"}`);

const reportPath = join(dir, "published-report.json");
writeFileSync(reportPath, JSON.stringify(svc.get(published.investigationId), null, 2));
console.log("  exported:", reportPath);

// 3) HTTP API on an ephemeral local port with validation and pagination.
const server = createApp({ db, clock });
const bound = await listen(server, 0);
const base = `http://127.0.0.1:${bound.port}`;
const health = await fetch(`${base}/health`).then((r) => r.json());
const page = await fetch(`${base}/events?limit=3&offset=0`).then((r) => r.json());
const bad = await fetch(`${base}/events?limit=abc`);
console.log(`\n[3] api on 127.0.0.1:${bound.port} maxEventId=${health.data.maxEventId} page=${page.data.items.length}/${page.data.total} badRequest=${bad.status}`);
await bound.close();
db.close();
rmSync(dir, { recursive: true, force: true });
console.log("\ndemo complete");
