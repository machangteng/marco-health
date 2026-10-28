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

export function normalizeSleepSessions(rows: readonly UpstreamRow[]): SleepSessionRecord[] {
  const sessions: SleepSessionRecord[] = [];
  for (const row of rows) {
    const value = asObject(parseMaybeJson(row.value));
    const bedtime = asNumber(value.bedtime);
    const wake = asNumber(value.wake_up_time);
    if (bedtime === null || wake === null) continue;
    const startMs = epochMillis(bedtime);
    const endMs = epochMillis(wake);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    sessions.push({
      type: "sleep_session",
      started_at: formatInShanghai(new Date(startMs)),
      ended_at: formatInShanghai(new Date(endMs)),
      score: asInt(value.sleep_score),
      stages: readStages(value),
    });
  }
  return sessions;
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
      current.sleep_score = asInt(value.sleep_score);
      return;
    default:
      return;
  }
}

function readStages(value: Record<string, unknown>): SleepStageRecord[] | null {
  const raw = value.items ?? value.segment_details ?? value.sleep_stage;
  if (!Array.isArray(raw)) return null;
  const stages: SleepStageRecord[] = [];
  for (const item of raw) {
    const stage = asObject(item);
    const name = normalizeStageName(stage.stage ?? stage.key);
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
