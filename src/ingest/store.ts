import type { ErrorCode } from "../error-codes.js";
import { safeMeta } from "../mask.js";
import { queryRows, type Queryable } from "../query.js";
import type {
  DailySummaryRecord,
  HrSampleRecord,
  SleepSessionRecord,
  WorkoutRecord,
} from "./types.js";

export type UpsertOutcome = "upserted" | "unchanged";

type IdRow = { id: string };

export async function findDeviceById(
  client: Queryable,
  deviceId: string,
): Promise<{ id: string; source: string; external_id: string } | null> {
  const found = await queryRows<{ id: string; source: string; external_id: string }>(
    client,
    "SELECT id::text AS id, source, external_id FROM devices WHERE id = $1::uuid",
    [deviceId],
  );
  return found[0] ?? null;
}

export async function upsertDevice(
  client: Queryable,
  source: string,
  externalId: string,
): Promise<string> {
  const rows = await queryRows<IdRow>(
    client,
    `INSERT INTO devices (source, external_id, timezone)
     VALUES ($1, $2, 'Asia/Shanghai')
     ON CONFLICT (source, external_id) DO UPDATE SET updated_at = now()
     RETURNING id::text AS id`,
    [source, externalId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("device upsert did not return an id");
  return id;
}

export async function openSyncRun(
  client: Queryable,
  syncRunId: string,
  deviceId: string,
  meta: Record<string, unknown>,
): Promise<"opened" | "device_mismatch"> {
  const existing = await queryRows<{ device_id: string }>(
    client,
    "SELECT device_id::text AS device_id FROM sync_runs WHERE id = $1::uuid",
    [syncRunId],
  );
  const current = existing[0];
  if (current && current.device_id !== deviceId) return "device_mismatch";
  if (!current) {
    await client.query(
      `INSERT INTO sync_runs (id, device_id, started_at, status, rows_upserted, error_code, meta)
       VALUES ($1::uuid, $2::uuid, now(), 'running', 0, NULL, $3::jsonb)`,
      [syncRunId, deviceId, JSON.stringify(safeMeta(meta))],
    );
    return "opened";
  }
  await client.query(
    `UPDATE sync_runs
     SET status = 'running', finished_at = NULL, rows_upserted = 0, error_code = NULL, meta = $2::jsonb
     WHERE id = $1::uuid`,
    [syncRunId, JSON.stringify(safeMeta(meta))],
  );
  return "opened";
}

export async function finishSyncRun(
  client: Queryable,
  syncRunId: string,
  status: "ok" | "partial" | "failed",
  rowsUpserted: number,
  errorCode: ErrorCode | null,
  meta: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `UPDATE sync_runs
     SET finished_at = now(), status = $2, rows_upserted = $3, error_code = $4, meta = $5::jsonb
     WHERE id = $1::uuid`,
    [syncRunId, status, rowsUpserted, errorCode, JSON.stringify(safeMeta(meta))],
  );
}

export async function upsertDaily(
  client: Queryable,
  deviceId: string,
  syncRunId: string,
  observedAt: string,
  record: DailySummaryRecord,
): Promise<UpsertOutcome> {
  const written = await queryRows<IdRow>(
    client,
    `INSERT INTO daily_aggregates (
       device_id, record_type, started_at, day_local,
       steps, distance_m, floors, active_kcal, exercise_minutes, stand_hours,
       resting_hr_bpm, hr_zone_minutes, sleep_score, sync_run_id, observed_at
     ) VALUES (
       $1::uuid, 'daily_summary', $2::timestamptz, $3::date,
       $4, $5, $6, $7, $8, $9,
       $10, $11::jsonb, $12, $13::uuid, $14::timestamptz
     )
     ON CONFLICT (device_id, record_type, started_at) DO UPDATE SET
       day_local = EXCLUDED.day_local,
       steps = EXCLUDED.steps,
       distance_m = EXCLUDED.distance_m,
       floors = EXCLUDED.floors,
       active_kcal = EXCLUDED.active_kcal,
       exercise_minutes = EXCLUDED.exercise_minutes,
       stand_hours = EXCLUDED.stand_hours,
       resting_hr_bpm = EXCLUDED.resting_hr_bpm,
       hr_zone_minutes = EXCLUDED.hr_zone_minutes,
       sleep_score = EXCLUDED.sleep_score,
       sync_run_id = EXCLUDED.sync_run_id,
       observed_at = EXCLUDED.observed_at,
       ingested_at = now()
     WHERE daily_aggregates.observed_at IS NULL
        OR daily_aggregates.observed_at < EXCLUDED.observed_at
     RETURNING id::text AS id`,
    [
      deviceId,
      record.started_at,
      record.day,
      record.steps,
      record.distance_m,
      record.floors,
      record.active_kcal,
      record.exercise_minutes,
      record.stand_hours,
      record.resting_hr_bpm,
      record.hr_zone_minutes === null ? null : JSON.stringify(record.hr_zone_minutes),
      record.sleep_score,
      syncRunId,
      observedAt,
    ],
  );
  return written.length > 0 ? "upserted" : "unchanged";
}

export async function upsertHeartRate(
  client: Queryable,
  deviceId: string,
  syncRunId: string,
  observedAt: string,
  record: HrSampleRecord,
): Promise<UpsertOutcome> {
  const extras = record.sample_kind === null ? {} : { type: record.sample_kind };
  const written = await queryRows<IdRow>(
    client,
    `INSERT INTO samples (
       device_id, record_type, started_at, ended_at, value_num, unit, extras, sync_run_id, observed_at
     ) VALUES (
       $1::uuid, 'heart_rate', $2::timestamptz, $3::timestamptz, $4, 'bpm', $5::jsonb, $6::uuid, $7::timestamptz
     )
     ON CONFLICT (device_id, record_type, started_at) DO UPDATE SET
       ended_at = EXCLUDED.ended_at,
       value_num = EXCLUDED.value_num,
       unit = EXCLUDED.unit,
       extras = EXCLUDED.extras,
       sync_run_id = EXCLUDED.sync_run_id,
       observed_at = EXCLUDED.observed_at,
       ingested_at = now()
     WHERE samples.observed_at IS NULL
        OR samples.observed_at < EXCLUDED.observed_at
     RETURNING id::text AS id`,
    [deviceId, record.started_at, record.end_at, record.bpm, JSON.stringify(extras), syncRunId, observedAt],
  );
  return written.length > 0 ? "upserted" : "unchanged";
}

export async function upsertSleep(
  client: Queryable,
  deviceId: string,
  syncRunId: string,
  observedAt: string,
  record: SleepSessionRecord,
): Promise<UpsertOutcome> {
  const written = await queryRows<IdRow>(
    client,
    `INSERT INTO sleep_sessions (
       device_id, record_type, started_at, ended_at, score,
       deep_min, light_min, rem_min, awake_min, awake_count,
       efficiency, avg_hr_bpm, min_hr_bpm, max_hr_bpm, avg_spo2,
       sync_run_id, observed_at
     ) VALUES (
       $1::uuid, 'sleep_session', $2::timestamptz, $3::timestamptz, $4,
       $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14,
       $15::uuid, $16::timestamptz
     )
     ON CONFLICT (device_id, record_type, started_at) DO UPDATE SET
       ended_at = EXCLUDED.ended_at,
       score = EXCLUDED.score,
       deep_min = EXCLUDED.deep_min,
       light_min = EXCLUDED.light_min,
       rem_min = EXCLUDED.rem_min,
       awake_min = EXCLUDED.awake_min,
       awake_count = EXCLUDED.awake_count,
       efficiency = EXCLUDED.efficiency,
       avg_hr_bpm = EXCLUDED.avg_hr_bpm,
       min_hr_bpm = EXCLUDED.min_hr_bpm,
       max_hr_bpm = EXCLUDED.max_hr_bpm,
       avg_spo2 = EXCLUDED.avg_spo2,
       sync_run_id = EXCLUDED.sync_run_id,
       observed_at = EXCLUDED.observed_at,
       ingested_at = now()
     WHERE sleep_sessions.observed_at IS NULL
        OR sleep_sessions.observed_at < EXCLUDED.observed_at
     RETURNING id::text AS id`,
    [
      deviceId,
      record.started_at,
      record.ended_at,
      record.score,
      record.deep_min,
      record.light_min,
      record.rem_min,
      record.awake_min,
      record.awake_count,
      record.efficiency,
      record.avg_hr_bpm,
      record.min_hr_bpm,
      record.max_hr_bpm,
      record.avg_spo2,
      syncRunId,
      observedAt,
    ],
  );
  if (written.length === 0) return "unchanged";
  const sessionId = written[0]?.id;
  if (!sessionId) throw new Error("sleep upsert did not return an id");
  if (record.stages !== null) {
    await client.query("DELETE FROM sleep_stages WHERE session_id = $1::uuid", [sessionId]);
    for (const stage of record.stages) {
      await client.query(
        `INSERT INTO sleep_stages (session_id, stage, started_at, ended_at)
         VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz)`,
        [sessionId, stage.stage, stage.started_at, stage.ended_at],
      );
    }
  }
  return "upserted";
}

export async function upsertWorkout(
  client: Queryable,
  deviceId: string,
  syncRunId: string,
  observedAt: string,
  record: WorkoutRecord,
): Promise<UpsertOutcome> {
  const written = await queryRows<IdRow>(
    client,
    `INSERT INTO workouts (
       device_id, record_type, started_at, ended_at, sport_type, title, vendor_sid,
       duration_sec, distance_m, active_kcal, avg_hr_bpm, max_hr_bpm, sync_run_id, observed_at
     ) VALUES (
       $1::uuid, 'workout', $2::timestamptz, $3::timestamptz, $4, $5, $6,
       $7, $8, $9, $10, $11, $12::uuid, $13::timestamptz
     )
     ON CONFLICT (device_id, record_type, started_at) DO UPDATE SET
       ended_at = EXCLUDED.ended_at,
       sport_type = EXCLUDED.sport_type,
       title = EXCLUDED.title,
       vendor_sid = EXCLUDED.vendor_sid,
       duration_sec = EXCLUDED.duration_sec,
       distance_m = EXCLUDED.distance_m,
       active_kcal = EXCLUDED.active_kcal,
       avg_hr_bpm = EXCLUDED.avg_hr_bpm,
       max_hr_bpm = EXCLUDED.max_hr_bpm,
       sync_run_id = EXCLUDED.sync_run_id,
       observed_at = EXCLUDED.observed_at,
       ingested_at = now()
     WHERE workouts.observed_at IS NULL
        OR workouts.observed_at < EXCLUDED.observed_at
     RETURNING id::text AS id`,
    [
      deviceId,
      record.started_at,
      record.ended_at,
      record.sport_type,
      record.sport_type_label,
      record.vendor_sid,
      record.duration_sec,
      record.distance_m,
      record.active_kcal,
      record.avg_hr_bpm,
      record.max_hr_bpm,
      syncRunId,
      observedAt,
    ],
  );
  return written.length > 0 ? "upserted" : "unchanged";
}

export function postgresErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return null;
}
