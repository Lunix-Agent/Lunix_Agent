/**
 * save-prs.ts
 * Reads a JSON payload from stdin and saves an array of personal records.
 * Each call appends new rows — does not deduplicate. If the athlete updates
 * a PR, save the new one; both are retained (historical record).
 *
 * Usage:
 *   echo '<payload>' | bun run .agents/skills/athlete-profile/scripts/save-prs.ts
 *
 * Payload shape:
 *   {
 *     "records": [
 *       {
 *         "distance": "5k",
 *         "time_s": 1052,
 *         "set_date": "2024-03-15",
 *         "race_name": "Local Spring 5k"   // or null
 *       }
 *     ]
 *   }
 *
 * distance canonical labels: '5k' | '10k' | 'half_marathon' | 'marathon' | custom string
 * time_s: finish time in whole seconds (e.g. 17:32 → 1052, 1:22:45 → 4965)
 *
 * Output:
 *   { "saved": 2, "ids": [1, 2] }
 */

import { DuckDBInstance } from "@duckdb/node-api"
import path from "node:path"
import { savePersonalRecord, type PersonalRecordInput } from "../../../../src/db/queries.ts"

const DB_PATH = path.resolve(import.meta.dir, "../../../../data/fit.duckdb")

const raw = await new Response(Bun.stdin.stream()).text()

let payload: { records: PersonalRecordInput[] }

try {
  payload = JSON.parse(raw)
} catch {
  console.error("Error: stdin must be valid JSON")
  process.exit(1)
}

if (!Array.isArray(payload.records) || payload.records.length === 0) {
  console.error("Error: payload must include a non-empty records array")
  process.exit(1)
}

const instance = await DuckDBInstance.create(DB_PATH)
const conn = await instance.connect()

try {
  const ids: number[] = []
  for (const pr of payload.records) {
    if (!pr.distance || typeof pr.time_s !== "number" || !pr.set_date) {
      console.error("Error: each record must have distance, time_s, and set_date")
      process.exit(1)
    }
    const id = await savePersonalRecord(conn, pr)
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
