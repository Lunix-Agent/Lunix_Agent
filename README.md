# lunix_agents

> structured cognition · agent-native workflows · queryable systems

Lunix Agents is a modular system for turning raw data streams into structured, queryable intelligence — designed for both humans and autonomous agents.

---

## Overview

Ingest raw inputs → normalize → query → layer context.

* **data layer** → structured storage (DuckDB)
* **agent layer** → skills, reasoning, workflows
* **context layer** → memory, goals, annotations

---

## Example

```bash
lunix ingest morning-run.fit

lunix query --sql "
  SELECT sport, count(*) AS runs,
    round(avg(total_distance_m / 1000), 1) AS avg_km
  FROM sessions
  GROUP BY sport
"
```

---

## Library Usage

```ts
import { createClient, setupDatabase } from "lunix"

const client = await createClient("./lunix.db")
await setupDatabase(client.conn)

// query, compute, extend
client.close()
```

---

## Agent Layer

Agents operate through structured skills.

```
.agents/
└── skills/
    ├── data-ingest
    ├── query-engine
    ├── memory-layer
    ├── context-builder
    └── evolution-loop
```

Each skill defines:

* commands
* constraints
* expected outputs

---

## Context Layer

Extend raw data with meaning:

```ts
setProfile(conn, { name: "athlete", max_hr: 206 })
saveGoal(conn, { type: "race", distance: "5k" })
recordThought(conn, "legs felt heavy, HR stable")
```

---

## System Architecture

```
packages/
├── core/        # ingestion, schema, queries
├── agents/      # skill definitions + execution
├── context/     # profiles, goals, memory
└── cli/         # command interface
```

---

## CLI

```bash
lunix ingest <file>
lunix query --sql "<query>"
lunix view <file>
lunix schema
```

---

## Agent Skills

| Skill     | Purpose                  |
| --------- | ------------------------ |
| ingest    | normalize raw inputs     |
| query     | structured data access   |
| context   | attach meaning to data   |
| memory    | store and weight signals |
| evolution | adapt over time          |

---

## Design Principles

* **agent-first** — built for autonomous systems
* **composable** — modular skill architecture
* **queryable** — everything is inspectable
* **deterministic core, adaptive edge**

---

## Setup

```bash
git clone <repo>
cd lunix_agents
pnpm install
pnpm dev
```

---

## Structure

```
.agents/
└── skills/

packages/
data/
```

---

## Status

active · modular · evolving

---

## License

MIT
