import type { DatabaseSync } from "node:sqlite";

export interface ConfigDiff {
  sectorId: string;
  fromVersion: number | null;
  toVersion: number | null;
  added: string[];
  removed: string[];
  unchanged: string[];
}

export function listConfigVersions(db: DatabaseSync, sectorId: string): { configVersionId: string; version: number; effectiveAtMs: number }[] {
  return db
    .prepare(
      `SELECT config_version_id AS configVersionId, version, effective_at_ms AS effectiveAtMs
       FROM nbr_config_versions WHERE sector_id = ? ORDER BY version`,
    )
    .all(sectorId) as { configVersionId: string; version: number; effectiveAtMs: number }[];
}

export function compareConfigVersions(
  db: DatabaseSync,
  sectorId: string,
  fromVersion: number | null,
  toVersion: number | null,
): ConfigDiff {
  const neighborsOf = (version: number | null): Set<string> => {
    if (version === null) return new Set();
    const stmt = db.prepare(
      "SELECT config_version_id FROM nbr_config_versions WHERE sector_id = ? AND version = ?",
    );
    const cv = stmt.get(sectorId, version) as { config_version_id: string } | undefined;
    if (!cv) throw new ConfigVersionError("NOT_FOUND", `${sectorId} v${version} not found`);
    const rows = db.prepare("SELECT neighbor_sector_id FROM nbr_entries WHERE config_version_id = ?").all(cv.config_version_id) as { neighbor_sector_id: string }[];
    return new Set(rows.map((r) => r.neighbor_sector_id));
  };
  const a = neighborsOf(fromVersion);
  const b = neighborsOf(toVersion);
  const added = [...b].filter((n) => !a.has(n)).sort();
  const removed = [...a].filter((n) => !b.has(n)).sort();
  const unchanged = [...a].filter((n) => b.has(n)).sort();
  return { sectorId, fromVersion, toVersion, added, removed, unchanged };
}

export class ConfigVersionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigVersionError";
  }
}
