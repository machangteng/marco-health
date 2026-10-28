import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env");

export function parseEnvFile(text: string): { DATABASE_URL?: string } {
  const result: { DATABASE_URL?: string } = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) {
      throw new Error(`.env line is not KEY=VALUE: ${line}`);
    }
    const key = line.slice(0, eq).trim();
    if (key !== "DATABASE_URL") {
      throw new Error(
        `.env may only set DATABASE_URL (found ${key}). Keep vendor credentials outside this repository.`,
      );
    }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") {
      throw new Error("DATABASE_URL in .env is empty.");
    }
    result.DATABASE_URL = value;
  }
  return result;
}

/** Loads DATABASE_URL from .env when the shell has not already set it. */
export function loadLocalEnv(): void {
  if (!existsSync(ENV_PATH)) return;
  const parsed = parseEnvFile(readFileSync(ENV_PATH, "utf8"));
  if (parsed.DATABASE_URL !== undefined && process.env.DATABASE_URL === undefined) {
    process.env.DATABASE_URL = parsed.DATABASE_URL;
  }
}

export function getDatabaseUrl(): string {
  loadLocalEnv();
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env or export DATABASE_URL.");
  }
  return url.trim();
}

/** Host, port, and database name for logs. The password is omitted. */
export function describeDatabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  const database = parsed.pathname.replace(/^\//, "");
  if (parsed.hostname === "" || database === "") {
    throw new Error("DATABASE_URL must include a host and database name.");
  }
  const port = parsed.port === "" ? "5432" : parsed.port;
  return `${parsed.hostname}:${port}/${database}`;
}
