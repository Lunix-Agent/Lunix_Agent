# FIT Database

## Purpose

A persistent analytical store for Garmin running activity data. The goal is to give an LLM fast, reliable answers to questions like "how much did I run last month?", "did I negative split?", and "how is my fitness trending?" — without reparsing FIT files each time.

The database is **one person's training log**. Every query is implicitly scoped to a single athlete. There are no user IDs.

---

## Self-orienting when this document is stale

The live schema is always the authority. If anything in this document seems inconsistent with what you find in the database, trust the database. Discover the current state with:

```sql
-- What tables exist?
SHOW TABLES;

-- What columns does a table have?
DESCRIBE activities;
DESCRIBE sessions;
DESCRIBE laps;
DESCRIBE records;
DESCRIBE hr_zones;

-- Full column details including types and nullability
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sessions'
ORDER BY ordinal_position;

-- Row counts to understand data volume
SELECT
  (SELECT count(*) FROM activities) AS activities,
  (SELECT count(*) FROM sessions)   AS sessions,
  (SELECT count(*) FROM laps)       AS laps,
  (SELECT count(*) FROM records)    AS records,
  (SELECT count(*) FROM hr_zones)   AS hr_zones;
```

Run these before writing queries if you are uncertain.

---

## Conceptual data model

FIT files record a workout at four levels of granularity. The database mirrors this hierarchy exactly:

```
activity          — one FIT file (e.g. a morning run)
  └── session     — one continuous effort within that file (almost always 1 per activity)
        └── lap   — a split marker (auto-lap every km, or manual button press)
              └── record — one sensor sample, roughly once per second
```

**In practice:** most activities have exactly 1 session. Laps are the natural unit for structured workouts. Records are the raw time-series and are only needed for per-second analysis.

When an LLM answers a question about "a run", it is describing a **session**. When it breaks it into "splits" or "km markers", it is describing **laps**. When it plots a pace curve or HR curve, it is querying **records**.

---

## Schema

### `activities`

One row per imported FIT file.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-incremented via sequence |
| `file_path` | TEXT UNIQUE | Absolute path on disk at import time |
| `file_name` | TEXT | Basename only (e.g. `475490951656144900.fit`) |
| `file_hash` | TEXT UNIQUE | SHA-256 of raw bytes — dedup even across renames |
| `recorded_at` | TIMESTAMP | Start time of first session (activity timestamp) |
| `sport` | TEXT | e.g. `running`, `cycling` |
| `imported_at` | TIMESTAMP | When the row was inserted |

The `file_path` + `file_hash` dual uniqueness means **the same activity cannot be imported twice**, regardless of whether the file was renamed or copied.

---

### `sessions`

One row per session within an activity. The primary table for activity-level analytics.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `activity_id` | INTEGER FK → activities | |
| `session_index` | INTEGER | 0-based, usually 0 |
| `sport` | TEXT | e.g. `running` |
| `sub_sport` | TEXT | e.g. `road`, `trail` — often NULL |
| `start_time` | TIMESTAMP | Wall-clock start |
| `total_distance_m` | REAL | Raw meters from GPS |
| `total_duration_s` | REAL | Timer time in seconds (pauses excluded) |
| `total_calories` | INTEGER | |
| `avg_heart_rate` | INTEGER | bpm |
| `max_heart_rate` | INTEGER | bpm |
| `avg_cadence_spm` | INTEGER | Steps per minute — **already doubled** from FIT's half-cadence |
| `avg_speed_kmh` | REAL | km/h |
| `max_speed_kmh` | REAL | km/h |
| `total_ascent_m` | INTEGER | Cumulative elevation gain |
| `total_descent_m` | INTEGER | Cumulative elevation loss |
| `avg_power_w` | INTEGER | Running power in watts (Stryd/Garmin) |
| `avg_pace_min_per_km` | REAL | Derived: `60 / avg_speed_kmh` — stored for query convenience |
| `avg_vertical_osc` | REAL | Vertical oscillation in mm |
| `avg_vertical_ratio` | REAL | Vertical ratio % (oscillation / stride length) |
| `avg_stance_time_ms` | REAL | Ground contact time in milliseconds |

**To convert for display:**
- Distance: `total_distance_m / 1000.0` → km
- Duration: `total_duration_s / 60.0` → minutes
- Pace: already `min/km`; format as `floor(pace):round((pace % 1) * 60)` for MM:SS

---

### `laps`

One row per lap within a session. Same fields as sessions at lap scope.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `session_id` | INTEGER FK → sessions | |
| `lap_index` | INTEGER | 0-based order within session |
| `start_time` | TIMESTAMP | |
| `total_distance_m` | REAL | |
| `total_duration_s` | REAL | |
| `avg_heart_rate` | INTEGER | |
| `max_heart_rate` | INTEGER | |
| `avg_speed_kmh` | REAL | |
| `avg_cadence_spm` | INTEGER | Already doubled |
| `total_ascent_m` | INTEGER | |
| `total_descent_m` | INTEGER | |
| `avg_power_w` | INTEGER | |
| `avg_pace_min_per_km` | REAL | |
| `avg_vertical_osc` | REAL | |
| `avg_vertical_ratio` | REAL | |
| `avg_stance_time_ms` | REAL | |
| `effort_pace` | REAL | Garmin developer field — pace adjusted for elevation and conditions. NULL if device didn't record it. |

---

### `records`

Per-second sensor data. The largest table — expect ~1000–3600 rows per session.

| Column | Type | Notes |
|--------|------|-------|
| `session_id` | INTEGER FK → sessions | |
| `ts` | TIMESTAMP | Wall-clock timestamp of the sample |
| `elapsed_s` | INTEGER | Seconds since session start |
| `lat` | DOUBLE | Degrees — NULL when GPS not locked |
| `lng` | DOUBLE | Degrees — NULL when GPS not locked |
| `distance_m` | REAL | Cumulative distance at this moment |
| `speed_kmh` | REAL | Instantaneous speed |
| `heart_rate` | INTEGER | bpm — NULL if HR not recorded yet |
| `cadence_spm` | INTEGER | Already doubled |
| `altitude_m` | REAL | |
| `power_w` | INTEGER | |
| `vertical_osc_mm` | REAL | |
| `vertical_ratio_pct` | REAL | |
| `stance_time_ms` | REAL | |
| `step_length_mm` | INTEGER | |
| `effort_pace` | REAL | Garmin developer field |

**Primary key:** `(session_id, ts)` — no two records in the same session share a timestamp.

**Sparsity:** Garmin devices send sensor data as sensors come online. The first 10–30 seconds of a session commonly have NULL heart_rate, NULL cadence, NULL GPS. Filter `WHERE heart_rate IS NOT NULL` or `WHERE speed_kmh > 0` as appropriate.

Records are **deduplicated across laps during ingestion** — the same timestamp cannot appear twice even though laps nominally overlap at their boundaries.

---

### `hr_zones`

The athlete's personal heart rate zones. Used by `hrZones()` to classify per-second records.

Zones are **absolute BPM ranges**, not percentages of max HR. Do not compute zones from `max_heart_rate` — always JOIN this table.

| Column | Type | Notes |
|--------|------|-------|
| `zone` | INTEGER PK | 1–5 |
| `name` | TEXT | Human-readable zone label |
| `min_bpm` | INTEGER | NULL for Z1 (no lower bound) |
| `max_bpm` | INTEGER | NULL for Z5 (no upper bound) |

Current zones:

| Zone | Name | Range |
|------|------|-------|
| 1 | Recovery | < 134 |
| 2 | Endurance | 135–167 |
| 3 | Tempo | 168–183 |
| 4 | Threshold | 184–200 |
| 5 | Anaerobic | ≥ 201 |

Seeded once by `setupDatabase` via `INSERT ... ON CONFLICT DO NOTHING` — re-running ingest never overwrites manual edits. To update a zone boundary: `UPDATE hr_zones SET max_bpm = 130 WHERE zone = 1`.

The canonical JOIN pattern for classifying records by zone:
```sql
JOIN hr_zones z
  ON (z.min_bpm IS NULL OR r.heart_rate >= z.min_bpm)
 AND (z.max_bpm IS NULL OR r.heart_rate <= z.max_bpm)
```

Zones not visited in a session will be absent from results (not returned as 0 seconds). If you need all 5 zones to always appear, LEFT JOIN from `hr_zones` to `records`.

---

## Units and conventions

These are baked in during ingestion and never change:

| Measurement | Unit stored | Conversion to display |
|-------------|------------|----------------------|
| Distance | meters (REAL) | ÷ 1000 → km; ÷ 1609.34 → miles |
| Speed | km/h (REAL) | As-is; or 60/speed → min/km pace |
| Pace | min/km (REAL) | Stored precomputed. Format: `MM:SS` |
| Duration | seconds (REAL) | ÷ 60 → minutes |
| Cadence | steps/min | FIT stores half-cadence; **×2 already applied** |
| Heart rate | bpm (INTEGER) | As-is |
| Power | watts (INTEGER) | As-is |
| Temperature | Celsius | As-is |
| Coordinates | decimal degrees | lat/lng |
| Altitude / ascent | meters | As-is |
| Vertical oscillation | mm (REAL) | As-is |
| Vertical ratio | percent (REAL) | As-is |
| Stance time | milliseconds (REAL) | As-is |

**Cadence note:** The FIT protocol stores cadence as half-cadence (divide by 2 to get one foot). All cadence columns in this database have had ×2 applied and represent **total steps per minute**. Do not double again.

**Pace note:** `avg_pace_min_per_km` is derived from `avg_speed_kmh` as `60 / speed`. A value of `5.0` means 5 minutes per km (i.e. 5:00/km). Format as MM:SS by separating integer and fractional parts.

---

## Indexes

```sql
idx_sessions_start   ON sessions(start_time DESC)        -- date-range queries
idx_sessions_sport   ON sessions(sport, start_time DESC) -- filter by sport
idx_laps_session     ON laps(session_id, lap_index)       -- lap breakdown
idx_records_session  ON records(session_id, elapsed_s)    -- time-series within a session
```

---

## Query API (`src/db/queries.ts`)

Pre-built query functions that return plain JS objects. All live in `src/db/queries.ts` and are designed to be called with an open `DuckDBConnection`.

```ts
import { DuckDBInstance } from "@duckdb/node-api"
import { listActivities, sessionDetail, hrZones } from "./src/db/queries.ts"

const instance = await DuckDBInstance.create("data/fit.duckdb")
const conn = await instance.connect()
const rows = await listActivities(conn)
conn.closeSync()
instance.closeSync()
```

All functions return `Record<string, JS>[]` where `JS` includes `null | boolean | number | bigint | string | Date`. When serializing to JSON, use a BigInt replacer: `(_, v) => typeof v === 'bigint' ? v.toString() : v`.

Run all queries against the live database as a smoke test:
```sh
bun run src/db/queries.ts
```

---

### `listActivities(conn)`

**Granularity:** Session-level — one row per session, joined to its parent activity for the filename.

**Tables:** `sessions` JOIN `activities`

**Row count:** One per session in the database, ordered newest first. With one session per activity (typical), this equals the number of imported FIT files.

**Returns:**

| Field | Type | Notes |
|-------|------|-------|
| `session_id` | number | FK into sessions — use this for all per-session queries |
| `activity_id` | number | FK into activities |
| `date` | Date | Session start time |
| `km` | number | Total distance, rounded to 2dp |
| `minutes` | number | Total duration in minutes, rounded to 1dp |
| `pace_min_per_km` | number | Average pace in decimal min/km (e.g. `4.11` = 4:06/km) |
| `avg_hr` | number | Average heart rate in bpm |
| `calories` | number | Total calories |
| `file_name` | string | Source FIT filename |

**What it enables:**
- Inventory of all runs with key stats at a glance
- Finding a session to pass to `sessionDetail`, `hrZones`, or `paceProgression`
- Answering "when did I last run?", "how many runs do I have?", "what was my fastest/longest recent run?"
- The `session_id` from this result is the input to all other per-session queries

**Limitations:** Does not include lap breakdown, record-level data, or elevation. Use `sessionDetail` for depth on a specific run.

---

### `weeklyLoad(conn)`

**Granularity:** Week-level aggregation across all sessions.

**Tables:** `sessions` only

**Row count:** One per ISO week (Monday–Sunday) that contains at least one session. Weeks with no runs are absent — there are no zero-rows.

**Returns:**

| Field | Type | Notes |
|-------|------|-------|
| `week` | string | ISO week start date as `YYYY-MM-DD HH:MM:SS` (Monday) |
| `run_count` | bigint | Number of sessions that week — convert with `Number()` |
| `total_km` | number | Sum of distances, rounded to 2dp |
| `total_minutes` | number | Sum of durations, rounded to 1dp |
| `avg_pace` | number | Average of each session's avg pace (not distance-weighted) |
| `avg_hr` | number | Average of each session's avg heart rate |

**What it enables:**
- Training volume trends over time ("my biggest week was...")
- Spotting recovery weeks or ramp-up patterns
- Week-over-week load comparison
- Answering "how much did I run in February?", "how consistent have I been?"

**Limitations:** Averages pace and HR across sessions rather than weighting by distance. A short fast run and a long slow run in the same week produce a misleading avg_pace. For weighted analysis, write a custom query joining to session distances.

---

### `sessionDetail(conn, sessionId)`

**Granularity:** Session-level summary + full lap breakdown.

**Tables:** `sessions` JOIN `activities` (for session), `laps` (for lap array)

**Row count:** Returns `{ session: object | null, laps: object[] }`. The session is 1 object; laps is typically 1–30 objects ordered by `lap_index`.

**`session` fields:** All columns from the `sessions` table plus `file_name` and `file_path` from `activities`. See the sessions schema for the full list. Key fields: `start_time`, `total_distance_m`, `total_duration_s`, `avg_heart_rate`, `max_heart_rate`, `avg_cadence_spm`, `avg_speed_kmh`, `avg_power_w`, `avg_pace_min_per_km`, `total_ascent_m`, `avg_vertical_osc`, `avg_stance_time_ms`.

**`laps[]` fields:** All columns from the `laps` table. Same metrics as sessions but scoped to each lap. Includes `effort_pace` (Garmin developer field, may be null). Ordered by `lap_index` (0-based).

**What it enables:**
- Comprehensive narrative about a single run ("you ran 12.2km in 50 minutes...")
- Lap-by-lap split analysis ("your fastest lap was lap 3 at 3:58/km...")
- Comparing first and second half laps for positive/negative split detection at the lap level
- Answering "how were my splits?", "did I slow down in the second half?", "what was my best lap?"

**Limitations:** No per-second data. For pace curves, HR curves, or zone breakdowns, combine with `paceProgression` and `hrZones` using the same `sessionId`.

---

### `hrZones(conn, sessionId)`

**Granularity:** Record-level (per-second) — each record is classified into a named zone by joining the `hr_zones` table, then aggregated.

**Tables:** `records` JOIN `hr_zones`

**Row count:** 1–5 rows, one per zone that was actually visited during the session. Zones with zero seconds are absent. If you need all 5 zones to always appear (including zeros), query `hr_zones` directly and LEFT JOIN.

**Returns:**

| Field | Type | Notes |
|-------|------|-------|
| `zone` | number | 1–5 |
| `name` | string | Recovery / Endurance / Tempo / Threshold / Anaerobic |
| `seconds` | bigint | Time in zone — convert with `Number()` |
| `pct` | number | Percentage of total HR-recorded time, rounded to 1dp |

**What it enables:**
- Intensity distribution for a session ("90% of this run was in zone 5")
- Classifying a run's training purpose (aerobic base vs threshold vs race-effort)
- Answering "how much time in zone 2?", "was this a recovery run?", "did I spend time above threshold?"

**Important:** Zone boundaries come from the `hr_zones` table (absolute BPM ranges), not from max HR percentages. The percentages sum to 100% of records *where heart_rate is not null* — early GPS/HR warmup records with null HR are excluded. A session with 30 seconds of null HR at the start will slightly overstate zone percentages relative to total elapsed time.

**Limitations:** Cannot tell you *when* in the session zones were visited — only totals. For a time-series of HR zones, query `records` directly with the hr_zones JOIN.

---

### `paceProgression(conn, sessionId)`

**Granularity:** Record-level (per-second) — records are bucketed into 30-second windows and averaged.

**Tables:** `records` only

**Row count:** Approximately `session_duration_s / 30` rows, one per 30-second bucket that contains at least one record with `speed_kmh > 0`. The first 1–2 buckets are often noisy due to GPS lock acquiring.

**Returns:**

| Field | Type | Notes |
|-------|------|-------|
| `bucket_start_s` | number | Elapsed seconds at the start of this bucket (0, 30, 60, …) |
| `avg_speed_kmh` | number | Average speed in this bucket, rounded to 2dp |
| `avg_pace_min_per_km` | number | Corresponding pace in decimal min/km, rounded to 2dp |

**What it enables:**
- Detecting negative splits (later buckets faster than earlier ones)
- Detecting positive splits / fade (slowing over time)
- Identifying surges, pickups, or effort changes within a run
- Answering "did I run even pace?", "when did I speed up?", "how did my pace change over time?"

**Limitations:** 30-second averages smooth out short surges and stops. Gaps in GPS recording create missing buckets rather than zero-speed buckets. The very first bucket often reads unrealistically slow as the GPS acquires — treat the first 1–2 buckets as warmup noise.

---

### `recentForm(conn)`

**Granularity:** Session-level, aggregated across two rolling time windows: 7 days and 28 days from now.

**Tables:** `sessions` only

**Row count:** Always 1 row if any sessions exist within the last 28 days. Returns 0 rows if the database has no sessions in the last 28 days — check for an empty result before narrating.

**Returns:**

| Field | Type | Notes |
|-------|------|-------|
| `km_7d` | number | Total distance in the last 7 days |
| `km_28d` | number | Total distance in the last 28 days |
| `pace_7d` | number | Average pace (decimal min/km) in the last 7 days |
| `pace_28d` | number | Average pace (decimal min/km) in the last 28 days |
| `hr_7d` | number | Average heart rate in the last 7 days |
| `hr_28d` | number | Average heart rate in the last 28 days |

**What it enables:**
- Comparing recent volume and intensity to the rolling month baseline
- Detecting fitness improvement (faster pace at same or lower HR over time)
- Answering "am I running more or less than usual?", "is my fitness trending up?", "how does this week compare to my monthly average?"

**Limitations:** Windows are always relative to `now()` — the values change every day even if no new data is imported. If all data falls within the same 7 days, `km_7d` = `km_28d` and the comparison is meaningless. Pace averages across sessions (not distance-weighted). Does not distinguish easy runs from hard runs — a week of easy volume can show the same km_7d as a week of intense short efforts.

---

### `longestRuns(conn, n = 10)`

**Granularity:** Session-level, sorted by distance descending.

**Tables:** `sessions` only

**Row count:** `min(n, total sessions)`. Default `n` is 10.

**Returns:**

| Field | Type | Notes |
|-------|------|-------|
| `session_id` | number | Use to fetch full detail with `sessionDetail` |
| `date` | Date | Session start time |
| `km` | number | Distance, rounded to 2dp |
| `minutes` | number | Duration in minutes, rounded to 1dp |
| `pace_min_per_km` | number | Average pace in decimal min/km |
| `avg_hr` | number | Average heart rate |

**What it enables:**
- Identifying longest efforts (long runs, races)
- Tracking personal distance records over time
- Answering "what are my longest runs?", "have I ever run a half marathon?", "what's my furthest run?"

**Limitations:** Sorted by distance only — does not consider effort, pace, or elevation. Two runs of the same distance are ordered arbitrarily. Use `session_id` from results to call `sessionDetail` for full context on any specific run.

---

## Ingestion

```sh
# Single file
bun run src/db/ingest.ts data/activity.fit

# Multiple files (shell glob expansion)
bun run src/db/ingest.ts data/*.fit

# Entire directory (script scans recursively for .fit files)
bun run src/db/ingest.ts data/
```

**Idempotency:** The ingest script checks both `file_path` (absolute) and `file_hash` (SHA-256) before inserting. Re-running on the same file — or on a copy with a different name — is safe and prints a skip message identifying the original.

**What happens on first import of a file:**
1. File is hashed and parsed with `fit-file-parser` in `cascade` mode
2. `activities`, `sessions`, `laps` are inserted inside a transaction
3. `records` are appended after the transaction commits using DuckDB's bulk appender
4. If any step fails, the transaction is rolled back; records that were appended after a commit failure remain but the activity row does not — re-running after fixing the error will re-insert cleanly

---

## Writing new queries

The pattern used throughout `queries.ts`:

```ts
export async function myQuery(conn: DuckDBConnection, param: number) {
  const reader = await conn.runAndReadAll(`
    SELECT col1, col2
    FROM sessions
    WHERE id = ${param}        -- numeric params: interpolate directly (no injection risk)
  `)
  return reader.getRowObjectsJS()
}
```

**String parameters** must be escaped:
```ts
// Use the sqlStr helper from ingest.ts, or inline:
const safe = `'${userInput.replace(/'/g, "''")}'`
```

**Timestamp gotcha:** `date_trunc(...)` and `count(*)` return `bigint` via `getRowObjectsJS()`. Cast to VARCHAR in SQL if you need a readable string:
```sql
CAST(date_trunc('week', start_time) AS VARCHAR) AS week
```

**Useful DuckDB patterns for running analysis:**

```sql
-- Pace in MM:SS string form
printf('%d:%02d', floor(avg_pace_min_per_km), round((avg_pace_min_per_km % 1) * 60)) AS pace_str

-- Classify a record into its named HR zone (always use hr_zones table, not max HR %)
JOIN hr_zones z
  ON (z.min_bpm IS NULL OR r.heart_rate >= z.min_bpm)
 AND (z.max_bpm IS NULL OR r.heart_rate <= z.max_bpm)

-- 30-second time buckets
(elapsed_s / 30) * 30 AS bucket_start_s

-- Rolling 7-day window
WHERE start_time >= now() - INTERVAL '7 days'

-- Convert meters to km inline
round(total_distance_m / 1000.0, 2) AS km
```

---

## Evolving the schema

**Adding a column** (the migration is built into `setupDatabase` — add it there):

```ts
// In schema.ts, after the CREATE TABLE block:
await conn.run(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS new_field REAL`)
```

`IF NOT EXISTS` makes it safe to run on existing databases. Existing rows get `NULL`. `setupDatabase` runs on every ingest, so the column appears automatically on next import.

**Adding a new table:**

```sql
CREATE TABLE IF NOT EXISTS my_table ( ... )
```

Add the CREATE in `setupDatabase`. It will not overwrite data on subsequent runs.

**Adding a computed column to a query:** Prefer doing this in `queries.ts` rather than adding it to the schema, unless the computation is expensive and the value is queried frequently.

---

## DuckDB + Bun known behaviours

| Behaviour | What to do |
|-----------|-----------|
| Process hangs after `conn.closeSync()` / `instance.closeSync()` | DuckDB keeps a background thread pool alive. Use `setImmediate(() => process.exit(0))` at end of CLI scripts. |
| Exit code 133 (SIGTRAP) | DuckDB's teardown sends SIGTRAP in some Bun versions. Queries completed successfully; the exit code is cosmetic. |
| `bigint` in query results | `count(*)`, sequences, and some timestamp operations return `bigint`. Use `Number(val)` or a JSON.stringify replacer. |
| Dynamic `import('@duckdb/node-api')` inside a function | Causes `INTERNAL Error` in `SetThreads`. Always import at the top level of the module. |
| `date_trunc` result serialization | Returns as `bigint` (microseconds), not a `Date`. Cast to `VARCHAR` in SQL for readable output. |
| Appender vs transaction | The DuckDB appender bypasses the transaction system. Commit metadata (activity/sessions/laps) first, then use the appender for records. |
