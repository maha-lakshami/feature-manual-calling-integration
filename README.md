# Aiking Logistics — Multi-Tenant AI Communication Platform

Aiking Logistics is a TypeScript monorepo for tenant-isolated customer communications, campaign delivery, provider integrations, prepaid wallet accounting, and observational provider-cost rating.

## Prerequisites

- Node.js `>=20.11`; Node 22.x is recommended and is the currently tested major version.
- npm compatible with the committed lockfile (lockfile v3; npm 10 or 11 recommended).
- Docker Desktop or another local PostgreSQL 16 and Redis installation.

## Install

Clone the repository, enter it, and install exactly the locked dependency tree:

```bash
npm ci
```

For deliberate dependency updates, use `npm install` and review the resulting `package-lock.json` change.

## Environment

Create a local environment file from the zero-credential template:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

The template defaults external providers to mock mode. Keep real credentials only in the ignored `.env` file or an approved secret manager; never commit them.

## PostgreSQL and Redis

The local services are defined in `docker-compose.infra.yml`:

```bash
npm run infra:up
```

This starts PostgreSQL on `localhost:5433` and Redis on `localhost:6379`. Check service logs with `npm run infra:logs`.

## Prisma and development data

Generate the Prisma client and apply committed migrations:

```bash
npm run prisma:generate
npm run prisma:migrate
```

`npm run prisma:migrate` maps to `prisma migrate deploy`. Check migration status from the repository root with:

```bash
npm exec --workspace @aiking/api -- prisma migrate status
```

Seed local development data only after migrations are current:

```bash
npm run seed
```

### Migration safety

- Applied migrations are immutable.
- Every schema change requires a new forward migration.
- For a new migration in local development, use the repository workspace command:

  ```bash
  npm run prisma:migrate:dev --workspace @aiking/api -- --name descriptive_name
  ```

- Shared, staging, and production environments must apply committed migrations through `npm run prisma:migrate` (`prisma migrate deploy`).
- Never run `prisma db push`, `prisma migrate reset`, or `docker compose down -v` against shared, staging, or production environments.

## Run locally

Start the API, worker, and Vite web application together:

```bash
npm run dev
```

Or run each process in a separate terminal:

```bash
npm run dev:api
npm run dev:worker
npm run dev:web
```

Default development endpoints:

- Web: <http://localhost:3000>
- API: <http://localhost:3001/api>
- Swagger: <http://localhost:3001/api/docs> (non-production only)

## Development-only accounts

Running the seed creates predictable local accounts. They are for development only and must never be used as production credentials.

| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@aiking.example` | `admin123` |
| Tenant Manager | `manager@demo.example` | `demo123` |
| Tenant Staff | `staff@demo.example` | `demo123` |

The seed refuses to run when `NODE_ENV=production`.

## Quality gates

Run the same checks required by pull-request CI:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Project structure

```text
apps/api/                         NestJS API, workers, Prisma schema and migrations
apps/web/                         React 18 and Vite web application
packages/shared/                  Shared contracts, enums, permissions and money helpers
docs/                             Architecture, user and production-readiness documentation
scripts/                          Development and assurance utilities
docker-compose.infra.yml          Local PostgreSQL and Redis services
render.yaml                       Render deployment definition
```

See `docs/TECHNICAL_DOCUMENTATION.md` for architecture and `docs/PRODUCTION_READINESS.md` for confirmed production hardening work. A stakeholder-friendly `docs/TECHNICAL_DOCUMENTATION.pdf` is intentionally committed; its authoritative source is the Markdown file and it can be regenerated with `node scripts/generate-pdf.mjs` on Windows with Chrome or Edge installed.
