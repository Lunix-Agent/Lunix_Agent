/**
 * save-target-races.ts
 * Reads a JSON payload from stdin and saves an array of target races.
 * Each call appends new rows — safe to add races incrementally.
 *
 * Usage:
 *   echo '<payload>' | bun run .agents/skills/athlete-profile/scripts/save-target-races.ts
 *
 * Payload shape:
 *   {
 *     "races": [
 *       {
 *         "name": "Spring Classic 5k",
 *         "race_date": "2026-04-12",
 *         "distance": "5k",
 *         "distance_m": 5000,          // optional — exact meters
 *         "priority": "A",             // 'A' | 'B' | 'C'
 *         "goal_time_s": 1080,         // optional — null = no time goal
 *         "goal_type": "time"          // 'time' | 'place' | 'completion' | 'training'
 *       }
 *     ]
 *   }
 *
 * priority:   A = peak effort / key race, B = strong effort, C = training run / experience
 * goal_time_s: target finish in whole seconds (e.g. 18:00 → 1080)
 *
 * Output:
 *   { "saved": 1, "ids": [1] }
 */

import { DuckDBInstance } from "@duckdb/node-api"
import path from "node:path"
import { saveTargetRace, type TargetRaceInput } from "../../../../packages/coaching/src/db/queries.ts"

const DB_PATH = path.resolve(import.meta.dir, "../../../../data/fit.duckdb")

const raw = await new Response(Bun.stdin.stream()).text()

let payload: { races: TargetRaceInput[] }

try {
  payload = JSON.parse(raw)
} catch {
  console.error("Error: stdin must be valid JSON")
  process.exit(1)
}

if (!Array.isArray(payload.races) || payload.races.length === 0) {
  console.error("Error: payload must include a non-empty races array")
  process.exit(1)
}

const instance = await DuckDBInstance.create(DB_PATH)
const conn = await instance.connect()

try {
  const ids: number[] = []
  for (const race of payload.races) {
    if (!race.name || !race.race_date || !race.distance || !race.priority) {
      console.error("Error: each race must have name, race_date, distance, and priority")
      process.exit(1)
    }
    if (!["A", "B", "C"].includes(race.priority)) {
      console.error(`Error: priority must be 'A', 'B', or 'C' — got '${race.priority}'`)
      process.exit(1)
    }
    const id = await saveTargetRace(conn, race)
    ids.push(id)
  }
  console.log(JSON.stringify({ saved: ids.length, ids }))
} catch (err: any) {
  console.error("Error:", err.message)
  process.exit(1)
} finally {
  conn.closeSync()
  instance.closeSync()
  setImmediate(() => process.exit(0))
}
