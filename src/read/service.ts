import { queryRows, type Queryable } from "../query.js";
import { shanghaiDayStart, shiftShanghaiDay } from "../time.js";
import {
  buildToday,
  buildTrends,
  fixtureToday,
  fixtureTrends,
  heartPoint,
  hoursBetween,
  metricsFromDaily,
  monthBounds,
  sleepView,
  stamp,
  weekBounds,
  workoutView,
  type DayMetric,
  type ReadSource,
  type TodayResponse,
  type TrendsResponse,
} from "./present.js";

export type ReadQuery = {
  day: string;
  deviceId: string | null;
};

const TODAY_DAILY = `
  -- read:today-daily
  SELECT device_id::text AS device_id,
         day_local::text AS day,
         steps, distance_m, floors, active_kcal, exercise_minutes, stand_hours,
         resting_hr_bpm, hr_zone_minutes, sleep_score, sleep_hours
  FROM daily_aggregates
  WHERE record_type = 'daily_summary'
    AND day_local = $1::date
    AND ($2::uuid IS NULL OR device_id = $2::uuid)
  ORDER BY ingested_at DESC
  LIMIT 1`;

const HEART_SQL = `
  -- read:heart-rate
  SELECT started_at, value_num
  FROM samples
  WHERE device_id = $1::uuid
    AND record_type = 'heart_rate'
    AND started_at >= $2::timestamptz
    AND started_at < $3::timestamptz
  ORDER BY started_at ASC`;

const STEPS_SQL = `
  -- read:steps-minute
  SELECT started_at, value_num
  FROM samples
  WHERE device_id = $1::uuid
    AND record_type = 'steps_minute'
    AND started_at >= $2::timestamptz
    AND started_at < $3::timestamptz
  ORDER BY started_at ASC`;

const SLEEP_SQL = `
  -- read:sleep-session
  SELECT id::text AS id, started_at, ended_at, score
  FROM sleep_sessions
  WHERE device_id = $1::uuid
    AND record_type = 'sleep_session'
    AND ended_at >= $2::timestamptz
    AND ended_at < $3::timestamptz
  ORDER BY ended_at DESC
  LIMIT 1`;

const STAGES_SQL = `
  -- read:sleep-stages
  SELECT stage, started_at, ended_at
  FROM sleep_stages
  WHERE session_id = $1::uuid
  ORDER BY started_at ASC`;

const WORKOUTS_SQL = `
  -- read:workouts
  SELECT started_at, ended_at, sport_type, title, duration_sec, distance_m,
         active_kcal, avg_hr_bpm, max_hr_bpm
  FROM workouts
  WHERE device_id = $1::uuid
    AND record_type = 'workout'
    AND started_at < $2::timestamptz
  ORDER BY started_at DESC
  LIMIT 8`;

const TREND_DEVICE = `
  -- read:trend-device
  SELECT device_id::text AS device_id
  FROM daily_aggregates
  WHERE record_type = 'daily_summary'
    AND day_local BETWEEN $1::date AND $2::date
    AND ($3::uuid IS NULL OR device_id = $3::uuid)
  ORDER BY day_local DESC, ingested_at DESC
  LIMIT 1`;

const TREND_DAYS = `
  -- read:trend-days
  SELECT day_local::text AS day,
         steps, active_kcal, exercise_minutes, stand_hours,
         resting_hr_bpm, sleep_score, sleep_hours
  FROM daily_aggregates
  WHERE record_type = 'daily_summary'
    AND device_id = $1::uuid
    AND day_local BETWEEN $2::date AND $3::date
  ORDER BY day_local ASC`;

const TREND_SLEEP = `
  -- read:trend-sleep
  SELECT started_at, ended_at
  FROM sleep_sessions
  WHERE device_id = $1::uuid
    AND record_type = 'sleep_session'
    AND ended_at >= $2::timestamptz
    AND ended_at < $3::timestamptz
  ORDER BY ended_at ASC`;

/**
 * Today summary. If no daily_aggregates row covers the day, the body is derived
 * from fixtures/mi_health/ingest-batch-0.2.json and source is "fixture".
 */
export async function readToday(db: Queryable, query: ReadQuery): Promise<TodayResponse> {
  const rows = await queryRows<Record<string, unknown>>(db, TODAY_DAILY, [query.day, query.deviceId]);
  const row = rows[0];
  if (!row || typeof row.device_id !== "string") return fixtureToday(query.day);
  const from = shanghaiDayStart(query.day);
  const to = shanghaiDayStart(shiftShanghaiDay(query.day, 1));
  const hearts = await queryRows<Record<string, unknown>>(db, HEART_SQL, [row.device_id, from, to]);
  const steps = await queryRows<Record<string, unknown>>(db, STEPS_SQL, [row.device_id, from, to]);
  const sleeps = await queryRows<Record<string, unknown>>(db, SLEEP_SQL, [row.device_id, from, to]);
  const workouts = await queryRows<Record<string, unknown>>(db, WORKOUTS_SQL, [row.device_id, to]);
  const session = sleeps[0];
  const stages =
    session && typeof session.id === "string"
      ? await queryRows<Record<string, unknown>>(db, STAGES_SQL, [session.id])
      : [];
  const metrics = metricsFromDaily(row);
  const sleep = session
    ? sleepView({
        startedAt: session.started_at,
        endedAt: session.ended_at,
        score: session.score,
        stages: stages.map((stage) => ({
          stage: stage.stage,
          startedAt: stage.started_at,
          endedAt: stage.ended_at,
        })),
      })
    : null;
  if (sleep && metrics.sleep_hours === null) metrics.sleep_hours = hoursBetween(sleep.started_at, sleep.ended_at);
  return buildToday({
    source: "db",
    requestedDay: query.day,
    day: typeof row.day === "string" ? row.day : query.day,
    metrics,
    heartRate: hearts.flatMap((point) => {
      const mapped = heartPoint(point.started_at, point.value_num);
      return mapped ? [mapped] : [];
    }),
    stepsMinute: steps.flatMap((point) => {
      const mapped = heartPoint(point.started_at, point.value_num);
      return mapped ? [{ started_at: mapped.started_at, value_num: mapped.value_num }] : [];
    }),
    sleep,
    workouts: workouts.flatMap((item) => {
      const mapped = workoutView({
        startedAt: item.started_at,
        endedAt: item.ended_at,
        sportType: item.sport_type,
        title: item.title,
        durationSec: item.duration_sec,
        distanceM: item.distance_m,
        activeKcal: item.active_kcal,
        avgHr: item.avg_hr_bpm,
        maxHr: item.max_hr_bpm,
      });
      return mapped ? [mapped] : [];
    }),
  });
}

/** Week is Mon–Sun. Month is week buckets inside the calendar month. Empty window → fixture. */
export async function readTrends(
  db: Queryable,
  query: ReadQuery & { range: "week" | "month" },
): Promise<TrendsResponse> {
  const bounds = query.range === "month" ? monthBounds(query.day) : weekBounds(query.day);
  const probe = await queryRows<{ device_id: string }>(db, TREND_DEVICE, [bounds.from, bounds.to, query.deviceId]);
  const deviceId = probe[0]?.device_id;
  if (!deviceId) return fixtureTrends(query.range, query.day);
  const from = shanghaiDayStart(bounds.from);
  const to = shanghaiDayStart(shiftShanghaiDay(bounds.to, 1));
  const days = await queryRows<Record<string, unknown>>(db, TREND_DAYS, [deviceId, bounds.from, bounds.to]);
  const sleeps = await queryRows<Record<string, unknown>>(db, TREND_SLEEP, [deviceId, from, to]);
  if (days.length === 0) return fixtureTrends(query.range, query.day);
  return buildTrends({
    source: "db" satisfies ReadSource,
    range: query.range,
    day: query.day,
    byDay: metricsByDay(days, sleeps),
  });
}

function metricsByDay(days: Array<Record<string, unknown>>, sleeps: Array<Record<string, unknown>>): Map<string, DayMetric> {
  const byDay = new Map<string, DayMetric>();
  for (const row of days) {
    if (typeof row.day !== "string") continue;
    byDay.set(row.day, metricsFromDaily(row));
  }
  for (const session of sleeps) {
    const startedStamp = stamp(session.started_at);
    const endedStamp = stamp(session.ended_at);
    if (!startedStamp || !endedStamp) continue;
    const current = byDay.get(endedStamp.slice(0, 10));
    if (!current) continue;
    const hours = hoursBetween(startedStamp, endedStamp);
    if (hours !== null) current.sleep_hours = hours;
  }
  return byDay;
}
