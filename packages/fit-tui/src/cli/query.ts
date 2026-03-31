import { DuckDBConnection } from "@duckdb/node-api"

function makeError(code: string, message: string, cause?: unknown) {
  const err = new Error(message) as any
  err.code = code
  err.cause = cause
  return err
}

function hasBadPattern(sql: string): boolean {
  // Reject path traversal and multi-statement injection
  if (/\.\.[/\\]/.test(sql)) return true
  // Reject multiple statements (semicolon not inside string literals)
  // Simple heuristic: any semicolon that isn't inside quotes
  const stripped = sql.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
  if (stripped.includes(';')) return true
  return false
}

export async function executeQuery(
  conn: DuckDBConnection,
  sql: string,
): Promise<Record<string, unknown>[]> {
  if (hasBadPattern(sql)) {
    throw makeError('INPUT_REJECTED', `SQL rejected: contains disallowed pattern`)
  }

  let result
  try {
    result = await conn.runAndReadAll(sql)
  } catch (err: any) {
    throw makeError('QUERY_FAILED', err.message, err)
  }

  const rows = result.getRowObjectsJS()

  // Convert bigints to numbers so output is JSON-serializable
  return rows.map(row => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'bigint' ? Number(v) : v
    }
    return out
  })
}
