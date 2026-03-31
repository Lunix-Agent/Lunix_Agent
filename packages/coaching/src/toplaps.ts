/**
 * toplaps.ts — fastest laps at a given distance
 * Usage: bun run src/toplaps.ts [distance_m] [--top N] [--tolerance pct] [--extrapolate]
 * Examples:
 *   bun run src/toplaps.ts 400                      → top 10 fastest 400m laps (exact ±3%)
 *   bun run src/toplaps.ts 400 --extrapolate        → extrapolate pace to 400m (±20% band)
 *   bun run src/toplaps.ts 400 --extrapolate --tolerance 10
 *   bun run src/toplaps.ts 1609 --extrapolate
 */

import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api"
import path from "node:path"

const distanceM = Number(process.argv[2] ?? 400)
const topIdx = process.argv.indexOf("--top")
const topN = topIdx !== -1 ? Number(process.argv[topIdx + 1]) : 10
const tolIdx = process.argv.indexOf("--tolerance")
const extrapolate = process.argv.includes("--extrapolate")
// Wider default tolerance in extrapolate mode to catch late/early button presses
const tolPct = tolIdx !== -1 ? Number(process.argv[tolIdx + 1]) : extrapolate ? 20 : 3

const lo = distanceM * (1 - tolPct / 100)
const hi = distanceM * (1 + tolPct / 100)

const DB_PATH = path.resolve("data/fit.duckdb")
const instance = await DuckDBInstance.create(DB_PATH)
const conn = await instance.connect()

const reader = await conn.runAndReadAll(`
  SELECT
    l.id          AS lap_id,
    l.session_id,
    l.lap_index,
    l.start_time::VARCHAR                                         AS start_time_utc,
    l.total_distance_m,
    l.total_duration_s,
    -- extrapolated time: what the lap duration would be at exactly target distance
    round(l.total_duration_s * (${distanceM}.0 / l.total_distance_m), 2) AS extrapolated_s,
    l.avg_heart_rate,
    l.avg_speed_kmh,
    l.avg_power_w,
    s.total_distance_m          AS session_total_m
  FROM laps l
  JOIN sessions s ON l.session_id = s.id
  WHERE l.total_distance_m BETWEEN ${lo} AND ${hi}
    AND l.total_duration_s IS NOT NULL
    AND l.total_duration_s > 0
    AND s.start_time >= now() - INTERVAL '1 year'
    AND s.id != 456
  ORDER BY ${extrapolate ? "extrapolated_s" : "l.total_duration_s"} ASC
  LIMIT ${topN}
`)

const rows = reader.getRowObjectsJS()

const fmt = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  if (m > 0) return `${m}:${String(sec).padStart(2, "0")}`
  return `${sec}s`
}

const fmtPace = (speedKmh: number) => {
  if (!speedKmh || speedKmh <= 0) return "--:--"
  const minPerKm = 60 / speedKmh
  const m = Math.floor(minPerKm)
  const s = Math.round((minPerKm - m) * 60)
  return `${m}:${String(s).padStart(2, "0")}/km`
}

const toEasternDate = (utcStr: string) => {
  const d = new Date(utcStr.replace(" ", "T") + "Z")
  return d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2")
}

const mode = extrapolate ? `extrapolated to ${distanceM}m, ±${tolPct}%` : `exact ±${tolPct}%`
console.log(`\nTop ${topN} fastest ~${distanceM}m laps (${mode}, last 12 months)\n`)

if (extrapolate) {
  console.log(`Rank  Date         Lap  Extrap  Actual    Dist      Pace        HR    Power  Session`)
  console.log(`────  ───────────  ───  ──────  ────────  ────────  ──────────  ────  ─────  ───────`)
} else {
  console.log(`Rank  Date         Lap  Time    Dist      Pace        HR    Power  Session`)
  console.log(`────  ───────────  ───  ──────  ────────  ──────────  ────  ─────  ───────`)
}

rows.forEach((r, i) => {
  const rank    = String(i + 1).padStart(4)
  const date    = toEasternDate(String(r.start_time_utc)).padEnd(11)
  const lap     = String(r.lap_index).padStart(3)
  const actual  = fmt(Number(r.total_duration_s)).padEnd(6)
  const extrap  = fmt(Number(r.extrapolated_s)).padEnd(6)
  const dist    = (Math.round(Number(r.total_distance_m)) + "m").padEnd(8)
  const pace    = fmtPace(Number(r.avg_speed_kmh)).padEnd(10)
  const hr      = r.avg_heart_rate ? String(r.avg_heart_rate).padEnd(4) : "--  "
  const pwr     = r.avg_power_w ? String(r.avg_power_w).padEnd(5) : "--   "
  const sesKm   = Math.round(Number(r.session_total_m) / 10) / 100 + "km"

  if (extrapolate) {
    console.log(`${rank}  ${date}  ${lap}  ${extrap}  ${actual}  ${dist}  ${pace}  ${hr}  ${pwr}  ${r.session_id}(${sesKm})`)
  } else {
    console.log(`${rank}  ${date}  ${lap}  ${actual}  ${dist}  ${pace}  ${hr}  ${pwr}  ${r.session_id}(${sesKm})`)
  }
})

conn.closeSync()
instance.closeSync()
setImmediate(() => process.exit(0))
