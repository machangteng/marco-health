import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import type { Pool, Client } from "pg";
import { createApp } from "./app.js";
import { connectWithRetry, createPool } from "./db.js";
import { migrateToHead } from "./migrate.js";
import { accountExternalId, runLiveProbe, type ProbeRequest } from "./pull/live-probe.js";
import { persistLiveProbe } from "./pull/persist.js";
import { STACK_FIXTURE_PASS, STACK_FIXTURE_SERVICE, scriptedStackTransport, stackPage } from "./pull/scripted-stack.js";
import { asQueryable, type Queryable } from "./query.js";

process.env.DATABASE_URL ??= "postgres://marco:marco@localhost:5432/marco_health";

const STACK_HOSTS = new Set(["account.xiaomi.com", "sts-hlth.io.mi.com", "hlth.io.mi.com"]);

type TodayBody = {
  source: string;
  timezone: string;
  day: string;
  requested_day: string;
  steps: number | null;
  active_kcal: number | null;
  exercise_minutes: number | null;
  stand_hours: number | null;
  rings: {
    move: { active_kcal: number | null };
    exercise: { exercise_minutes: number | null };
    stand: { stand_hours: number | null };
  };
};

describe("live pull ingest against postgres", { concurrency: 1 }, () => {
  let client: Client;
  let db: Queryable;
  let pool: Pool;
  let server: Server;
  let port = 0;

  before(async () => {
    client = await connectWithRetry();
    db = asQueryable(client);
    await migrateToHead(client);
    pool = createPool();
    server = createApp(pool);
    port = await listen(server);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await client.end();
  });

  test("mock stack X today lands in GET /v1/read/today as source db", async () => {
    const day = "2026-03-17";
    const userId = "90009017";
    const vendor = accountExternalId(userId);
    try {
      const result = await pullShanghaiDay(db, {
        day,
        userId,
        now: new Date(`${day}T08:15:00+08:00`),
        activeKcal: 418,
        exerciseMinutes: 36,
        standHours: 9,
        steps: 12001,
      });
      assert.equal(result.skipped, false);
      if (result.skipped) return;
      assert.equal(result.status, "ok");
      assert.equal(result.window.to, day);
      const daily = result.records.find((record) => record.type === "daily_summary" && record.day === day);
      assert.ok(daily && daily.type === "daily_summary");
      assert.equal(daily.active_kcal, 418);
      assert.notEqual(daily.active_kcal, 999);

      const deviceId = await deviceIdFor(vendor);
      const body = await readToday(day, deviceId);
      assert.equal(body.source, "db");
      assert.equal(body.day, day);
      assert.equal(body.requested_day, day);
      assert.equal(body.timezone, "Asia/Shanghai");
      assert.deepEqual(body.rings, {
        move: { active_kcal: 418 },
        exercise: { exercise_minutes: 36 },
        stand: { stand_hours: 9 },
      });
      assert.equal(body.active_kcal, 418);
      assert.equal(body.exercise_minutes, 36);
      assert.equal(body.stand_hours, 9);
      assert.equal(body.steps, 12001);
      assert.equal(JSON.stringify(body).includes(STACK_FIXTURE_PASS), false);
      assert.equal(JSON.stringify(body).includes(STACK_FIXTURE_SERVICE), false);
    } finally {
      await deleteDevice(vendor);
    }
  });

  test("auth_expired does not replace daily_aggregates with fixture rows", async () => {
    const day = "2026-03-18";
    const userId = "90009018";
    const vendor = accountExternalId(userId);
    try {
      const seeded = await pullShanghaiDay(db, {
        day,
        userId,
        now: new Date(`${day}T08:00:00+08:00`),
        activeKcal: 418,
        exerciseMinutes: 36,
        standHours: 9,
        steps: 12001,
      });
      assert.equal(seeded.skipped, false);
      if (seeded.skipped) return;

      const hosts: string[] = [];
      let logins = 0;
      const failed = await runLiveProbe({
        env: { XIAOMI_USER_ID: userId, XIAOMI_PASS_TOKEN: STACK_FIXTURE_PASS },
        transport: async (request) => {
          const host = new URL(request.url).host;
          hosts.push(host);
          if (host === "account.xiaomi.com") logins += 1;
          return scriptedStackTransport({
            onHealth: () => ({ status: 401, headers: {}, body: "" }),
          })(request);
        },
        sleep: async () => undefined,
        now: () => new Date(`${day}T18:00:00+08:00`),
        random: () => 0,
        dailyKeys: ["steps"],
        includeHeartSamples: false,
        includeSleep: false,
        includeSport: false,
      });
      assert.equal(failed.skipped, false);
      if (failed.skipped) return;
      assert.equal(failed.error_code, "auth_expired");
      assert.equal(failed.records.length, 0);
      assert.ok(hosts.every((host) => STACK_HOSTS.has(host)));
      await persistLiveProbe(db, failed);

      const deviceId = await deviceIdFor(vendor);
      const body = await readToday(day, deviceId);
      assert.equal(body.source, "db");
      assert.deepEqual(body.rings, {
        move: { active_kcal: 418 },
        exercise: { exercise_minutes: 36 },
        stand: { stand_hours: 9 },
      });
      const rows = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM daily_aggregates
         WHERE device_id = $1::uuid AND day_local = $2::date`,
        [deviceId, day],
      );
      assert.equal(rows.rows[0]?.count, "1");
      const fixtureDay = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM daily_aggregates
         WHERE device_id = $1::uuid AND day_local = '2026-10-27'`,
        [deviceId],
      );
      assert.equal(fixtureDay.rows[0]?.count, "0");
      const run = await client.query<{ status: string; error_code: string; rows_upserted: number }>(
        `SELECT status, error_code, rows_upserted
         FROM sync_runs
         WHERE id = $1::uuid`,
        [failed.sync_run_id],
      );
      assert.equal(run.rows[0]?.status, "failed");
      assert.equal(run.rows[0]?.error_code, "auth_expired");
      assert.equal(Number(run.rows[0]?.rows_upserted), 0);
      assert.equal(logins, 2);
    } finally {
      await deleteDevice(vendor);
    }
  });

  async function pullShanghaiDay(
    queryable: Queryable,
    input: {
      day: string;
      userId: string;
      now: Date;
      activeKcal: number;
      exerciseMinutes: number;
      standHours: number;
      steps: number;
    },
  ) {
    const dayStart = Math.floor(new Date(`${input.day}T00:00:00+08:00`).getTime() / 1000);
    const hosts: string[] = [];
    const result = await runLiveProbe({
      env: { XIAOMI_USER_ID: input.userId, XIAOMI_PASS_TOKEN: STACK_FIXTURE_PASS },
      transport: async (request: ProbeRequest) => {
        const host = new URL(request.url).host;
        hosts.push(host);
        if (!STACK_HOSTS.has(host)) throw new Error(`blocked host ${host}`);
        return scriptedStackTransport({
          onHealth(_url, params) {
            const row = (key: string, value: unknown) =>
              stackPage([{ key, time: dayStart, value: JSON.stringify(value) }]);
            if (params.key === "steps") {
              return row("steps", { steps: input.steps, distance: 8000, calories: 999 });
            }
            if (params.key === "calories") return row("calories", { calories: input.activeKcal });
            if (params.key === "intensity") return row("intensity", { duration: input.exerciseMinutes });
            if (params.key === "valid_stand") return row("valid_stand", { count: input.standHours });
            return stackPage([]);
          },
        })(request);
      },
      sleep: async () => undefined,
      now: () => input.now,
      random: () => 0,
      dailyKeys: ["steps", "calories", "intensity", "valid_stand"],
      includeHeartSamples: false,
      includeSleep: false,
      includeSport: false,
    });
    assert.ok(hosts.every((host) => STACK_HOSTS.has(host)));
    assert.ok(hosts.includes("hlth.io.mi.com"));
    if (!result.skipped) await persistLiveProbe(queryable, result);
    return result;
  }

  async function deviceIdFor(vendor: string): Promise<string> {
    const found = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM devices WHERE source = 'mi_health' AND external_id = $1",
      [vendor],
    );
    const id = found.rows[0]?.id;
    if (!id) throw new Error("live pull did not create a device");
    return id;
  }

  async function readToday(day: string, deviceId: string): Promise<TodayBody> {
    const response = await fetch(`http://127.0.0.1:${port}/v1/read/today?day=${day}&device_id=${deviceId}`);
    assert.equal(response.status, 200);
    return (await response.json()) as TodayBody;
  }

  async function deleteDevice(vendor: string): Promise<void> {
    await client.query("DELETE FROM devices WHERE source = 'mi_health' AND external_id = $1", [vendor]);
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
