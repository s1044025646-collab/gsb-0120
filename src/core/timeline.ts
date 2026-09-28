import type { DatabaseSync } from "node:sqlite";
import { SignalRepository } from "./repository.js";

export interface EventRow {
  event_id: number;
  source: string;
  source_seq: number;
  event_type: string;
  terminal_id: string | null;
  sector_id: string | null;
  target_sector_id: string | null;
  config_version_id: string | null;
  event_time_ms: number;
  received_at_ms: number;
  ref_time_ms: number | null;
  payload_json: string;
}

export function payload(row: EventRow): Record<string, unknown> {
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

// Pass 1: calibrate event timestamps to the reference clock using the offset
// that was valid for the emitting sector at the reported time.
export function calibrateTimestamps(db: DatabaseSync, repo: SignalRepository): number {
  const rows = db
    .prepare("SELECT event_id, sector_id, event_time_ms FROM signaling_events WHERE ref_time_ms IS NULL")
    .all() as Pick<EventRow, "event_id" | "sector_id" | "event_time_ms">[];
  const upd = db.prepare("UPDATE signaling_events SET ref_time_ms = ? WHERE event_id = ?");
  let n = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) {
      const offset = r.sector_id ? repo.offsetFor(r.sector_id, r.event_time_ms) : 0;
      upd.run(r.event_time_ms + offset, r.event_id);
      n++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

export const PINGPONG_WINDOW_MS = 5000;
export const TOO_EARLY_WINDOW_MS = 3000;
export const ACK_WINDOW_MS = 2000;

export interface HoRecord {
  terminalId: string;
  fromSectorId: string;
  toSectorId: string;
  commandEventId: number;
  ackEventId: number | null;
  cmdRefMs: number;
  ackRefMs: number | null;
  outcome: string;
  classification: string;
  pingpongGroupId: number | null;
}

export interface DropRecord {
  terminalId: string;
  sectorId: string;
  detectedRefMs: number;
  lastEventId: number;
}

export interface TimelineStateRow {
  terminalId: string;
  state: string;
  sectorId: string | null;
  beginRefMs: number;
  endRefMs: number | null;
  causeEventId: number | null;
}

export interface RecomputeResult {
  rerunToken: string;
  terminals: number;
  states: number;
  handovers: HoRecord[];
  drops: DropRecord[];
}

interface PendingHo {
  cmd: EventRow;
  from: string;
  to: string;
}

// Reconstructs per-terminal timelines from calibrated events.
// Ordering: (ref_time_ms, event_id) so out-of-order arrivals sort correctly.
// Drops require an explicit RLF_IND / failed re-establishment; pure gaps or
// late ACKs never fabricate a drop.
export function recompute(db: DatabaseSync, rerunToken: string): RecomputeResult {
  calibrateTimestamps(db, new SignalRepository(db));

  const rows = db
    .prepare(
      `SELECT * FROM signaling_events
       WHERE terminal_id IS NOT NULL
       ORDER BY terminal_id, ref_time_ms, event_id`,
    )
    .all() as unknown as EventRow[];

  const states: TimelineStateRow[] = [];
  const handovers: HoRecord[] = [];
  const drops: DropRecord[] = [];
  let ppGroup = 0;

  const pushState = (
    terminalId: string,
    prev: TimelineStateRow | undefined,
    state: string,
    sectorId: string | null,
    beginRefMs: number,
    causeEventId: number | null,
  ) => {
    if (prev && prev.endRefMs === null) prev.endRefMs = beginRefMs;
    states.push({ terminalId, state, sectorId, beginRefMs, endRefMs: null, causeEventId });
  };

  let currentTerminal: string | null = null;
  let prevState: TimelineStateRow | undefined;
  let serving: string | null = null;
  let pending: PendingHo | null = null;
  let rlfPending = false;
  const recentHo: { from: string; to: string; cmdRef: number; idx: number }[] = [];

  const closePending = (
    t: string,
    outcome: string,
    ackEventId: number | null,
    ackRef: number | null,
    classification = "NORMAL",
    ppId: number | null = null,
  ) => {
    if (!pending) return;
    handovers.push({
      terminalId: t,
      fromSectorId: pending.from,
      toSectorId: pending.to,
      commandEventId: pending.cmd.event_id,
      ackEventId,
      cmdRefMs: pending.cmd.ref_time_ms ?? pending.cmd.event_time_ms,
      ackRefMs: ackRef,
      outcome,
      classification,
      pingpongGroupId: ppId,
    });
    pending = null;
  };

  for (const row of rows) {
    if (row.terminal_id !== currentTerminal) {
      if (pending && currentTerminal) {
        // End of feed with no ACK and no RLF: record as MISSING_ACK, not a drop.
        closePending(
          currentTerminal,
          rlfPending ? "RLF_BEFORE_ACK" : "MISSING_ACK",
          null,
          null,
          rlfPending ? "RLF_UNRESOLVED" : "MISSING_ACK",
        );
      }
      currentTerminal = row.terminal_id;
      prevState = undefined;
      serving = null;
      pending = null;
      rlfPending = false;
      recentHo.length = 0;
    }
    const ref = row.ref_time_ms ?? row.event_time_ms;
    const p = payload(row);

    switch (row.event_type) {
      case "MEAS_REPORT": {
        const serv: string | null = (p.servingSectorId as string | undefined) ?? row.sector_id ?? serving;
        if (serv && serv !== serving && !pending) {
          serving = serv;
          pushState(row.terminal_id!, prevState, "CAMPED", serving, ref, row.event_id);
          prevState = states[states.length - 1];
        }
        break;
      }
      case "HO_COMMAND": {
        if (pending) closePending(row.terminal_id!, "MISSING_ACK", null, null, "MISSING_ACK");
        const from: string = row.sector_id ?? serving ?? "UNKNOWN";
        const to: string = row.target_sector_id ?? (p.targetSectorId as string | undefined) ?? "UNKNOWN";
        pending = { cmd: row, from, to };
        pushState(row.terminal_id!, prevState, "HANDOVER_PENDING", to, ref, row.event_id);
        prevState = states[states.length - 1];
        break;
      }
      case "HO_ACK": {
        if (!pending) break; // duplicate / stray ACK, ignored without state change
        const cmdPending = pending;
        const ackSector = row.sector_id ?? (p.servingSectorId as string) ?? cmdPending.to;
        if (ackSector !== cmdPending.to) break;
        const cmdRef = cmdPending.cmd.ref_time_ms ?? cmdPending.cmd.event_time_ms;
        if (ref - cmdRef > ACK_WINDOW_MS) {
          closePending(row.terminal_id!, "MISSING_ACK", row.event_id, ref, "MISSING_ACK");
          break;
        }
        // Ping-pong: back to a sector we served within the window.
        let classification = "NORMAL";
        let ppId: number | null = null;
        const back = recentHo.find(
          (h) => h.to === cmdPending.from && h.from === cmdPending.to && ref - h.cmdRef <= PINGPONG_WINDOW_MS,
        );
        if (back) {
          classification = "PINGPONG";
          ppGroup++;
          ppId = ppGroup;
          const earlier = handovers[back.idx];
          if (earlier) {
            earlier.classification = "PINGPONG";
            earlier.pingpongGroupId = ppGroup;
          }
        }
        serving = cmdPending.to;
        const idxNow = handovers.length;
        closePending(row.terminal_id!, "SUCCESS", row.event_id, ref, classification, ppId);
        recentHo.push({ from: cmdPending.from, to: serving, cmdRef: ref, idx: idxNow });
        pushState(row.terminal_id!, prevState, "CAMPED", serving, ref, row.event_id);
        prevState = states[states.length - 1];
        while (recentHo.length > 0 && recentHo[0]!.cmdRef < ref - PINGPONG_WINDOW_MS) recentHo.shift();
        break;
      }
      case "RLF_IND": {
        const rlfSector = (p.servingSectorId as string) ?? (pending ? pending.to : serving) ?? "UNKNOWN";
        rlfPending = pending !== null;
        drops.push({ terminalId: row.terminal_id!, sectorId: rlfSector, detectedRefMs: ref, lastEventId: row.event_id });
        pushState(row.terminal_id!, prevState, "DROPPED", rlfSector, ref, row.event_id);
        prevState = states[states.length - 1];
        break;
      }
      case "REESTABLISH_REQ": {
        const reestSector = (p.servingSectorId as string) ?? row.sector_id ?? null;
        if (rlfPending && pending && reestSector === pending.from) {
          closePending(row.terminal_id!, "REESTABLISH_SOURCE", null, ref, "TOO_EARLY");
        } else if (rlfPending && pending) {
          closePending(row.terminal_id!, "REESTABLISH_TARGET", null, ref, "TOO_LATE");
        }
        rlfPending = false;
        if (reestSector) {
          serving = reestSector;
          pushState(row.terminal_id!, prevState, "CAMPED", serving, ref, row.event_id);
          prevState = states[states.length - 1];
        }
        break;
      }
      case "CONN_RELEASE": {
        if (pending) closePending(row.terminal_id!, "MISSING_ACK", null, null, "MISSING_ACK");
        pushState(row.terminal_id!, prevState, "RRC_IDLE", serving, ref, row.event_id);
        prevState = states[states.length - 1];
        serving = null;
        break;
      }
      default:
        break;
    }
  }
  if (pending && currentTerminal) {
    closePending(
      currentTerminal,
      rlfPending ? "RLF_BEFORE_ACK" : "MISSING_ACK",
      null,
      null,
      rlfPending ? "RLF_UNRESOLVED" : "MISSING_ACK",
    );
  }

  // Persist derived tables atomically.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM timeline_states");
    db.exec("DELETE FROM handovers");
    db.exec("DELETE FROM drops");
    const insState = db.prepare(
      `INSERT INTO timeline_states(terminal_id, state, sector_id, begin_ref_ms, end_ref_ms, cause_event_id, recompute_batch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insHo = db.prepare(
      `INSERT INTO handovers(terminal_id, from_sector_id, to_sector_id, command_event_id, ack_event_id,
        cmd_ref_ms, ack_ref_ms, outcome, classification, pingpong_group_id, rerun_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insDrop = db.prepare(
      `INSERT INTO drops(terminal_id, sector_id, detected_ref_ms, last_event_id, rerun_token)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const s of states) insState.run(s.terminalId, s.state, s.sectorId, s.beginRefMs, s.endRefMs, s.causeEventId, rerunToken);
    for (const h of handovers)
      insHo.run(h.terminalId, h.fromSectorId, h.toSectorId, h.commandEventId, h.ackEventId, h.cmdRefMs, h.ackRefMs, h.outcome, h.classification, h.pingpongGroupId, rerunToken);
    for (const d of drops) insDrop.run(d.terminalId, d.sectorId, d.detectedRefMs, d.lastEventId, rerunToken);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const terminals = new Set(rows.map((r) => r.terminal_id)).size;
  return { rerunToken, terminals, states: states.length, handovers, drops };
}

