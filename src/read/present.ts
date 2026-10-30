import { readFileSync } from "node:fs";
import { formatInShanghai, isCalendarDay, parseOffsetDateTime, shanghaiDay, shiftShanghaiDay } from "../time.js";

/** Read payloads say where the numbers came from. */
export type ReadSource = "db" | "fixture";

export type HeartRatePoint = {
  started_at: string;
  /** Wire field. Stored on samples.value_num where record_type = heart_rate. */
  bpm: number;
  value_num: number;
};

export type SleepStageView = {
  stage: "deep" | "light" | "rem" | "awake";
  started_at: string;
  ended_at: string;
};

export type SleepView = {
  started_at: string;
  ended_at: string;
  score: number | null;
  stages: SleepStageView[];
  /** Minutes. Null when Xiaomi omitted that stage total and no timeline could derive it. */
  deep_min: number | null;
  light_min: number | null;
  rem_min: number | null;
  awake_min: number | null;
  awake_count: number | null;
  /** Null when the payload had no sleep_efficiency. */
  efficiency: number | null;
  avg_hr_bpm: number | null;
  min_hr_bpm: number | null;
  max_hr_bpm: number | null;
  avg_spo2: number | null;
};

export type WorkoutView = {
  started_at: string;
  ended_at: string | null;
  sport_type: string | null;
  /** Ingest wire name. Same string as the workouts.title column. */
  sport_type_label: string | null;
  title: string | null;
  duration_sec: number | null;
  distance_m: number | null;
  active_kcal: number | null;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
};

export type StepsMinutePoint = {
  started_at: string;
  value_num: number;
};

/**
 * Today card. Ring metrics keep the daily_aggregates column names:
 * move ← active_kcal, exercise ← exercise_minutes, stand ← stand_hours.
 */
export type TodayResponse = {
  source: ReadSource;
  timezone: "Asia/Shanghai";
  /** Day the numbers belong to. Fixture fallback uses the fixture daily_summary day. */
  day: string;
  /** Day the client asked for. Defaults to yesterday in Asia/Shanghai. */
  requested_day: string;
  /** Calendar day has ended; does not guarantee upstream data completeness. */
  is_complete_day: boolean;
  rings: {
    move: { active_kcal: number | null };
    exercise: { exercise_minutes: number | null };
    stand: { stand_hours: number | null };
  };
  steps: number | null;
  distance_m: number | null;
  floors: number | null;
  active_kcal: number | null;
  exercise_minutes: number | null;
  stand_hours: number | null;
  resting_hr_bpm: number | null;
  sleep_score: number | null;
  hr_zone_minutes: Record<string, number> | null;
  heart_rate: HeartRatePoint[];
  steps_minute: StepsMinutePoint[];
  sleep: SleepView | null;
  workouts: WorkoutView[];
};

export type TrendPoint = {
  day: string;
  label: string;
  from: string;
  to: string;
  steps: number | null;
  active_kcal: number | null;
  exercise_minutes: number | null;
  stand_hours: number | null;
  resting_hr_bpm: number | null;
  sleep_hours: number | null;
  sleep_score: number | null;
};

export type TrendsResponse = {
  source: ReadSource;
  timezone: "Asia/Shanghai";
  range: "week" | "month";
  day: string;
  from: string;
  to: string;
  days: TrendPoint[];
};

export type DayMetric = {
  steps: number | null;
  distance_m: number | null;
  floors: number | null;
  active_kcal: number | null;
  exercise_minutes: number | null;
  stand_hours: number | null;
  resting_hr_bpm: number | null;
  sleep_score: number | null;
  sleep_hours: number | null;
  hr_zone_minutes: Record<string, number> | null;
};

const STAGES = new Set<SleepStageView["stage"]>(["deep", "light", "rem", "awake"]);
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

export function weekBounds(day: string): { from: string; to: string } {
  const weekday = utcWeekday(day);
  const deltaToMonday = weekday === 0 ? -6 : 1 - weekday;
  const from = shiftShanghaiDay(day, deltaToMonday);
  return { from, to: shiftShanghaiDay(from, 6) };
}

export function monthBounds(day: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error("expected YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${match[1]}-${match[2]}-01`,
    to: `${match[1]}-${match[2]}-${String(last).padStart(2, "0")}`,
  };
}

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    days.push(cursor);
    cursor = shiftShanghaiDay(cursor, 1);
    if (days.length > 400) break;
  }
  return days;
}

export function monthBuckets(anchorDay: string): Array<{ label: string; from: string; to: string; days: string[] }> {
  const { from, to } = monthBounds(anchorDay);
  const buckets: Array<{ label: string; from: string; to: string; days: string[] }> = [];
  let cursor = from;
  while (cursor <= to && buckets.length < 6) {
    const week = weekBounds(cursor);
    const days: string[] = [];
    let day = cursor;
    while (day <= to && day <= week.to) {
      days.push(day);
      day = shiftShanghaiDay(day, 1);
    }
    const first = days[0] ?? cursor;
    const last = days[days.length - 1] ?? cursor;
    buckets.push({ label: `W${buckets.length + 1}`, from: first, to: last, days });
    cursor = shiftShanghaiDay(week.to, 1);
  }
  return buckets;
}

export function weekdayChar(day: string): string {
  return WEEKDAY[utcWeekday(day)] ?? "";
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asZones(value: unknown): Record<string, number> | null {
  if (value === null || value === undefined) return null;
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
  const zones: Record<string, number> = {};
  for (const [key, inner] of Object.entries(source)) {
    const parsed = asNumber(inner);
    if (parsed === null) continue;
    zones[key] = parsed;
  }
  return zones;
}

export function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = parseOffsetDateTime(value) ?? new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

export function stamp(value: unknown): string | null {
  const instant = asDate(value);
  if (!instant) return null;
  return formatInShanghai(instant);
}

export function buildToday(input: {
  source: ReadSource;
  requestedDay: string;
  day: string;
  metrics: DayMetric;
  heartRate: HeartRatePoint[];
  stepsMinute: StepsMinutePoint[];
  sleep: SleepView | null;
  workouts: WorkoutView[];
}): TodayResponse {
  const metrics = input.metrics;
  return {
    source: input.source,
    timezone: "Asia/Shanghai",
    day: input.day,
    requested_day: input.requestedDay,
    is_complete_day: input.day < shanghaiDay(new Date()),
    rings: {
      move: { active_kcal: metrics.active_kcal },
      exercise: { exercise_minutes: metrics.exercise_minutes },
      stand: { stand_hours: metrics.stand_hours },
    },
    steps: metrics.steps,
    distance_m: metrics.distance_m,
    floors: metrics.floors,
    active_kcal: metrics.active_kcal,
    exercise_minutes: metrics.exercise_minutes,
    stand_hours: metrics.stand_hours,
    resting_hr_bpm: metrics.resting_hr_bpm,
    sleep_score: metrics.sleep_score,
    hr_zone_minutes: metrics.hr_zone_minutes,
    heart_rate: input.heartRate,
    steps_minute: input.stepsMinute,
    sleep: input.sleep,
    workouts: input.workouts,
  };
}

export function buildTrends(input: {
  source: ReadSource;
  range: "week" | "month";
  day: string;
  byDay: Map<string, DayMetric>;
}): TrendsResponse {
  const bounds = input.range === "month" ? monthBounds(input.day) : weekBounds(input.day);
  const days =
    input.range === "month"
      ? monthBuckets(input.day).map((bucket) => pointFromDays(bucket.label, bucket.from, bucket.to, bucket.days, input.byDay))
      : eachDay(bounds.from, bounds.to).map((day) => pointFromDays(weekdayChar(day), day, day, [day], input.byDay));
  return {
    source: input.source,
    timezone: "Asia/Shanghai",
    range: input.range,
    day: input.day,
    from: bounds.from,
    to: bounds.to,
    days,
  };
}

type FixtureBundle = {
  day: string;
  metrics: DayMetric;
  heartRate: HeartRatePoint[];
  sleep: SleepView | null;
  workouts: WorkoutView[];
};

export function loadFixtureBundle(): FixtureBundle {
  const file = readFileSync(new URL("../../fixtures/mi_health/ingest-batch-0.2.json", import.meta.url), "utf8");
  const parsed = JSON.parse(file) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("records" in parsed) || !Array.isArray(parsed.records)) {
    throw new Error("ingest fixture is missing records");
  }
  let daily: Record<string, unknown> | null = null;
  const hearts: HeartRatePoint[] = [];
  const sleeps: Array<{ record: Record<string, unknown>; view: SleepView }> = [];
  const workouts: WorkoutView[] = [];
  for (const record of parsed.records) {
    if (typeof record !== "object" || record === null) continue;
    const row = record as Record<string, unknown>;
    if (row.type === "daily_summary" && daily === null) daily = row;
    if (row.type === "hr_sample") {
      const point = heartFromWire(row);
      if (point) hearts.push(point);
    }
    if (row.type === "sleep_session") {
      const view = sleepFromWire(row);
      if (view) sleeps.push({ record: row, view });
    }
    if (row.type === "workout") {
      const view = workoutFromWire(row);
      if (view) workouts.push(view);
    }
  }
  if (!daily) throw new Error("ingest fixture has no daily_summary");
  const day = typeof daily.day === "string" && isCalendarDay(daily.day) ? daily.day : null;
  if (!day) throw new Error("ingest fixture daily_summary day is invalid");
  const metrics = metricsFromDaily(daily);
  const session = sleeps.find((item) => wakeDay(item.view.ended_at) === day) ?? null;
  if (session && metrics.sleep_hours === null) {
    metrics.sleep_hours = hoursBetween(session.view.started_at, session.view.ended_at);
  }
  return {
    day,
    metrics,
    heartRate: hearts.filter((point) => shanghaiDay(asDate(point.started_at) ?? new Date(point.started_at)) === day),
    sleep: session?.view ?? null,
    workouts: workouts
      .filter((item) => item.started_at.slice(0, 10) <= day)
      .sort((left, right) => (left.started_at < right.started_at ? 1 : -1))
      .slice(0, 8),
  };
}

export function fixtureToday(requestedDay: string): TodayResponse {
  const bundle = loadFixtureBundle();
  return buildToday({
    source: "fixture",
    requestedDay,
    day: bundle.day,
    metrics: bundle.metrics,
    heartRate: bundle.heartRate,
    stepsMinute: [],
    sleep: bundle.sleep,
    workouts: bundle.workouts,
  });
}

export function fixtureTrends(range: "week" | "month", anchorDay: string): TrendsResponse {
  const bundle = loadFixtureBundle();
  const byDay = new Map<string, DayMetric>();
  byDay.set(bundle.day, bundle.metrics);
  return buildTrends({ source: "fixture", range, day: anchorDay, byDay });
}

export function metricsFromDaily(row: Record<string, unknown>): DayMetric {
  return {
    steps: asNumber(row.steps),
    distance_m: asNumber(row.distance_m),
    floors: asNumber(row.floors),
    active_kcal: asNumber(row.active_kcal),
    exercise_minutes: asNumber(row.exercise_minutes),
    stand_hours: asNumber(row.stand_hours),
    resting_hr_bpm: asNumber(row.resting_hr_bpm),
    sleep_score: asNumber(row.sleep_score),
    sleep_hours: asNumber(row.sleep_hours),
    hr_zone_minutes: asZones(row.hr_zone_minutes),
  };
}

export function heartPoint(startedAt: unknown, bpm: unknown): HeartRatePoint | null {
  const instant = stamp(startedAt);
  const value = asNumber(bpm);
  if (!instant || value === null) return null;
  return { started_at: instant, bpm: value, value_num: value };
}

export function sleepView(input: {
  startedAt: unknown;
  endedAt: unknown;
  score: unknown;
  stages: Array<{ stage: unknown; startedAt: unknown; endedAt: unknown }>;
  deepMin?: unknown;
  lightMin?: unknown;
  remMin?: unknown;
  awakeMin?: unknown;
  awakeCount?: unknown;
  efficiency?: unknown;
  avgHr?: unknown;
  minHr?: unknown;
  maxHr?: unknown;
  avgSpo2?: unknown;
}): SleepView | null {
  const started = stamp(input.startedAt);
  const ended = stamp(input.endedAt);
  if (!started || !ended) return null;
  const stages: SleepStageView[] = [];
  for (const stage of input.stages) {
    if (typeof stage.stage !== "string" || !STAGES.has(stage.stage as SleepStageView["stage"])) continue;
    const stageStart = stamp(stage.startedAt);
    const stageEnd = stamp(stage.endedAt);
    if (!stageStart || !stageEnd) continue;
    stages.push({ stage: stage.stage as SleepStageView["stage"], started_at: stageStart, ended_at: stageEnd });
  }
  return {
    started_at: started,
    ended_at: ended,
    score: asNumber(input.score),
    stages,
    deep_min: minuteField(input.deepMin, derivedStageMinutes(stages, "deep")),
    light_min: minuteField(input.lightMin, derivedStageMinutes(stages, "light")),
    rem_min: minuteField(input.remMin, derivedStageMinutes(stages, "rem")),
    awake_min: minuteField(input.awakeMin, derivedStageMinutes(stages, "awake")),
    awake_count: asNumber(input.awakeCount),
    efficiency: asNumber(input.efficiency),
    avg_hr_bpm: asNumber(input.avgHr),
    min_hr_bpm: asNumber(input.minHr),
    max_hr_bpm: asNumber(input.maxHr),
    avg_spo2: asNumber(input.avgSpo2),
  };
}

export function workoutView(row: {
  startedAt: unknown;
  endedAt: unknown;
  sportType: unknown;
  title: unknown;
  durationSec: unknown;
  distanceM: unknown;
  activeKcal: unknown;
  avgHr: unknown;
  maxHr: unknown;
}): WorkoutView | null {
  const started = stamp(row.startedAt);
  if (!started) return null;
  const title = typeof row.title === "string" ? row.title : null;
  return {
    started_at: started,
    ended_at: stamp(row.endedAt),
    sport_type: typeof row.sportType === "string" ? row.sportType : null,
    sport_type_label: title,
    title,
    duration_sec: asNumber(row.durationSec),
    distance_m: asNumber(row.distanceM),
    active_kcal: asNumber(row.activeKcal),
    avg_hr_bpm: asNumber(row.avgHr),
    max_hr_bpm: asNumber(row.maxHr),
  };
}

export function hoursBetween(startedAt: string, endedAt: string): number | null {
  const started = asDate(startedAt);
  const ended = asDate(endedAt);
  if (!started || !ended) return null;
  const hours = (ended.getTime() - started.getTime()) / 3_600_000;
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

function pointFromDays(
  label: string,
  from: string,
  to: string,
  days: string[],
  byDay: Map<string, DayMetric>,
): TrendPoint {
  const rows = days.map((day) => byDay.get(day));
  const pick = (
    key: "steps" | "active_kcal" | "exercise_minutes" | "stand_hours" | "resting_hr_bpm" | "sleep_hours" | "sleep_score",
  ): number | null => mean(rows.map((row) => row?.[key] ?? null));
  return {
    day: from,
    label,
    from,
    to,
    steps: pick("steps"),
    active_kcal: pick("active_kcal"),
    exercise_minutes: pick("exercise_minutes"),
    stand_hours: pick("stand_hours"),
    resting_hr_bpm: pick("resting_hr_bpm"),
    sleep_hours: pick("sleep_hours"),
    sleep_score: pick("sleep_score"),
  };
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function utcWeekday(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error("expected YYYY-MM-DD");
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}

function heartFromWire(row: Record<string, unknown>): HeartRatePoint | null {
  return heartPoint(row.started_at, row.bpm);
}

function sleepFromWire(row: Record<string, unknown>): SleepView | null {
  const stages = Array.isArray(row.stages) ? row.stages : [];
  return sleepView({
    startedAt: row.started_at,
    endedAt: row.ended_at,
    score: row.score,
    deepMin: row.deep_min,
    lightMin: row.light_min,
    remMin: row.rem_min,
    awakeMin: row.awake_min,
    awakeCount: row.awake_count,
    efficiency: row.efficiency,
    avgHr: row.avg_hr_bpm,
    minHr: row.min_hr_bpm,
    maxHr: row.max_hr_bpm,
    avgSpo2: row.avg_spo2,
    stages: stages.map((stage) => {
      const item = typeof stage === "object" && stage !== null ? (stage as Record<string, unknown>) : {};
      return { stage: item.stage, startedAt: item.started_at, endedAt: item.ended_at };
    }),
  });
}

function minuteField(explicit: unknown, derived: number | null): number | null {
  if (explicit === undefined) return derived;
  const value = asNumber(explicit);
  return value === null ? derived : value;
}

function derivedStageMinutes(stages: readonly SleepStageView[], stage: SleepStageView["stage"]): number | null {
  let total = 0;
  let seen = false;
  for (const item of stages) {
    if (item.stage !== stage) continue;
    const started = asDate(item.started_at);
    const ended = asDate(item.ended_at);
    if (!started || !ended) continue;
    const minutes = Math.round((ended.getTime() - started.getTime()) / 60_000);
    if (minutes <= 0) continue;
    seen = true;
    total += minutes;
  }
  return seen ? total : null;
}

function workoutFromWire(row: Record<string, unknown>): WorkoutView | null {
  return workoutView({
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sportType: row.sport_type,
    title: row.sport_type_label,
    durationSec: row.duration_sec,
    distanceM: row.distance_m,
    activeKcal: row.active_kcal,
    avgHr: row.avg_hr_bpm,
    maxHr: row.max_hr_bpm,
  });
}

function wakeDay(endedAt: string): string {
  const instant = asDate(endedAt);
  return instant ? shanghaiDay(instant) : endedAt.slice(0, 10);
}
