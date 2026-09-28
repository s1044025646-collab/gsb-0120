export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_init",
    sql: `
CREATE TABLE terminals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anon_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE cells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  tech TEXT NOT NULL DEFAULT 'LTE',
  created_at INTEGER NOT NULL
);

CREATE TABLE neighbor_config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE neighbor_config_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES neighbor_config_versions(id),
  source_cell_id INTEGER NOT NULL REFERENCES cells(id),
  target_cell_id INTEGER NOT NULL REFERENCES cells(id),
  priority INTEGER NOT NULL DEFAULT 0,
  UNIQUE (version_id, source_cell_id, target_cell_id)
);

-- Which config version was active on a cell starting at a given (corrected) time.
CREATE TABLE config_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id INTEGER NOT NULL REFERENCES cells(id),
  version_id INTEGER NOT NULL REFERENCES neighbor_config_versions(id),
  effective_from INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE clock_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_id INTEGER NOT NULL REFERENCES cells(id),
  offset_ms INTEGER NOT NULL,
  effective_from INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Raw signaling: order of arrival (id) and source are always preserved.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id INTEGER NOT NULL REFERENCES terminals(id),
  type TEXT NOT NULL CHECK (type IN
    ('measurement_report','handover_command','handover_receipt','signal_strength','drop','cell_load')),
  cell_id INTEGER REFERENCES cells(id),
  target_cell_id INTEGER REFERENCES cells(id),
  payload TEXT NOT NULL DEFAULT '{}',
  device_time INTEGER NOT NULL,
  corrected_time INTEGER NOT NULL,
  source TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_terminal ON events (terminal_id, corrected_time, id);

CREATE TABLE timelines (
  terminal_id INTEGER PRIMARY KEY REFERENCES terminals(id),
  state TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  rebuilt_at INTEGER NOT NULL
);

CREATE TABLE drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_id INTEGER NOT NULL REFERENCES terminals(id),
  cell_id INTEGER REFERENCES cells(id),
  detected_at INTEGER NOT NULL,
  context TEXT NOT NULL DEFAULT '{}',
  UNIQUE (terminal_id, detected_at)
);

CREATE TABLE investigations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drop_id INTEGER NOT NULL REFERENCES drops(id),
  batch_id INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  root_cause TEXT NOT NULL,
  evidence TEXT NOT NULL,
  counter_evidence TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TABLE batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at INTEGER NOT NULL
);
`,
  },
];
