import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SignalRepository } from "../core/repository.js";
import { runAnalysis } from "../core/investigation.js";
import type { Clock } from "../core/clock.js";
import type { RawSignalInput } from "../core/types.js";
import type { ScenarioOutput } from "./generator.js";

export interface ImportReport {
  batchId: string;
      inserted: number;
  duplicates: number;
  terminals: number;
  sectors: number;
  configs: number;
  clocks: number;
  analysis?: Awaited<ReturnType<typeof runAnalysis>>;
}

// Loads a scenario bundle (entities + signals) transactionally.
export function importScenario(
  db: DatabaseSync,
  out: ScenarioOutput,
  clock: Clock,
  opts: { batchId?: string; recompute?: boolean } = {},
): ImportReport {
  const repo = new SignalRepository(db);
  for (const t of out.terminals) repo.upsertTerminal(t.terminalId, t.pseudonym, t.registeredAtMs);
  for (const s of out.sectors) repo.upsertSector(s);
  let configs = 0;
  for (const c of out.configs) {
    if (
      repo.upsertConfigVersion({
        configVersionId: c.configVersionId,
        sectorId: c.sectorId,
        version: c.version,
        effectiveAtMs: c.effectiveAtMs,
        importedAtMs: c.importedAtMs,
        neighbors: c.neighbors,
      })
    )
      configs++;
  }
  let clocks = 0;
  for (const c of out.clocks) {
    repo.addClockCalibration({ ...c, createdAtMs: clock.now() });
    clocks++;
  }
  const res = repo.insertBatch(opts.batchId ?? `import_${randomUUID().slice(0, 8)}`, out.signals, clock.now());
  const report: ImportReport = {
    batchId: opts.batchId ?? "",
    inserted: res.inserted,
    duplicates: res.duplicates,
    terminals: out.terminals.length,
    sectors: out.sectors.length,
    configs,
    clocks,
  };
  if (opts.recompute ?? true) report.analysis = runAnalysis(db, clock);
  return report;
}

// One JSON object per line. Accepts either a RawSignalInput or a wrapper with
// entity sections. Unknown lines fail validation explicitly.
export function importJsonl(db: DatabaseSync, path: string, clock: Clock, recompute = true): ImportReport {
  const text = readFileSync(path, "utf8");
  const signals: RawSignalInput[] = [];
  const errors: { line: number; error: string }[] = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const obj = JSON.parse(trimmed) as RawSignalInput;
      validateSignal(obj, idx + 1, errors);
      if (errors.length === 0 || errors[errors.length - 1]!.line !== idx + 1) signals.push(obj);
    } catch (err) {
      errors.push({ line: idx + 1, error: `invalid JSON: ${(err as Error).message}` });
    }
  });
  if (errors.length > 0) {
    throw new ImportValidationError(errors);
  }
  const repo = new SignalRepository(db);
  const batchId = `file_${randomUUID().slice(0, 8)}`;
  const res = repo.insertBatch(batchId, signals, clock.now());
  const report: ImportReport = {
    batchId,
    inserted: res.inserted,
    duplicates: res.duplicates,
    terminals: 0,
    sectors: 0,
    configs: 0,
    clocks: 0,
  };
  if (recompute) report.analysis = runAnalysis(db, clock);
  return report;
}

const VALID_SOURCES = new Set(["UE", "ENB", "OMC"]);
const VALID_TYPES = new Set([
  "MEAS_REPORT", "HO_COMMAND", "HO_ACK", "REESTABLISH_REQ", "RLF_IND",
  "CONN_RELEASE", "CELL_LOAD", "CONFIG_ACTIVATE", "CLOCK_SYNC",
]);

export function validateSignal(obj: RawSignalInput, line: number, errors: { line: number; error: string }[]): void {
  if (typeof obj !== "object" || obj === null) {
    errors.push({ line, error: "not an object" });
    return;
  }
  if (!VALID_SOURCES.has(obj.source)) errors.push({ line, error: `source must be one of UE/ENB/OMC, got ${String(obj.source)}` });
  if (!VALID_TYPES.has(obj.eventType)) errors.push({ line, error: `invalid eventType ${String(obj.eventType)}` });
  if (typeof obj.sourceSeq !== "number" || !Number.isInteger(obj.sourceSeq) || obj.sourceSeq < 0)
    errors.push({ line, error: "sourceSeq must be a non-negative integer" });
  if (typeof obj.eventTimeMs !== "number" || !Number.isFinite(obj.eventTimeMs))
    errors.push({ line, error: "eventTimeMs must be a finite number" });
  if (obj.payload === undefined || typeof obj.payload !== "object")
    errors.push({ line, error: "payload must be an object" });
}

export class ImportValidationError extends Error {
  constructor(public readonly errors: { line: number; error: string }[]) {
    super(`import validation failed:\n${errors.map((e) => `  line ${e.line}: ${e.error}`).join("\n")}`);
    this.name = "ImportValidationError";
  }
}
