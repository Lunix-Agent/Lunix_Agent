import { describe, it, expect } from 'bun:test'
import { DuckDBInstance } from '@duckdb/node-api'
import { setupDatabase } from '../../src/db/schema'
import { executeQuery } from '../../src/cli/query'

async function freshDb() {
  const instance = await DuckDBInstance.create(':memory:')
  await setupDatabase(instance)
  const conn = await instance.connect()
  return { instance, conn, close: () => { conn.closeSync(); instance.closeSync() } }
}

describe('executeQuery', () => {
  it('returns rows as plain objects', async () => {
    const { conn, close } = await freshDb()
    const rows = await executeQuery(conn, 'SELECT 42 AS n, \'hello\' AS s')
    close()
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].n)).toBe(42)
    expect(rows[0].s).toBe('hello')
  })

  it('returns empty array when no rows match', async () => {
    const { conn, close } = await freshDb()
    const rows = await executeQuery(conn, 'SELECT * FROM activities WHERE 1=0')
    close()
    expect(rows).toEqual([])
  })

  it('output is JSON-serializable (converts bigints)', async () => {
    const { conn, close } = await freshDb()
    const rows = await executeQuery(conn, 'SELECT count(*) AS n FROM hr_zones')
    close()
    expect(() => JSON.stringify(rows)).not.toThrow()
    expect(Number(rows[0].n)).toBe(5)
  })

  it('throws a typed QueryError for invalid SQL', async () => {
    const { conn, close } = await freshDb()
    try {
      await expect(
        executeQuery(conn, 'SELECT * FROM nonexistent_table_xyz')
      ).rejects.toMatchObject({ code: 'QUERY_FAILED' })
    } finally {
      close()
    }
  })

  it('rejects SQL containing path traversal patterns', async () => {
    const { conn, close } = await freshDb()
    try {
      await expect(
        executeQuery(conn, "SELECT '../etc/passwd' AS p")
      ).rejects.toMatchObject({ code: 'INPUT_REJECTED' })
    } finally {
      close()
    }
  })

  it('rejects SQL with semicolons (statement injection guard)', async () => {
    const { conn, close } = await freshDb()
    try {
      await expect(
        executeQuery(conn, 'SELECT 1; DROP TABLE activities')
      ).rejects.toMatchObject({ code: 'INPUT_REJECTED' })
    } finally {
      close()
    }
  })
})
