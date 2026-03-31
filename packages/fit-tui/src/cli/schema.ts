import { DuckDBConnection } from "@duckdb/node-api"

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
}

export interface TableInfo {
  name: string
  columns: ColumnInfo[]
}

export interface SchemaInfo {
  tables: TableInfo[]
}

export async function getSchema(conn: DuckDBConnection): Promise<SchemaInfo> {
  const result = await conn.runAndReadAll(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'main'
    ORDER BY table_name, ordinal_position
  `)
  const rows = result.getRowObjectsJS()

  const tableMap = new Map<string, ColumnInfo[]>()
  for (const row of rows) {
    const table = String(row.table_name)
    if (!tableMap.has(table)) tableMap.set(table, [])
    tableMap.get(table)!.push({
      name: String(row.column_name),
      type: String(row.data_type),
      nullable: String(row.is_nullable) === 'YES',
    })
  }

  return {
    tables: Array.from(tableMap.entries()).map(([name, columns]) => ({ name, columns })),
  }
}
