import { describe, it, expect } from 'bun:test'
import { DuckDBInstance } from '@duckdb/node-api'
import { setupDatabase } from '../../src/db/schema'

async function freshDb() {
  const instance = await DuckDBInstance.create(':memory:')
  const conn = await instance.connect()
  return { instance, conn, close: () => { conn.closeSync(); instance.closeSync() } }
}

async function tableNames(conn: any): Promise<string[]> {
  const result = await conn.runAndReadAll(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'main'
    ORDER BY table_name
  `)
  return result.getRowObjectsJS().map((r: any) => String(r.table_name))
}

async function sequenceNames(conn: any): Promise<string[]> {
  const result = await conn.runAndReadAll(`
    SELECT sequence_name FROM duckdb_sequences()
    ORDER BY sequence_name
  `)
  return result.getRowObjectsJS().map((r: any) => String(r.sequence_name))
}

describe('setupDatabase (coaching)', () => {
  it('creates all activity tables from fit-tui', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    const tables = await tableNames(conn)
    expect(tables).toContain('activities')
    expect(tables).toContain('sessions')
    expect(tables).toContain('laps')
    expect(tables).toContain('records')
    expect(tables).toContain('hr_zones')
    close()
  })

  it('creates all coaching tables', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    const tables = await tableNames(conn)
    expect(tables).toContain('entries')
    expect(tables).toContain('observations')
    expect(tables).toContain('athlete')
    expect(tables).toContain('personal_records')
    expect(tables).toContain('target_races')
    close()
  })

  it('creates all coaching sequences', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    const seqs = await sequenceNames(conn)
    expect(seqs).toContain('seq_entries')
    expect(seqs).toContain('seq_observations')
    expect(seqs).toContain('seq_personal_records')
    expect(seqs).toContain('seq_target_races')
    close()
  })

  it('observations has subtype column', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    const result = await conn.runAndReadAll(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'observations' AND column_name = 'subtype'
    `)
    expect(result.getRowObjectsJS()).toHaveLength(1)
    close()
  })

  it('is idempotent — running twice does not throw', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    await expect(setupDatabase(instance)).resolves.toBeUndefined()
    close()
  })

  it('target_races references sessions via FK', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    // inserting a target race with a non-existent result_session_id should fail
    await expect(
      conn.run(`
        INSERT INTO target_races (id, name, race_date, distance, priority, result_session_id)
        VALUES (1, 'Test Race', '2026-04-01'::DATE, '5k', 'A', 99999)
      `)
    ).rejects.toThrow()
    close()
  })
})
