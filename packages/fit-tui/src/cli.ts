#!/usr/bin/env bun
/**
 * fitui — FIT file CLI
 *
 * Non-TTY (piped/agent) context → JSON output on stdout
 * TTY context → human-readable output
 *
 * Commands:
 *   fitui schema                          Print DB schema as JSON
 *   fitui query --sql "<SQL>"             Execute a SQL query, return rows as JSON
 *   fitui ingest <file.fit> [--dry-run]   Ingest a FIT file (or validate with --dry-run)
 */

import path from "node:path"
import { DuckDBInstance } from "@duckdb/node-api"
import { setupDatabase } from "./db/schema.ts"
import { getSchema } from "./cli/schema.ts"
import { executeQuery } from "./cli/query.ts"
import { dryRunIngest, runIngest } from "./cli/ingest.ts"

const DB_PATH = path.resolve(import.meta.dir, "../../../data/fit.duckdb")
const IS_TTY = Boolean(process.stdout.isTTY)

function out(data: unknown) {
  console.log(JSON.stringify(data, null, IS_TTY ? 2 : 0))
}

function errorOut(code: string, message: string, status = 1) {
  const payload = JSON.stringify({ error: true, code, message })
  process.stderr.write(payload + "\n")
  process.exit(status)
}

// ─── Parse args ──────────────────────────────────────────────────────────────

const [, , command, ...rest] = process.argv

if (!command || command === "--help" || command === "-h") {
  process.stderr.write([
    "fitui — FIT file CLI",
    "",
    "Commands:",
    "  fitui schema                          Print DB schema as JSON",
    "  fitui query --sql \"<SQL>\"             Execute a SQL query",
    "  fitui ingest <file.fit> [--dry-run]   Ingest or validate a FIT file",
    "",
    "Non-TTY contexts always receive JSON output.",
  ].join("\n") + "\n")
  process.exit(0)
}

// ─── Open DB ─────────────────────────────────────────────────────────────────

const instance = await DuckDBInstance.create(DB_PATH)
await setupDatabase(instance)
const conn = await instance.connect()

function close() {
  conn.closeSync()
  instance.closeSync()
}

// ─── Commands ────────────────────────────────────────────────────────────────

if (command === "schema") {
  const schema = await getSchema(conn)
  out(schema)
  close()
  setImmediate(() => process.exit(0))

} else if (command === "query") {
  const sqlIdx = rest.indexOf("--sql")
  if (sqlIdx === -1 || !rest[sqlIdx + 1]) {
    close()
    errorOut("MISSING_ARG", "query requires --sql \"<SQL>\"")
  }
  const sql = rest[sqlIdx + 1]
  try {
    const rows = await executeQuery(conn, sql)
    out(rows)
  } catch (err: any) {
    close()
    errorOut(err.code ?? "QUERY_FAILED", err.message)
  }
  close()
  setImmediate(() => process.exit(0))

} else if (command === "ingest") {
  const filePath = rest.find(a => !a.startsWith("--"))
  const dryRun = rest.includes("--dry-run")

  if (!filePath) {
    close()
    errorOut("MISSING_ARG", "ingest requires a file path")
  }

  if (dryRun) {
    const result = await dryRunIngest(conn, filePath!)
    out(result)
    close()
    setImmediate(() => process.exit(result.valid ? 0 : 1))
  } else {
    const result = await runIngest(conn, filePath!)
    out(result)
    close()
    setImmediate(() => process.exit(result.status === "error" ? 1 : 0))
  }

} else {
  close()
  errorOut("UNKNOWN_COMMAND", `Unknown command: ${command}`)
}
