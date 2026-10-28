import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Pool } from "pg";
import { checkHealth, unreachableHealth, type SqlQuery } from "./health.js";
import { ingestBatch } from "./ingest/batch.js";
import { isUuid } from "./ingest/validate.js";
import { maskSecrets } from "./mask.js";
import { asQueryable } from "./query.js";
import type { TodayResponse } from "./read/present.js";
import { readToday, readTrends, type ReadQuery } from "./read/service.js";
import { getSyncRun } from "./sync-run.js";
import { isCalendarDay, shanghaiDay } from "./time.js";
import { contentTypeFor, resolveWebFile } from "./web-static.js";

const MAX_BODY_BYTES = 2_000_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = "HttpError";
  }
}

export function createApp(pool: Pool): Server {
  return createServer((request, response) => {
    void handleRequest(pool, request, response);
  });
}

export async function handleRequest(pool: Pool, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  try {
    if (request.method === "GET" && path === "/v1") {
      send(response, 200, {
        service: "marco-health",
        source: "mi_health",
        ui: "/",
        health: "/health",
        ingest: "/v1/ingest/batch",
        read: {
          today: "/v1/read/today",
          heart_rate: "/v1/read/heart-rate",
          sleep: "/v1/read/sleep",
          workouts: "/v1/read/workouts",
          trends: "/v1/read/trends",
        },
      });
      return;
    }
    if (request.method === "GET" && path === "/health") {
      const query: SqlQuery = async (sql, params) => {
        const result = await pool.query(sql, params);
        return { rows: result.rows as Array<Record<string, unknown>> };
      };
      try {
        const report = await checkHealth(query);
        send(response, report.ok ? 200 : 503, report);
      } catch (error) {
        send(response, 503, unreachableHealth(error));
      }
      return;
    }
    if (path === "/v1/ingest/batch") {
      if (request.method !== "POST") {
        send(response, 405, { error: "method_not_allowed", detail: "Use POST." });
        return;
      }
      assertJsonContentType(request);
      const body = await readJson(request);
      const client = await pool.connect();
      try {
        const result = await ingestBatch(asQueryable(client), body);
        send(response, result.status, result.body);
      } finally {
        client.release();
      }
      return;
    }
    const syncMatch = /^\/v1\/sync\/runs\/([^/]+)$/.exec(path);
    if (syncMatch) {
      if (request.method !== "GET") {
        send(response, 405, { error: "method_not_allowed", detail: "Use GET." });
        return;
      }
      const syncRunId = decodeURIComponent(syncMatch[1] ?? "").toLowerCase();
      if (!isUuid(syncRunId)) {
        send(response, 400, { error: "invalid_sync_run_id", detail: "sync_run_id must be a UUID." });
        return;
      }
      const row = await getSyncRun(asQueryable(pool), syncRunId);
      if (!row) {
        send(response, 404, { error: "not_found", detail: "sync run not found." });
        return;
      }
      send(response, 200, row);
      return;
    }
    if (path.startsWith("/v1/read/")) {
      await handleRead(pool, request, response, path);
      return;
    }
    if (request.method === "GET") {
      const file = resolveWebFile(path);
      if (file) {
        const body = await readFile(file);
        response.writeHead(200, {
          "content-type": contentTypeFor(file),
          "cache-control": "no-store",
        });
        response.end(body);
        return;
      }
    }
    send(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HttpError) {
      send(response, error.status, { error: error.code, detail: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : "internal error";
    console.error(maskSecrets(message, secretValues()));
    send(response, 500, { error: "internal_error", detail: "Request failed." });
  }
}

async function handleRead(
  pool: Pool,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<void> {
  if (request.method !== "GET") {
    send(response, 405, { error: "method_not_allowed", detail: "Use GET." });
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const parsed = readParams(url);
  if ("error" in parsed) {
    send(response, 400, parsed);
    return;
  }
  const db = asQueryable(pool);
  if (path === "/v1/read/trends") {
    const range = url.searchParams.get("range") ?? "week";
    if (range !== "week" && range !== "month") {
      send(response, 400, { error: "invalid_range", detail: "range must be week or month." });
      return;
    }
    send(response, 200, await readTrends(db, { ...parsed, range }));
    return;
  }
  const today = await readToday(db, parsed);
  if (path === "/v1/read/today") {
    send(response, 200, today);
    return;
  }
  if (path === "/v1/read/heart-rate") {
    send(response, 200, sliceHeart(today));
    return;
  }
  if (path === "/v1/read/sleep") {
    send(response, 200, sliceSleep(today));
    return;
  }
  if (path === "/v1/read/workouts") {
    send(response, 200, sliceWorkouts(today));
    return;
  }
  send(response, 404, { error: "not_found" });
}

function readParams(url: URL): ReadQuery | { error: string; detail: string } {
  const rawDay = url.searchParams.get("day");
  const day = rawDay === null || rawDay === "" ? shanghaiDay(new Date()) : rawDay;
  if (!isCalendarDay(day)) return { error: "invalid_day", detail: "day must be YYYY-MM-DD." };
  const rawDevice = url.searchParams.get("device_id");
  if (rawDevice === null || rawDevice === "") return { day, deviceId: null };
  const deviceId = rawDevice.toLowerCase();
  if (!isUuid(deviceId)) return { error: "invalid_device_id", detail: "device_id must be a UUID." };
  return { day, deviceId };
}

function sliceHeart(today: TodayResponse) {
  return {
    source: today.source,
    timezone: today.timezone,
    day: today.day,
    requested_day: today.requested_day,
    heart_rate: today.heart_rate,
  };
}

function sliceSleep(today: TodayResponse) {
  return {
    source: today.source,
    timezone: today.timezone,
    day: today.day,
    requested_day: today.requested_day,
    sleep_score: today.sleep_score,
    sleep: today.sleep,
  };
}

function sliceWorkouts(today: TodayResponse) {
  return {
    source: today.source,
    timezone: today.timezone,
    day: today.day,
    requested_day: today.requested_day,
    workouts: today.workouts,
  };
}

function assertJsonContentType(request: IncomingMessage): void {
  const header = request.headers["content-type"];
  if (header === undefined) return;
  if (!header.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw new HttpError(400, "invalid_json", "Request body is empty.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not JSON.");
  }
}

function secretValues(): string[] {
  return [process.env.XIAOMI_PASS_TOKEN ?? "", process.env.XIAOMI_DEVICE_ID ?? ""].filter((value) => value !== "");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
