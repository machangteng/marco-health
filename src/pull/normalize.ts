import type { DailySummaryRecord, HrSampleRecord, SleepSessionRecord, SleepStageRecord, WorkoutRecord } from "../ingest/types.js";
import { epochMillis, formatInShanghai, shanghaiDay } from "../time.js";

export type UpstreamRow = {
  key?: unknown;
  sid?: unknown;
  time?: unknown;
  value?: unknown;
  tag?: unknown;
};

const ZONE_KEYS: Record<string, string> = {
  warm_up_hr_zone_duration: "warm_up",
  fat_burning_hr_zone_duration: "fat_burning",
  aerobic_hr_zone_duration: "aerobic",
  anaerobic_hr_zone_duration: "anaerobic",
  extreme_hr_zone_duration: "extreme",
};

/**
 * Merge stack X daily_report rows into one daily_summary per Shanghai day.
 * active_kcal comes from the calories key, never from steps.calories.
 */
export function normalizeDailyReports(rows: readonly UpstreamRow[]): DailySummaryRecord[] {
  const byDay = new Map<string, DailySummaryRecord>();
  for (const row of rows) {
    const time = asNumber(row.time);
    if (time === null) continue;
    const millis = epochMillis(time);
    if (millis === null) continue;
    const day = shanghaiDay(new Date(millis));
    const current = byDay.get(day) ?? emptyDaily(day);
    const value = asObject(parseMaybeJson(row.value));
    const key = typeof row.key === "string" ? row.key : "";
    applyDailyKey(current, key, value);
    byDay.set(day, current);
  }
  return [...byDay.values()];
}

/** Raw heart_rate rows. Samples before windowStartSec are the first-bucket pad and are dropped. */
export function normalizeHeartSamples(rows: readonly UpstreamRow[], windowStartSec: number): HrSampleRecord[] {
  const samples: HrSampleRecord[] = [];
  for (const row of rows) {
    const value = asObject(parseMaybeJson(row.value));
    const time = asNumber(value.time) ?? asNumber(row.time);
    if (time === null) continue;
    const seconds = time > 1e12 ? time / 1000 : time;
    if (seconds < windowStartSec) continue;
    const millis = epochMillis(time);
    const bpm = asInt(value.bpm);
    if (millis === null || bpm === null) continue;
    const kind = typeof value.type === "string" && value.type.trim() !== "" ? value.type.trim() : null;
    samples.push({
      type: "hr_sample",
      started_at: formatInShanghai(new Date(millis)),
      bpm,
      end_at: null,
      sample_kind: kind,
    });
  }
  return samples;
}

/**
 * Raw `get_fitness_data_by_time` key=sleep rows.
 * Xiaomi stage items use numeric `state` (2 deep, 3 light, 4 REM, 5 awake), not the names deep|light|rem|awake.
 * Durations on this row are minutes. A zero sleep_score is treated as absent.
 */
export function normalizeSleepSessions(rows: readonly UpstreamRow[]): SleepSessionRecord[] {
  const sessions: SleepSessionRecord[] = [];
  for (const row of rows) {
    const value = asObject(parseMaybeJson(row.value));
    const session = sessionFromWindow(value.bedtime ?? value.device_bedtime, value.wake_up_time ?? value.device_wake_up_time);
    if (!session) continue;
    applySleepMetrics(session, value, "set");
    session.stages = readStages(value);
    sessions.push(session);
  }
  return sessions;
}

/**
 * Aggregated `daily_report` key=sleep.
 * `sleep_score`, REM minutes, heart rate, and `avg_spo2` live here.
 * `segment_details` entries are sessions (bedtime / wake), not a stage timeline.
 * `sleep_stage` on this row is an integer grade/count and is ignored.
 * Day-level metrics fill only the longest segment so a shorter segment does not inherit the night score.
 */
export function normalizeAggregatedSleepSessions(rows: readonly UpstreamRow[]): SleepSessionRecord[] {
  const sessions: SleepSessionRecord[] = [];
  for (const row of rows) {
    if (row.key !== "sleep") continue;
    const value = asObject(parseMaybeJson(row.value));
    const built: SleepSessionRecord[] = [];
    if (Array.isArray(value.segment_details)) {
      for (const item of value.segment_details) {
        const segment = asObject(item);
        const session = sessionFromWindow(segment.bedtime ?? segment.device_bedtime, segment.wake_up_time ?? segment.device_wake_up_time);
        if (!session) continue;
        applySleepMetrics(session, segment, "set");
        built.push(session);
      }
    }
    if (built.length === 0) {
      const solo = sessionFromWindow(value.bedtime ?? value.device_bedtime, value.wake_up_time ?? value.device_wake_up_time);
      if (solo) built.push(solo);
    }
    const longest = longestSession(built);
    if (longest) applySleepMetrics(longest, value, "fill");
    sessions.push(...built);
  }
  return sessions;
}

/** Raw fitness rows win when both describe the same bedtime. Aggregated rows fill nulls, including score. */
export function mergeSleepSessions(
  raw: readonly SleepSessionRecord[],
  aggregated: readonly SleepSessionRecord[],
): SleepSessionRecord[] {
  const byStart = new Map<string, SleepSessionRecord>();
  for (const session of raw) byStart.set(session.started_at, session);
  for (const session of aggregated) {
    const existing = byStart.get(session.started_at);
    if (!existing) {
      byStart.set(session.started_at, session);
      continue;
    }
    applySleepMetrics(existing, metricsOf(session), "fill");
    if ((existing.stages === null || existing.stages.length === 0) && session.stages !== null && session.stages.length > 0) {
      existing.stages = session.stages;
    }
  }
  return [...byStart.values()];
}

export function normalizeWorkouts(rows: readonly UpstreamRow[]): WorkoutRecord[] {
  const workouts: WorkoutRecord[] = [];
  for (const row of rows) {
    const value = asObject(parseMaybeJson(row.value));
    const start = asNumber(value.start_time) ?? asNumber(row.time);
    const end = asNumber(value.end_time);
    if (start === null || end === null) continue;
    const startMs = epochMillis(start);
    const endMs = epochMillis(end);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const sportType = asText(value.sport_type) ?? asText(row.key);
    workouts.push({
      type: "workout",
      started_at: formatInShanghai(new Date(startMs)),
      ended_at: formatInShanghai(new Date(endMs)),
      sport_type: sportType,
      sport_type_label: null,
      duration_sec: asInt(value.duration),
      distance_m: asFinite(value.distance),
      active_kcal: asFinite(value.calories),
      avg_hr_bpm: asInt(value.avg_hrm),
      max_hr_bpm: asInt(value.max_hrm),
      vendor_sid: asText(row.sid),
    });
  }
  return workouts;
}

function emptyDaily(day: string): DailySummaryRecord {
  return {
    type: "daily_summary",
    day,
    started_at: `${day}T00:00:00+08:00`,
    steps: null,
    distance_m: null,
    floors: null,
    active_kcal: null,
    exercise_minutes: null,
    stand_hours: null,
    resting_hr_bpm: null,
    hr_zone_minutes: null,
    sleep_score: null,
  };
}

function applyDailyKey(current: DailySummaryRecord, key: string, value: Record<string, unknown>): void {
  switch (key) {
    case "steps":
      current.steps = asInt(value.steps);
      current.distance_m = asFinite(value.distance);
      return;
    case "calories":
      current.active_kcal = asFinite(value.calories);
      return;
    case "intensity":
      current.exercise_minutes = asInt(value.duration);
      return;
    case "valid_stand":
      current.stand_hours = asInt(value.count);
      return;
    case "heart_rate": {
      current.resting_hr_bpm = asInt(value.avg_rhr);
      const zones: Record<string, number> = {};
      for (const [upstream, name] of Object.entries(ZONE_KEYS)) {
        const minutes = asFinite(value[upstream]);
        if (minutes !== null) zones[name] = minutes;
      }
      current.hr_zone_minutes = Object.keys(zones).length === 0 ? null : zones;
      return;
    }
    case "sleep":
      current.sleep_score = asScore(value.sleep_score);
      return;
    default:
      return;
  }
}

type SleepMetrics = Pick<
  SleepSessionRecord,
  | "score"
  | "deep_min"
  | "light_min"
  | "rem_min"
  | "awake_min"
  | "awake_count"
  | "efficiency"
  | "avg_hr_bpm"
  | "min_hr_bpm"
  | "max_hr_bpm"
  | "avg_spo2"
>;

const SLEEP_METRIC_KEYS = [
  "score",
  "deep_min",
  "light_min",
  "rem_min",
  "awake_min",
  "awake_count",
  "efficiency",
  "avg_hr_bpm",
  "min_hr_bpm",
  "max_hr_bpm",
  "avg_spo2",
] as const satisfies readonly (keyof SleepMetrics)[];

/** Official sleep_state: 2 deep, 3 light, 4 REM, 5 awake. 0, 1, and 6 are not stages. */
const SLEEP_STATE: Record<number, SleepStageRecord["stage"]> = {
  2: "deep",
  3: "light",
  4: "rem",
  5: "awake",
};

function emptySleep(startedAt: string, endedAt: string): SleepSessionRecord {
  return {
    type: "sleep_session",
    started_at: startedAt,
    ended_at: endedAt,
    score: null,
    stages: null,
    deep_min: null,
    light_min: null,
    rem_min: null,
    awake_min: null,
    awake_count: null,
    efficiency: null,
    avg_hr_bpm: null,
    min_hr_bpm: null,
    max_hr_bpm: null,
    avg_spo2: null,
  };
}

function sessionFromWindow(bedtime: unknown, wake: unknown): SleepSessionRecord | null {
  const start = asNumber(bedtime);
  const end = asNumber(wake);
  if (start === null || end === null) return null;
  const startMs = epochMillis(start);
  const endMs = epochMillis(end);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return emptySleep(formatInShanghai(new Date(startMs)), formatInShanghai(new Date(endMs)));
}

function metricsFromUpstream(value: Record<string, unknown>): SleepMetrics {
  return {
    score: asScore(value.sleep_score ?? value.score),
    deep_min: asMinute(value.sleep_deep_duration),
    light_min: asMinute(value.sleep_light_duration),
    rem_min: asMinute(value.sleep_rem_duration),
    awake_min: asMinute(value.sleep_awake_duration),
    awake_count: asCount(value.awake_count),
    efficiency: asPercent(value.sleep_efficiency),
    avg_hr_bpm: asHr(value.avg_hr),
    min_hr_bpm: asHr(value.min_hr),
    max_hr_bpm: asHr(value.max_hr),
    avg_spo2: asPercent(value.avg_spo2),
  };
}

function metricsOf(session: SleepSessionRecord): SleepMetrics {
  return {
    score: session.score,
    deep_min: session.deep_min,
    light_min: session.light_min,
    rem_min: session.rem_min,
    awake_min: session.awake_min,
    awake_count: session.awake_count,
    efficiency: session.efficiency,
    avg_hr_bpm: session.avg_hr_bpm,
    min_hr_bpm: session.min_hr_bpm,
    max_hr_bpm: session.max_hr_bpm,
    avg_spo2: session.avg_spo2,
  };
}

function isSleepMetrics(value: Record<string, unknown> | SleepMetrics): value is SleepMetrics {
  return "deep_min" in value && "avg_hr_bpm" in value;
}

function applySleepMetrics(session: SleepSessionRecord, value: Record<string, unknown> | SleepMetrics, mode: "set" | "fill"): void {
  const incoming = isSleepMetrics(value) ? value : metricsFromUpstream(value);
  for (const key of SLEEP_METRIC_KEYS) {
    const next = incoming[key];
    if (mode === "set") session[key] = next;
    else if (session[key] === null && next !== null) session[key] = next;
  }
}

function longestSession(sessions: readonly SleepSessionRecord[]): SleepSessionRecord | null {
  let best: SleepSessionRecord | null = null;
  let span = -1;
  for (const session of sessions) {
    const width = instantSpan(session.started_at, session.ended_at);
    if (width > span) {
      best = session;
      span = width;
    }
  }
  return best;
}

function instantSpan(startedAt: string, endedAt: string): number {
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return 0;
  return Math.max(0, ended - started);
}

/** Timeline from `items`. `segment_details` is a session list, and numeric `sleep_stage` is not a timeline. */
function readStages(value: Record<string, unknown>): SleepStageRecord[] | null {
  const raw = value.items;
  if (!Array.isArray(raw)) return null;
  const stages: SleepStageRecord[] = [];
  for (const item of raw) {
    const stage = asObject(item);
    const name = stageName(stage);
    const start = asNumber(stage.start_time ?? stage.started_at ?? stage.start);
    const end = asNumber(stage.end_time ?? stage.ended_at ?? stage.end);
    if (name === null || start === null || end === null) continue;
    const startMs = epochMillis(start);
    const endMs = epochMillis(end);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    stages.push({
      stage: name,
      started_at: formatInShanghai(new Date(startMs)),
      ended_at: formatInShanghai(new Date(endMs)),
    });
  }
  return stages;
}

function stageName(stage: Record<string, unknown>): SleepStageRecord["stage"] | null {
  const named = normalizeStageName(stage.stage ?? stage.key);
  if (named) return named;
  const code = asInt(stage.state ?? stage.sleep_state ?? stage.stage);
  if (code === null) return null;
  return SLEEP_STATE[code] ?? null;
}

function normalizeStageName(value: unknown): SleepStageRecord["stage"] | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (name === "deep" || name === "light" || name === "rem" || name === "awake") return name;
  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asInt(value: unknown): number | null {
  const number = asNumber(value);
  if (number === null || !Number.isInteger(number)) return null;
  return number;
}

/** 1–100. Xiaomi uses 0 as an empty placeholder, so 0 stays null. */
function asScore(value: unknown): number | null {
  const number = asInt(value);
  if (number === null || number < 1 || number > 100) return null;
  return number;
}

function asPercent(value: unknown): number | null {
  return asScore(value);
}

function asMinute(value: unknown): number | null {
  const number = asInt(value);
  if (number === null || number < 0) return null;
  return number;
}

function asCount(value: unknown): number | null {
  return asMinute(value);
}

function asHr(value: unknown): number | null {
  const number = asInt(value);
  if (number === null || number < 1 || number > 250) return null;
  return number;
}

function asFinite(value: unknown): number | null {
  const number = asNumber(value);
  if (number === null || number < 0) return null;
  return number;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
