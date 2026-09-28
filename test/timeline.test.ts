import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, meas, hoCmd, hoAck, rlf, reest, release } from "./helpers.js";

test("normal handover: CAMPED -> PENDING -> CAMPED, no drop", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([
    meas(1000, "secA", -80, [{ sectorId: "secB", rsrp: -85 }]),
    hoCmd(2000, "secA", "secB"),
    hoAck(2300, "secB"),
  ]);
  const run = h.analyze();
  assert.equal(run.recomputed.drops, 0);
  assert.equal(run.recomputed.handovers, 1);
  assert.equal(run.findings.length, 0);
  const ho = h.db.prepare("SELECT outcome, classification FROM handovers").get() as { outcome: string; classification: string };
  assert.equal(ho.outcome, "SUCCESS");
  assert.equal(ho.classification, "NORMAL");
  const states = h.db.prepare("SELECT state FROM timeline_states ORDER BY begin_ref_ms").all() as { state: string }[];
  assert.deepEqual(states.map((s) => s.state), ["CAMPED", "HANDOVER_PENDING", "CAMPED"]);
});

test("missing ack without RLF is NOT a drop", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([meas(1000, "secA", -80, []), hoCmd(2000, "secA", "secB")]);
  const run = h.analyze();
  assert.equal(run.recomputed.drops, 0);
  const ho = h.db.prepare("SELECT classification FROM handovers").get() as { classification: string };
  assert.equal(ho.classification, "MISSING_ACK");
});

test("late arriving ack after gap but before recompute still yields success (no false drop)", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([hoCmd(2000, "secA", "secB")]);
  h.analyze();
  assert.equal((h.db.prepare("SELECT classification FROM handovers").get() as { classification: string }).classification, "MISSING_ACK");
  h.import([hoAck(2500, "secB")]);
  const run = h.analyze();
  assert.equal(run.recomputed.drops, 0);
  assert.equal((h.db.prepare("SELECT outcome FROM handovers").get() as { outcome: string }).outcome, "SUCCESS");
});

test("out of order arrival sorted by calibrated time produces no false drop", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([
    hoAck(2500, "secB"),
    hoCmd(2000, "secA", "secB"),
    meas(1500, "secA", -80, [{ sectorId: "secB", rsrp: -82 }]),
  ]);
  const run = h.analyze();
  assert.equal(run.recomputed.drops, 0);
  assert.equal((h.db.prepare("SELECT outcome FROM handovers").get() as { outcome: string }).outcome, "SUCCESS");
});

test("duplicate signaling is ignored and never doubles state", () => {
  const h = makeHarness();
  h.seedSectors();
  const cmd = hoCmd(2000, "secA", "secB");
  const res1 = h.import([cmd]);
  const res2 = h.import([{ ...cmd }], "batch_retry");
  assert.equal(res1.inserted, 1);
  assert.equal(res2.inserted, 0);
  assert.equal(res2.duplicates, 1);
  h.import([hoAck(2300, "secB")]);
  h.analyze();
  assert.equal((h.db.prepare("SELECT COUNT(*) AS c FROM handovers").get() as { c: number }).c, 1);
});

test("too early: RLF after command then re-establish on source", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([hoCmd(2000, "secA", "secB"), rlf(2200, "secB"), reest(2400, "secA")]);
  h.analyze();
  const ho = h.db.prepare("SELECT outcome, classification FROM handovers").get() as { outcome: string; classification: string };
  assert.equal(ho.outcome, "REESTABLISH_SOURCE");
  assert.equal(ho.classification, "TOO_EARLY");
  assert.equal((h.db.prepare("SELECT COUNT(*) AS c FROM drops").get() as { c: number }).c, 1);
});

test("too late: RLF on source then re-establish on target", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([meas(1000, "secA", -112, []), rlf(1900, "secA"), reest(2100, "secB")]);
  h.analyze();
  const findings = h.db.prepare("SELECT category FROM investigation_findings");
  void findings;
  const drop = h.db.prepare("SELECT COUNT(*) AS c FROM drops").get() as { c: number };
  assert.equal(drop.c, 1);
});

test("ping-pong within window classifies both handovers", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([
    hoCmd(1000, "secA", "secB"), hoAck(1200, "secB"),
    hoCmd(3000, "secB", "secA"), hoAck(3200, "secA"),
  ]);
  h.analyze();
  const rows = h.db.prepare("SELECT classification FROM handovers ORDER BY cmd_ref_ms").all() as { classification: string }[];
  assert.ok(rows.every((r) => r.classification === "PINGPONG"));
  const group = h.db.prepare("SELECT DISTINCT pingpong_group_id AS g FROM handovers").all() as { g: number }[];
  assert.equal(group.length, 1);
});

test("distant return handover is not ping-pong", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([
    hoCmd(1000, "secA", "secB"), hoAck(1200, "secB"),
    hoCmd(9000, "secB", "secA"), hoAck(9200, "secA"),
  ]);
  h.analyze();
  const rows = h.db.prepare("SELECT classification FROM handovers ORDER BY cmd_ref_ms").all() as { classification: string }[];
  assert.ok(rows.every((r) => r.classification === "NORMAL"));
});

test("normal release creates no drop", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([meas(1000, "secA", -75, []), release(5000, "secA")]);
  const run = h.analyze();
  assert.equal(run.recomputed.drops, 0);
});

