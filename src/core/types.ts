export type EventSource = "UE" | "ENB" | "OMC";

export type SignalEventType =
  | "MEAS_REPORT"
  | "HO_COMMAND"
  | "HO_ACK"
  | "REESTABLISH_REQ"
  | "RLF_IND"
  | "CONN_RELEASE"
  | "CELL_LOAD"
  | "CONFIG_ACTIVATE"
  | "CLOCK_SYNC";

export interface RawSignalInput {
  source: EventSource;
  sourceSeq: number;
  eventType: SignalEventType;
  terminalId?: string | undefined;
  sectorId?: string | undefined;
  targetSectorId?: string | undefined;
  configVersionId?: string | undefined;
  eventTimeMs: number;
  receivedAtMs?: number | undefined;
  payload: Record<string, unknown>;
}

export interface StoredSignal extends RawSignalInput {
  eventId: number;
  receivedAtMs: number;
  refTimeMs: number | null;
  dedupHash: string;
  importBatch: string;
}

export type HoOutcome =
  | "SUCCESS"
  | "MISSING_ACK"
  | "RLF_BEFORE_ACK"
  | "REESTABLISH_SOURCE"
  | "REESTABLISH_TARGET";

export type HoClassification =
  | "NORMAL"
  | "TOO_EARLY"
  | "TOO_LATE"
  | "PINGPONG"
  | "MISSING_ACK"
  | "RLF_UNRESOLVED";

export type RcaCategory =
  | "MISSING_NEIGHBOR"
  | "WEAK_COVERAGE"
  | "CAPACITY_CONGESTION"
  | "CLOCK_SKEW_ARTIFACT"
  | "MULTI_FACTOR"
  | "INCONCLUSIVE";

export interface TimelineState {
  terminalId: string;
  state: "CAMPED" | "HANDOVER_PENDING" | "REESTABLISHING" | "RRC_IDLE" | "DROPPED";
  sectorId: string | null;
  beginRefMs: number;
  endRefMs: number | null;
  causeEventId: number | null;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
