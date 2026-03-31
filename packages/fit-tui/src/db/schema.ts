import { DuckDBInstance } from "@duckdb/node-api"

export async function setupDatabase(instance: DuckDBInstance): Promise<void> {
  const conn = await instance.connect()

  await conn.run(`CREATE SEQUENCE IF NOT EXISTS seq_activities START 1`)
  await conn.run(`CREATE SEQUENCE IF NOT EXISTS seq_sessions START 1`)
  await conn.run(`CREATE SEQUENCE IF NOT EXISTS seq_laps START 1`)

  await conn.run(`
    CREATE TABLE IF NOT EXISTS activities (
      id          INTEGER PRIMARY KEY,
      file_path   TEXT NOT NULL UNIQUE,
      file_name   TEXT NOT NULL,
      file_hash   TEXT UNIQUE,
      recorded_at TIMESTAMP NOT NULL,
      sport       TEXT,
      imported_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `)
  await conn.run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS file_hash TEXT`)

  await conn.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                  INTEGER PRIMARY KEY,
      activity_id         INTEGER NOT NULL REFERENCES activities(id),
      session_index       INTEGER NOT NULL,
      sport               TEXT,
      sub_sport           TEXT,
      start_time          TIMESTAMP NOT NULL,
      total_distance_m    REAL,
      total_duration_s    REAL,
      total_calories      INTEGER,
      avg_heart_rate      INTEGER,
      max_heart_rate      INTEGER,
      avg_cadence_spm     INTEGER,
      avg_speed_kmh       REAL,
      max_speed_kmh       REAL,
      total_ascent_m      INTEGER,
      total_descent_m     INTEGER,
      avg_power_w         INTEGER,
      avg_pace_min_per_km REAL,
      avg_vertical_osc    REAL,
      avg_vertical_ratio  REAL,
      avg_stance_time_ms  REAL
    )
  `)

  await conn.run(`
    CREATE TABLE IF NOT EXISTS laps (
      id                  INTEGER PRIMARY KEY,
      session_id          INTEGER NOT NULL REFERENCES sessions(id),
      lap_index           INTEGER NOT NULL,
      start_time          TIMESTAMP,
      total_distance_m    REAL,
      total_duration_s    REAL,
      avg_heart_rate      INTEGER,
      max_heart_rate      INTEGER,
      avg_speed_kmh       REAL,
      avg_cadence_spm     INTEGER,
      total_ascent_m      INTEGER,
      total_descent_m     INTEGER,
      avg_power_w         INTEGER,
      avg_pace_min_per_km REAL,
      avg_vertical_osc    REAL,
      avg_vertical_ratio  REAL,
      avg_stance_time_ms  REAL,
      effort_pace         REAL
    )
  `)

  await conn.run(`
    CREATE TABLE IF NOT EXISTS records (
      session_id           INTEGER NOT NULL REFERENCES sessions(id),
      ts                   TIMESTAMP NOT NULL,
      elapsed_s            INTEGER,
      lat                  DOUBLE,
      lng                  DOUBLE,
      distance_m           REAL,
      speed_kmh            REAL,
      heart_rate           INTEGER,
      cadence_spm          INTEGER,
      altitude_m           REAL,
      power_w              INTEGER,
      vertical_osc_mm      REAL,
      vertical_ratio_pct   REAL,
      stance_time_ms       REAL,
      step_length_mm       INTEGER,
      effort_pace          REAL,
      PRIMARY KEY (session_id, ts)
    )
  `)

  await conn.run(`CREATE INDEX IF NOT EXISTS idx_sessions_start  ON sessions(start_time DESC)`)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_sessions_sport  ON sessions(sport, start_time DESC)`)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_laps_session    ON laps(session_id, lap_index)`)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_records_session ON records(session_id, elapsed_s)`)

  await conn.run(`
    CREATE TABLE IF NOT EXISTS hr_zones (
      zone    INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      min_bpm INTEGER,
      max_bpm INTEGER
    )
  `)
  await conn.run(`
    INSERT INTO hr_zones (zone, name, min_bpm, max_bpm) VALUES
      (1, 'Recovery',  NULL, 134),
      (2, 'Endurance', 135,  167),
      (3, 'Tempo',     168,  183),
      (4, 'Threshold', 184,  200),
      (5, 'Anaerobic', 201,  NULL)
    ON CONFLICT DO NOTHING
  `)

  conn.closeSync()
}
