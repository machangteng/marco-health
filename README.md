# marco-health

Local skeleton for Marco's health dashboard. The database is the locked FORGE-005 schema for 栈 X (`mi_health`, hlth.io.mi.com). `devices.source` is `mi_health`.

This repository boots a small Node.js service that checks Postgres and accepts stack X ingest batches. The FORGE-002 UI is a later ticket.

## Stack

Node.js (TypeScript) and Postgres 16 via Docker Compose.

Node fits the later HTTP ingest and read API in one typed service, and Postgres 16 satisfies the schema's PostgreSQL 15+ requirement. Docker Compose is the local database so the schema can be applied the same way on a clean machine.

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

- `GET /` — service identity
- `GET /health` — live database check (`200` when Postgres answers, `503` when it does not)

`schemaReady` on that payload is true after `npm run migrate`.

- `POST /v1/ingest/batch` — schema 0.2 upsert. One bad record is rejected; the rest of the batch is kept.
- `GET /v1/sync/runs/{sync_run_id}` — run status. The payload has no credentials.

Wire name `hr_sample` is stored as `samples.record_type = heart_rate`. Idempotency is `UNIQUE (device_id, record_type, started_at)`. A newer `observed_at` overwrites. Day boundaries are `Asia/Shanghai`, and timestamps are stored with `+08:00`.

```bash
npm run build
npm start
```

`PORT` defaults to `3000`. Export `PORT` in the shell when you need another port.

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
npm run pull:probe
```

The live probe calls `account.xiaomi.com` (pass token exchange), `sts-hlth.io.mi.com`, and `hlth.io.mi.com` only. It does not call Huami or `api-mifit`. If `XIAOMI_USER_ID` or `XIAOMI_PASS_TOKEN` is missing, the command prints `{"skipped":true,...}` and exits 0. When they are present it uses a two-day window, waits at least one second between requests, renews the session at most once after HTTP 401, and records `auth_expired` or `pass_token_invalid` on `sync_runs`.

## Layout

```
docker-compose.yml    Postgres 16
db/migrations/         locked up/down SQL
openapi/               ingest OpenAPI 0.2
fixtures/mi_health/    mock puller batches
docs/                  path F contract v0.2
src/index.ts           HTTP server
src/health.ts          database health check
src/migrate.ts         migration runner
src/ingest/            batch upsert
src/pull/              mock puller and optional live probe
.env.example           DATABASE_URL and blank Xiaomi placeholders
```

## Credentials

Copy `.env.example` to `.env` for the local database URL, or export `DATABASE_URL`. `.env` is gitignored. The loader accepts blank `XIAOMI_*` placeholders and refuses non-empty credential values in that file.

Export these in the process environment only when you intend to run the live probe:

- `XIAOMI_USER_ID`
- `XIAOMI_PASS_TOKEN`
- `XIAOMI_DEVICE_ID` (optional login device id)

Do not commit those values. Logs redact them.

## Checks

`npm test` includes the Postgres integration tests, so the Compose database has to be up and migrated.

```bash
docker compose up -d --wait
npm run migrate
npm test
npm run typecheck
```
