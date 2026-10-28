import type { ErrorCode } from "../error-codes.js";
import { safeMeta } from "../mask.js";
import type { Queryable } from "../query.js";
import { shanghaiDay } from "../time.js";
import {
  findDeviceById,
  finishSyncRun,
  openSyncRun,
  postgresErrorCode,
  upsertDaily,
  upsertDevice,
  upsertHeartRate,
  upsertSleep,
  upsertWorkout,
} from "./store.js";
import type { ErrorBody, IngestBatchResponse, IngestRecord, ItemReject } from "./types.js";
import { isUuid, validateEnvelope, validateRecord } from "./validate.js";

export type IngestOptions = {
  meta?: Record<string, unknown>;
  /** Force a non-ok status when the caller stopped early (live probe truncation). */
  status?: "ok" | "partial" | "failed";
  error_code?: ErrorCode | null;
};

export type IngestResult =
  | { ok: true; status: 200; body: IngestBatchResponse }
  | { ok: false; status: 400 | 409; body: ErrorBody };

/**
 * Validate and upsert one batch. A bad record is rejected and does not roll back
 * records that already passed. Newer observed_at wins on the FORGE-005 unique key.
 */
export async function ingestBatch(client: Queryable, input: unknown, options: IngestOptions = {}): Promise<IngestResult> {
  const envelope = validateEnvelope(input);
  if (!envelope.ok) {
    return { ok: false, status: envelope.status, body: { error: envelope.error, detail: envelope.detail } };
  }
  const batch = envelope.value;

  await client.query("BEGIN");
  try {
    const device = await resolveDevice(client, batch.device_id, batch.vendor_sid);
    if (!device.ok) {
      await client.query("ROLLBACK");
      return { ok: false, status: device.status, body: { error: device.error, detail: device.detail } };
    }

    const meta = {
      source: "mi_health",
      schema_version: "0.2",
      mode: "ingest",
      ...safeMeta(options.meta ?? {}),
    };
    const opened = await openSyncRun(client, batch.sync_run_id, device.id, meta);
    if (opened === "device_mismatch") {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        body: { error: "sync_run_conflict", detail: "sync_run_id is already bound to another device." },
      };
    }

    let upserted = 0;
    let unchanged = 0;
    const rejected: ItemReject[] = [];

    for (let index = 0; index < batch.records.length; index += 1) {
      const validated = validateRecord(batch.records[index]);
      if (!validated.ok) {
        rejected.push({ index, reason: validated.reason });
        continue;
      }
      await client.query("SAVEPOINT item");
      try {
        const outcome = await applyRecord(client, device.id, batch.sync_run_id, batch.observed_at, validated.record);
        await client.query("RELEASE SAVEPOINT item");
        if (outcome === "upserted") upserted += 1;
        else unchanged += 1;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT item");
        await client.query("RELEASE SAVEPOINT item").catch(() => undefined);
        const code = postgresErrorCode(error);
        rejected.push({ index, reason: code === "23505" ? "conflict" : "database_reject" });
      }
    }

    const accepted = upserted + unchanged;
    let status: "ok" | "partial" | "failed" =
      rejected.length === 0 ? "ok" : accepted === 0 ? "failed" : "partial";
    let errorCode: ErrorCode | null = rejected.length === 0 ? null : "parse_error";
    if (options.status === "failed") status = "failed";
    else if (options.status === "partial" && status === "ok") status = "partial";
    if (options.error_code) {
      errorCode = options.error_code;
      if (status === "ok") status = "partial";
    }

    const days = batch.records.flatMap((item) => recordDay(item));
    const window =
      days.length === 0
        ? null
        : { from: days.reduce((min, day) => (day < min ? day : min)), to: days.reduce((max, day) => (day > max ? day : max)) };
    await finishSyncRun(client, batch.sync_run_id, status, upserted, errorCode, {
      ...meta,
      accepted,
      rejected: rejected.length,
      ...(window ? { window } : {}),
    });
    await client.query("COMMIT");
    return {
      ok: true,
      status: 200,
      body: {
        sync_run_id: batch.sync_run_id,
        accepted,
        upserted,
        unchanged,
        rejected,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function resolveDevice(
  client: Queryable,
  deviceId: string | null,
  vendorSid: string | null,
): Promise<{ ok: true; id: string } | { ok: false; status: 400 | 409; error: string; detail: string }> {
  if (deviceId !== null && isUuid(deviceId)) {
    const existing = await findDeviceById(client, deviceId);
    if (!existing) {
      return { ok: false, status: 409, error: "device_not_found", detail: "device_id does not match a device." };
    }
    if (existing.source !== "mi_health") {
      return { ok: false, status: 409, error: "source_mismatch", detail: "device source is not mi_health." };
    }
    return { ok: true, id: existing.id };
  }
  const externalId = vendorSid ?? deviceId;
  if (externalId === null || externalId === "") {
    return { ok: false, status: 400, error: "missing_device", detail: "Provide device_id or vendor_sid." };
  }
  const id = await upsertDevice(client, "mi_health", externalId);
  return { ok: true, id };
}

async function applyRecord(
  client: Queryable,
  deviceId: string,
  syncRunId: string,
  observedAt: string,
  record: IngestRecord,
): Promise<"upserted" | "unchanged"> {
  switch (record.type) {
    case "daily_summary":
      return upsertDaily(client, deviceId, syncRunId, observedAt, record);
    case "hr_sample":
      return upsertHeartRate(client, deviceId, syncRunId, observedAt, record);
    case "sleep_session":
      return upsertSleep(client, deviceId, syncRunId, observedAt, record);
    case "workout":
      return upsertWorkout(client, deviceId, syncRunId, observedAt, record);
  }
}

function recordDay(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  if (typeof record.day === "string") return [record.day];
  if (typeof record.started_at !== "string") return [];
  const parsed = new Date(record.started_at);
  if (Number.isNaN(parsed.getTime())) return [];
  return [shanghaiDay(parsed)];
}
