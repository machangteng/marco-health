import { Client, Pool, type ClientConfig, type PoolConfig } from "pg";
import { describeDatabaseUrl, getDatabaseUrl } from "./env.js";

const RETRY_ATTEMPTS = 30;
const RETRY_DELAY_MS = 1000;

function baseConfig(statementTimeoutMs: number): ClientConfig {
  return {
    connectionString: getDatabaseUrl(),
    application_name: "marco-health",
    connectionTimeoutMillis: 5000,
    options: `-c statement_timeout=${statementTimeoutMs}`,
  };
}

export function createPool(): Pool {
  const config: PoolConfig = {
    ...baseConfig(5000),
    max: 5,
    idleTimeoutMillis: 10_000,
  };
  const pool = new Pool(config);
  pool.on("error", (error: Error) => {
    console.error(`postgres pool error: ${error.message}`);
  });
  return pool;
}

export async function connectWithRetry(): Promise<Client> {
  const target = describeDatabaseUrl(getDatabaseUrl());
  let last: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    const client = new Client(baseConfig(120_000));
    try {
      await client.connect();
      return client;
    } catch (error) {
      last = error;
      await client.end().catch(() => undefined);
      if (attempt === RETRY_ATTEMPTS) break;
      console.error(`waiting for postgres at ${target} (${attempt}/${RETRY_ATTEMPTS})`);
      await delay(RETRY_DELAY_MS);
    }
  }
  const message = last instanceof Error ? last.message : String(last);
  throw new Error(`could not connect to postgres at ${target}: ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
