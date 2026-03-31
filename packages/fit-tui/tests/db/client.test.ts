import { describe, it, expect, afterEach } from 'bun:test'
import { createClient, type FitClient } from '../../src/db/client'

describe('createClient', () => {
  let client: FitClient

  afterEach(() => {
    client?.close()
  })

  it('creates an in-memory client with conn and close', async () => {
    client = await createClient(':memory:')
    expect(client).toHaveProperty('conn')
    expect(client).toHaveProperty('close')
  })

  it('conn can execute a query immediately after creation', async () => {
    client = await createClient(':memory:')
    const result = await client.conn.runAndReadAll('SELECT 1 AS n')
    const rows = result.getRowObjectsJS()
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].n)).toBe(1)
  })

  it('close() does not throw', async () => {
    client = await createClient(':memory:')
    expect(() => client.close()).not.toThrow()
  })

  it('throws a typed error for an invalid path', async () => {
    await expect(
      createClient('/nonexistent/path/to.duckdb')
    ).rejects.toMatchObject({ code: 'DB_OPEN_FAILED' })
  })
})
