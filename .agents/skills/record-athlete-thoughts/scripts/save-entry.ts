/**
 * save-entry.ts
 * Reads a JSON payload from stdin, writes an entry and its observations to the
 * database (all observations stored as 'pending'), and prints the resulting IDs.
 *
 * Usage:
 *   echo '<payload>' | bun run .agents/skills/record-athlete-thoughts/scripts/save-entry.ts
 *
 * Payload shape:
 *   {
 *     "entry_date": "2026-02-21",
 *     "body": "...",
 *     "observations": [
 *       {
 *         "type": "goal",
 *         "start_date": "2026-01-01",
 *         "end_date": "2026-06-30",       // or null
 *         "title": "Sub-18 5k",           // or null
 *         "body": "Run a sub-18:00 5k."
 *       }
 *     ]
 *   }
 *
 * Output:
 *   { "entry_id": 4, "observation_ids": [7, 8, 9] }
 */

import { DuckDBInstance } from "@duckdb/node-api"
import path from "node:path"
import {
  recordAthleteThoughts,
  saveExtractedObservations,
  type ObservationInput,
} from "../../../../packages/coaching/src/db/queries.ts"

const DB_PATH = path.resolve(import.meta.dir, "../../../../data/fit.duckdb")

const raw = await new Response(Bun.stdin.stream()).text()

let payload: { entry_date: string; body: string; observations: ObservationInput[] }

try {
  payload = JSON.parse(raw)
} catch {
  console.error("Error: stdin must be valid JSON")
  process.exit(1)
}

if (!payload.entry_date || !payload.body) {
  console.error("Error: payload must include entry_date and body")
  process.exit(1)
}

const instance = await DuckDBInstance.create(DB_PATH)
const conn = await instance.connect()

try {
  const entryId = await recordAthleteThoughts(conn, payload.entry_date, payload.body)
  const observationIds = await saveExtractedObservations(
    conn,
    entryId,
    payload.observations ?? []
  )
  console.log(JSON.stringify({ entry_id: entryId, observation_ids: observationIds }))
} catch (err: any) {
  console.error("Error:", err.message)
  process.exit(1)
} finally {
  conn.closeSync()
  instance.closeSync()
  setImmediate(() => process.exit(0))
}
