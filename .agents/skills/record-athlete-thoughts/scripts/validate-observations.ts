/**
 * validate-observations.ts
 * Reads a JSON payload from stdin and sets the validation state for each
 * observation. Accepted observations become part of active coaching context.
 * Rejected observations are retained in the database but excluded from analysis.
 *
 * Usage:
 *   echo '<payload>' | bun run .agents/skills/record-athlete-thoughts/scripts/validate-observations.ts
 *
 * Payload shape:
 *   {
 *     "validations": [
 *       { "id": 7, "state": "accepted" },
 *       { "id": 8, "state": "accepted" },
 *       { "id": 9, "state": "rejected" }
 *     ]
 *   }
 *
 * Output:
 *   { "updated": 3, "accepted": 2, "rejected": 1 }
 */

import { DuckDBInstance } from "@duckdb/node-api"
import path from "node:path"
import { validateObservation } from "../../../../src/db/queries.ts"

const DB_PATH = path.resolve(import.meta.dir, "../../../../data/fit.duckdb")

const raw = await new Response(Bun.stdin.stream()).text()

let payload: { validations: Array<{ id: number; state: "accepted" | "rejected" }> }

try {
  payload = JSON.parse(raw)
} catch {
  console.error("Error: stdin must be valid JSON")
  process.exit(1)
}

if (!Array.isArray(payload.validations)) {
  console.error("Error: payload must include a validations array")
  process.exit(1)
}

const instance = await DuckDBInstance.create(DB_PATH)
const conn = await instance.connect()

try {
  let accepted = 0
  let rejected = 0

  for (const v of payload.validations) {
    if (v.state !== "accepted" && v.state !== "rejected") {
      console.error(`Error: invalid state "${v.state}" for id ${v.id}`)
      process.exit(1)
    }
    await validateObservation(conn, v.id, v.state)
    v.state === "accepted" ? accepted++ : rejected++
  }

  console.log(
    JSON.stringify({ updated: payload.validations.length, accepted, rejected })
  )
} catch (err: any) {
  console.error("Error:", err.message)
  process.exit(1)
} finally {
  conn.closeSync()
  instance.closeSync()
  setImmediate(() => process.exit(0))
}
