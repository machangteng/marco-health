import type { ProbeResponse, ProbeTransport } from "./live-probe.js";
import { sealJson, unsealData } from "./xiaomi-crypto.js";

/** Synthetic stand-in values. They are not vault credentials. */
export const STACK_FIXTURE_PASS = "fixture-only-pass-value";
export const STACK_FIXTURE_SERVICE = "svc-fixture-value";
export const STACK_FIXTURE_SSECURITY = Buffer.from("0123456789abcdef").toString("base64");

const LOGIN_LOCATION = "https://sts-hlth.io.mi.com/healthapp/sts?sid=miothealth";

type HealthOverride = ProbeResponse & { plain?: unknown };

type HealthHandler = (url: string, params: Record<string, unknown>) => ProbeResponse | HealthOverride;

/**
 * In-process account.xiaomi.com + STS + hlth.io.mi.com.
 * Tests pass this as transport so CI never opens a socket to Xiaomi.
 */
export function scriptedStackTransport(handlers: {
  onLogin?: () => ProbeResponse;
  onHealth?: HealthHandler;
}): ProbeTransport {
  return async (request) => {
    const url = new URL(request.url);
    if (url.host === "account.xiaomi.com") return (handlers.onLogin ?? (() => stackLoginResponse()))();
    if (url.host === "sts-hlth.io.mi.com") {
      return {
        status: 200,
        headers: { "set-cookie": [`serviceToken=${STACK_FIXTURE_SERVICE}; Path=/`] },
        body: "ok",
      };
    }
    if (url.host !== "hlth.io.mi.com") throw new Error(`blocked host ${url.host}`);
    const nonce = url.searchParams.get("_nonce");
    const data = url.searchParams.get("data");
    if (!nonce || !data) throw new Error("health request was not sealed");
    const params = unsealData(STACK_FIXTURE_SSECURITY, nonce, data) as Record<string, unknown>;
    const produced = (handlers.onHealth ?? (() => stackPage([])))(request.url, params);
    if ("plain" in produced && produced.plain !== undefined) {
      return {
        status: produced.status,
        headers: produced.headers,
        body: sealJson(STACK_FIXTURE_SSECURITY, nonce, produced.plain),
      };
    }
    return produced;
  };
}

export function stackLoginResponse(code = 0, location = LOGIN_LOCATION): ProbeResponse {
  return {
    status: 200,
    headers: {},
    body:
      "&&&START&&&" +
      JSON.stringify({
        code,
        nonce: "nonce-fixture",
        ssecurity: STACK_FIXTURE_SSECURITY,
        location,
        cUserId: "c-fixture",
        securityStatus: 0,
      }),
  };
}

export function stackPage(rows: unknown[]): HealthOverride {
  return {
    status: 200,
    headers: {},
    body: "",
    plain: { code: 0, result: { data_list: rows, sport_records: rows, has_more: false } },
  };
}
