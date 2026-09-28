import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { normalizePagination, QueryService } from "../core/query.js";
import { InvestigationService, runAnalysis } from "../core/investigation.js";
import { compareConfigVersions, listConfigVersions } from "../core/config.js";
import type { Clock } from "../core/clock.js";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "BAD_JSON"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
}

interface Route {
  method: string;
  pattern: RegExp;
  handle: (params: Record<string, string>, req: IncomingMessage, body: unknown, deps: AppDeps, url: URL) => Promise<unknown> | unknown;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/health$/,
    handle: (_p, _r, _b, deps) => ({
      ok: true,
      maxEventId: (deps.db.prepare("SELECT COALESCE(MAX(event_id),0) AS m FROM signaling_events").get() as { m: number }).m,
    }),
  },
  { method: "POST", pattern: /^\/analyze$/, handle: (_p, _r, _b, deps) => runAnalysis(deps.db, deps.clock) },
  {
    method: "GET",
    pattern: /^\/events$/,
    handle: (_p, _r, _b, deps, url) => {
      const qs = new QueryService(deps.db);
      return paginate((q) => qs.listEvents(q), url, ["terminalId", "sectorId", "eventType"]);
    },
  },
  {
    method: "GET",
    pattern: /^\/terminals\/([^/]+)\/timeline$/,
    handle: (p, _r, _b, deps, url) => new QueryService(deps.db).timeline(p["0"]!, paginationFrom(url)),
  },
  { method: "GET", pattern: /^\/handovers$/, handle: (_p, _r, _b, deps, url) => new QueryService(deps.db).listHandovers({ ...filters(url, ["terminalId", "classification"]), ...paginationFrom(url) }) },
  { method: "GET", pattern: /^\/drops$/, handle: (_p, _r, _b, deps, url) => new QueryService(deps.db).listDrops({ ...filters(url, ["terminalId"]), ...paginationFrom(url) }) },
  {
    method: "GET",
    pattern: /^\/sectors\/([^/]+)\/config-versions$/,
    handle: (p, _r, _b, deps) => ({ sectorId: p["0"], versions: listConfigVersions(deps.db, p["0"]!) }),
  },
  {
    method: "GET",
    pattern: /^\/sectors\/([^/]+)\/config-diff$/,
    handle: (p, _r, _b, deps, url) => {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const parse = (v: string | null): number | null => {
        if (v === null || v === "") return null;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) throw new ApiError("VALIDATION_ERROR", "version must be a positive integer");
        return n;
      };
      return compareConfigVersions(deps.db, p["0"]!, parse(from), parse(to));
    },
  },
  { method: "POST", pattern: /^\/investigations$/, handle: (_p, _r, body, deps) => new InvestigationService(deps.db, deps.clock).createDraft() },
  {
    method: "GET",
    pattern: /^\/investigations$/,
    handle: (_p, _r, _b, deps, url) => {
      const pg = normalizePagination(paginationFrom(url));
      if (pg.error) throw new ApiError("VALIDATION_ERROR", pg.error);
      return new InvestigationService(deps.db, deps.clock).list(pg.limit, pg.offset);
    },
  },
  {
    method: "GET",
    pattern: /^\/investigations\/([^/]+)$/,
    handle: (p, _r, _b, deps) => requireFound(new InvestigationService(deps.db, deps.clock).get(p["0"]!), "investigation"),
  },
  {
    method: "POST",
    pattern: /^\/investigations\/([^/]+)\/publish$/,
    handle: (p, _r, _b, deps) => {
      try {
        return new InvestigationService(deps.db, deps.clock).publish(p["0"]!);
      } catch (err) {
        if ((err as { code?: string }).code === "NOT_FOUND") throw new ApiError("NOT_FOUND", (err as Error).message, 404);
        throw err;
      }
    },
  },
];

function parseVersion(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ApiError("VALIDATION_ERROR", "version must be a positive integer");
  return n;
}

function paginationFrom(url: URL) {
  return { limit: url.searchParams.get("limit") ?? undefined, offset: url.searchParams.get("offset") ?? undefined };
}

function filters(url: URL, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = url.searchParams.get(k);
    if (v !== null) out[k] = v;
  }
  return out;
}

function paginate(fn: (q: Record<string, unknown>) => unknown, url: URL, filterKeys: string[]): unknown {
  const result = fn({ ...filters(url, filterKeys), ...paginationFrom(url) }) as { error?: string };
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new ApiError("VALIDATION_ERROR", result.error);
  }
  return result;
}

function requireFound<T>(value: T | null, what: string): T {
  if (!value) throw new ApiError("NOT_FOUND", `${what} not found`, 404);
  return value;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET") return null;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("BAD_JSON", "request body must be valid JSON");
  }
}

export function createApp(deps: AppDeps): Server {
  return createServer(async (req, res) => {
    await dispatch(req, res, deps);
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, deps: AppDeps): Promise<void> {
  const send = (status: number, payload: unknown): void => {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
  };
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = await readBody(req);
    for (const route of routes) {
      const m = url.pathname.match(route.pattern);
      if (!m) continue;
      if (route.method !== req.method) throw new ApiError("METHOD_NOT_ALLOWED", `${req.method} not allowed on ${url.pathname}`, 405);
      const params: Record<string, string> = {};
      m.slice(1).forEach((g, i) => (params[String(i)] = decodeURIComponent(g!)));
      const result = await route.handle(params, req, body, deps, url);
      send(200, { data: result });
      return;
    }
    throw new ApiError("NOT_FOUND", `no route for ${url.pathname}`, 404);
  } catch (err) {
    if (err instanceof ApiError) {
      send(err.status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      return;
    }
    send(500, { error: { code: "INTERNAL_ERROR", message: (err as Error).message } });
  }
}

export function listen(server: Server, port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((r, reject) => {
            server.close((err) => (err ? reject(err) : r()));
          }),
      });
    });
  });
}

