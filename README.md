# cellular-handover-rca

A **local, offline Windows backend** for cellular handover event reconstruction and
dropped-call root-cause analysis. It uses **only synthetic base stations, anonymous
terminals and fabricated signaling**. There is no web UI and no connection to any real
operator network.

Stack: TypeScript + Node.js (built-in `node:sqlite`) + zero HTTP dependencies.

## What it does

- Stores the **immutable raw signaling feed**, preserving source (`UE` / `ENB` / `OMC`),
  per-source sequence number, device-reported time and collector arrival order.
- Calibrates per-sector clock offsets onto one reference timeline.
- Reconstructs a per-terminal handover state machine and classifies handovers as
  `NORMAL`, `TOO_EARLY`, `TOO_LATE`, `PINGPONG`, `MISSING_ACK` or `RLF_UNRESOLVED`.
- Detects drops **only** from explicit failure signaling (`RLF_IND` / failed
  re-establishment). Out-of-order, duplicate or late signaling never fabricates a drop.
- Evaluates root causes with both evidence and counter-evidence:
  missing-neighbor configuration, weak coverage, capacity congestion and clock-skew
  artifacts (with `MULTI_FACTOR` / `INCONCLUSIVE` results). Conclusions are based on the
  whole analysis window, never on the single last event.
- Versions neighbor configurations, diffs versions, and treats new configurations or late
  events as triggers for recomputation. **Published investigations are frozen** and stay
  reproducible.
- Provides a JSON API (validation, explicit error codes, pagination) and a CLI.
- Time and randomness are injectable; tests need no real waiting.

## Requirements

- Windows + Node.js **>= 22.5** (developed/tested on Node 25). `node:sqlite` is used
  directly, so no native build step is required.

```powershell
npm install
```

## Tests

```powershell
npm test
```

The suite (28 tests) covers state transitions, de-duplication, ordering boundaries,
too-early/too-late/ping-pong/missing-ACK classification, clock skew, duplicate reports,
configuration repair, RCA evidence and counter-evidence, API validation/pagination,
failure paths, transactions, and persistence after a simulated process restart.

Type-check without emitting:

```powershell
npx tsc --noEmit -p tsconfig.test.json
```

## Repeatable end-to-end demo

```powershell
npm run demo
```

This runs every built-in scenario (high speed, signal jitter, clock skew, missing ACK,
duplicate reports, ping-pong, missing neighbor, congestion, config repair) in isolated
databases, then demonstrates a late configuration repair triggering recompute while an
already-published investigation stays unchanged, and finally exercises the HTTP API on an
ephemeral port. Output is deterministic for the fixed seed and requires no network.

## Starting the API server

Development mode (auto-selected free local port):

```powershell
# optional: $env:CELL_DB_PATH = "data/cellular.sqlite"  (this is the default)
npm run dev
```

Production build:

```powershell
npm run build
$env:PORT = "0"          # 0 = let the OS assign a free port; set a fixed port if preferred
npm start
```

The server prints one JSON line such as:

```json
{"status":"listening","host":"127.0.0.1","port":52376,"dbPath":"data/cellular.sqlite"}
```

It binds to `127.0.0.1` only. With `PORT=0` the assigned port is in that stdout line.

### Stopping

Press `Ctrl+C` in the terminal (SIGINT), or stop the process with `Stop-Process`:

```powershell
Get-Process node | Where-Object { $_.Path -like "*node*" }   # find PIDs if needed
Stop-Process -Id <pid>
```

The database is in WAL mode and closes cleanly on SIGINT/SIGTERM.

## CLI

All commands accept `CELL_DB_PATH` and print key counters before/after mutating
operations.

```powershell
npx tsx src/cli/index.ts init
npx tsx src/cli/index.ts scenarios
npx tsx src/cli/index.ts import-scenario missing_neighbor --seed 42
npx tsx src/cli/index.ts rebuild
npx tsx src/cli/index.ts analyze
npx tsx src/cli/index.ts timeline ue1
npx tsx src/cli/index.ts config-versions secA
npx tsx src/cli/index.ts config-diff secA 1 2
npx tsx src/cli/index.ts investigate --publish
npx tsx src/cli/index.ts evidence <investigationId>
npx tsx src/cli/index.ts export <investigationId> report.json
npx tsx src/cli/index.ts stats
```

You can also import one JSON object per line (`source`, `sourceSeq`, `eventType`,
`eventTimeMs`, `payload` are required):

```powershell
npx tsx src/cli/index.ts import-jsonl path\to\signals.jsonl
```

Validation errors list the offending lines and cause a non-zero exit without partial
writes.

After `npm run build`, use the compiled CLI with `node dist/cli/index.js ...`.

## HTTP API

All responses are JSON. Successful responses wrap data in `{ "data": ... }`; errors use
`{ "error": { "code", "message", "details" } }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/health` | service + stored event high-water mark |
| POST | `/analyze` | run calibration + timeline + RCA now |
| GET  | `/events` | list raw signals (`terminalId`, `sectorId`, `eventType`, `limit`, `offset`) |
| GET  | `/terminals/:id/timeline` | reconstructed states |
| GET  | `/handovers` | handovers (`terminalId`, `classification`, paging) |
| GET  | `/drops` | detected drops (`terminalId`, paging) |
| GET  | `/sectors/:id/config-versions` | neighbor config versions |
| GET  | `/sectors/:id/config-diff?from=1&to=2` | added/removed/kept neighbors |
| POST | `/investigations` | create a draft investigation snapshot |
| GET  | `/investigations` | list investigations (paged) |
| GET  | `/investigations/:id` | full report with findings |
| POST | `/investigations/:id/publish` | freeze the report |

Error codes: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405),
`BAD_JSON` (400), `INTERNAL_ERROR` (500). Pagination: `limit` (default 50, max 500) and
`offset` (>= 0), non-integers rejected.

Example:

```powershell
$port = 52376
Invoke-RestMethod "http://127.0.0.1:$port/events?limit=20&offset=0"
Invoke-RestMethod "http://127.0.0.1:$port/drops"
Invoke-RestMethod -Method Post "http://127.0.0.1:$port/analyze"
```

## Data model notes

- `signaling_events` is insert-only; `(source, sourceSeq, dedup_hash)` makes
  re-delivered signaling idempotent.
- `clock_calibrations` maps device time to reference time (`reference = device + offset`).
- `timeline_states`, `handovers` and `drops` are derived; each recomputation is tagged with
  a `rerun_token` and replaced atomically in a transaction.
- Investigations store a snapshot (`max_event_id`) and a frozen `report_json` once
  published, so historical reports remain reproducible after later recomputation.
- Migrations live in `src/db/schema.ts`, run automatically at startup, and are safe to
  re-run (tracked in `schema_migrations`).

## Project layout

```
src/db      database open + idempotent migrations
src/core    types, clock/rng injection, repository, timeline, RCA, investigations, query
src/ingest  synthetic scenario generator + JSONL/scenario importer
src/api     HTTP app + server entry point
src/cli     command line interface
src/demo    repeatable end-to-end demo
test        node:test suites and fixtures/helpers
```
