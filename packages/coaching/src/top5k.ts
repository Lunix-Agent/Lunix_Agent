/**
 * top5k.ts — fastest N-meter segment finder
 * Usage: bun run src/top5k.ts [distance_m] [--top N]
 * Examples:
 *   bun run src/top5k.ts          → top 10 fastest 5K segments
 *   bun run src/top5k.ts 200      → top 10 fastest 200m segments
 *   bun run src/top5k.ts 1609     → top 10 fastest mile segments
 *   bun run src/top5k.ts 200 --top 5
 */

import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api"
import path from "node:path"

const distanceM = Number(process.argv[2] ?? 5000)
const topIdx = process.argv.indexOf("--top")
const topN = topIdx !== -1 ? Number(process.argv[topIdx + 1]) : 10
// Tolerance: at least 2 GPS seconds of travel (~10m/s max) so we always catch the crossing
const tolerance = Math.max(50, distanceM * 0.05)

const DB_PATH = path.resolve("data/fit.duckdb")
const instance = await DuckDBInstance.create(DB_PATH)
const conn = await instance.connect()

const sessReader = await conn.runAndReadAll(`
  SELECT id, start_time::VARCHAR AS start_time_utc, total_distance_m
  FROM sessions
  WHERE total_distance_m >= ${distanceM}
    AND start_time >= now() - INTERVAL '1 year'
    AND id != 456
  ORDER BY id
`)
const sessions = sessReader.getRowObjectsJS()
console.error(`Checking ${sessions.length} sessions for best ${distanceM}m segment...`)

const results: { sessionId: number; startTimeUtc: string; totalKm: number; timeS: number }[] = []

for (const s of sessions) {
  const sid = Number(s.id)
  const r = await conn.runAndReadAll(`
    SELECT MIN(r2.elapsed_s - r1.elapsed_s) AS time_s
    FROM records r1
    JOIN records r2
      ON r2.session_id = r1.session_id
     AND r2.distance_m - r1.distance_m BETWEEN ${distanceM} AND ${distanceM + tolerance}
     AND r2.elapsed_s > r1.elapsed_s
    WHERE r1.session_id = ${sid}
  `)
  const row = r.getRowObjectsJS()[0]
  if (row?.time_s != null) {
    results.push({
      sessionId: sid,
      startTimeUtc: String(s.start_time_utc),
      totalKm: Math.round(Number(s.total_distance_m) / 10) / 100,
      timeS: Number(row.time_s),
    })
  }
}

results.sort((a, b) => a.timeS - b.timeS)
const top = results.slice(0, topN)

const fmt = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m > 0) return `${m}:${String(sec).padStart(2, "0")}`
  return `${sec}s`
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

console.log(`\nTop ${topN} fastest ${distanceM}m segments (last 12 months)\n`)
console.log("Rank  Date         Time     Total run   Session")
console.log("────  ───────────  ───────  ──────────  ───────")
top.forEach((r, i) => {
  const rank = String(i + 1).padStart(4)
  const date = toEasternDate(r.startTimeUtc).padEnd(11)
  const time = fmt(r.timeS).padEnd(7)
  const km   = (String(r.totalKm) + "km").padEnd(10)
  console.log(`${rank}  ${date}  ${time}  ${km}  ${r.sessionId}`)
})

conn.closeSync()
instance.closeSync()
setImmediate(() => process.exit(0))
