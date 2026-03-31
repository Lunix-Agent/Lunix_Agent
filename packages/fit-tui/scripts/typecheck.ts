import { DuckDBInstance } from '@duckdb/node-api'
const inst = await DuckDBInstance.create(':memory:')
const conn = await inst.connect()
await conn.run("CREATE TABLE t (d DATE, ts TIMESTAMP)")
await conn.run("INSERT INTO t VALUES ('2026-04-01'::DATE, '2026-04-01 12:00:00'::TIMESTAMP)")
const r = await conn.runAndReadAll('SELECT d, ts FROM t')
const rows = r.getRowObjectsJS()
const row = rows[0] as any
console.log('DATE  value:', JSON.stringify(row.d), '| constructor:', row.d?.constructor?.name)
console.log('TS    value:', JSON.stringify(row.ts), '| constructor:', row.ts?.constructor?.name)
conn.closeSync(); inst.closeSync()
setImmediate(() => process.exit(0))
