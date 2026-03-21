import { DuckDBInstance } from "@duckdb/node-api"

export async function setupDatabase(dbPath: string): Promise<DuckDBInstance> {
  const instance = await DuckDBInstance.create(dbPath)
  const conn = await instance.connect()

  // Sequences for auto-increment IDs
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

  // Migration: add file_hash to databases created before this column existed
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

  // HR zones — absolute BPM ranges, not percentage-based.
  // NULL min_bpm means no lower bound (Z1); NULL max_bpm means no upper bound (Z5).
  // ON CONFLICT DO NOTHING so manual edits are never overwritten on re-run.
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

  // ── Entries ───────────────────────────────────────────────────────────────
  // Raw, unstructured athlete expressions. The source of truth for all
  // observations. Never modified after creation — re-extract instead.
  await conn.run(`CREATE SEQUENCE IF NOT EXISTS seq_entries START 1`)
  await conn.run(`
    CREATE TABLE IF NOT EXISTS entries (
      id           INTEGER PRIMARY KEY,
      entry_date   DATE NOT NULL,
      body         TEXT NOT NULL,
      extracted    BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMP NOT NULL DEFAULT now()
    )
  `)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(entry_date DESC)`)

  // ── Observations ──────────────────────────────────────────────────────────
  // Structured records extracted from entries by an LLM and validated by the
  // athlete. Scoped to a time range so they apply to any session that falls
  // within that range. Only 'accepted' observations are used in analysis.
  //
  // type:             'goal' | 'condition' | 'note' | 'reflection'
  // validation_state: 'pending' | 'accepted' | 'rejected'
  // end_date NULL:    ongoing — applies from start_date forward indefinitely
  //
  // subtype:          'perceived' | 'reported' | 'computed' | NULL
  //   perceived — athlete's subjective internal experience ("I felt exhausted")
  //   reported  — factual claim about objective state ("I slept 4 hours")
  //   computed  — derived from session data at analysis time; not from language
  //   NULL      — not yet classified (all observations start here)
  //
  // perceived/reported are set at extraction time by linguistic analysis.
  // computed is set later when an LLM has both the observation and session data.
  await conn.run(`CREATE SEQUENCE IF NOT EXISTS seq_observations START 1`)
  await conn.run(`
    CREATE TABLE IF NOT EXISTS observations (
      id               INTEGER PRIMARY KEY,
      entry_id         INTEGER NOT NULL REFERENCES entries(id),
      type             TEXT NOT NULL,
      subtype          TEXT,
      start_date       DATE NOT NULL,
      end_date         DATE,
      title            TEXT,
      body             TEXT NOT NULL,
      validation_state TEXT NOT NULL DEFAULT 'pending',
      created_at       TIMESTAMP NOT NULL DEFAULT now()
    )
  `)
  // Migration: add subtype to databases created before this column existed
  await conn.run(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS subtype TEXT`)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_observations_dates ON observations(start_date, end_date)`)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_observations_state ON observations(validation_state)`)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_observations_entry ON observations(entry_id)`)

  // ── Athlete Profile ───────────────────────────────────────────────────────
  // Single-row table. id is always 1. Upsert to update.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS athlete (
      id         INTEGER PRIMARY KEY,
      name       TEXT,
      birthdate  DATE,
      max_hr     INTEGER,
      resting_hr INTEGER,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `)

  // ── Personal Records ──────────────────────────────────────────────────────
  // One row per distance PR. time_s is always whole seconds.
  // entry_id optionally links to an entry containing context about the race.
  // distance: canonical label — '5k' | '10k' | 'half_marathon' | 'marathon' | custom
  await conn.run(`CREATE SEQUENCE IF NOT EXISTS seq_personal_records START 1`)
  await conn.run(`
    CREATE TABLE IF NOT EXISTS personal_records (
      id         INTEGER PRIMARY KEY,
      distance   TEXT NOT NULL,
      time_s     INTEGER NOT NULL,
      set_date   DATE NOT NULL,
      race_name  TEXT,
      entry_id   INTEGER REFERENCES entries(id),
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_prs_distance ON personal_records(distance, set_date DESC)`)

  // ── Target Races ──────────────────────────────────────────────────────────
  // Upcoming races on the athlete's calendar.
  // priority:          'A' | 'B' | 'C'  (A = peak effort, C = fitness/training)
  // goal_type:         'time' | 'place' | 'completion' | 'training'
  // goal_time_s:       target finish in whole seconds; NULL = no time goal
  // entry_id:          optional link to a race strategy entry
  // result_session_id: populated after the race links to the ingested session
  // completed:         flipped to true after the race
  await conn.run(`CREATE SEQUENCE IF NOT EXISTS seq_target_races START 1`)
  await conn.run(`
    CREATE TABLE IF NOT EXISTS target_races (
      id                INTEGER PRIMARY KEY,
      name              TEXT NOT NULL,
      race_date         DATE NOT NULL,
      distance          TEXT NOT NULL,
      distance_m        REAL,
      priority          TEXT NOT NULL DEFAULT 'B',
      goal_time_s       INTEGER,
      goal_type         TEXT NOT NULL DEFAULT 'time',
      entry_id          INTEGER REFERENCES entries(id),
      result_session_id INTEGER REFERENCES sessions(id),
      completed         BOOLEAN NOT NULL DEFAULT false,
      created_at        TIMESTAMP NOT NULL DEFAULT now()
    )
  `)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_target_races_date ON target_races(race_date)`)

  conn.closeSync()
  return instance
}
