import { createHash } from "crypto";
import { DB } from "./db";
import { Clock, systemClock } from "./clock";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export const EVENT_TYPES = [
  "measurement_report",
  "handover_command",
  "handover_receipt",
  "signal_strength",
  "drop",
  "cell_load",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventInput {
  terminalId: number;
  type: EventType;
  cellId?: number | null;
  targetCellId?: number | null;
  payload?: Record<string, unknown>;
  deviceTime: number;
  source: string;
}

export class Service {
  constructor(
    private db: DB,
    private clock: Clock = systemClock
  ) {}

  // --- entity creation -------------------------------------------------
  createTerminal(anonId: string) {
    try {
      const r = this.db
        .prepare("INSERT INTO terminals (anon_id, created_at) VALUES (?, ?)")
        .run(anonId, this.clock.now());
      return { id: Number(r.lastInsertRowid), anonId };
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE"))
        throw new ApiError("CONFLICT", `terminal ${anonId} already exists`, 409);
      throw e;
    }
  }

  createCell(name: string, tech = "LTE") {
    try {
      const r = this.db
        .prepare("INSERT INTO cells (name, tech, created_at) VALUES (?, ?, ?)")
        .run(name, tech, this.clock.now());
      return { id: Number(r.lastInsertRowid), name, tech };
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE"))
        throw new ApiError("CONFLICT", `cell ${name} already exists`, 409);
      throw e;
    }
  }

  createConfigVersion(
    version: number,
    entries: { sourceCellId: number; targetCellId: number; priority?: number }[],
    note = ""
  ) {
    const tx = this.db.transaction(() => {
      let versionId: number;
      try {
        const r = this.db
          .prepare("INSERT INTO neighbor_config_versions (version, note, created_at) VALUES (?, ?, ?)")
          .run(version, note, this.clock.now());
        versionId = Number(r.lastInsertRowid);
      } catch (e: any) {
        if (String(e.message).includes("UNIQUE"))
          throw new ApiError("CONFLICT", `config version ${version} already exists`, 409);
        throw e;
      }
      const ins = this.db.prepare(
        "INSERT INTO neighbor_config_entries (version_id, source_cell_id, target_cell_id, priority) VALUES (?, ?, ?, ?)"
      );
      for (const e of entries) {
        this.requireCell(e.sourceCellId);
        this.requireCell(e.targetCellId);
        ins.run(versionId, e.sourceCellId, e.targetCellId, e.priority ?? 0);
      }
      return versionId;
    });
    return { id: tx(), version };
  }

  activateConfig(cellId: number, versionId: number, effectiveFrom: number) {
    this.requireCell(cellId);
    const v = this.db
      .prepare("SELECT id FROM neighbor_config_versions WHERE id = ?")
      .get(versionId);
    if (!v) throw new ApiError("NOT_FOUND", `config version ${versionId} not found`, 404);
    this.db
      .prepare(
        "INSERT INTO config_activations (cell_id, version_id, effective_from, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(cellId, versionId, effectiveFrom, this.clock.now());
    return { ok: true };
  }

  addClockCalibration(cellId: number, offsetMs: number, effectiveFrom: number) {
    this.requireCell(cellId);
    this.db
      .prepare(
        "INSERT INTO clock_calibrations (cell_id, offset_ms, effective_from, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(cellId, offsetMs, effectiveFrom, this.clock.now());
    return { ok: true };
  }

  // --- events ------------------------------------------------------------
  /** Clock offset (ms) of a cell at a given device time; latest calibration wins. */
  clockOffsetAt(cellId: number | null | undefined, deviceTime: number): number {
    if (!cellId) return 0;
    const row = this.db
      .prepare(
        `SELECT offset_ms FROM clock_calibrations
         WHERE cell_id = ? AND effective_from <= ?
         ORDER BY effective_from DESC, id DESC LIMIT 1`
      )
      .get(cellId, deviceTime) as { offset_ms: number } | undefined;
    return row ? row.offset_ms : 0;
  }

  /** Import a batch of events in one transaction. Duplicates are skipped, not errors. */
  importEvents(inputs: EventInput[]) {
    const inserted: number[] = [];
    const duplicates: number[] = [];
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT INTO events
           (terminal_id, type, cell_id, target_cell_id, payload, device_time, corrected_time, source, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      inputs.forEach((e, idx) => {
        this.validateEvent(e);
        const offset = this.clockOffsetAt(e.cellId ?? null, e.deviceTime);
        const corrected = e.deviceTime - offset;
        const key = dedupeKey(e);
        try {
          const r = stmt.run(
            e.terminalId,
            e.type,
            e.cellId ?? null,
            e.targetCellId ?? null,
            JSON.stringify(e.payload ?? {}),
            e.deviceTime,
            corrected,
            e.source,
            key,
            this.clock.now()
          );
          inserted.push(Number(r.lastInsertRowid));
        } catch (err: any) {
          if (String(err.message).includes("UNIQUE")) duplicates.push(idx);
          else throw err;
        }
      });
    });
    tx();
    return { inserted: inserted.length, duplicates: duplicates.length, ids: inserted };
  }

  private validateEvent(e: EventInput) {
    if (!EVENT_TYPES.includes(e.type))
      throw new ApiError("VALIDATION_ERROR", `unknown event type ${e.type}`);
    if (!Number.isInteger(e.terminalId)) throw new ApiError("VALIDATION_ERROR", "terminalId required");
    this.requireTerminal(e.terminalId);
    if (e.cellId != null) this.requireCell(e.cellId);
    if (e.targetCellId != null) this.requireCell(e.targetCellId);
    if (!Number.isFinite(e.deviceTime)) throw new ApiError("VALIDATION_ERROR", "deviceTime required");
    if (!e.source) throw new ApiError("VALIDATION_ERROR", "source required");
  }

  private requireTerminal(id: number) {
    if (!this.db.prepare("SELECT id FROM terminals WHERE id = ?").get(id))
      throw new ApiError("NOT_FOUND", `terminal ${id} not found`, 404);
  }
  private requireCell(id: number) {
    if (!this.db.prepare("SELECT id FROM cells WHERE id = ?").get(id))
      throw new ApiError("NOT_FOUND", `cell ${id} not found`, 404);
  }

  // --- queries -----------------------------------------------------------
  listEvents(filter: { terminalId?: number; cursor?: number; limit?: number }) {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const cursor = filter.cursor ?? 0;
    const rows = (
      filter.terminalId != null
        ? this.db
            .prepare(
              "SELECT * FROM events WHERE terminal_id = ? AND id > ? ORDER BY id LIMIT ?"
            )
            .all(filter.terminalId, cursor, limit + 1)
        : this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(cursor, limit + 1)
    ) as any[];
    const page = rows.slice(0, limit);
    return {
      items: page,
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  eventsForTerminal(terminalId: number): any[] {
    // Reconstruction order: corrected time, then arrival order as tiebreak.
    return this.db
      .prepare("SELECT * FROM events WHERE terminal_id = ? ORDER BY corrected_time, id")
      .all(terminalId) as any[];
  }

  configForCellAt(cellId: number, time: number): { versionId: number; entries: Set<string> } {
    const act = this.db
      .prepare(
        `SELECT version_id FROM config_activations
         WHERE cell_id = ? AND effective_from <= ?
         ORDER BY effective_from DESC, id DESC LIMIT 1`
      )
      .get(cellId, time) as { version_id: number } | undefined;
    if (!act) return { versionId: 0, entries: new Set() };
    const rows = this.db
      .prepare("SELECT source_cell_id, target_cell_id FROM neighbor_config_entries WHERE version_id = ?")
      .all(act.version_id) as { source_cell_id: number; target_cell_id: number }[];
    return {
      versionId: act.version_id,
      entries: new Set(rows.map((r) => `${r.source_cell_id}->${r.target_cell_id}`)),
    };
  }

  compareConfigVersions(a: number, b: number) {
    const load = (v: number) => {
      const rows = this.db
        .prepare(
          `SELECT e.source_cell_id, e.target_cell_id FROM neighbor_config_entries e
           JOIN neighbor_config_versions v ON v.id = e.version_id WHERE v.version = ?`
        )
        .all(v) as { source_cell_id: number; target_cell_id: number }[];
      return new Set(rows.map((r) => `${r.source_cell_id}->${r.target_cell_id}`));
    };
    const sa = load(a);
    const sb = load(b);
    return {
      added: [...sb].filter((x) => !sa.has(x)),
      removed: [...sa].filter((x) => !sb.has(x)),
    };
  }

  inputHashForTerminal(terminalId: number): string {
    const h = createHash("sha256");
    const rows = this.db
      .prepare(
        "SELECT id, type, cell_id, target_cell_id, device_time, corrected_time, payload FROM events WHERE terminal_id = ? ORDER BY corrected_time, id"
      )
      .all(terminalId);
    h.update(JSON.stringify(rows));
    const cfg = this.db
      .prepare("SELECT * FROM config_activations ORDER BY cell_id, effective_from, id")
      .all();
    h.update(JSON.stringify(cfg));
    const ent = this.db.prepare("SELECT * FROM neighbor_config_entries ORDER BY id").all();
    h.update(JSON.stringify(ent));
    return h.digest("hex");
  }
}

export function dedupeKey(e: EventInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        e.terminalId,
        e.type,
        e.cellId ?? null,
        e.targetCellId ?? null,
        e.deviceTime,
        e.source,
        e.payload ?? {},
      ])
    )
    .digest("hex");
}
