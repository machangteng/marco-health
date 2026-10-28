import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ErrorCode } from "../error-codes.js";
import type { IngestRecord } from "../ingest/types.js";
import { maskSecrets } from "../mask.js";
import { formatInShanghai, shiftShanghaiDay, shanghaiDay } from "../time.js";
import { normalizeDailyReports, normalizeHeartSamples, normalizeSleepSessions, normalizeWorkouts, type UpstreamRow } from "./normalize.js";
import { clientSign, openJson, sealParams } from "./xiaomi-crypto.js";

/** Inclusive Shanghai days covered by one probe. Not a historical backfill. */
export const PROBE_WINDOW_DAYS = 2;
export const PROBE_DAILY_KEYS = ["steps", "calories", "intensity", "valid_stand", "heart_rate"] as const;
const HEALTH_ORIGIN = "https://hlth.io.mi.com";
const LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=miothealth";
const MIN_GAP_MS = 1000;
const MAX_GAP_MS = 2000;
const MAX_PAGES = 2;

const PATH_OK: Record<string, (pathname: string) => boolean> = {
  "account.xiaomi.com": (pathname) => pathname === "/pass/serviceLogin",
  "sts-hlth.io.mi.com": (pathname) => pathname === "/healthapp/sts",
  "hlth.io.mi.com": (pathname) =>
    pathname === "/app/v1/data/get_aggregated_fitness_data_by_time" ||
    pathname === "/app/v1/data/get_fitness_data_by_time" ||
    pathname === "/app/v1/data/get_sport_records_by_time",
};

export type ProbeRequest = {
  url: string;
  method: "GET";
  headers: Record<string, string>;
};

export type ProbeResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type ProbeTransport = (request: ProbeRequest) => Promise<ProbeResponse>;

export type LiveProbeOptions = {
  env: NodeJS.ProcessEnv;
  transport?: ProbeTransport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  log?: (line: string) => void;
  dailyKeys?: readonly string[];
  includeHeartSamples?: boolean;
  includeSleep?: boolean;
  includeSport?: boolean;
};

export type ProbeWindow = { from: string; to: string };

export type LiveProbeResult =
  | { skipped: true; reason: "credentials_absent" }
  | {
      skipped: false;
      status: "ok" | "partial" | "failed";
      error_code: ErrorCode | null;
      upstream_status: number | null;
      window: ProbeWindow;
      records: IngestRecord[];
      sync_run_id: string;
      vendor_sid: string;
      observed_at: string;
    };

type Session = {
  userId: string;
  passToken: string;
  deviceId: string;
  cUserId: string;
  ssecurity: string;
  serviceToken: string;
};

class ProbeFailure extends Error {
  constructor(
    readonly errorCode: ErrorCode,
    readonly upstreamStatus: number | null,
  ) {
    super(errorCode);
    this.name = "ProbeFailure";
  }
}

export function interRequestDelayMs(random: () => number = Math.random): number {
  const span = MAX_GAP_MS - MIN_GAP_MS;
  return MIN_GAP_MS + Math.floor(random() * (span + 1));
}

export function isStackXUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const allow = PATH_OK[url.hostname];
  return allow ? allow(url.pathname) : false;
}

export function accountExternalId(userId: string): string {
  const digest = createHash("sha256").update(`mi_health:${userId}`).digest("hex").slice(0, 24);
  return `acct_${digest}`;
}

export function probeWindow(now: Date): ProbeWindow & { startSec: number; endSec: number; hrStartSec: number } {
  const to = shanghaiDay(now);
  const from = shiftShanghaiDay(to, -(PROBE_WINDOW_DAYS - 1));
  const startSec = Math.floor(new Date(`${from}T00:00:00+08:00`).getTime() / 1000);
  const endSec = Math.floor(now.getTime() / 1000);
  return { from, to, startSec, endSec, hrStartSec: startSec - 86_400 };
}

export function readXiaomiCredentials(env: NodeJS.ProcessEnv): { userId: string; passToken: string; deviceId: string } | null {
  const userId = env.XIAOMI_USER_ID?.trim() ?? "";
  const passToken = env.XIAOMI_PASS_TOKEN?.trim() ?? "";
  if (userId === "" || passToken === "") return null;
  return { userId, passToken, deviceId: env.XIAOMI_DEVICE_ID?.trim() ?? "" };
}

export function fetchTransport(timeoutMs = 15_000): ProbeTransport {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    return {
      status: response.status,
      headers: setCookie.length > 0 ? { "set-cookie": setCookie } : {},
      body: await response.text(),
    };
  };
}

/**
 * Short stack X probe. Missing credentials return credentials_absent and do not call the network.
 * The daily CLI treats that result as a failure. It is not a successful skip.
 * A 401 on the health host renews the STS session once, then stops as auth_expired.
 * Requests wait 1-2s with jitter. passToken is sent only to account.xiaomi.com.
 * Data calls stay on hlth.io.mi.com.
 */
export async function runLiveProbe(options: LiveProbeOptions): Promise<LiveProbeResult> {
  const credentials = readXiaomiCredentials(options.env);
  const now = options.now ?? (() => new Date());
  const window = probeWindow(now());
  if (!credentials) return { skipped: true, reason: "credentials_absent" };

  const secrets = [credentials.passToken, credentials.userId];
  const log = (line: string) => {
    options.log?.(maskSecrets(line, secrets));
  };
  const transport = options.transport ?? fetchTransport();
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const vendorSid = accountExternalId(credentials.userId);
  const syncRunId = randomUUID();
  const observedAt = formatInShanghai(now());
  let lastRequestAt = 0;
  let upstreamStatus: number | null = null;
  let renewed = false;
  let truncated = false;

  const fail = (code: ErrorCode, status: number | null): LiveProbeResult => ({
    skipped: false,
    status: "failed",
    error_code: code,
    upstream_status: status ?? upstreamStatus,
    window: { from: window.from, to: window.to },
    records: [],
    sync_run_id: syncRunId,
    vendor_sid: vendorSid,
    observed_at: observedAt,
  });

  const call = async (url: string, headers: Record<string, string>): Promise<ProbeResponse> => {
    if (!isStackXUrl(url)) throw new ProbeFailure("unknown", null);
    if (lastRequestAt !== 0) {
      const gap = interRequestDelayMs(random);
      await sleep(gap);
    }
    lastRequestAt = Date.now();
    const parsed = new URL(url);
    try {
      const response = await transport({ url, method: "GET", headers });
      upstreamStatus = response.status;
      log(`stack-x GET ${parsed.host}${parsed.pathname} -> ${response.status}`);
      return response;
    } catch (error) {
      log(`stack-x GET ${parsed.host}${parsed.pathname} -> error`);
      if (isTimeout(error)) throw new ProbeFailure("upstream_timeout", null);
      throw new ProbeFailure("unknown", null);
    }
  };

  const session: Session = {
    userId: credentials.userId,
    passToken: credentials.passToken,
    deviceId: credentials.deviceId === "" ? randomBytes(8).toString("hex").toUpperCase() : credentials.deviceId,
    cUserId: "",
    ssecurity: "",
    serviceToken: "",
  };
  secrets.push(session.deviceId);

  try {
    await establish(session, call);
    secrets.push(session.serviceToken, session.ssecurity);

    const dailyRows: UpstreamRow[] = [];
    const keys = options.dailyKeys ?? PROBE_DAILY_KEYS;
    for (const key of keys) {
      const page = await pagedGet(session, "/app/v1/data/get_aggregated_fitness_data_by_time", {
        relative_uid: relativeUid(session.userId),
        key,
        tag: "daily_report",
        start_time: window.startSec,
        end_time: window.endSec,
        limit: PROBE_WINDOW_DAYS,
      }, "data_list", call, () => {
        truncated = true;
      });
      dailyRows.push(...page);
    }

    let heartRows: UpstreamRow[] = [];
    if (options.includeHeartSamples !== false) {
      heartRows = await pagedGet(session, "/app/v1/data/get_fitness_data_by_time", {
        relative_uid: relativeUid(session.userId),
        key: "heart_rate",
        start_time: window.hrStartSec,
        end_time: window.endSec,
        limit: 200,
      }, "data_list", call, () => {
        truncated = true;
      });
    }

    let sleepRows: UpstreamRow[] = [];
    if (options.includeSleep !== false) {
      sleepRows = await pagedGet(session, "/app/v1/data/get_fitness_data_by_time", {
        relative_uid: relativeUid(session.userId),
        key: "sleep",
        start_time: window.hrStartSec,
        end_time: window.endSec,
        limit: 20,
      }, "data_list", call, () => {
        truncated = true;
      });
    }

    let sportRows: UpstreamRow[] = [];
    if (options.includeSport !== false) {
      sportRows = await pagedGet(session, "/app/v1/data/get_sport_records_by_time", {
        start_time: window.startSec,
        end_time: window.endSec,
        limit: 50,
        reverse: false,
      }, "sport_records", call, () => {
        truncated = true;
      });
    }

    const records: IngestRecord[] = [
      ...normalizeDailyReports(dailyRows),
      ...normalizeHeartSamples(heartRows, window.startSec),
      ...normalizeSleepSessions(sleepRows),
      ...normalizeWorkouts(sportRows),
    ];
    return {
      skipped: false,
      status: truncated ? "partial" : "ok",
      error_code: null,
      upstream_status: upstreamStatus,
      window: { from: window.from, to: window.to },
      records,
      sync_run_id: syncRunId,
      vendor_sid: vendorSid,
      observed_at: observedAt,
    };
  } catch (error) {
    if (error instanceof ProbeFailure) return fail(error.errorCode, error.upstreamStatus);
    return fail("unknown", upstreamStatus);
  }

  async function establish(current: Session, request: typeof call): Promise<void> {
    const response = await request(LOGIN_URL, {
      cookie: `userId=${current.userId}; deviceId=${current.deviceId}; passToken=${current.passToken}`,
      accept: "application/json",
      "user-agent": "marco-health/0.2",
    });
    if (response.status === 429) throw new ProbeFailure("rate_limited", 429);
    if (response.status >= 500) throw new ProbeFailure("upstream_5xx", response.status);
    if (response.status === 401) throw new ProbeFailure("auth_expired", 401);
    if (response.status !== 200) throw new ProbeFailure("unknown", response.status);
    const payload = parseLogin(response.body);
    if (payload.code === 70016) throw new ProbeFailure("pass_token_invalid", 200);
    if (payload.securityStatus !== 0) throw new ProbeFailure("auth_expired", 200);
    if (payload.code !== 0 || payload.ssecurity === "" || payload.nonce === "" || payload.location === "") {
      throw new ProbeFailure("auth_expired", 200);
    }
    if (!isStackXUrl(payload.location)) throw new ProbeFailure("unknown", 200);
    current.ssecurity = payload.ssecurity;
    if (payload.cUserId !== "") current.cUserId = payload.cUserId;
    const sign = clientSign(payload.nonce, payload.ssecurity);
    const signed = `${payload.location}${payload.location.includes("?") ? "&" : "?"}clientSign=${encodeURIComponent(sign).replaceAll("%2F", "/")}`;
    const sts = await request(signed, {
      cookie: `userId=${current.userId}; deviceId=${current.deviceId}`,
      "user-agent": "marco-health/0.2",
    });
    if (sts.status === 429) throw new ProbeFailure("rate_limited", 429);
    if (sts.status >= 500) throw new ProbeFailure("upstream_5xx", sts.status);
    if (sts.status === 401) throw new ProbeFailure("auth_expired", 401);
    if (sts.status !== 200) throw new ProbeFailure("auth_expired", sts.status);
    const token = cookieValue(sts.headers, "serviceToken");
    if (token === "") throw new ProbeFailure("auth_expired", sts.status);
    current.serviceToken = token;
  }

  async function pagedGet(
    current: Session,
    path: string,
    params: Record<string, unknown>,
    listKey: "data_list" | "sport_records",
    request: typeof call,
    onTruncated: () => void,
  ): Promise<UpstreamRow[]> {
    const rows: UpstreamRow[] = [];
    let nextKey = "";
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = nextKey === "" ? params : { ...params, next_key: nextKey };
      const decoded = await signedGet(current, path, query, request);
      const list = decoded[listKey];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item !== null && typeof item === "object") rows.push(item as UpstreamRow);
        }
      }
      const hasMore = decoded.has_more === true;
      if (!hasMore) return rows;
      const incoming = decoded.next_key;
      if (typeof incoming !== "string" || incoming.trim() === "") throw new ProbeFailure("incomplete_page", 200);
      nextKey = incoming;
    }
    onTruncated();
    return rows;
  }

  async function signedGet(
    current: Session,
    path: string,
    params: Record<string, unknown>,
    request: typeof call,
  ): Promise<Record<string, unknown>> {
    const send = async (): Promise<{ decoded: Record<string, unknown>; status: number }> => {
      const sealed = sealParams("GET", path, current.ssecurity, params, now().getTime());
      const url = new URL(path, HEALTH_ORIGIN);
      for (const [key, value] of Object.entries(sealed)) url.searchParams.set(key, value);
      const response = await request(url.toString(), {
        cookie: healthCookie(current),
        "user-agent": "marco-health/0.2",
      });
      if (response.status === 401) return { decoded: {}, status: 401 };
      if (response.status === 429) throw new ProbeFailure("rate_limited", 429);
      if (response.status >= 500) throw new ProbeFailure("upstream_5xx", response.status);
      if (response.status !== 200) throw new ProbeFailure("unknown", response.status);
      try {
        const decoded = asObject(openJson(current.ssecurity, sealed._nonce, response.body));
        return { decoded, status: 200 };
      } catch {
        throw new ProbeFailure("parse_error", 200);
      }
    };

    let result = await send();
    if (result.status === 401) {
      if (renewed) throw new ProbeFailure("auth_expired", 401);
      renewed = true;
      log("stack-x renewing session once");
      await establish(current, request);
      result = await send();
      if (result.status === 401) throw new ProbeFailure("auth_expired", 401);
    }
    const code = asCode(result.decoded.code);
    if (code === 70016) throw new ProbeFailure("pass_token_invalid", 200);
    if (code !== 0) throw new ProbeFailure("unknown", 200);
    return asObject(result.decoded.result ?? result.decoded);
  }
}

export function publicProbeView(result: LiveProbeResult): Record<string, unknown> {
  if (result.skipped) return { skipped: true, reason: result.reason };
  return {
    skipped: false,
    status: result.status,
    error_code: result.error_code,
    upstream_status: result.upstream_status,
    window: result.window,
    sync_run_id: result.sync_run_id,
    record_count: result.records.length,
  };
}

/** Exit status for pull:live. Absent credentials and failed pulls are both failures. */
export function livePullExitCode(result: LiveProbeResult): number {
  if (result.skipped) return 1;
  return result.status === "failed" ? 1 : 0;
}

/** Stdout summary. Adds error_code credentials_absent when the process must fail closed. */
export function livePullSummary(result: LiveProbeResult): Record<string, unknown> {
  const view = publicProbeView(result);
  if (result.skipped) return { ...view, error_code: "credentials_absent" };
  return view;
}

function healthCookie(session: Session): string {
  const pairs = [`userId=${session.userId}`, `serviceToken=${session.serviceToken}`];
  if (session.cUserId !== "") pairs.push(`cUserId=${session.cUserId}`);
  return pairs.join("; ");
}

function parseLogin(body: string): { code: number; securityStatus: number; nonce: string; ssecurity: string; location: string; cUserId: string } {
  const text = body.startsWith("&&&START&&&") ? body.slice("&&&START&&&".length) : body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProbeFailure("parse_error", 200);
  }
  const object = asObject(parsed);
  return {
    code: asCode(object.code),
    securityStatus: object.securityStatus === undefined ? 0 : asCode(object.securityStatus),
    nonce: typeof object.nonce === "string" ? object.nonce : "",
    ssecurity: typeof object.ssecurity === "string" ? object.ssecurity : "",
    location: typeof object.location === "string" ? object.location : "",
    cUserId: typeof object.cUserId === "string" ? object.cUserId : "",
  };
}

function cookieValue(headers: ProbeResponse["headers"], name: string): string {
  const raw = headers["set-cookie"] ?? headers["Set-Cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const cookie of list) {
    const pair = cookie.split(";", 1)[0] ?? "";
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return "";
}

function relativeUid(userId: string): number | string {
  if (/^\d+$/.test(userId) && userId.length < 16) return Number(userId);
  return userId;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asCode(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return -1;
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error ? String(error.name) : "";
  const code = "code" in error ? String(error.code) : "";
  return name === "TimeoutError" || name === "AbortError" || code === "ABORT_ERR" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT";
}
