import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { QueryResult } from "pg";
import { readParams } from "./app.js";
import { probeWindow } from "./pull/live-probe.js";
import { readToday } from "./read/service.js";
import type { Queryable } from "./query.js";
import { lastCompleteShanghaiDay, shanghaiDay, shanghaiDayStart } from "./time.js";

const NOW = new Date("2026-10-29T22:30:00Z");

test("Shanghai midnight and scheduled morning use Shanghai calendar days", () => {
  assert.equal(shanghaiDay(NOW), "2026-10-30");
  assert.equal(lastCompleteShanghaiDay(NOW), "2026-10-29");
  assert.equal(shanghaiDay(new Date("2026-10-29T15:59:59Z")), "2026-10-29");
  assert.equal(shanghaiDay(new Date("2026-10-29T16:00:00Z")), "2026-10-30");
});

test("seven-day morning pull contains yesterday from Shanghai midnight through the next midnight", () => {
  const window = probeWindow(NOW);
  assert.equal(window.from, "2026-10-24");
  assert.equal(window.to, "2026-10-30");
  assert.equal(window.startSec, shanghaiDayStart("2026-10-24").getTime() / 1000);
  assert.equal(window.endSec, NOW.getTime() / 1000);
  assert.ok(window.startSec <= shanghaiDayStart("2026-10-29").getTime() / 1000);
  assert.ok(window.endSec >= shanghaiDayStart("2026-10-30").getTime() / 1000);
});

test("default read uses yesterday, explicit day keeps its sleep day, trends keep today", () => {
  const url = new URL("http://localhost/v1/read/today");
  assert.deepEqual(readParams(url, NOW), { day: "2026-10-29", sleepDay: "2026-10-30", deviceId: null });
  url.searchParams.set("day", "2026-10-28");
  assert.deepEqual(readParams(url, NOW), { day: "2026-10-28", sleepDay: "2026-10-28", deviceId: null });
  url.searchParams.delete("day");
  assert.deepEqual(readParams(url, NOW, true), { day: "2026-10-30", sleepDay: "2026-10-30", deviceId: null });
});

test("default overview queries yesterday but sleep still wakes today, without stale score fallback", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db: Queryable = {
    query: async (sql, values) => {
      calls.push({ sql, values: values ?? [] });
      const rows = sql.includes("read:today-daily")
        ? [{ device_id: "11111111-1111-4111-8111-111111111111", day: "2026-10-29", steps: 12000, sleep_score: 88 }]
        : sql.includes("read:sleep-session")
          ? [{ started_at: "2026-10-29T23:00:00+08:00", ended_at: "2026-10-30T06:00:00+08:00" }]
          : [];
      return { rows, command: "SELECT", rowCount: rows.length, oid: 0, fields: [] } as QueryResult;
    },
  };
  const params = readParams(new URL("http://localhost/v1/read/today"), NOW);
  assert.ok(!("error" in params));
  const body = await readToday(db, params);
  assert.equal(body.day, "2026-10-29");
  assert.equal(body.is_complete_day, true);
  assert.equal(body.sleep?.ended_at, "2026-10-30T06:00:00+08:00");
  assert.equal(body.sleep?.score, null);
  assert.equal(body.sleep_score, null);
  assert.deepEqual(calls.find((call) => call.sql.includes("read:today-daily"))?.values, ["2026-10-29", null]);
  assert.deepEqual(calls.find((call) => call.sql.includes("read:sleep-session"))?.values.slice(1), [
    shanghaiDayStart("2026-10-30"), shanghaiDayStart("2026-10-31"),
  ]);
});


test("all overview slices share yesterday by default and preserve explicit today", () => {
  for (const path of ["today", "heart-rate", "sleep", "workouts"]) {
    const url = new URL(`http://localhost/v1/read/${path}`);
    assert.deepEqual(readParams(url, NOW), { day: "2026-10-29", sleepDay: "2026-10-30", deviceId: null });
    url.searchParams.set("day", "2026-10-30");
    assert.deepEqual(readParams(url, NOW), { day: "2026-10-30", sleepDay: "2026-10-30", deviceId: null });
  }
});

test("overview labels use Shanghai dates regardless of browser timezone", () => {
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("  function shanghaiDay("), source.indexOf("  function formatDayLabel("));
  const label = runInNewContext(`${helpers}; overviewLabel`) as (day: string, now: Date) => string;
  assert.equal(label("2026-10-29", NOW), "昨天 10/29");
  assert.equal(label("2026-10-30", NOW), "今天 10/30");
  assert.equal(label("2026-10-28", NOW), "10/28");
  assert.equal(label("2026-10-29", new Date("2026-10-29T15:59:59Z")), "今天 10/29");
  assert.equal(label("2026-10-29", new Date("2026-10-29T16:00:00Z")), "昨天 10/29");
});
