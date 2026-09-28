import { openDb, DB } from "../src/db";
import { Service, EventInput } from "../src/service";
import { FixedClock } from "../src/clock";
import { rebuildTimeline } from "../src/timeline";

export interface Ctx {
  db: DB;
  svc: Service;
  clock: FixedClock;
  cells: { A: number; B: number; C: number };
  terminal: number;
  base: number;
}

export function setup(): Ctx {
  const db = openDb(":memory:");
  const clock = new FixedClock(1_700_000_000_000);
  const svc = new Service(db, clock);
  const A = svc.createCell("A").id;
  const B = svc.createCell("B").id;
  const C = svc.createCell("C").id;
  const terminal = svc.createTerminal("anon-t1").id;
  return { db, svc, clock, cells: { A, B, C }, terminal, base: 1_700_000_000_000 };
}

export function ev(ctx: Ctx, partial: Partial<EventInput> & { type: EventInput["type"] }): EventInput {
  return {
    terminalId: ctx.terminal,
    deviceTime: ctx.base,
    source: "test",
    ...partial,
  } as EventInput;
}

export function rebuild(ctx: Ctx) {
  return rebuildTimeline(ctx.db, ctx.svc, ctx.terminal, ctx.clock);
}
