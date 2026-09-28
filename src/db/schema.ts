// Idempotent SQLite schema migrations. Each migration is applied exactly once,
// tracked in the schema_migrations table. Re-running on an existing database
// is a no-op (safe after process restart).
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE terminals (
      terminal_id      TEXT PRIMARY KEY,
      pseudonym        TEXT NOT NULL UNIQUE,
      registered_at_ms INTEGER NOT NULL
    );

    CREATE TABLE sectors (
      sector_id   TEXT PRIMARY KEY,
      site_id     TEXT NOT NULL,
      pci         INTEGER NOT NULL,
      earfcn      INTEGER NOT NULL,
      max_erlangs REAL NOT NULL DEFAULT 50.0,
      UNIQUE (earfcn, pci)
    );

    CREATE TABLE nbr_config_versions (
      config_version_id TEXT PRIMARY KEY,
      sector_id         TEXT NOT NULL REFERENCES sectors(sector_id),
      version           INTEGER NOT NULL,
      effective_at_ms   INTEGER NOT NULL,
      imported_at_ms    INTEGER NOT NULL,
      UNIQUE (sector_id, version)
    );

    CREATE TABLE nbr_entries (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      config_version_id  TEXT NOT NULL REFERENCES nbr_config_versions(config_version_id),
      neighbor_sector_id TEXT NOT NULL REFERENCES sectors(sector_id),
      pci_offset         INTEGER NOT NULL DEFAULT 0,
      UNIQUE (config_version_id, neighbor_sector_id)
    );

    -- Calibrated reference time = sector reported time + offset_ms
    CREATE TABLE clock_calibrations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sector_id     TEXT NOT NULL REFERENCES sectors(sector_id),
      valid_from_ms INTEGER NOT NULL,
      offset_ms     INTEGER NOT NULL,
      confidence    REAL NOT NULL DEFAULT 1.0,
      created_at_ms INTEGER NOT NULL,
      UNIQUE (sector_id, valid_from_ms)
    );

    -- Immutable raw signaling feed. Original source, source sequence and
    -- arrival order are always preserved.
    CREATE TABLE signaling_events (
      event_id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source            TEXT NOT NULL CHECK (source IN ('UE','ENB','OMC')),
      source_seq        INTEGER NOT NULL,
      event_type        TEXT NOT NULL,
      terminal_id       TEXT REFERENCES terminals(terminal_id),
      sector_id         TEXT REFERENCES sectors(sector_id),
      target_sector_id  TEXT REFERENCES sectors(sector_id),
      config_version_id TEXT REFERENCES nbr_config_versions(config_version_id),
      event_time_ms     INTEGER NOT NULL,
      received_at_ms    INTEGER NOT NULL,
      ref_time_ms       INTEGER,
      payload_json      TEXT NOT NULL,
      dedup_hash        TEXT NOT NULL,
      import_batch      TEXT NOT NULL,
      UNIQUE (source, source_seq, dedup_hash)
    );

    CREATE INDEX idx_sig_terminal_time ON signaling_events(terminal_id, ref_time_ms, event_id);
    CREATE INDEX idx_sig_sector_time   ON signaling_events(sector_id, ref_time_ms);
    CREATE INDEX idx_sig_received      ON signaling_events(received_at_ms, event_id);

    -- Recomputed state transitions; rebuilt by the timeline pass.
    CREATE TABLE timeline_states (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id     TEXT NOT NULL REFERENCES terminals(terminal_id),
      state           TEXT NOT NULL,
      sector_id       TEXT REFERENCES sectors(sector_id),
      begin_ref_ms    INTEGER NOT NULL,
      end_ref_ms      INTEGER,
      cause_event_id  INTEGER REFERENCES signaling_events(event_id),
      recompute_batch TEXT NOT NULL
    );
    CREATE INDEX idx_tl_terminal ON timeline_states(terminal_id, begin_ref_ms);

    CREATE TABLE handovers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id       TEXT NOT NULL,
      from_sector_id    TEXT NOT NULL,
      to_sector_id      TEXT NOT NULL,
      command_event_id  INTEGER NOT NULL,
      ack_event_id      INTEGER,
      cmd_ref_ms        INTEGER NOT NULL,
      ack_ref_ms        INTEGER,
      outcome           TEXT NOT NULL,
      classification    TEXT NOT NULL,
      pingpong_group_id INTEGER,
      rerun_token       TEXT NOT NULL,
      UNIQUE (command_event_id, rerun_token)
    );

    CREATE TABLE drops (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id     TEXT NOT NULL,
      sector_id       TEXT NOT NULL,
      detected_ref_ms INTEGER NOT NULL,
      last_event_id   INTEGER NOT NULL,
      rerun_token     TEXT NOT NULL,
      UNIQUE (terminal_id, last_event_id, rerun_token)
    );

    -- Published investigations are immutable and reproducible.
    CREATE TABLE investigations (
      investigation_id TEXT PRIMARY KEY,
      status           TEXT NOT NULL CHECK (status IN ('DRAFT','PUBLISHED')),
      created_at_ms    INTEGER NOT NULL,
      published_at_ms  INTEGER,
      snapshot_json    TEXT NOT NULL,
      max_event_id     INTEGER NOT NULL,
      report_json      TEXT
    );

    CREATE TABLE investigation_findings (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      investigation_id      TEXT NOT NULL REFERENCES investigations(investigation_id),
      drop_id               INTEGER,
      terminal_id           TEXT,
      category              TEXT NOT NULL,
      verdict               TEXT NOT NULL,
      confidence            REAL NOT NULL,
      evidence_json         TEXT NOT NULL,
      counter_evidence_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_find_inv ON investigation_findings(investigation_id);
    `,
  },
];
