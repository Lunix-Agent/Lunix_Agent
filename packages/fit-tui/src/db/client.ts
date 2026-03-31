import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api"

export interface FitClient {
  conn: DuckDBConnection
  close: () => void
}

export async function createClient(path: string): Promise<FitClient> {
  let instance: DuckDBInstance
  try {
    instance = await DuckDBInstance.create(path)
  } catch (err: any) {
    const error = new Error(`Failed to open database: ${path}`) as any
    error.code = 'DB_OPEN_FAILED'
    error.cause = err
    throw error
  }

  const conn = await instance.connect()

  return {
    conn,
    close() {
      conn.closeSync()
      instance.closeSync()
    },
  }
}
