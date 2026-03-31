import { describe, it, expect } from 'bun:test'
import path from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { setupDatabase } from '../../src/db/schema'
import { dryRunIngest, runIngest } from '../../src/cli/ingest'

const SAMPLE_FIT = path.resolve(import.meta.dir, '../../../../data/475490951656144900.fit')

async function freshDb() {
  const instance = await DuckDBInstance.create(':memory:')
  await setupDatabase(instance)
  const conn = await instance.connect()
  return { instance, conn, close: () => { conn.closeSync(); instance.closeSync() } }
}

describe('dryRunIngest', () => {
  it('validates a real .fit file without writing to db', async () => {
    const { conn, close } = await freshDb()
    const result = await dryRunIngest(conn, SAMPLE_FIT)
    close()
    expect(result.valid).toBe(true)
    expect(result.file).toBe(SAMPLE_FIT)
    expect(result.sessions).toBeGreaterThan(0)
  })

  it('returns invalid for a non-existent file', async () => {
    const { conn, close } = await freshDb()
    const result = await dryRunIngest(conn, '/no/such/file.fit')
    close()
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('returns invalid for a non-.fit file', async () => {
    const { conn, close } = await freshDb()
    const result = await dryRunIngest(conn, '/tmp/not-a-fit.txt')
    close()
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/\.fit/i)
  })

  it('returns invalid for a path traversal', async () => {
    const { conn, close } = await freshDb()
    const result = await dryRunIngest(conn, '../../etc/passwd.fit')
    close()
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/path traversal/i)
  })

  it('does not import the file (activities table stays empty)', async () => {
    const { conn, close } = await freshDb()
    await dryRunIngest(conn, SAMPLE_FIT)
    const res = await conn.runAndReadAll('SELECT count(*) AS n FROM activities')
    close()
    expect(Number(res.getRowObjectsJS()[0].n)).toBe(0)
  })
})

describe('runIngest', () => {
  it('imports a real .fit file and returns a summary', async () => {
    const { conn, close } = await freshDb()
    const result = await runIngest(conn, SAMPLE_FIT)
    close()
    expect(result.status).toBe('imported')
    expect(result.file).toBe(SAMPLE_FIT)
    expect(result.sessions).toBeGreaterThan(0)
  })

  it('skips a file that was already imported (idempotent)', async () => {
    const { conn, close } = await freshDb()
    await runIngest(conn, SAMPLE_FIT)
    const result = await runIngest(conn, SAMPLE_FIT)
    close()
    expect(result.status).toBe('skipped')
  })
})
