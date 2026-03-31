import { DuckDBInstance } from "@duckdb/node-api"
import { setupDatabase as setupActivityDatabase } from "fitui"

export async function setupDatabase(instance: DuckDBInstance): Promise<void> {
  await setupActivityDatabase(instance)

  const conn = await instance.connect()

  // ── Entries ───────────────────────────────────────────────────────────────
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
  // subtype: 'perceived' | 'reported' | 'computed' | NULL
  //   perceived — athlete's subjective internal experience ("I felt exhausted")
  //   reported  — factual claim about objective state ("I slept 4 hours")
  //   computed  — derived from session data at analysis time
  //   NULL      — not yet classified (all observations start here)
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
  await conn.run(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS subtype TEXT`)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_observations_dates ON observations(start_date, end_date)`)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_observations_state ON observations(validation_state)`)
  await conn.run(`CREATE INDEX IF NOT EXISTS idx_observations_entry ON observations(entry_id)`)

  // ── Athlete Profile ───────────────────────────────────────────────────────
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
  // priority: 'A' | 'B' | 'C'  (A = peak effort, C = fitness/training)
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
}
