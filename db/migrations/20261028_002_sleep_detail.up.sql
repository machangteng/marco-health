-- FORGE-017 · sleep detail columns
-- Neon Free: nullable columns only. No new index. Idempotent ADD / CHECK.
-- Stage minutes are Xiaomi minutes. efficiency and avg_spo2 stay null when the payload omits them.

BEGIN;

ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS deep_min integer;
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS light_min integer;
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS rem_min integer;
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS awake_min integer;
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS awake_count integer;
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS efficiency smallint;
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS avg_hr_bpm smallint;
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS min_hr_bpm smallint;
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS max_hr_bpm smallint;
ALTER TABLE sleep_sessions ADD COLUMN IF NOT EXISTS avg_spo2 smallint;

ALTER TABLE sleep_sessions DROP CONSTRAINT IF EXISTS sleep_sessions_minutes_check;
ALTER TABLE sleep_sessions ADD CONSTRAINT sleep_sessions_minutes_check CHECK (
  (deep_min IS NULL OR deep_min >= 0)
  AND (light_min IS NULL OR light_min >= 0)
  AND (rem_min IS NULL OR rem_min >= 0)
  AND (awake_min IS NULL OR awake_min >= 0)
  AND (awake_count IS NULL OR awake_count >= 0)
);

ALTER TABLE sleep_sessions DROP CONSTRAINT IF EXISTS sleep_sessions_efficiency_check;
ALTER TABLE sleep_sessions ADD CONSTRAINT sleep_sessions_efficiency_check
  CHECK (efficiency IS NULL OR efficiency BETWEEN 0 AND 100);

ALTER TABLE sleep_sessions DROP CONSTRAINT IF EXISTS sleep_sessions_spo2_check;
ALTER TABLE sleep_sessions ADD CONSTRAINT sleep_sessions_spo2_check
  CHECK (avg_spo2 IS NULL OR avg_spo2 BETWEEN 0 AND 100);

ALTER TABLE sleep_sessions DROP CONSTRAINT IF EXISTS sleep_sessions_hr_check;
ALTER TABLE sleep_sessions ADD CONSTRAINT sleep_sessions_hr_check CHECK (
  (avg_hr_bpm IS NULL OR avg_hr_bpm BETWEEN 1 AND 250)
  AND (min_hr_bpm IS NULL OR min_hr_bpm BETWEEN 1 AND 250)
  AND (max_hr_bpm IS NULL OR max_hr_bpm BETWEEN 1 AND 250)
);

COMMIT;
