import { DB } from "./db";
import { Service } from "./service";
import { Clock, systemClock } from "./clock";

export const RECEIPT_TIMEOUT_MS = 2000;
export const TOO_EARLY_WINDOW_MS = 3000;
export const PING_PONG_WINDOW_MS = 5000;
export const WEAK_RSRP_DBM = -110;

export interface HandoverRecord {
  fromCell: number | null;
  toCell: number | null;
  commandTime: number;
  receiptTime: number | null;
  durationMs: number | null;
  classification:
    | "normal"
    | "too_early"
    | "too_late"
    | "ping_pong"
    | "missing_receipt"
    | "pending";
}

export interface TimelineState {
  terminalId: number;
  servingCell: number | null;
  handovers: HandoverRecord[];
  drops: { time: number; cellId: number | null; eventId: number }[];
  lastRsrp: Record<string, number>; // cellId -> latest rsrp
}

/**
 * Rebuild a terminal's handover state machine from raw events.
 * Events are consumed in (corrected_time, arrival id) order, so out-of-order
 * arrival cannot fabricate transitions; duplicates were removed at import, so
 * repeated signaling cannot fabricate drops. Only explicit `drop` events
 * produce drop records — a missing receipt is flagged, never a drop.
 */
export function rebuildTimeline(
  db: DB,
  svc: Service,
  terminalId: number,
  clock: Clock = systemClock
): TimelineState {
  const events = svc.eventsForTerminal(terminalId);
  const state: TimelineState = {
    terminalId,
    servingCell: null,
    handovers: [],
    drops: [],
    lastRsrp: {},
  };
  let pending: HandoverRecord | null = null;
  const visited: { cell: number; time: number }[] = [];

  const flushPending = (now: number) => {
    if (pending && pending.receiptTime == null) {
      if (now - pending.commandTime > RECEIPT_TIMEOUT_MS) {
        pending.classification = "missing_receipt";
        state.handovers.push(pending);
        pending = null;
      }
    }
  };

  for (const ev of events) {
    const t = ev.corrected_time as number;
    flushPending(t);
    const payload = JSON.parse(ev.payload || "{}");
    switch (ev.type) {
      case "signal_strength":
      case "measurement_report": {
        if (ev.cell_id != null && typeof payload.rsrp === "number")
          state.lastRsrp[String(ev.cell_id)] = payload.rsrp;
        if (state.servingCell == null && ev.cell_id != null) state.servingCell = ev.cell_id;
        break;
      }
      case "handover_command": {
        if (pending) {
          // superseded command without receipt
          pending.classification = "missing_receipt";
          state.handovers.push(pending);
        }
        pending = {
          fromCell: ev.cell_id ?? state.servingCell,
          toCell: ev.target_cell_id ?? null,
          commandTime: t,
          receiptTime: null,
          durationMs: null,
          classification: "pending",
        };
        break;
      }
      case "handover_receipt": {
        const to = ev.cell_id ?? ev.target_cell_id ?? pending?.toCell ?? null;
        if (pending && (pending.toCell == null || pending.toCell === to)) {
          pending.receiptTime = t;
          pending.durationMs = t - pending.commandTime;
          const recentReturn = visited.some(
            (v) => v.cell === to && pending!.commandTime - v.time <= PING_PONG_WINDOW_MS
          );
          pending.classification = recentReturn ? "ping_pong" : "normal";
          state.handovers.push(pending);
          if (pending.fromCell != null) visited.push({ cell: pending.fromCell, time: t });
          pending = null;
        }
        if (to != null) state.servingCell = to;
        break;
      }
      case "drop": {
        // classify any open handover around this drop
        if (pending) {
          const fromRsrp =
            pending.fromCell != null ? state.lastRsrp[String(pending.fromCell)] : undefined;
          if (fromRsrp != null && fromRsrp <= WEAK_RSRP_DBM) {
            // source was fading before the command completed: command came too late
            pending.classification = "too_late";
          } else {
            pending.classification = "missing_receipt";
          }
          state.handovers.push(pending);
          pending = null;
        } else {
          // drop shortly after a completed handover => too early
          const last = state.handovers[state.handovers.length - 1];
          if (
            last &&
            last.receiptTime != null &&
            t - last.receiptTime <= TOO_EARLY_WINDOW_MS &&
            last.classification === "normal"
          ) {
            last.classification = "too_early";
          }
        }
        state.drops.push({ time: t, cellId: ev.cell_id ?? state.servingCell, eventId: ev.id });
        break;
      }
    }
  }
  flushPending(Number.MAX_SAFE_INTEGER);

  const inputHash = svc.inputHashForTerminal(terminalId);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO timelines (terminal_id, state, input_hash, rebuilt_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(terminal_id) DO UPDATE SET state = excluded.state,
         input_hash = excluded.input_hash, rebuilt_at = excluded.rebuilt_at`
    ).run(terminalId, JSON.stringify(state), inputHash, clock.now());
    // keep stable ids for drops that still exist; remove only vanished ones
    const times = state.drops.map((d) => d.time);
    if (times.length > 0) {
      db.prepare(
        `DELETE FROM drops WHERE terminal_id = ? AND detected_at NOT IN (${times.map(() => "?").join(",")})`
      ).run(terminalId, ...times);
    } else {
      db.prepare("DELETE FROM drops WHERE terminal_id = ?").run(terminalId);
    }
    const ins = db.prepare(
      "INSERT OR IGNORE INTO drops (terminal_id, cell_id, detected_at, context) VALUES (?, ?, ?, ?)"
    );
    for (const d of state.drops)
      ins.run(terminalId, d.cellId, d.time, JSON.stringify({ eventId: d.eventId }));
  });
  tx();
  return state;
}

export function getTimeline(db: DB, terminalId: number): (TimelineState & { inputHash: string }) | null {
  const row = db.prepare("SELECT state, input_hash FROM timelines WHERE terminal_id = ?").get(terminalId) as
    | { state: string; input_hash: string }
    | undefined;
  if (!row) return null;
  return { ...(JSON.parse(row.state) as TimelineState), inputHash: row.input_hash };
}
