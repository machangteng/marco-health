import {
  EXPECTED_COLUMNS,
  EXPECTED_DEVICE_SOURCES,
  EXPECTED_RELATIONS,
} from "./schema.js";

export type HealthReport = {
  ok: boolean;
  schemaReady: boolean;
  database: string | null;
  serverVersion: string | null;
  missingRelations: string[];
  missingColumns: string[];
  deviceSourcesOk: boolean;
  error?: string;
};

export type SqlQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export function unreachableHealth(error: unknown): HealthReport {
  return {
    ok: false,
    schemaReady: false,
    database: null,
    serverVersion: null,
    missingRelations: [...EXPECTED_RELATIONS],
    missingColumns: [],
    deviceSourcesOk: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function checkHealth(query: SqlQuery): Promise<HealthReport> {
  const versionResult = await query(
    "SELECT current_database() AS database, current_setting('server_version') AS server_version",
  );
  const versionRow = versionResult.rows[0];
  const database = stringOrNull(versionRow?.database);
  const serverVersion = stringOrNull(versionRow?.server_version);

  const relationResult = await query(
    `SELECT c.relname AS name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'v', 'p')
       AND c.relname = ANY($1::text[])`,
    [...EXPECTED_RELATIONS],
  );
  const present = new Set(relationResult.rows.map((row) => String(row.name)));
  const missingRelations = EXPECTED_RELATIONS.filter((name) => !present.has(name));

  const columnTables = Object.keys(EXPECTED_COLUMNS);
  const columnResult = await query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [columnTables],
  );
  const columns = new Set(
    columnResult.rows.map((row) => `${String(row.table_name)}.${String(row.column_name)}`),
  );
  const missingColumns: string[] = [];
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    for (const column of expected) {
      if (!columns.has(`${table}.${column}`)) missingColumns.push(`${table}.${column}`);
    }
  }

  let deviceSourcesOk = false;
  if (present.has("devices")) {
    const constraintResult = await query(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'public.devices'::regclass
         AND contype = 'c'`,
    );
    const defs = constraintResult.rows.map((row) => String(row.def)).join("\n");
    deviceSourcesOk = EXPECTED_DEVICE_SOURCES.every((source) => defs.includes(`'${source}'`));
  }

  const schemaReady =
    missingRelations.length === 0 && missingColumns.length === 0 && deviceSourcesOk;

  return {
    ok: true,
    schemaReady,
    database,
    serverVersion,
    missingRelations: [...missingRelations],
    missingColumns,
    deviceSourcesOk,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
