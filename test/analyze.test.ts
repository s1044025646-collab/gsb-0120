import { describe, it, expect } from "vitest";
import { setup, ev, rebuild } from "./helpers";
import { analyzeDrop, investigate, publishInvestigation } from "../src/analyze";

function dropIdOf(ctx: ReturnType<typeof setup>): number {
  const row = ctx.db.prepare("SELECT id FROM drops WHERE terminal_id = ?").get(ctx.terminal) as any;
  return row.id;
}

describe("root cause analysis", () => {
  it("weak coverage: evidence from weak rsrp, counter-evidence absent", () => {
    const ctx = setup();
    const { A } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -115 }, deviceTime: T }),
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -118 }, deviceTime: T + 500 }),
      ev(ctx, { type: "drop", cellId: A, deviceTime: T + 1000 }),
    ]);
    rebuild(ctx);
    const r = analyzeDrop(ctx.db, ctx.svc, dropIdOf(ctx));
    expect(r.rootCause).toBe("weak_coverage");
    const weak = r.assessments.find((a) => a.cause === "weak_coverage")!;
    expect(weak.evidence.length).toBe(2);
    expect(weak.counterEvidence.length).toBe(0);
  });

  it("strong signal before drop is counter-evidence against weak coverage", () => {
    const ctx = setup();
    const { A } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -75 }, deviceTime: T }),
      ev(ctx, { type: "cell_load", cellId: A, payload: { load: 0.96 }, deviceTime: T + 100 }),
      ev(ctx, { type: "drop", cellId: A, deviceTime: T + 500 }),
    ]);
    rebuild(ctx);
    const r = analyzeDrop(ctx.db, ctx.svc, dropIdOf(ctx));
    expect(r.rootCause).toBe("congestion");
    const weak = r.assessments.find((a) => a.cause === "weak_coverage")!;
    expect(weak.counterEvidence.length).toBe(1);
  });

  it("missing neighbor config is detected and fixed by a new config version", () => {
    const ctx = setup();
    const { A, B } = ctx.cells;
    const T = ctx.base;
    const v1 = ctx.svc.createConfigVersion(1, []).id; // A->B missing
    ctx.svc.activateConfig(A, v1, T - 1000);
    ctx.svc.importEvents([
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -95 }, deviceTime: T }),
      ev(ctx, {
        type: "measurement_report", cellId: A,
        payload: { rsrp: -100, neighbors: [{ cellId: B, rsrp: -80 }] },
        deviceTime: T + 100,
      }),
      ev(ctx, { type: "drop", cellId: A, deviceTime: T + 500 }),
    ]);
    rebuild(ctx);
    const before = analyzeDrop(ctx.db, ctx.svc, dropIdOf(ctx));
    expect(before.rootCause).toBe("neighbor_missing");
    const missing = before.assessments.find((a) => a.cause === "neighbor_missing")!;
    expect(missing.evidence.length).toBe(1);

    // config fix: v2 adds A->B, activated after the drop; re-analysis of the
    // historical drop still uses the config active at that time
    const v2 = ctx.svc.createConfigVersion(2, [{ sourceCellId: A, targetCellId: B }]).id;
    ctx.svc.activateConfig(A, v2, T + 60_000);
    const after = analyzeDrop(ctx.db, ctx.svc, dropIdOf(ctx));
    expect(after.rootCause).toBe("neighbor_missing");
    const diff = ctx.svc.compareConfigVersions(1, 2);
    expect(diff.added).toEqual([`${A}->${B}`]);
  });

  it("late-arriving events trigger recompute and can change the conclusion", () => {
    const ctx = setup();
    const { A } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -70 }, deviceTime: T }),
      ev(ctx, { type: "drop", cellId: A, deviceTime: T + 500 }),
    ]);
    rebuild(ctx);
    const id = dropIdOf(ctx);
    expect(analyzeDrop(ctx.db, ctx.svc, id).rootCause).toBe("unknown");
    // late event: congestion evidence arrives after the fact
    ctx.svc.importEvents([
      ev(ctx, { type: "cell_load", cellId: A, payload: { load: 0.99 }, deviceTime: T + 200 }),
    ]);
    rebuild(ctx);
    expect(analyzeDrop(ctx.db, ctx.svc, id).rootCause).toBe("congestion");
  });

  it("published investigations are immutable and reproducible", () => {
    const ctx = setup();
    const { A } = ctx.cells;
    const T = ctx.base;
    ctx.svc.importEvents([
      ev(ctx, { type: "signal_strength", cellId: A, payload: { rsrp: -115 }, deviceTime: T }),
      ev(ctx, { type: "drop", cellId: A, deviceTime: T + 500 }),
    ]);
    rebuild(ctx);
    const inv = investigate(ctx.db, ctx.svc, dropIdOf(ctx), null, ctx.clock);
    publishInvestigation(ctx.db, inv.id, ctx.clock);
    // new evidence arrives; published record must not change
    ctx.svc.importEvents([
      ev(ctx, { type: "cell_load", cellId: A, payload: { load: 0.99 }, deviceTime: T + 200 }),
    ]);
    const again = investigate(ctx.db, ctx.svc, dropIdOf(ctx), null, ctx.clock);
    expect(again.id).toBe(inv.id);
    const stored = ctx.db.prepare("SELECT root_cause FROM investigations WHERE id = ?").get(inv.id) as any;
    expect(stored.root_cause).toBe("weak_coverage");
    expect(() => publishInvestigation(ctx.db, inv.id, ctx.clock)).toThrowError(/already published/);
  });
});
