export type DailySummaryRecord = {
  type: "daily_summary";
  day: string;
  started_at: string;
  steps: number | null;
  distance_m: number | null;
  floors: number | null;
  active_kcal: number | null;
  exercise_minutes: number | null;
  stand_hours: number | null;
  resting_hr_bpm: number | null;
  hr_zone_minutes: Record<string, number> | null;
  sleep_score: number | null;
};

/** Wire name stays hr_sample. The database record_type is heart_rate. */
export type HrSampleRecord = {
  type: "hr_sample";
  started_at: string;
  bpm: number;
  end_at: string | null;
  sample_kind: string | null;
};

export type SleepStageRecord = {
  stage: "deep" | "light" | "rem" | "awake";
  started_at: string;
  ended_at: string;
};

export type SleepSessionRecord = {
  type: "sleep_session";
  started_at: string;
  ended_at: string;
  score: number | null;
  /** null when the payload omitted stages; an array replaces stored stages. */
  stages: SleepStageRecord[] | null;
  /** Stage totals in minutes. Null when that Xiaomi field was absent. */
  deep_min: number | null;
  light_min: number | null;
  rem_min: number | null;
  awake_min: number | null;
  awake_count: number | null;
  /** sleep_efficiency when the row includes it. Known captures omit it. */
  efficiency: number | null;
  avg_hr_bpm: number | null;
  min_hr_bpm: number | null;
  max_hr_bpm: number | null;
  avg_spo2: number | null;
};

export type WorkoutRecord = {
  type: "workout";
  started_at: string;
  ended_at: string;
  sport_type: string | null;
  sport_type_label: string | null;
  duration_sec: number | null;
  distance_m: number | null;
  active_kcal: number | null;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
  vendor_sid: string | null;
};

export type IngestRecord = DailySummaryRecord | HrSampleRecord | SleepSessionRecord | WorkoutRecord;

export type IngestEnvelope = {
  schema_version: "0.2";
  source: "mi_health";
  device_id: string | null;
  vendor_sid: string | null;
  sync_run_id: string;
  observed_at: string;
  records: unknown[];
};

export type ItemReject = {
  index: number;
  reason: string;
};

export type IngestBatchResponse = {
  sync_run_id: string;
  accepted: number;
  upserted: number;
  unchanged: number;
  rejected: ItemReject[];
};

export type ErrorBody = {
  error: string;
  detail: string;
};
