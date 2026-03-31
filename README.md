# fitui

Turn Garmin `.fit` files into a queryable training database — then layer athlete context (thoughts, PRs, race goals) on top for AI coaching.

## What it looks like

Ingest a run from your watch and query it:

```bash
fitui ingest morning-run.fit
fitui query --sql "
  SELECT sport, count(*) AS runs,
    round(avg(total_distance_m / 1000), 1) AS avg_km,
    round(avg(avg_pace_min_per_km), 2) AS avg_pace
  FROM sessions
  WHERE sport = 'running'
  GROUP BY sport
"
```

```json
[{"sport":"running","runs":545,"avg_km":7.2,"avg_pace":4.89}]
```

Browse a `.fit` file interactively in the terminal:

```bash
fitui view morning-run.fit
fitui view morning-run.fit --mode protocol
```

Use the library from code:

```typescript
import { createClient, setupDatabase, weeklyLoad, recentForm } from "@_davideast/fit"

const client = await createClient("./fit.duckdb")
await setupDatabase(client.conn)

const weekly = await weeklyLoad(client.conn)   // distance/pace/HR by week
const form = await recentForm(client.conn)     // 7d and 28d rolling averages
console.log(weekly, form)

client.close()
```

Add athlete context — journal entries, personal records, target races:

```typescript
import { setupDatabase } from "fit-coaching"
import {
  setAthleteProfile,
  savePersonalRecord,
  saveTargetRace,
  recordAthleteThoughts,
} from "fit-coaching"

await setAthleteProfile(conn, { name: "David East", max_hr: 206, resting_hr: 58 })
await savePersonalRecord(conn, { distance: "5k", time_s: 1098, set_date: "2025-11-05" })
await saveTargetRace(conn, {
  name: "Cherry Blossom 5k",
  race_date: "2026-04-11",
  distance: "5k",
  priority: "A",
  goal_time_s: 1080,
  goal_type: "time",
})
await recordAthleteThoughts(conn, "2026-03-30",
  "Easy 5 miler today. Legs felt heavy from yesterday's track session but HR stayed low."
)
```

## What's in the box

This is a monorepo with two packages:

| Package | npm name | Purpose |
|---------|----------|---------|
| `packages/fit-tui` | `@_davideast/fit` | FIT file parsing, DuckDB storage, query functions, CLI, TUI viewer |
| `packages/coaching` | `fit-coaching` (private) | Athlete profile, PRs, target races, journal entries, observations |

**fitui** is the standalone library. It handles the activity data layer — parsing `.fit` files, storing sessions/laps/records in DuckDB, and querying them. It works on Bun and Node.js.

**fit-coaching** extends fitui with athlete context. It imports and re-exports everything from fitui, then adds coaching-specific tables and queries. It's private to this workspace — not published to npm.

```
fitui (activity data)          fit-coaching (athlete context)
├── activities                 ├── re-exports all fitui queries
├── sessions                   ├── entries (journal)
├── laps                       ├── observations (extracted facts)
├── records (per-second)       ├── athlete (profile)
├── hr_zones                   ├── personal_records
└── 9 query functions          ├── target_races
                               └── 13 coaching query functions
```

## Setup

```bash
git clone git@github.com:davideast/fitui.git
cd fitui
bun install
```

Import your `.fit` files:

```bash
fitui --db data/fit.duckdb ingest data/your-run.fit
```

Or point at a directory:

```bash
bun run packages/fit-tui/src/db/ingest.ts data/
```

Run tests:

```bash
bun test --cwd packages/fit-tui     # 31 tests
bun test --cwd packages/coaching    # 6 tests
```

## CLI

The `fitui` CLI works on both Bun and Node.js. Full reference in [packages/fit-tui/README.md](packages/fit-tui/README.md).

```bash
fitui schema                                          # database schema as JSON
fitui query --sql "SELECT * FROM sessions LIMIT 5"    # read-only SQL
fitui ingest run.fit --dry-run                         # validate without importing
fitui ingest run.fit                                   # import to database
fitui view run.fit                                     # interactive TUI (Bun only)
fitui view run.fit --mode raw                          # flat message explorer
```

Use `--db <path>` or `FIT_DB_PATH` env var to specify the database location. Default: `./fit.duckdb`.

## Agent skills

The `.agents/skills/` directory contains structured knowledge for AI coding agents:

| Skill | What it does |
|-------|-------------|
| `fitui` | CLI command reference, guardrails, error codes |
| `athlete-profile` | Save profile details, PRs, and target races |
| `record-athlete-thoughts` | Extract observations from free-form journal entries |
| `tdd-red-green-refactor` | TDD workflow for this project |
| `agent-dx-cli-scale` | CLI design scoring for agent-friendliness |

## Project layout

```
├── packages/
│   ├── fit-tui/            # fitui library + CLI
│   │   ├── src/
│   │   │   ├── db/         # schema, queries, client, ingest
│   │   │   ├── cli/        # schema, query, ingest, view commands
│   │   │   ├── tui/        # interactive viewers (OpenTUI/React)
│   │   │   └── compat.ts   # node:fs/node:crypto wrappers
│   │   └── tests/
│   └── coaching/           # fit-coaching extension
│       ├── src/db/         # coaching schema + queries
│       └── tests/
├── .agents/skills/         # agent knowledge files
├── data/                   # .fit files and fit.duckdb (gitignored)
├── DATABASE.md             # schema reference
└── AGENTS.md               # agent conventions
```
