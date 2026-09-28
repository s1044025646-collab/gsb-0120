#!/usr/bin/env node
import * as fs from "fs";
import { openDb } from "./db";
import { Service, EventInput } from "./service";
import { rebuildTimeline, getTimeline } from "./timeline";
import { investigate, getInvestigation, publishInvestigation } from "./analyze";
import { seedNetwork, generateAll } from "./fixtures";

const dbPath = process.env.DB_PATH ?? "data.sqlite";
const db = openDb(dbPath);
const svc = new Service(db);

const [, , cmd, ...args] = process.argv;
const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const fail = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

function counts() {
  const c = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n;
  return { events: c("events"), drops: c("drops"), timelines: c("timelines"), investigations: c("investigations") };
}

function main() {
  switch (cmd) {
    case "import": {
      const file = args[0];
      if (!file) fail("usage: import <events.json>");
      const events = JSON.parse(fs.readFileSync(file, "utf8")) as EventInput[];
      console.log("before:", JSON.stringify(counts()));
      const r = svc.importEvents(events);
      console.log("after:", JSON.stringify(counts()));
      out(r);
      break;
    }
    case "rebuild": {
      const terminalId = Number(args[0]);
      if (!terminalId) fail("usage: rebuild <terminalId>");
      const before = getTimeline(db, terminalId);
      console.log("before:", before ? `inputHash=${before.inputHash.slice(0, 12)} handovers=${before.handovers.length}` : "(none)");
      const state = rebuildTimeline(db, svc, terminalId);
      console.log(`after: handovers=${state.handovers.length} drops=${state.drops.length}`);
      out(state);
      break;
    }
    case "analyze": {
      const dropId = Number(args[0]);
      if (!dropId) fail("usage: analyze <dropId>");
      console.log("before:", JSON.stringify(counts()));
      const r = investigate(db, svc, dropId);
      console.log("after:", JSON.stringify(counts()));
      out(r);
      break;
    }
    case "evidence": {
      const id = Number(args[0]);
      if (!id) fail("usage: evidence <investigationId>");
      out(getInvestigation(db, id));
      break;
    }
    case "publish": {
      const id = Number(args[0]);
      if (!id) fail("usage: publish <investigationId>");
      out(publishInvestigation(db, id));
      break;
    }
    case "compare-config": {
      const [a, b] = args.map(Number);
      if (!a || !b) fail("usage: compare-config <versionA> <versionB>");
      out(svc.compareConfigVersions(a, b));
      break;
    }
    case "export": {
      const id = Number(args[0]);
      if (!id) fail("usage: export <investigationId>");
      const inv = getInvestigation(db, id);
      const drop = db.prepare("SELECT * FROM drops WHERE id = ?").get(inv.drop_id);
      const report = { investigation: inv, drop, exportedAt: Date.now() };
      const file = `investigation-${id}.json`;
      fs.writeFileSync(file, JSON.stringify(report, null, 2));
      console.log(`written: ${file}`);
      break;
    }
    case "fixtures": {
      console.log("before:", JSON.stringify(counts()));
      const ctx = seedNetwork(db, svc);
      const scenarios = generateAll(ctx);
      for (const evs of Object.values(scenarios)) svc.importEvents(evs);
      for (const tid of Object.values(ctx.terminals)) rebuildTimeline(db, svc, tid);
      console.log("after:", JSON.stringify(counts()));
      out({ terminals: ctx.terminals, cells: ctx.cells });
      break;
    }
    case "status":
      out(counts());
      break;
    default:
      console.log(`commands:
  fixtures                 generate fictional network + all scenarios
  import <events.json>     import signaling events (shows before/after counts)
  rebuild <terminalId>     rebuild terminal timeline state machine
  analyze <dropId>         run root-cause analysis for a drop
  evidence <invId>         show evidence & counter-evidence
  publish <invId>          publish an investigation (immutable afterwards)
  compare-config <a> <b>   diff two neighbor config versions
  export <invId>           export investigation report JSON
  status                   show table counts`);
  }
}

main();
db.close();
