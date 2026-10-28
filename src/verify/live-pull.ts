import { queryRows, type Queryable } from "../query.js";
import { isCalendarDay, shanghaiDayStart, shiftShanghaiDay } from "../time.js";

/** Where a read of this day would get its numbers. Matches GET /v1/read/today. */
export type VerifySource = "db" | "fixture";

export type LivePullVerify = {
  day: string;
  aggregates: number;
  samples: number;
  source: VerifySource;
  ok: boolean;
};

const AGGREGATES_SQL = `
  -- verify:aggregates
  SELECT count(*)::int AS count
  FROM daily_aggregates
  WHERE record_type = 'daily_summary'
    AND day_local = $1::date`;

const SAMPLES_SQL = `
  -- verify:samples
  SELECT count(*)::int AS count
  FROM samples
  WHERE started_at >= $1::timestamptz
    AND started_at < $2::timestamptz`;

/**
 * Judge one Asia/Shanghai day.
 * source is db when daily_aggregates has a daily_summary row, which is the
 * read API rule. Zero rows means a read would answer source fixture.
 */
export function judgeLivePullVerify(day: string, aggregates: number, samples: number): LivePullVerify {
  if (!isCalendarDay(day)) throw new Error("verify day must be YYYY-MM-DD");
  const aggregateCount = asCount(aggregates);
  const sampleCount = asCount(samples);
  const source: VerifySource = aggregateCount > 0 ? "db" : "fixture";
  return {
    day,
    aggregates: aggregateCount,
    samples: sampleCount,
    source,
    ok: source === "db",
  };
}

/** Job-summary line. Counts and the day only. */
export function formatLivePullVerify(result: LivePullVerify): string {
  const judged = judgeLivePullVerify(result.day, result.aggregates, result.samples);
  const status = judged.ok ? "verify ok" : "verify failed";
  return `${status}: day=${judged.day} aggregates=${judged.aggregates} samples=${judged.samples} source=${judged.source}`;
}

/** Count daily_aggregates and samples for one Shanghai day. Parameters stay out of the SQL text. */
export async function queryLivePullVerify(db: Queryable, day: string): Promise<LivePullVerify> {
  if (!isCalendarDay(day)) throw new Error("verify day must be YYYY-MM-DD");
  const from = shanghaiDayStart(day);
  const to = shanghaiDayStart(shiftShanghaiDay(day, 1));
  const aggregates = await readCount(db, AGGREGATES_SQL, [day]);
  const samples = await readCount(db, SAMPLES_SQL, [from, to]);
  return judgeLivePullVerify(day, aggregates, samples);
}

async function readCount(db: Queryable, sql: string, values: unknown[]): Promise<number> {
  const rows = await queryRows<{ count: unknown }>(db, sql, values);
  const row = rows[0];
  if (!row || !("count" in row)) throw new Error("verify query returned no count");
  return asCount(row.count);
}

function asCount(value: unknown): number {
  let parsed = Number.NaN;
  if (typeof value === "bigint") parsed = Number(value);
  else if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && value.trim() !== "") parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("verify count was not a non-negative integer");
  }
  return parsed;
}
