import {
  formatInShanghai,
  isCalendarDay,
  parseOffsetDateTime,
  sameInstant,
  shanghaiDayStart,
} from "../time.js";
import type {
  DailySummaryRecord,
  HrSampleRecord,
  IngestEnvelope,
  IngestRecord,
  SleepSessionRecord,
  SleepStageRecord,
  WorkoutRecord,
} from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECORDS = 5000;
const STAGES = new Set(["deep", "light", "rem", "awake"]);

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

type Failure = { ok: false; status: 400 | 409; error: string; detail: string };
type EnvelopeOk = { ok: true; value: IngestEnvelope };

export function validateEnvelope(input: unknown): EnvelopeOk | Failure {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return fail(400, "invalid_envelope", "Body must be a JSON object.");
  }
  const body = input as Record<string, unknown>;
  if (body.schema_version !== "0.2") {
    return fail(400, "invalid_envelope", "schema_version must be \"0.2\".");
  }
  if (body.source !== "mi_health") {
    return fail(409, "source_mismatch", "source must be mi_health.");
  }
  if (typeof body.sync_run_id !== "string" || !isUuid(body.sync_run_id)) {
    return fail(400, "invalid_envelope", "sync_run_id must be a UUID.");
  }
  if (typeof body.observed_at !== "string" || parseOffsetDateTime(body.observed_at) === null) {
    return fail(400, "invalid_envelope", "observed_at must be an ISO-8601 timestamp with a timezone.");
  }
  if (!Array.isArray(body.records)) {
    return fail(400, "invalid_envelope", "records must be an array.");
  }
  if (body.records.length === 0) {
    return fail(400, "invalid_envelope", "records must contain at least one item.");
  }
  if (body.records.length > MAX_RECORDS) {
    return fail(400, "invalid_envelope", `records must contain at most ${MAX_RECORDS} items.`);
  }
  const deviceId = optionalString(body.device_id);
  if (deviceId instanceof Error) return fail(400, "invalid_envelope", "device_id must be a string or omitted.");
  const vendorSid = optionalString(body.vendor_sid);
  if (vendorSid instanceof Error) return fail(400, "invalid_envelope", "vendor_sid must be a string or omitted.");
  if ((deviceId === null || deviceId === "") && (vendorSid === null || vendorSid === "")) {
    return fail(400, "missing_device", "Provide device_id or vendor_sid so the device can be resolved.");
  }
  const observed = parseOffsetDateTime(body.observed_at);
  if (!observed) return fail(400, "invalid_envelope", "observed_at must be an ISO-8601 timestamp with a timezone.");
  return {
    ok: true,
    value: {
      schema_version: "0.2",
      source: "mi_health",
      device_id: deviceId === "" ? null : deviceId,
      vendor_sid: vendorSid === "" ? null : vendorSid,
      sync_run_id: body.sync_run_id.toLowerCase(),
      observed_at: formatInShanghai(observed),
      records: body.records,
    },
  };
}

export function validateRecord(input: unknown): { ok: true; record: IngestRecord } | { ok: false; reason: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "invalid_record" };
  }
  const record = input as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type === "") return { ok: false, reason: "missing_type" };
  switch (record.type) {
    case "daily_summary":
      return validateDaily(record);
    case "hr_sample":
      return validateHeartRate(record);
    case "sleep_session":
      return validateSleep(record);
    case "workout":
      return validateWorkout(record);
    default:
      return { ok: false, reason: "unknown_type" };
  }
}

function validateDaily(record: Record<string, unknown>): { ok: true; record: DailySummaryRecord } | { ok: false; reason: string } {
  if (typeof record.day !== "string" || record.day === "") return { ok: false, reason: "missing_day" };
  if (!isCalendarDay(record.day)) return { ok: false, reason: "invalid_day" };
  const started = requiredTimestamp(record.started_at, "missing_started_at", "invalid_started_at");
  if (typeof started === "string") return { ok: false, reason: started };
  if (!sameInstant(started, shanghaiDayStart(record.day))) return { ok: false, reason: "started_at_not_day_start" };
  const steps = readInt(record, "steps", "invalid_steps", 0);
  if (typeof steps === "string") return { ok: false, reason: steps };
  const distance = readNumber(record, "distance_m", "invalid_distance_m", 0);
  if (typeof distance === "string") return { ok: false, reason: distance };
  const floors = readInt(record, "floors", "invalid_floors", 0);
  if (typeof floors === "string") return { ok: false, reason: floors };
  const active = readNumber(record, "active_kcal", "invalid_active_kcal", 0);
  if (typeof active === "string") return { ok: false, reason: active };
  const exercise = readInt(record, "exercise_minutes", "invalid_exercise_minutes", 0);
  if (typeof exercise === "string") return { ok: false, reason: exercise };
  const stand = readInt(record, "stand_hours", "invalid_stand_hours", 0, 24);
  if (typeof stand === "string") return { ok: false, reason: stand };
  const resting = readInt(record, "resting_hr_bpm", "invalid_resting_hr_bpm", 20, 250);
  if (typeof resting === "string") return { ok: false, reason: resting };
  const zones = readZones(record.hr_zone_minutes);
  if (typeof zones === "string") return { ok: false, reason: zones };
  const sleepScore = readInt(record, "sleep_score", "invalid_sleep_score", 0, 100);
  if (typeof sleepScore === "string") return { ok: false, reason: sleepScore };
  return {
    ok: true,
    record: {
      type: "daily_summary",
      day: record.day,
      started_at: `${record.day}T00:00:00+08:00`,
      steps,
      distance_m: distance,
      floors,
      active_kcal: active,
      exercise_minutes: exercise,
      stand_hours: stand,
      resting_hr_bpm: resting,
      hr_zone_minutes: zones,
      sleep_score: sleepScore,
    },
  };
}

function validateHeartRate(record: Record<string, unknown>): { ok: true; record: HrSampleRecord } | { ok: false; reason: string } {
  const started = requiredTimestamp(record.started_at, "missing_started_at", "invalid_started_at");
  if (typeof started === "string") return { ok: false, reason: started };
  if (!("bpm" in record) || record.bpm === null) return { ok: false, reason: "missing_bpm" };
  if (typeof record.bpm !== "number" || !Number.isInteger(record.bpm) || record.bpm < 20 || record.bpm > 250) {
    return { ok: false, reason: "invalid_bpm" };
  }
  let endAt: string | null = null;
  if ("end_at" in record && record.end_at !== null && record.end_at !== undefined) {
    if (typeof record.end_at !== "string") return { ok: false, reason: "invalid_end_at" };
    const parsed = parseOffsetDateTime(record.end_at);
    if (!parsed) return { ok: false, reason: "invalid_end_at" };
    if (parsed.getTime() <= started.getTime()) return { ok: false, reason: "end_before_start" };
    endAt = formatInShanghai(parsed);
  }
  const sampleKind = readShortString(record.sample_kind, "invalid_sample_kind");
  if (sampleKind instanceof Error) return { ok: false, reason: "invalid_sample_kind" };
  return {
    ok: true,
    record: {
      type: "hr_sample",
      started_at: formatInShanghai(started),
      bpm: record.bpm,
      end_at: endAt,
      sample_kind: sampleKind,
    },
  };
}

function validateSleep(record: Record<string, unknown>): { ok: true; record: SleepSessionRecord } | { ok: false; reason: string } {
  const started = requiredTimestamp(record.started_at, "missing_started_at", "invalid_started_at");
  if (typeof started === "string") return { ok: false, reason: started };
  const ended = requiredTimestamp(record.ended_at, "missing_ended_at", "invalid_ended_at");
  if (typeof ended === "string") return { ok: false, reason: ended };
  if (ended.getTime() <= started.getTime()) return { ok: false, reason: "ended_before_started" };
  const score = readInt(record, "score", "invalid_sleep_score", 0, 100);
  if (typeof score === "string") return { ok: false, reason: score };
  let stages: SleepStageRecord[] | null = null;
  if ("stages" in record && record.stages !== undefined && record.stages !== null) {
    if (!Array.isArray(record.stages)) return { ok: false, reason: "invalid_stage" };
    stages = [];
    for (const stage of record.stages) {
      const parsed = validateStage(stage);
      if (typeof parsed === "string") return { ok: false, reason: parsed };
      stages.push(parsed);
    }
  }
  return {
    ok: true,
    record: {
      type: "sleep_session",
      started_at: formatInShanghai(started),
      ended_at: formatInShanghai(ended),
      score,
      stages,
    },
  };
}

function validateStage(input: unknown): SleepStageRecord | string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "invalid_stage";
  const stage = input as Record<string, unknown>;
  if (typeof stage.stage !== "string" || !STAGES.has(stage.stage)) return "invalid_stage";
  const started = requiredTimestamp(stage.started_at, "invalid_stage_window", "invalid_stage_window");
  if (typeof started === "string") return "invalid_stage_window";
  const ended = requiredTimestamp(stage.ended_at, "invalid_stage_window", "invalid_stage_window");
  if (typeof ended === "string") return "invalid_stage_window";
  if (ended.getTime() <= started.getTime()) return "invalid_stage_window";
  return {
    stage: stage.stage as SleepStageRecord["stage"],
    started_at: formatInShanghai(started),
    ended_at: formatInShanghai(ended),
  };
}

function validateWorkout(record: Record<string, unknown>): { ok: true; record: WorkoutRecord } | { ok: false; reason: string } {
  const started = requiredTimestamp(record.started_at, "missing_started_at", "invalid_started_at");
  if (typeof started === "string") return { ok: false, reason: started };
  const ended = requiredTimestamp(record.ended_at, "missing_ended_at", "invalid_ended_at");
  if (typeof ended === "string") return { ok: false, reason: ended };
  if (ended.getTime() <= started.getTime()) return { ok: false, reason: "ended_before_started" };
  const sportType = readShortString(record.sport_type, "invalid_sport_type");
  if (sportType instanceof Error) return { ok: false, reason: "invalid_sport_type" };
  const label = readShortString(record.sport_type_label, "invalid_sport_type", 80);
  if (label instanceof Error) return { ok: false, reason: "invalid_sport_type" };
  const duration = readInt(record, "duration_sec", "invalid_duration_sec", 0);
  if (typeof duration === "string") return { ok: false, reason: duration };
  const distance = readNumber(record, "distance_m", "invalid_distance_m", 0);
  if (typeof distance === "string") return { ok: false, reason: distance };
  const active = readNumber(record, "active_kcal", "invalid_active_kcal", 0);
  if (typeof active === "string") return { ok: false, reason: active };
  const avg = readInt(record, "avg_hr_bpm", "invalid_avg_hr_bpm", 20, 250);
  if (typeof avg === "string") return { ok: false, reason: avg };
  const max = readInt(record, "max_hr_bpm", "invalid_max_hr_bpm", 20, 250);
  if (typeof max === "string") return { ok: false, reason: max };
  const vendorSid = readShortString(record.vendor_sid, "invalid_vendor_sid", 128);
  if (vendorSid instanceof Error) return { ok: false, reason: "invalid_vendor_sid" };
  return {
    ok: true,
    record: {
      type: "workout",
      started_at: formatInShanghai(started),
      ended_at: formatInShanghai(ended),
      sport_type: sportType,
      sport_type_label: label,
      duration_sec: duration,
      distance_m: distance,
      active_kcal: active,
      avg_hr_bpm: avg,
      max_hr_bpm: max,
      vendor_sid: vendorSid,
    },
  };
}

function fail(status: 400 | 409, error: string, detail: string): Failure {
  return { ok: false, status, error, detail };
}

function optionalString(value: unknown): string | null | Error {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return new Error("not a string");
  return value.trim();
}

function requiredTimestamp(value: unknown, missing: string, invalid: string): Date | string {
  if (value === undefined || value === null || value === "") return missing;
  if (typeof value !== "string") return invalid;
  return parseOffsetDateTime(value) ?? invalid;
}

function readInt(
  record: Record<string, unknown>,
  key: string,
  reason: string,
  min: number,
  max?: number,
): number | null | string {
  if (!(key in record) || record[key] === null || record[key] === undefined) return null;
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) return reason;
  if (value < min) return reason;
  if (max !== undefined && value > max) return reason;
  return value;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  reason: string,
  min: number,
): number | null | string {
  if (!(key in record) || record[key] === null || record[key] === undefined) return null;
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return reason;
  return value;
}

function readZones(value: unknown): Record<string, number> | null | string {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid_hr_zone_minutes";
  const zones: Record<string, number> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) return "invalid_hr_zone_minutes";
    if (typeof inner !== "number" || !Number.isFinite(inner) || inner < 0) return "invalid_hr_zone_minutes";
    zones[key] = inner;
  }
  return zones;
}

function readShortString(value: unknown, _reason: string, max = 64): string | null | Error {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return new Error("not a string");
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) return new Error("too long");
  return trimmed;
}
