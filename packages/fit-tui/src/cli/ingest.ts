import path from "node:path"
import { DuckDBConnection } from "@duckdb/node-api"
import { parseFitFile, ingestFile } from "../db/ingest.ts"

export interface DryRunResult {
  valid: boolean
  file: string
  sessions?: number
  laps?: number
  records?: number
  sport?: string | null
  error?: string
}

export interface IngestResult {
  status: 'imported' | 'skipped' | 'error'
  file: string
  sessions?: number
  error?: string
}

function validatePath(filePath: string): string | null {
  if (/\.\.[/\\]/.test(filePath)) return 'path traversal detected'
  if (!filePath.toLowerCase().endsWith('.fit')) return 'file must have a .fit extension'
  return null
}

export async function dryRunIngest(conn: DuckDBConnection, filePath: string): Promise<DryRunResult> {
  const pathError = validatePath(filePath)
  if (pathError) return { valid: false, file: filePath, error: pathError }

  const resolved = path.resolve(process.cwd(), filePath)
  const file = await Bun.file(resolved)
  if (!(await file.exists())) {
    return { valid: false, file: filePath, error: `file not found: ${filePath}` }
  }

  try {
    const summary = await parseFitFile(resolved)
    return { valid: true, file: filePath, ...summary }
  } catch (err: any) {
    return { valid: false, file: filePath, error: err.message }
  }
}

export async function runIngest(conn: DuckDBConnection, filePath: string): Promise<IngestResult> {
  const pathError = validatePath(filePath)
  if (pathError) return { status: 'error', file: filePath, error: pathError }

  const resolved = path.resolve(process.cwd(), filePath)
  try {
    const summary = await ingestFile(conn, resolved)
    if (summary === null || summary.startsWith('SKIP')) {
      return { status: 'skipped', file: filePath }
    }
    // Parse session count from summary string e.g. "1 session(s), 5 laps, 600 records  [running]"
    const sessMatch = summary.match(/^(\d+) session/)
    const sessions = sessMatch ? Number(sessMatch[1]) : undefined
    return { status: 'imported', file: filePath, sessions }
  } catch (err: any) {
    return { status: 'error', file: filePath, error: err.message }
  }
}
