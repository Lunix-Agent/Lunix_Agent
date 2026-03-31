import { DuckDBConnection } from "@duckdb/node-api"

function makeError(code: string, message: string, cause?: unknown) {
  const err = new Error(message) as any
  err.code = code
  err.cause = cause
  return err
}

// Strip string literals and line comments, then check for banned patterns
function hasBadPattern(sql: string): boolean {
  // Reject path traversal first (fast path, before stripping)
  if (/\.\.[/\\]/.test(sql)) return true

  // Strip single-quoted strings, double-quoted identifiers, and -- line comments
  let stripped = sql
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")       // single-quoted strings (with escapes)
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')        // double-quoted identifiers
    .replace(/--[^\r\n]*/g, '')                  // line comments

  // Reject multiple statements
  if (stripped.includes(';')) return true

  return false
}

// Block write operations — query is read-only
function isWriteStatement(sql: string): boolean {
  const first = sql.trimStart().toUpperCase()
  return /^(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE|COPY|VACUUM|ATTACH|DETACH)\b/.test(first)
}

export async function executeQuery(
  conn: DuckDBConnection,
  sql: string,
): Promise<Record<string, unknown>[]> {
  if (hasBadPattern(sql)) {
    throw makeError('INPUT_REJECTED', `SQL rejected: contains disallowed pattern`)
  }

  if (isWriteStatement(sql)) {
    throw makeError('INPUT_REJECTED', `SQL rejected: query command is read-only (got ${sql.trimStart().split(/\s+/)[0]?.toUpperCase()})`)
  }

  let result
  try {
    result = await conn.runAndReadAll(sql)
  } catch (err: any) {
    throw makeError('QUERY_FAILED', err.message, err)
  }

  const rows = result.getRowObjectsJS()

  // Coerce non-JSON-serializable types
  return rows.map(row => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'bigint') {
        out[k] = Number(v)
      } else if (v instanceof Date) {
        // Preserve DATE columns as YYYY-MM-DD, TIMESTAMP columns as full ISO string.
        // DuckDB returns both as JS Date — distinguish by checking if time is exactly midnight UTC.
        const isDateOnly = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 &&
          v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0
        out[k] = isDateOnly ? v.toISOString().slice(0, 10) : v.toISOString()
      } else {
        out[k] = v
      }
    }
    return out
  })
}
