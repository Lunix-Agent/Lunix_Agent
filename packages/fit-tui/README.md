# fitui

Parse Garmin `.fit` files, store them in DuckDB, and query your training data from the terminal or from code.

## What it looks like

Import a `.fit` file and query your sessions:

```bash
fitui ingest morning-run.fit
fitui query --sql "SELECT sport, count(*) AS runs, round(avg(total_distance_m / 1000), 1) AS avg_km FROM sessions GROUP BY sport"
```

```json
[{"sport":"running","runs":545,"avg_km":7.2},{"sport":"walking","runs":666,"avg_km":3.1}]
```

Inspect the database schema before writing SQL:

```bash
fitui schema
```

```json
{
  "tables": [
    {
      "name": "sessions",
      "columns": [
        {"name": "id", "type": "INTEGER", "nullable": false},
        {"name": "sport", "type": "VARCHAR", "nullable": true},
        {"name": "start_time", "type": "TIMESTAMP", "nullable": false},
        {"name": "total_distance_m", "type": "FLOAT", "nullable": true},
        {"name": "avg_pace_min_per_km", "type": "FLOAT", "nullable": true}
      ]
    }
  ]
}
```

Validate a file before importing it:

```bash
fitui ingest morning-run.fit --dry-run
```

```json
{"valid":true,"file":"morning-run.fit","sessions":1,"laps":8,"records":2451,"sport":"running"}
```

Browse a `.fit` file interactively in the terminal:

```bash
fitui view morning-run.fit
fitui view morning-run.fit --mode protocol
```

Use it as a library:

```typescript
import { createClient, setupDatabase, listActivities, weeklyLoad } from "fitui"

const client = await createClient("./fit.duckdb")
await setupDatabase(client.conn)

const activities = await listActivities(client.conn)
const weekly = await weeklyLoad(client.conn)
console.log(weekly)

client.close()
```

## Install

Requires [Bun](https://bun.sh) >= 1.0.0.

```bash
bun add fitui
```

## CLI Reference

All commands output JSON. In a TTY, output is pretty-printed. When piped, output is compact. Errors go to stderr as `{"error": true, "code": "...", "message": "..."}`.

### Global flags

| Flag | Description | Default |
|------|-------------|---------|
| `--db <path>` | Path to DuckDB database | `$FIT_DB_PATH` or `./fit.duckdb` |

### `fitui schema`

Print every table and column in the database.

```bash
fitui schema
```

### `fitui query --sql "<SQL>"`

Run a read-only SQL query against DuckDB. Write operations (INSERT, DELETE, DROP, etc.) are rejected.

```bash
fitui query --sql "SELECT sport, start_time, total_distance_m FROM sessions ORDER BY start_time DESC LIMIT 5"
```

DATE columns return `"YYYY-MM-DD"` strings. TIMESTAMP columns return full ISO strings. BigInts are coerced to numbers.

SQL containing `../`, semicolons outside string literals, or write keywords is rejected with `INPUT_REJECTED`.

### `fitui ingest <file.fit> [--dry-run]`

Import a `.fit` file into the database.

```bash
fitui ingest run.fit --dry-run    # validate without writing
fitui ingest run.fit              # import
```

Idempotent — importing the same file twice returns `"status": "skipped"`. Deduplication checks both file path and content hash.

Path traversal (`../`) and non-`.fit` extensions are rejected.

### `fitui view <file.fit> [--mode laps|raw|tree|protocol]`

Open an interactive terminal viewer for a `.fit` file. Does not require a database — parses the file directly.

```bash
fitui view run.fit                # default: lap breakdown
fitui view run.fit --mode raw     # flat message-type explorer
fitui view run.fit --mode tree    # collapsible cascade hierarchy
fitui view run.fit --mode protocol  # binary FIT protocol inspector
```

Requires a TTY. Non-TTY contexts receive `{"error": true, "code": "TTY_REQUIRED"}`.

## Library API

### `createClient(path: string): Promise<FitClient>`

Open a DuckDB database. Returns `{ conn, close }`. Throws with `code: 'DB_OPEN_FAILED'` on failure.

```typescript
import { createClient } from "fitui"

const client = await createClient("./fit.duckdb")
// use client.conn for queries
client.close()
```

Use `":memory:"` for an in-memory database.

### `setupDatabase(instance: DuckDBInstance): Promise<void>`

Create all tables, sequences, and indexes. Idempotent — safe to call on every startup.

```typescript
import { DuckDBInstance } from "@duckdb/node-api"
import { setupDatabase } from "fitui"

const instance = await DuckDBInstance.create("./fit.duckdb")
await setupDatabase(instance)
```

### Query functions

All query functions take a `DuckDBConnection` as the first argument and return row objects.

| Function | Parameters | Description |
|----------|-----------|-------------|
| `listActivities(conn)` | — | All sessions with date, distance, pace, HR, calories |
| `weeklyLoad(conn)` | — | Weekly aggregates: run count, total km, avg pace, avg HR |
| `sessionDetail(conn, sessionId)` | `sessionId: number` | Full session + lap breakdown |
| `hrZones(conn, sessionId)` | `sessionId: number` | Time in each heart rate zone |
| `sessionRecords(conn, sessionId)` | `sessionId: number` | Per-second series with deltas |
| `paceRecords(conn, sessionId)` | `sessionId: number` | Pace series for surge/turnaround detection |
| `paceProgression(conn, sessionId)` | `sessionId: number` | 30-second pace buckets for split analysis |
| `recentForm(conn)` | — | 7-day and 28-day rolling averages |
| `longestRuns(conn, n?)` | `n?: number` (default 10) | Top N longest runs by distance |

```typescript
import { createClient, setupDatabase, sessionDetail, hrZones } from "fitui"
import { DuckDBInstance } from "@duckdb/node-api"

const instance = await DuckDBInstance.create("./fit.duckdb")
await setupDatabase(instance)
const conn = await instance.connect()

const { session, laps } = await sessionDetail(conn, 42)
const zones = await hrZones(conn, 42)
console.log(session, laps, zones)

conn.closeSync()
instance.closeSync()
```

### Ingest functions

```typescript
import { parseFitFile, ingestFile } from "fitui"
```

**`parseFitFile(path: string): Promise<FitFileSummary>`** — Parse a `.fit` file and return `{ sessions, laps, records, sport }` without touching the database.

**`ingestFile(conn, path: string): Promise<string | null>`** — Parse and write a `.fit` file to the database. Returns a summary string on success, a `"SKIP (...)"` string if already imported, or throws on error.

## Database schema

`setupDatabase` creates these tables:

| Table | Description | Scale |
|-------|-------------|-------|
| `activities` | One row per imported `.fit` file | ~1 per file |
| `sessions` | Continuous sport blocks within an activity | 1–3 per activity |
| `laps` | Auto or manual lap splits | 5–40 per session |
| `records` | Per-second GPS, HR, power, cadence data | 500–5000 per session |
| `hr_zones` | Heart rate zone definitions (5 rows, seeded) | Fixed |

Cadence values are stored as steps per minute (doubled from the half-cadence in `.fit` files). Pace is stored as minutes per kilometer.

## Error codes

| Code | Meaning |
|------|---------|
| `INPUT_REJECTED` | SQL or file path failed validation |
| `QUERY_FAILED` | DuckDB returned an error |
| `MISSING_ARG` | Required argument not provided |
| `DB_OPEN_FAILED` | Database file could not be opened |
| `UNKNOWN_COMMAND` | Unrecognized command |
| `TTY_REQUIRED` | `view` called from non-interactive context |
| `INVALID_MODE` | Unknown `--mode` for `view` |
| `INVALID_FILE` | Bad extension or path traversal |
| `RENDER_FAILED` | TUI viewer error |

## Limitations

- Bun only — uses `Bun.file`, `Bun.CryptoHasher`, and `import.meta.main`
- DuckDB native module means no browser or edge runtime support
- The `view` command requires a terminal — it takes over stdin/stdout
- SQL queries through the CLI are read-only by design
- The query input hardening is heuristic-based (comment and literal stripping before semicolon check)
