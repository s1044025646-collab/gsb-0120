import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../db/database.js";
import { systemClock } from "../core/clock.js";
import { runAnalysis, InvestigationService } from "../core/investigation.js";
import { QueryService } from "../core/query.js";
import { compareConfigVersions, listConfigVersions } from "../core/config.js";
import { ScenarioGenerator, SCENARIOS, type ScenarioName } from "../ingest/generator.js";
import { importJsonl, importScenario, ImportValidationError } from "../ingest/importer.js";

interface CliState {
  events: number;
  handovers: number;
  drops: number;
  published: number;
}

function dbPath(): string {
  return process.env.CELL_DB_PATH ?? resolve("data/cellular.sqlite");
}

function snapshot(db: ReturnType<typeof openDatabase>): CliState {
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  return {
    events: one("SELECT COUNT(*) AS c FROM signaling_events"),
    handovers: one("SELECT COUNT(*) AS c FROM handovers"),
    drops: one("SELECT COUNT(*) AS c FROM drops"),
    published: one("SELECT COUNT(*) AS c FROM investigations WHERE status='PUBLISHED'"),
  };
}

function fmtState(s: CliState): string {
  return `events=${s.events} handovers=${s.handovers} drops=${s.drops} published=${s.published}`;
}

function usage(): void {
  console.log(`cellular-handover-rca CLI (synthetic data only)

Usage:
  cli init
  cli import-scenario <name> [--seed N] [--no-recompute]
  cli import-jsonl <file>
  cli rebuild
  cli analyze [--terminal ID]
  cli timeline <terminalId>
  cli evidence <investigationId>
  cli config-versions <sectorId>
  cli config-diff <sectorId> <from|null> <to|null>
  cli investigate [--publish]
  cli export <investigationId> <output.json>
  cli scenarios
  cli stats
`);
}

function run(argv: string[]): number {
  const [cmd, ...args] = argv;
  const db = openDatabase(dbPath());
  const before = snapshot(db);
  try {
    switch (cmd) {
      case "init":
        console.log("database ready at", dbPath());
        console.log("state:", fmtState(before));
        return 0;
      case "scenarios":
        console.log(SCENARIOS.join("\n"));
        return 0;
      case "stats":
        console.log(fmtState(before));
        return 0;
      case "import-scenario": {
        const name = args[0] as ScenarioName | undefined;
        if (!name || !SCENARIOS.includes(name)) throw new CliError(`unknown scenario: ${String(name)}`);
        const seed = Number(option(args, "--seed") ?? "42");
        const recompute = !args.includes("--no-recompute");
        const out = new ScenarioGenerator({ seed }).generate(name);
        console.log(`before  ${fmtState(before)}`);
        const report = importScenario(db, out, systemClock, { recompute });
        const after = snapshot(db);
        console.log(`imported scenario=${name} inserted=${report.inserted} duplicates=${report.duplicates} configs=${report.configs} clocks=${report.clocks}`);
        console.log(`after   ${fmtState(after)}`);
        return 0;
      }
      case "import-jsonl": {
        const file = args[0];
        if (!file) throw new CliError("import-jsonl requires <file>");
        console.log(`before  ${fmtState(before)}`);
        const report = importJsonl(db, resolve(file), systemClock);
        console.log(`inserted=${report.inserted} duplicates=${report.duplicates}`);
        console.log(`after   ${fmtState(snapshot(db))}`);
        return 0;
      }
      case "rebuild": {
        console.log(`before  ${fmtState(before)}`);
        const run = runAnalysis(db, systemClock);
        console.log(`rerunToken=${run.rerunToken}`);
        console.log(`after   ${fmtState(snapshot(db))}`);
        return 0;
      }
      case "analyze": {
        const run = runAnalysis(db, systemClock);
        const qs = new QueryService(db);
        const terminal = option(args, "--terminal");
        const filter = terminal ? { terminalId: terminal } : {};
        const hos = qs.listHandovers(filter) as { items: Record<string, unknown>[]; total: number };
        const drops = qs.listDrops(filter) as { items: Record<string, unknown>[]; total: number };
        console.log(`handovers (${hos.total}):`);
        for (const h of hos.items) console.log(`  ${String(h.terminal_id)} ${String(h.from_sector_id)}->${String(h.to_sector_id)} ${String(h.outcome)} ${String(h.classification)}`);
        console.log(`drops (${drops.total}):`);
        for (const d of drops.items) console.log(`  ${String(d.terminal_id)} @${String(d.sector_id)} t=${String(d.detected_ref_ms)}`);
        console.log(`findings (${run.findings.length}):`);
        for (const f of run.findings) console.log(`  ${f.terminalId} ${f.category} conf=${f.confidence} - ${f.verdict}`);
        return 0;
      }
      case "timeline": {
        const id = args[0];
        if (!id) throw new CliError("timeline requires <terminalId>");
        const result = new QueryService(db).timeline(id, { limit: 200 });
        if ("error" in result) throw new CliError(result.error!);
        for (const s of result.items) {
          console.log(`  t=${String(s.begin_ref_ms)}..${s.end_ref_ms === null ? "open" : String(s.end_ref_ms)} ${String(s.state)} ${String(s.sector_id ?? "-")}`);
        }
        return 0;
      }
      case "evidence": {
        const id = args[0];
        if (!id) throw new CliError("evidence requires <investigationId>");
        const inv = new InvestigationService(db, systemClock).get(id);
        if (!inv) throw new CliError(`investigation ${id} not found`);
        console.log(`investigation=${id} status=${inv.status} maxEventId=${inv.maxEventId}`);
        for (const f of inv.findings) {
          console.log(`[${f.category}] ${f.terminalId} confidence=${f.confidence}`);
          console.log(`  verdict: ${f.verdict}`);
          for (const e of f.evidence) console.log(`  + t=${e.refMs} evt=${e.eventId} ${e.detail}`);
          for (const c of f.counterEvidence) console.log(`  - t=${c.refMs} evt=${c.eventId} ${c.detail}`);
        }
        return 0;
      }
      case "config-versions": {
        const id = args[0];
        if (!id) throw new CliError("config-versions requires <sectorId>");
        for (const v of listConfigVersions(db, id)) console.log(`  v${v.version} effective=${v.effectiveAtMs} id=${v.configVersionId}`);
        return 0;
      }
      case "config-diff": {
        const [sector, from, to] = args;
        if (!sector || !from || !to) throw new CliError("config-diff requires <sectorId> <from|null> <to|null>");
        const parse = (v: string): number | null => (v === "null" ? null : Number(v));
        const diff = compareConfigVersions(db, sector, parse(from), parse(to));
        console.log(`added:   ${diff.added.join(", ") || "-"}`);
        console.log(`removed: ${diff.removed.join(", ") || "-"}`);
        console.log(`kept:    ${diff.unchanged.join(", ") || "-"}`);
        return 0;
      }
      case "investigate": {
        console.log(`before  ${fmtState(before)}`);
        const svc = new InvestigationService(db, systemClock);
        const inv = svc.createDraft();
        if (args.includes("--publish")) svc.publish(inv.investigationId);
        const saved = svc.get(inv.investigationId)!;
        console.log(`investigation=${saved.investigationId} status=${saved.status} findings=${saved.findings.length}`);
        console.log(`after   ${fmtState(snapshot(db))}`);
        return 0;
      }
      case "export": {
        const [id, out] = args;
        if (!id || !out) throw new CliError("export requires <investigationId> <output.json>");
        const svc = new InvestigationService(db, systemClock);
        const inv = svc.get(id);
        if (!inv) throw new CliError(`investigation ${id} not found`);
        if (inv.status !== "PUBLISHED") svc.publish(id);
        const report = svc.get(id)!;
        writeFileSync(resolve(out), JSON.stringify({ exportedAt: systemClock.now(), investigation: report }, null, 2), "utf8");
        console.log(`exported ${id} -> ${out} (${report.findings.length} findings)`);
        return 0;
      }
      default:
        usage();
        return cmd === undefined ? 1 : 0;
    }
  } catch (err) {
    if (err instanceof ImportValidationError) {
      console.error(err.message);
      return 2;
    }
    if (err instanceof CliError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    console.error("error:", (err as Error).message);
    return 1;
  } finally {
    db.close();
  }
}

function option(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

class CliError extends Error {}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  process.exit(run(process.argv.slice(2)));
}

export { run };
