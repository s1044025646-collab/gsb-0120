import { DB } from "./db";
import { Service, EventInput } from "./service";
import { SeededRng } from "./clock";

/**
 * Fictional network generator. All data is invented; no real operator
 * network is involved. Deterministic via SeededRng so tests and demos are
 * reproducible.
 */
export interface FixtureContext {
  svc: Service;
  cells: { A: number; B: number; C: number };
  terminals: Record<string, number>;
  configV1: number;
  configV2: number;
  baseTime: number;
}

export const BASE_TIME = 1_700_000_000_000;

export function seedNetwork(db: DB, svc: Service): FixtureContext {
  const A = svc.createCell("CELL-A").id;
  const B = svc.createCell("CELL-B").id;
  const C = svc.createCell("CELL-C").id;
  // v1: A<->B configured, B->C missing (the defect the fixtures expose)
  const configV1 = svc.createConfigVersion(1, [
    { sourceCellId: A, targetCellId: B },
    { sourceCellId: B, targetCellId: A },
    { sourceCellId: C, targetCellId: B },
  ]).id;
  // v2: config fix, adds B->C
  const configV2 = svc.createConfigVersion(2, [
    { sourceCellId: A, targetCellId: B },
    { sourceCellId: B, targetCellId: A },
    { sourceCellId: B, targetCellId: C },
    { sourceCellId: C, targetCellId: B },
  ]).id;
  svc.activateConfig(A, configV1, BASE_TIME);
  svc.activateConfig(B, configV1, BASE_TIME);
  svc.activateConfig(C, configV1, BASE_TIME);
  const terminals: Record<string, number> = {};
  return { svc, cells: { A, B, C }, terminals, configV1, configV2, baseTime: BASE_TIME };
}

function term(ctx: FixtureContext, name: string): number {
  if (!ctx.terminals[name]) ctx.terminals[name] = ctx.svc.createTerminal(`anon-${name}`).id;
  return ctx.terminals[name];
}

/** Scenario 1: high-speed movement A -> B -> C with clean handovers. */
export function genHighSpeed(ctx: FixtureContext): EventInput[] {
  const t = term(ctx, "highspeed");
  const { A, B, C } = ctx.cells;
  const T = ctx.baseTime;
  const ev: EventInput[] = [];
  const sig = (time: number, cell: number, rsrp: number) =>
    ev.push({ terminalId: t, type: "signal_strength", cellId: cell, payload: { rsrp }, deviceTime: time, source: "probe" });
  for (let i = 0; i < 10; i++) sig(T + i * 500, A, -80 - i * 3);
  ev.push({ terminalId: t, type: "handover_command", cellId: A, targetCellId: B, deviceTime: T + 5000, source: "cellA" });
  ev.push({ terminalId: t, type: "handover_receipt", cellId: B, deviceTime: T + 5200, source: "cellB" });
  for (let i = 0; i < 8; i++) sig(T + 5500 + i * 500, B, -82 - i * 3);
  ev.push({ terminalId: t, type: "handover_command", cellId: B, targetCellId: C, deviceTime: T + 9500, source: "cellB" });
  ev.push({ terminalId: t, type: "handover_receipt", cellId: C, deviceTime: T + 9700, source: "cellC" });
  for (let i = 0; i < 5; i++) sig(T + 10000 + i * 500, C, -78);
  return ev;
}

/** Scenario 2: signal jitter around the weak threshold, then a weak-coverage drop. */
export function genJitterDrop(ctx: FixtureContext): EventInput[] {
  const t = term(ctx, "jitter");
  const { A } = ctx.cells;
  const T = ctx.baseTime + 60_000;
  const rng = new SeededRng(42);
  const ev: EventInput[] = [];
  for (let i = 0; i < 20; i++) {
    const rsrp = -105 - Math.floor(rng.next() * 12); // jitter across -110 threshold
    ev.push({ terminalId: t, type: "signal_strength", cellId: A, payload: { rsrp }, deviceTime: T + i * 400, source: "probe" });
  }
  ev.push({ terminalId: t, type: "drop", cellId: A, deviceTime: T + 8200, source: "terminal" });
  return ev;
}

/** Scenario 3: base-station clock skew; events arrive out of order but must not create fake drops. */
export function genClockSkew(ctx: FixtureContext): EventInput[] {
  const t = term(ctx, "skew");
  const { A, B } = ctx.cells;
  const T = ctx.baseTime + 120_000;
  // cell B clock is 1500ms fast; calibration corrects it
  ctx.svc.addClockCalibration(ctx.cells.B, 1500, T - 10_000);
  // recalibrated back to zero after the skew experiment window
  ctx.svc.addClockCalibration(ctx.cells.B, 0, T + 10_000);
  const ev: EventInput[] = [
    { terminalId: t, type: "signal_strength", cellId: A, payload: { rsrp: -85 }, deviceTime: T, source: "probe" },
    { terminalId: t, type: "handover_command", cellId: A, targetCellId: B, deviceTime: T + 1000, source: "cellA" },
    // receipt stamped by B's fast clock: T+1300+1500 = T+2800 raw, corrects to T+1300
    { terminalId: t, type: "handover_receipt", cellId: B, deviceTime: T + 2800, source: "cellB" },
    { terminalId: t, type: "signal_strength", cellId: B, payload: { rsrp: -80 }, deviceTime: T + 3500, source: "probe" },
  ];
  return ev;
}

/** Scenario 4: handover command with missing receipt (not a drop). */
export function genMissingReceipt(ctx: FixtureContext): EventInput[] {
  const t = term(ctx, "noreceipt");
  const { A, B } = ctx.cells;
  const T = ctx.baseTime + 180_000;
  return [
    { terminalId: t, type: "signal_strength", cellId: A, payload: { rsrp: -88 }, deviceTime: T, source: "probe" },
    { terminalId: t, type: "handover_command", cellId: A, targetCellId: B, deviceTime: T + 1000, source: "cellA" },
    { terminalId: t, type: "signal_strength", cellId: A, payload: { rsrp: -90 }, deviceTime: T + 5000, source: "probe" },
  ];
}

/** Scenario 5: duplicate reports; re-import must be a no-op. */
export function genDuplicates(ctx: FixtureContext): EventInput[] {
  const t = term(ctx, "dup");
  const { A } = ctx.cells;
  const T = ctx.baseTime + 240_000;
  const one: EventInput = {
    terminalId: t, type: "signal_strength", cellId: A, payload: { rsrp: -90 }, deviceTime: T, source: "probe",
  };
  return [one, { ...one }, { ...one }];
}

/** Scenario 6: ping-pong A -> B -> A within the ping-pong window. */
export function genPingPong(ctx: FixtureContext): EventInput[] {
  const t = term(ctx, "pingpong");
  const { A, B } = ctx.cells;
  const T = ctx.baseTime + 300_000;
  return [
    { terminalId: t, type: "signal_strength", cellId: A, payload: { rsrp: -85 }, deviceTime: T, source: "probe" },
    { terminalId: t, type: "handover_command", cellId: A, targetCellId: B, deviceTime: T + 1000, source: "cellA" },
    { terminalId: t, type: "handover_receipt", cellId: B, deviceTime: T + 1200, source: "cellB" },
    { terminalId: t, type: "handover_command", cellId: B, targetCellId: A, deviceTime: T + 3000, source: "cellB" },
    { terminalId: t, type: "handover_receipt", cellId: A, deviceTime: T + 3200, source: "cellA" },
  ];
}

/** Scenario 7: drop caused by missing neighbor config (B->C absent in v1), later fixed by v2. */
export function genMissingNeighborDrop(ctx: FixtureContext): EventInput[] {
  const t = term(ctx, "missingnbr");
  const { B, C } = ctx.cells;
  const T = ctx.baseTime + 360_000;
  return [
    { terminalId: t, type: "signal_strength", cellId: B, payload: { rsrp: -95 }, deviceTime: T, source: "probe" },
    {
      terminalId: t, type: "measurement_report", cellId: B,
      payload: { rsrp: -100, neighbors: [{ cellId: C, rsrp: -80 }] },
      deviceTime: T + 500, source: "terminal",
    },
    { terminalId: t, type: "signal_strength", cellId: B, payload: { rsrp: -108 }, deviceTime: T + 1000, source: "probe" },
    { terminalId: t, type: "drop", cellId: B, deviceTime: T + 1500, source: "terminal" },
  ];
}

/** Scenario 8: congestion on serving cell leads to drop. */
export function genCongestionDrop(ctx: FixtureContext): EventInput[] {
  const t = term(ctx, "congestion");
  const { A } = ctx.cells;
  const T = ctx.baseTime + 420_000;
  return [
    { terminalId: t, type: "signal_strength", cellId: A, payload: { rsrp: -75 }, deviceTime: T, source: "probe" },
    { terminalId: t, type: "cell_load", cellId: A, payload: { load: 0.95 }, deviceTime: T + 200, source: "cellA" },
    { terminalId: t, type: "cell_load", cellId: A, payload: { load: 0.97 }, deviceTime: T + 700, source: "cellA" },
    { terminalId: t, type: "drop", cellId: A, deviceTime: T + 1200, source: "terminal" },
  ];
}

export function generateAll(ctx: FixtureContext): Record<string, EventInput[]> {
  return {
    highSpeed: genHighSpeed(ctx),
    jitterDrop: genJitterDrop(ctx),
    clockSkew: genClockSkew(ctx),
    missingReceipt: genMissingReceipt(ctx),
    duplicates: genDuplicates(ctx),
    pingPong: genPingPong(ctx),
    missingNeighborDrop: genMissingNeighborDrop(ctx),
    congestionDrop: genCongestionDrop(ctx),
  };
}
