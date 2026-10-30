# marco-health

Marco健康管家 for 栈 X (`mi_health`, hlth.io.mi.com). The database is the locked FORGE-005 schema. `devices.source` is `mi_health`.

The same Node process checks Postgres, accepts ingest batches, serves the FORGE-002 phone UI from `web/`, and answers the read API those screens use.

## Stack

Node.js (TypeScript) and Postgres 16 via Docker Compose.

Node fits HTTP ingest and the read API in one typed service, and Postgres 16 satisfies the schema's PostgreSQL 15+ requirement. Docker Compose is the local database so the schema can be applied the same way on a clean machine.

## Prerequisites

- Node.js 20 or newer
- Docker with Compose v2

## Local database

```bash
cp .env.example .env
docker compose up -d --wait
npm install
npm run migrate
npm run health
```

`.env.example` sets `DATABASE_URL` to the Compose database:

`postgres://marco:marco@localhost:5432/marco_health`

The Compose password is a local development default.

`npm run migrate` and `npm run health` retry the connection for about 30 seconds. `npm run health` prints a JSON report and exits 0 when the database accepts queries and the locked relations are present (`schemaReady: true`). That includes `devices.source` values `mi_health`, `hyperos_sdk`, and `manual_export`.

Business dates use `Asia/Shanghai`. `devices.timezone` defaults to that zone. Ingested rows are idempotent on `UNIQUE (device_id, record_type, started_at)`.

## App

```bash
npm run dev
```

Open http://127.0.0.1:3000/ for the phone UI (今日 / 趋势 / 我的).

- `GET /` — `web/index.html`
- `GET /v1` — service route list
- `GET /health` — live database check (`200` when Postgres answers, `503` when it does not)

`schemaReady` on that payload is true after `npm run migrate`.

- `POST /v1/ingest/batch` — schema 0.2 upsert. One bad record is rejected; the rest of the batch is kept.
- `GET /v1/sync/runs/{sync_run_id}` — run status. The payload has no credentials.
- `GET /v1/read/today`, `/v1/read/heart-rate`, `/v1/read/sleep`, `/v1/read/workouts`, `/v1/read/trends` — see Read API below.

Wire name `hr_sample` is stored as `samples.record_type = heart_rate`. Idempotency is `UNIQUE (device_id, record_type, started_at)`. A newer `observed_at` overwrites. Day boundaries are `Asia/Shanghai`, and timestamps are stored with `+08:00`.

```bash
npm run build
npm start
```

`PORT` defaults to `3000`. Export `PORT` in the shell when you need another port. `npm start` reads `PORT` when a host sets it. See [Deploy](#deploy).

## Read API

Day keys are `YYYY-MM-DD` in **Asia/Shanghai**. Without `day`, `/today`, `/heart-rate`, `/sleep`, and `/workouts` default to yesterday (the most recent complete day); explicit `day` is unchanged. Trends still default to today. `is_complete_day` indicates that the returned `day` has ended in Shanghai, not that upstream data is guaranteed complete. The overview title uses the returned `day`, e.g. 昨天 10/29 or 今天 10/30. Optional `device_id` (uuid) limits the query to one device. Omit it and the latest `daily_aggregates` row in the window is used.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/v1/read/today?day=` | Rings, steps, `distance_m`, `floors`, `resting_hr_bpm`, `sleep_score`, `hr_zone_minutes`, `heart_rate` samples, `steps_minute` samples, sleep session + stages, recent workouts |
| GET | `/v1/read/heart-rate?day=` | `heart_rate` samples for that Shanghai day |
| GET | `/v1/read/sleep?day=` | Session whose wake instant falls on that day, plus stages |
| GET | `/v1/read/workouts?day=` | Up to 8 workouts that started before the next Shanghai midnight |
| GET | `/v1/read/trends?range=week\|month&day=` | Week: Monday–Sunday. Month: week buckets inside the calendar month |

Every read object includes **`source`**:

- `"db"` — the window had `daily_aggregates` rows. Numbers come from those columns and the related tables.
- `"fixture"` — the window had no `daily_aggregates` rows. The payload is derived from `fixtures/mi_health/ingest-batch-0.2.json` so the UI still renders. There is no second copy of the numbers under `fixtures/ui/`.

On a fixture today response, `day` is the fixture `daily_summary` day and `requested_day` is what the client asked for. Trend fixture responses keep the requested window and fill only the fixture day when it falls inside that window.

### Rings

These names are the `daily_aggregates` columns. The UI does not rename them.

| Ring | Field |
| --- | --- |
| move | `active_kcal` |
| exercise | `exercise_minutes` |
| stand | `stand_hours` |

`heart_rate` points are `samples` rows with `record_type = heart_rate`. `bpm` repeats `value_num`. Workout `title` is also returned as `sport_type_label` (the ingest wire name). Goals (650 kcal / 30 min / 12 h / 10,000 steps) live in the UI only.

### Sleep

`sleep` on `/v1/read/today` and `/v1/read/sleep` is the longest session whose wake instant falls on the explicit Shanghai day. Without `day`, sleep instead uses today as the wake day, preserving 昨晚 while the overview uses yesterday. A missing latest-night score does not fall back to yesterday’s daily score. Fixture fallback remains a labeled fixture replay. `source` stays `"db"` when the day has a `daily_aggregates` row.

| Field | Xiaomi source | Unit |
| --- | --- | --- |
| `started_at` / `ended_at` | `bedtime` / `wake_up_time` (raw row, or `device_bedtime` / `device_wake_up_time`) | timestamp |
| `stages[]` | raw `items[]` with `start_time`, `end_time`, and `state` | `2` deep, `3` light, `4` REM, `5` awake. Named `deep\|light\|rem\|awake` still accepted |
| `deep_min` `light_min` `rem_min` `awake_min` | `sleep_deep_duration`, `sleep_light_duration`, `sleep_rem_duration`, `sleep_awake_duration` | minutes. Derived from `stages` only when the column is null and a timeline exists |
| `score` | raw `sleep_score` when it is 1–100, otherwise the aggregated daily `sleep` row | 0 is an empty placeholder and stays null |
| `awake_count` | `awake_count` | count, including 0 |
| `avg_hr_bpm` `min_hr_bpm` `max_hr_bpm` | `avg_hr` `min_hr` `max_hr` on the raw row, filled from the daily row when the raw row omitted them | bpm |
| `avg_spo2` | aggregated daily `sleep.avg_spo2` | percent, 1–100 |
| `efficiency` | `sleep_efficiency` only when that key is present | percent. Captured `sleep` payloads do not include it, so the card hides it |

The daily pull asks for aggregated key `sleep` inside the existing window. That row's `segment_details` are sessions, not a stage timeline. Numeric `sleep_stage` on the daily row is a grade, not stages. The card draws a timeline when `stages` is non-empty, otherwise a stacked bar from the minute totals. It omits the bar when both are missing.

Not on these payloads: breathing rate, and a nap-versus-main flag. `watch_daytime_sleep` is not requested — an unknown key fails the whole pull. A shorter session the same day is stored, and the read picks the longest one.

## Migrations

SQL lives in `db/migrations/` and is applied in filename order by `npm run migrate`. The runner records versions in `schema_migrations`. That bookkeeping table is separate from the health schema.

| Command | Effect |
| --- | --- |
| `npm run migrate` | Apply pending `*.up.sql` files |
| `npm run migrate:status` | Show applied and pending versions |
| `npm run migrate:down` | Roll back the latest applied version |

`migrate:down` drops the health tables for that version. Use it on a local database you can recreate.

The `20261028_001_health_schema` files are the locked FORGE-005 schema. Add a new pair of `*.up.sql` / `*.down.sql` files for later changes.

Relations: `devices`, `sync_runs`, `samples`, `sleep_sessions`, `sleep_stages`, `workouts`, `daily_aggregates`, and view `v_ui_day`.

Recreate an empty database volume:

```bash
docker compose down -v
docker compose up -d --wait
npm run migrate
```

## Ingest

The contract is `docs/FORGE-003-path-f-contract.md` (v0.2). The HTTP shape is `openapi/ingest-v0.2.yaml`. A synthetic batch lives at `fixtures/mi_health/ingest-batch-0.2.json`.

```bash
npm run pull:mock
```

That reads `fixtures/mi_health/` and upserts through the same path as `POST /v1/ingest/batch`. It does not call Xiaomi.

```bash
npm run pull:live
```

`npm run pull:probe` is the same program. It calls `account.xiaomi.com` (pass token exchange), `sts-hlth.io.mi.com`, and `hlth.io.mi.com` only. It does not call Huami or `api-mifit`. See [Daily live pull](#daily-live-pull).

## Layout

```
docker-compose.yml    Postgres 16
db/migrations/         locked up/down SQL
openapi/               ingest OpenAPI 0.2
fixtures/mi_health/    mock puller batches and the UI fixture fallback
docs/                  path F contract v0.2
web/                   FORGE-002 phone UI
src/index.ts           HTTP server
src/health.ts          database health check
src/migrate.ts         migration runner
src/ingest/            batch upsert
src/read/              today and trend reads
src/pull/              mock puller and stack X live pull
src/verify/            Shanghai-day check after the live pull
.github/workflows/     daily live pull (schedule + workflow_dispatch)
.env.example           DATABASE_URL and blank Xiaomi placeholders
```

## Daily live pull

`npm run pull:live` reads runtime credentials, pulls the past **7 Asia/Shanghai calendar days** (inclusive, ending today) from stack X, and upserts through the same path as `POST /v1/ingest/batch`. The window was 2 days. At the scheduled 06:30 Shanghai run, the end timestamp is the run instant, after yesterday’s 24:00+08:00, so yesterday is fully re-fetched and newer values replace partial daily rows through the existing idempotent upsert. Heart-rate and sleep queries still start one calendar day before the window; samples before the window start are dropped. Ring fields stay `active_kcal`, `exercise_minutes`, and `stand_hours`.

`XIAOMI_PULL_WINDOW_DAYS` overrides that width in the process environment. The default is 7. A value above 7 is clamped to 7, so the daily job does not become a multi-week archive. It is not a credential, it is not loaded from `.env`, and it is not set on Render.

Requests wait 1–2 seconds with jitter. A health-host HTTP 401 refreshes the STS session once. A second 401 stops with `auth_expired` and does not retry. `passToken` code `70016` stops with `pass_token_invalid`.

Each list stops at a fixed page cap. Daily keys use `limit` equal to the window length and at most 4 pages. Heart rate uses `limit` 1000 and at most 12 pages (12,000 points, about one sample a minute across the window plus the one-day pad). Sleep uses `limit` 40 and at most 2 pages. Sport keeps `limit` 50 and at most 3 pages. When `has_more` is still true at that cap, status is `partial`. Rows already fetched are still upserted. The puller does not keep paging.

A failure inside `serviceLogin` or the STS call that follows it adds six fields to the JSON summary and to the Actions line `live pull failed: …`: `login_code`, `security_status`, `has_ssecurity`, `has_nonce`, `has_location`, and `has_service_token`. These are a code, a status, and booleans. The summary does not include `passToken`, `ssecurity`, `nonce`, the `location` URL, `serviceToken`, or cookies.

`login_code` is the numeric login `code`, or `null` when that field is missing. `70016` remains `pass_token_invalid`. `security_status` is Xiaomi `securityStatus`. A value other than `0` is `auth_expired` and means the account needs phone confirmation (安全验证). `null` means the field was absent; the puller still treats that as `0`. `has_ssecurity` and `has_location` are false when that login field is missing or empty, which is `auth_expired`. The signing nonce is the JSON `nonce` when that value is a non-empty string or an integer (digits are kept exact past 2^53). When the JSON field is missing or empty, the same key is read from the `Extension-Pragma` response header. `has_nonce` is false when both are empty, which is also `auth_expired`. The header value is not written to the summary or the log. `has_service_token` is true only when the STS response included a `serviceToken` cookie. It stays false when STS was not called or the cookie was absent. A later health-host 401, after login and STS succeeded, is still `auth_expired` and does not add these fields.

Missing `XIAOMI_USER_ID` or `XIAOMI_PASS_TOKEN` prints `error_code` `credentials_absent` and exits 1. That path does not call Xiaomi and does not write the database. A failed pull can record `sync_runs` and does not replace `daily_aggregates` with fixture rows. The command never runs `npm run pull:mock`.

After a successful ingest, `GET /v1/read/today?day=YYYY-MM-DD` for a Shanghai day in that window returns `source` `"db"` where Xiaomi had a daily row. `GET /v1/read/trends?range=week` reads those same `daily_aggregates` rows.

### GitHub Actions

`.github/workflows/daily-live-pull.yml` runs `npm run migrate`, then `npm run pull:live`, then `npm run verify:live`, on a schedule and on `workflow_dispatch`. The cron is `30 22 * * *` UTC, which is 06:30 Asia/Shanghai. A failing step stops the job, so a failed migrate does not start the pull, and a failed pull does not start the verify. The workflow does not run `npm run pull:mock` and does not load `fixtures/mi_health/`.

`npm run migrate` is idempotent. Applied versions are stored in `schema_migrations`. A second run on a database that already has the locked schema prints `schema up to date` and changes nothing.

`npm run verify:live` queries Postgres with the `DATABASE_URL` secret. It counts `daily_aggregates` rows (`record_type = daily_summary`) and `samples` rows for Asia/Shanghai yesterday, the most recent complete day inside the 7-day pull window. `source` is `db` when that day has at least one `daily_aggregates` row, the same rule as `GET /v1/read/today`. Zero rows fail the step, because a read of that day would use `source` `fixture`. The job summary line is counts only:

```
verify ok: day=YYYY-MM-DD aggregates=N samples=M source=db
```

A failing check writes `verify failed: day=YYYY-MM-DD aggregates=0 samples=M source=fixture` and exits 1. `N` and `M` are row counts. The line has no database URI, token, or cookie.

Create these Actions secrets. Put the values in GitHub only (Settings → Secrets and variables → Actions). Secret names only belong in this repo.

| Secret | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres the runner can reach |
| `XIAOMI_USER_ID` | yes | Vault `account.xiaomi.com` user id |
| `XIAOMI_PASS_TOKEN` | yes | Vault `account.xiaomi.com` pass token |
| `XIAOMI_DEVICE_ID` | no | Stable login device id. A blank secret is fine |

`serviceToken` and `ssecurity` are STS session fields. The puller obtains them at runtime from `account.xiaomi.com` and `sts-hlth.io.mi.com`. They are not Actions secrets and must not be committed.

Logs redact credential values. A failed run prints `live pull failed: <error_code>`. A `serviceLogin` or STS failure appends the safe diagnostic fields described above.

#### Neon Free

Neon Free is the public Postgres for that `DATABASE_URL` secret. A new Neon project is empty, so the workflow applies `db/migrations/` before the live pull.

1. Sign up at [neon.tech](https://neon.tech) and create a project on the Free plan.
2. Open **Connect** on that project. Turn connection pooling off and copy the connection URI. The host should be the direct endpoint (no `-pooler`). Migrate takes a session advisory lock, which the pooled endpoint does not keep. Leave the URI in the Neon UI only.
3. In this repository: **Settings → Secrets and variables → Actions → New repository secret**. Name the secret `DATABASE_URL` and paste the URI as the value.
4. On the same page, confirm `XIAOMI_USER_ID` and `XIAOMI_PASS_TOKEN` are set. `XIAOMI_DEVICE_ID` stays optional.

Do not commit the URI. Do not add `serviceToken` or `ssecurity` as secrets.

#### One-shot backfill

After this 7-day window is merged to `main`, run **Actions → daily-live-pull → Run workflow** once. That single run applies pending migrations, pulls the past 7 Asia/Shanghai calendar days, upserts them into Neon, then verifies yesterday. Later scheduled runs keep the same 7-day window. This is not a multi-week archive.

If migrate fails, `pull:live` does not run. If the pull fails, verify does not run. A failed pull does not replace stored rows with fixture data. The job summary shows `verify ok: day=YYYY-MM-DD aggregates=N samples=M source=db` when that Shanghai day has `daily_aggregates` rows.

## Credentials

Copy `.env.example` to `.env` for the local database URL, or export `DATABASE_URL`. `.env` is gitignored. The loader accepts blank `XIAOMI_*` placeholders and refuses non-empty credential values in that file.

Export these in the process environment only when you intend to run the live pull. The Actions secret names are the same.

- `XIAOMI_USER_ID`
- `XIAOMI_PASS_TOKEN`
- `XIAOMI_DEVICE_ID` (optional login device id)

Do not commit those values. Logs redact them. Do not put `serviceToken` or `ssecurity` in `.env` or in git.

## Checks

`npm test` includes the Postgres integration tests, so the Compose database has to be up and migrated. Read tests cover ring columns from a seeded `daily_aggregates` row, and the fixture fallback when that day has no row. Stack X tests use an in-process STS and health fixture. They do not call Xiaomi.

```bash
docker compose up -d --wait
npm run migrate
npm test
npm run typecheck
```

## Deploy

Render serves the phone UI over HTTPS. The service is the existing process: `npm start` serves `web/`, the read API, and `GET /health`. It reads Neon through `DATABASE_URL`. When that Shanghai day has `daily_aggregates` rows, `GET /v1/read/today` returns `source` `"db"`.

### Why Render

`render.yaml` selects Render's free web service (`plan: free`, 0.1 CPU, 512 MB). The URL is `https://….onrender.com` with managed TLS. The build is the repo `Dockerfile`: Node 20, `npm run build`, then `npm start` (`node dist/index.js`). Render sets `PORT`. The process binds `0.0.0.0` and listens on that value. The startup log still prints `http://127.0.0.1:<port>`; Render reaches the process on `PORT`.

Render is the free host that runs this Node process. Railway's ongoing free credit is $1 per month, which does not keep a service online. Fly.io has no free tier for new accounts (the smallest always-on machine is about $2 per month) and deploys through `flyctl`. A Render free instance sleeps after about 15 minutes without a request and takes about a minute to wake on the next open.

The public host is the UI and the read API. Its only secret is `DATABASE_URL`. Leave `XIAOMI_USER_ID`, `XIAOMI_PASS_TOKEN`, and `XIAOMI_DEVICE_ID` on GitHub Actions. Do not set Xiaomi credentials on Render. `serviceToken` and `ssecurity` stay runtime fields of the puller.

### Ship from main

Merge this config to `main`, then in the Render Dashboard choose **New → Blueprint** and select this GitHub repository. Render reads `render.yaml`. The service tracks branch `main` and redeploys when that branch moves.

`region` is `singapore`, the closest Render region to Asia/Shanghai. Region cannot be changed after the service exists. Before the first apply, edit `region` in `render.yaml` to `oregon`, `ohio`, `virginia`, or `frankfurt` if the Neon project should sit next to a different Render region.

### The one secret

When Render prompts for `DATABASE_URL`, paste the Neon connection URI once. Use the same value as the Actions secret: Neon **Connect**, pooling off, direct host with no `-pooler` suffix. The URI stays in Render's environment UI. Do not commit it, and do not put it in `render.yaml`.

The daily workflow applies `db/migrations/` before the live pull. This service does not run `npm run migrate` and does not pull. If `/health` reports `schemaReady: false`, run that workflow, or run `npm run migrate` against the same URI from a machine you control.

### Smoke

Use the URL Render shows after the blueprint finishes.

```bash
curl -fsS "https://<host>/health"
curl -fsS "https://<host>/v1/read/today"
```

`/health` returns JSON. Status `200` and `schemaReady: true` means Neon accepted a query and the locked relations are present. `/v1/read/today` returns JSON. `source` is `"db"` when the Shanghai day has `daily_aggregates` rows, and `"fixture"` when it does not. Open `https://<host>/` on a phone. The UI (概况 / 趋势 / 我的) loads.

A free instance that has been asleep, or a Neon compute that has suspended, can fail the first request. Send it again once both are awake. If the first deploy's health check fails for that reason, wake the Neon compute from its console and redeploy.
