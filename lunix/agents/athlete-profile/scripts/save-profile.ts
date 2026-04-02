/**
 * save-profile.ts
 * Reads a JSON payload from stdin and upserts the athlete profile row.
 * Safe to run multiple times — subsequent runs update the existing row.
 *
 * Usage:
 *   echo '<payload>' | bun run .agents/skills/athlete-profile/scripts/save-profile.ts
 *
 * Payload shape:
 *   {
 *     "name": "David East",
 *     "birthdate": "1988-05-15",   // or null
 *     "max_hr": 196,               // or null
 *     "resting_hr": 52             // or null
 *   }
 *
 * Output:
 *   { "ok": true }
 */

import { DuckDBInstance } from "@duckdb/node-api"
import path from "node:path"
import { setAthleteProfile, type AthleteProfile } from "../../../../packages/coaching/src/db/queries.ts"

const DB_PATH = path.resolve(import.meta.dir, "../../../../data/fit.duckdb")

const raw = await new Response(Bun.stdin.stream()).text()

let payload: AthleteProfile

try {
  payload = JSON.parse(raw)
} catch {
  console.error("Error: stdin must be valid JSON")
  process.exit(1)
}

const instance = await DuckDBInstance.create(DB_PATH)
const conn = await instance.connect()

try {
  await setAthleteProfile(conn, payload)
  console.log(JSON.stringify({ ok: true }))
} catch (err: any) {
  console.error("Error:", err.message)
  process.exit(1)
} finally {
  conn.closeSync()
  instance.closeSync()
  setImmediate(() => process.exit(0))
}
