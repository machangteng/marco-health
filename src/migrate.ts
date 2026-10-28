import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { connectWithRetry } from "./db.js";
import { describeDatabaseUrl, getDatabaseUrl } from "./env.js";
import { splitMigration } from "./sql.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const ADVISORY_LOCK_KEY = 406006;

type Direction = "up" | "down" | "status";

type MigrationFile = {
  version: string;
  upPath: string;
  downPath: string;
};

async function main(): Promise<void> {
  const direction = parseDirection(process.argv[2]);
  const target = describeDatabaseUrl(getDatabaseUrl());
  const client = await connectWithRetry();
  try {
    await client.query("SELECT pg_advisory_lock($1::int)", [ADVISORY_LOCK_KEY]);
    if (direction === "status") {
      await printStatus(client);
      return;
    }
    if (direction === "up") {
      await migrateUp(client);
      return;
    }
    await migrateDown(client, target);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::int)", [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

function parseDirection(arg: string | undefined): Direction {
  if (arg === "up" || arg === "down" || arg === "status") return arg;
  throw new Error("usage: npm run migrate | npm run migrate:down | npm run migrate:status");
}

function migrationFiles(): MigrationFile[] {
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".up.sql"))
    .sort();
  return names.map((name) => {
    const version = name.slice(0, -".up.sql".length);
    if (!/^[A-Za-z0-9._-]+$/.test(version)) {
      throw new Error(`unsupported migration filename: ${name}`);
    }
    return {
      version,
      upPath: resolve(MIGRATIONS_DIR, name),
      downPath: resolve(MIGRATIONS_DIR, `${version}.down.sql`),
    };
  });
}

async function appliedVersions(client: Client): Promise<Set<string>> {
  const exists = await client.query<{ name: string | null }>(
    "SELECT to_regclass('public.schema_migrations') AS name",
  );
  if (exists.rows[0]?.name == null) return new Set();
  const result = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return new Set(result.rows.map((row) => row.version));
}

async function migrateUp(client: Client): Promise<void> {
  const applied = await appliedVersions(client);
  const pending = migrationFiles().filter((file) => !applied.has(file.version));
  if (pending.length === 0) {
    console.log("schema up to date");
    return;
  }
  for (const file of pending) {
    if (!existsSync(file.downPath)) {
      throw new Error(`missing down migration for ${file.version}`);
    }
    console.log(`applying ${file.version}`);
    await applyFile(client, file.version, readFileSync(file.upPath, "utf8"), async () => {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file.version]);
    });
    console.log(`applied ${file.version}`);
  }
}

async function migrateDown(client: Client, target: string): Promise<void> {
  const applied = await appliedVersions(client);
  const latest = migrationFiles()
    .filter((file) => applied.has(file.version))
    .at(-1);
  if (!latest) {
    console.log(`nothing to roll back at ${target}`);
    return;
  }
  if (!existsSync(latest.downPath)) {
    throw new Error(`missing down migration for ${latest.version}`);
  }
  console.log(`rolling back ${latest.version}`);
  await applyFile(client, latest.version, readFileSync(latest.downPath, "utf8"), async () => {
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [latest.version]);
  });
  console.log(`rolled back ${latest.version}`);
}

async function applyFile(
  client: Client,
  version: string,
  sql: string,
  beforeCommit: () => Promise<void>,
): Promise<void> {
  const script = splitMigration(sql);
  let current = script.wrapped ? "BEGIN" : "BEGIN";
  if (script.wrapped) {
    if (script.prologue === null) throw new Error(`${version}: missing BEGIN`);
    await client.query(script.prologue);
  } else {
    await client.query("BEGIN");
  }

  try {
    for (const statement of script.body) {
      current = statement.body.slice(0, 120);
      await client.query(statement.raw);
    }
    current = "schema_migrations";
    await beforeCommit();
    current = "COMMIT";
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${version} failed near "${current}": ${message}`);
  }
}

async function printStatus(client: Client): Promise<void> {
  const applied = await appliedVersions(client);
  for (const file of migrationFiles()) {
    const state = applied.has(file.version) ? "applied" : "pending";
    console.log(`${state}\t${file.version}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
