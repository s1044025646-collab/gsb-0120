import { DB } from "./db";
import { Service } from "./service";
import { Clock, systemClock } from "./clock";
import { WEAK_RSRP_DBM } from "./timeline";

const LOOKBACK_MS = 10000;
const CONGESTION_LOAD = 0.85;

export interface EvidenceItem {
  kind: string;
  detail: string;
  eventId?: number;
}

export interface CauseAssessment {
  cause: "weak_coverage" | "neighbor_missing" | "congestion";
  evidence: EvidenceItem[];
  counterEvidence: EvidenceItem[];
  score: number;
}

export interface AnalysisResult {
  dropId: number;
  rootCause: string;
  assessments: CauseAssessment[];
  inputHash: string;
}

/**
 * Assess a drop against all candidate causes. Every cause reports both
 * supporting evidence and counter-evidence; the root cause is the cause with
 * the highest net score, never just the latest event.
 */
export function analyzeDrop(db: DB, svc: Service, dropId: number): AnalysisResult {
  const drop = db.prepare("SELECT * FROM drops WHERE id = ?").get(dropId) as any;
  if (!drop) throw Object.assign(new Error(`drop ${dropId} not found`), { code: "NOT_FOUND" });
  const t0 = drop.detected_at - LOOKBACK_MS;
  const events = db
    .prepare(
      `SELECT * FROM events WHERE terminal_id = ? AND corrected_time BETWEEN ? AND ?
       ORDER BY corrected_time, id`
    )
    .all(drop.terminal_id, t0, drop.detected_at) as any[];

  const weak: CauseAssessment = { cause: "weak_coverage", evidence: [], counterEvidence: [], score: 0 };
  const missing: CauseAssessment = { cause: "neighbor_missing", evidence: [], counterEvidence: [], score: 0 };
  const congestion: CauseAssessment = { cause: "congestion", evidence: [], counterEvidence: [], score: 0 };

  const serving = drop.cell_id;
  for (const ev of events) {
    const p = JSON.parse(ev.payload || "{}");
    if (ev.type === "signal_strength" || ev.type === "measurement_report") {
      if (ev.cell_id === serving && typeof p.rsrp === "number") {
        const item = {
          kind: "rsrp",
          detail: `serving cell ${serving} rsrp ${p.rsrp} dBm (threshold ${WEAK_RSRP_DBM})`,
          eventId: ev.id as number,
        };
        if (p.rsrp <= WEAK_RSRP_DBM) weak.evidence.push(item);
        else weak.counterEvidence.push(item);
      }
      if (ev.type === "measurement_report" && Array.isArray(p.neighbors) && serving != null) {
        const cfg = svc.configForCellAt(serving, ev.corrected_time);
        for (const n of p.neighbors as { cellId: number; rsrp: number }[]) {
          if (typeof n.rsrp !== "number" || n.rsrp <= WEAK_RSRP_DBM) continue;
          const configured = cfg.entries.has(`${serving}->${n.cellId}`);
          const item = {
            kind: "neighbor",
            detail: `strong neighbor ${n.cellId} (rsrp ${n.rsrp}) ${
              configured ? "was" : "was NOT"
            } in config v${cfg.versionId || "none"} for cell ${serving}`,
            eventId: ev.id as number,
          };
          if (configured) missing.counterEvidence.push(item);
          else missing.evidence.push(item);
        }
      }
    }
    if (ev.type === "cell_load" && typeof p.load === "number") {
      const item = { kind: "load", detail: `cell ${ev.cell_id} load ${p.load}`, eventId: ev.id as number };
      if (p.load >= CONGESTION_LOAD) congestion.evidence.push(item);
      else congestion.counterEvidence.push(item);
    }
  }

  for (const a of [weak, missing, congestion]) a.score = a.evidence.length - a.counterEvidence.length;
  const best = [weak, missing, congestion]
    .filter((a) => a.evidence.length > 0)
    .sort((a, b) => b.score - a.score)[0];
  const rootCause = best && best.score > 0 ? best.cause : "unknown";
  return {
    dropId,
    rootCause,
    assessments: [weak, missing, congestion],
    inputHash: svc.inputHashForTerminal(drop.terminal_id),
  };
}

/** Create (or refresh a draft of) the investigation for a drop. */
export function investigate(
  db: DB,
  svc: Service,
  dropId: number,
  batchId: number | null = null,
  clock: Clock = systemClock
) {
  const result = analyzeDrop(db, svc, dropId);
  const tx = db.transaction(() => {
    const existing = db
      .prepare("SELECT id, status FROM investigations WHERE drop_id = ? ORDER BY id DESC LIMIT 1")
      .get(dropId) as any;
    if (existing && existing.status === "published") return existing.id as number;
    const evidence = JSON.stringify(
      result.assessments.flatMap((a) => a.evidence.map((e) => ({ cause: a.cause, ...e })))
    );
    const counter = JSON.stringify(
      result.assessments.flatMap((a) => a.counterEvidence.map((e) => ({ cause: a.cause, ...e })))
    );
    if (existing) {
      db.prepare(
        `UPDATE investigations SET root_cause = ?, evidence = ?, counter_evidence = ?, input_hash = ?, batch_id = ? WHERE id = ?`
      ).run(result.rootCause, evidence, counter, result.inputHash, batchId, existing.id);
      return existing.id as number;
    }
    const r = db
      .prepare(
        `INSERT INTO investigations (drop_id, batch_id, status, root_cause, evidence, counter_evidence, input_hash, created_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`
      )
      .run(dropId, batchId, result.rootCause, evidence, counter, result.inputHash, clock.now());
    return Number(r.lastInsertRowid);
  });
  const id = tx();
  return { id, ...result };
}

export function publishInvestigation(db: DB, id: number, clock: Clock = systemClock) {
  const r = db
    .prepare("UPDATE investigations SET status = 'published', published_at = ? WHERE id = ? AND status = 'draft'")
    .run(clock.now(), id);
  if (r.changes === 0) {
    const row = db.prepare("SELECT status FROM investigations WHERE id = ?").get(id);
    if (!row) throw Object.assign(new Error(`investigation ${id} not found`), { code: "NOT_FOUND" });
    throw Object.assign(new Error(`investigation ${id} already published`), { code: "CONFLICT" });
  }
  return { id, status: "published" };
}

export function getInvestigation(db: DB, id: number) {
  const row = db.prepare("SELECT * FROM investigations WHERE id = ?").get(id) as any;
  if (!row) throw Object.assign(new Error(`investigation ${id} not found`), { code: "NOT_FOUND" });
  return {
    ...row,
    evidence: JSON.parse(row.evidence),
    counter_evidence: JSON.parse(row.counter_evidence),
  };
}
