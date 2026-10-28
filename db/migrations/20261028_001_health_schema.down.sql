-- FORGE-005 down · reverse of 20261028_001_health_schema.up.sql (v0.2 lock)

BEGIN;

DROP VIEW IF EXISTS v_ui_day;
DROP TABLE IF EXISTS sleep_stages;
DROP TABLE IF EXISTS sleep_sessions;
DROP TABLE IF EXISTS workouts;
DROP TABLE IF EXISTS samples;
DROP TABLE IF EXISTS daily_aggregates;
DROP TABLE IF EXISTS sync_runs;
DROP TABLE IF EXISTS devices;

COMMIT;
