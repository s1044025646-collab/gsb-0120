import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.js";
import { fakeClock } from "../src/core/clock.js";
import { createApp, listen } from "../src/api/app.js";
import { ScenarioGenerator } from "../src/ingest/generator.js";
import { importScenario } from "../src/ingest/importer.js";
import type { Server } from "node:http";

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cell-api-"));
  const dbPath = join(dir, "t.sqlite");
  const clock = fakeClock(1_000_000);
  {
    const db = openDatabase(dbPath);
    const out = new ScenarioGenerator({ seed: 5 }).generate("config_repair");
    importScenario(db, out, clock, { recompute: true });
    db.close();
  }
  const db = openDatabase(dbPath);
  const server: Server = createApp({ db, clock });
  const bound = await listen(server, 0);
  try {
    await fn(`http://127.0.0.1:${bound.port}`);
  } finally {
    await bound.close();
    db.close();
  }
}

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

test("GET /health reports stored event count after reopen", async () => {
  await withServer(async (base) => {
    const { status, body } = await getJson(base, "/health");
    assert.equal(status, 200);
    assert.ok(body.data.maxEventId >= 3);
  });
});

test("GET /events paginates with limit/offset", async () => {
  await withServer(async (base) => {
    const page1 = await getJson(base, "/events?limit=2&offset=0");
    assert.equal(page1.body.data.items.length, 2);
    assert.equal(page1.body.data.limit, 2);
    assert.equal(page1.body.data.offset, 0);
    const page2 = await getJson(base, "/events?limit=2&offset=2");
    assert.deepEqual(page1.body.data.items.map((e: any) => e.event_id), [1, 2]);
    assert.deepEqual(page2.body.data.items.map((e: any) => e.event_id), [3, 4]);
  });
});

test("invalid limit returns VALIDATION_ERROR with 400", async () => {
  await withServer(async (base) => {
    const { status, body } = await getJson(base, "/events?limit=-3");
    assert.equal(status, 400);
    assert.equal(body.error.code, "VALIDATION_ERROR");
  });
});

test("unknown route returns NOT_FOUND", async () => {
  await withServer(async (base) => {
    const { status, body } = await getJson(base, "/nope");
    assert.equal(status, 404);
    assert.equal(body.error.code, "NOT_FOUND");
  });
});

test("investigation create/publish/get flow freezes the report", async () => {
  await withServer(async (base) => {
    const created = await fetch(base + "/investigations", { method: "POST", body: "{}" }).then((r) => r.json());
    const id = created.data.investigationId as string;
    assert.ok(id.startsWith("inv_"));
    const pub = await fetch(base + `/investigations/${id}/publish`, { method: "POST" });
    assert.equal(pub.status, 200);
    const got = await getJson(base, `/investigations/${id}`);
    assert.equal(got.body.data.status, "PUBLISHED");
    assert.ok(Array.isArray(got.body.data.findings));
  });
});

test("config diff shows neighbor added by the repair version", async () => {
  await withServer(async (base) => {
    const diff = await getJson(base, "/sectors/secA/config-diff?from=1&to=2");
    assert.equal(diff.status, 200, JSON.stringify(diff.body));
    assert.deepEqual(diff.body.data.added, ["secB"]);
  });
});
