import { describe, it, expect } from "vitest";
import { setup, ev, rebuild } from "./helpers";
import { RECEIPT_TIMEOUT_MS, TOO_EARLY_WINDOW_MS } from "../src/timeline";

describe("handover state machine", () => {
  it("classifies a normal handover", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -85 }, deviceTime: T }),
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T + 1000 }),
      ev(ctx, { type: "handover_receipt", cellId: B, deviceTime: T + 1200 }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers).toHaveLength(1);
    expect(tl.handovers[0].classification).toBe("normal");
    expect(tl.handovers[0].durationMs).toBe(200);
    expect(tl.servingCell).toBe(B);
  });

  it("flags a missing receipt without creating a drop", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -85 }, deviceTime: T }),
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T + 1000 }),
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -90 }, deviceTime: T + 9000 }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers[0].classification).toBe("missing_receipt");
    expect(tl.drops).toHaveLength(0);
  });

  it("receipt exactly at the timeout boundary is still accepted", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T }),
      ev(ctx, { type: "handover_receipt", cellId: B, deviceTime: T + RECEIPT_TIMEOUT_MS }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers[0].classification).toBe("normal");
  });

  it("receipt one ms past the timeout is missing_receipt", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T }),
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -90 }, deviceTime: T + RECEIPT_TIMEOUT_MS + 1 }),
      ev(ctx, { type: "handover_receipt", cellId: B, deviceTime: T + RECEIPT_TIMEOUT_MS + 2 }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers[0].classification).toBe("missing_receipt");
  });

  it("classifies too-early handover (drop right after receipt)", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T }),
      ev(ctx, { type: "handover_receipt", cellId: B, deviceTime: T + 200 }),
      ev(ctx, { type: "drop", cellId: B, deviceTime: T + 200 + TOO_EARLY_WINDOW_MS - 1 }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers[0].classification).toBe("too_early");
    expect(tl.drops).toHaveLength(1);
  });

  it("drop beyond the too-early window keeps handover normal", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T }),
      ev(ctx, { type: "handover_receipt", cellId: B, deviceTime: T + 200 }),
      ev(ctx, { type: "drop", cellId: B, deviceTime: T + 200 + TOO_EARLY_WINDOW_MS + 1 }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers[0].classification).toBe("normal");
    expect(tl.drops).toHaveLength(1);
  });

  it("classifies too-late handover (weak source, drop before receipt)", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -120 }, deviceTime: T }),
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T + 500 }),
      ev(ctx, { type: "drop", cellId: A, deviceTime: T + 900 }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers[0].classification).toBe("too_late");
  });

  it("classifies ping-pong handover", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T }),
      ev(ctx, { type: "handover_receipt", cellId: B, deviceTime: T + 200 }),
      ev(ctx, { type: "handover_command", cellId: B, targetCellId: A, deviceTime: T + 2000 }),
      ev(ctx, { type: "handover_receipt", cellId: A, deviceTime: T + 2200 }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers.map((h) => h.classification)).toEqual(["normal", "ping_pong"]);
  });

  it("out-of-order arrival does not fabricate drops or transitions", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "handover_receipt", cellId: B, deviceTime: T + 1200 }),
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T + 1000 }),
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -85 }, deviceTime: T }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers[0].classification).toBe("normal");
    expect(tl.drops).toHaveLength(0);
  });

  it("duplicate signaling is deduplicated and cannot fabricate drops", () => {
    const ctx = setup();
    const { A } = ctx.cells;
    const T = ctx.base;
    const drop = ev(ctx, { type: "drop", cellId: A, deviceTime: T });
    const r1 = ctx.svc.importEvents([drop]);
    const r2 = ctx.svc.importEvents([drop, drop]);
    expect(r1.inserted).toBe(1);
    expect(r2.inserted).toBe(0);
    expect(r2.duplicates).toBe(2);
    const tl = rebuild(ctx);
    expect(tl.drops).toHaveLength(1);
  });

  it("clock skew on target cell is corrected before ordering", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    ctx.svc.addClockCalibration(B, 1500, T - 1000); // B runs 1.5s fast
    ctx.svc.importEvents([
      ev(ctx, { type: "handover_command", cellId: A, targetCellId: B, deviceTime: T }),
      ev(ctx, { type: "handover_receipt", cellId: B, deviceTime: T + 1700 }),
    ]);
    const tl = rebuild(ctx);
    expect(tl.handovers[0].classification).toBe("normal");
    expect(tl.handovers[0].durationMs).toBe(200);
  });
});
