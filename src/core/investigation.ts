import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SignalRepository } from "./repository.js";
import { recompute } from "./timeline.js";
import { analyzeDrops, type Finding } from "./rca.js";
import type { Clock } from "./clock.js";

export interface AnalysisRun {
  rerunToken: string;
  maxEventId: number;
  recomputed: {
    terminals: number;
    states: number;
    handovers: number;
    drops: number;
  };
  findings: Finding[];
}

// Runs calibration + timeline reconstruction + RCA as one unit of work.
export function runAnalysis(db: DatabaseSync, clock: Clock): AnalysisRun {
  const rerunToken = `rerun_${clock.now()}_${randomUUID().slice(0, 8)}`;
  const result = recompute(db, rerunToken);
  const findings = analyzeDrops(db, rerunToken);
  return {
    rerunToken,
    maxEventId: new SignalRepository(db).maxEventId(),
    recomputed: {
      terminals: result.terminals,
      states: result.states,
      handovers: result.handovers.length,
      drops: result.drops.length,
    },
    findings,
  };
}

export interface Investigation {
  investigationId: string;
  status: "DRAFT" | "PUBLISHED";
  createdAtMs: number;
  publishedAtMs: number | null;
  maxEventId: number;
  findings: Finding[];
}

export class InvestigationService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  // Draft captures a snapshot of the current analysis. It can be recomputed.
  createDraft(run?: AnalysisRun): Investigation {
    const analysis = run ?? runAnalysis(this.db, this.clock);
    const id = `inv_${randomUUID().slice(0, 12)}`;
    const now = this.clock.now();
    const snapshot = JSON.stringify({
      rerunToken: analysis.rerunToken,
      maxEventId: analysis.maxEventId,
      recomputed: analysis.recomputed,
    });
    this.db
      .prepare(
        `INSERT INTO investigations(investigation_id, status, created_at_ms, snapshot_json, max_event_id)
         VALUES (?, 'DRAFT', ?, ?, ?)`,
      )
      .run(id, now, snapshot, analysis.maxEventId);
    this.replaceFindings(id, analysis.findings);
    return this.get(id)!;
  }

  // Publication freezes the report. Later config changes / late events trigger
  // recompute of *new* drafts but never mutate a published report.
  publish(investigationId: string): Investigation {
    const inv = this.get(investigationId);
    if (!inv) throw new InvestigationError("NOT_FOUND", `investigation ${investigationId} not found`);
    if (inv.status === "PUBLISHED") return inv;
    const report = JSON.stringify(inv.findings);
    this.db
      .prepare(
        `UPDATE investigations SET status = 'PUBLISHED', published_at_ms = ?, report_json = ?
         WHERE investigation_id = ?`,
      )
      .run(this.clock.now(), report, investigationId);
    return this.get(investigationId)!;
  }

  get(investigationId: string): Investigation | null {
    const row = this.db
      .prepare("SELECT * FROM investigations WHERE investigation_id = ?")
      .get(investigationId) as
      | {
          investigation_id: string;
          status: "DRAFT" | "PUBLISHED";
          created_at_ms: number;
          published_at_ms: number | null;
          snapshot_json: string;
          max_event_id: number;
        }
      | undefined;
    if (!row) return null;
    const findings = this.db
      .prepare("SELECT * FROM investigation_findings WHERE investigation_id = ? ORDER BY id")
      .all(investigationId) as unknown as FindingRow[];
    return {
      investigationId: row.investigation_id,
      status: row.status,
      createdAtMs: row.created_at_ms,
      publishedAtMs: row.published_at_ms,
      maxEventId: row.max_event_id,
      findings: findings.map(rowToFinding),
    };
  }

  list(limit: number, offset: number): { items: Investigation[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM investigations").get() as { c: number }).c;
    const rows = this.db
      .prepare("SELECT investigation_id FROM investigations ORDER BY created_at_ms DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as { investigation_id: string }[];
    return { items: rows.map((r) => this.get(r.investigation_id)!), total };
  }

  private replaceFindings(investigationId: string, findings: Finding[]): void {
    const del = this.db.prepare("DELETE FROM investigation_findings WHERE investigation_id = ?");
    const ins = this.db.prepare(
      `INSERT INTO investigation_findings(
         investigation_id, drop_id, terminal_id, category, verdict, confidence,
         evidence_json, counter_evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      del.run(investigationId);
      for (const f of findings) {
        ins.run(
          investigationId,
          f.dropId,
          f.terminalId,
          f.category,
          f.verdict,
          f.confidence,
          JSON.stringify(f.evidence),
          JSON.stringify(f.counterEvidence),
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

interface FindingRow {
  drop_id: number;
  terminal_id: string;
  category: Finding["category"];
  verdict: string;
  confidence: number;
  evidence_json: string;
  counter_evidence_json: string;
}

function rowToFinding(r: FindingRow): Finding {
  return {
    dropId: r.drop_id,
    terminalId: r.terminal_id,
    category: r.category,
    verdict: r.verdict,
    confidence: r.confidence,
    evidence: JSON.parse(r.evidence_json) as Finding["evidence"],
    counterEvidence: JSON.parse(r.counter_evidence_json) as Finding["counterEvidence"],
  };
}

export class InvestigationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvestigationError";
  }
}
