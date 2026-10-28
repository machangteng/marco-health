import assert from "node:assert/strict";
import test from "node:test";
import { PROBE_DAILY_KEYS, PROBE_WINDOW_DAYS } from "./pull/live-probe.js";
import {
  mergeSleepSessions,
  normalizeAggregatedSleepSessions,
  normalizeDailyReports,
  normalizeSleepSessions,
} from "./pull/normalize.js";

const BED = 1_662_995_880;
const WAKE = 1_663_022_040;

test("raw Xiaomi sleep items use numeric state and do not invent score, REM, SpO2, or efficiency", () => {
  const sessions = normalizeSleepSessions([
    {
      key: "sleep",
      time: WAKE,
      value: JSON.stringify({
        bedtime: BED,
        wake_up_time: WAKE,
        device_bedtime: BED,
        device_wake_up_time: WAKE,
        duration: 435,
        sleep_deep_duration: 110,
        sleep_light_duration: 325,
        sleep_awake_duration: 1,
        awake_count: 1,
        avg_hr: 68,
        min_hr: 57,
        max_hr: 79,
        sleep_score: 0,
        items: [
          { start_time: BED, end_time: BED + 3600, state: 3 },
          { start_time: BED + 3600, end_time: BED + 7200, state: 2 },
          { start_time: BED + 7200, end_time: BED + 7260, state: 5 },
          { start_time: BED + 7260, end_time: BED + 9000, state: 4 },
          { start_time: BED + 9000, end_time: BED + 9060, state: 1 },
          { start_time: BED + 9060, end_time: WAKE, state: 6 },
        ],
      }),
    },
  ]);
  assert.equal(sessions.length, 1);
  const session = sessions[0];
  assert.ok(session);
  assert.deepEqual(
    session.stages?.map((stage) => stage.stage),
    ["light", "deep", "awake", "rem"],
  );
  assert.equal(session.deep_min, 110);
  assert.equal(session.light_min, 325);
  assert.equal(session.awake_min, 1);
  assert.equal(session.rem_min, null);
  assert.equal(session.awake_count, 1);
  assert.equal(session.avg_hr_bpm, 68);
  assert.equal(session.min_hr_bpm, 57);
  assert.equal(session.max_hr_bpm, 79);
  assert.equal(session.score, null);
  assert.equal(session.efficiency, null);
  assert.equal(session.avg_spo2, null);
  assert.equal(session.stages?.[0]?.started_at.endsWith("+08:00"), true);
});

test("named stage items still map, and segment_details is not read as a timeline", () => {
  const sessions = normalizeSleepSessions([
    {
      key: "sleep",
      value: {
        bedtime: BED,
        wake_up_time: WAKE,
        sleep_score: 82,
        segment_details: [{ bedtime: BED, wake_up_time: WAKE, sleep_deep_duration: 10 }],
        items: [{ stage: "deep", start_time: BED, end_time: BED + 600 }],
      },
    },
  ]);
  assert.equal(sessions[0]?.score, 82);
  assert.equal(sessions[0]?.stages?.length, 1);
  assert.equal(sessions[0]?.stages?.[0]?.stage, "deep");
  assert.equal(sessions[0]?.deep_min, null);
});

test("aggregated daily sleep supplies score, REM, and SpO2 without inventing a timeline", () => {
  const row = {
    key: "sleep",
    time: WAKE,
    value: JSON.stringify({
      total_duration: 435,
      sleep_score: 86,
      sleep_deep_duration: 110,
      sleep_light_duration: 240,
      sleep_rem_duration: 80,
      sleep_awake_duration: 5,
      sleep_stage: 4,
      avg_hr: 56,
      min_hr: 48,
      max_hr: 72,
      avg_spo2: 97,
      segment_details: [
        {
          bedtime: BED,
          wake_up_time: WAKE,
          duration: 400,
          sleep_deep_duration: 100,
          sleep_light_duration: 220,
          sleep_awake_duration: 4,
          awake_count: 2,
        },
        {
          bedtime: WAKE + 3600,
          wake_up_time: WAKE + 5400,
          duration: 30,
          sleep_light_duration: 30,
        },
      ],
    }),
  };
  const daily = normalizeDailyReports([row]);
  assert.equal(daily[0]?.sleep_score, 86);
  const sessions = normalizeAggregatedSleepSessions([row]);
  assert.equal(sessions.length, 2);
  const night = sessions.find((session) => session.deep_min === 100);
  const nap = sessions.find((session) => session.deep_min !== 100);
  assert.ok(night);
  assert.ok(nap);
  assert.equal(night.stages, null);
  assert.equal(night.score, 86);
  assert.equal(night.rem_min, 80);
  assert.equal(night.avg_spo2, 97);
  assert.equal(night.avg_hr_bpm, 56);
  assert.equal(night.min_hr_bpm, 48);
  assert.equal(night.max_hr_bpm, 72);
  assert.equal(night.awake_count, 2);
  assert.equal(night.light_min, 220);
  assert.equal(night.awake_min, 4);
  assert.equal(night.efficiency, null);
  assert.equal(nap.score, null);
  assert.equal(nap.rem_min, null);
  assert.equal(nap.avg_spo2, null);
  assert.equal(nap.stages, null);
});

test("merge keeps the raw timeline and fills score, REM, and SpO2 from the daily row", () => {
  const raw = normalizeSleepSessions([
    {
      key: "sleep",
      value: {
        bedtime: BED,
        wake_up_time: WAKE,
        sleep_deep_duration: 110,
        sleep_light_duration: 325,
        sleep_awake_duration: 1,
        awake_count: 1,
        avg_hr: 68,
        min_hr: 57,
        max_hr: 79,
        items: [{ state: 2, start_time: BED, end_time: BED + 600 }],
      },
    },
  ]);
  const aggregated = normalizeAggregatedSleepSessions([
    {
      key: "sleep",
      value: {
        sleep_score: 86,
        sleep_rem_duration: 80,
        avg_spo2: 97,
        avg_hr: 56,
        segment_details: [{ bedtime: BED, wake_up_time: WAKE, sleep_deep_duration: 110, awake_count: 3 }],
      },
    },
  ]);
  const merged = mergeSleepSessions(raw, aggregated);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.stages?.[0]?.stage, "deep");
  assert.equal(merged[0]?.score, 86);
  assert.equal(merged[0]?.rem_min, 80);
  assert.equal(merged[0]?.avg_spo2, 97);
  assert.equal(merged[0]?.avg_hr_bpm, 68);
  assert.equal(merged[0]?.min_hr_bpm, 57);
  assert.equal(merged[0]?.awake_count, 1);
  assert.equal(merged[0]?.deep_min, 110);
  assert.equal(merged[0]?.efficiency, null);
});

test("sleep_efficiency maps only when Xiaomi sent it", () => {
  const present = normalizeSleepSessions([
    { value: { bedtime: BED, wake_up_time: WAKE, sleep_efficiency: 91 } },
  ]);
  assert.equal(present[0]?.efficiency, 91);
  assert.equal(present[0]?.stages, null);
  const absent = normalizeSleepSessions([{ value: { bedtime: BED, wake_up_time: WAKE, sleep_efficiency: 0 } }]);
  assert.equal(absent[0]?.efficiency, null);
});

test("the sleep daily key stays inside the existing seven-day window", () => {
  assert.equal(PROBE_WINDOW_DAYS, 7);
  assert.deepEqual(
    [...PROBE_DAILY_KEYS],
    ["steps", "calories", "intensity", "valid_stand", "heart_rate", "sleep"],
  );
});
