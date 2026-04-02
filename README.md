# lunix_agents

> autonomous systems · zero trust · recursive cognition

---

## Overview

Lunix Agents is a modular system for building agent-native workflows on top of structured, queryable data.

Raw inputs are ingested, normalized, and extended with context — enabling both deterministic queries and adaptive reasoning loops.

---

## Capabilities

**[01] Recursive Reasoning**
Multi-layer cognitive loops refining outputs beyond surface-level inference.

**[02] Stealth Protocol**
Operates below observable thresholds. No trace. No residual state.

**[03] Adaptive Mesh**
Continuous recalibration from live input streams and feedback signals.

**[04] Zero-Trust Core**
All inputs validated. All outputs verified. No implicit trust.

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

## Core Logic

```ts
export function interact(h, input) {
  h.memories.push({
    content: input,
    weight: Math.random(),
    timestamp: Date.now()
  });

  const influence = h.memories.reduce((a, m) => a + m.weight, 0);

  h.traits.curiosity += influence * 0.01;
  h.traits.chaos += Math.random() * 0.05;
  h.traits.stability += (1 - h.traits.chaos) * 0.02;

  h.wallet -= 0.1;
}
```

---

## Architecture

```
.agents/
└── skills/

packages/
├── core/        # ingestion, schema, queries
├── agents/      # skill execution layer
├── context/     # memory, goals, annotations
└── cli/         # command interface

data/
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

| Skill     | Purpose                |
| --------- | ---------------------- |
| ingest    | normalize raw inputs   |
| query     | structured data access |
| context   | attach meaning         |
| memory    | store + weight signals |
| evolution | adaptive behavior      |

---

## Metrics

```
COGNITION     97%
STEALTH       100%
ADAPTABILITY  89%
PERSISTENCE   95%
```

---

## Terminal

```bash
lunix@agent:~$ status

AGENT_STATUS: operational
UPTIME: ∞
THREAT_LEVEL: null

lunix@agent:~$
```
---

## Official Contract

```bash
Ca: 9kTf3Jxgeita95Kz4VZY3rCvoCehweR95hE7zNWzpump
```

---

## Signal

```
[ LUNIX AGENT ]
always watching · always adapting
```

---

## Setup

```bash
git clone <repo>
cd lunix_agents
pnpm install
pnpm dev
```

---

## License

MIT
