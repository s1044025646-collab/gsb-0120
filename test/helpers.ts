import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db/database.js";
import { SignalRepository } from "../src/core/repository.js";
import { runAnalysis } from "../src/core/investigation.js";
import { fakeClock, type Clock } from "../src/core/clock.js";
import type { RawSignalInput } from "../src/core/types.js";

export interface Harness {
  db: DatabaseSync;
  clock: ReturnType<typeof fakeClock>;
  repo: SignalRepository;
  seq: Record<string, number>;
  seedSectors(): void;
  import(signals: RawSignalInput[], batch?: string): { inserted: number; duplicates: number };
  analyze(): ReturnType<typeof runAnalysis>;
}

export function makeHarness(startMs = 1_000_000): Harness {
  const db = openDatabase(":memory:");
  const clock = fakeClock(startMs);
  const repo = new SignalRepository(db);
  const seq: Record<string, number> = { UE: 0, ENB: 0, OMC: 0 };

  const h: Harness = {
    db,
    clock,
    repo,
    seq,
    seedSectors() {
      repo.upsertTerminal("ue1", "anon-ue1", clock.now());
      repo.upsertTerminal("ue2", "anon-ue2", clock.now());
      for (const [id, site, pci, earfcn] of [
        ["secA", "site1", 101, 1800],
        ["secB", "site2", 202, 1800],
        ["secC", "site3", 303, 2100],
      ] as const) {
        repo.upsertSector({ sectorId: id, siteId: site, pci, earfcn });
      }
    },
    import(signals, batch) {
      clock.advance(1);
      const b = batch ?? `batch_${clock.now()}`;
      const res = repo.insertBatch(b, signals, clock.now());
      return { inserted: res.inserted, duplicates: res.duplicates };
    },
    analyze() {
      return runAnalysis(db, clock as Clock);
    },
  };
  return h;
}

let counter = 0;
export function sig(partial: Partial<RawSignalInput> & Pick<RawSignalInput, "eventType" | "eventTimeMs">): RawSignalInput {
  counter++;
  const source = partial.source ?? (partial.eventType === "HO_COMMAND" || partial.eventType === "CELL_LOAD" || partial.eventType === "CONFIG_ACTIVATE" ? "ENB" : "UE");
  return {
    source,
    sourceSeq: partial.sourceSeq ?? counter,
    eventType: partial.eventType,
    terminalId: partial.terminalId ?? "ue1",
    sectorId: partial.sectorId,
    targetSectorId: partial.targetSectorId,
    configVersionId: partial.configVersionId,
    eventTimeMs: partial.eventTimeMs,
    payload: partial.payload ?? {},
  };
}

export function meas(t: number, serving: string, servingRsrp: number, cells: { sectorId: string; rsrp: number }[]): RawSignalInput {
  return sig({ eventType: "MEAS_REPORT", eventTimeMs: t, sectorId: serving, payload: { servingSectorId: serving, servingRsrp, cells } });
}
export function hoCmd(t: number, from: string, to: string): RawSignalInput {
  return sig({ eventType: "HO_COMMAND", eventTimeMs: t, sectorId: from, targetSectorId: to, source: "ENB" });
}
export function hoAck(t: number, sector: string): RawSignalInput {
  return sig({ eventType: "HO_ACK", eventTimeMs: t, sectorId: sector, payload: { servingSectorId: sector } });
}
export function rlf(t: number, sector: string): RawSignalInput {
  return sig({ eventType: "RLF_IND", eventTimeMs: t, sectorId: sector, payload: { servingSectorId: sector } });
}
export function reest(t: number, sector: string): RawSignalInput {
  return sig({ eventType: "REESTABLISH_REQ", eventTimeMs: t, sectorId: sector, payload: { servingSectorId: sector } });
}
export function release(t: number, sector: string): RawSignalInput {
  return sig({ eventType: "CONN_RELEASE", eventTimeMs: t, sectorId: sector });
}
