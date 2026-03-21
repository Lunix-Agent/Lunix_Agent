---
name: record-athlete-thoughts
description: Captures free-form athlete expressions — goals, race reflections, training notes, conditions — and extracts structured observations into the database. Use when the athlete wants to log thoughts, set goals, reflect on a race or workout, describe how they're feeling, or record anything about their training context.
compatibility: Designed for Claude Code within the fit project. Requires bun and data/fit.duckdb.
---

# Record Athlete Thoughts

Converts free-form athlete expression into structured observations stored in the database. The athlete writes naturally. You extract meaning. They validate. You commit.

## Flow

### Step 1 — Determine entry date
Default to today's date. If the athlete refers to a past event ("after yesterday's race", "last Tuesday") infer the correct date and confirm it before proceeding.

### Step 2 — Receive thoughts
If the athlete has already written their thoughts in the message that triggered this skill, use that text directly. Otherwise ask once:

> "What's on your mind? Write freely — goals, how the race went, how you're feeling, what you want to work on. There's no required format."

### Step 3 — Extract observations
Read the full text and extract every discrete piece of structured meaning. Each observation has:

- **type** — one of `goal`, `condition`, `note`, `reflection`
- **subtype** — one of `perceived`, `reported`, or null (see subtype guidance below; never set to `computed`)
- **start_date** — ISO date (YYYY-MM-DD). When does this observation become relevant?
- **end_date** — ISO date or null. When does it stop being relevant? Null means ongoing.
- **title** — short label (under 60 chars)
- **body** — the full extracted meaning, written in third person past/present tense

**Type guidance:**
| Type | Use when the athlete... |
|------|------------------------|
| `goal` | States an intention or target — a race goal, a time target, something they want to achieve |
| `condition` | Describes physical or external state — sleep, fatigue, illness, weather, equipment, injury |
| `note` | Records a fact or observation without strong emotional or evaluative content |
| `reflection` | Evaluates something that happened — what went well, what went wrong, what to change |

**Subtype guidance** (classify at extraction time using linguistic cues alone — no session data needed):
| Subtype | Meaning | Linguistic signal |
|---------|---------|-------------------|
| `perceived` | Athlete's subjective internal experience | "I felt…", "my legs felt…", "I was exhausted", emotional or sensory language |
| `reported` | Factual claim about objective state that is verifiable but may be rationalized | "I slept 4 hours", "I ran easy", "I took it easy in the first mile" |
| `computed` | Derived from session data at analysis time | **Do not set at extraction.** Leave as null — a coaching analysis step will populate this. |

Leave `subtype` null if the sentence mixes both signals or is genuinely ambiguous. When in doubt, prefer `perceived` for internal-state language and `reported` for claims about external facts or behaviors.

**Date range guidance:**
- A season goal: start = first day of the training block, end = race day
- A race-day reflection: start = end = race date
- A current physical condition: start = today, end = null (ongoing until updated)
- A historical note about a past event: start = end = the date it occurred

**One entry can produce multiple observations.** Extract all of them, even if they seem minor.

### Step 4 — Present for validation

Show observations in a numbered list, clearly formatted. Do not write to the database yet.

```
Here's what I extracted. Review each one:

1. [goal] Sub-18 5k (Jan 1 – Jun 30)
   "Run a sub-18:00 5k at a local race this spring."

2. [reflection] Turnaround execution (Feb 21)
   "Braked twice at the first cone. Double-wave braking identified as key area to improve."

3. [condition] Pre-race fatigue (Feb 21 → ongoing)
   "Reported heavy legs and poor sleep the night before the race."

Reply with: "accept all", "reject 2", "edit 3: [corrected text]", or any combination.
```

Wait for the athlete's response before proceeding.

### Step 5 — Handle edits
If the athlete edits an observation, update the body accordingly. Re-show only the edited observations and confirm the change before including them.

### Step 6 — Commit to database
Run the save script with the entry body and all observations (both accepted and rejected — the database stores all pending observations; validation state is applied after):

```bash
echo '<json_payload>' | bun run .agents/skills/record-athlete-thoughts/scripts/save-entry.ts
```

The script returns the entry ID and observation IDs as JSON.

Then run the validate script with each observation's final state:

```bash
echo '<json_payload>' | bun run .agents/skills/record-athlete-thoughts/scripts/validate-observations.ts
```

### Step 7 — Confirm
Report back concisely:

> "Saved. Entry #3 recorded with 2 accepted observations (1 rejected). The sub-18 goal is now active context for all sessions through June 30."

## Edge cases

**Athlete writes nothing actionable** — If the text contains no extractable observations (e.g. "just a quick check-in, all good"), save the entry with `extracted = false` and note that no observations were found. Do not force extraction.

**Ambiguous date range** — Ask once to clarify. Do not guess at season boundaries.

**Duplicate goal** — If the athlete states a goal that closely matches an existing accepted observation, surface the existing one and ask whether this is a replacement or an update to the date range.

**Multiple entries in one message** — If the athlete writes thoughts covering multiple distinct dates, split them into separate entries.
