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

`PORT` defaults to `3000`. Export `PORT` in the shell when you need another port.

## Read API

Day keys are `YYYY-MM-DD` in **Asia/Shanghai**. Optional `device_id` (uuid) limits the query to one device. Omit it and the latest `daily_aggregates` row in the window is used.

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
.github/workflows/     daily live pull (schedule + workflow_dispatch)
.env.example           DATABASE_URL and blank Xiaomi placeholders
```

## Daily live pull

`npm run pull:live` reads runtime credentials, pulls the Asia/Shanghai today window from stack X, and upserts through the same path as `POST /v1/ingest/batch`. The window is that calendar day plus the previous day (the contract's one-day pad). Ring fields stay `active_kcal`, `exercise_minutes`, and `stand_hours`.

Requests wait 1–2 seconds with jitter. A health-host HTTP 401 refreshes the STS session once. A second 401 stops with `auth_expired` and does not retry. `passToken` code `70016` stops with `pass_token_invalid`.

Missing `XIAOMI_USER_ID` or `XIAOMI_PASS_TOKEN` prints `error_code` `credentials_absent` and exits 1. That path does not call Xiaomi and does not write the database. A failed pull can record `sync_runs` and does not replace `daily_aggregates` with fixture rows. The command never runs `npm run pull:mock`.

After a successful ingest, `GET /v1/read/today?day=YYYY-MM-DD` for that Shanghai day returns `source` `"db"`.

### GitHub Actions

`.github/workflows/daily-live-pull.yml` runs `npm run migrate`, then `npm run pull:live`, on a schedule and on `workflow_dispatch`. The cron is `30 22 * * *` UTC, which is 06:30 Asia/Shanghai. A failing step stops the job, so a failed migrate does not start the pull. The workflow does not run `npm run pull:mock` and does not load `fixtures/mi_health/`.

`npm run migrate` is idempotent. Applied versions are stored in `schema_migrations`. A second run on a database that already has the locked schema prints `schema up to date` and changes nothing.

Create these Actions secrets. Put the values in GitHub only (Settings → Secrets and variables → Actions). Secret names only belong in this repo.

| Secret | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres the runner can reach |
| `XIAOMI_USER_ID` | yes | Vault `account.xiaomi.com` user id |
| `XIAOMI_PASS_TOKEN` | yes | Vault `account.xiaomi.com` pass token |
| `XIAOMI_DEVICE_ID` | no | Stable login device id. A blank secret is fine |

`serviceToken` and `ssecurity` are STS session fields. The puller obtains them at runtime from `account.xiaomi.com` and `sts-hlth.io.mi.com`. They are not Actions secrets and must not be committed.

Logs redact credential values. A failed run prints `live pull failed: <error_code>`.

#### Neon Free

Neon Free is the public Postgres for that `DATABASE_URL` secret. A new Neon project is empty, so the workflow applies `db/migrations/` before the live pull.

1. Sign up at [neon.tech](https://neon.tech) and create a project on the Free plan.
2. Open **Connect** on that project. Turn connection pooling off and copy the connection URI. The host should be the direct endpoint (no `-pooler`). Migrate takes a session advisory lock, which the pooled endpoint does not keep. Leave the URI in the Neon UI only.
3. In this repository: **Settings → Secrets and variables → Actions → New repository secret**. Name the secret `DATABASE_URL` and paste the URI as the value.
4. On the same page, confirm `XIAOMI_USER_ID` and `XIAOMI_PASS_TOKEN` are set. `XIAOMI_DEVICE_ID` stays optional.

Do not commit the URI. Do not add `serviceToken` or `ssecurity` as secrets.

#### One-shot verify

On GitHub: **Actions → daily-live-pull → Run workflow**. Choose the branch that contains this workflow and run it.

That dispatch applies pending migrations, then pulls the Asia/Shanghai today window. If migrate fails, `pull:live` does not run. A failed pull does not replace stored rows with fixture data. After a successful run, `GET /v1/read/today` for that Shanghai day returns `source` `"db"`.

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
