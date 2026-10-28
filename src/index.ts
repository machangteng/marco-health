import type { Pool } from "pg";
import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { describeDatabaseUrl, getDatabaseUrl } from "./env.js";
import { checkHealth, unreachableHealth, type HealthReport, type SqlQuery } from "./health.js";

const port = readPort();

async function main(): Promise<void> {
  const target = describeDatabaseUrl(getDatabaseUrl());
  console.log(`postgres target ${target}`);
  const pool = createPool();
  const query = sqlQuery(pool);
  const server = createApp(pool);

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      rejectListen(error);
    };
    server.once("error", onError);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", onError);
      resolveListen();
    });
  });

  console.log(`marco-health listening on http://127.0.0.1:${port}`);
  console.log(`startup health ${JSON.stringify(await probe(query))}`);

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => {
      void pool.end().finally(() => {
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function probe(query: SqlQuery): Promise<HealthReport> {
  try {
    return await checkHealth(query);
  } catch (error) {
    return unreachableHealth(error);
  }
}

function sqlQuery(pool: Pool): SqlQuery {
  return async (sql, params) => {
    const result = await pool.query(sql, params);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };
}

function readPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw === "") return 3000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT is not a valid TCP port: ${raw}`);
  }
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
