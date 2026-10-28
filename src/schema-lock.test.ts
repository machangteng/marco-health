import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_DEVICE_SOURCES,
  EXPECTED_RELATIONS,
  LOCKED_MIGRATION_SHA256,
} from "./schema.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function hash(name: string): string {
  const bytes = readFileSync(resolve(root, "db/migrations", name));
  return createHash("sha256").update(bytes).digest("hex");
}

test("locked migration bytes are unchanged", () => {
  assert.equal(hash("20261028_001_health_schema.up.sql"), LOCKED_MIGRATION_SHA256.up);
  assert.equal(hash("20261028_001_health_schema.down.sql"), LOCKED_MIGRATION_SHA256.down);
});

test("up migration keeps 栈 X sources and the health relations", () => {
  const sql = readFileSync(resolve(root, "db/migrations/20261028_001_health_schema.up.sql"), "utf8");
  for (const source of EXPECTED_DEVICE_SOURCES) {
    assert.match(sql, new RegExp(`'${source}'`));
  }
  assert.equal(sql.includes("huami_mifit"), false);
  for (const relation of EXPECTED_RELATIONS) {
    assert.match(sql, new RegExp(`\\b${relation}\\b`));
  }
  assert.match(sql, /\bstand_hours\b/);
  assert.match(sql, /UNIQUE \(device_id, record_type, started_at\)/);
});

test("compose file runs Postgres 16", () => {
  const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
  assert.match(compose, /image:\s*postgres:16\b/);
});
