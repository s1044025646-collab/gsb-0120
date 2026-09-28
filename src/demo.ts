/**
 * Repeatable end-to-end demo on a throwaway database:
 * seed fictional network -> import scenarios -> rebuild timelines ->
 * analyze drops -> publish -> export. Deterministic (seeded RNG, fixed clock).
 */
import * as fs from "fs";
import { openDb } from "./db";
import { Service } from "./service";
import { FixedClock } from "./clock";
import { seedNetwork, generateAll, BASE_TIME } from "./fixtures";
import { rebuildTimeline } from "./timeline";
import { investigate, publishInvestigation, getInvestigation } from "./analyze";

const file = "demo.sqlite";
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.unlinkSync(file + suffix);
  } catch {
    // ignore missing files
  }
}
const db = openDb(file);
const clock = new FixedClock(BASE_TIME);
const svc = new Service(db, clock);

console.log("== seed fictional network (cells A/B/C, config v1 with missing B->C, v2 fix) ==");
const ctx = seedNetwork(db, svc);
const scenarios = generateAll(ctx);
for (const [name, evs] of Object.entries(scenarios)) {
  const r = svc.importEvents(evs);
  console.log(`  scenario ${name}: imported=${r.inserted} duplicates=${r.duplicates}`);
}

console.log("\n== rebuild timelines ==");
for (const [name, tid] of Object.entries(ctx.terminals)) {
  const tl = rebuildTimeline(db, svc, tid, clock);
  const cls = tl.handovers.map((h) => h.classification);
  console.log(`  ${name}: handovers=[${cls.join(",")}] drops=${tl.drops.length}`);
}

console.log("\n== analyze drops ==");
const drops = db.prepare("SELECT id, terminal_id, detected_at FROM drops ORDER BY id").all() as any[];
const invIds: number[] = [];
for (const d of drops) {
  const r = investigate(db, svc, d.id, null, clock);
  invIds.push(r.id);
  console.log(`  drop#${d.id} (terminal ${d.terminal_id}) -> root cause: ${r.rootCause}`);
  for (const a of r.assessments)
    console.log(`    ${a.cause}: evidence=${a.evidence.length} counter=${a.counterEvidence.length} score=${a.score}`);
}

console.log("\n== apply config fix (activate v2) and re-check ==");
svc.activateConfig(ctx.cells.B, ctx.configV2, BASE_TIME + 1_000_000);
console.log("  compare v1->v2:", JSON.stringify(svc.compareConfigVersions(1, 2)));

console.log("\n== publish & export first investigation ==");
publishInvestigation(db, invIds[0], clock);
const report = getInvestigation(db, invIds[0]);
fs.writeFileSync("demo-report.json", JSON.stringify(report, null, 2));
console.log(`  published investigation #${invIds[0]}, exported to demo-report.json`);

db.close();
console.log("\ndemo complete. database: demo.sqlite");
