import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { Client, QueryResult } from "pg";
import { connectWithRetry } from "./db.js";
import { migrateToHead } from "./migrate.js";
import { PROBE_WINDOW_DAYS, probeWindow } from "./pull/live-probe.js";
import { asQueryable, type Queryable } from "./query.js";
import { readToday } from "./read/service.js";
import { lastCompleteShanghaiDay, shanghaiDay } from "./time.js";
import { formatLivePullVerify, judgeLivePullVerify, queryLivePullVerify } from "./verify/live-pull.js";

const LINE = /^verify (ok|failed): day=\d{4}-\d{2}-\d{2} aggregates=\d+ samples=\d+ source=(db|fixture)$/;

function queryable(rowsFor: (sql: string, values: unknown[]) => unknown): Queryable {
  return {
    query: async (text, values) =>
      ({
        rows: [{ count: rowsFor(text, values ?? []) }],
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
      }) as QueryResult,
  };
}

test("a day with daily_aggregates is source db", () => {
  const result = judgeLivePullVerify("2026-10-28", 2, 40);
  assert.equal(result.ok, true);
  assert.equal(result.source, "db");
  assert.equal(formatLivePullVerify(result), "verify ok: day=2026-10-28 aggregates=2 samples=40 source=db");
  assert.match(formatLivePullVerify(result), LINE);
});

test("samples alone do not make source db", () => {
  const result = judgeLivePullVerify("2026-10-28", 0, 9);
  assert.equal(result.ok, false);
  assert.equal(result.source, "fixture");
  assert.equal(formatLivePullVerify(result), "verify failed: day=2026-10-28 aggregates=0 samples=9 source=fixture");
});

test("aggregates without samples are still source db", () => {
  const result = judgeLivePullVerify("2026-10-28", 1, 0);
  assert.equal(result.ok, true);
  assert.equal(result.source, "db");
  assert.equal(formatLivePullVerify(result), "verify ok: day=2026-10-28 aggregates=1 samples=0 source=db");
});

test("the summary line keeps only the day and the counts", () => {
  const line = formatLivePullVerify(judgeLivePullVerify("2026-10-28", 3, 8));
  assert.equal(line.includes("postgres"), false);
  assert.equal(line.includes("@"), false);
  assert.equal(line.includes("passToken"), false);
  assert.equal(line.includes("cookie"), false);
});

test("a non-day is rejected without echoing the value", () => {
  const secret = "postgres://user:secret-token@ep.neon.tech/db";
  assert.throws(
    () => judgeLivePullVerify(secret, 1, 1),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("secret-token"), false);
      assert.equal(error.message.includes("postgres"), false);
      assert.match(error.message, /YYYY-MM-DD/);
      return true;
    },
  );
});

test("query counts daily_aggregates and samples for the Shanghai day", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const db = queryable((sql, values) => {
    calls.push({ text: sql, values });
    if (sql.includes("verify:aggregates")) return "2";
    if (sql.includes("verify:samples")) return 15;
    throw new Error("unexpected sql");
  });
  const result = await queryLivePullVerify(db, "2026-10-28");
  assert.deepEqual(result, {
    day: "2026-10-28",
    aggregates: 2,
    samples: 15,
    source: "db",
    ok: true,
  });
  assert.equal(formatLivePullVerify(result), "verify ok: day=2026-10-28 aggregates=2 samples=15 source=db");
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.text ?? "", /daily_aggregates/);
  assert.match(calls[0]?.text ?? "", /record_type = 'daily_summary'/);
  assert.match(calls[0]?.text ?? "", /\$1::date/);
  assert.equal((calls[0]?.text ?? "").includes("2026-10-28"), false);
  assert.deepEqual(calls[0]?.values, ["2026-10-28"]);
  assert.match(calls[1]?.text ?? "", /FROM samples/);
  assert.deepEqual(calls[1]?.values, [
    new Date("2026-10-28T00:00:00+08:00"),
    new Date("2026-10-29T00:00:00+08:00"),
  ]);
});

test("an empty day fails and does not query a fixture file", async () => {
  const calls: string[] = [];
  const db = queryable((sql) => {
    calls.push(sql);
    return sql.includes("verify:aggregates") ? 0 : 4;
  });
  const result = await queryLivePullVerify(db, "2026-10-28");
  assert.equal(result.ok, false);
  assert.equal(result.source, "fixture");
  assert.equal(formatLivePullVerify(result), "verify failed: day=2026-10-28 aggregates=0 samples=4 source=fixture");
  assert.equal(calls.some((sql) => sql.includes("fixtures")), false);
});

test("a bad count fails closed", async () => {
  const db = queryable(() => null);
  await assert.rejects(() => queryLivePullVerify(db, "2026-10-28"), /non-negative integer/);
});

test("verified day is yesterday inside the pull window in Asia/Shanghai", () => {
  const now = new Date("2026-10-28T22:30:00.000Z");
  assert.equal(shanghaiDay(now), "2026-10-29");
  const window = probeWindow(now);
  assert.equal(PROBE_WINDOW_DAYS, 7);
  assert.equal(window.from, "2026-10-23");
  assert.equal(window.to, "2026-10-29");
  assert.equal(lastCompleteShanghaiDay(now), "2026-10-28");
});

test("daily workflow verifies after pull:live and documents the summary line", () => {
  const workflow = readFileSync(new URL("../.github/workflows/daily-live-pull.yml", import.meta.url), "utf8");
  const cli = readFileSync(new URL("./cli/verify-live-pull.ts", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(workflow, /npm run migrate[\s\S]*npm run pull:live[\s\S]*npm run verify:live/);
  assert.equal(workflow.includes("pull:mock"), false);
  assert.equal(workflow.includes("fixtures/"), false);
  assert.equal(workflow.includes("postgres://"), false);
  const afterPull = workflow.slice(workflow.indexOf("npm run pull:live") + "npm run pull:live".length);
  assert.match(afterPull, /npm run verify:live/);
  assert.match(afterPull, /secrets\.DATABASE_URL/);
  assert.equal(afterPull.includes("XIAOMI_"), false);
  assert.equal(afterPull.includes("echo"), false);
  assert.match(cli, /lastCompleteShanghaiDay\(new Date\(\)\)/);
  assert.match(cli, /GITHUB_STEP_SUMMARY/);
  assert.match(cli, /maskSecrets/);
  assert.equal(cli.includes("pull:mock"), false);
  assert.equal(cli.includes("fixtures/"), false);
  assert.equal(cli.includes("console.log(process.env.DATABASE_URL)"), false);
  assert.match(readme, /verify ok: day=YYYY-MM-DD aggregates=N samples=M source=db/);
  assert.match(readme, /verify failed: day=YYYY-MM-DD aggregates=0 samples=M source=fixture/);
});

const SEEDED_DAY = "2099-03-17";
const EMPTY_DAY = "1800-06-01";

describe("verify live pull against postgres", { concurrency: 1 }, () => {
  let client: Client | undefined;
  let db: Queryable;
  let deviceId = "";

  before(async () => {
    process.env.DATABASE_URL ??= "postgres://marco:marco@localhost:5432/marco_health";
    client = await connectWithRetry();
    const connected = client;
    db = asQueryable(connected);
    await migrateToHead(connected);
    await connected.query(
      `DELETE FROM devices WHERE id IN (
         SELECT device_id FROM daily_aggregates WHERE day_local = ANY($1::date[])
         UNION
         SELECT device_id FROM samples
          WHERE (started_at >= '2099-03-17T00:00:00+08:00' AND started_at < '2099-03-18T00:00:00+08:00')
             OR (started_at >= '1800-06-01T00:00:00+08:00' AND started_at < '1800-06-02T00:00:00+08:00')
       )`,
      [[SEEDED_DAY, EMPTY_DAY]],
    );
  });

  after(async () => {
    if (!client) return;
    if (deviceId !== "") {
      await client.query("DELETE FROM devices WHERE id = $1::uuid", [deviceId]);
    }
    await client.end();
  });

  test("a seeded day is source db and an empty day matches the read API", async () => {
    assert.ok(client);
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO devices (source, external_id, timezone) VALUES ('mi_health', $1, 'Asia/Shanghai') RETURNING id::text AS id",
      [`verify-live-${randomUUID()}`],
    );
    deviceId = inserted.rows[0]?.id ?? "";
    assert.notEqual(deviceId, "");
    await client.query(
      `INSERT INTO daily_aggregates (
         device_id, record_type, started_at, day_local, steps, active_kcal
       ) VALUES ($1::uuid, 'daily_summary', '2099-03-17T00:00:00+08:00', '2099-03-17', 100, 12)`,
      [deviceId],
    );
    await client.query(
      `INSERT INTO samples (device_id, record_type, started_at, value_num, unit)
       VALUES ($1::uuid, 'heart_rate', '2099-03-17T08:15:00+08:00', 70, 'bpm')`,
      [deviceId],
    );

    const seeded = await queryLivePullVerify(db, SEEDED_DAY);
    assert.equal(seeded.aggregates, 1);
    assert.equal(seeded.samples, 1);
    assert.equal(seeded.ok, true);
    assert.equal(formatLivePullVerify(seeded), "verify ok: day=2099-03-17 aggregates=1 samples=1 source=db");
    const seededRead = await readToday(db, { day: SEEDED_DAY, deviceId: null });
    assert.equal(seededRead.source, seeded.source);

    const empty = await queryLivePullVerify(db, EMPTY_DAY);
    assert.equal(empty.aggregates, 0);
    assert.equal(empty.samples, 0);
    assert.equal(empty.ok, false);
    assert.equal(formatLivePullVerify(empty), "verify failed: day=1800-06-01 aggregates=0 samples=0 source=fixture");
    const emptyRead = await readToday(db, { day: EMPTY_DAY, deviceId: null });
    assert.equal(emptyRead.source, "fixture");
    assert.equal(JSON.stringify(emptyRead).includes("passToken"), false);
  });
});
