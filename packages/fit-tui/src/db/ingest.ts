import path from "node:path"
import fs from "node:fs"
import FitParser from "fit-file-parser"
import { DuckDBConnection, DuckDBInstance, DuckDBTimestampValue } from "@duckdb/node-api"
import { setupDatabase } from "./schema.ts"

const DB_PATH = path.resolve(import.meta.dir, "../../../../data/fit.duckdb")

// ─── SQL helpers ─────────────────────────────────────────────────────────────

function sqlTs(val: Date | string | number | undefined | null): string {
  if (val == null) return "NULL"
  const d = val instanceof Date ? val : new Date(val as any)
  if (isNaN(d.getTime())) return "NULL"
  return `'${d.toISOString()}'::TIMESTAMP`
}

function sqlStr(s: string | undefined | null): string {
  if (s == null) return "NULL"
  return `'${String(s).replace(/'/g, "''")}'`
}

function sqlNum(n: number | undefined | null): string {
  if (n == null || typeof n !== "number" || isNaN(n) || !isFinite(n)) return "NULL"
  return String(n)
}

function sqlInt(n: number | undefined | null): string {
  if (n == null || typeof n !== "number" || isNaN(n) || !isFinite(n)) return "NULL"
  return String(Math.round(n))
}

function pace(speedKmh: number | undefined | null): string {
  if (!speedKmh || speedKmh === 0) return "NULL"
  return sqlNum(60 / speedKmh)
}

// Convert JS Date to DuckDB timestamp value (microseconds since epoch)
function toTS(val: Date | string | number | undefined | null): DuckDBTimestampValue | null {
  if (val == null) return null
  const d = val instanceof Date ? val : new Date(val as any)
  if (isNaN(d.getTime())) return null
  return new DuckDBTimestampValue(BigInt(d.getTime()) * 1000n)
}

// ─── Per-file ingest (connection provided by caller) ─────────────────────────

/** Returns a summary string on success, null if already imported, throws on error. */
async function ingestFile(conn: DuckDBConnection, fitPath: string): Promise<string | null> {
  const resolved = path.resolve(process.cwd(), fitPath)
  const fileName = path.basename(resolved)

  const buffer = await Bun.file(resolved).arrayBuffer()

  // Content hash — catches duplicate files regardless of name or path
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(new Uint8Array(buffer))
  const fileHash = hasher.digest("hex")

  const parser = new FitParser({
    force: true,
    speedUnit: "km/h",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
    mode: "cascade",
  })
  const fitData = await (parser as any).parseAsync(Buffer.from(buffer))

  const activity = fitData.activity
  if (!activity) throw new Error("No activity found in FIT file")

  const sessions: any[] = activity.sessions ?? []
  if (sessions.length === 0) throw new Error("No sessions found in FIT file")

  // Idempotency check — by path OR by content hash
  const existing = await conn.runAndReadAll(
    `SELECT id, file_path FROM activities WHERE file_path = ${sqlStr(resolved)} OR file_hash = ${sqlStr(fileHash)}`
  )
  if (existing.getRowObjectsJS().length > 0) {
    const row = existing.getRowObjectsJS()[0]
    const reason = String(row.file_path) === resolved ? "same path" : "same content"
    return `SKIP (${reason}: ${path.basename(String(row.file_path))})`
  }

  try {

    // ── Activity ──────────────────────────────────────────────────────────
    await conn.run("BEGIN")

    const actIdRes = await conn.runAndReadAll(`SELECT nextval('seq_activities') AS id`)
    const activityId = Number(actIdRes.getRowObjectsJS()[0].id)

    const firstSession = sessions[0]
    const recordedAt = sqlTs(firstSession.start_time ?? activity.timestamp)
    const sport = sqlStr(firstSession.sport ?? activity.sport ?? null)

    await conn.run(`
      INSERT INTO activities (id, file_path, file_name, file_hash, recorded_at, sport, imported_at)
      VALUES (${activityId}, ${sqlStr(resolved)}, ${sqlStr(fileName)}, ${sqlStr(fileHash)}, ${recordedAt}, ${sport}, now())
    `)

    // ── Sessions + Laps ───────────────────────────────────────────────────
    const sessionIds: number[] = []
    let totalLapCount = 0

    for (let si = 0; si < sessions.length; si++) {
      const sess = sessions[si]

      const sessIdRes = await conn.runAndReadAll(`SELECT nextval('seq_sessions') AS id`)
      const sessionId = Number(sessIdRes.getRowObjectsJS()[0].id)
      sessionIds.push(sessionId)

      const avgSpeed = sess.avg_speed
      const avgCadence = sess.avg_cadence != null ? sess.avg_cadence * 2 : null

      await conn.run(`
        INSERT INTO sessions VALUES (
          ${sessionId},
          ${activityId},
          ${si},
          ${sqlStr(sess.sport)},
          ${sqlStr(sess.sub_sport)},
          ${sqlTs(sess.start_time)},
          ${sqlNum(sess.total_distance)},
          ${sqlNum(sess.total_timer_time)},
          ${sqlInt(sess.total_calories)},
          ${sqlInt(sess.avg_heart_rate)},
          ${sqlInt(sess.max_heart_rate)},
          ${sqlInt(avgCadence)},
          ${sqlNum(avgSpeed)},
          ${sqlNum(sess.max_speed)},
          ${sqlInt(sess.total_ascent)},
          ${sqlInt(sess.total_descent)},
          ${sqlInt(sess.avg_power)},
          ${pace(avgSpeed)},
          ${sqlNum(sess.avg_vertical_oscillation)},
          ${sqlNum(sess.avg_vertical_ratio)},
          ${sqlNum(sess.avg_stance_time)}
        )
      `)

      const laps: any[] = sess.laps ?? []
      totalLapCount += laps.length

      for (let li = 0; li < laps.length; li++) {
        const lap = laps[li]

        const lapIdRes = await conn.runAndReadAll(`SELECT nextval('seq_laps') AS id`)
        const lapId = Number(lapIdRes.getRowObjectsJS()[0].id)
        const lapSpeed = lap.avg_speed
        const lapCadence = lap.avg_cadence != null ? lap.avg_cadence * 2 : null

        await conn.run(`
          INSERT INTO laps VALUES (
            ${lapId},
            ${sessionId},
            ${li},
            ${sqlTs(lap.start_time)},
            ${sqlNum(lap.total_distance)},
            ${sqlNum(lap.total_timer_time)},
            ${sqlInt(lap.avg_heart_rate)},
            ${sqlInt(lap.max_heart_rate)},
            ${sqlNum(lapSpeed)},
            ${sqlInt(lapCadence)},
            ${sqlInt(lap.total_ascent)},
            ${sqlInt(lap.total_descent)},
            ${sqlInt(lap.avg_power)},
            ${pace(lapSpeed)},
            ${sqlNum(lap.avg_vertical_oscillation)},
            ${sqlNum(lap.avg_vertical_ratio)},
            ${sqlNum(lap.avg_stance_time)},
            ${sqlNum(lap["Effort Pace"])}
          )
        `)
      }
    }

    await conn.run("COMMIT")

    // ── Records (appender, after transaction) ────────────────────────────
    let totalRecordCount = 0

    for (let si = 0; si < sessions.length; si++) {
      const sess = sessions[si]
      const sessionId = sessionIds[si]
      const laps: any[] = sess.laps ?? []

      // Deduplicate records across laps by timestamp
      const recordMap = new Map<number, any>()
      for (const lap of laps) {
        for (const rec of lap.records ?? []) {
          const ms = new Date(rec.timestamp).getTime()
          if (!isNaN(ms) && !recordMap.has(ms)) {
            recordMap.set(ms, rec)
          }
        }
      }

      if (recordMap.size === 0) continue

      const appender = await conn.createAppender("records")

      for (const [ms, rec] of recordMap) {
        const ts = new DuckDBTimestampValue(BigInt(ms) * 1000n)

        appender.appendInteger(sessionId)
        appender.appendTimestamp(ts)

        rec.elapsed_time != null
          ? appender.appendInteger(Math.round(rec.elapsed_time))
          : appender.appendNull()

        rec.position_lat != null
          ? appender.appendDouble(rec.position_lat)
          : appender.appendNull()

        rec.position_long != null
          ? appender.appendDouble(rec.position_long)
          : appender.appendNull()

        rec.distance != null
          ? appender.appendFloat(rec.distance)
          : appender.appendNull()

        rec.speed != null
          ? appender.appendFloat(rec.speed)
          : appender.appendNull()

        rec.heart_rate != null
          ? appender.appendInteger(rec.heart_rate)
          : appender.appendNull()

        rec.cadence != null
          ? appender.appendInteger(rec.cadence * 2)
          : appender.appendNull()

        rec.altitude != null
          ? appender.appendFloat(rec.altitude)
          : appender.appendNull()

        rec.power != null
          ? appender.appendInteger(rec.power)
          : appender.appendNull()

        rec.vertical_oscillation != null
          ? appender.appendFloat(rec.vertical_oscillation)
          : appender.appendNull()

        rec.vertical_ratio != null
          ? appender.appendFloat(rec.vertical_ratio)
          : appender.appendNull()

        rec.stance_time != null
          ? appender.appendFloat(rec.stance_time)
          : appender.appendNull()

        rec.step_length != null
          ? appender.appendInteger(Math.round(rec.step_length))
          : appender.appendNull()

        rec["Effort Pace"] != null
          ? appender.appendFloat(rec["Effort Pace"])
          : appender.appendNull()

        appender.endRow()
      }

      appender.flushSync()
      appender.closeSync()
      totalRecordCount += recordMap.size
    }

    return `${sessions.length} session(s), ${totalLapCount} laps, ${totalRecordCount} records  [${firstSession.sport ?? "unknown"}]`
  } catch (err) {
    try { await conn.run("ROLLBACK") } catch {}
    throw err
  }
}

// ─── Collect FIT files from args (files or directories) ──────────────────────

function collectFitFiles(args: string[]): string[] {
  const files: string[] = []
  for (const arg of args) {
    const resolved = path.resolve(process.cwd(), arg)
    const stat = fs.statSync(resolved, { throwIfNoEntry: false })
    if (!stat) {
      console.error(`  Not found: ${arg}`)
    } else if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved)
        .filter(f => f.toLowerCase().endsWith(".fit"))
        .sort()
        .map(f => path.join(resolved, f))
      files.push(...entries)
    } else {
      files.push(resolved)
    }
  }
  return files
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("Usage: bun run src/db/ingest.ts <file.fit> [file2.fit ...] [dir/]")
  process.exit(1)
}

const files = collectFitFiles(args)
if (files.length === 0) {
  console.error("No .fit files found.")
  process.exit(1)
}

console.log(`Found ${files.length} file(s). Opening database...`)
const instance = await DuckDBInstance.create(DB_PATH)
await setupDatabase(instance)
const conn = await instance.connect()

let imported = 0
let skipped = 0
const errors: { file: string; error: string }[] = []

for (let i = 0; i < files.length; i++) {
  const file = files[i]
  const label = `[${i + 1}/${files.length}] ${path.basename(file)}`
  process.stdout.write(`${label} ... `)
  try {
    const summary = await ingestFile(conn, file)
    if (summary === null || summary.startsWith("SKIP")) {
      console.log(summary ?? "already imported")
      skipped++
    } else {
      console.log(summary)
      imported++
    }
  } catch (err: any) {
    console.log(`ERROR: ${err.message}`)
    errors.push({ file: path.basename(file), error: err.message })
  }
}

conn.closeSync()
instance.closeSync()

console.log(`\nDone. ${imported} imported, ${skipped} skipped, ${errors.length} errors.`)
if (errors.length > 0) {
  for (const e of errors) console.error(`  ✗ ${e.file}: ${e.error}`)
}

setImmediate(() => process.exit(errors.length > 0 ? 1 : 0))
