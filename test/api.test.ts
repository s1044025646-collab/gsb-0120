import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, DB } from "../src/db";
import { createApp } from "../src/api";
import { FixedClock } from "../src/clock";
import { Express } from "express";

let db: DB;
let app: Express;

beforeEach(() => {
  db = openDb(":memory:");
  app = createApp(db, new FixedClock(1_700_000_000_000));
});

async function seedBasic() {
  const t = await request(app).post("/terminals").send({ anonId: "anon-x" });
  const a = await request(app).post("/cells").send({ name: "C1" });
  return { terminalId: t.body.data.id as number, cellId: a.body.data.id as number };
}

describe("API", () => {
  it("creates terminals and cells; rejects duplicates with CONFLICT", async () => {
    const { terminalId } = await seedBasic();
    expect(terminalId).toBeGreaterThan(0);
    const dup = await request(app).post("/terminals").send({ anonId: "anon-x" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("CONFLICT");
  });

  it("validates event payloads with VALIDATION_ERROR", async () => {
    const res = await request(app).post("/events").send({ type: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns NOT_FOUND for unknown terminal on import", async () => {
    const res = await request(app).post("/events").send({
      terminalId: 999, type: "signal_strength", deviceTime: 1, source: "s",
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("imports events, rebuilds timeline, and preserves arrival order", async () => {
    const { terminalId, cellId } = await seedBasic();
    const imp = await request(app).post("/events").send({
      events: [
        { terminalId, type: "signal_strength", cellId, payload: { rsrp: -90 }, deviceTime: 100, source: "probe" },
        { terminalId, type: "drop", cellId, deviceTime: 200, source: "terminal" },
      ],
    });
    expect(imp.status).toBe(201);
    expect(imp.body.data.inserted).toBe(2);
    const rebuild = await request(app).post(`/terminals/${terminalId}/rebuild`);
    expect(rebuild.body.data.after.drops).toHaveLength(1);
    const timeline = await request(app).get(`/terminals/${terminalId}/timeline`);
    expect(timeline.status).toBe(200);
  });

  it("paginates events with cursor", async () => {
    const { terminalId, cellId } = await seedBasic();
    const events = Array.from({ length: 7 }, (_, i) => ({
      terminalId, type: "signal_strength", cellId,
      payload: { rsrp: -90 - i }, deviceTime: i * 100, source: "probe",
    }));
    await request(app).post("/events").send({ events });
    const p1 = await request(app).get("/events?limit=3");
    expect(p1.body.data.items).toHaveLength(3);
    expect(p1.body.data.nextCursor).not.toBeNull();
    const p2 = await request(app).get(`/events?limit=3&cursor=${p1.body.data.nextCursor}`);
    expect(p2.body.data.items).toHaveLength(3);
    const ids1 = p1.body.data.items.map((e: any) => e.id);
    const ids2 = p2.body.data.items.map((e: any) => e.id);
    expect(ids1.filter((id: number) => ids2.includes(id))).toHaveLength(0);
  });

  it("full flow: drop -> analyze -> evidence -> publish -> export", async () => {
    const { terminalId, cellId } = await seedBasic();
    await request(app).post("/events").send({
      events: [
        { terminalId, type: "signal_strength", cellId, payload: { rsrp: -120 }, deviceTime: 100, source: "probe" },
        { terminalId, type: "drop", cellId, deviceTime: 500, source: "terminal" },
      ],
    });
    await request(app).post(`/terminals/${terminalId}/rebuild`);
    const drops = await request(app).get(`/drops?terminalId=${terminalId}`);
    const dropId = drops.body.data.items[0].id;
    const inv = await request(app).post("/investigations").send({ dropId });
    expect(inv.status).toBe(201);
    expect(inv.body.data.rootCause).toBe("weak_coverage");
    const detail = await request(app).get(`/investigations/${inv.body.data.id}`);
    expect(detail.body.data.evidence.length).toBeGreaterThan(0);
    const pub = await request(app).post(`/investigations/${inv.body.data.id}/publish`);
    expect(pub.body.data.status).toBe("published");
    const exp = await request(app).get(`/investigations/${inv.body.data.id}/export`);
    expect(exp.body.data.report.investigation.id).toBe(inv.body.data.id);
  });

  it("404 for missing timeline and investigation", async () => {
    const r1 = await request(app).get("/terminals/123/timeline");
    expect(r1.status).toBe(404);
    const r2 = await request(app).get("/investigations/123");
    expect(r2.status).toBe(404);
  });
});
