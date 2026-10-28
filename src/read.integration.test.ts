import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "./app.js";
import { connectWithRetry, createPool } from "./db.js";
import { migrateToHead } from "./migrate.js";
import { asQueryable, type Queryable } from "./query.js";
import { readToday } from "./read/service.js";
import type { Client } from "pg";

process.env.DATABASE_URL ??= "postgres://marco:marco@localhost:5432/marco_health";

describe("read API against postgres", { concurrency: 1 }, () => {
  let client: Client;
  let db: Queryable;
  let pool: Pool;
  let server: Server;
  let port = 0;
  let deviceId = "";

  before(async () => {
    client = await connectWithRetry();
    db = asQueryable(client);
    await migrateToHead(client);
    pool = createPool();
    server = createApp(pool);
    port = await listen(server);
  });

  after(async () => {
    if (deviceId !== "") {
      await client.query("DELETE FROM devices WHERE id = $1::uuid", [deviceId]);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await client.end();
  });

  test("a seeded daily_aggregates row maps rings, heart_rate, sleep, and workouts", async () => {
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO devices (source, external_id, timezone) VALUES ('mi_health', $1, 'Asia/Shanghai') RETURNING id::text AS id",
      [`read-${randomUUID()}`],
    );
    deviceId = inserted.rows[0]?.id ?? "";
    assert.notEqual(deviceId, "");
    await client.query(
      `INSERT INTO daily_aggregates (
         device_id, record_type, started_at, day_local,
         steps, distance_m, floors, active_kcal, exercise_minutes, stand_hours,
         resting_hr_bpm, hr_zone_minutes, sleep_score
       ) VALUES (
         $1::uuid, 'daily_summary', '2024-06-15T00:00:00+08:00', '2024-06-15',
         12345, 9000, NULL, 501, 44, 11,
         61, '{"warm_up":9,"fat_burning":8,"aerobic":7,"anaerobic":6,"extreme":1}'::jsonb, 77
       )`,
      [deviceId],
    );
    await client.query(
      `INSERT INTO samples (device_id, record_type, started_at, value_num, unit)
       VALUES ($1::uuid, 'heart_rate', '2024-06-15T14:22:00+08:00', 88, 'bpm')`,
      [deviceId],
    );
    const sleep = await client.query<{ id: string }>(
      `INSERT INTO sleep_sessions (
         device_id, record_type, started_at, ended_at, score,
         deep_min, light_min, rem_min, awake_min, awake_count,
         efficiency, avg_hr_bpm, min_hr_bpm, max_hr_bpm, avg_spo2
       ) VALUES (
         $1::uuid, 'sleep_session', '2024-06-14T23:10:00+08:00', '2024-06-15T06:40:00+08:00', 77,
         90, 210, 80, 15, 2,
         NULL, 54, 46, 71, 97
       )
       RETURNING id::text AS id`,
      [deviceId],
    );
    await client.query(
      `INSERT INTO sleep_stages (session_id, stage, started_at, ended_at)
       VALUES ($1::uuid, 'deep', '2024-06-15T01:00:00+08:00', '2024-06-15T02:00:00+08:00')`,
      [sleep.rows[0]?.id],
    );
    await client.query(
      `INSERT INTO workouts (
         device_id, record_type, started_at, ended_at, sport_type, title,
         duration_sec, distance_m, active_kcal, avg_hr_bpm, max_hr_bpm
       ) VALUES (
         $1::uuid, 'workout', '2024-06-15T07:15:00+08:00', '2024-06-15T07:47:00+08:00',
         'outdoor_running', '户外跑步', 1920, 5100, 250, 140, 168
       )`,
      [deviceId],
    );

    const response = await fetch(`http://127.0.0.1:${port}/v1/read/today?day=2024-06-15&device_id=${deviceId}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      source: string;
      day: string;
      steps: number;
      resting_hr_bpm: number;
      sleep_score: number;
      active_kcal: number;
      exercise_minutes: number;
      stand_hours: number;
      rings: {
        move: { active_kcal: number };
        exercise: { exercise_minutes: number };
        stand: { stand_hours: number };
      };
      hr_zone_minutes: { warm_up: number };
      heart_rate: Array<{ bpm: number; value_num: number; started_at: string }>;
      sleep: {
        score: number | null;
        stages: Array<{ stage: string }>;
        deep_min: number | null;
        rem_min: number | null;
        awake_count: number | null;
        efficiency: number | null;
        avg_hr_bpm: number | null;
        avg_spo2: number | null;
      };
      workouts: Array<{ sport_type: string; title: string; sport_type_label: string; active_kcal: number }>;
    };
    assert.equal(body.source, "db");
    assert.equal(body.day, "2024-06-15");
    assert.equal(body.rings.move.active_kcal, 501);
    assert.equal(body.rings.exercise.exercise_minutes, 44);
    assert.equal(body.rings.stand.stand_hours, 11);
    assert.equal(body.active_kcal, 501);
    assert.equal(body.exercise_minutes, 44);
    assert.equal(body.stand_hours, 11);
    assert.notEqual(body.rings.exercise.exercise_minutes, 32);
    assert.equal(body.steps, 12345);
    assert.equal(body.resting_hr_bpm, 61);
    assert.equal(body.sleep_score, 77);
    assert.equal(body.hr_zone_minutes.warm_up, 9);
    assert.equal(body.heart_rate[0]?.bpm, 88);
    assert.equal(body.heart_rate[0]?.value_num, 88);
    assert.equal(body.heart_rate[0]?.started_at, "2024-06-15T14:22:00+08:00");
    assert.equal(body.sleep.stages[0]?.stage, "deep");
    assert.equal(body.sleep.score, 77);
    assert.equal(body.sleep.deep_min, 90);
    assert.equal(body.sleep.rem_min, 80);
    assert.equal(body.sleep.awake_count, 2);
    assert.equal(body.sleep.efficiency, null);
    assert.equal(body.sleep.avg_hr_bpm, 54);
    assert.equal(body.sleep.avg_spo2, 97);

    const sleepRead = await fetch(`http://127.0.0.1:${port}/v1/read/sleep?day=2024-06-15&device_id=${deviceId}`);
    assert.equal(sleepRead.status, 200);
    const sleepBody = (await sleepRead.json()) as {
      source: string;
      sleep: { score: number | null; deep_min: number | null; avg_spo2: number | null; efficiency: number | null };
    };
    assert.equal(sleepBody.source, "db");
    assert.equal(sleepBody.sleep.score, 77);
    assert.equal(sleepBody.sleep.deep_min, 90);
    assert.equal(sleepBody.sleep.avg_spo2, 97);
    assert.equal(sleepBody.sleep.efficiency, null);
    assert.equal(body.workouts[0]?.sport_type, "outdoor_running");
    assert.equal(body.workouts[0]?.title, "户外跑步");
    assert.equal(body.workouts[0]?.sport_type_label, "户外跑步");
    assert.equal(body.workouts[0]?.active_kcal, 250);
    const encoded = JSON.stringify(body);
    assert.equal(encoded.includes("move_kcal"), false);
    assert.equal(encoded.includes("hr_sample"), false);
    assert.equal(encoded.includes("passToken"), false);

    const direct = await readToday(db, { day: "2024-06-15", deviceId });
    assert.equal(direct.rings.stand.stand_hours, 11);

    const trends = await fetch(
      `http://127.0.0.1:${port}/v1/read/trends?range=week&day=2024-06-15&device_id=${deviceId}`,
    );
    assert.equal(trends.status, 200);
    const trendBody = (await trends.json()) as {
      source: string;
      days: Array<{ day: string; active_kcal: number | null; exercise_minutes: number | null; stand_hours: number | null; sleep_hours: number | null }>;
    };
    assert.equal(trendBody.source, "db");
    const saturday = trendBody.days.find((day) => day.day === "2024-06-15");
    assert.equal(saturday?.active_kcal, 501);
    assert.equal(saturday?.exercise_minutes, 44);
    assert.equal(saturday?.stand_hours, 11);
    assert.ok((saturday?.sleep_hours ?? 0) > 7);

    const heart = await fetch(`http://127.0.0.1:${port}/v1/read/heart-rate?day=2024-06-15&device_id=${deviceId}`);
    const heartBody = (await heart.json()) as { source: string; heart_rate: Array<{ bpm: number }> };
    assert.equal(heartBody.source, "db");
    assert.equal(heartBody.heart_rate[0]?.bpm, 88);
  });

  test("a day with no daily_aggregates row falls back to the ingest fixture", async () => {
    const count = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM daily_aggregates WHERE day_local = '1900-01-01'",
    );
    assert.equal(count.rows[0]?.count, "0");
    const response = await fetch(`http://127.0.0.1:${port}/v1/read/today?day=1900-01-01`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      source: string;
      day: string;
      requested_day: string;
      rings: { move: { active_kcal: number }; exercise: { exercise_minutes: number }; stand: { stand_hours: number } };
      heart_rate: Array<{ bpm: number }>;
      workouts: Array<{ active_kcal: number }>;
    };
    assert.equal(body.source, "fixture");
    assert.equal(body.requested_day, "1900-01-01");
    assert.equal(body.day, "2026-10-27");
    assert.equal(body.rings.move.active_kcal, 312);
    assert.equal(body.rings.exercise.exercise_minutes, 28);
    assert.equal(body.rings.stand.stand_hours, 10);
    assert.equal(body.heart_rate[0]?.bpm, 76);
    assert.equal(body.workouts[0]?.active_kcal, 380);

    const trends = await fetch(`http://127.0.0.1:${port}/v1/read/trends?range=week&day=1900-01-01`);
    const trendBody = (await trends.json()) as { source: string; days: Array<{ active_kcal: number | null }> };
    assert.equal(trendBody.source, "fixture");
    assert.equal(trendBody.days.every((day) => day.active_kcal === null), true);
  });

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
