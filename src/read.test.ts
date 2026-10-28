import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import type { Pool, QueryResult } from "pg";
import { createApp } from "./app.js";
import { weekBounds } from "./read/present.js";
import { readToday, readTrends } from "./read/service.js";
import type { Queryable } from "./query.js";
import { resolveWebFile } from "./web-static.js";

const EMPTY: Queryable = {
  query: async () => ({ rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] }) as QueryResult,
};

function scripted(rowsFor: (sql: string) => Array<Record<string, unknown>>): Queryable {
  return {
    query: async (text) => ({ rows: rowsFor(text), command: "SELECT", rowCount: 0, oid: 0, fields: [] }) as QueryResult,
  };
}

test("week containing 2026-10-28 is Monday 26 through Sunday 1", () => {
  assert.deepEqual(weekBounds("2026-10-28"), { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(weekBounds("2024-06-15"), { from: "2024-06-10", to: "2024-06-16" });
});

test("rings use active_kcal, exercise_minutes, and stand_hours from the daily row", async () => {
  const db = scripted((sql) => {
    if (sql.includes("read:today-daily")) {
      return [
        {
          device_id: "11111111-1111-4111-8111-111111111111",
          day: "2024-06-15",
          steps: 12345,
          distance_m: 9000,
          floors: null,
          active_kcal: 501,
          exercise_minutes: 44,
          stand_hours: 11,
          resting_hr_bpm: 61,
          hr_zone_minutes: { warm_up: 9, fat_burning: 8, aerobic: 7, anaerobic: 6, extreme: 1 },
          sleep_score: 77,
          sleep_hours: null,
        },
      ];
    }
    if (sql.includes("read:heart-rate")) {
      return [{ started_at: new Date("2024-06-15T14:22:00+08:00"), value_num: 88 }];
    }
    if (sql.includes("read:sleep-session")) {
      return [
        {
          id: "22222222-2222-4222-8222-222222222222",
          started_at: new Date("2024-06-14T23:10:00+08:00"),
          ended_at: new Date("2024-06-15T06:40:00+08:00"),
          score: 77,
        },
      ];
    }
    if (sql.includes("read:sleep-stages")) {
      return [
        {
          stage: "deep",
          started_at: new Date("2024-06-15T01:00:00+08:00"),
          ended_at: new Date("2024-06-15T02:00:00+08:00"),
        },
      ];
    }
    if (sql.includes("read:workouts")) {
      return [
        {
          started_at: new Date("2024-06-15T07:15:00+08:00"),
          ended_at: new Date("2024-06-15T07:47:00+08:00"),
          sport_type: "outdoor_running",
          title: "户外跑步",
          duration_sec: 1920,
          distance_m: 5100,
          active_kcal: 250,
          avg_hr_bpm: 140,
          max_hr_bpm: 168,
        },
      ];
    }
    return [];
  });

  const body = await readToday(db, { day: "2024-06-15", deviceId: null });
  assert.equal(body.source, "db");
  assert.equal(body.day, "2024-06-15");
  assert.deepEqual(Object.keys(body.rings.move), ["active_kcal"]);
  assert.deepEqual(Object.keys(body.rings.exercise), ["exercise_minutes"]);
  assert.deepEqual(Object.keys(body.rings.stand), ["stand_hours"]);
  assert.equal(body.rings.move.active_kcal, 501);
  assert.equal(body.rings.exercise.exercise_minutes, 44);
  assert.equal(body.rings.stand.stand_hours, 11);
  assert.equal(body.active_kcal, 501);
  assert.equal(body.steps, 12345);
  assert.equal(body.resting_hr_bpm, 61);
  assert.equal(body.heart_rate[0]?.bpm, 88);
  assert.equal(body.heart_rate[0]?.value_num, 88);
  assert.equal(body.heart_rate[0]?.started_at, "2024-06-15T14:22:00+08:00");
  assert.equal(body.sleep?.stages[0]?.stage, "deep");
  assert.equal(body.workouts[0]?.title, "户外跑步");
  assert.equal(body.workouts[0]?.sport_type_label, "户外跑步");
  assert.equal(body.workouts[0]?.active_kcal, 250);
  assert.notEqual(body.rings.exercise.exercise_minutes, 32);
  const encoded = JSON.stringify(body);
  assert.equal(encoded.includes("move_kcal"), false);
  assert.equal(encoded.includes("hr_sample"), false);
  assert.equal(encoded.includes("passToken"), false);
});

test("empty daily_aggregates falls back to the ingest fixture", async () => {
  const today = await readToday(EMPTY, { day: "2026-10-28", deviceId: null });
  assert.equal(today.source, "fixture");
  assert.equal(today.requested_day, "2026-10-28");
  assert.equal(today.day, "2026-10-27");
  assert.equal(today.rings.move.active_kcal, 312);
  assert.equal(today.rings.exercise.exercise_minutes, 28);
  assert.equal(today.rings.stand.stand_hours, 10);
  assert.equal(today.steps, 8432);
  assert.equal(today.distance_m, 5820.5);
  assert.equal(today.floors, null);
  assert.equal(today.resting_hr_bpm, 58);
  assert.equal(today.sleep_score, 82);
  assert.equal(today.hr_zone_minutes?.warm_up, 40);
  assert.equal(today.heart_rate[0]?.bpm, 76);
  assert.equal(today.heart_rate[0]?.value_num, 76);
  assert.equal(today.sleep?.score, 82);
  assert.equal(today.sleep?.stages.length, 5);
  assert.equal(today.workouts[0]?.sport_type, "outdoor_running");
  assert.equal(today.workouts[0]?.sport_type_label, "户外跑步");
  assert.equal(today.workouts[0]?.active_kcal, 380);
  assert.equal(JSON.stringify(today).includes("passToken"), false);

  const trends = await readTrends(EMPTY, { day: "2026-10-28", deviceId: null, range: "week" });
  assert.equal(trends.source, "fixture");
  assert.equal(trends.from, "2026-10-26");
  assert.equal(trends.to, "2026-11-01");
  const tuesday = trends.days.find((day) => day.day === "2026-10-27");
  assert.ok(tuesday);
  assert.equal(tuesday?.label, "二");
  assert.equal(tuesday?.active_kcal, 312);
  assert.equal(tuesday?.exercise_minutes, 28);
  assert.equal(tuesday?.stand_hours, 10);
  assert.equal(tuesday?.steps, 8432);
  assert.equal(tuesday?.resting_hr_bpm, 58);
  assert.ok((tuesday?.sleep_hours ?? 0) > 7);

  const outside = await readTrends(EMPTY, { day: "1900-01-01", deviceId: null, range: "week" });
  assert.equal(outside.source, "fixture");
  assert.equal(outside.days.every((day) => day.active_kcal === null), true);
});

test("web files stay inside web/", () => {
  assert.equal(resolveWebFile("/../package.json"), null);
  assert.equal(resolveWebFile("/..%2Fpackage.json"), null);
  const index = resolveWebFile("/");
  assert.ok(index?.endsWith("/index.html") || index?.endsWith("\\index.html"));
});

test("HTTP serves the UI and fixture read payloads", async () => {
  const queried: string[] = [];
  const pool = {
    query(sql: string) {
      queried.push(sql);
      return Promise.resolve({ rows: [], command: "SELECT", rowCount: 0, oid: 0, fields: [] });
    },
  } as unknown as Pool;
  const server: Server = createApp(pool);
  const port = await listen(server);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /Marco健康管家/);
    assert.match(html, /今日/);
    assert.match(html, /趋势/);
    assert.match(html, /我的/);

    const script = await fetch(`http://127.0.0.1:${port}/app.js`);
    const source = await script.text();
    assert.match(source, /\/v1\/read\/today/);
    assert.equal(source.includes("const MOCK"), false);
    const css = await fetch(`http://127.0.0.1:${port}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /--move:\s*#fa114f/);

    const index = await fetch(`http://127.0.0.1:${port}/v1`);
    const listed = (await index.json()) as { read: { today: string } };
    assert.equal(listed.read.today, "/v1/read/today");

    const badDay = await fetch(`http://127.0.0.1:${port}/v1/read/today?day=2024-13-40`);
    assert.equal(badDay.status, 400);
    const badDevice = await fetch(`http://127.0.0.1:${port}/v1/read/today?device_id=not-a-uuid`);
    assert.equal(badDevice.status, 400);
    const badRange = await fetch(`http://127.0.0.1:${port}/v1/read/trends?range=year`);
    assert.equal(badRange.status, 400);
    assert.equal(queried.length, 0);

    const today = await fetch(`http://127.0.0.1:${port}/v1/read/today?day=1900-01-01`);
    assert.equal(today.status, 200);
    const body = (await today.json()) as {
      source: string;
      rings: { move: { active_kcal: number }; exercise: { exercise_minutes: number }; stand: { stand_hours: number } };
    };
    assert.equal(body.source, "fixture");
    assert.equal(body.rings.move.active_kcal, 312);
    assert.equal(body.rings.exercise.exercise_minutes, 28);
    assert.equal(body.rings.stand.stand_hours, 10);

    const heart = await fetch(`http://127.0.0.1:${port}/v1/read/heart-rate?day=1900-01-01`);
    const heartBody = (await heart.json()) as { source: string; heart_rate: Array<{ bpm: number }> };
    assert.equal(heartBody.source, "fixture");
    assert.equal(heartBody.heart_rate[0]?.bpm, 76);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
