---
name: athlete-profile
description: Records structured athlete facts — profile details (age, max HR), personal records across distances, and target races on the calendar. Use when the athlete wants to set up their profile, log a PR, add upcoming races, or update any of this information. These are facts, not observations — they go directly into structured tables, not through the entries/observations pipeline.
compatibility: Designed for Claude Code within the fit project. Requires bun and data/fit.duckdb.
---

# Athlete Profile

Records the structured, factual layer of athlete context — the data that doesn't require interpretation to store. Three distinct categories, each saved to its own table.

## What this skill handles

| Category | Data | Table |
|----------|------|-------|
| Profile | Name, age/birthdate, max HR, resting HR | `athlete` |
| Personal records | Distance, time, date, race name | `personal_records` |
| Target races | Race name, date, distance, priority, goal time | `target_races` |

This skill does **not** handle qualitative context (how the athlete felt at their PR, race strategy, training philosophy). That goes through `record-athlete-thoughts`. Once this skill saves structured data, the athlete can use `record-athlete-thoughts` to write context around it.

---

## Flow

### Step 1 — Identify what's being recorded

The athlete may provide all three categories at once, or just one. Work with whatever is given. Do not ask for information they haven't offered.

### Step 2 — Extract structured fields

**Profile fields:**
- `name` — full name or preferred name
- `birthdate` — ISO date. If the athlete gives an age, compute approximate birthdate as `YYYY-01-01` where YYYY = current year minus age, and note the approximation.
- `max_hr` — maximum heart rate in BPM. Accept "max HR is 196" or "my max is 196".
- `resting_hr` — resting heart rate in BPM

**Personal record fields:**
- `distance` — use canonical labels: `5k`, `10k`, `half_marathon`, `marathon`. For other distances use a descriptive string (e.g. `1_mile`, `8k`, `50k`).
- `time_s` — convert any time format to whole seconds:
  - `17:32` → 1052
  - `1:22:45` → 4965
  - `2:58:30` → 10710
- `set_date` — ISO date. If only a year is given, use `YYYY-01-01` and note the approximation.
- `race_name` — optional. The name of the race where it was set.

**Target race fields:**
- `name` — full race name
- `race_date` — ISO date
- `distance` — canonical label (same as PRs)
- `distance_m` — optional. Exact meters if the athlete specifies or if it's a standard distance (5000, 10000, 21097, 42195).
- `priority` — ask if not clear:
  - `A` = peak effort, key race, full taper
  - `B` = strong effort, sub-maximal prep
  - `C` = training race, experience, no pressure
- `goal_time_s` — optional. Convert same as PR times. Null if no time goal.
- `goal_type` — `time` (default) | `place` | `completion` | `training`

### Step 3 — Confirm before saving

Show a summary of what will be saved. For brevity, format it as:

```
Profile: David East, born 1988, max HR 196
PRs: 5k 17:32 (Mar 15 2024, Spring Classic), 10k 36:20 (Nov 5 2023)
Target races:
  • Spring Classic 5k — Apr 12 2026 — A race — goal 18:00
  • Summer 10k — Jun 7 2026 — B race — no time goal
```

Ask: "Save this?" Wait for confirmation before running any scripts.

### Step 4 — Save

Run only the scripts needed for the categories provided.

**Profile:**
```bash
echo '<json>' | bun run .agents/skills/athlete-profile/scripts/save-profile.ts
```

**Personal records:**
```bash
echo '<json>' | bun run .agents/skills/athlete-profile/scripts/save-prs.ts
```

**Target races:**
```bash
echo '<json>' | bun run .agents/skills/athlete-profile/scripts/save-target-races.ts
```

### Step 5 — Confirm

Report back concisely:

> "Saved. Profile set, 2 PRs recorded, 2 target races on the calendar."

If the athlete wants to add context around a PR or race (what shape they were in, race strategy, etc.), tell them: "You can add context around any of these using `record-athlete-thoughts` — just mention which PR or race you're referring to."

---

## Edge cases

**Athlete gives age, not birthdate** — Compute `YYYY-01-01` and note: "I've approximated your birthdate as January 1, YYYY. Correct it anytime."

**PR time in a non-standard format** — Convert to seconds and confirm: "I'm reading 17:32 as 1,052 seconds — does that look right?"

**Goal time for a race stated as a pace** — Convert: "sub-6:00/mile for a 5k" → 6 min/mile × 3.107 miles ≈ 18:38 → 1118 seconds. Confirm the conversion.

**Duplicate PR for the same distance** — Save it. Both rows are kept as history. The most recent is the current PR. Do not delete old ones.

**Priority not stated** — Ask once: "Is this an A race (full taper, peak effort), B race (strong but not peak), or C race (training/experience)?"

**No goal time** — Acceptable. Set `goal_time_s` to null and `goal_type` to `completion` or `training` as appropriate.
