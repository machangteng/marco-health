import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import type { Client } from "pg";
import { createApp } from "./app.js";
import { createPool } from "./db.js";
import { ingestBatch } from "./ingest/batch.js";
import { connectWithRetry } from "./db.js";
import { migrateToHead } from "./migrate.js";
import { defaultFixtureDir, runMockPull } from "./pull/mock.js";
import { persistLiveProbe } from "./pull/persist.js";
import { asQueryable, type Queryable } from "./query.js";
import { getSyncRun } from "./sync-run.js";

process.env.DATABASE_URL ??= "postgres://marco:marco@localhost:5432/marco_health";

describe("ingest against postgres", { concurrency: 1 }, () => {
  let client: Client;
  let db: Queryable;

  before(async () => {
    client = await connectWithRetry();
    db = asQueryable(client);
    await migrateToHead(client);
  });

  after(async () => {
    await client.end();
  });

  test("fixture batch upserts heart_rate, daily, sleep, and workout rows", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../fixtures/mi_health/ingest-batch-0.2.json", import.meta.url), "utf8")) as {
      sync_run_id: string;
      records: Array<Record<string, unknown>>;
    };
    const first = await ingestBatch(db, fixture);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.body.accepted, 4);
    assert.equal(first.body.rejected.length, 0);
    const second = await ingestBatch(db, fixture);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.body.upserted, 0);
    assert.equal(second.body.unchanged, 4);

    const heart = await one<{ record_type: string; value_num: number }>(
      `SELECT record_type, value_num
       FROM samples
       WHERE started_at = $1::timestamptz`,
      ["2026-10-27T14:20:00+08:00"],
    );
    assert.equal(heart.record_type, "heart_rate");
    assert.equal(Number(heart.value_num), 76);
    const wireName = await client.query("SELECT 1 FROM samples WHERE record_type = 'hr_sample'");
    assert.equal(wireName.rowCount, 0);

    const daily = await one<{ steps: number; active_kcal: number; stand_hours: number; exercise_minutes: number }>(
      `SELECT steps, active_kcal, stand_hours, exercise_minutes
       FROM daily_aggregates
       WHERE day_local = '2026-10-27' AND record_type = 'daily_summary'
         AND device_id = (SELECT id FROM devices WHERE source = 'mi_health' AND external_id = 'sid-mock-001')`,
      [],
    );
    assert.equal(daily.steps, 8432);
    assert.equal(Number(daily.active_kcal), 312);
    assert.equal(daily.stand_hours, 10);
    assert.equal(daily.exercise_minutes, 28);

    const stages = await one<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM sleep_stages
       WHERE session_id = (
         SELECT id FROM sleep_sessions WHERE started_at = $1::timestamptz AND record_type = 'sleep_session'
       )`,
      ["2026-10-26T23:40:00+08:00"],
    );
    assert.equal(stages.count, "5");

    const workout = await one<{ sport_type: string; title: string; active_kcal: number; vendor_sid: string }>(
      `SELECT sport_type, title, active_kcal, vendor_sid
       FROM workouts
       WHERE started_at = $1::timestamptz AND record_type = 'workout'`,
      ["2026-10-27T18:00:00+08:00"],
    );
    assert.equal(workout.sport_type, "outdoor_running");
    assert.equal(workout.title, "户外跑步");
    assert.equal(Number(workout.active_kcal), 380);
    assert.equal(workout.vendor_sid, "sid-mock-001");

    const run = await getSyncRun(db, fixture.sync_run_id);
    assert.ok(run);
    assert.equal(run.status, "ok");
    assert.equal(run.error_code, null);
    assert.match(run.started_at, /\+08:00$/);
    assert.equal(JSON.stringify(run).includes("passToken"), false);
  });

  test("newer observed_at overwrites and an older one does not", async () => {
    const vendor = `sid-${randomUUID()}`;
    const syncRunId = randomUUID();
    const base = {
      schema_version: "0.2",
      source: "mi_health",
      vendor_sid: vendor,
      sync_run_id: syncRunId,
      observed_at: "2026-10-28T06:31:00+08:00",
      records: [
        {
          type: "daily_summary",
          day: "2026-10-21",
          started_at: "2026-10-21T00:00:00+08:00",
          steps: 100,
          stand_hours: 4,
        },
        {
          type: "hr_sample",
          started_at: "2026-10-21T08:00:00Z",
          bpm: 61,
        },
      ],
    };
    const created = await ingestBatch(db, base);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.body.upserted, 2);

    const again = await ingestBatch(db, {
      ...base,
      sync_run_id: randomUUID(),
      records: [
        { ...base.records[0], steps: 999 },
        { type: "hr_sample", started_at: "2026-10-21T16:00:00+08:00", bpm: 77 },
      ],
    });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.body.unchanged, 2);

    const newer = await ingestBatch(db, {
      ...base,
      sync_run_id: randomUUID(),
      observed_at: "2026-10-28T07:00:00+08:00",
      records: [{ ...base.records[0], steps: 250, stand_hours: 8 }],
    });
    assert.equal(newer.ok, true);
    if (!newer.ok) return;
    assert.equal(newer.body.upserted, 1);
    const daily = await one<{ steps: number; stand_hours: number }>(
      `SELECT steps, stand_hours FROM daily_aggregates
       WHERE device_id = (SELECT id FROM devices WHERE external_id = $1) AND day_local = '2026-10-21'`,
      [vendor],
    );
    assert.equal(daily.steps, 250);
    assert.equal(daily.stand_hours, 8);
    const heart = await one<{ value_num: number }>(
      `SELECT value_num FROM samples
       WHERE device_id = (SELECT id FROM devices WHERE external_id = $1) AND record_type = 'heart_rate'`,
      [vendor],
    );
    assert.equal(Number(heart.value_num), 61);
  });

  test("one invalid record does not roll back the rest", async () => {
    const vendor = `sid-${randomUUID()}`;
    const syncRunId = randomUUID();
    const result = await ingestBatch(db, {
      schema_version: "0.2",
      source: "mi_health",
      vendor_sid: vendor,
      sync_run_id: syncRunId,
      observed_at: "2026-10-28T06:31:00+08:00",
      records: [
        {
          type: "daily_summary",
          day: "2026-10-22",
          started_at: "2026-10-22T00:00:00+08:00",
          steps: 10,
          stand_hours: 1,
        },
        { type: "hr_sample", started_at: "2026-10-22T10:00:00+08:00" },
        { type: "hr_sample", started_at: "2026-10-22T11:00:00+08:00", bpm: 80 },
        { type: "daily_summary", day: "2026-10-22", started_at: "2026-10-22T00:00:00+08:00", stand_hours: 30 },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.body.accepted, 2);
    assert.equal(result.body.rejected.length, 2);
    assert.deepEqual(result.body.rejected.map((item) => item.index), [1, 3]);
    assert.equal(result.body.rejected[0]?.reason, "missing_bpm");
    assert.equal(result.body.rejected[1]?.reason, "invalid_stand_hours");
    const stored = await one<{ steps: number; hearts: string }>(
      `SELECT
         (SELECT steps FROM daily_aggregates d WHERE d.device_id = devices.id AND d.day_local = '2026-10-22') AS steps,
         (SELECT count(*)::text FROM samples s WHERE s.device_id = devices.id AND s.record_type = 'heart_rate') AS hearts
       FROM devices WHERE external_id = $1`,
      [vendor],
    );
    assert.equal(stored.steps, 10);
    assert.equal(stored.hearts, "1");
    const run = await getSyncRun(db, syncRunId);
    assert.equal(run?.status, "partial");
    assert.equal(run?.error_code, "parse_error");
    assert.equal(run?.rows_upserted, 2);
  });

  test("malformed envelopes and foreign devices do not write a sync run", async () => {
    const missingRun = randomUUID();
    const badVersion = await ingestBatch(db, {
      schema_version: "0.1",
      source: "mi_health",
      vendor_sid: "sid-x",
      sync_run_id: missingRun,
      observed_at: "2026-10-28T06:31:00+08:00",
      records: [{ type: "hr_sample", started_at: "2026-10-22T11:00:00+08:00", bpm: 70 }],
    });
    assert.equal(badVersion.ok, false);
    if (badVersion.ok) return;
    assert.equal(badVersion.status, 400);
    assert.equal(await getSyncRun(db, missingRun), null);

    const wrongSource = randomUUID();
    const source = await ingestBatch(db, {
      schema_version: "0.2",
      source: "huami_mifit",
      vendor_sid: "sid-x",
      sync_run_id: wrongSource,
      observed_at: "2026-10-28T06:31:00+08:00",
      records: [{ type: "hr_sample", started_at: "2026-10-22T11:00:00+08:00", bpm: 70 }],
    });
    assert.equal(source.ok, false);
    if (!source.ok) assert.equal(source.status, 409);
    assert.equal(await getSyncRun(db, wrongSource), null);

    const external = `hyper-${randomUUID()}`;
    const inserted = await one<{ id: string }>(
      "INSERT INTO devices (source, external_id) VALUES ('hyperos_sdk', $1) RETURNING id::text AS id",
      [external],
    );
    const mismatch = randomUUID();
    const conflict = await ingestBatch(db, {
      schema_version: "0.2",
      source: "mi_health",
      device_id: inserted.id,
      sync_run_id: mismatch,
      observed_at: "2026-10-28T06:31:00+08:00",
      records: [{ type: "hr_sample", started_at: "2026-10-22T11:00:00+08:00", bpm: 70 }],
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.body.error, "source_mismatch");
    assert.equal(await getSyncRun(db, mismatch), null);
  });

  test("GET sync run drops credential keys", async () => {
    const vendor = `sid-${randomUUID()}`;
    const syncRunId = randomUUID();
    const result = await ingestBatch(db, {
      schema_version: "0.2",
      source: "mi_health",
      vendor_sid: vendor,
      sync_run_id: syncRunId,
      observed_at: "2026-10-28T06:31:00+08:00",
      records: [{ type: "hr_sample", started_at: "2026-10-23T09:00:00+08:00", bpm: 64 }],
    });
    assert.equal(result.ok, true);
    await client.query(
      `UPDATE sync_runs
       SET meta = meta || jsonb_build_object('passToken', $2::text, 'note', 'visible')
       WHERE id = $1::uuid`,
      [syncRunId, "should-not-leak"],
    );
    const run = await getSyncRun(db, syncRunId);
    assert.equal(JSON.stringify(run).includes("should-not-leak"), false);
    assert.equal(run?.meta.note, "visible");
    assert.equal(run?.error_code, null);
  });

  test("mock puller reads fixtures and feeds ingest", async () => {
    const first = await runMockPull(db, defaultFixtureDir());
    const second = await runMockPull(db, defaultFixtureDir());
    assert.equal(first.length, 1);
    assert.equal(first[0]?.result?.ok, true);
    if (first[0]?.result?.ok) assert.equal(first[0].result.body.accepted, 4);
    assert.equal(second[0]?.result?.ok, true);
    if (second[0]?.result?.ok) {
      assert.equal(second[0].result.body.unchanged, 4);
      assert.equal(second[0].result.body.upserted, 0);
    }
    const mode = await one<{ mode: string }>(
      "SELECT meta->>'mode' AS mode FROM sync_runs WHERE id = '7c9e6679-7425-40de-944b-e07fc1f90ae7'::uuid",
      [],
    );
    assert.equal(mode.mode, "mock");
  });

  test("failed live probe writes a sync run and no samples", async () => {
    const syncRunId = randomUUID();
    const vendor = `acct_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await persistLiveProbe(db, {
      skipped: false,
      status: "failed",
      error_code: "auth_expired",
      upstream_status: 401,
      window: { from: "2026-10-27", to: "2026-10-28" },
      records: [],
      sync_run_id: syncRunId,
      vendor_sid: vendor,
      observed_at: "2026-10-28T06:31:00+08:00",
    });
    const run = await getSyncRun(db, syncRunId);
    assert.equal(run?.status, "failed");
    assert.equal(run?.error_code, "auth_expired");
    assert.equal(run?.rows_upserted, 0);
    assert.equal(JSON.stringify(run).includes("passToken"), false);
    const samples = await one<{ count: string }>(
      "SELECT count(*)::text AS count FROM samples WHERE device_id = (SELECT id FROM devices WHERE external_id = $1)",
      [vendor],
    );
    assert.equal(samples.count, "0");
  });

  test("HTTP ingest and sync run routes", async () => {
    const pool: Pool = createPool();
    const server: Server = createApp(pool);
    const port = await listen(server);
    try {
      const vendor = `sid-${randomUUID()}`;
      const syncRunId = randomUUID();
      const response = await fetch(`http://127.0.0.1:${port}/v1/ingest/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema_version: "0.2",
          source: "mi_health",
          vendor_sid: vendor,
          sync_run_id: syncRunId,
          observed_at: "2026-10-28T06:31:00+08:00",
          records: [
            { type: "hr_sample", started_at: "2026-10-24T12:00:00+08:00", bpm: 72 },
            { type: "hr_sample", started_at: "2026-10-24T12:10:00+08:00" },
          ],
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { accepted: number; rejected: Array<{ index: number }> };
      assert.equal(body.accepted, 1);
      assert.equal(body.rejected[0]?.index, 1);
      const runResponse = await fetch(`http://127.0.0.1:${port}/v1/sync/runs/${syncRunId}`);
      assert.equal(runResponse.status, 200);
      const run = (await runResponse.json()) as { status: string; error_code: string | null; rows_upserted: number };
      assert.equal(run.status, "partial");
      assert.equal(run.error_code, "parse_error");
      assert.equal(run.rows_upserted, 1);
      const missing = await fetch(`http://127.0.0.1:${port}/v1/sync/runs/${randomUUID()}`);
      assert.equal(missing.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    }
  });

  async function one<T extends Record<string, unknown>>(text: string, values: unknown[]): Promise<T> {
    const result = await client.query(text, values as never[]);
    const row = result.rows[0];
    if (!row) throw new Error(`no row for ${text}`);
    return row as T;
  }
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}
