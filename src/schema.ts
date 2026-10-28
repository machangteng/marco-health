/** Relations created by the locked FORGE-005 migration. */
export const EXPECTED_RELATIONS = [
  "devices",
  "sync_runs",
  "samples",
  "sleep_sessions",
  "sleep_stages",
  "workouts",
  "daily_aggregates",
  "v_ui_day",
] as const;

/** Columns the health check requires, aligned with contract v0.2. */
export const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  devices: ["id", "source", "external_id", "timezone"],
  sync_runs: ["device_id", "status", "error_code", "rows_upserted", "meta"],
  samples: ["device_id", "record_type", "started_at", "value_num", "extras"],
  sleep_sessions: ["device_id", "record_type", "started_at", "ended_at", "score"],
  sleep_stages: ["session_id", "stage", "started_at", "ended_at"],
  workouts: ["device_id", "record_type", "started_at", "vendor_sid", "active_kcal", "avg_hr_bpm"],
  daily_aggregates: [
    "device_id",
    "record_type",
    "started_at",
    "day_local",
    "steps",
    "active_kcal",
    "exercise_minutes",
    "stand_hours",
    "hr_zone_minutes",
  ],
  v_ui_day: ["device_id", "day_local", "move_kcal", "exercise_minutes", "stand_hours"],
};

/** devices.source allow-list from the locked CHECK constraint. 栈 X value is mi_health. */
export const EXPECTED_DEVICE_SOURCES = ["mi_health", "hyperos_sdk", "manual_export"] as const;

/** SHA-256 of the locked migration files. Tests fail if those bytes change. */
export const LOCKED_MIGRATION_SHA256 = {
  up: "f1d6a47900153e65efe333677c3c229a0223cb9e694b60cc085f5e70b1ef6f33",
  down: "0327fe3bec25d83e73201a0af0e5fff93df5efed843154fe1d1eccc9fd7ee653",
} as const;
