import { DuckDBConnection } from "@duckdb/node-api"

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
    SELECT s.*, a.file_name, a.file_path
    FROM sessions s
    JOIN activities a ON s.activity_id = a.id
    WHERE s.id = ${sessionId}
  `)
  const session = sessReader.getRowObjectsJS()[0] ?? null

  const lapReader = await conn.runAndReadAll(`
    SELECT * FROM laps WHERE session_id = ${sessionId} ORDER BY lap_index
  `)
  return { session, laps: lapReader.getRowObjectsJS() }
}

/** "How much time did I spend in zone 2?" */
export async function hrZones(conn: DuckDBConnection, sessionId: number) {
  const reader = await conn.runAndReadAll(`
    WITH zone_counts AS (
      SELECT z.zone, z.name, count(*) AS seconds
      FROM records r
      JOIN hr_zones z
        ON (z.min_bpm IS NULL OR r.heart_rate >= z.min_bpm)
       AND (z.max_bpm IS NULL OR r.heart_rate <= z.max_bpm)
      WHERE r.session_id = ${sessionId} AND r.heart_rate IS NOT NULL
      GROUP BY z.zone, z.name
    ),
    total AS (SELECT sum(seconds) AS total FROM zone_counts)
    SELECT z.zone, z.name, z.seconds,
      round(z.seconds * 100.0 / t.total, 1) AS pct
    FROM zone_counts z, total t
    ORDER BY z.zone
  `)
  return reader.getRowObjectsJS()
}

/** Full per-record biomechanical series — for coaching analysis */
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

/** Per-record pace series with delta — for turnaround/surge detection */
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
      elapsed_s, distance_m, speed_kmh, pace_min_per_km,
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
      round(sum(CASE WHEN start_time >= now() - INTERVAL '7 days'
          THEN total_distance_m END) / 1000.0, 2) AS km_7d,
      round(sum(CASE WHEN start_time >= now() - INTERVAL '28 days'
          THEN total_distance_m END) / 1000.0, 2) AS km_28d,
      round(avg(CASE WHEN start_time >= now() - INTERVAL '7 days'
          THEN avg_pace_min_per_km END), 2)        AS pace_7d,
      round(avg(CASE WHEN start_time >= now() - INTERVAL '28 days'
          THEN avg_pace_min_per_km END), 2)        AS pace_28d,
      round(avg(CASE WHEN start_time >= now() - INTERVAL '7 days'
          THEN avg_heart_rate END))                AS hr_7d,
      round(avg(CASE WHEN start_time >= now() - INTERVAL '28 days'
          THEN avg_heart_rate END))                AS hr_28d
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
