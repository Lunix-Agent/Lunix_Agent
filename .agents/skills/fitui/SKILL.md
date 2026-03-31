---
name: fit
description: >
  Interact with the fit CLI to inspect the FIT activity database, run SQL queries,
  and ingest .fit files. Use this skill whenever you need to read activity data,
  validate a file before importing it, or introspect the database schema.
  Always use --dry-run before ingest. Always use fit schema before writing SQL.
compatibility: Designed for Claude Code within the fit project. Requires bun and data/fit.duckdb.
---

# fit CLI

Agent interface for the FIT activity database. The CLI is non-TTY aware: when piped
or called from an agent context, all output is compact JSON on stdout. Errors are
JSON on stderr with an `error`, `code`, and `message` field.

---

## Commands

### `fit schema`

Returns the full database schema — every table with column names and types.

```bash
bun run packages/fit-tui/src/cli.ts schema
```

**Output shape:**
```json
{
  "tables": [
    {
      "name": "sessions",
      "columns": [
        { "name": "id", "type": "INTEGER", "nullable": false },
        { "name": "sport", "type": "VARCHAR", "nullable": true }
      ]
    }
  ]
}
```

**Guardrail:** Always call `fit schema` before writing any SQL query. Never guess
column names — verify them from the schema first.

---

### `fit query --sql "<SQL>"`

Executes a read-only SQL query against the database. Returns rows as a JSON array.
Bigint values are coerced to numbers. Output is always JSON-serializable.

```bash
bun run packages/fit-tui/src/cli.ts query --sql "SELECT sport, count(*) AS n FROM sessions GROUP BY sport ORDER BY n DESC"
```

**Output shape:**
```json
[{ "sport": "running", "n": 545 }, { "sport": "walking", "n": 666 }]
```

**Error shape (stderr):**
```json
{ "error": true, "code": "QUERY_FAILED", "message": "..." }
```

#### Input hardening — these patterns are always rejected

| Pattern | Rejection code | Why |
|---------|---------------|-----|
| `../` in SQL | `INPUT_REJECTED` | Path traversal guard |
| Multiple statements (`SELECT 1; DROP TABLE …`) | `INPUT_REJECTED` | Injection guard |

**Guardrails:**
- Use `LIMIT` on large tables (sessions, records). The records table can exceed 500k rows.
- Prefer aggregates over `SELECT *` to protect context window.
- Only SELECT statements are safe to issue through this command.

---

### `fit ingest <file.fit> [--dry-run]`

Imports a `.fit` file into the database. With `--dry-run`, validates and reports
what would be imported without writing anything.

```bash
# Always validate first
bun run packages/fit-tui/src/cli.ts ingest data/475490951656144900.fit --dry-run

# Then import
bun run packages/fit-tui/src/cli.ts ingest data/475490951656144900.fit
```

**Dry-run output (valid file):**
```json
{ "valid": true, "file": "data/...", "sessions": 1, "laps": 24, "records": 3005, "sport": "running" }
```

**Dry-run output (invalid file):**
```json
{ "valid": false, "file": "...", "error": "file not found: ..." }
```

**Ingest output:**
```json
{ "status": "imported", "file": "...", "sessions": 1 }
{ "status": "skipped",  "file": "..." }
{ "status": "error",    "file": "...", "error": "..." }
```

**Exit codes:** 0 = success/skipped, 1 = error or invalid

#### Input hardening — these paths are always rejected

| Pattern | Why |
|---------|-----|
| `../../` or `..\` | Path traversal guard |
| Non-`.fit` extension | Extension enforcement |

**Guardrails:**
- **Always run `--dry-run` first.** Never ingest without validating.
- Ingest is idempotent — importing the same file twice yields `"status": "skipped"`.
- Only pass absolute paths or paths relative to the project root (CWD).

---

## Key tables

| Table | Rows (typical) | Description |
|-------|---------------|-------------|
| `activities` | ~1 per file | One row per imported `.fit` file |
| `sessions` | 1–3 per activity | A continuous block of sport within an activity |
| `laps` | 5–40 per session | Individual laps (auto or manual) |
| `records` | 500–5000 per session | Per-second GPS/HR/power/cadence data points |
| `hr_zones` | 5 (fixed) | Heart rate zone definitions |

## Key columns to know

**sessions:**
- `sport` — `'running'` \| `'walking'` \| `'cycling'` \| `'training'`
- `start_time` — TIMESTAMP of session start
- `total_distance_m` — meters
- `total_duration_s` — seconds
- `avg_heart_rate`, `max_heart_rate` — BPM
- `avg_cadence_spm` — steps per minute (already doubled from half-cadence)
- `avg_pace_min_per_km` — minutes per km as a float

**records:**
- `session_id` — FK to sessions
- `ts` — TIMESTAMP (primary key with session_id)
- `heart_rate`, `cadence_spm`, `speed_kmh`, `distance_m`, `altitude_m`
- `effort_pace` — Garmin developer field (optional, may be NULL)

---

## Workflow: answering a question about activity data

```
1. fit schema                          # verify column names exist
2. fit query --sql "..."               # run targeted query with LIMIT
3. Interpret results and answer          # never re-query unnecessarily
```

## Workflow: ingesting a new file

```
1. fit ingest <file> --dry-run         # validate: check valid=true
2. fit ingest <file>                   # import: check status=imported
3. fit query --sql "SELECT id, recorded_at, sport FROM activities ORDER BY imported_at DESC LIMIT 1"
                                         # confirm it landed
```

---

### `fit view <file.fit> [--mode laps|raw|tree|protocol]`

Interactive TUI viewer for `.fit` files. **Requires a TTY (interactive terminal).**
Agents running in non-TTY contexts will receive a `TTY_REQUIRED` error — use `fit query`
to extract data programmatically instead.

```bash
bun run packages/fit-tui/src/cli.ts view data/475490951656144900.fit
bun run packages/fit-tui/src/cli.ts view data/475490951656144900.fit --mode raw
```

**Modes:**

| Mode | Description |
|------|-------------|
| `laps` (default) | Lap/record activity viewer — shows splits, HR, pace, cadence |
| `raw` | Flat message-type explorer — lists all FIT message types |
| `tree` | Collapsible cascade hierarchy tree |
| `protocol` | Binary FIT protocol explorer — raw definition messages |

**Non-TTY error (stderr):**
```json
{ "error": true, "code": "TTY_REQUIRED", "message": "view command requires a TTY (interactive terminal)" }
```

**Guardrails:**
- Do not call `view` from agent contexts — it takes over the terminal.
- Use `fit query` for programmatic data access instead.
- Does not require a database connection — parses `.fit` files directly.

---

## Error codes

| Code | Meaning |
|------|---------|
| `INPUT_REJECTED` | SQL or path failed hardening checks |
| `QUERY_FAILED` | Valid SQL but DuckDB reported an error |
| `MISSING_ARG` | Required argument not provided |
| `DB_OPEN_FAILED` | Database file could not be opened |
| `UNKNOWN_COMMAND` | Unrecognised command name |
| `TTY_REQUIRED` | `view` command called from non-TTY context |
| `INVALID_MODE` | Unknown `--mode` value for `view` command |
| `INVALID_FILE` | File extension or path failed validation |
| `RENDER_FAILED` | TUI renderer encountered an error |

All errors exit with code 1. Parse stderr JSON to get the code and message.
