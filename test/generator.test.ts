import { test } from "node:test";
import assert from "node:assert/strict";
import { ScenarioGenerator, SCENARIOS } from "../src/ingest/generator.js";

test("every built-in scenario generates a coherent signal feed", () => {
  for (const name of SCENARIOS) {
    const out = new ScenarioGenerator({ seed: 7 }).generate(name);
    assert.ok(out.sectors.length >= 3, name);
    assert.ok(out.signals.length > 0, name);
    for (const s of out.signals) {
      assert.ok(["UE", "ENB", "OMC"].includes(s.source), name);
      assert.equal(typeof s.eventTimeMs, "number", name);
    }
  }
});

test("generator is deterministic for a fixed seed", () => {
  const a = new ScenarioGenerator({ seed: 123 }).generate("signal_jitter");
  const b = new ScenarioGenerator({ seed: 123 }).generate("signal_jitter");
  assert.deepEqual(a.signals, b.signals);
});

test("duplicates scenario contains byte-identical re-delivered signaling", () => {
  const out = new ScenarioGenerator({ seed: 1 }).generate("duplicates");
  const keys = out.signals.map((s) => `${s.source}:${s.sourceSeq}`);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.ok(dupes.length >= 2);
});

test("clock skew scenario keeps arrival order distinct from device order", () => {
  const out = new ScenarioGenerator({ seed: 1 }).generate("clock_skew");
  assert.ok(out.clocks.some((c) => Math.abs(c.offsetMs) >= 1000));
  const ack = out.signals.find((s) => s.eventType === "HO_ACK")!;
  const cmd = out.signals.find((s) => s.eventType === "HO_COMMAND")!;
  assert.ok(ack.receivedAtMs! > cmd.receivedAtMs!);
});
