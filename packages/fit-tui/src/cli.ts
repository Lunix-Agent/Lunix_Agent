#!/usr/bin/env node
/**
 * fitui — FIT file CLI
 *
 * Non-TTY (piped/agent) context → JSON output on stdout
 * TTY context → human-readable output
 *
 * Commands:
 *   fitui schema                                    Print DB schema as JSON
 *   fitui query --sql "<SQL>"                       Execute a SQL query, return rows as JSON
 *   fitui ingest <file.fit> [--dry-run]             Ingest a FIT file (or validate with --dry-run)
 *   fitui view <file.fit> [--mode laps|raw|tree|protocol]  Interactive TUI viewer (TTY only)
 */

import path from "node:path"
import { DuckDBInstance } from "@duckdb/node-api"
import { setupDatabase } from "./db/schema.ts"
import { getSchema } from "./cli/schema.ts"
import { executeQuery } from "./cli/query.ts"
import { dryRunIngest, runIngest } from "./cli/ingest.ts"
import { launchViewer, validateViewArgs } from "./cli/view.ts"

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

// Extract global flags (--db) from all args, then find the command
const allArgs = process.argv.slice(2)
const dbIdx = allArgs.indexOf("--db")
const DB_PATH = (dbIdx !== -1 && allArgs[dbIdx + 1] != null)
  ? path.resolve(allArgs[dbIdx + 1]!)
  : process.env.FIT_DB_PATH
    ? path.resolve(process.env.FIT_DB_PATH)
    : path.resolve("fit.duckdb")
const argsWithoutDb = dbIdx !== -1
  ? [...allArgs.slice(0, dbIdx), ...allArgs.slice(dbIdx + 2)]
  : allArgs

const command = argsWithoutDb[0]
const rest = argsWithoutDb.slice(1)

if (!command || command === "--help" || command === "-h") {
  process.stderr.write([
    "fitui — FIT file CLI",
    "",
    "Global flags:",
    "  --db <path>     Path to DuckDB database (default: $FIT_DB_PATH or ./fit.duckdb)",
    "",
    "Commands:",
    "  fitui schema                                    Print DB schema as JSON",
    "  fitui query --sql \"<SQL>\"                       Execute a SQL query",
    "  fitui ingest <file.fit> [--dry-run]             Ingest or validate a FIT file",
    "  fitui view <file.fit> [--mode laps|raw|tree|protocol]  Interactive TUI (TTY only)",
    "",
    "Non-TTY contexts always receive JSON output.",
  ].join("\n") + "\n")
  process.exit(0)
}

// ─── view command (no DB needed) ─────────────────────────────────────────────

if (command === "view") {
  const filePath = rest.find(a => !a.startsWith("--"))
  const modeIdx = rest.indexOf("--mode")
  const mode = (modeIdx !== -1 && rest[modeIdx + 1]) ? rest[modeIdx + 1]! : "laps"

  const validationError = validateViewArgs(filePath, mode)
  if (validationError) {
    errorOut(validationError.code, validationError.message)
  }

  try {
    await launchViewer(filePath!, mode)
  } catch (err: any) {
    errorOut(err.code ?? "RENDER_FAILED", err.message)
  }
  // TUI takes over — no explicit exit needed
} else {

  // ─── Open DB (only for DB commands) ──────────────────────────────────────

  const instance = await DuckDBInstance.create(DB_PATH)
  await setupDatabase(instance)
  const conn = await instance.connect()

  function close() {
    conn.closeSync()
    instance.closeSync()
  }

  // ─── DB Commands ───────────────────────────────────────────────────────────

  if (command === "schema") {
    const schema = await getSchema(conn)
    out(schema)
    close()
    setImmediate(() => process.exit(0))

  } else if (command === "query") {
    const sqlIdx = rest.indexOf("--sql")
    const sql = sqlIdx !== -1 ? rest[sqlIdx + 1] : undefined
    if (!sql) {
      close()
      errorOut("MISSING_ARG", "query requires --sql \"<SQL>\"")
    }
    try {
      const rows = await executeQuery(conn, sql!)
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
}
