import { ingestBatch } from "../ingest/batch.js";
import { finishSyncRun, openSyncRun, upsertDevice } from "../ingest/store.js";
import type { Queryable } from "../query.js";
import type { LiveProbeResult } from "./live-probe.js";

type ReadyProbe = Exclude<LiveProbeResult, { skipped: true }>;

/** Write a sync_runs row for a probe. Failed probes do not insert fitness rows. */
export async function persistLiveProbe(client: Queryable, result: ReadyProbe): Promise<void> {
  if (result.status === "failed" || result.records.length === 0) {
    await writeTerminalRun(client, result);
    return;
  }
  const ingested = await ingestBatch(
    client,
    {
      schema_version: "0.2",
      source: "mi_health",
      vendor_sid: result.vendor_sid,
      sync_run_id: result.sync_run_id,
      observed_at: result.observed_at,
      records: result.records,
    },
    {
      meta: {
        mode: "live_probe",
        window: result.window,
        upstream_status: result.upstream_status,
      },
      status: result.status,
      error_code: result.error_code,
    },
  );
  if (!ingested.ok) {
    throw new Error(`live probe ingest rejected the envelope (${ingested.body.error})`);
  }
}

async function writeTerminalRun(client: Queryable, result: ReadyProbe): Promise<void> {
  await client.query("BEGIN");
  try {
    const deviceId = await upsertDevice(client, "mi_health", result.vendor_sid);
    const meta = {
      source: "mi_health",
      schema_version: "0.2",
      mode: "live_probe",
      window: result.window,
      upstream_status: result.upstream_status,
      accepted: 0,
      rejected: 0,
    };
    const opened = await openSyncRun(client, result.sync_run_id, deviceId, meta);
    if (opened === "device_mismatch") {
      throw new Error("live probe sync_run_id is already bound to another device");
    }
    await finishSyncRun(
      client,
      result.sync_run_id,
      result.status === "failed" ? "failed" : "ok",
      0,
      result.error_code,
      meta,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
