import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { maskSecrets, scrubSecrets } from "./mask.js";
import { normalizeDailyReports, normalizeHeartSamples } from "./pull/normalize.js";
import {
  accountExternalId,
  interRequestDelayMs,
  isStackXUrl,
  livePullExitCode,
  livePullSummary,
  publicProbeView,
  readXiaomiCredentials,
  runLiveProbe,
  type ProbeTransport,
} from "./pull/live-probe.js";
import {
  STACK_FIXTURE_PASS,
  STACK_FIXTURE_SERVICE,
  STACK_FIXTURE_SSECURITY,
  scriptedStackTransport as scriptedTransport,
  stackLoginResponse as loginResponse,
  stackPage as page,
} from "./pull/scripted-stack.js";
import { clientSign, sealParams, unsealData } from "./pull/xiaomi-crypto.js";
import { formatInShanghai, shanghaiDayStart } from "./time.js";
import { validateEnvelope, validateRecord } from "./ingest/validate.js";

const PASS = STACK_FIXTURE_PASS;
const SERVICE = STACK_FIXTURE_SERVICE;
const SSECURITY = STACK_FIXTURE_SSECURITY;
const NOW = new Date("2026-10-28T06:30:00+08:00");

test("Shanghai midnight formats with +08:00", () => {
  const instant = new Date("2026-10-27T00:00:00+08:00");
  assert.equal(formatInShanghai(instant), "2026-10-27T00:00:00+08:00");
  assert.equal(formatInShanghai(new Date("2026-10-26T16:00:00.000Z")), "2026-10-27T00:00:00+08:00");
  assert.equal(shanghaiDayStart("2026-10-27").getTime(), instant.getTime());
});

test("maskSecrets and scrubSecrets remove credential material", () => {
  const masked = maskSecrets(`passToken=${PASS}&ok=1`, [PASS]);
  assert.equal(masked.includes(PASS), false);
  assert.match(masked, /passToken=\[redacted\]/);
  const scrubbed = scrubSecrets({ status: "ok", passToken: PASS, nested: { serviceToken: SERVICE, note: "visible" } });
  assert.equal(JSON.stringify(scrubbed).includes(PASS), false);
  assert.equal(JSON.stringify(scrubbed).includes(SERVICE), false);
  assert.match(JSON.stringify(scrubbed), /visible/);
});

test("checked-in contract artifacts are schema 0.2 and carry no credentials", () => {
  const openapi = readFileSync(new URL("../openapi/ingest-v0.2.yaml", import.meta.url), "utf8");
  const fixture = readFileSync(new URL("../fixtures/mi_health/ingest-batch-0.2.json", import.meta.url), "utf8");
  assert.match(openapi, /version: 0\.2\.0/);
  assert.match(openapi, /hr_sample/);
  assert.match(openapi, /heart_rate/);
  assert.equal(JSON.parse(fixture).schema_version, "0.2");
  assert.equal(/passToken|serviceToken|ssecurity/i.test(fixture), false);
  const puller = readFileSync(new URL("./pull/live-probe.ts", import.meta.url), "utf8");
  assert.equal(puller.includes("huami"), false);
  assert.equal(puller.includes("api-mifit"), false);
  assert.match(puller, /hlth\.io\.mi\.com/);
  assert.match(puller, /sts-hlth\.io\.mi\.com/);
});

test("envelope and hr_sample validation", () => {
  const missing = validateRecord({ type: "hr_sample", bpm: 70 });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "missing_started_at");
  const badBpm = validateRecord({ type: "hr_sample", started_at: "2026-10-27T14:20:00+08:00", bpm: 10 });
  assert.equal(badBpm.ok, false);
  const unknownStage = validateRecord({
    type: "sleep_session",
    started_at: "2026-10-26T23:40:00+08:00",
    ended_at: "2026-10-27T07:05:00+08:00",
    stages: [{ stage: "unknown", started_at: "2026-10-26T23:40:00+08:00", ended_at: "2026-10-27T00:10:00+08:00" }],
  });
  assert.equal(unknownStage.ok, false);
  const day = validateRecord({
    type: "daily_summary",
    day: "2026-10-27",
    started_at: "2026-10-27T01:00:00+08:00",
    steps: 1,
  });
  assert.equal(day.ok, false);
  if (!day.ok) assert.equal(day.reason, "started_at_not_day_start");
  const envelope = validateEnvelope({ schema_version: "0.1", source: "mi_health", records: [{}] });
  assert.equal(envelope.ok, false);
  if (!envelope.ok) assert.equal(envelope.status, 400);
});

test("daily calories come from the calories key, not steps.calories", () => {
  const dayStart = Math.floor(new Date("2026-10-27T00:00:00+08:00").getTime() / 1000);
  const rows = normalizeDailyReports([
    { key: "steps", time: dayStart, value: JSON.stringify({ steps: 8432, distance: 5820.5, calories: 999 }) },
    { key: "calories", time: dayStart, value: JSON.stringify({ calories: 312 }) },
    { key: "intensity", time: dayStart, value: JSON.stringify({ duration: 28 }) },
    { key: "valid_stand", time: dayStart, value: JSON.stringify({ count: 10 }) },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.steps, 8432);
  assert.equal(rows[0]?.active_kcal, 312);
  assert.equal(rows[0]?.exercise_minutes, 28);
  assert.equal(rows[0]?.stand_hours, 10);
  assert.equal(rows[0]?.started_at, "2026-10-27T00:00:00+08:00");
  const samples = normalizeHeartSamples(
    [
      { key: "heart_rate", time: dayStart - 3600, value: JSON.stringify({ time: dayStart - 3600, bpm: 55 }) },
      { key: "heart_rate", time: dayStart + 3600, value: JSON.stringify({ time: dayStart + 3600, bpm: 76, type: "auto" }) },
    ],
    dayStart,
  );
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.bpm, 76);
  assert.equal(samples[0]?.type, "hr_sample");
  assert.equal(samples[0]?.sample_kind, "auto");
});

test("request gap stays between 1 and 2 seconds", () => {
  assert.equal(interRequestDelayMs(() => 0), 1000);
  assert.equal(interRequestDelayMs(() => 0.999999), 2000);
  for (let index = 0; index < 50; index += 1) {
    const gap = interRequestDelayMs(() => index / 50);
    assert.ok(gap >= 1000 && gap <= 2000);
  }
});

test("stack X URL allow-list rejects other health clouds", () => {
  assert.equal(isStackXUrl("https://hlth.io.mi.com/app/v1/data/get_fitness_data_by_time"), true);
  assert.equal(isStackXUrl("https://sts-hlth.io.mi.com/healthapp/sts"), true);
  assert.equal(isStackXUrl("https://account.xiaomi.com/pass/serviceLogin"), true);
  assert.equal(isStackXUrl("https://api-mifit.huami.com/v1/data/band_data.json"), false);
  assert.equal(isStackXUrl("https://api-mifit-cn.zepp.com/v1/data/band_data.json"), false);
  assert.equal(isStackXUrl("http://hlth.io.mi.com/app/v1/data/get_fitness_data_by_time"), false);
  assert.equal(isStackXUrl("https://user:secret@hlth.io.mi.com/app/v1/data/get_fitness_data_by_time"), false);
});

test("sealed health params round-trip and clientSign matches SHA1", () => {
  const sealed = sealParams("GET", "/app/v1/data/get_aggregated_fitness_data_by_time", SSECURITY, { key: "steps" }, NOW.getTime(), randomBytes(8));
  const opened = unsealData(SSECURITY, sealed._nonce, sealed.data ?? "");
  assert.deepEqual(opened, { key: "steps" });
  const expected = createHash("sha1").update(`nonce=nonce-fixture&${SSECURITY}`, "utf8").digest("base64");
  assert.equal(clientSign("nonce-fixture", SSECURITY), expected);
});

test("live probe skips when credentials are absent and does not call the network", async () => {
  let called = false;
  const transport: ProbeTransport = async () => {
    called = true;
    throw new Error("network");
  };
  const result = await runLiveProbe({
    env: { XIAOMI_USER_ID: "  ", XIAOMI_PASS_TOKEN: "" },
    transport,
    sleep: async () => {
      throw new Error("sleep");
    },
  });
  assert.deepEqual(result, { skipped: true, reason: "credentials_absent" });
  assert.equal(called, false);
  assert.equal(readXiaomiCredentials({}), null);
  assert.equal(publicProbeView(result).skipped, true);
  assert.equal(livePullExitCode(result), 1);
  assert.equal(livePullSummary(result).error_code, "credentials_absent");
});

test("live probe pulls a short window, spaces calls, and hides credentials", async () => {
  const gaps: number[] = [];
  const hosts: string[] = [];
  const logs: string[] = [];
  let healthCalls = 0;
  const transport = scriptedTransport({
    onHealth(url, params) {
      healthCalls += 1;
      const span = Number(params.end_time) - Number(params.start_time);
      assert.ok(span > 0 && span <= 3 * 86_400);
      if (params.key === "steps") {
        return page([{ key: "steps", time: params.start_time, value: JSON.stringify({ steps: 100, distance: 10, calories: 999 }) }]);
      }
      if (params.key === "calories") {
        return page([{ key: "calories", time: params.start_time, value: JSON.stringify({ calories: 312 }) }]);
      }
      return page([]);
    },
  });
  const result = await runLiveProbe({
    env: { XIAOMI_USER_ID: "10001", XIAOMI_PASS_TOKEN: PASS, XIAOMI_DEVICE_ID: "ABCDEF0123456789" },
    transport: async (request) => {
      const url = new URL(request.url);
      hosts.push(url.host);
      if (url.host === "hlth.io.mi.com" || url.host === "sts-hlth.io.mi.com") {
        const cookie = request.headers.cookie ?? "";
        assert.equal(cookie.includes(PASS), false);
        assert.match(cookie, /userId=/);
      }
      if (url.host === "hlth.io.mi.com") assert.match(request.headers.cookie ?? "", /serviceToken=/);
      if (url.host === "account.xiaomi.com") assert.match(request.headers.cookie ?? "", /passToken=/);
      return transport(request);
    },
    sleep: async (ms) => {
      gaps.push(ms);
    },
    now: () => NOW,
    random: () => 0,
    log: (line) => logs.push(line),
    dailyKeys: ["steps", "calories"],
    includeHeartSamples: false,
    includeSleep: false,
    includeSport: false,
  });
  assert.equal(result.skipped, false);
  if (result.skipped) return;
  assert.equal(result.status, "ok");
  assert.equal(result.error_code, null);
  assert.equal(result.window.from, "2026-10-27");
  assert.equal(result.window.to, "2026-10-28");
  assert.equal(healthCalls, 2);
  assert.deepEqual([...new Set(hosts)].sort(), ["account.xiaomi.com", "hlth.io.mi.com", "sts-hlth.io.mi.com"]);
  assert.ok(gaps.length >= 1);
  assert.ok(gaps.every((gap) => gap >= 1000 && gap <= 2000));
  const joined = logs.join("\n");
  assert.equal(joined.includes(PASS), false);
  assert.equal(joined.includes(SERVICE), false);
  assert.equal(joined.includes(SSECURITY), false);
  const daily = result.records.find((record) => record.type === "daily_summary");
  assert.ok(daily && daily.type === "daily_summary");
  assert.equal(daily.active_kcal, 312);
  assert.equal(daily.steps, 100);
  assert.equal(result.vendor_sid, accountExternalId("10001"));
  assert.equal(JSON.stringify(publicProbeView(result)).includes(PASS), false);
  assert.equal(livePullExitCode(result), 0);
});

test("live probe renews once on 401 and then stops", async () => {
  let logins = 0;
  let health = 0;
  const result = await runLiveProbe({
    env: { XIAOMI_USER_ID: "10001", XIAOMI_PASS_TOKEN: PASS },
    transport: scriptedTransport({
      onLogin() {
        logins += 1;
        return loginResponse();
      },
      onHealth() {
        health += 1;
        return { status: 401, headers: {}, body: "" };
      },
    }),
    sleep: async () => undefined,
    now: () => NOW,
    random: () => 0,
    dailyKeys: ["steps"],
    includeHeartSamples: false,
    includeSleep: false,
    includeSport: false,
  });
  assert.equal(result.skipped, false);
  if (result.skipped) return;
  assert.equal(result.error_code, "auth_expired");
  assert.equal(result.records.length, 0);
  assert.equal(logins, 2);
  assert.equal(health, 2);
  assert.equal(livePullExitCode(result), 1);
  assert.equal(livePullSummary(result).error_code, "auth_expired");
});

test("live probe maps passToken refusal and does not follow a non-stack-X location", async () => {
  const refused = await runLiveProbe({
    env: { XIAOMI_USER_ID: "10001", XIAOMI_PASS_TOKEN: PASS },
    transport: scriptedTransport({
      onLogin: () => loginResponse(70016),
    }),
    sleep: async () => undefined,
    dailyKeys: ["steps"],
    includeHeartSamples: false,
    includeSleep: false,
    includeSport: false,
  });
  assert.equal(refused.skipped, false);
  if (!refused.skipped) assert.equal(refused.error_code, "pass_token_invalid");

  let leftStack = false;
  const wrongHost = await runLiveProbe({
    env: { XIAOMI_USER_ID: "10001", XIAOMI_PASS_TOKEN: PASS },
    transport: async (request) => {
      const host = new URL(request.url).host;
      if (host.includes("huami") || host.includes("mifit") || host.includes("zepp")) leftStack = true;
      if (host === "account.xiaomi.com") {
        return loginResponse(0, "https://api-mifit.huami.com/v1/data/band_data.json");
      }
      throw new Error(`unexpected host ${host}`);
    },
    sleep: async () => undefined,
    dailyKeys: ["steps"],
    includeHeartSamples: false,
    includeSleep: false,
    includeSport: false,
  });
  assert.equal(leftStack, false);
  assert.equal(wrongHost.skipped, false);
  if (!wrongHost.skipped) assert.equal(wrongHost.error_code, "unknown");
});

test("live probe classifies upstream failures", async () => {
  const cases: Array<{ status?: number; throwName?: string; code: string }> = [
    { status: 503, code: "upstream_5xx" },
    { status: 429, code: "rate_limited" },
    { throwName: "TimeoutError", code: "upstream_timeout" },
    { status: 200, code: "parse_error" },
  ];
  for (const item of cases) {
    const result = await runLiveProbe({
      env: { XIAOMI_USER_ID: "10001", XIAOMI_PASS_TOKEN: PASS },
      transport: scriptedTransport({
        onHealth() {
          if (item.throwName) {
            const error = new Error("slow");
            error.name = item.throwName;
            throw error;
          }
          if (item.code === "parse_error") return { status: 200, headers: {}, body: "not-a-payload" };
          return { status: item.status ?? 500, headers: {}, body: "" };
        },
      }),
      sleep: async () => undefined,
      now: () => NOW,
      dailyKeys: ["steps"],
      includeHeartSamples: false,
      includeSleep: false,
      includeSport: false,
    });
    assert.equal(result.skipped, false);
    if (!result.skipped) assert.equal(result.error_code, item.code);
  }

  const incomplete = await runLiveProbe({
    env: { XIAOMI_USER_ID: "10001", XIAOMI_PASS_TOKEN: PASS },
    transport: scriptedTransport({
      onHealth: () => ({
        status: 200,
        headers: {},
        body: "",
        plain: { code: 0, result: { data_list: [], has_more: true, next_key: "" } },
      }),
    }),
    sleep: async () => undefined,
    now: () => NOW,
    dailyKeys: ["steps"],
    includeHeartSamples: false,
    includeSleep: false,
    includeSport: false,
  });
  assert.equal(incomplete.skipped, false);
  if (!incomplete.skipped) {
    assert.equal(incomplete.error_code, "incomplete_page");
    assert.equal(incomplete.records.length, 0);
  }
});

test("daily workflow names Actions secrets and does not load fixtures", () => {
  const workflow = readFileSync(new URL("../.github/workflows/daily-live-pull.yml", import.meta.url), "utf8");
  const cli = readFileSync(new URL("./cli/pull-probe.ts", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cron:\s*"30 22 \* \* \*"/);
  assert.match(workflow, /npm run pull:live/);
  assert.equal(workflow.includes("pull:mock"), false);
  assert.equal(workflow.includes("fixtures/"), false);
  assert.equal(workflow.includes("postgres://"), false);
  for (const name of ["DATABASE_URL", "XIAOMI_USER_ID", "XIAOMI_PASS_TOKEN", "XIAOMI_DEVICE_ID"]) {
    assert.match(workflow, new RegExp(`secrets\\.${name}`));
  }
  assert.equal(cli.includes("runMockPull"), false);
  assert.equal(cli.includes("fixtures/mi_health"), false);
  assert.match(cli, /credentials_absent/);
});
