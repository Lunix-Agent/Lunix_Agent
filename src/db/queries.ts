import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api"
import path from "node:path"

// ─── Query functions ──────────────────────────────────────────────────────────
// Each returns plain JS objects suitable for LLM narration.

/** "What runs do I have?" — one row per session */
export async function listActivities(conn: DuckDBConnection) {
  const reader = await conn.runAndReadAll(`
    SELECT
      s.id                                      AS session_id,
      a.id                                      AS activity_id,
      s.start_time                              AS date,
      round(s.total_distance_m / 1000.0, 2)    AS km,
      round(s.total_duration_s / 60.0, 1)      AS minutes,
      s.avg_pace_min_per_km                     AS pace_min_per_km,
      s.avg_heart_rate                          AS avg_hr,
      s.total_calories                          AS calories,
      a.file_name
    FROM sessions s
    JOIN activities a ON s.activity_id = a.id
    ORDER BY s.start_time DESC
  `)
  return reader.getRowObjectsJS()
}

/** "How much did I run per week?" */
export async function weeklyLoad(conn: DuckDBConnection) {
  const reader = await conn.runAndReadAll(`
    SELECT
      CAST(date_trunc('week', start_time) AS VARCHAR) AS week,
      count(*)                                        AS run_count,
      round(sum(total_distance_m) / 1000.0, 2)       AS total_km,
      round(sum(total_duration_s) / 60.0, 1)         AS total_minutes,
      round(avg(avg_pace_min_per_km), 2)              AS avg_pace,
      round(avg(avg_heart_rate))                      AS avg_hr
    FROM sessions
    GROUP BY date_trunc('week', start_time)
    ORDER BY date_trunc('week', start_time) DESC
  `)
  return reader.getRowObjectsJS()
}

/** "Tell me about my Tuesday run" — full session + lap breakdown */
export async function sessionDetail(conn: DuckDBConnection, sessionId: number) {
  const sessReader = await conn.runAndReadAll(`
    SELECT
      s.*,
      a.file_name,
      a.file_path
    FROM sessions s
    JOIN activities a ON s.activity_id = a.id
    WHERE s.id = ${sessionId}
  `)
  const session = sessReader.getRowObjectsJS()[0] ?? null

  const lapReader = await conn.runAndReadAll(`
    SELECT *
    FROM laps
    WHERE session_id = ${sessionId}
    ORDER BY lap_index
  `)
  const laps = lapReader.getRowObjectsJS()

  return { session, laps }
}

/** "How much time did I spend in zone 2?" — uses stored hr_zones table */
export async function hrZones(conn: DuckDBConnection, sessionId: number) {
  const reader = await conn.runAndReadAll(`
    WITH zone_counts AS (
      SELECT
        z.zone,
        z.name,
        count(*) AS seconds
      FROM records r
      JOIN hr_zones z
        ON (z.min_bpm IS NULL OR r.heart_rate >= z.min_bpm)
       AND (z.max_bpm IS NULL OR r.heart_rate <= z.max_bpm)
      WHERE r.session_id = ${sessionId} AND r.heart_rate IS NOT NULL
      GROUP BY z.zone, z.name
    ),
    total AS (SELECT sum(seconds) AS total FROM zone_counts)
    SELECT
      z.zone,
      z.name,
      z.seconds,
      round(z.seconds * 100.0 / t.total, 1) AS pct
    FROM zone_counts z, total t
    ORDER BY z.zone
  `)
  return reader.getRowObjectsJS()
}

/** Full per-record biomechanical series — for coaching analysis across all five layers */
export async function sessionRecords(conn: DuckDBConnection, sessionId: number) {
  const reader = await conn.runAndReadAll(`
    SELECT
      elapsed_s,
      round(distance_m, 1)                             AS distance_m,
      round(altitude_m, 1)                             AS altitude_m,
      round(speed_kmh, 2)                              AS speed_kmh,
      round(60.0 / nullif(speed_kmh, 0), 3)           AS pace_min_per_km,
      round(
        pace_min_per_km - lag(pace_min_per_km) OVER (ORDER BY elapsed_s),
        3
      )                                                AS pace_delta,
      heart_rate,
      round(
        heart_rate - lag(heart_rate) OVER (ORDER BY elapsed_s),
        0
      )                                                AS hr_delta,
      cadence_spm,
      power_w,
      round(vertical_osc_mm, 1)                       AS vertical_osc_mm,
      round(vertical_ratio_pct, 2)                     AS vertical_ratio_pct,
      round(stance_time_ms, 1)                         AS stance_time_ms,
      step_length_mm,
      round(effort_pace, 3)                            AS effort_pace
    FROM records
    WHERE session_id = ${sessionId}
      AND speed_kmh > 0
      AND elapsed_s IS NOT NULL
    ORDER BY elapsed_s
  `)
  return reader.getRowObjectsJS()
}

/** Per-record pace series with delta — for turnaround/surge detection and time-lost analysis */
export async function paceRecords(conn: DuckDBConnection, sessionId: number) {
  const reader = await conn.runAndReadAll(`
    WITH base AS (
      SELECT
        elapsed_s,
        round(distance_m, 1)                             AS distance_m,
        round(speed_kmh, 2)                              AS speed_kmh,
        round(60.0 / nullif(speed_kmh, 0), 3)           AS pace_min_per_km
      FROM records
      WHERE session_id = ${sessionId}
        AND speed_kmh > 0
        AND distance_m IS NOT NULL
        AND elapsed_s IS NOT NULL
    )
    SELECT
      elapsed_s,
      distance_m,
      speed_kmh,
      pace_min_per_km,
      round(
        pace_min_per_km - lag(pace_min_per_km) OVER (ORDER BY elapsed_s),
        3
      ) AS pace_delta
    FROM base
    ORDER BY elapsed_s
  `)
  return reader.getRowObjectsJS()
}

/** "Did I negative split?" — 30-second pace buckets */
export async function paceProgression(conn: DuckDBConnection, sessionId: number) {
  const reader = await conn.runAndReadAll(`
    SELECT
      (elapsed_s / 30) * 30                              AS bucket_start_s,
      round(avg(speed_kmh), 2)                           AS avg_speed_kmh,
      round(60.0 / nullif(avg(speed_kmh), 0), 2)        AS avg_pace_min_per_km
    FROM records
    WHERE session_id = ${sessionId} AND speed_kmh > 0 AND elapsed_s IS NOT NULL
    GROUP BY bucket_start_s
    ORDER BY bucket_start_s
  `)
  return reader.getRowObjectsJS()
}

/** "How is my fitness trending?" — 7-day vs 28-day rolling averages */
export async function recentForm(conn: DuckDBConnection) {
  const reader = await conn.runAndReadAll(`
    SELECT
      round(
        sum(CASE WHEN start_time >= now() - INTERVAL '7 days'
            THEN total_distance_m END) / 1000.0, 2
      ) AS km_7d,
      round(
        sum(CASE WHEN start_time >= now() - INTERVAL '28 days'
            THEN total_distance_m END) / 1000.0, 2
      ) AS km_28d,
      round(
        avg(CASE WHEN start_time >= now() - INTERVAL '7 days'
            THEN avg_pace_min_per_km END), 2
      ) AS pace_7d,
      round(
        avg(CASE WHEN start_time >= now() - INTERVAL '28 days'
            THEN avg_pace_min_per_km END), 2
      ) AS pace_28d,
      round(
        avg(CASE WHEN start_time >= now() - INTERVAL '7 days'
            THEN avg_heart_rate END)
      ) AS hr_7d,
      round(
        avg(CASE WHEN start_time >= now() - INTERVAL '28 days'
            THEN avg_heart_rate END)
      ) AS hr_28d
    FROM sessions
    WHERE start_time >= now() - INTERVAL '28 days'
  `)
  return reader.getRowObjectsJS()
}

/** "What are my longest runs?" — top N by distance */
export async function longestRuns(conn: DuckDBConnection, n: number = 10) {
  const reader = await conn.runAndReadAll(`
    SELECT
      s.id                                   AS session_id,
      s.start_time                           AS date,
      round(s.total_distance_m / 1000.0, 2) AS km,
      round(s.total_duration_s / 60.0, 1)   AS minutes,
      s.avg_pace_min_per_km                  AS pace_min_per_km,
      s.avg_heart_rate                       AS avg_hr
    FROM sessions s
    ORDER BY s.total_distance_m DESC
    LIMIT ${n}
  `)
  return reader.getRowObjectsJS()
}

// ─── Entries & Observations ───────────────────────────────────────────────────

export interface ObservationInput {
  type: string          // 'goal' | 'condition' | 'note' | 'reflection'
  subtype?: 'perceived' | 'reported' | null  // set at extraction; 'computed' written later at analysis time
  start_date: string    // ISO date string: 'YYYY-MM-DD'
  end_date?: string | null
  title?: string | null
  body: string
}

/** Store a raw athlete expression — the source record before any extraction */
export async function recordAthleteThoughts(
  conn: DuckDBConnection,
  entryDate: string,   // 'YYYY-MM-DD'
  body: string
): Promise<number> {
  const idRes = await conn.runAndReadAll(`SELECT nextval('seq_entries') AS id`)
  const entryId = Number(idRes.getRowObjectsJS()[0].id)
  await conn.run(`
    INSERT INTO entries (id, entry_date, body)
    VALUES (${entryId}, '${entryDate}'::DATE, ${sqlStr(body)})
  `)
  return entryId
}

/** Save LLM-extracted observations for an entry and mark the entry as extracted */
export async function saveExtractedObservations(
  conn: DuckDBConnection,
  entryId: number,
  observations: ObservationInput[]
): Promise<number[]> {
  const ids: number[] = []
  for (const obs of observations) {
    const idRes = await conn.runAndReadAll(`SELECT nextval('seq_observations') AS id`)
    const obsId = Number(idRes.getRowObjectsJS()[0].id)
    const endDate = obs.end_date ? `'${obs.end_date}'::DATE` : "NULL"
    const title = obs.title ? sqlStr(obs.title) : "NULL"
    const subtype = obs.subtype ? sqlStr(obs.subtype) : "NULL"
    await conn.run(`
      INSERT INTO observations (id, entry_id, type, subtype, start_date, end_date, title, body)
      VALUES (
        ${obsId},
        ${entryId},
        ${sqlStr(obs.type)},
        ${subtype},
        '${obs.start_date}'::DATE,
        ${endDate},
        ${title},
        ${sqlStr(obs.body)}
      )
    `)
    ids.push(obsId)
  }
  await conn.run(`UPDATE entries SET extracted = true WHERE id = ${entryId}`)
  return ids
}

/** Accept or reject a single observation after athlete review */
export async function validateObservation(
  conn: DuckDBConnection,
  observationId: number,
  state: 'accepted' | 'rejected'
): Promise<void> {
  await conn.run(`
    UPDATE observations
    SET validation_state = ${sqlStr(state)}
    WHERE id = ${observationId}
  `)
}

/**
 * Write a subtype to an observation — called at analysis time when an LLM has
 * both the observation and session data simultaneously.
 *   'perceived' — athlete's subjective internal experience ("I felt exhausted")
 *   'reported'  — factual claim about objective state ("I slept 4 hours")
 *   'computed'  — derived from session data, not from athlete language
 */
export async function enrichObservation(
  conn: DuckDBConnection,
  observationId: number,
  subtype: 'perceived' | 'reported' | 'computed'
): Promise<void> {
  await conn.run(`
    UPDATE observations
    SET subtype = ${sqlStr(subtype)}
    WHERE id = ${observationId}
  `)
}

/** Return all observations awaiting athlete review */
export async function getPendingObservations(conn: DuckDBConnection) {
  const reader = await conn.runAndReadAll(`
    SELECT
      o.id,
      o.entry_id,
      o.type,
      o.subtype,
      CAST(o.start_date AS VARCHAR) AS start_date,
      CAST(o.end_date   AS VARCHAR) AS end_date,
      o.title,
      o.body,
      CAST(e.entry_date AS VARCHAR) AS entry_date
    FROM observations o
    JOIN entries e ON o.entry_id = e.id
    WHERE o.validation_state = 'pending'
    ORDER BY e.entry_date DESC, o.id
  `)
  return reader.getRowObjectsJS()
}

/**
 * Return all accepted observations covering a specific date — ordered from
 * broadest time range to narrowest so an LLM receives them in coaching priority:
 * life goals first, day-of notes last.
 */
export async function getActiveCoachingContext(conn: DuckDBConnection, date: string) {
  const reader = await conn.runAndReadAll(`
    SELECT
      o.id,
      o.type,
      o.subtype,
      CAST(o.start_date AS VARCHAR) AS start_date,
      CAST(o.end_date   AS VARCHAR) AS end_date,
      o.title,
      o.body,
      -- duration in days, NULL end_date treated as very large (ongoing)
      COALESCE(
        CAST(o.end_date - o.start_date AS INTEGER),
        999999
      ) AS duration_days
    FROM observations o
    WHERE o.validation_state = 'accepted'
      AND o.start_date <= '${date}'::DATE
      AND (o.end_date IS NULL OR o.end_date >= '${date}'::DATE)
    ORDER BY duration_days DESC, o.start_date
  `)
  return reader.getRowObjectsJS()
}

// ─── Athlete Profile ──────────────────────────────────────────────────────────

export interface AthleteProfile {
  name?: string | null
  birthdate?: string | null   // 'YYYY-MM-DD'
  max_hr?: number | null
  resting_hr?: number | null
}

/** Upsert the single athlete profile row (id always 1) */
export async function setAthleteProfile(
  conn: DuckDBConnection,
  profile: AthleteProfile
): Promise<void> {
  const name = profile.name != null ? sqlStr(profile.name) : 'NULL'
  const birthdate = profile.birthdate ? `'${profile.birthdate}'::DATE` : 'NULL'
  const maxHr = profile.max_hr ?? 'NULL'
  const restingHr = profile.resting_hr ?? 'NULL'
  await conn.run(`
    INSERT INTO athlete (id, name, birthdate, max_hr, resting_hr, updated_at)
    VALUES (1, ${name}, ${birthdate}, ${maxHr}, ${restingHr}, now())
    ON CONFLICT (id) DO UPDATE SET
      name       = excluded.name,
      birthdate  = excluded.birthdate,
      max_hr     = excluded.max_hr,
      resting_hr = excluded.resting_hr,
      updated_at = now()
  `)
}

export async function getAthleteProfile(conn: DuckDBConnection) {
  const reader = await conn.runAndReadAll(`
    SELECT
      name,
      CAST(birthdate AS VARCHAR) AS birthdate,
      max_hr,
      resting_hr,
      CAST(updated_at AS VARCHAR) AS updated_at
    FROM athlete WHERE id = 1
  `)
  return reader.getRowObjectsJS()[0] ?? null
}

// ─── Personal Records ─────────────────────────────────────────────────────────

export interface PersonalRecordInput {
  distance: string       // '5k' | '10k' | 'half_marathon' | 'marathon' | custom
  time_s: number         // finish time in whole seconds
  set_date: string       // 'YYYY-MM-DD'
  race_name?: string | null
  entry_id?: number | null
}

/** Save a single PR. Returns the new row id. */
export async function savePersonalRecord(
  conn: DuckDBConnection,
  pr: PersonalRecordInput
): Promise<number> {
  const idRes = await conn.runAndReadAll(`SELECT nextval('seq_personal_records') AS id`)
  const id = Number(idRes.getRowObjectsJS()[0].id)
  const raceName = pr.race_name != null ? sqlStr(pr.race_name) : 'NULL'
  const entryId = pr.entry_id ?? 'NULL'
  await conn.run(`
    INSERT INTO personal_records (id, distance, time_s, set_date, race_name, entry_id)
    VALUES (${id}, ${sqlStr(pr.distance)}, ${pr.time_s}, '${pr.set_date}'::DATE, ${raceName}, ${entryId})
  `)
  return id
}

/** All PRs ordered by distance label then most-recent first */
export async function getPersonalRecords(conn: DuckDBConnection) {
  const reader = await conn.runAndReadAll(`
    SELECT
      id,
      distance,
      time_s,
      CAST(set_date AS VARCHAR) AS set_date,
      race_name,
      entry_id
    FROM personal_records
    ORDER BY distance, set_date DESC
  `)
  return reader.getRowObjectsJS()
}

// ─── Target Races ─────────────────────────────────────────────────────────────

export interface TargetRaceInput {
  name: string
  race_date: string                                          // 'YYYY-MM-DD'
  distance: string                                           // '5k' | '10k' | 'half_marathon' | 'marathon' | custom
  distance_m?: number | null                                 // exact meters if known
  priority: 'A' | 'B' | 'C'
  goal_time_s?: number | null                                // target finish in whole seconds
  goal_type?: 'time' | 'place' | 'completion' | 'training'
  entry_id?: number | null
}

/** Save a single target race. Returns the new row id. */
export async function saveTargetRace(
  conn: DuckDBConnection,
  race: TargetRaceInput
): Promise<number> {
  const idRes = await conn.runAndReadAll(`SELECT nextval('seq_target_races') AS id`)
  const id = Number(idRes.getRowObjectsJS()[0].id)
  const distanceM = race.distance_m ?? 'NULL'
  const goalTimeS = race.goal_time_s ?? 'NULL'
  const goalType = sqlStr(race.goal_type ?? 'time')
  const entryId = race.entry_id ?? 'NULL'
  await conn.run(`
    INSERT INTO target_races
      (id, name, race_date, distance, distance_m, priority, goal_time_s, goal_type, entry_id)
    VALUES (
      ${id},
      ${sqlStr(race.name)},
      '${race.race_date}'::DATE,
      ${sqlStr(race.distance)},
      ${distanceM},
      ${sqlStr(race.priority)},
      ${goalTimeS},
      ${goalType},
      ${entryId}
    )
  `)
  return id
}

/** All target races, optionally including completed ones */
export async function getTargetRaces(conn: DuckDBConnection, includeCompleted = false) {
  const filter = includeCompleted ? '' : `WHERE completed = false`
  const reader = await conn.runAndReadAll(`
    SELECT
      id,
      name,
      CAST(race_date AS VARCHAR) AS race_date,
      distance,
      distance_m,
      priority,
      goal_time_s,
      goal_type,
      entry_id,
      result_session_id,
      completed
    FROM target_races
    ${filter}
    ORDER BY race_date
  `)
  return reader.getRowObjectsJS()
}

/**
 * Target races relevant for a coaching date:
 *   - upcoming races (race_date >= date), ordered by proximity
 *   - recently completed races (within the prior 60 days), for reflection context
 */
export async function getActiveTargetRaces(conn: DuckDBConnection, date: string) {
  const reader = await conn.runAndReadAll(`
    SELECT
      id,
      name,
      CAST(race_date AS VARCHAR) AS race_date,
      distance,
      distance_m,
      priority,
      goal_time_s,
      goal_type,
      completed,
      result_session_id,
      CAST(
        CAST(race_date AS DATE) - '${date}'::DATE
      AS INTEGER) AS days_until
    FROM target_races
    WHERE
      race_date >= '${date}'::DATE
      OR (completed AND race_date >= ('${date}'::DATE - INTERVAL '60 days'))
    ORDER BY ABS(CAST(CAST(race_date AS DATE) - '${date}'::DATE AS INTEGER))
  `)
  return reader.getRowObjectsJS()
}

// ─── SQL helpers (private) ─────────────────────────────────────────────────────

function sqlStr(s: string | undefined | null): string {
  if (s == null) return "NULL"
  return `'${String(s).replace(/'/g, "''")}'`
}

// ─── Smoke test ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  const DB_PATH = path.resolve(import.meta.dir, "../../data/fit.duckdb")

  const pp = (v: unknown) =>
    JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val), 2)

  const instance = await DuckDBInstance.create(DB_PATH)
  const conn = await instance.connect()

  console.log("\n── listActivities ──")
  const activities = await listActivities(conn)
  console.log(pp(activities))

  if (activities.length > 0) {
    const sessionId = Number(activities[0].session_id)

    console.log("\n── weeklyLoad ──")
    console.log(pp(await weeklyLoad(conn)))

    console.log("\n── sessionDetail ──")
    const detail = await sessionDetail(conn, sessionId)
    console.log("Session:", pp(detail.session))
    console.log(`Laps (${detail.laps.length}):`, pp(detail.laps[0]), "...")

    console.log("\n── hrZones ──")
    console.log(pp(await hrZones(conn, sessionId)))

    console.log("\n── paceProgression (first 5 buckets) ──")
    const buckets = await paceProgression(conn, sessionId)
    console.log(pp(buckets.slice(0, 5)))

    console.log("\n── recentForm ──")
    console.log(pp(await recentForm(conn)))

    console.log("\n── longestRuns(5) ──")
    console.log(pp(await longestRuns(conn, 5)))
  }

  conn.closeSync()
  instance.closeSync()
  // DuckDB background threads need a hard exit to avoid hanging
  setImmediate(() => process.exit(0))
}
