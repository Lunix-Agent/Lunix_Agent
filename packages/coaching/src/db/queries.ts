import { DuckDBConnection } from "@duckdb/node-api"

// Re-export all activity queries — coaching consumers have one import point
export * from "fit-tui"

// ─── Entries & Observations ───────────────────────────────────────────────────

export interface ObservationInput {
  type: string
  subtype?: 'perceived' | 'reported' | null
  start_date: string
  end_date?: string | null
  title?: string | null
  body: string
}

export async function recordAthleteThoughts(
  conn: DuckDBConnection,
  entryDate: string,
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
        ${obsId}, ${entryId},
        ${sqlStr(obs.type)}, ${subtype},
        '${obs.start_date}'::DATE, ${endDate},
        ${title}, ${sqlStr(obs.body)}
      )
    `)
    ids.push(obsId)
  }
  await conn.run(`UPDATE entries SET extracted = true WHERE id = ${entryId}`)
  return ids
}

export async function validateObservation(
  conn: DuckDBConnection,
  observationId: number,
  state: 'accepted' | 'rejected'
): Promise<void> {
  await conn.run(`
    UPDATE observations SET validation_state = ${sqlStr(state)} WHERE id = ${observationId}
  `)
}

export async function enrichObservation(
  conn: DuckDBConnection,
  observationId: number,
  subtype: 'perceived' | 'reported' | 'computed'
): Promise<void> {
  await conn.run(`
    UPDATE observations SET subtype = ${sqlStr(subtype)} WHERE id = ${observationId}
  `)
}

export async function getPendingObservations(conn: DuckDBConnection) {
  const reader = await conn.runAndReadAll(`
    SELECT o.id, o.entry_id, o.type, o.subtype,
      CAST(o.start_date AS VARCHAR) AS start_date,
      CAST(o.end_date   AS VARCHAR) AS end_date,
      o.title, o.body,
      CAST(e.entry_date AS VARCHAR) AS entry_date
    FROM observations o
    JOIN entries e ON o.entry_id = e.id
    WHERE o.validation_state = 'pending'
    ORDER BY e.entry_date DESC, o.id
  `)
  return reader.getRowObjectsJS()
}

export async function getActiveCoachingContext(conn: DuckDBConnection, date: string) {
  const reader = await conn.runAndReadAll(`
    SELECT
      o.id, o.type, o.subtype,
      CAST(o.start_date AS VARCHAR) AS start_date,
      CAST(o.end_date   AS VARCHAR) AS end_date,
      o.title, o.body,
      COALESCE(CAST(o.end_date - o.start_date AS INTEGER), 999999) AS duration_days
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
  birthdate?: string | null
  max_hr?: number | null
  resting_hr?: number | null
}

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
      name = excluded.name, birthdate = excluded.birthdate,
      max_hr = excluded.max_hr, resting_hr = excluded.resting_hr,
      updated_at = now()
  `)
}

export async function getAthleteProfile(conn: DuckDBConnection) {
  const reader = await conn.runAndReadAll(`
    SELECT name, CAST(birthdate AS VARCHAR) AS birthdate,
      max_hr, resting_hr, CAST(updated_at AS VARCHAR) AS updated_at
    FROM athlete WHERE id = 1
  `)
  return reader.getRowObjectsJS()[0] ?? null
}

// ─── Personal Records ─────────────────────────────────────────────────────────

export interface PersonalRecordInput {
  distance: string
  time_s: number
  set_date: string
  race_name?: string | null
  entry_id?: number | null
}

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

export async function getPersonalRecords(conn: DuckDBConnection) {
  const reader = await conn.runAndReadAll(`
    SELECT id, distance, time_s, CAST(set_date AS VARCHAR) AS set_date, race_name, entry_id
    FROM personal_records
    ORDER BY distance, set_date DESC
  `)
  return reader.getRowObjectsJS()
}

// ─── Target Races ─────────────────────────────────────────────────────────────

export interface TargetRaceInput {
  name: string
  race_date: string
  distance: string
  distance_m?: number | null
  priority: 'A' | 'B' | 'C'
  goal_time_s?: number | null
  goal_type?: 'time' | 'place' | 'completion' | 'training'
  entry_id?: number | null
}

export async function saveTargetRace(
  conn: DuckDBConnection,
  race: TargetRaceInput
): Promise<number> {
  const idRes = await conn.runAndReadAll(`SELECT nextval('seq_target_races') AS id`)
  const id = Number(idRes.getRowObjectsJS()[0].id)
  await conn.run(`
    INSERT INTO target_races
      (id, name, race_date, distance, distance_m, priority, goal_time_s, goal_type, entry_id)
    VALUES (
      ${id}, ${sqlStr(race.name)},
      '${race.race_date}'::DATE,
      ${sqlStr(race.distance)},
      ${race.distance_m ?? 'NULL'},
      ${sqlStr(race.priority)},
      ${race.goal_time_s ?? 'NULL'},
      ${sqlStr(race.goal_type ?? 'time')},
      ${race.entry_id ?? 'NULL'}
    )
  `)
  return id
}

export async function getTargetRaces(conn: DuckDBConnection, includeCompleted = false) {
  const filter = includeCompleted ? '' : `WHERE completed = false`
  const reader = await conn.runAndReadAll(`
    SELECT id, name, CAST(race_date AS VARCHAR) AS race_date,
      distance, distance_m, priority, goal_time_s, goal_type,
      entry_id, result_session_id, completed
    FROM target_races ${filter}
    ORDER BY race_date
  `)
  return reader.getRowObjectsJS()
}

export async function getActiveTargetRaces(conn: DuckDBConnection, date: string) {
  const reader = await conn.runAndReadAll(`
    SELECT id, name, CAST(race_date AS VARCHAR) AS race_date,
      distance, distance_m, priority, goal_time_s, goal_type,
      completed, result_session_id,
      CAST(CAST(race_date AS DATE) - '${date}'::DATE AS INTEGER) AS days_until
    FROM target_races
    WHERE race_date >= '${date}'::DATE
      OR (completed AND race_date >= ('${date}'::DATE - INTERVAL '60 days'))
    ORDER BY ABS(CAST(CAST(race_date AS DATE) - '${date}'::DATE AS INTEGER))
  `)
  return reader.getRowObjectsJS()
}

// ─── SQL helpers (private) ────────────────────────────────────────────────────

function sqlStr(s: string | undefined | null): string {
  if (s == null) return "NULL"
  return `'${String(s).replace(/'/g, "''")}'`
}
