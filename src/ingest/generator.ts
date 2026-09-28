import { gaussian, seededRng, type Rng } from "../core/clock.js";
import type { RawSignalInput, SignalEventType } from "../core/types.js";

export interface GeneratorOptions {
  seed?: number;
  startTimeMs?: number;
  rng?: Rng;
  clock?: { now(): number };
}

export interface SectorSpec {
  sectorId: string;
  siteId: string;
  pci: number;
  earfcn: number;
  maxErlangs: number;
}

export interface GeneratedConfig {
  configVersionId: string;
  sectorId: string;
  version: number;
  effectiveAtMs: number;
  importedAtMs: number;
  neighbors: string[];
}

export interface GeneratedClock {
  sectorId: string;
  validFromMs: number;
  offsetMs: number;
  confidence: number;
}

export interface ScenarioOutput {
  scenario: string;
  sectors: SectorSpec[];
  terminals: { terminalId: string; pseudonym: string; registeredAtMs: number }[];
  configs: GeneratedConfig[];
  clocks: GeneratedClock[];
  signals: RawSignalInput[];
}

export const SCENARIOS = [
  "normal",
  "high_speed",
  "signal_jitter",
  "clock_skew",
  "missing_ack",
  "duplicates",
  "pingpong",
  "missing_neighbor",
  "congestion",
  "config_repair",
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

interface B {
  source: "UE" | "ENB" | "OMC";
  seq: number;
}

export class ScenarioGenerator {
  private readonly rng: Rng;
  private readonly t0: number;
  private readonly clocks = new Map<string, number>();
  private readonly configs: GeneratedConfig[] = [];
  private readonly clocksOut: GeneratedClock[] = [];
  private readonly signals: RawSignalInput[] = [];
  private readonly seq: B = { source: "UE", seq: 0 };
  private readonly seqs: Record<string, number> = { UE: 0, ENB: 0, OMC: 0 };
  private readonly sectors: SectorSpec[] = [];
  private readonly terminals: { terminalId: string; pseudonym: string; registeredAtMs: number }[] = [];
  private receiveCounter = 0;

  constructor(private readonly opts: GeneratorOptions = {}) {
    this.rng = opts.rng ?? seededRng(opts.seed ?? 42);
    this.t0 = opts.startTimeMs ?? 1_000_000;
  }

  generate(scenario: ScenarioName): ScenarioOutput {
    this.sectors.push(
      { sectorId: "secA", siteId: "site1", pci: 101, earfcn: 1800, maxErlangs: 50 },
      { sectorId: "secB", siteId: "site2", pci: 202, earfcn: 1800, maxErlangs: 50 },
      { sectorId: "secC", siteId: "site3", pci: 303, earfcn: 2100, maxErlangs: 50 },
    );
    this.terminals.push({ terminalId: "ue1", pseudonym: "anon-9f3a", registeredAtMs: this.t0 });

    switch (scenario) {
      case "normal": this.normal(); break;
      case "high_speed": this.highSpeed(); break;
      case "signal_jitter": this.signalJitter(); break;
      case "clock_skew": this.clockSkew(); break;
      case "missing_ack": this.missingAck(); break;
      case "duplicates": this.duplicates(); break;
      case "pingpong": this.pingpong(); break;
      case "missing_neighbor": this.missingNeighbor(false); break;
      case "congestion": this.congestion(); break;
      case "config_repair": this.missingNeighbor(true); break;
      default: throw new Error(`unknown scenario ${scenario as string}`);
    }

    return {
      scenario,
      sectors: this.sectors,
      terminals: this.terminals,
      configs: this.configs,
      clocks: this.clocksOut,
      signals: this.signals,
    };
  }

  private addConfig(sectorId: string, version: number, effectiveAtMs: number, neighbors: string[]): void {
    this.configs.push({
      configVersionId: `${sectorId}_v${version}`,
      sectorId,
      version,
      effectiveAtMs,
      importedAtMs: this.t0 - 1000,
      neighbors,
    });
  }

  private setClock(sectorId: string, offsetMs: number, validFromMs = 0): void {
    this.clocks.set(sectorId, offsetMs);
    this.clocksOut.push({ sectorId, validFromMs, offsetMs, confidence: 0.95 });
  }

  // Emit at device-reported time; receivedAt is arrival order and can be shuffled.
  private emit(
    eventType: SignalEventType,
    deviceTimeMs: number,
    fields: Partial<RawSignalInput> = {},
    source: RawSignalInput["source"] = "UE",
    skipSectorClock = false,
  ): RawSignalInput {
    // The stored event time is always the raw device-reported time; clock
    // calibration is applied exactly once, during analysis.
    void skipSectorClock;
    const sectorClock = 0;
    const targetClock = fields.targetSectorId ? (this.clocks.get(fields.targetSectorId) ?? 0) : 0;
    void targetClock;
    const event: RawSignalInput = {
      source,
      sourceSeq: ++this.seqs[source]!,
      eventType,
      terminalId: Object.prototype.hasOwnProperty.call(fields, "terminalId") ? fields.terminalId : "ue1",
      sectorId: fields.sectorId,
      targetSectorId: fields.targetSectorId,
      configVersionId: fields.configVersionId,
      eventTimeMs: deviceTimeMs + sectorClock,
      receivedAtMs: this.t0 + 10_000 + this.receiveCounter++,
      payload: fields.payload ?? {},
    };
    this.signals.push(event);
    return event;
  }

  private meas(t: number, serving: string, rsrp: number, cells: { sectorId: string; rsrp: number }[]): void {
    this.emit("MEAS_REPORT", t, { sectorId: serving, payload: { servingSectorId: serving, servingRsrp: Math.round(rsrp), cells: cells.map((c) => ({ sectorId: c.sectorId, rsrp: Math.round(c.rsrp) })) } });
  }
  private cmd(t: number, from: string, to: string): RawSignalInput {
    return this.emit("HO_COMMAND", t, { sectorId: from, targetSectorId: to, payload: { targetSectorId: to } }, "ENB");
  }
  private ack(t: number, sector: string): RawSignalInput {
    return this.emit("HO_ACK", t, { sectorId: sector, payload: { servingSectorId: sector } }, "UE", true);
  }
  private rlf(t: number, sector: string): void {
    this.emit("RLF_IND", t, { sectorId: sector, payload: { servingSectorId: sector } });
  }
  private reest(t: number, sector: string): void {
    this.emit("REESTABLISH_REQ", t, { sectorId: sector, payload: { servingSectorId: sector } });
  }
  private load(t: number, sector: string, loadRatio: number, rejected = false): void {
    this.emit("CELL_LOAD", t, { sectorId: sector, payload: { sectorId: sector, loadRatio, ...(rejected ? { admissionRejected: true, rejectCause: "CONGESTION" } : {}) } }, "OMC");
  }

  private normal(): void {
    this.addConfig("secA", 1, 0, ["secB", "secC"]);
    this.meas(1000, "secA", -80, [{ sectorId: "secB", rsrp: -88 }]);
    this.cmd(2000, "secA", "secB");
    this.ack(2300, "secB");
  }

  private highSpeed(): void {
    this.addConfig("secA", 1, 0, ["secB", "secC"]);
    this.addConfig("secB", 1, 0, ["secA", "secC"]);
    let t = 0;
    let rsrpA = -75;
    let rsrpB = -105;
    this.meas((t = 500), "secA", rsrpA, [{ sectorId: "secB", rsrp: rsrpB }]);
    this.cmd(1200, "secA", "secB");
    this.ack(1500, "secB");
    rsrpA = -108; rsrpB = -78;
    this.meas(2500, "secB", rsrpB, [{ sectorId: "secA", rsrp: rsrpA }, { sectorId: "secC", rsrp: -100 }]);
  }

  private signalJitter(): void {
    this.addConfig("secA", 1, 0, ["secB"]);
    for (let i = 0; i < 8; i++) {
      const t = 500 + i * 300;
      const rsrp = -95 + gaussian(this.rng, 0, 12);
      const b = -100 + gaussian(this.rng, 0, 10);
      this.meas(t, "secA", rsrp, [{ sectorId: "secB", rsrp: b }]);
    }
    this.cmd(3000, "secA", "secB");
    this.ack(3200, "secB");
  }

  private clockSkew(): void {
    this.addConfig("secA", 1, 0, ["secB"]);
    // B's clock runs 3000ms fast: it reports device times that are 3000ms too
    // large, so calibration subtracts 3000. The raw feed would place the ACK
    // long after the command; only calibration yields the correct ordering.
    this.setClock("secB", -3000);
    this.meas(1000, "secA", -82, [{ sectorId: "secB", rsrp: -90 }]);
    this.cmd(2000, "secA", "secB");
    // Raw ACK at 5200 on B calibrates to 2200 reference (inside ACK window).
    this.ack(5200, "secB");
    this.meas(6000, "secB", -78, [{ sectorId: "secA", rsrp: -104 }]);
  }

  private missingAck(): void {
    this.addConfig("secA", 1, 0, ["secB"]);
    this.meas(1000, "secA", -85, [{ sectorId: "secB", rsrp: -90 }]);
    this.cmd(2000, "secA", "secB");
    // no HO_ACK; also no RLF -> must not be counted as a drop
  }

  private duplicates(): void {
    this.addConfig("secA", 1, 0, ["secB"]);
    this.meas(1000, "secA", -80, [{ sectorId: "secB", rsrp: -89 }]);
    const c = this.cmd(2000, "secA", "secB");
    const a = this.ack(2300, "secB");
    this.signals.push({ ...c, receivedAtMs: this.t0 + 20_000 });
    this.signals.push({ ...a, receivedAtMs: this.t0 + 20_001 });
  }

  private pingpong(): void {
    this.addConfig("secA", 1, 0, ["secB"]);
    this.addConfig("secB", 1, 0, ["secA"]);
    this.cmd(1000, "secA", "secB");
    this.ack(1200, "secB");
    this.meas(2000, "secB", -92, [{ sectorId: "secA", rsrp: -80 }]);
    this.cmd(3000, "secB", "secA");
    this.ack(3200, "secA");
  }

  private missingNeighbor(withRepair: boolean): void {
    this.addConfig("secA", 1, 0, ["secC"]); // secB missing
    this.meas(1000, "secA", -96, [{ sectorId: "secB", rsrp: -88 }, { sectorId: "secC", rsrp: -118 }]);
    this.cmd(1200, "secA", "secC");
    this.rlf(1400, "secC");
    if (withRepair) {
      this.addConfig("secA", 2, 5000, ["secB", "secC"]);
      this.meas(6000, "secA", -75, [{ sectorId: "secB", rsrp: -77 }]);
    }
  }

  private congestion(): void {
    this.addConfig("secA", 1, 0, ["secB"]);
    this.load(700, "secA", 0.62);
    this.load(1100, "secA", 0.96, true);
    this.meas(1000, "secA", -82, [{ sectorId: "secB", rsrp: -108 }]);
    this.rlf(1400, "secA");
  }
}
