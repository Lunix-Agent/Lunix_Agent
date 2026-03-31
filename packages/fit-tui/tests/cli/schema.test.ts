import { describe, it, expect, afterEach } from 'bun:test'
import { DuckDBInstance } from '@duckdb/node-api'
import { setupDatabase } from '../../src/db/schema'
import { getSchema } from '../../src/cli/schema'

async function freshDb() {
  const instance = await DuckDBInstance.create(':memory:')
  await setupDatabase(instance)
  const conn = await instance.connect()
  return { instance, conn, close: () => { conn.closeSync(); instance.closeSync() } }
}

describe('getSchema', () => {
  it('returns all table names', async () => {
    const { conn, close } = await freshDb()
    const schema = await getSchema(conn)
    close()
    const names = schema.tables.map(t => t.name)
    expect(names).toContain('activities')
    expect(names).toContain('sessions')
    expect(names).toContain('laps')
    expect(names).toContain('records')
    expect(names).toContain('hr_zones')
  })

  it('returns columns with name and type for each table', async () => {
    const { conn, close } = await freshDb()
    const schema = await getSchema(conn)
    close()
    const activities = schema.tables.find(t => t.name === 'activities')
    expect(activities).toBeDefined()
    const colNames = activities!.columns.map(c => c.name)
    expect(colNames).toContain('id')
    expect(colNames).toContain('file_path')
    expect(colNames).toContain('sport')
    expect(colNames).toContain('recorded_at')
    // each column has a type
    activities!.columns.forEach(c => expect(c.type).toBeTruthy())
  })

  it('output is JSON-serializable', async () => {
    const { conn, close } = await freshDb()
    const schema = await getSchema(conn)
    close()
    expect(() => JSON.stringify(schema)).not.toThrow()
  })
})
