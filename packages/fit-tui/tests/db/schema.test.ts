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

describe('setupDatabase (fit-tui)', () => {
  it('creates all activity tables', async () => {
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

  it('creates all required sequences', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    const seqs = await sequenceNames(conn)
    expect(seqs).toContain('seq_activities')
    expect(seqs).toContain('seq_sessions')
    expect(seqs).toContain('seq_laps')
    close()
  })

  it('seeds hr_zones with 5 rows', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    const result = await conn.runAndReadAll('SELECT count(*) AS n FROM hr_zones')
    const n = Number(result.getRowObjectsJS()[0].n)
    expect(n).toBe(5)
    close()
  })

  it('is idempotent — running twice does not throw', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    await expect(setupDatabase(instance)).resolves.toBeUndefined()
    const result = await conn.runAndReadAll('SELECT count(*) AS n FROM hr_zones')
    expect(Number(result.getRowObjectsJS()[0].n)).toBe(5)
    close()
  })

  it('sessions table references activities via FK', async () => {
    const { instance, conn, close } = await freshDb()
    await setupDatabase(instance)
    // inserting a session with a non-existent activity_id should fail
    await expect(
      conn.run(`
        INSERT INTO sessions (id, activity_id, session_index, sport, start_time)
        VALUES (1, 99999, 0, 'running', now())
      `)
    ).rejects.toThrow()
    close()
  })
})
