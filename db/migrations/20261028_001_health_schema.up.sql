-- FORGE-005 · Marco健康管家 · PostgreSQL schema (PATH F · 栈 X)
-- Owner: BOT-066 Database Engineer
-- Aligned: FORGE-003-path-f-contract.md v0.2 (BOT-061)
-- Status: LOCKED for v0.2 — repo apply waits BOT-155 + marco-health
-- Engine: PostgreSQL 15+
-- Idempotency: UNIQUE (device_id, record_type, started_at)
-- Trade-off: typed UI columns + jsonb extras for X-field drift
--            (buys FORGE-002 reads; taxes ALTER on new metrics — cheaper than dual parsers)
-- Secrets: never store passToken / serviceToken / ssecurity in any table

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------- devices ----------
-- PATH F default source = mi_health (hlth.io.mi.com 栈 X). Not huami/Zepp 栈 H.
CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL CHECK (source IN ('mi_health', 'hyperos_sdk', 'manual_export')),
  external_id   text NOT NULL,                     -- vendor sid / account hash placeholder (no secrets)
  display_name  text,
  timezone      text NOT NULL DEFAULT 'Asia/Shanghai',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

COMMENT ON TABLE devices IS 'Wearable identity for PATH F (栈 X). Never store passToken/serviceToken/ssecurity.';
COMMENT ON COLUMN devices.source IS 'mi_health = 小米运动健康云; hyperos_sdk/manual_export = fallback paths only';
COMMENT ON COLUMN devices.external_id IS 'Upstream sid or stable account hash — not a credential';

-- ---------- sync_runs ----------
CREATE TABLE sync_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  rows_upserted int NOT NULL DEFAULT 0,
  error_code    text,  -- auth_expired|pass_token_invalid|upstream_5xx|upstream_timeout|parse_error|rate_limited|incomplete_page|unknown
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb  -- window/from/to, upstream_status; no secrets
);

CREATE INDEX sync_runs_device_started_idx
  ON sync_runs (device_id, started_at DESC);
-- Justification: UI "上次同步" + ops triage by device.

-- ---------- samples (hr_sample → record_type=heart_rate) ----------
CREATE TABLE samples (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  record_type   text NOT NULL,                     -- heart_rate | steps_minute | spo2 | stress | …
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  value_num     double precision,                  -- bpm for heart_rate
  unit          text,
  extras        jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_run_id   uuid REFERENCES sync_runs(id) ON DELETE SET NULL,
  observed_at   timestamptz,                       -- batch observed_at; newer wins on UPSERT
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, record_type, started_at)
);

CREATE INDEX samples_device_type_time_idx
  ON samples (device_id, record_type, started_at DESC);
-- Justification: HR sparkline / zone bucketing — range scans by type.

CREATE INDEX samples_extras_gin
  ON samples USING gin (extras jsonb_path_ops);
-- Justification: rare X-specific keys without new columns. Write tax on ingest only.

-- ---------- sleep_sessions + sleep_stages ----------
CREATE TABLE sleep_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  record_type   text NOT NULL DEFAULT 'sleep_session',
  started_at    timestamptz NOT NULL,              -- bedtime
  ended_at      timestamptz NOT NULL,              -- wake_up_time
  score         smallint CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  extras        jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_run_id   uuid REFERENCES sync_runs(id) ON DELETE SET NULL,
  observed_at   timestamptz,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, record_type, started_at),
  CHECK (ended_at > started_at)
);

CREATE INDEX sleep_sessions_device_started_idx
  ON sleep_sessions (device_id, started_at DESC);
-- Justification: last-night card + week sleep trend. Ownership day = wake date Asia/Shanghai (app layer).

CREATE TABLE sleep_stages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sleep_sessions(id) ON DELETE CASCADE,
  stage         text NOT NULL CHECK (stage IN ('deep', 'light', 'rem', 'awake')),
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz NOT NULL,
  CHECK (ended_at > started_at)
);

CREATE INDEX sleep_stages_session_idx
  ON sleep_stages (session_id, started_at);
-- Justification: stage bar for one night; cascade with session.

-- ---------- workouts ----------
CREATE TABLE workouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  record_type   text NOT NULL DEFAULT 'workout',
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  sport_type    text,
  title         text,
  vendor_sid    text,                              -- upstream sid; optional secondary key
  duration_sec  int CHECK (duration_sec IS NULL OR duration_sec >= 0),
  distance_m    double precision CHECK (distance_m IS NULL OR distance_m >= 0),
  active_kcal   double precision CHECK (active_kcal IS NULL OR active_kcal >= 0),
  avg_hr_bpm    double precision,
  max_hr_bpm    double precision,
  extras        jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_run_id   uuid REFERENCES sync_runs(id) ON DELETE SET NULL,
  observed_at   timestamptz,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, record_type, started_at)
);

CREATE INDEX workouts_device_started_idx
  ON workouts (device_id, started_at DESC);
-- Justification: workout list + calorie history for FORGE-002.

CREATE INDEX workouts_vendor_sid_idx
  ON workouts (device_id, vendor_sid)
  WHERE vendor_sid IS NOT NULL;
-- Justification: sid-stable upsert debug when started_at drifts.

-- ---------- daily_aggregates (daily_summary) ----------
-- rings.move ← active_kcal (calories.calories)
-- rings.exercise ← exercise_minutes (intensity.duration)
-- rings.stand ← stand_hours (valid_stand.count) — REAL source, not a missing-field proxy
CREATE TABLE daily_aggregates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  record_type       text NOT NULL DEFAULT 'daily_summary',
  started_at        timestamptz NOT NULL,          -- day 00:00:00+08:00 (idempotency)
  day_local         date NOT NULL,                 -- Asia/Shanghai calendar day
  steps             int,
  distance_m        double precision,
  floors            int,                           -- often null on 栈 X → UI hide
  active_kcal       double precision,              -- → rings.move
  exercise_minutes  int,                           -- → rings.exercise
  stand_hours       int CHECK (stand_hours IS NULL OR (stand_hours BETWEEN 0 AND 24)), -- → rings.stand
  resting_hr_bpm    int,
  hr_zone_minutes   jsonb,                         -- five-zone map from *_hr_zone_duration
  sleep_score       smallint CHECK (sleep_score IS NULL OR (sleep_score BETWEEN 0 AND 100)),
  sleep_hours       double precision,              -- optional derived; not required by v0.2 ingest
  extras            jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_run_id       uuid REFERENCES sync_runs(id) ON DELETE SET NULL,
  observed_at       timestamptz,
  ingested_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, record_type, started_at),
  UNIQUE (device_id, day_local)
);

COMMENT ON COLUMN daily_aggregates.stand_hours IS 'From valid_stand.count (栈 X). Not Apple Stand; not a steps-proxy.';
COMMENT ON COLUMN daily_aggregates.active_kcal IS 'From calories.calories — do NOT use steps.calories';
COMMENT ON COLUMN daily_aggregates.started_at IS 'Idempotency: local day start Asia/Shanghai as timestamptz';

CREATE INDEX daily_aggregates_device_day_idx
  ON daily_aggregates (device_id, day_local DESC);
-- Justification: week/month trends without re-aggregating samples.

-- ---------- read model for FORGE-002 ----------
CREATE OR REPLACE VIEW v_ui_day AS
SELECT
  d.id AS device_id,
  da.day_local,
  da.active_kcal AS move_kcal,
  da.exercise_minutes,
  da.stand_hours,
  da.steps,
  da.distance_m,
  da.floors,
  da.active_kcal,
  da.resting_hr_bpm,
  da.hr_zone_minutes,
  da.sleep_score,
  da.sleep_hours,
  da.extras
FROM daily_aggregates da
JOIN devices d ON d.id = da.device_id;

COMMIT;
