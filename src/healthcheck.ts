import type { Client } from "pg";
import { connectWithRetry } from "./db.js";
import { describeDatabaseUrl, getDatabaseUrl } from "./env.js";
import { checkHealth, unreachableHealth, type SqlQuery } from "./health.js";

async function main(): Promise<void> {
  const target = describeDatabaseUrl(getDatabaseUrl());
  console.error(`checking ${target}`);
  let client: Client;
  try {
    client = await connectWithRetry();
  } catch (error) {
    console.log(JSON.stringify(unreachableHealth(error), null, 2));
    process.exit(1);
  }

  const query: SqlQuery = async (sql, params) => {
    const result = await client.query(sql, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };

  try {
    const report = await checkHealth(query);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok || !report.schemaReady) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.log(JSON.stringify(unreachableHealth(error), null, 2));
  process.exit(1);
});
