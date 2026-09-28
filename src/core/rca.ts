import type { DatabaseSync } from "node:sqlite";
import { payload, type EventRow } from "./timeline.js";
import type { RcaCategory } from "./types.js";

export interface EvidenceItem {
  eventId: number;
  refMs: number;
  detail: string;
}

export interface Finding {
  dropId: number;
  terminalId: string;
  category: RcaCategory;
  verdict: string;
  confidence: number;
  evidence: EvidenceItem[];
  counterEvidence: EvidenceItem[];
}

const WEAK_RSRP_DBM = -110;
const CONGESTED_LOAD = 0.85;
const SKEW_GUARD_MS = 2000;
const WINDOW_BEFORE_MS = 10_000;
const WINDOW_AFTER_MS = 3_000;

interface DropRow {
  id: number;
  terminal_id: string;
  sector_id: string;
  detected_ref_ms: number;
  last_event_id: number;
}

// Config version effective for a sector at a given reference time.
function activeConfig(
  db: DatabaseSync,
  sectorId: string,
  refMs: number,
): { configVersionId: string; version: number; neighbors: string[] } | null {
  const cv = db
    .prepare(
      `SELECT config_version_id, version FROM nbr_config_versions
       WHERE sector_id = ? AND effective_at_ms <= ?
       ORDER BY effective_at_ms DESC LIMIT 1`,
    )
    .get(sectorId, refMs) as { config_version_id: string; version: number } | undefined;
  if (!cv) return null;
  const rows = db
    .prepare("SELECT neighbor_sector_id FROM nbr_entries WHERE config_version_id = ? ORDER BY neighbor_sector_id")
    .all(cv.config_version_id) as { neighbor_sector_id: string }[];
  return { configVersionId: cv.config_version_id, version: cv.version, neighbors: rows.map((r) => r.neighbor_sector_id) };
}

function eventsForTerminal(db: DatabaseSync, terminalId: string): EventRow[] {
  return db
    .prepare("SELECT * FROM signaling_events WHERE terminal_id = ? ORDER BY ref_time_ms, event_id")
    .all(terminalId) as unknown as EventRow[];
}

// Evaluate every hypothesis independently with supporting and contradicting
// evidence, then combine. Never concludes from a single last event.
export function analyzeDrops(db: DatabaseSync, rerunToken: string): Finding[] {
  const drops = db
    .prepare("SELECT * FROM drops WHERE rerun_token = ?")
    .all(rerunToken) as unknown as DropRow[];
  const findings: Finding[] = [];

  for (const drop of drops) {
    // Evaluate neighbor configuration against the sector the UE was served by
    // just before failure (a drop after HO may be recorded on the target).
    const sourceState = db
      .prepare(
        `SELECT sector_id FROM timeline_states
         WHERE terminal_id = ? AND begin_ref_ms <= ? AND state = 'CAMPED' AND sector_id IS NOT NULL
         ORDER BY begin_ref_ms DESC, id DESC LIMIT 1`,
      )
      .get(drop.terminal_id, drop.detected_ref_ms) as { sector_id: string | null } | undefined;
    const sourceSector = sourceState?.sector_id ?? drop.sector_id;
    const all = eventsForTerminal(db, drop.terminal_id);
    const before = all.filter(
      (e) => (e.ref_time_ms ?? e.event_time_ms) <= drop.detected_ref_ms &&
             (e.ref_time_ms ?? e.event_time_ms) >= drop.detected_ref_ms - WINDOW_BEFORE_MS,
    );
    const after = all.filter(
      (e) => (e.ref_time_ms ?? e.event_time_ms) > drop.detected_ref_ms &&
             (e.ref_time_ms ?? e.event_time_ms) <= drop.detected_ref_ms + WINDOW_AFTER_MS,
    );
    const window = [...before, ...after];

    const hypotheses: {
      category: RcaCategory;
      verdict: string;
      score: number;
      evidence: EvidenceItem[];
      counter: EvidenceItem[];
    }[] = [];

    // H1: missing neighbor relation at the active config version
    const cfg = activeConfig(db, sourceSector, drop.detected_ref_ms);
    const meas = window.filter((e) => e.event_type === "MEAS_REPORT");
    const seenNeighbors = new Set<string>();
    const strongOther: { sector: string; rsrp: number; eventId: number; refMs: number }[] = [];
    for (const m of meas) {
      const p = payload(m);
      const cells = (p.cells as { sectorId?: string; rsrp?: number }[] | undefined) ?? [];
      for (const c of cells) {
        if (!c.sectorId || c.sectorId === drop.sector_id) continue;
        seenNeighbors.add(c.sectorId);
        if (typeof c.rsrp === "number" && c.rsrp > WEAK_RSRP_DBM) {
          strongOther.push({ sector: c.sectorId, rsrp: c.rsrp, eventId: m.event_id, refMs: m.ref_time_ms ?? m.event_time_ms });
        }
      }
    }
    {
      const evidence: EvidenceItem[] = [];
      const counter: EvidenceItem[] = [];
      if (!cfg) {
          counter.push({ eventId: 0, refMs: drop.detected_ref_ms, detail: `no neighbor config version active for ${sourceSector} at drop time` });
      } else {
        const missing = [...seenNeighbors].filter((n) => !cfg.neighbors.includes(n));
        for (const m of strongOther.filter((s) => !cfg.neighbors.includes(s.sector))) {
          evidence.push({ eventId: m.eventId, refMs: m.refMs, detail: `strong measured cell ${m.sector} rsrp=${m.rsrp}dBm absent from config v${cfg.version}` });
        }
        if (missing.length === 0 && seenNeighbors.size > 0) {
          counter.push({ eventId: 0, refMs: drop.detected_ref_ms, detail: `all ${seenNeighbors.size} measured cells present in config v${cfg.version}` });
        }
        // A later config version that adds the measured cell is corroboration
        // that this was a configuration defect since repaired.
        const placeholders = seenNeighbors.size ? [...seenNeighbors].map(() => "?").join(",") : "SELECT NULL";
        const repaired = db
          .prepare(
            `SELECT DISTINCT cv.version
             FROM nbr_config_versions cv
             JOIN nbr_entries ne ON ne.config_version_id = cv.config_version_id
             WHERE cv.sector_id = ? AND cv.effective_at_ms > ?
               AND ne.neighbor_sector_id IN (${placeholders})
             ORDER BY cv.version LIMIT 1`,
          )
          .all(sourceSector, drop.detected_ref_ms, ...seenNeighbors) as { version: number }[];
        if (repaired.length > 0) {
          evidence.push({ eventId: 0, refMs: drop.detected_ref_ms, detail: `later config v${repaired[0]!.version} adds previously missing neighbor (repair evidence)` });
        }
      }
      if (evidence.length > 0) {
        hypotheses.push({
          category: "MISSING_NEIGHBOR",
          verdict: "strong measured neighbor missing from active neighbor configuration",
          score: Math.min(1, 0.55 + 0.15 * evidence.length),
          evidence,
          counter,
        });
      }
    }

    // H2: weak coverage
    {
      const evidence: EvidenceItem[] = [];
      const counter: EvidenceItem[] = [];
      for (const m of meas) {
        const p = payload(m);
        const serving = (p.servingRsrp ?? p.rsrp) as number | undefined;
        const ref = m.ref_time_ms ?? m.event_time_ms;
        if (typeof serving === "number" && serving <= WEAK_RSRP_DBM) {
          evidence.push({ eventId: m.event_id, refMs: ref, detail: `serving rsrp=${serving}dBm <= ${WEAK_RSRP_DBM}dBm threshold` });
        } else if (typeof serving === "number" && serving > WEAK_RSRP_DBM + 10) {
          counter.push({ eventId: m.event_id, refMs: ref, detail: `serving rsrp=${serving}dBm remained healthy` });
        }
      }
      const strongCellExists = strongOther.length > 0;
      if (!strongCellExists) {
        counter.push({ eventId: 0, refMs: drop.detected_ref_ms, detail: "no neighbor cell measured above weak-coverage threshold (pilot pollution / coverage hole)" });
      } else {
        evidence.push({ eventId: 0, refMs: drop.detected_ref_ms, detail: `${strongOther.length} neighbor samples above ${WEAK_RSRP_DBM}dBm existed (coverage was reachable)` });
      }
      if (evidence.some((e) => /serving rsrp/.test(e.detail))) {
        hypotheses.push({
          category: "WEAK_COVERAGE",
          verdict: "serving signal degraded below threshold before failure",
          score: Math.min(1, 0.5 + 0.12 * evidence.length),
          evidence,
          counter,
        });
      }
    }

    // H3: capacity congestion
    {
      const evidence: EvidenceItem[] = [];
      const counter: EvidenceItem[] = [];
      const loads = window.filter((e) => e.event_type === "CELL_LOAD" && (e.sector_id === drop.sector_id || (payload(e).sectorId === drop.sector_id)));
      for (const l of loads) {
        const p = payload(l);
        const util = p.loadRatio as number | undefined;
        const ref = l.ref_time_ms ?? l.event_time_ms;
        if (typeof util === "number" && util >= CONGESTED_LOAD) {
          evidence.push({ eventId: l.event_id, refMs: ref, detail: `sector load=${(util * 100).toFixed(0)}% >= ${CONGESTED_LOAD * 100}% (reject/purge risk)` });
        } else if (typeof util === "number") {
          counter.push({ eventId: l.event_id, refMs: ref, detail: `sector load=${(util * 100).toFixed(0)}% below congestion threshold` });
        }
      }
      // Admission rejects in payloads are direct evidence.
      for (const e of window) {
        const p = payload(e);
        if ((p.rejectCause as string | undefined) === "CONGESTION" || (p.admissionRejected as boolean | undefined) === true) {
          evidence.push({ eventId: e.event_id, refMs: e.ref_time_ms ?? e.event_time_ms, detail: "admission rejected due to congestion" });
        }
      }
      if (evidence.length > 0) {
        hypotheses.push({
          category: "CAPACITY_CONGESTION",
          verdict: "serving sector was congested around the drop window",
          score: Math.min(1, 0.5 + 0.15 * evidence.length),
          evidence,
          counter,
        });
      }
    }

    // H4: clock skew artifact (drop may be an ordering artifact)
    {
      const skewRows = db
        .prepare(
          `SELECT MAX(ABS(offset_ms)) AS max_abs FROM clock_calibrations
           WHERE sector_id = ? AND valid_from_ms <= ?`,
        )
        .get(drop.sector_id, drop.detected_ref_ms) as { max_abs: number | null } | undefined;
      const maxAbs = skewRows?.max_abs ?? 0;
      if (maxAbs >= SKEW_GUARD_MS) {
        hypotheses.push({
          category: "CLOCK_SKEW_ARTIFACT",
          verdict: `sector clock offset up to ${maxAbs}ms; failure ordering may be distorted`,
          score: 0.45,
          evidence: [{ eventId: 0, refMs: drop.detected_ref_ms, detail: `clock calibration offset=${maxAbs}ms >= ${SKEW_GUARD_MS}ms` }],
          counter: [
            {
              eventId: 0,
              refMs: drop.detected_ref_ms,
              detail: "drop was detected on calibrated reference time and RLF is explicit, so skew alone does not invalidate it",
            },
          ],
        });
      }
    }

    const ranked = hypotheses.filter((h) => h.score >= 0.5).sort((a, b) => b.score - a.score);
    let category: RcaCategory;
    let verdict: string;
    let confidence: number;
    let evidence: EvidenceItem[];
    let counter: EvidenceItem[];
    if (ranked.length === 0) {
      category = "INCONCLUSIVE";
      verdict = "no hypothesis gathered sufficient evidence within the analysis window";
      confidence = 0.2;
      evidence = [{ eventId: drop.last_event_id, refMs: drop.detected_ref_ms, detail: `explicit drop on ${drop.sector_id}` }];
      counter = hypotheses.flatMap((h) => h.counter.map((c) => ({ ...c, detail: `[${h.category}] ${c.detail}` })));
    } else if (ranked.length >= 2 && ranked[1]!.score >= ranked[0]!.score - 0.1) {
      category = "MULTI_FACTOR";
      verdict = `competing causes: ${ranked.map((h) => h.category).join(" + ")}`;
      confidence = Math.round(ranked.reduce((s, h) => s + h.score, 0) / ranked.length * 100) / 100;
      evidence = ranked.flatMap((h) => h.evidence.map((e) => ({ ...e, detail: `[${h.category}] ${e.detail}` })));
      counter = ranked.flatMap((h) => h.counter.map((c) => ({ ...c, detail: `[${h.category}] ${c.detail}` })));
    } else {
      category = ranked[0]!.category;
      verdict = ranked[0]!.verdict;
      confidence = Math.round(ranked[0]!.score * 100) / 100;
      evidence = ranked[0]!.evidence;
      const winner = hypotheses.find((h) => h.category === category);
      counter = [
        ...(winner ? winner.counter.map((c) => ({ ...c, detail: `[${category}] ${c.detail}` })) : []),
        ...hypotheses.filter((h) => h.category !== category).flatMap((h) => h.counter.map((c) => ({ ...c, detail: `[${h.category}] ${c.detail}` }))),
      ];
    }

    findings.push({
      dropId: drop.id,
      terminalId: drop.terminal_id,
      category,
      verdict,
      confidence,
      evidence,
      counterEvidence: counter,
    });
  }

  return findings;
}
