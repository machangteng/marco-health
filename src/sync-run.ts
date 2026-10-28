import { isErrorCode } from "./error-codes.js";
import { scrubSecrets } from "./mask.js";
import { queryRows, type Queryable } from "./query.js";
import { formatInShanghai } from "./time.js";

export type SyncRunView = {
  id: string;
  device_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  rows_upserted: number;
  error_code: string | null;
  meta: Record<string, unknown>;
};

type SyncRunRow = {
  id: string;
  device_id: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  status: string;
  rows_upserted: number | string;
  error_code: string | null;
  meta: unknown;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function getSyncRun(client: Queryable, syncRunId: string): Promise<SyncRunView | null> {
  const rows = await queryRows<SyncRunRow>(
    client,
    `SELECT id::text AS id,
            device_id::text AS device_id,
            started_at,
            finished_at,
            status,
            rows_upserted,
            error_code,
            meta
     FROM sync_runs
     WHERE id = $1::uuid`,
    [syncRunId],
  );
  const row = rows[0];
  if (!row) return null;
  const meta = scrubSecrets(row.meta);
  return {
    id: row.id,
    device_id: row.device_id,
    started_at: formatInShanghai(asDate(row.started_at)),
    finished_at: row.finished_at ? formatInShanghai(asDate(row.finished_at)) : null,
    status: row.status,
    rows_upserted: Number(row.rows_upserted),
    error_code: row.error_code === null ? null : isErrorCode(row.error_code) ? row.error_code : "unknown",
    meta: meta !== null && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {},
  };
}
