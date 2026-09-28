import express, { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { DB } from "./db";
import { Service, ApiError, EVENT_TYPES, EventInput } from "./service";
import { rebuildTimeline, getTimeline } from "./timeline";
import { investigate, publishInvestigation, getInvestigation } from "./analyze";
import { Clock, systemClock } from "./clock";

const idParam = z.coerce.number().int().positive();

const eventSchema = z.object({
  terminalId: z.number().int().positive(),
  type: z.enum(EVENT_TYPES),
  cellId: z.number().int().positive().nullish(),
  targetCellId: z.number().int().positive().nullish(),
  payload: z.record(z.string(), z.unknown()).optional(),
  deviceTime: z.number().finite(),
  source: z.string().min(1),
});

const pageSchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function createApp(db: DB, clock: Clock = systemClock): Express {
  const svc = new Service(db, clock);
  const app = express();
  app.use(express.json());
  const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ ok: true, data });

  app.get("/health", (_req, res) => ok(res, { status: "up" }));

  app.post("/terminals", (req, res) => {
    const body = z.object({ anonId: z.string().min(1) }).parse(req.body);
    ok(res, svc.createTerminal(body.anonId), 201);
  });
  app.get("/terminals", (req, res) => {
    const { cursor, limit } = pageSchema.parse(req.query);
    const l = limit ?? 50;
    const rows = db
      .prepare("SELECT * FROM terminals WHERE id > ? ORDER BY id LIMIT ?")
      .all(cursor ?? 0, l + 1) as any[];
    ok(res, { items: rows.slice(0, l), nextCursor: rows.length > l ? rows[l - 1].id : null });
  });

  app.post("/cells", (req, res) => {
    const body = z.object({ name: z.string().min(1), tech: z.string().optional() }).parse(req.body);
    ok(res, svc.createCell(body.name, body.tech), 201);
  });
  app.get("/cells", (_req, res) => ok(res, db.prepare("SELECT * FROM cells ORDER BY id").all()));

  app.post("/config-versions", (req, res) => {
    const body = z
      .object({
        version: z.number().int().positive(),
        note: z.string().optional(),
        entries: z.array(
          z.object({
            sourceCellId: z.number().int().positive(),
            targetCellId: z.number().int().positive(),
            priority: z.number().int().optional(),
          })
        ),
      })
      .parse(req.body);
    ok(res, svc.createConfigVersion(body.version, body.entries, body.note), 201);
  });
  app.get("/config-versions", (_req, res) =>
    ok(res, db.prepare("SELECT * FROM neighbor_config_versions ORDER BY version").all())
  );
  app.get("/config-versions/compare", (req, res) => {
    const q = z.object({ a: z.coerce.number().int(), b: z.coerce.number().int() }).parse(req.query);
    ok(res, svc.compareConfigVersions(q.a, q.b));
  });
  app.post("/config-activations", (req, res) => {
    const body = z
      .object({ cellId: idParam, versionId: idParam, effectiveFrom: z.number().finite() })
      .parse(req.body);
    ok(res, svc.activateConfig(body.cellId, body.versionId, body.effectiveFrom), 201);
  });

  app.post("/clock-calibrations", (req, res) => {
    const body = z
      .object({ cellId: idParam, offsetMs: z.number().finite(), effectiveFrom: z.number().finite() })
      .parse(req.body);
    ok(res, svc.addClockCalibration(body.cellId, body.offsetMs, body.effectiveFrom), 201);
  });

  app.post("/events", (req, res) => {
    const body = z
      .union([eventSchema, z.object({ events: z.array(eventSchema).min(1).max(1000) })])
      .parse(req.body);
    const list: EventInput[] = "events" in body ? (body.events as EventInput[]) : [body as EventInput];
    ok(res, svc.importEvents(list), 201);
  });
  app.get("/events", (req, res) => {
    const q = pageSchema
      .extend({ terminalId: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    ok(res, svc.listEvents(q));
  });

  app.post("/terminals/:id/rebuild", (req, res) => {
    const id = idParam.parse(req.params.id);
    const before = getTimeline(db, id);
    const state = rebuildTimeline(db, svc, id, clock);
    ok(res, { before: before ? { inputHash: before.inputHash } : null, after: state });
  });
  app.get("/terminals/:id/timeline", (req, res) => {
    const id = idParam.parse(req.params.id);
    const tl = getTimeline(db, id);
    if (!tl) throw new ApiError("NOT_FOUND", `timeline for terminal ${id} not found`, 404);
    ok(res, tl);
  });

  app.get("/drops", (req, res) => {
    const q = pageSchema
      .extend({ terminalId: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    const l = q.limit ?? 50;
    const rows = (
      q.terminalId != null
        ? db.prepare("SELECT * FROM drops WHERE terminal_id = ? AND id > ? ORDER BY id LIMIT ?").all(q.terminalId, q.cursor ?? 0, l + 1)
        : db.prepare("SELECT * FROM drops WHERE id > ? ORDER BY id LIMIT ?").all(q.cursor ?? 0, l + 1)
    ) as any[];
    ok(res, { items: rows.slice(0, l), nextCursor: rows.length > l ? rows[l - 1].id : null });
  });

  app.post("/batches", (req, res) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    const r = db
      .prepare("INSERT INTO batches (name, status, created_at) VALUES (?, 'open', ?)")
      .run(body.name, clock.now());
    ok(res, { id: Number(r.lastInsertRowid), name: body.name }, 201);
  });
  app.post("/batches/:id/analyze", (req, res) => {
    const batchId = idParam.parse(req.params.id);
    const batch = db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId);
    if (!batch) throw new ApiError("NOT_FOUND", `batch ${batchId} not found`, 404);
    const drops = db.prepare("SELECT id FROM drops ORDER BY id").all() as { id: number }[];
    const results = drops.map((d) => investigate(db, svc, d.id, batchId, clock));
    ok(res, {
      batchId,
      investigations: results.map((r) => ({ id: r.id, dropId: r.dropId, rootCause: r.rootCause })),
    });
  });

  app.post("/investigations", (req, res) => {
    const body = z.object({ dropId: idParam, batchId: idParam.optional() }).parse(req.body);
    ok(res, investigate(db, svc, body.dropId, body.batchId ?? null, clock), 201);
  });
  app.get("/investigations/:id", (req, res) => {
    ok(res, getInvestigation(db, idParam.parse(req.params.id)));
  });
  app.post("/investigations/:id/publish", (req, res) => {
    ok(res, publishInvestigation(db, idParam.parse(req.params.id), clock));
  });
  app.get("/investigations/:id/export", (req, res) => {
    const inv = getInvestigation(db, idParam.parse(req.params.id));
    const drop = db.prepare("SELECT * FROM drops WHERE id = ?").get(inv.drop_id);
    ok(res, { report: { investigation: inv, drop }, exportedAt: clock.now() });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError)
      return res.status(400).json({
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      });
    if (err instanceof ApiError)
      return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
    if (err?.code === "NOT_FOUND")
      return res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: err.message } });
    if (err?.code === "CONFLICT")
      return res.status(409).json({ ok: false, error: { code: "CONFLICT", message: err.message } });
    if (err?.type === "entity.parse.failed")
      return res.status(400).json({ ok: false, error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
    res.status(500).json({ ok: false, error: { code: "INTERNAL", message: String(err?.message ?? err) } });
  });

  return app;
}
