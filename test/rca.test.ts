import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, meas, hoCmd, rlf, reest, sig } from "./helpers.js";
import { InvestigationService } from "../src/core/investigation.js";

function loadEvent(t: number, sector: string, loadRatio: number) {
  return sig({ eventType: "CELL_LOAD", eventTimeMs: t, sectorId: sector, source: "ENB", terminalId: undefined, payload: { sectorId: sector, loadRatio } });
}

test("RCA: missing neighbor backed by strong measurement and config repair", () => {
  const h = makeHarness();
  h.seedSectors();
  // v1 config of secA lists only secC; UE measures strong secB.
  h.repo.upsertConfigVersion({
    configVersionId: "cfgA1", sectorId: "secA", version: 1,
    effectiveAtMs: 0, importedAtMs: h.clock.now(), neighbors: ["secC"],
  });
  h.import([
    meas(1000, "secA", -95, [{ sectorId: "secB", rsrp: -88 }, { sectorId: "secC", rsrp: -118 }]),
    hoCmd(1200, "secA", "secC"),
    rlf(1400, "secC"),
  ]);
  let run = h.analyze();
  assert.equal(run.findings.length, 1);
  assert.equal(run.findings[0]!.category, "MISSING_NEIGHBOR");
  assert.ok(run.findings[0]!.evidence.some((e) => /absent from config/.test(e.detail)));

  // Repair: new config version adds secB after the drop.
  h.repo.upsertConfigVersion({
    configVersionId: "cfgA2", sectorId: "secA", version: 2,
    effectiveAtMs: 5000, importedAtMs: h.clock.now(), neighbors: ["secB", "secC"],
  });
  run = h.analyze();
  assert.ok(run.findings[0]!.evidence.some((e) => /repair evidence/.test(e.detail)));
});

test("RCA: weak coverage includes counter evidence when serving was healthy", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([
    meas(1000, "secA", -115, []),
    meas(500, "secA", -70, []),
    rlf(1400, "secA"),
  ]);
  const run = h.analyze();
  assert.equal(run.findings[0]!.category, "WEAK_COVERAGE");
  assert.ok(run.findings[0]!.counterEvidence.some((e) => /healthy/.test(e.detail)));
});

test("RCA: congestion needs load evidence, not proximity to last event", () => {
  const h = makeHarness();
  h.seedSectors();
  h.import([loadEvent(900, "secA", 0.95), meas(1000, "secA", -80, []), rlf(1200, "secA")]);
  let run = h.analyze();
  assert.equal(run.findings[0]!.category, "CAPACITY_CONGESTION");

  const h2 = makeHarness();
  h2.seedSectors();
  h2.import([loadEvent(900, "secA", 0.3), meas(1000, "secA", -113, []), rlf(1200, "secA")]);
  run = h2.analyze();
  assert.notEqual(run.findings[0]!.category, "CAPACITY_CONGESTION");
  assert.equal(run.findings[0]!.category, "WEAK_COVERAGE");
});

test("clock skew calibration reorders events across sectors without false drops", () => {
  const h = makeHarness();
  h.seedSectors();
  // secB clock runs 3000ms fast: subtract 3000 to reach reference time.
  h.repo.addClockCalibration({ sectorId: "secB", validFromMs: 0, offsetMs: -3000, createdAtMs: h.clock.now() });
  h.import([
    { ...hoCmd(2000, "secA", "secB") },
    // raw 5200 on B -> calibrated 2200, still inside the ACK window
    { ...sig({ eventType: "HO_ACK", eventTimeMs: 5200, sectorId: "secB", source: "UE", payload: { servingSectorId: "secB" } }) },
  ]);
  const run = h.analyze();
  assert.equal(run.recomputed.drops, 0);
  assert.equal(run.recomputed.handovers, 1);
});

test("published investigation is immutable after late events and recompute", () => {
  const h = makeHarness();
  h.seedSectors();
  h.repo.upsertConfigVersion({
    configVersionId: "cfgA1", sectorId: "secA", version: 1,
    effectiveAtMs: 0, importedAtMs: h.clock.now(), neighbors: ["secC"],
  });
  h.import([meas(1000, "secA", -95, [{ sectorId: "secB", rsrp: -88 }]), rlf(1400, "secA")]);
  const run = h.analyze();
  const service = new InvestigationService(h.db, h.clock);
  const draft = service.createDraft(run);
  const published = service.publish(draft.investigationId);
  assert.equal(published.status, "PUBLISHED");
  const snapshot = JSON.stringify(published.findings);

  // Late-arriving config repair + more events trigger recompute for new drafts.
  h.repo.upsertConfigVersion({
    configVersionId: "cfgA2", sectorId: "secA", version: 2,
    effectiveAtMs: 5000, importedAtMs: h.clock.now(), neighbors: ["secB", "secC"],
  });
  h.import([meas(6000, "secA", -75, [{ sectorId: "secB", rsrp: -77 }])]);
  const run2 = h.analyze();
  const draft2 = service.createDraft(run2);
  assert.notEqual(snapshot, JSON.stringify(draft2.findings));

  const reread = service.get(published.investigationId)!;
  assert.equal(JSON.stringify(reread.findings), snapshot);
  assert.equal(reread.status, "PUBLISHED");
});

