import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { splitMigration, splitSql } from "./sql.js";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../db/migrations");

test("splitSql keeps semicolons inside strings, comments, and dollar quotes", () => {
  const statements = splitSql(`
    -- keep; this comment
    SELECT 'a;b';
    SELECT 'it''s; fine';
    SELECT $tag$a;b$tag$;
    /* block; comment */
    SELECT 4;
  `);
  assert.deepEqual(
    statements.map((statement) => statement.body),
    ["SELECT 'a;b'", "SELECT 'it''s; fine'", "SELECT $tag$a;b$tag$", "SELECT 4"],
  );
});

test("splitSql keeps a semicolon that sits in an end-of-line comment", () => {
  const statements = splitSql(`
    CREATE TABLE sync_runs (
      meta jsonb NOT NULL DEFAULT '{}'::jsonb  -- window; no secrets
    );
  `);
  assert.equal(statements.length, 1);
  assert.match(statements[0]?.body ?? "", /CREATE TABLE sync_runs/);
  assert.match(statements[0]?.body ?? "", /meta jsonb/);
});

test("locked up migration is one BEGIN/COMMIT script", () => {
  const sql = readFileSync(resolve(migrationsDir, "20261028_001_health_schema.up.sql"), "utf8");
  const statements = splitSql(sql);
  assert.equal(statements.length, 25);
  assert.equal(statements[0]?.body, "BEGIN");
  assert.equal(statements.at(-1)?.body, "COMMIT");

  const script = splitMigration(sql);
  assert.equal(script.wrapped, true);
  assert.equal(script.body.length, 23);
  const bodies = script.body.map((statement) => statement.body);
  assert.equal(bodies.filter((body) => body.startsWith("CREATE TABLE")).length, 7);
  assert.equal(bodies.filter((body) => body.startsWith("CREATE INDEX")).length, 8);
  assert.ok(bodies.some((body) => body.includes("小米运动健康云; hyperos_sdk")));
  assert.ok(bodies.some((body) => body.includes("Not Apple Stand; not a steps-proxy.")));
  const syncRuns = bodies.find((body) => body.startsWith("CREATE TABLE sync_runs"));
  assert.ok(syncRuns);
  assert.match(syncRuns, /error_code/);
  assert.match(syncRuns, /meta jsonb/);
  assert.ok(bodies.some((body) => body.includes("WHERE vendor_sid IS NOT NULL")));
  assert.ok(bodies.some((body) => body.startsWith("CREATE OR REPLACE VIEW v_ui_day")));
});

test("locked down migration drops the view before the tables", () => {
  const sql = readFileSync(resolve(migrationsDir, "20261028_001_health_schema.down.sql"), "utf8");
  const script = splitMigration(sql);
  assert.equal(script.wrapped, true);
  assert.deepEqual(
    script.body.map((statement) => statement.body),
    [
      "DROP VIEW IF EXISTS v_ui_day",
      "DROP TABLE IF EXISTS sleep_stages",
      "DROP TABLE IF EXISTS sleep_sessions",
      "DROP TABLE IF EXISTS workouts",
      "DROP TABLE IF EXISTS samples",
      "DROP TABLE IF EXISTS daily_aggregates",
      "DROP TABLE IF EXISTS sync_runs",
      "DROP TABLE IF EXISTS devices",
    ],
  );
});
