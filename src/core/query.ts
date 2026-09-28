import type { DatabaseSync } from "node:sqlite";
import type { Page } from "./types.js";

export interface PageQuery {
  limit?: unknown;
  offset?: unknown;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function normalizePagination(q: PageQuery): { limit: number; offset: number; error?: string } {
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1) return { limit, offset, error: "limit must be a positive integer" };
    limit = Math.min(n, MAX_LIMIT);
  }
  if (q.offset !== undefined) {
    const n = Number(q.offset);
    if (!Number.isInteger(n) || n < 0) return { limit, offset, error: "offset must be a non-negative integer" };
    offset = n;
  }
  return { limit, offset };
}

interface EventListFilter {
  terminalId?: string;
  sectorId?: string;
  eventType?: string;
}

export class QueryService {
  constructor(private readonly db: DatabaseSync) {}

  listEvents(q: PageQuery & EventListFilter): Page<Record<string, unknown>> | { error: string } {
    const pg = normalizePagination(q);
    if (pg.error) return { error: pg.error };
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.terminalId) { where.push("terminal_id = ?"); params.push(q.terminalId); }
    if (q.sectorId) { where.push("(sector_id = ? OR target_sector_id = ?)"); params.push(q.sectorId, q.sectorId); }
    if (q.eventType) { where.push("event_type = ?"); params.push(q.eventType); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM signaling_events ${clause}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT * FROM signaling_events ${clause} ORDER BY ref_time_ms, event_id LIMIT ? OFFSET ?`)
      .all(...params, pg.limit, pg.offset) as Record<string, unknown>[];
    return { items: rows.map(deserialize), total, limit: pg.limit, offset: pg.offset };
  }

  timeline(terminalId: string, q: PageQuery = {}): Page<Record<string, unknown>> | { error: string } {
    const pg = normalizePagination(q);
    if (pg.error) return { error: pg.error };
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM timeline_states WHERE terminal_id = ?").get(terminalId) as { c: number }).c;
    const rows = this.db
      .prepare("SELECT * FROM timeline_states WHERE terminal_id = ? ORDER BY begin_ref_ms LIMIT ? OFFSET ?")
      .all(terminalId, pg.limit, pg.offset) as Record<string, unknown>[];
    return { items: rows, total, limit: pg.limit, offset: pg.offset };
  }

  listHandovers(q: PageQuery & { terminalId?: string; classification?: string } = {}): Page<Record<string, unknown>> | { error: string } {
    const pg = normalizePagination(q);
    if (pg.error) return { error: pg.error };
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.terminalId) { where.push("terminal_id = ?"); params.push(q.terminalId); }
    if (q.classification) { where.push("classification = ?"); params.push(q.classification); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM handovers ${clause}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT * FROM handovers ${clause} ORDER BY cmd_ref_ms LIMIT ? OFFSET ?`)
      .all(...params, pg.limit, pg.offset) as Record<string, unknown>[];
    return { items: rows, total, limit: pg.limit, offset: pg.offset };
  }

  listDrops(q: PageQuery & { terminalId?: string } = {}): Page<Record<string, unknown>> | { error: string } {
    const pg = normalizePagination(q);
    if (pg.error) return { error: pg.error };
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.terminalId) { where.push("terminal_id = ?"); params.push(q.terminalId); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM drops ${clause}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT * FROM drops ${clause} ORDER BY detected_ref_ms LIMIT ? OFFSET ?`)
      .all(...params, pg.limit, pg.offset) as Record<string, unknown>[];
    return { items: rows, total, limit: pg.limit, offset: pg.offset };
  }
}

function deserialize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    payload: row.payload_json ? JSON.parse(row.payload_json as string) : undefined,
  };
}

