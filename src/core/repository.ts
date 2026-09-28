import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RawSignalInput } from "./types.js";

export function canonicalHash(input: RawSignalInput): string {
  const basis = {
    source: input.source,
    sourceSeq: input.sourceSeq,
    eventType: input.eventType,
    terminalId: input.terminalId ?? null,
    sectorId: input.sectorId ?? null,
    targetSectorId: input.targetSectorId ?? null,
    configVersionId: input.configVersionId ?? null,
    eventTimeMs: input.eventTimeMs,
    payload: input.payload,
  };
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 32);
}

export interface InsertSignalResult {
  eventId: number | null;
  duplicate: boolean;
}

export class SignalRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertTerminal(terminalId: string, pseudonym: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO terminals(terminal_id, pseudonym, registered_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(terminal_id) DO NOTHING`,
      )
      .run(terminalId, pseudonym, nowMs);
  }

  upsertSector(sector: {
    sectorId: string;
    siteId: string;
    pci: number;
    earfcn: number;
    maxErlangs?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sectors(sector_id, site_id, pci, earfcn, max_erlangs)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sector_id) DO UPDATE SET
           site_id = excluded.site_id,
           pci = excluded.pci,
           earfcn = excluded.earfcn,
           max_erlangs = excluded.max_erlangs`,
      )
      .run(
        sector.sectorId,
        sector.siteId,
        sector.pci,
        sector.earfcn,
        sector.maxErlangs ?? 50,
      );
  }

  upsertConfigVersion(cv: {
    configVersionId: string;
    sectorId: string;
    version: number;
    effectiveAtMs: number;
    importedAtMs: number;
    neighbors: string[];
  }): boolean {
    const existing = this.db
      .prepare("SELECT 1 FROM nbr_config_versions WHERE config_version_id = ?")
      .get(cv.configVersionId);
    if (existing) return false;
    const tx = this.db.prepare(
      `INSERT INTO nbr_config_versions(config_version_id, sector_id, version, effective_at_ms, imported_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insEntry = this.db.prepare(
      `INSERT INTO nbr_entries(config_version_id, neighbor_sector_id) VALUES (?, ?)
       ON CONFLICT(config_version_id, neighbor_sector_id) DO NOTHING`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      tx.run(cv.configVersionId, cv.sectorId, cv.version, cv.effectiveAtMs, cv.importedAtMs);
      for (const n of cv.neighbors) insEntry.run(cv.configVersionId, n);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  addClockCalibration(c: {
    sectorId: string;
    validFromMs: number;
    offsetMs: number;
    confidence?: number;
    createdAtMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO clock_calibrations(sector_id, valid_from_ms, offset_ms, confidence, created_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sector_id, valid_from_ms) DO UPDATE SET
           offset_ms = excluded.offset_ms,
           confidence = excluded.confidence,
           created_at_ms = excluded.created_at_ms`,
      )
      .run(c.sectorId, c.validFromMs, c.offsetMs, c.confidence ?? 1, c.createdAtMs);
  }

  // Returns sector offset valid at a given sector-reported time.
  offsetFor(sectorId: string, atEventMs: number): number {
    const row = this.db
      .prepare(
        `SELECT offset_ms FROM clock_calibrations
         WHERE sector_id = ? AND valid_from_ms <= ?
         ORDER BY valid_from_ms DESC LIMIT 1`,
      )
      .get(sectorId, atEventMs) as { offset_ms: number } | undefined;
    return row?.offset_ms ?? 0;
  }

  // Insert a batch atomically. Duplicates are skipped, never raise.
  insertBatch(
    batchId: string,
    signals: RawSignalInput[],
    nowMs: number,
  ): { inserted: number; duplicates: number; eventIds: number[] } {
    const stmt = this.db.prepare(
      `INSERT INTO signaling_events(
         source, source_seq, event_type, terminal_id, sector_id, target_sector_id,
         config_version_id, event_time_ms, received_at_ms, ref_time_ms,
         payload_json, dedup_hash, import_batch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    );
    let inserted = 0;
    let duplicates = 0;
    const eventIds: number[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of signals) {
        const hash = canonicalHash(s);
        try {
          const info = stmt.run(
            s.source,
            s.sourceSeq,
            s.eventType,
            s.terminalId ?? null,
            s.sectorId ?? null,
            s.targetSectorId ?? null,
            s.configVersionId ?? null,
            s.eventTimeMs,
            s.receivedAtMs ?? nowMs,
            JSON.stringify(s.payload),
            hash,
            batchId,
          );
          inserted++;
          eventIds.push(Number(info.lastInsertRowid));
        } catch (err) {
          if (isUniqueError(err)) {
            duplicates++;
          } else {
            throw err;
          }
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { inserted, duplicates, eventIds };
  }

  maxEventId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(event_id), 0) AS m FROM signaling_events").get() as { m: number };
    return row.m;
  }
}

export function isUniqueError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; errcode?: number; message?: string };
  if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  // node:sqlite surfaces errcode 2067 (SQLITE_CONSTRAINT_UNIQUE).
  if (e.errcode === 2067) return true;
  return /UNIQUE constraint failed/i.test(e.message ?? "");
}
