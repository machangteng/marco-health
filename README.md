# marco-health

Local skeleton for Marco's health dashboard. The database is the locked FORGE-005 schema for 栈 X (`mi_health`, hlth.io.mi.com). `devices.source` is `mi_health`.

This repository boots a small Node.js service that checks Postgres. The ingest puller and the FORGE-002 UI are later tickets.

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

## Layout

```
docker-compose.yml    Postgres 16
db/migrations/         locked up/down SQL
src/index.ts           HTTP server
src/health.ts          database health check
src/migrate.ts         migration runner
.env.example           DATABASE_URL only
```

## Credentials

Copy `.env.example` to `.env` for the local database URL. Keep Xiaomi account material in a vault or a runtime environment outside this repository. `.env` is gitignored. `.env.example` documents `DATABASE_URL` only.

## Checks

```bash
npm test
npm run typecheck
```
