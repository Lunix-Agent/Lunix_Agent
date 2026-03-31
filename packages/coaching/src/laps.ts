/**
 * laps.ts — show all laps for a session
 * Usage: bun run src/laps.ts <session_id>
 */

import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api"
import path from "node:path"

const sessionId = Number(process.argv[2])
if (!sessionId) { console.error("Usage: bun run src/laps.ts <session_id>"); process.exit(1) }

const instance = await DuckDBInstance.create(path.resolve("data/fit.duckdb"))
const conn = await instance.connect()

// Find all fast ~350m windows via sliding window on records
// Use a 60s minimum gap to avoid overlapping windows from the same effort
const segReader = await conn.runAndReadAll(`
  WITH candidates AS (
    SELECT
      r1.elapsed_s                             AS start_s,
      r2.elapsed_s                             AS end_s,
      r2.elapsed_s - r1.elapsed_s             AS time_s,
      round(r2.distance_m - r1.distance_m, 1) AS dist_m,
      round(r1.distance_m, 0)                 AS at_dist_m
    FROM records r1
    JOIN records r2
      ON r2.session_id = r1.session_id
     AND r2.distance_m - r1.distance_m BETWEEN 350 AND 400
     AND r2.elapsed_s > r1.elapsed_s
    WHERE r1.session_id = ${sessionId}
  ),
  -- deduplicate: keep only the fastest window starting within each 60s bucket
  bucketed AS (
    SELECT *, (start_s / 60) AS bucket
    FROM candidates
    QUALIFY row_number() OVER (PARTITION BY (start_s / 60) ORDER BY time_s ASC) = 1
  )
  SELECT * FROM bucketed ORDER BY at_dist_m ASC
`)
const segs = segReader.getRowObjectsJS()

const r = await conn.runAndReadAll(`
  SELECT lap_index, total_distance_m, total_duration_s, avg_heart_rate, avg_speed_kmh, avg_power_w
  FROM laps WHERE session_id = ${sessionId} ORDER BY lap_index
`)

const fmt = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`
}

const fmtPace = (kmh: number) => {
  if (!kmh) return "    --"
  const mpk = 60 / kmh
  const m = Math.floor(mpk), s = Math.round((mpk - m) * 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

const rows = r.getRowObjectsJS()
console.log(`\nSession ${sessionId} — ${rows.length} laps\n`)
console.log("Lap   Dist      Time    Pace      HR    Power")
console.log("────  ────────  ──────  ────────  ────  ─────")
rows.forEach(row => {
  const lap  = String(row.lap_index).padStart(3)
  const dist = (Math.round(Number(row.total_distance_m)) + "m").padEnd(8)
  const time = fmt(Number(row.total_duration_s)).padEnd(6)
  const pace = fmtPace(Number(row.avg_speed_kmh)).padEnd(8)
  const hr   = row.avg_heart_rate ? String(row.avg_heart_rate).padEnd(4) : "--  "
  const pwr  = row.avg_power_w ?? "--"
  console.log(` ${lap}  ${dist}  ${time}  ${pace}  ${hr}  ${pwr}`)
})

if (segs.length > 0) {
  console.log("\n~350m windows (sliding window, one per 60s bucket):")
  console.log("  Start    Time   Dist     Extrap→350m")
  console.log("  ───────  ─────  ───────  ───────────")
  segs.forEach(s => {
    const startFmt = fmt(Number(s.start_s))
    const t = Number(s.time_s)
    const dist = Number(s.dist_m)
    const extrap = Math.round(t * (350 / dist))
    console.log(`  ${startFmt.padEnd(7)}  ${fmt(t).padEnd(5)}  ${String(dist)+'m'}  → ${extrap}s`)
  })
}

conn.closeSync()
instance.closeSync()
setImmediate(() => process.exit(0))
