-- FORGE-017 down · drop sleep detail columns

BEGIN;

ALTER TABLE sleep_sessions DROP CONSTRAINT IF EXISTS sleep_sessions_hr_check;
ALTER TABLE sleep_sessions DROP CONSTRAINT IF EXISTS sleep_sessions_spo2_check;
ALTER TABLE sleep_sessions DROP CONSTRAINT IF EXISTS sleep_sessions_efficiency_check;
ALTER TABLE sleep_sessions DROP CONSTRAINT IF EXISTS sleep_sessions_minutes_check;

ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS avg_spo2;
ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS max_hr_bpm;
ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS min_hr_bpm;
ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS avg_hr_bpm;
ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS efficiency;
ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS awake_count;
ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS awake_min;
ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS rem_min;
ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS light_min;
ALTER TABLE sleep_sessions DROP COLUMN IF EXISTS deep_min;

COMMIT;
